import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ChildProcessWithoutNullStreams, spawn } from 'child_process';

let sshProcess: ChildProcessWithoutNullStreams | null = null;
let externalTunnelPid: number | null = null;
let outputChannel: vscode.OutputChannel;
let statusBarItem: vscode.StatusBarItem;
let keyStatusBarItem: vscode.StatusBarItem;
let connectTimer: NodeJS.Timeout | null = null;
let stopRequested = false;
let extensionContextRef: vscode.ExtensionContext | null = null;
let toolBoxWebviewProvider: ToolBoxWebviewProvider | null = null;
let keyProjectsWorkspaceOverride: string | null = null;
let keyProjectsCache: KeyProjectsCache | null = null;
let keyProjectsRefreshPromise: Promise<void> | null = null;
const LOCAL_TARGET_CONNECT_FAILURE_LOG_INTERVAL_MS = 30_000;
const LOCAL_TARGET_CONNECT_FAILURE_CONTEXT_MS = 30_000;

type ProxyState = 'stopped' | 'starting' | 'connected' | 'failed';
let proxyState: ProxyState = 'stopped';

type FileProxyConfig = {
  sshPath: string;
  connectionReadyDelayMs: number;
  remoteHost: string;
  remotePort: number;
  remoteUser: string;
  remoteBindPort: number;
  localHost: string;
  localPort: number;
  identityFile: string;
};

type RuntimeProxyConfig = FileProxyConfig & {
  loadedConfigPath: string;
};

type ExistingTunnelMatch = {
  pid: number;
  commandLine: string;
};

type ResolvePathOptions = {
  workspaceFolder?: string;
  remoteName?: string;
  homeDir?: string;
  extensionPath?: string;
};

type KeyProjectsMode = 'local' | 'ssh';

type KeyProjectsConfig = {
  mode: KeyProjectsMode;
  rootDir: string;
  repoNames: string[];
  sshTarget: string;
  sshPort: number;
  gitPath: string;
  sshPath: string;
  loadedConfigPath: string;
  configExists: boolean;
  workspaceAvailable: boolean;
};

type KeyProjectStatus = {
  configuredRepoName: string;
  repoName: string;
  repoPath: string;
  branch: string;
  upstream?: string;
  syncState: 'synced' | 'ahead' | 'behind' | 'diverged' | 'no-upstream' | 'unknown';
  aheadCount: number;
  behindCount: number;
  shortStatus: string;
  fullStatus?: string;
  clean: boolean;
  available: boolean;
  error?: string;
  fetchError?: string;
};

type KeyProjectsCache = {
  signature: string;
  statuses: KeyProjectStatus[];
};

type BatchedSshKeyProjectResult = {
  configuredRepoName: string;
  repoPath: string;
  remoteUrl: string;
  fetchError: string;
  statusOutput: string;
  error: string;
};

type KeyProjectsViewRow = {
  configuredRepoName: string;
  repoName: string;
  branch: string;
  remoteLabel: string;
  stateLabel: string;
  stateEmoji: string;
  detailTitle: string;
  detailText: string;
  clean: boolean;
  available: boolean;
};

type KeyProjectsViewModel = {
  issue: string | null;
  configLoaded: boolean;
  refreshing: boolean;
  rows: KeyProjectsViewRow[];
};

type ToolBoxAction = {
  id: 'toggle' | 'logs' | 'proxySettings' | 'keyRefresh' | 'keySettings';
  label: string;
  enabled: boolean;
};

type ReverseTunnelViewModel = {
  stateLabel: string;
  detail: string;
  tone: 'connected' | 'starting' | 'failed' | 'stopped';
  actions: ToolBoxAction[];
};

type ToolBoxViewModel = {
  reverseTunnel: ReverseTunnelViewModel;
  keyProjects: KeyProjectsViewModel;
};

type SidebarTestItem = {
  kind: string;
  label: string;
  description?: string;
  tooltip?: string;
  command?: string;
  arguments?: unknown[];
  enabled: boolean;
  parentLabel?: string;
};

type SshStderrLogState = {
  lastLocalTargetConnectFailureLogAt: Map<string, number>;
  localTargetConnectFailureContextUntilMs: number;
};

function padDatePart(value: number, length = 2): string {
  return String(value).padStart(length, '0');
}

function formatLogTimestamp(date = new Date()): string {
  return [
    date.getFullYear(),
    '-',
    padDatePart(date.getMonth() + 1),
    '-',
    padDatePart(date.getDate()),
    ' ',
    padDatePart(date.getHours()),
    ':',
    padDatePart(date.getMinutes()),
    ':',
    padDatePart(date.getSeconds()),
    '.',
    padDatePart(date.getMilliseconds(), 3)
  ].join('');
}

function formatLogLine(message: string, date = new Date()): string {
  return `[${formatLogTimestamp(date)}] ${message}`;
}

function createTimestampedOutputChannel(channel: vscode.OutputChannel): vscode.OutputChannel {
  const appendLine = channel.appendLine.bind(channel);
  channel.appendLine = (value: string): void => {
    const lines = value.split(/\r?\n/);
    for (const line of lines) {
      appendLine(formatLogLine(line));
    }
  };
  return channel;
}

function getLocalTargetConnectFailureKey(text: string, config: Pick<FileProxyConfig, 'localHost' | 'localPort'>): string | null {
  const hostPattern = new RegExp(`(^|[^\\w.:-])${escapeRegExp(config.localHost)}([^\\w.:-]|$)`, 'i');
  const portPattern = new RegExp(`(^|[^\\d])(?:port\\s+|:)${config.localPort}([^\\d]|$)`, 'i');
  const connectFailurePattern = /connect|connection|refused|failed|no error|连接|无法连接/i;

  if (!hostPattern.test(text) || !portPattern.test(text) || !connectFailurePattern.test(text)) {
    return null;
  }

  return `${config.localHost}:${config.localPort}`;
}

function shouldLogSshStderr(
  text: string,
  config: Pick<FileProxyConfig, 'localHost' | 'localPort'>,
  nowMs: number,
  state: SshStderrLogState
): boolean {
  const localTargetKey = getLocalTargetConnectFailureKey(text, config);
  if (!localTargetKey) {
    if (/^socket:\s*no error$/i.test(text) && nowMs < state.localTargetConnectFailureContextUntilMs) {
      return false;
    }

    return true;
  }

  state.localTargetConnectFailureContextUntilMs = nowMs + LOCAL_TARGET_CONNECT_FAILURE_CONTEXT_MS;

  const lastLoggedAt = state.lastLocalTargetConnectFailureLogAt.get(localTargetKey);
  if (lastLoggedAt !== undefined && nowMs - lastLoggedAt < LOCAL_TARGET_CONNECT_FAILURE_LOG_INTERVAL_MS) {
    return false;
  }

  state.lastLocalTargetConnectFailureLogAt.set(localTargetKey, nowMs);
  return true;
}

function getStateLabel(state: ProxyState): string {
  if (state === 'starting') {
    return 'Starting';
  }
  if (state === 'connected') {
    return 'Connected';
  }
  if (state === 'failed') {
    return 'Failed';
  }
  return 'Stopped';
}

function getReverseTunnelTone(state: ProxyState): ReverseTunnelViewModel['tone'] {
  if (state === 'connected') {
    return 'connected';
  }
  if (state === 'starting') {
    return 'starting';
  }
  if (state === 'failed') {
    return 'failed';
  }
  return 'stopped';
}

function getReverseTunnelDetail(state: ProxyState): string {
  if (state === 'connected') {
    return '';
  }
  if (state === 'starting') {
    return '';
  }
  if (state === 'failed') {
    return '';
  }
  return '';
}

function getReverseTunnelActions(): ToolBoxAction[] {
  return [
    {
      id: 'toggle',
      label: proxyState === 'connected' ? 'Stop' : proxyState === 'starting' ? 'Connecting...' : 'Start',
      enabled: proxyState !== 'starting'
    },
    {
      id: 'logs',
      label: 'Logs',
      enabled: true
    },
    {
      id: 'proxySettings',
      label: 'Settings',
      enabled: true
    }
  ];
}

function getKeyProjectStateLabel(status: Pick<KeyProjectStatus, 'clean' | 'available'>): string {
  if (!status.available) {
    return 'unavailable';
  }

  return status.clean ? 'clean' : 'dirty';
}

function getKeyProjectStateEmoji(status: Pick<KeyProjectStatus, 'clean' | 'available'>): string {
  if (!status.available) {
    return '\u26A0';
  }

  return status.clean ? '\u2714\uFE0F' : '\u2757';
}

async function getKeyProjectsViewModel(): Promise<KeyProjectsViewModel> {
  const config = await getKeyProjectsConfig();
  const issue = getKeyProjectsConfigurationIssue(config);
  const cached = issue ? null : getCachedKeyProjectStatuses(config);

  return {
    issue,
    configLoaded: Boolean(cached),
    refreshing: Boolean(keyProjectsRefreshPromise),
    rows: (cached ?? []).map((status) => ({
      configuredRepoName: status.configuredRepoName,
      repoName: status.repoName,
      branch: status.available ? status.branch : 'unavailable',
      remoteLabel: status.available ? getKeyProjectSyncLabel(status) : 'unavailable',
      stateLabel: getKeyProjectStateLabel(status),
      stateEmoji: getKeyProjectStateEmoji(status),
      detailTitle: status.repoName + ' - ' + status.branch,
      detailText: formatKeyProjectCachedDetail(status),
      clean: status.clean,
      available: status.available
    }))
  };
}

async function getToolBoxViewModel(): Promise<ToolBoxViewModel> {
  return {
    reverseTunnel: {
      stateLabel: getStateLabel(proxyState),
      detail: getReverseTunnelDetail(proxyState),
      tone: getReverseTunnelTone(proxyState),
      actions: getReverseTunnelActions()
    },
    keyProjects: await getKeyProjectsViewModel()
  };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function createNonce(): string {
  return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
}

function getReverseTunnelActionIconSvg(actionId: string): string {
  if (actionId === 'toggle') {
    return '<svg viewBox="0 0 16 16" fill="currentColor" focusable="false" aria-hidden="true"><path d="M7.5 1v7h1V1z"/><path d="M3 8.812a5 5 0 0 1 2.578-4.375l-.485-.874A6 6 0 1 0 11 3.616l-.501.865A5 5 0 1 1 3 8.812"/></svg>';
  }
  if (actionId === 'logs') {
    return '<svg viewBox="0 0 16 16" fill="currentColor" focusable="false" aria-hidden="true"><path d="M5 10.5a.5.5 0 0 1 .5-.5h2a.5.5 0 0 1 0 1h-2a.5.5 0 0 1-.5-.5m0-2a.5.5 0 0 1 .5-.5h5a.5.5 0 0 1 0 1h-5a.5.5 0 0 1-.5-.5m0-2a.5.5 0 0 1 .5-.5h5a.5.5 0 0 1 0 1h-5a.5.5 0 0 1-.5-.5m0-2a.5.5 0 0 1 .5-.5h5a.5.5 0 0 1 0 1h-5a.5.5 0 0 1-.5-.5"/><path d="M3 0h10a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2v-1h1v1a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V2a1 1 0 0 0-1-1H3a1 1 0 0 0-1 1v1H1V2a2 2 0 0 1 2-2"/><path d="M1 5v-.5a.5.5 0 0 1 1 0V5h.5a.5.5 0 0 1 0 1h-2a.5.5 0 0 1 0-1zm0 3v-.5a.5.5 0 0 1 1 0V8h.5a.5.5 0 0 1 0 1h-2a.5.5 0 0 1 0-1zm0 3v-.5a.5.5 0 0 1 1 0v.5h.5a.5.5 0 0 1 0 1h-2a.5.5 0 0 1 0-1z"/></svg>';
  }
  return '<svg viewBox="0 0 16 16" fill="currentColor" focusable="false" aria-hidden="true"><path d="M7.068.727c.243-.97 1.62-.97 1.864 0l.071.286a.96.96 0 0 0 1.622.434l.205-.211c.695-.719 1.888-.03 1.613.931l-.08.284a.96.96 0 0 0 1.187 1.187l.283-.081c.96-.275 1.65.918.931 1.613l-.211.205a.96.96 0 0 0 .434 1.622l.286.071c.97.243.97 1.62 0 1.864l-.286.071a.96.96 0 0 0-.434 1.622l.211.205c.719.695.03 1.888-.931 1.613l-.284-.08a.96.96 0 0 0-1.187 1.187l.081.283c.275.96-.918 1.65-1.613.931l-.205-.211a.96.96 0 0 0-1.622.434l-.071.286c-.243.97-1.62.97-1.864 0l-.071-.286a.96.96 0 0 0-1.622-.434l-.205.211c-.695.719-1.888.03-1.613-.931l.08-.284a.96.96 0 0 0-1.186-1.187l-.284.081c-.96.275-1.65-.918-.931-1.613l.211-.205a.96.96 0 0 0-.434-1.622l-.286-.071c-.97-.243-.97-1.62 0-1.864l.286-.071a.96.96 0 0 0 .434-1.622l-.211-.205c-.719-.695-.03-1.888.931-1.613l.284.08a.96.96 0 0 0 1.187-1.186l-.081-.284c-.275-.96.918-1.65 1.613-.931l.205.211a.96.96 0 0 0 1.622-.434zM12.973 8.5H8.25l-2.834 3.779A4.998 4.998 0 0 0 12.973 8.5m0-1a4.998 4.998 0 0 0-7.557-3.779l2.834 3.78zM5.048 3.967l-.087.065zm-.431.355A4.98 4.98 0 0 0 3.002 8c0 1.455.622 2.765 1.615 3.678L7.375 8zm.344 7.646.087.065z"/></svg>';
}

function getKeyProjectsToolbarIconSvg(actionId: string): string {
  if (actionId === 'refresh') {
    return '<svg viewBox="0 0 16 16" fill="currentColor" focusable="false" aria-hidden="true"><path d="M8 3a5 5 0 1 0 4.546 2.914.5.5 0 0 1 .908-.418A6 6 0 1 1 8 2z"/><path d="M8 4.466V.534a.25.25 0 0 1 .41-.192l2.36 1.966c.12.1.12.284 0 .384L8.41 4.658A.25.25 0 0 1 8 4.466"/></svg>';
  }
  return '<svg viewBox="0 0 16 16" fill="currentColor" focusable="false" aria-hidden="true"><path d="M7.068.727c.243-.97 1.62-.97 1.864 0l.071.286a.96.96 0 0 0 1.622.434l.205-.211c.695-.719 1.888-.03 1.613.931l-.08.284a.96.96 0 0 0 1.187 1.187l.283-.081c.96-.275 1.65.918.931 1.613l-.211.205a.96.96 0 0 0 .434 1.622l.286.071c.97.243.97 1.62 0 1.864l-.286.071a.96.96 0 0 0-.434 1.622l.211.205c.719.695.03 1.888-.931 1.613l-.284-.08a.96.96 0 0 0-1.187 1.187l.081.283c.275.96-.918 1.65-1.613.931l-.205-.211a.96.96 0 0 0-1.622.434l-.071.286c-.243.97-1.62.97-1.864 0l-.071-.286a.96.96 0 0 0-1.622-.434l-.205.211c-.695.719-1.888.03-1.613-.931l.08-.284a.96.96 0 0 0-1.186-1.187l-.284.081c-.96.275-1.65-.918-.931-1.613l.211-.205a.96.96 0 0 0-.434-1.622l-.286-.071c-.97-.243-.97-1.62 0-1.864l.286-.071a.96.96 0 0 0 .434-1.622l-.211-.205c-.719-.695-.03-1.888.931-1.613l.284.08a.96.96 0 0 0 1.187-1.186l-.081-.284c-.275-.96.918-1.65 1.613-.931l.205.211a.96.96 0 0 0 1.622-.434zM12.973 8.5H8.25l-2.834 3.779A4.998 4.998 0 0 0 12.973 8.5m0-1a4.998 4.998 0 0 0-7.557-3.779l2.834 3.78zM5.048 3.967l-.087.065zm-.431.355A4.98 4.98 0 0 0 3.002 8c0 1.455.622 2.765 1.615 3.678L7.375 8zm.344 7.646.087.065z"/></svg>';
}
function renderToolBoxWebview(webview: vscode.Webview, model: ToolBoxViewModel): string {
  const nonce = createNonce();
  const reverseActions = model.reverseTunnel.actions
    .map((action) => {
      const classes = ['action'];
      if (action.id === 'toggle') {
        classes.push(proxyState === 'connected' ? 'danger' : 'success');
      }
      const icon = getReverseTunnelActionIconSvg(action.id);
      return '<button class="' + classes.join(' ') + '" data-action="' + escapeHtml(action.id) + '" title="' + escapeHtml(action.label) + '" aria-label="' + escapeHtml(action.label) + '" ' + (action.enabled ? '' : 'disabled') + '><span class="action-icon" aria-hidden="true">' + icon + '</span></button>';
    })
    .join('');

  const keyToolbar = [
    '<button id="refresh" class="icon-button" title="' + escapeHtml(model.keyProjects.refreshing ? 'Refreshing...' : 'Refresh') + '" aria-label="' + escapeHtml(model.keyProjects.refreshing ? 'Refreshing...' : 'Refresh') + '" ' + (model.keyProjects.refreshing ? 'disabled' : '') + '><span class="action-icon" aria-hidden="true">' + getKeyProjectsToolbarIconSvg('refresh') + '</span></button>',
    '<button id="key-settings" class="icon-button secondary" title="Settings" aria-label="Settings"><span class="action-icon" aria-hidden="true">' + getKeyProjectsToolbarIconSvg('settings') + '</span></button>'
  ].join('');

  const keyDetailsByRepo = JSON.stringify(
    Object.fromEntries(
      model.keyProjects.rows.map((row) => [row.configuredRepoName, { title: row.detailTitle, text: row.detailText }])
    )
  ).replace(/</g, '\u003C');

  const keyRows = model.keyProjects.rows
    .map((row) => {
      return [
        '<button class="table-row" data-repo="' + escapeHtml(row.configuredRepoName) + '">',
        '  <span class="cell state" title="' + escapeHtml(row.stateLabel) + '">' + row.stateEmoji + '</span>',
        '  <span class="cell repo">' + escapeHtml(row.repoName) + '</span>',
        '  <span class="cell branch">' + escapeHtml(row.branch) + '</span>',
        '  <span class="cell remote">' + escapeHtml(row.remoteLabel) + '</span>',
        '</button>'
      ].join('');
    })
    .join('');

  let keyBody = '';
  if (model.keyProjects.issue) {
    keyBody = '<div class="empty">' + escapeHtml(model.keyProjects.issue) + '</div>';
  } else if (!model.keyProjects.configLoaded && !model.keyProjects.refreshing) {
    keyBody = '<div class="empty">Click Refresh to load key project status.</div>';
  } else if (!model.keyProjects.rows.length && model.keyProjects.refreshing) {
    keyBody = '<div class="empty">Refreshing key projects...</div>';
  } else if (!model.keyProjects.rows.length) {
    keyBody = '<div class="empty">No key projects configured.</div>';
  } else {
    keyBody = [
      '<div class="table-header">',
      '  <span class="cell state">State</span>',
      '  <span class="cell repo">Repo</span>',
      '  <span class="cell branch">Branch</span>',
      '  <span class="cell remote">Remote</span>',
      '</div>',
      '<div class="table-rows">' + keyRows + '</div>'
    ].join('');
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>
    body {
      margin: 0;
      padding: 12px;
      font-family: var(--vscode-font-family);
      font-size: 12px;
      color: var(--vscode-foreground);
      background: var(--vscode-sideBar-background);
    }
    .stack {
      display: grid;
      gap: 8px;
    }
    .panel {
      border: 1px solid var(--vscode-panel-border);
      border-radius: 10px;
      overflow: hidden;
      background: color-mix(in srgb, var(--vscode-editor-background) 86%, transparent);
    }
    .reverse-block {
      display: grid;
      gap: 5px;
      justify-items: start;
    }
    .reverse-title {
      padding-left: 0;
      text-align: left;
    }
    .reverse-panel {
      width: 102px;
      justify-self: start;
      margin-left: 0;
      padding: 7px 12px 12px;
    }
    .key-block {
      display: grid;
      gap: 5px;
      justify-items: stretch;
    }
    .key-title {
      padding-left: 0;
      text-align: left;
    }
    .key-panel {
      width: 100%;
    }
    .panel-head {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 12px;
      padding: 12px 12px 10px;
      border-bottom: 1px solid color-mix(in srgb, var(--vscode-panel-border) 70%, transparent);
    }
    .panel-title {
      display: grid;
      gap: 4px;
      min-width: 0;
    }
    .eyebrow {
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--vscode-descriptionForeground);
    }
    .headline {
      font-size: 14px;
      font-weight: 600;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .subline {
      color: var(--vscode-descriptionForeground);
      line-height: 1.4;
    }
    .tone {
      width: 9px;
      height: 9px;
      border-radius: 999px;
      background: var(--vscode-disabledForeground);
      flex: 0 0 auto;
    }
    .tone.connected, .dot.clean { background: var(--vscode-testing-iconPassed); }
    .tone.starting { background: var(--vscode-testing-iconQueued); }
    .tone.failed, .dot.dirty { background: var(--vscode-testing-iconFailed); }
    .tone.stopped, .dot.unavailable { background: var(--vscode-disabledForeground); }
    .reverse-bar {
      width: 102px;
      display: grid;
      gap: 12px;
      align-items: center;
      justify-items: stretch;
      margin-top: 0;
    }
    .reverse-status {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
      font-size: 13px;
      font-weight: 600;
      line-height: 1.1;
      margin-top: 0;
      justify-self: center;
    }
    .reverse-status-text {
      display: inline-flex;
      align-items: center;
      transform: translateY(0.5px);
    }
    .actions {
      display: inline-flex;
      flex-wrap: wrap;
      gap: 6px;
      justify-content: flex-start;
      align-items: center;
      justify-self: start;
      margin-top: 0;
    }
    button.action {
      border: 1px solid var(--vscode-button-border, transparent);
      background: var(--vscode-button-secondaryBackground, var(--vscode-button-background));
      color: var(--vscode-button-secondaryForeground, var(--vscode-button-foreground));
      border-radius: 6px;
      width: 30px;
      height: 30px;
      padding: 0;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      line-height: 1;
      transition: background-color 120ms ease, border-color 120ms ease, box-shadow 120ms ease, transform 120ms ease;
    }
    button.action:hover:not(:disabled) {
      background: color-mix(in srgb, var(--vscode-list-hoverBackground) 78%, var(--vscode-button-secondaryBackground, var(--vscode-button-background)));
      border-color: color-mix(in srgb, var(--vscode-focusBorder) 50%, transparent);
      box-shadow: 0 0 0 1px color-mix(in srgb, var(--vscode-focusBorder) 18%, transparent);
      transform: translateY(-1px);
    }
    .action-icon {
      width: 14px;
      height: 14px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      color: inherit;
      opacity: 0.96;
      flex: 0 0 auto;
      transition: transform 120ms ease, opacity 120ms ease;
    }
    button.action:hover:not(:disabled) .action-icon,
    .icon-button:hover:not(:disabled) .action-icon {
      opacity: 1;
      transform: scale(1.06);
    }
    .action-icon svg {
      width: 14px;
      height: 14px;
      display: block;
    }
    button.action.success .action-icon {
      color: var(--vscode-testing-iconPassed);
    }
    button.action.danger .action-icon {
      color: var(--vscode-testing-iconFailed);
    }
    button.action:disabled {
      cursor: default;
      opacity: 0.6;
    }
    .key-toolbar {
      display: flex;
      gap: 8px;
      padding: 12px 12px 12px;
    }
    .icon-button {
      border: 1px solid var(--vscode-button-border, transparent);
      background: var(--vscode-button-secondaryBackground, var(--vscode-button-background));
      color: var(--vscode-button-secondaryForeground, var(--vscode-button-foreground));
      border-radius: 6px;
      width: 30px;
      height: 30px;
      padding: 0;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      line-height: 1;
      transition: background-color 120ms ease, border-color 120ms ease, box-shadow 120ms ease, transform 120ms ease;
    }
    .icon-button:hover:not(:disabled) {
      background: color-mix(in srgb, var(--vscode-list-hoverBackground) 78%, var(--vscode-button-secondaryBackground, var(--vscode-button-background)));
      border-color: color-mix(in srgb, var(--vscode-focusBorder) 50%, transparent);
      box-shadow: 0 0 0 1px color-mix(in srgb, var(--vscode-focusBorder) 18%, transparent);
      transform: translateY(-1px);
    }
    .icon-button.secondary {
      background: var(--vscode-button-secondaryBackground, var(--vscode-dropdown-background));
      color: var(--vscode-button-secondaryForeground, var(--vscode-dropdown-foreground));
    }
    .icon-button:disabled {
      cursor: default;
      opacity: 0.6;
    }
    .key-body {
      padding: 0 12px 12px;
    }
    .table-header, .table-row {
      width: 100%;
      display: grid;
      grid-template-columns: 36px minmax(124px, 180px) minmax(88px, 132px) minmax(96px, 148px);
      gap: 8px;
      align-items: center;
      box-sizing: border-box;
      padding: 8px 9px;
    }
    .table-header {
      font-size: 10px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--vscode-descriptionForeground);
      border-bottom: 1px solid var(--vscode-panel-border);
    }
    .table-row {
      border: 0;
      border-top: 1px solid color-mix(in srgb, var(--vscode-panel-border) 70%, transparent);
      background: transparent;
      color: inherit;
      text-align: left;
      cursor: pointer;
    }
    .table-row:first-child { border-top: 0; }
    .table-row:hover { background: color-mix(in srgb, var(--vscode-list-hoverBackground) 88%, transparent); }
    .cell {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .table-row .state {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-size: 14px;
      line-height: 1;
    }
    .table-header .state {
      font-size: inherit;
      line-height: inherit;
      justify-content: flex-start;
    }
    .table-header .repo,
    .table-header .branch,
    .table-header .remote,
    .table-row .repo,
    .table-row .branch,
    .table-row .remote {
      justify-self: stretch;
      width: 100%;
      text-align: left;
    }
    .dot {
      width: 8px;
      height: 8px;
      border-radius: 999px;
      flex: 0 0 auto;
    }
    .empty {
      border: 1px dashed var(--vscode-panel-border);
      border-radius: 8px;
      padding: 12px;
      color: var(--vscode-descriptionForeground);
      line-height: 1.45;
    }
    .detail-popover {
      position: fixed;
      display: none;
      width: min(340px, calc(100vw - 24px));
      max-height: min(240px, calc(100vh - 24px));
      border: 1px solid var(--vscode-panel-border);
      border-radius: 10px;
      overflow: hidden;
      background: var(--vscode-editor-background);
      box-shadow: 0 8px 20px rgba(0, 0, 0, 0.18);
      z-index: 30;
    }
    .detail-popover.open {
      display: grid;
      grid-template-rows: auto 1fr;
    }
    .detail-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 12px 14px;
      border-bottom: 1px solid var(--vscode-panel-border);
    }
    .detail-title {
      font-size: 13px;
      font-weight: 600;
    }
    .detail-close {
      border: 0;
      background: transparent;
      color: var(--vscode-foreground);
      font-size: 18px;
      line-height: 1;
      padding: 4px 6px;
      cursor: pointer;
    }
    .detail-body {
      margin: 0;
      padding: 14px;
      overflow: auto;
      white-space: pre-wrap;
      user-select: text;
      -webkit-user-select: text;
      font-family: var(--vscode-editor-font-family, var(--vscode-font-family));
      font-size: 12px;
      line-height: 1.5;
    }
  </style>
</head>
<body>
  <div class="stack">
    <section class="reverse-block">
      <div class="eyebrow reverse-title">Reverse Tunnel</div>
      <div class="panel reverse-panel">
        <div class="reverse-bar">
          <div class="actions">${reverseActions}</div>
          <div class="reverse-status"><span class="tone ${model.reverseTunnel.tone}"></span><span class="reverse-status-text">${escapeHtml(model.reverseTunnel.stateLabel)}</span></div>
        </div>
      </div>
    </section>
    <section class="key-block">
      <div class="eyebrow key-title">Key Projects</div>
      <section class="panel key-panel">
        <div class="key-toolbar">${keyToolbar}</div>
        <div class="key-body">${keyBody}</div>
      </section>
    </section>
  </div>
  <div id="detail-popover" class="detail-popover" aria-hidden="true">
    <div class="detail-head">
      <div id="detail-title" class="detail-title">Key Project Details</div>
      <button id="detail-close" class="detail-close" type="button" aria-label="Close">\u00D7</button>
    </div>
    <pre id="detail-body" class="detail-body"></pre>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    document.querySelectorAll('button.action[data-action]').forEach((button) => {
      button.addEventListener('click', () => {
        const action = button.getAttribute('data-action');
        if (action) {
          vscode.postMessage({ type: 'action', action });
        }
      });
    });
    document.getElementById('refresh')?.addEventListener('click', () => {
      vscode.postMessage({ type: 'action', action: 'keyRefresh' });
    });
    document.getElementById('key-settings')?.addEventListener('click', () => {
      vscode.postMessage({ type: 'action', action: 'keySettings' });
    });
    const detailPopover = document.getElementById('detail-popover');
    const detailTitle = document.getElementById('detail-title');
    const detailBody = document.getElementById('detail-body');
    const keyDetailsByRepo = ${keyDetailsByRepo};
    const closeDetails = () => {
      detailPopover?.classList.remove('open');
      detailPopover?.setAttribute('aria-hidden', 'true');
    };
    document.getElementById('detail-close')?.addEventListener('click', closeDetails);
    window.addEventListener('click', (event) => {
      if (!detailPopover?.classList.contains('open')) {
        return;
      }
      const target = event.target;
      if (target instanceof HTMLElement && (target.closest('.table-row') || target.closest('#detail-popover'))) {
        return;
      }
      closeDetails();
    });
    window.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        closeDetails();
      }
    });
    window.addEventListener('message', (event) => {
      const message = event.data;
      if (message?.type !== 'detail' || !detailBody || !detailTitle || !detailPopover) {
        return;
      }
      const margin = 12;
      const width = Math.min(340, window.innerWidth - margin * 2);
      const height = Math.min(240, window.innerHeight - margin * 2);
      const left = Math.min(Math.max(Number(message.left ?? margin), margin), window.innerWidth - width - margin);
      const top = Math.min(Math.max(Number(message.top ?? margin), margin), window.innerHeight - height - margin);
      detailTitle.textContent = message.title || 'Key Project Details';
      detailBody.textContent = message.text || '';
      detailPopover.style.left = left + 'px';
      detailPopover.style.top = top + 'px';
      detailPopover.classList.add('open');
      detailPopover.setAttribute('aria-hidden', 'false');
    });
    document.querySelectorAll('.table-row').forEach((row) => {
      row.addEventListener('click', (event) => {
        const repoName = row.getAttribute('data-repo');
        if (repoName && detailBody && detailTitle && detailPopover) {
          const clientX = event instanceof MouseEvent ? event.clientX : 12;
          const clientY = event instanceof MouseEvent ? event.clientY : 12;
          const detail = keyDetailsByRepo[repoName];
          const margin = 12;
          const width = Math.min(340, window.innerWidth - margin * 2);
          const height = Math.min(240, window.innerHeight - margin * 2);
          const left = Math.min(Math.max(clientX + 8, margin), window.innerWidth - width - margin);
          const top = Math.min(Math.max(clientY + 8, margin), window.innerHeight - height - margin);
          detailTitle.textContent = detail?.title || 'Key Project Details';
          detailBody.textContent = detail?.text || 'Status not loaded. Click Refresh first.';
          detailPopover.style.left = left + 'px';
          detailPopover.style.top = top + 'px';
          detailPopover.classList.add('open');
          detailPopover.setAttribute('aria-hidden', 'false');
        }
      });
    });
  </script>
</body>
</html>`;
}

class ToolBoxWebviewProvider implements vscode.WebviewViewProvider {
  static readonly viewType = 'reverseProxy.sidebarView';
  private view: vscode.WebviewView | null = null;

  async resolveWebviewView(webviewView: vscode.WebviewView): Promise<void> {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.onDidDispose(() => {
      if (this.view === webviewView) {
        this.view = null;
      }
    });
    webviewView.webview.onDidReceiveMessage(async (message: { type?: string; repoName?: string; action?: string; left?: number; top?: number }) => {
      if (message.type === 'showStatus' && message.repoName) {
        const config = await getKeyProjectsConfig();
        const cachedStatus = getCachedKeyProjectStatuses(config)?.find((entry) => entry.configuredRepoName === message.repoName);
        const repoPath = getRepoPath(config.rootDir, message.repoName, config.mode);
        const displayName = await loadRepoDisplayName(config, repoPath);
        const detailStatus = cachedStatus ?? {
          configuredRepoName: message.repoName,
          repoName: displayName,
          repoPath,
          branch: 'unknown',
          syncState: 'unknown',
          aheadCount: 0,
          behindCount: 0,
          shortStatus: '',
          clean: false,
          available: false,
          error: 'Status not loaded. Click Refresh first.'
        };
        await webviewView.webview.postMessage({
          type: 'detail',
          title: detailStatus.repoName + ' - ' + detailStatus.branch,
          text: formatKeyProjectCachedDetail(detailStatus),
          left: message.left,
          top: message.top
        });
        return;
      }
      if (message.type !== 'action' || !message.action) {
        return;
      }
      switch (message.action) {
        case 'toggle':
          await toggleProxyFromSidebar();
          return;
        case 'logs':
          showLogs();
          return;
        case 'proxySettings':
          await openSettingsConfig();
          return;
        case 'keyRefresh':
          await refreshKeyProjects();
          return;
        case 'keySettings':
          await openKeyProjectsSettings();
          return;
        default:
          return;
      }
    });
    await this.refresh();
  }

  async refresh(): Promise<void> {
    if (!this.view) {
      return;
    }

    const model = await getToolBoxViewModel();
    this.view.webview.html = renderToolBoxWebview(this.view.webview, model);
  }
}


function setProxyState(state: ProxyState): void {
  proxyState = state;

  if (state === 'starting') {
    statusBarItem.text = '🟡 ReverseTun (Starting)';
    statusBarItem.tooltip = 'SSH reverse proxy is starting. Click to view status.';
  } else if (state === 'connected') {
    statusBarItem.text = '🟢 ReverseTun (Connected)';
    statusBarItem.tooltip = 'SSH reverse proxy is connected. Click to view status.';
  } else if (state === 'failed') {
    statusBarItem.text = '🔴 ReverseTun (Failed)';
    statusBarItem.tooltip = 'SSH reverse proxy failed. Click to view status.';
  } else {
    statusBarItem.text = '🔴 ReverseTun (Stopped)';
    statusBarItem.tooltip = 'SSH reverse proxy is stopped. Click to view status.';
  }

  void toolBoxWebviewProvider?.refresh();
}

function getReverseTunnelSidebarItemsForTest(): SidebarTestItem[] {
  const toggleLabel = proxyState === 'connected'
    ? 'ReverseTun: ON'
    : proxyState === 'starting'
      ? 'ReverseTun: CONNECTING...'
      : 'ReverseTun: OFF';
  const toggleCommand = proxyState === 'starting' ? undefined : 'reverseProxy.sidebarToggle';

  return [
    {
      kind: 'action',
      label: toggleLabel,
      command: toggleCommand,
      enabled: Boolean(toggleCommand),
      parentLabel: 'ReverseTunnel'
    },
    {
      kind: 'action',
      label: 'Open Logs',
      command: 'reverseProxy.showLogs',
      enabled: true,
      parentLabel: 'ReverseTunnel'
    },
    {
      kind: 'action',
      label: 'Settings',
      command: 'reverseProxy.openSettings',
      enabled: true,
      parentLabel: 'ReverseTunnel'
    }
  ];
}

async function getKeyProjectSidebarItemsForTest(): Promise<SidebarTestItem[]> {
  const config = await getKeyProjectsConfig();
  const issue = getKeyProjectsConfigurationIssue(config);
  const items: SidebarTestItem[] = [];

  if (issue) {
    items.push({
      kind: 'info',
      label: issue,
      tooltip: issue,
      enabled: false,
      parentLabel: 'Key Projects'
    });
  } else {
    const cached = getCachedKeyProjectStatuses(config);
    if (cached) {
      for (const status of cached) {
        const label = status.available
          ? (status.clean
              ? `\u2714\uFE0F ${status.repoName}: ${status.branch} - ${getKeyProjectSyncLabel(status)}`
              : `\u2757 ${status.repoName}: ${status.branch} - ${getKeyProjectSyncLabel(status)}`)
          : `\u26A0 ${status.repoName}: unavailable`;
        items.push({
          kind: 'project',
          label,
          tooltip: formatKeyProjectTooltip(status).value,
          command: 'reverseProxy.showKeyProjectStatus',
          arguments: [status.configuredRepoName],
          enabled: true,
          parentLabel: 'Key Projects'
        });
      }
    } else {
      items.push({
        kind: 'info',
        label: 'Click Refresh to load key project status.',
        tooltip: 'Click Refresh to load key project status.',
        enabled: false,
        parentLabel: 'Key Projects'
      });
    }
  }

  items.push({
    kind: 'action',
    label: keyProjectsRefreshPromise ? 'Refreshing...' : 'Refresh',
    command: keyProjectsRefreshPromise ? undefined : 'reverseProxy.refreshKeyProjects',
    enabled: !keyProjectsRefreshPromise,
    parentLabel: 'Key Projects'
  });
  items.push({
    kind: 'action',
    label: 'Settings',
    command: 'reverseProxy.openKeyProjectSettings',
    enabled: true,
    parentLabel: 'Key Projects'
  });

  return items;
}

async function getSidebarItemsForTest(): Promise<{ root: SidebarTestItem[]; children: SidebarTestItem[] }> {
  return {
    root: [
      { kind: 'group', label: 'ReverseTunnel', enabled: false },
      { kind: 'group', label: 'Key Projects', enabled: false }
    ],
    children: [...getReverseTunnelSidebarItemsForTest(), ...(await getKeyProjectSidebarItemsForTest())]
  };
}

async function updateKeyStatusBar(): Promise<void> {
  if (!keyStatusBarItem) {
    return;
  }

  keyStatusBarItem.command = 'reverseProxy.refreshKeyProjects';

  if (keyProjectsRefreshPromise) {
    keyStatusBarItem.text = '$(sync~spin) $(bookmark) Refreshing...';
    keyStatusBarItem.tooltip = 'Refreshing key project status.';
    keyStatusBarItem.show();
    return;
  }

  const config = await getKeyProjectsConfig();
  const issue = getKeyProjectsConfigurationIssue(config);
  if (issue) {
    keyStatusBarItem.text = '$(bookmark) setup';
    keyStatusBarItem.tooltip = issue;
    keyStatusBarItem.command = 'reverseProxy.openKeyProjectSettings';
    keyStatusBarItem.show();
    return;
  }

  const cached = getCachedKeyProjectStatuses(config);
  const first = cached?.[0];
  if (!first) {
    keyStatusBarItem.text = '$(bookmark) not loaded';
    keyStatusBarItem.tooltip = 'Click to refresh key project status.';
    keyStatusBarItem.show();
    return;
  }

  keyStatusBarItem.text = `$(bookmark) ${first.repoName} - ${first.branch}`;
  keyStatusBarItem.tooltip = formatKeyProjectTooltip(first);
  keyStatusBarItem.show();
}

function assertString(value: unknown, key: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Invalid config field '${key}': expected non-empty string.`);
  }
  return value.trim();
}

function assertNumber(value: unknown, key: string): number {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw new Error(`Invalid config field '${key}': expected number.`);
  }
  return value;
}

function assertStringArray(value: unknown, key: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`Invalid config field '${key}': expected string array.`);
  }

  return value
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim().replace(/[\\/]+$/g, ''))
    .filter((entry) => entry.length > 0);
}

function getWorkspaceFolderUri(workspacePath?: string): vscode.Uri | null {
  const overridePath = workspacePath ?? keyProjectsWorkspaceOverride;
  if (overridePath) {
    return vscode.Uri.file(overridePath);
  }

  return vscode.workspace.workspaceFolders?.[0]?.uri ?? null;
}

function getKeyProjectsConfigUri(workspacePath?: string): vscode.Uri | null {
  const workspaceUri = getWorkspaceFolderUri(workspacePath);
  return workspaceUri ? vscode.Uri.joinPath(workspaceUri, '.vscode', 'mytoolbox.json') : null;
}

function getDefaultKeyProjectsConfigContent(): string {
  return `${JSON.stringify(
    {
      keyProjects: {
        mode: 'local',
        rootDir: '',
        repoNames: [],
        sshTarget: '',
        sshPort: 22,
        gitPath: 'git',
        sshPath: 'ssh'
      }
    },
    null,
    2
  )}
`;
}

function isFileNotFoundError(error: unknown): boolean {
  if (error instanceof vscode.FileSystemError) {
    const details = `${error.name} ${error.message}`;
    return /FileNotFound|EntryNotFound|ENOENT/i.test(details);
  }

  const details = error instanceof Error ? `${error.name} ${error.message}` : String(error);
  return /FileNotFound|EntryNotFound|ENOENT/i.test(details);
}

async function getKeyProjectsConfig(workspacePath?: string): Promise<KeyProjectsConfig> {
  const configUri = getKeyProjectsConfigUri(workspacePath);
  if (!configUri) {
    const result = {
      mode: 'local' as KeyProjectsMode,
      rootDir: '',
      repoNames: [],
      sshTarget: '',
      sshPort: 22,
      gitPath: 'git',
      sshPath: 'ssh',
      loadedConfigPath: '<no-workspace>',
      configExists: false,
      workspaceAvailable: false
    };

    outputChannel?.appendLine('[key-projects] config path=<no-workspace> exists=false mode=local rootDir=<empty> repos=<none> sshTarget=<empty> sshPort=22');
    return result;
  }

  let parsed: Record<string, unknown> | null = null;

  try {
    const bytes = await vscode.workspace.fs.readFile(configUri);
    const rawText = Buffer.from(bytes).toString('utf8');
    const raw = JSON.parse(rawText) as unknown;
    if (!raw || typeof raw !== 'object') {
      throw new Error(`Invalid config file '${configUri.toString()}': root must be a JSON object.`);
    }
    parsed = raw as Record<string, unknown>;
  } catch (error) {
    if (!isFileNotFoundError(error)) {
      throw error;
    }
  }

  const section =
    parsed && parsed.keyProjects && typeof parsed.keyProjects === 'object'
      ? (parsed.keyProjects as Record<string, unknown>)
      : {};
  const rawMode = typeof section.mode === 'string' ? section.mode.trim().toLowerCase() : 'local';
  const mode: KeyProjectsMode = rawMode === 'ssh' ? 'ssh' : 'local';

  const result = {
    mode,
    rootDir: typeof section.rootDir === 'string' ? section.rootDir.trim() : '',
    repoNames: assertStringArray(section.repoNames ?? [], 'keyProjects.repoNames'),
    sshTarget: typeof section.sshTarget === 'string' ? section.sshTarget.trim() : '',
    sshPort: typeof section.sshPort === 'number' && Number.isFinite(section.sshPort) ? Math.max(1, section.sshPort) : 22,
    gitPath: typeof section.gitPath === 'string' && section.gitPath.trim() ? section.gitPath.trim() : 'git',
    sshPath: typeof section.sshPath === 'string' && section.sshPath.trim() ? section.sshPath.trim() : 'ssh',
    loadedConfigPath: configUri.toString(),
    configExists: Boolean(parsed),
    workspaceAvailable: true
  };

  outputChannel?.appendLine(
    `[key-projects] config path=${result.loadedConfigPath} exists=${result.configExists} mode=${result.mode} rootDir=${result.rootDir || '<empty>'} repos=${result.repoNames.join(', ') || '<none>'} sshTarget=${result.sshTarget || '<empty>'} sshPort=${result.sshPort}`
  );

  return result;
}

function getKeyProjectsConfigurationIssue(config: KeyProjectsConfig): string | null {
  if (!config.workspaceAvailable) {
    return 'Open a workspace folder to use key projects.';
  }

  if (!config.configExists) {
    return 'Create .vscode/mytoolbox.json to list key projects.';
  }

  if (!config.rootDir) {
    return 'Set keyProjects.rootDir in .vscode/mytoolbox.json.';
  }

  if (config.repoNames.length === 0) {
    return 'Set keyProjects.repoNames in .vscode/mytoolbox.json.';
  }

  if (config.mode === 'ssh' && !config.sshTarget) {
    return 'Set keyProjects.sshTarget in .vscode/mytoolbox.json when mode is ssh.';
  }

  return null;
}

async function openKeyProjectsSettings(workspacePath?: string): Promise<string> {
  const workspaceUri = getWorkspaceFolderUri(workspacePath);
  if (!workspaceUri) {
    throw new Error('Open a workspace folder before editing key project settings.');
  }

  const configUri = vscode.Uri.joinPath(workspaceUri, '.vscode', 'mytoolbox.json');
  const configDir = vscode.Uri.joinPath(workspaceUri, '.vscode');

  outputChannel?.appendLine(`[key-projects] opening settings file ${configUri.toString()}`);

  try {
    await vscode.workspace.fs.stat(configDir);
  } catch (error) {
    if (!isFileNotFoundError(error)) {
      throw error;
    }
    await vscode.workspace.fs.createDirectory(configDir);
  }

  try {
    await vscode.workspace.fs.stat(configUri);
  } catch (error) {
    if (!isFileNotFoundError(error)) {
      throw error;
    }
    await vscode.workspace.fs.writeFile(configUri, Buffer.from(getDefaultKeyProjectsConfigContent(), 'utf8'));
  }

  const doc = await vscode.workspace.openTextDocument(configUri);
  await vscode.window.showTextDocument(doc, { preview: false });
  return configUri.scheme === 'file' ? configUri.fsPath : configUri.toString();
}

function getRepoPath(rootDir: string, repoName: string, mode: KeyProjectsMode): string {
  if (repoName === '.') {
    return mode === 'ssh' ? rootDir.replace(/\\/g, '/') : rootDir;
  }

  if (mode === 'ssh') {
    return path.posix.join(rootDir.replace(/\\/g, '/'), repoName);
  }

  return path.join(rootDir, repoName);
}

function getRepoDisplayName(repoPath: string, mode: KeyProjectsMode): string {
  const normalized = mode === 'ssh'
    ? repoPath.replace(/\\/g, '/').replace(/\/+$/g, '')
    : repoPath.replace(/[\\/]+$/g, '');
  const displayName = mode === 'ssh' ? path.posix.basename(normalized) : path.basename(normalized);
  return displayName || normalized;
}

function parseRemoteRepoName(remoteUrl: string, fallbackName: string): string {
  const trimmed = remoteUrl.trim().replace(/[\\/]+$/g, '');
  if (!trimmed) {
    return fallbackName;
  }

  const lastSegment = trimmed.split(/[/:]/).filter((segment) => segment.length > 0).pop();
  return lastSegment || fallbackName;
}

async function loadRepoDisplayName(config: KeyProjectsConfig, repoPath: string): Promise<string> {
  const fallbackName = getRepoDisplayName(repoPath, config.mode);

  try {
    const remoteUrl = (await runGitForKeyProject(config, repoPath, ['config', '--get', 'remote.origin.url'])).trim();
    return parseRemoteRepoName(remoteUrl, fallbackName);
  } catch {
    return fallbackName;
  }
}

function quotePosixShellArg(value: string): string {
  return `'${value.replace(/'/g, `"'"'`)}'`;
}

function buildRemoteGitCommand(repoPath: string, args: string[]): string {
  return ['git', '-C', quotePosixShellArg(repoPath), ...args].join(' ');
}

function getKeyProjectRefreshConcurrency(config: KeyProjectsConfig): number {
  return config.mode === 'ssh' ? 4 : 4;
}

function getRemoteKeyProjectsBatchToken(): string {
  return `${Date.now()}-${process.pid}-${Math.random().toString(16).slice(2, 10)}`;
}

function getRemoteKeyProjectsScriptPath(token: string): string {
  return `/tmp/mytoolbox-key-projects-script-${token}.sh`;
}

function getRemoteKeyProjectsRunDir(token: string): string {
  return `/tmp/mytoolbox-key-projects-run-${token}`;
}

function buildRemoteKeyProjectsBatchScript(config: KeyProjectsConfig, remoteRunDir: string): string {
  const repoSpecs = config.repoNames
    .map((repoName, index) => `${index}|${repoName}`)
    .join('\n');
  const jobs = String(Math.max(1, Math.min(getKeyProjectRefreshConcurrency(config), config.repoNames.length || 1)));

  return [
    '#!/bin/sh',
    'set -eu',
    'ROOT_DIR=' + quotePosixShellArg(config.rootDir.replace(/\\/g, '/')),
    'JOBS=' + quotePosixShellArg(jobs),
    'RUN_DIR="${KEY_PROJECTS_RUN_DIR:-' + remoteRunDir.replace(/"/g, '\"') + '}"',
    'REPO_SPECS_FILE="$RUN_DIR/repo-specs.txt"',
    'mkdir -p "$RUN_DIR"',
    "cat <<'__MYTB_REPO_SPECS__' > \"$REPO_SPECS_FILE\"",
    repoSpecs,
    '__MYTB_REPO_SPECS__',
    'run_repo() {',
    '  idx="$1"',
    '  repo_name="$2"',
    '  out_file="$RUN_DIR/$idx.out"',
    '  repo_path="$ROOT_DIR"',
    '  if [ "$repo_name" != "." ]; then',
    '    repo_path="$ROOT_DIR/$repo_name"',
    '  fi',
    '  remote_url=""',
    '  fetch_error=""',
    '  status_output=""',
    '  error_message=""',
    '  if remote_url=$(git -C "$repo_path" config --get remote.origin.url 2>/dev/null); then',
    '    :',
    '  else',
    '    remote_url=""',
    '  fi',
    '  fetch_tmp="$RUN_DIR/$idx.fetch.err"',
    '  if git -C "$repo_path" fetch --prune --quiet > /dev/null 2>"$fetch_tmp"; then',
    '    :',
    '  else',
    '    fetch_error=$(cat "$fetch_tmp")',
    '  fi',
    '  status_tmp="$RUN_DIR/$idx.status.out"',
    '  if git -C "$repo_path" status --porcelain=v2 --branch >"$status_tmp" 2>&1; then',
    '    status_output=$(cat "$status_tmp")',
    '  else',
    '    error_message=$(cat "$status_tmp")',
    '  fi',
    '  {',
    '    printf "%s\n" "__MYTB_BEGIN__ $idx $repo_name"',
    '    printf "%s\n" "__MYTB_FIELD__ repoPath"',
    '    printf "%s\n" "$repo_path"',
    '    printf "%s\n" "__MYTB_END_FIELD__ repoPath"',
    '    printf "%s\n" "__MYTB_FIELD__ remoteUrl"',
    '    printf "%s\n" "$remote_url"',
    '    printf "%s\n" "__MYTB_END_FIELD__ remoteUrl"',
    '    printf "%s\n" "__MYTB_FIELD__ fetchError"',
    '    printf "%s\n" "$fetch_error"',
    '    printf "%s\n" "__MYTB_END_FIELD__ fetchError"',
    '    printf "%s\n" "__MYTB_FIELD__ error"',
    '    printf "%s\n" "$error_message"',
    '    printf "%s\n" "__MYTB_END_FIELD__ error"',
    '    printf "%s\n" "__MYTB_FIELD__ status"',
    '    printf "%s\n" "$status_output"',
    '    printf "%s\n" "__MYTB_END_FIELD__ status"',
    '    printf "%s\n" "__MYTB_END__ $idx $repo_name"',
    '  } > "$out_file"',
    '}',
    'activeJobs=0',
    'while IFS="|" read -r idx repo_name; do',
    '  [ -n "$idx" ] || continue',
    '  run_repo "$idx" "$repo_name" &',
    '  activeJobs=$((activeJobs + 1))',
    '  if [ "$activeJobs" -ge "$JOBS" ]; then',
    '    wait',
    '    activeJobs=0',
    '  fi',
    'done < "$REPO_SPECS_FILE"',
    'wait',
    'while IFS="|" read -r idx repo_name; do',
    '  [ -n "$idx" ] || continue',
    '  cat "$RUN_DIR/$idx.out"',
    'done < "$REPO_SPECS_FILE"'
  ].join('\n') + '\n';
}

function buildRemoteKeyProjectsBootstrapCommand(remoteScriptPath: string, remoteRunDir: string): string {
  return `sh -s -- ${quotePosixShellArg(remoteScriptPath)} ${quotePosixShellArg(remoteRunDir)}`;
}

function buildRemoteKeyProjectsBootstrapScript(batchScript: string): string {
  return [
    '#!/bin/sh',
    'set -eu',
    'remote_script_path="$1"',
    'remote_run_dir="$2"',
    'mkdir -p "$remote_run_dir"',
    "cat > \"$remote_script_path\" <<'__MYTB_REMOTE_BATCH_SCRIPT__'",
    batchScript.replace(/\r/g, '').replace(/\n$/, ''),
    '__MYTB_REMOTE_BATCH_SCRIPT__',
    'chmod +x "$remote_script_path"',
    'KEY_PROJECTS_RUN_DIR="$remote_run_dir" "$remote_script_path"'
  ].join('\n') + '\n';
}
function parseBatchedSshKeyProjectResults(output: string): Map<string, BatchedSshKeyProjectResult> {
  const lines = output.replace(/\r/g, '').split('\n');
  const results = new Map<string, BatchedSshKeyProjectResult>();
  let currentRepoName: string | null = null;
  let currentField: keyof Omit<BatchedSshKeyProjectResult, 'configuredRepoName'> | null = null;
  let currentFieldLines: string[] = [];
  let currentResult: BatchedSshKeyProjectResult | null = null;

  const commitField = (): void => {
    if (!currentResult || !currentField) {
      return;
    }

    currentResult[currentField] = currentFieldLines.join('\n').replace(/\n+$/g, '');
    currentField = null;
    currentFieldLines = [];
  };

  for (const line of lines) {
    const beginMatch = line.match(/^__MYTB_BEGIN__\s+(\d+)\s+(.*)$/);
    if (beginMatch) {
      currentRepoName = beginMatch[2];
      currentResult = {
        configuredRepoName: currentRepoName,
        repoPath: '',
        remoteUrl: '',
        fetchError: '',
        statusOutput: '',
        error: ''
      };
      currentField = null;
      currentFieldLines = [];
      continue;
    }

    const fieldMatch = line.match(/^__MYTB_FIELD__\s+(repoPath|remoteUrl|fetchError|error|status)$/);
    if (fieldMatch && currentResult) {
      commitField();
      const fieldName = fieldMatch[1] === 'status' ? 'statusOutput' : fieldMatch[1];
      currentField = fieldName as keyof Omit<BatchedSshKeyProjectResult, 'configuredRepoName'>;
      currentFieldLines = [];
      continue;
    }

    const endFieldMatch = line.match(/^__MYTB_END_FIELD__\s+(repoPath|remoteUrl|fetchError|error|status)$/);
    if (endFieldMatch && currentResult) {
      commitField();
      continue;
    }

    const endMatch = line.match(/^__MYTB_END__\s+(\d+)\s+(.*)$/);
    if (endMatch && currentResult && currentRepoName) {
      commitField();
      results.set(currentRepoName, currentResult);
      currentRepoName = null;
      currentResult = null;
      continue;
    }

    if (currentField) {
      currentFieldLines.push(line);
    }
  }

  return results;
}

function getKeyProjectsConfigSignature(config: KeyProjectsConfig): string {
  return JSON.stringify({
    mode: config.mode,
    rootDir: config.rootDir,
    repoNames: config.repoNames,
    sshTarget: config.sshTarget,
    sshPort: config.sshPort,
    gitPath: config.gitPath,
    sshPath: config.sshPath,
    loadedConfigPath: config.loadedConfigPath,
    configExists: config.configExists,
    workspaceAvailable: config.workspaceAvailable
  });
}

function invalidateKeyProjectsCache(reason: string): void {
  keyProjectsCache = null;
}

function getCachedKeyProjectStatuses(config: KeyProjectsConfig): KeyProjectStatus[] | null {
  const signature = getKeyProjectsConfigSignature(config);
  if (keyProjectsCache?.signature !== signature) {
    return null;
  }

  return keyProjectsCache.statuses;
}

function setCachedKeyProjectStatuses(config: KeyProjectsConfig, statuses: KeyProjectStatus[]): void {
  keyProjectsCache = {
    signature: getKeyProjectsConfigSignature(config),
    statuses
  };
}

function parseGitStatusSummary(output: string): {
  branch: string;
  upstream?: string;
  syncState: 'synced' | 'ahead' | 'behind' | 'diverged' | 'no-upstream' | 'unknown';
  aheadCount: number;
  behindCount: number;
  shortStatus: string;
  clean: boolean;
} {
  const lines = output.replace(/\r/g, '').split('\n');
  let branch = 'HEAD';
  let upstream: string | undefined;
  let aheadCount = 0;
  let behindCount = 0;
  const shortLines: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    if (trimmed.startsWith('# branch.head ')) {
      branch = trimmed.slice('# branch.head '.length).trim() || 'HEAD';
      continue;
    }

    if (trimmed.startsWith('# branch.upstream ')) {
      upstream = trimmed.slice('# branch.upstream '.length).trim() || undefined;
      continue;
    }

    if (trimmed.startsWith('# branch.ab ')) {
      const match = trimmed.match(/^# branch\.ab \+(\d+) \-(\d+)$/);
      if (match) {
        aheadCount = Number(match[1]);
        behindCount = Number(match[2]);
      }
      continue;
    }

    if (!trimmed.startsWith('# ')) {
      shortLines.push(trimmed);
    }
  }

  let syncState: KeyProjectStatus['syncState'] = 'unknown';
  if (!upstream) {
    syncState = 'no-upstream';
  } else if (aheadCount > 0 && behindCount > 0) {
    syncState = 'diverged';
  } else if (aheadCount > 0) {
    syncState = 'ahead';
  } else if (behindCount > 0) {
    syncState = 'behind';
  } else {
    syncState = 'synced';
  }

  return {
    branch,
    upstream,
    syncState,
    aheadCount,
    behindCount,
    shortStatus: shortLines.join('\n'),
    clean: shortLines.length === 0
  };
}

function runCommandWithInput(command: string, args: string[], input: string | undefined, timeoutMs = 8000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args);
    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill();
      reject(new Error(`Command timed out after ${timeoutMs}ms: ${command}`));
    }, timeoutMs);

    child.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
    });
    child.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });
    child.on('error', (error) => {
      clearTimeout(timeout);
      outputChannel?.appendLine(`[key-projects] command error: ${error.message}`);
      reject(new Error(`Failed to run ${command}: ${error.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timeout);
      if (timedOut) {
        return;
      }
      if (code !== 0) {
        const details = stderr.trim() || stdout.trim() || `exit code ${code}`;
        outputChannel?.appendLine(`[key-projects] command failed: ${details}`);
        reject(new Error(details));
        return;
      }
      resolve(stdout.trimEnd());
    });

    child.stdin.on('error', () => {
      // Ignore broken pipe errors when the remote process exits early.
    });
    if (typeof input === 'string') {
      child.stdin.end(input);
    } else {
      child.stdin.end();
    }
  });
}

function runCommand(command: string, args: string[], timeoutMs = 8000): Promise<string> {
  return runCommandWithInput(command, args, undefined, timeoutMs);
}
async function runGitForKeyProject(
  config: KeyProjectsConfig,
  repoPath: string,
  args: string[],
  timeoutMs?: number
): Promise<string> {
  if (config.mode === 'ssh') {
    const sshArgs = config.sshPort === 22
      ? [config.sshTarget, buildRemoteGitCommand(repoPath, args)]
      : ['-p', String(config.sshPort), config.sshTarget, buildRemoteGitCommand(repoPath, args)];
    return runCommand(config.sshPath, sshArgs, timeoutMs);
  }

  return runCommand(config.gitPath, ['-C', repoPath, ...args], timeoutMs);
}

async function loadKeyProjectStatus(config: KeyProjectsConfig, repoName: string): Promise<KeyProjectStatus> {
  const repoPath = getRepoPath(config.rootDir, repoName, config.mode);
  const displayName = await loadRepoDisplayName(config, repoPath);

  try {
    let fetchError: string | undefined;
    try {
      await runGitForKeyProject(config, repoPath, ['fetch', '--prune', '--quiet'], 20000);
    } catch (error) {
      fetchError = error instanceof Error ? error.message : String(error);
      outputChannel?.appendLine(`[key-projects] fetch warning repo=${repoName}: ${fetchError}`);
    }

    const summary = await runGitForKeyProject(config, repoPath, ['status', '--porcelain=v2', '--branch']);
    const parsed = parseGitStatusSummary(summary.trimEnd());

    return {
      configuredRepoName: repoName,
      repoName: displayName,
      repoPath,
      branch: parsed.branch,
      upstream: parsed.upstream,
      syncState: fetchError ? 'unknown' : parsed.syncState,
      aheadCount: parsed.aheadCount,
      behindCount: parsed.behindCount,
      shortStatus: parsed.shortStatus,
      clean: parsed.clean,
      available: true,
      fetchError
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    outputChannel?.appendLine(`[key-projects] failed repo=${repoName}: ${message}`);
    return {
      configuredRepoName: repoName,
      repoName: displayName,
      repoPath,
      branch: 'unknown',
      syncState: 'unknown',
      aheadCount: 0,
      behindCount: 0,
      shortStatus: '',
      clean: false,
      available: false,
      error: message
    };
  }
}

async function loadKeyProjectStatusesFromBatchedSsh(config: KeyProjectsConfig): Promise<KeyProjectStatus[]> {
  const token = getRemoteKeyProjectsBatchToken();
  const remoteScriptPath = getRemoteKeyProjectsScriptPath(token);
  const remoteRunDir = getRemoteKeyProjectsRunDir(token);
  const script = buildRemoteKeyProjectsBatchScript(config, remoteRunDir);
  const bootstrapScript = buildRemoteKeyProjectsBootstrapScript(script);
  outputChannel?.appendLine(`[key-projects] batched ssh script=${remoteScriptPath} runDir=${remoteRunDir}`);

  const output = await runCommandWithInput(
    config.sshPath,
    config.sshPort === 22
      ? [config.sshTarget, buildRemoteKeyProjectsBootstrapCommand(remoteScriptPath, remoteRunDir)]
      : ['-p', String(config.sshPort), config.sshTarget, buildRemoteKeyProjectsBootstrapCommand(remoteScriptPath, remoteRunDir)],
    bootstrapScript,
    Math.max(20000, config.repoNames.length * 8000)
  );
  const parsedResults = parseBatchedSshKeyProjectResults(output);

  return config.repoNames.map((repoName) => {
    const repoPath = getRepoPath(config.rootDir, repoName, config.mode);
    const parsedResult = parsedResults.get(repoName);

    if (!parsedResult) {
      return {
        configuredRepoName: repoName,
        repoName: getRepoDisplayName(repoPath, config.mode),
        repoPath,
        branch: 'unknown',
        syncState: 'unknown' as const,
        aheadCount: 0,
        behindCount: 0,
        shortStatus: '',
        clean: false,
        available: false,
        error: 'Missing batched SSH result.'
      };
    }

    const displayName = parseRemoteRepoName(parsedResult.remoteUrl, getRepoDisplayName(parsedResult.repoPath || repoPath, config.mode));

    if (parsedResult.error) {
      outputChannel?.appendLine(`[key-projects] failed repo=${repoName}: ${parsedResult.error}`);
      return {
        configuredRepoName: repoName,
        repoName: displayName,
        repoPath: parsedResult.repoPath || repoPath,
        branch: 'unknown',
        syncState: 'unknown' as const,
        aheadCount: 0,
        behindCount: 0,
        shortStatus: '',
        clean: false,
        available: false,
        error: parsedResult.error
      };
    }

    const parsedStatus = parseGitStatusSummary(parsedResult.statusOutput.trimEnd());

    if (parsedResult.fetchError) {
      outputChannel?.appendLine(`[key-projects] fetch warning repo=${repoName}: ${parsedResult.fetchError}`);
    }

    return {
      configuredRepoName: repoName,
      repoName: displayName,
      repoPath: parsedResult.repoPath || repoPath,
      branch: parsedStatus.branch,
      upstream: parsedStatus.upstream,
      syncState: parsedResult.fetchError ? 'unknown' : parsedStatus.syncState,
      aheadCount: parsedStatus.aheadCount,
      behindCount: parsedStatus.behindCount,
      shortStatus: parsedStatus.shortStatus,
      clean: parsedStatus.clean,
      available: true,
      fetchError: parsedResult.fetchError || undefined
    };
  });
}

async function loadKeyProjectStatuses(config: KeyProjectsConfig): Promise<KeyProjectStatus[]> {
  outputChannel?.appendLine(`[key-projects] refresh start count=${config.repoNames.length}`);
  if (config.mode === 'ssh') {
    try {
      return await loadKeyProjectStatusesFromBatchedSsh(config);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      outputChannel?.appendLine(`[key-projects] batched ssh refresh failed: ${message}`);
      outputChannel?.appendLine('[key-projects] falling back to per-repo ssh refresh.');
    }
  }

  const statuses: KeyProjectStatus[] = [];
  for (const repoName of config.repoNames) {
    statuses.push(await loadKeyProjectStatus(config, repoName));
  }
  return statuses;
}

async function refreshKeyProjects(): Promise<void> {
  if (keyProjectsRefreshPromise) {
    return keyProjectsRefreshPromise;
  }

  keyProjectsRefreshPromise = (async () => {
    const config = await getKeyProjectsConfig();
    const issue = getKeyProjectsConfigurationIssue(config);
    if (issue) {
      outputChannel?.appendLine(`[key-projects] refresh skipped: ${issue}`);
      invalidateKeyProjectsCache('configuration issue');
      void toolBoxWebviewProvider?.refresh();
    
      await updateKeyStatusBar();
      return;
    }

    const statuses = await loadKeyProjectStatuses(config);
    setCachedKeyProjectStatuses(config, statuses);
    outputChannel?.appendLine(`[key-projects] refresh complete count=${statuses.length}`);
    void toolBoxWebviewProvider?.refresh();
  
    await updateKeyStatusBar();
  })();

  void toolBoxWebviewProvider?.refresh();

  void updateKeyStatusBar();

  try {
    await keyProjectsRefreshPromise;
  } finally {
    keyProjectsRefreshPromise = null;
    void toolBoxWebviewProvider?.refresh();
  
    await updateKeyStatusBar();
  }
}

function formatKeyProjectTooltip(status: KeyProjectStatus): vscode.MarkdownString {
  const escape = (value: string): string => value.replace(/\\/g, '\\\\').replace(/`/g, '\\`');
  const code = (value: string): string => '`' + escape(value) + '`';
  const lines = [
    '- repo: ' + code(status.repoName),
    '- branch: ' + code(status.branch),
    '- remote: ' + code(getKeyProjectSyncLabel(status)),
    '- status: ' + code(status.available ? (status.clean ? 'clean' : 'dirty') : 'unavailable'),
    '- path: ' + code(status.repoPath)
  ];

  if (!status.available) {
    lines.push('- error: ' + code(status.error ?? 'Unavailable'));
  } else {
    lines.push('- upstream: ' + code(status.upstream ?? 'not configured'));
    lines.push('- fetch: ' + code(status.fetchError ? 'failed (' + status.fetchError + ')' : 'ok'));

    if (status.clean) {
      lines.push('- changes: ' + code('working tree clean'));
    } else {
      lines.push('- changes:');
      for (const entry of status.shortStatus.split('\n').filter((line) => line.trim().length > 0)) {
        lines.push('  - ' + code(entry));
      }
    }
  }

  return new vscode.MarkdownString(lines.join('\n'));
}

function getKeyProjectSyncLabel(status: Pick<KeyProjectStatus, 'syncState' | 'aheadCount' | 'behindCount'>): string {
  switch (status.syncState) {
    case 'synced':
      return 'synced';
    case 'ahead':
      return 'ahead ' + status.aheadCount;
    case 'behind':
      return 'behind ' + status.behindCount;
    case 'diverged':
      return 'diverged +' + status.aheadCount + '/-' + status.behindCount;
    case 'no-upstream':
      return 'no upstream';
    default:
      return 'sync unknown';
  }
}

function formatKeyProjectOutput(status: KeyProjectStatus): string {
  const lines = [
    '[key-project] repo=' + status.repoName,
    'Path: ' + status.repoPath,
    'Branch: ' + status.branch,
    'Upstream: ' + (status.upstream ?? 'not configured'),
    'Remote Sync: ' + getKeyProjectSyncLabel(status),
    'Fetch: ' + (status.fetchError ? 'failed (' + status.fetchError + ')' : 'ok'),
    'Status: ' + (status.available ? (status.clean ? 'clean' : 'dirty') : 'unavailable'),
    '',
    status.available ? (status.fullStatus ?? '') : 'Error: ' + (status.error ?? 'Unavailable')
  ];

  return lines.join('\n').trim();
}

function formatKeyProjectCachedDetail(status: KeyProjectStatus): string {
  const lines = [
    'Repo: ' + status.repoName,
    'Path: ' + status.repoPath,
    'Branch: ' + status.branch,
    'Upstream: ' + (status.upstream ?? 'not configured'),
    'Remote Sync: ' + getKeyProjectSyncLabel(status),
    'Fetch: ' + (status.fetchError ? 'failed (' + status.fetchError + ')' : 'ok'),
    'Status: ' + (status.available ? (status.clean ? 'clean' : 'dirty') : 'unavailable')
  ];

  if (!status.available) {
    lines.push('Error: ' + (status.error ?? 'Unavailable'));
    return lines.join('\n');
  }

  if (status.clean) {
    lines.push('Changes: working tree clean');
  } else {
    lines.push('Changes:');
    for (const entry of status.shortStatus.split('\n').filter((line) => line.trim().length > 0)) {
      lines.push(entry);
    }
  }

  return lines.join('\n');
}

async function showKeyProjectStatus(repoName: string): Promise<string> {
  const config = await getKeyProjectsConfig();
  const repoPath = getRepoPath(config.rootDir, repoName, config.mode);
  const displayName = await loadRepoDisplayName(config, repoPath);
  let status = getCachedKeyProjectStatuses(config)?.find((entry) => entry.configuredRepoName === repoName) ?? {
    configuredRepoName: repoName,
    repoName: displayName,
    repoPath,
    branch: 'unknown',
    syncState: 'unknown',
    aheadCount: 0,
    behindCount: 0,
    shortStatus: '',
    clean: false,
    available: false,
    error: 'Status not loaded. Click Refresh first.'
  };

  if (status.available) {
    try {
      const fullStatus = (await runGitForKeyProject(config, repoPath, ['status'])).trim();
      status = { ...status, fullStatus };
      const cached = getCachedKeyProjectStatuses(config);
      if (cached) {
        setCachedKeyProjectStatuses(
          config,
          cached.map((entry) => (entry.configuredRepoName === repoName ? status : entry))
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      status = { ...status, available: false, error: message, fullStatus: message };
    }
  }

  const text = formatKeyProjectOutput(status);
  outputChannel.appendLine(`[key-projects] showing detailed status for repo=${repoName} display=${status.repoName}`);
  outputChannel.appendLine(text);
  outputChannel.show(true);
  return text;
}

function resolveConfiguredConfigPathWithContext(configFile: string, options?: ResolvePathOptions): string {
  if (path.isAbsolute(configFile)) {
    return configFile;
  }

  const workspaceFolder = options?.workspaceFolder ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const remoteName = options?.remoteName ?? vscode.env.remoteName;
  const homeDir = options?.homeDir ?? os.homedir();

  if (!remoteName && workspaceFolder) {
    return path.join(workspaceFolder, configFile);
  }

  return path.join(homeDir, configFile);
}

function resolveConfigPathWithContext(configFile: string, options?: ResolvePathOptions): string {
  if (path.isAbsolute(configFile)) {
    return configFile;
  }

  const workspaceFolder = options?.workspaceFolder ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const remoteName = options?.remoteName ?? vscode.env.remoteName;
  const homeDir = options?.homeDir ?? os.homedir();
  const extensionPath = options?.extensionPath ?? extensionContextRef?.extensionPath;

  if (!remoteName && workspaceFolder) {
    const workspacePath = path.join(workspaceFolder, configFile);
    if (fs.existsSync(workspacePath)) {
      return workspacePath;
    }
  }

  const homePath = path.join(homeDir, configFile);
  if (fs.existsSync(homePath)) {
    return homePath;
  }

  if (!extensionPath) {
    throw new Error('Extension context is not initialized.');
  }

  return path.join(extensionPath, 'resources', 'reverse-proxy.config.json');
}

function resolveConfigPath(configFile: string): string {
  return resolveConfigPathWithContext(configFile);
}

function resolveConfiguredConfigPath(configFile: string): string {
  return resolveConfiguredConfigPathWithContext(configFile);
}

function loadFileProxyConfig(filePath: string): FileProxyConfig {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Config file not found: ${filePath}`);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to parse config file '${filePath}': ${message}`);
  }

  if (!raw || typeof raw !== 'object') {
    throw new Error(`Invalid config file '${filePath}': root must be a JSON object.`);
  }

  const root = raw as Record<string, unknown>;
  const section = root.ReverseTunnel;
  if (!section || typeof section !== 'object') {
    throw new Error(`Invalid config file '${filePath}': missing object field 'ReverseTunnel'.`);
  }

  const data = section as Record<string, unknown>;
  const identityFile = typeof data.identityFile === 'string' ? data.identityFile.trim() : '';
  const connectionReadyDelayMs = assertNumber(data.connectionReadyDelayMs, 'ReverseTunnel.connectionReadyDelayMs');
  if (connectionReadyDelayMs <= 0) {
    throw new Error(`Invalid config field 'ReverseTunnel.connectionReadyDelayMs': expected > 0.`);
  }

  return {
    sshPath: assertString(data.sshPath, 'ReverseTunnel.sshPath'),
    connectionReadyDelayMs,
    remoteHost: assertString(data.remoteHost, 'ReverseTunnel.remoteHost'),
    remotePort: assertNumber(data.remotePort, 'ReverseTunnel.remotePort'),
    remoteUser: assertString(data.remoteUser, 'ReverseTunnel.remoteUser'),
    remoteBindPort: assertNumber(data.remoteBindPort, 'ReverseTunnel.remoteBindPort'),
    localHost: assertString(data.localHost, 'ReverseTunnel.localHost'),
    localPort: assertNumber(data.localPort, 'ReverseTunnel.localPort'),
    identityFile
  };
}

function getConfig(): RuntimeProxyConfig {
  const config = vscode.workspace.getConfiguration('reverseProxy');
  const configFile = config.get<string>('configFile', 'reverse-proxy.config.json');
  const configPath = resolveConfigPath(configFile);
  const fileConfig = loadFileProxyConfig(configPath);

  return {
    ...fileConfig,
    loadedConfigPath: configPath
  };
}

function verifySshExists(sshPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const check = spawn(sshPath, ['-V']);

    const onData = (data: Buffer) => {
      outputChannel.appendLine(`[ssh-check] ${data.toString().trim()}`);
    };

    check.stdout.on('data', onData);
    check.stderr.on('data', onData);

    check.on('error', (err) => {
      reject(new Error(`Cannot run ssh command '${sshPath}': ${err.message}`));
    });

    check.on('close', (code) => {
      if (code === 0 || code === 255) {
        resolve();
      } else {
        reject(new Error(`ssh check exited with code ${code}`));
      }
    });
  });
}

function normalizeCommandLine(commandLine: string): string {
  return commandLine.replace(/\s+/g, ' ').trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function commandLineHasArg(commandLine: string, value: string): boolean {
  const pattern = new RegExp(`(^|\\s|["'])${escapeRegExp(value)}(?=\\s|["']|$)`, 'i');
  return pattern.test(commandLine);
}

function isMatchingTunnelCommand(commandLine: string, config: RuntimeProxyConfig): boolean {
  const normalized = normalizeCommandLine(commandLine);
  if (!normalized) {
    return false;
  }

  const reverseSpec = `${config.remoteBindPort}:${config.localHost}:${config.localPort}`;
  const reverseSpecLower = reverseSpec.toLowerCase();
  const remoteTarget = `${config.remoteUser}@${config.remoteHost}`;
  const normalizedLower = normalized.toLowerCase();

  const hasReverseFlag = /(^|\s)-R(?=\s|$)/i.test(normalized);
  const hasReverseSpec = normalizedLower.includes(reverseSpecLower);
  if (!hasReverseFlag || !hasReverseSpec) {
    return false;
  }

  const hasRemoteTarget =
    commandLineHasArg(normalized, remoteTarget) ||
    commandLineHasArg(normalized, config.remoteHost) ||
    commandLineHasArg(normalized, config.remoteUser);

  if (!hasRemoteTarget) {
    return false;
  }

  return true;
}

function buildWindowsProcessInspectionScript(): string {
  return [
    '$ErrorActionPreference = "Stop";',
    'Get-CimInstance Win32_Process |',
    '  Where-Object { $_.CommandLine } |',
    '  Select-Object ProcessId, CommandLine |',
    '  ConvertTo-Json -Compress'
  ].join(' ');
}

function listCandidateProcesses(): Promise<ExistingTunnelMatch[]> {
  return new Promise((resolve, reject) => {
    if (process.platform === 'win32') {
      const script = buildWindowsProcessInspectionScript();
      const inspector = spawn('powershell.exe', ['-NoProfile', '-Command', script]);
      let stdout = '';
      let stderr = '';

      inspector.stdout.on('data', (data: Buffer) => {
        stdout += data.toString();
      });
      inspector.stderr.on('data', (data: Buffer) => {
        stderr += data.toString();
      });
      inspector.on('error', (error) => {
        reject(new Error(`Failed to inspect existing processes: ${error.message}`));
      });
      inspector.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(`Process inspection exited with code ${code}: ${stderr.trim()}`));
          return;
        }

        const trimmed = stdout.trim();
        if (!trimmed) {
          resolve([]);
          return;
        }

        try {
          const parsed = JSON.parse(trimmed) as
            | { ProcessId?: number; CommandLine?: string }
            | Array<{ ProcessId?: number; CommandLine?: string }>;
          const entries = Array.isArray(parsed) ? parsed : [parsed];
          resolve(
            entries
              .filter((entry) => typeof entry.ProcessId === 'number' && typeof entry.CommandLine === 'string')
              .map((entry) => ({
                pid: entry.ProcessId as number,
                commandLine: entry.CommandLine as string
              }))
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          reject(new Error(`Failed to parse process inspection output: ${message}`));
        }
      });
      return;
    }

    const inspector = spawn('ps', ['-ax', '-o', 'pid=', '-o', 'command=']);
    let stdout = '';
    let stderr = '';

    inspector.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
    });
    inspector.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });
    inspector.on('error', (error) => {
      reject(new Error(`Failed to inspect existing processes: ${error.message}`));
    });
    inspector.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`Process inspection exited with code ${code}: ${stderr.trim()}`));
        return;
      }

      const matches = stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) => {
          const match = line.match(/^(\d+)\s+(.*)$/);
          if (!match) {
            return null;
          }
          return {
            pid: Number(match[1]),
            commandLine: match[2]
          };
        })
        .filter((entry): entry is ExistingTunnelMatch => Boolean(entry));
      resolve(matches);
    });
  });
}

async function findExistingTunnelProcess(config: RuntimeProxyConfig): Promise<ExistingTunnelMatch | null> {
  const processes = await listCandidateProcesses();
  const currentPid = process.pid;

  for (const candidate of processes) {
    if (candidate.pid === currentPid) {
      continue;
    }
    if (sshProcess?.pid && candidate.pid === sshProcess.pid) {
      return candidate;
    }
    if (isMatchingTunnelCommand(candidate.commandLine, config)) {
      return candidate;
    }
  }

  return null;
}

async function syncProxyStateFromSystem(config?: RuntimeProxyConfig): Promise<boolean> {
  let runtimeConfig = config;
  if (!runtimeConfig) {
    try {
      runtimeConfig = getConfig();
    } catch {
      return false;
    }
  }

  try {
    const existing = await findExistingTunnelProcess(runtimeConfig);
    if (!existing) {
      externalTunnelPid = null;
      if (!sshProcess && proxyState === 'connected') {
        setProxyState('stopped');
      }
      return false;
    }

    externalTunnelPid = sshProcess?.pid === existing.pid ? null : existing.pid;
    if (proxyState !== 'connected') {
      outputChannel.appendLine(`[sync] detected existing reverse tunnel process pid=${existing.pid}`);
      setProxyState('connected');
    }
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    outputChannel.appendLine(`[warn] unable to inspect existing tunnel processes: ${message}`);
    return false;
  }
}

async function startProxy(): Promise<void> {
  if (sshProcess) {
    vscode.window.showInformationMessage('Reverse proxy is already running.');
    return;
  }

  let config: RuntimeProxyConfig;
  try {
    config = getConfig();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    outputChannel.appendLine(`[error] ${message}`);
    setProxyState('failed');
    vscode.window.showErrorMessage(`Failed to load reverse proxy config: ${message}`);
    return;
  }

  const remoteTarget = `${config.remoteUser}@${config.remoteHost}`;
  const reverseSpec = `${config.remoteBindPort}:${config.localHost}:${config.localPort}`;
  outputChannel.appendLine(`[config] using file: ${config.loadedConfigPath}`);
  if (vscode.env.remoteName) {
    outputChannel.appendLine(`[mode] workspace is remote (${vscode.env.remoteName}), tunnel runs on local UI host.`);
  }

  if (await syncProxyStateFromSystem(config)) {
    vscode.window.showInformationMessage('Reverse proxy is already running in another VS Code window.');
    return;
  }

  setProxyState('starting');

  try {
    await verifySshExists(config.sshPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    outputChannel.appendLine(`[error] ${message}`);
    setProxyState('failed');
    vscode.window.showErrorMessage(
      `SSH command is unavailable. Install OpenSSH or update 'sshPath' in reverse-proxy.config.json. Details: ${message}`
    );
    return;
  }

  const args = [
    '-N',
    '-p',
    String(config.remotePort),
    '-o',
    'ExitOnForwardFailure=yes',
    '-o',
    'ServerAliveInterval=30',
    '-o',
    'ServerAliveCountMax=3',
    '-R',
    reverseSpec
  ];

  if (config.identityFile.length > 0) {
    args.push('-i', config.identityFile);
  }

  args.push(remoteTarget);

  outputChannel.appendLine(`[start] ${config.sshPath} ${args.join(' ')}`);

  try {
    sshProcess = spawn(config.sshPath, args);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    outputChannel.appendLine(`[error] failed to spawn ssh: ${message}`);
    vscode.window.showErrorMessage(`Failed to start reverse proxy: ${message}`);
    sshProcess = null;
    return;
  }

  stopRequested = false;
  externalTunnelPid = null;
  let hasFailed = false;
  const stderrLogState: SshStderrLogState = {
    lastLocalTargetConnectFailureLogAt: new Map<string, number>(),
    localTargetConnectFailureContextUntilMs: 0
  };
  const markFailed = (message: string): void => {
    if (hasFailed) {
      return;
    }
    hasFailed = true;
    outputChannel.appendLine(`[error] ${message}`);
    setProxyState('failed');
    vscode.window.showErrorMessage(message);
  };

  if (connectTimer) {
    clearTimeout(connectTimer);
  }
  connectTimer = setTimeout(() => {
    if (sshProcess && !hasFailed && !stopRequested) {
      setProxyState('connected');
      vscode.window.showInformationMessage('Reverse proxy connected.');
    }
  }, config.connectionReadyDelayMs);

  sshProcess.stdout.on('data', (data: Buffer) => {
    outputChannel.appendLine(`[stdout] ${data.toString().trim()}`);
  });

  sshProcess.stderr.on('data', (data: Buffer) => {
    const lines = data
      .toString()
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    for (const text of lines) {
      if (shouldLogSshStderr(text, config, Date.now(), stderrLogState)) {
        outputChannel.appendLine(`[stderr] ${text}`);
      }
    }

    const text = lines.join('\n');
    if (/remote port forwarding failed/i.test(text) || /address already in use/i.test(text)) {
      markFailed(`Reverse proxy failed: remote port ${config.remoteBindPort} is already in use.`);
      if (sshProcess) {
        sshProcess.kill();
      }
    }
  });

  sshProcess.on('error', (err: Error) => {
    markFailed(`Reverse proxy failed: ${err.message}`);
  });

  sshProcess.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
    outputChannel.appendLine(`[stop] ssh exited with code=${code} signal=${signal}`);
    if (connectTimer) {
      clearTimeout(connectTimer);
      connectTimer = null;
    }

    if (stopRequested) {
      setProxyState('stopped');
    } else if (hasFailed) {
      // Keep failed state.
    } else if (proxyState === 'starting') {
      markFailed(`Reverse proxy failed before connection established (code=${code}, signal=${signal}).`);
    } else if (proxyState === 'connected') {
      markFailed(`Reverse proxy disconnected unexpectedly (code=${code}, signal=${signal}).`);
    } else {
      setProxyState('stopped');
    }

    sshProcess = null;
    externalTunnelPid = null;
    stopRequested = false;
  });

  outputChannel.show(true);
}

function stopProxy(): void {
  if (!sshProcess && !externalTunnelPid) {
    vscode.window.showInformationMessage('Reverse proxy is not running.');
    return;
  }

  outputChannel.appendLine('[stop] stopping ssh reverse proxy');
  stopRequested = true;
  if (connectTimer) {
    clearTimeout(connectTimer);
    connectTimer = null;
  }
  if (sshProcess) {
    sshProcess.kill();
    sshProcess = null;
  } else if (externalTunnelPid) {
    try {
      process.kill(externalTunnelPid);
      outputChannel.appendLine(`[stop] sent termination signal to existing reverse tunnel pid=${externalTunnelPid}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      outputChannel.appendLine(`[warn] failed to stop existing reverse tunnel pid=${externalTunnelPid}: ${message}`);
      vscode.window.showErrorMessage(`Failed to stop reverse proxy process ${externalTunnelPid}: ${message}`);
      return;
    }
  }
  externalTunnelPid = null;
  setProxyState('stopped');
  vscode.window.showInformationMessage('Reverse proxy stopping...');
}

async function toggleProxyFromSidebar(): Promise<void> {
  if (proxyState === 'starting') {
    return;
  }

  if (proxyState === 'connected' || sshProcess || externalTunnelPid) {
    stopProxy();
    return;
  }

  await startProxy();
}

function showStatus(): void {
  vscode.window.showInformationMessage(`Reverse proxy status: ${getStateLabel(proxyState)}`);
}

function showLogs(): void {
  outputChannel.show(true);
}

function getDefaultConfigJsonContent(): string {
  return JSON.stringify(
    {
      ReverseTunnel: {
        sshPath: 'ssh',
        connectionReadyDelayMs: 1200,
        remoteHost: 'FOO_ADDRESS',
        remotePort: 4001,
        remoteUser: 'FOO_USER',
        remoteBindPort: 17897,
        localHost: '127.0.0.1',
        localPort: 7897,
        identityFile: ''
      }
    },
    null,
    2
  );
}

async function openSettingsConfig(): Promise<void> {
  const reverseProxyConfig = vscode.workspace.getConfiguration('reverseProxy');
  const configuredPath = reverseProxyConfig.get<string>('configFile', 'reverse-proxy.config.json');
  const currentPath = resolveConfiguredConfigPath(configuredPath);

  let finalConfigPath = currentPath;

  if (!fs.existsSync(currentPath)) {
    const defaultUri =
      !vscode.env.remoteName && vscode.workspace.workspaceFolders?.[0]?.uri
        ? vscode.workspace.workspaceFolders[0].uri
        : vscode.Uri.file(os.homedir());

    const selected = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      openLabel: 'Select',
      defaultUri
    });

    if (!selected || selected.length === 0) {
      return;
    }

    const selectedDir = selected[0].fsPath;
    finalConfigPath = path.join(selectedDir, 'configs.json');

    if (!fs.existsSync(finalConfigPath)) {
      await vscode.workspace.fs.writeFile(
        vscode.Uri.file(finalConfigPath),
        Buffer.from(getDefaultConfigJsonContent(), 'utf8')
      );
    }

    await reverseProxyConfig.update('configFile', finalConfigPath, vscode.ConfigurationTarget.Global);
    void vscode.window.showInformationMessage(`Config file created: ${finalConfigPath}`);
  }

  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(finalConfigPath));
  await vscode.window.showTextDocument(doc, { preview: false });
}

export function activate(context: vscode.ExtensionContext): void {
  extensionContextRef = context;
  outputChannel = createTimestampedOutputChannel(vscode.window.createOutputChannel('Reverse Proxy'));
  keyStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 150);
  keyStatusBarItem.command = 'reverseProxy.refreshKeyProjects';
  keyStatusBarItem.text = '$(bookmark) not loaded';
  keyStatusBarItem.tooltip = 'Click to refresh key project status.';
  keyStatusBarItem.show();

  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBarItem.command = 'reverseProxy.showStatus';
  setProxyState('stopped');
  statusBarItem.show();
  toolBoxWebviewProvider = new ToolBoxWebviewProvider();

  if (vscode.env.remoteName) {
    outputChannel.appendLine(`[mode] remote workspace detected (${vscode.env.remoteName}); extension runs on local UI host.`);
  }

  void syncProxyStateFromSystem();
  void updateKeyStatusBar();

  const keyProjectsWatchers = (vscode.workspace.workspaceFolders ?? []).map((folder) => {
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, '.vscode/mytoolbox.json'));
    watcher.onDidChange(() => {
      invalidateKeyProjectsCache('config file changed');
      void toolBoxWebviewProvider?.refresh();
    
      void updateKeyStatusBar();
    });
    watcher.onDidCreate(() => {
      invalidateKeyProjectsCache('config file created');
      void toolBoxWebviewProvider?.refresh();
    
      void updateKeyStatusBar();
    });
    watcher.onDidDelete(() => {
      invalidateKeyProjectsCache('config file deleted');
      void toolBoxWebviewProvider?.refresh();
    
      void updateKeyStatusBar();
    });
    return watcher;
  });

  const toolBoxWebviewRegistration = vscode.window.registerWebviewViewProvider(ToolBoxWebviewProvider.viewType, toolBoxWebviewProvider);

  context.subscriptions.push(
    outputChannel,
    keyStatusBarItem,
    statusBarItem,
    toolBoxWebviewRegistration,
    ...keyProjectsWatchers,
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('reverseProxy.configFile')) {
        void syncProxyStateFromSystem();
  void updateKeyStatusBar();
      }
      if (event.affectsConfiguration('reverseProxy')) {
        void toolBoxWebviewProvider?.refresh();
      
      }
      void updateKeyStatusBar();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('reverseProxy.start', async () => {
      await startProxy();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('reverseProxy.stop', () => {
      stopProxy();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('reverseProxy.showStatus', () => {
      showStatus();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('reverseProxy.sidebarToggle', async () => {
      await toggleProxyFromSidebar();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('reverseProxy.showLogs', () => {
      showLogs();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('reverseProxy.openSettings', async () => {
      await openSettingsConfig();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('reverseProxy.openKeyProjectSettings', async () => {
      return openKeyProjectsSettings();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('reverseProxy.refreshKeyProjects', async () => {
      await refreshKeyProjects();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('reverseProxy.showKeyProjectStatus', async (repoName: string) => {
      return showKeyProjectStatus(repoName);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('reverseProxy.test.getToolBoxViewState', async () => {
      return getToolBoxViewModel();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('reverseProxy.test.getSidebarItems', async () => {
      return getSidebarItemsForTest();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('reverseProxy.test.getKeyProjectsViewState', async () => {
      return getKeyProjectsViewModel();
    })
  );


  context.subscriptions.push(
    vscode.commands.registerCommand('reverseProxy.test.resolvePaths', (args: ResolvePathOptions & { configFile: string }) => {
      const configFile = args.configFile;
      const options: ResolvePathOptions = {
        workspaceFolder: args.workspaceFolder,
        remoteName: args.remoteName,
        homeDir: args.homeDir,
        extensionPath: args.extensionPath
      };

      return {
        loadPath: resolveConfigPathWithContext(configFile, options),
        configuredPath: resolveConfiguredConfigPathWithContext(configFile, options)
      };
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      'reverseProxy.test.clickSidebarItem',
      async (args: string | { label: string; parentLabel?: string }) => {
        const request = typeof args === 'string' ? { label: args } : args;
        const snapshot = await getSidebarItemsForTest();
        const item = snapshot.children.find((entry) => entry.label === request.label && (!request.parentLabel || entry.parentLabel === request.parentLabel));
        if (!item || !item.command) {
          throw new Error('Sidebar item ' + request.label + ' is not clickable.');
        }
        return vscode.commands.executeCommand(item.command, ...(item.arguments ?? []));
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('reverseProxy.test.syncStateFromSystem', async () => {
      await syncProxyStateFromSystem();
      return {
        state: proxyState,
        externalTunnelPid
      };
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('reverseProxy.test.getWindowsProcessInspectionScript', () => {
      return buildWindowsProcessInspectionScript();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('reverseProxy.test.formatLogLine', (message: string, isoDate: string) => {
      return formatLogLine(message, new Date(isoDate));
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('reverseProxy.test.shouldLogSshStderrSequence', (messages: string[], localHost: string, localPort: number, offsetsMs: number[]) => {
      const stderrLogState: SshStderrLogState = {
        lastLocalTargetConnectFailureLogAt: new Map<string, number>(),
        localTargetConnectFailureContextUntilMs: 0
      };
      return messages.map((message, index) =>
        shouldLogSshStderr(message, { localHost, localPort }, offsetsMs[index] ?? 0, stderrLogState)
      );
    })
  );


  context.subscriptions.push(
    vscode.commands.registerCommand('reverseProxy.test.getStatusBarState', () => {
      return {
        proxyText: statusBarItem.text,
        keyText: keyStatusBarItem.text,
        keyTooltip: typeof keyStatusBarItem.tooltip === 'string' ? keyStatusBarItem.tooltip : keyStatusBarItem.tooltip?.value
      };
    })
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('reverseProxy.test.openSettingsWithDirectory', async (dir: string) => {
      const reverseProxyConfig = vscode.workspace.getConfiguration('reverseProxy');
      const configuredPath = reverseProxyConfig.get<string>('configFile', 'reverse-proxy.config.json');
      const currentPath = resolveConfiguredConfigPath(configuredPath);
      if (fs.existsSync(currentPath)) {
        throw new Error('Config path already exists; this test helper expects missing config path.');
      }

      const finalConfigPath = path.join(dir, 'configs.json');
      if (!fs.existsSync(finalConfigPath)) {
        await vscode.workspace.fs.writeFile(
          vscode.Uri.file(finalConfigPath),
          Buffer.from(getDefaultConfigJsonContent(), 'utf8')
        );
      }
      await reverseProxyConfig.update('configFile', finalConfigPath, vscode.ConfigurationTarget.Global);
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(finalConfigPath));
      await vscode.window.showTextDocument(doc, { preview: false });
      return finalConfigPath;
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('reverseProxy.test.setKeyProjectsWorkspaceOverride', async (workspacePath?: string | null) => {
      keyProjectsWorkspaceOverride = workspacePath ?? null;
      void toolBoxWebviewProvider?.refresh();
    
      return keyProjectsWorkspaceOverride;
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('reverseProxy.test.openKeyProjectSettingsWithDirectory', async (dir: string) => {
      return openKeyProjectsSettings(dir);
    })
  );
}

export function deactivate(): void {
  toolBoxWebviewProvider = null;
  externalTunnelPid = null;
  if (keyStatusBarItem) {
    keyStatusBarItem.dispose();
  }
  if (connectTimer) {
    clearTimeout(connectTimer);
    connectTimer = null;
  }
  if (sshProcess) {
    sshProcess.kill();
    sshProcess = null;
  }
}



