import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ChildProcessWithoutNullStreams, spawn } from 'child_process';

let outputChannel: vscode.OutputChannel;
let statusBarItem: vscode.StatusBarItem;
let keyStatusBarItem: vscode.StatusBarItem;
let extensionContextRef: vscode.ExtensionContext | null = null;
let toolBoxWebviewProvider: ToolBoxWebviewProvider | null = null;
let keyProjectsWorkspaceOverride: string | null = null;
let keyProjectsCache: KeyProjectsCache | null = null;
let keyProjectsRefreshPromise: Promise<void> | null = null;
const remoteTunnelStates = new Map<string, RemoteTunnelRuntimeState>();
const LOCAL_TARGET_CONNECT_FAILURE_LOG_INTERVAL_MS = 30_000;
const LOCAL_TARGET_CONNECT_FAILURE_CONTEXT_MS = 30_000;

type ProxyState = 'stopped' | 'starting' | 'connected' | 'external' | 'failed';

type RemoteProxyConfig = {
  remoteHost: string;
  remotePort: number;
  remoteUser: string;
  remoteBindPort: number;
  identityFile: string;
};

type FileProxyConfig = {
  sshPath: string;
  connectionReadyDelayMs: number;
  localHost: string;
  localPort: number;
  remotes: RemoteProxyConfig[];
};

type RuntimeRemoteProxyConfig = RemoteProxyConfig & {
  key: string;
  hostLabel: string;
  remoteTarget: string;
  reverseSpec: string;
};

type RuntimeProxyConfig = Omit<FileProxyConfig, 'remotes'> & {
  loadedConfigPath: string;
  remotes: RuntimeRemoteProxyConfig[];
};

type RemoteTunnelRuntimeState = {
  state: ProxyState;
  sshProcess: ChildProcessWithoutNullStreams | null;
  externalPid: number | null;
  connectTimer: NodeJS.Timeout | null;
  stopRequested: boolean;
  lastError: string | null;
  stderrLogState: SshStderrLogState;
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
  id: 'logs' | 'proxySettings' | 'keyRefresh' | 'keySettings';
  label: string;
  enabled: boolean;
};

type ReverseTunnelViewRow = {
  key: string;
  hostLabel: string;
  targetLabel: string;
  bindLabel: string;
  stateLabel: string;
  tone: 'connected' | 'external' | 'starting' | 'failed' | 'stopped';
  tooltip: string;
  action: 'start' | 'stop' | 'none';
  actionLabel: string;
  actionEnabled: boolean;
};

type ReverseTunnelViewModel = {
  stateLabel: string;
  detail: string;
  tone: 'connected' | 'external' | 'starting' | 'failed' | 'stopped';
  actions: ToolBoxAction[];
  issue: string | null;
  rows: ReverseTunnelViewRow[];
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
    return 'Started';
  }
  if (state === 'external') {
    return 'Started';
  }
  if (state === 'failed') {
    return 'Failed';
  }
  return 'Stopped';
}

function getReverseTunnelTone(state: ProxyState): ReverseTunnelViewRow['tone'] {
  if (state === 'connected') {
    return 'connected';
  }
  if (state === 'external') {
    return 'external';
  }
  if (state === 'starting') {
    return 'starting';
  }
  if (state === 'failed') {
    return 'failed';
  }
  return 'stopped';
}

function getReverseTunnelActions(): ToolBoxAction[] {
  return [
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

function getRemoteKey(remote: Pick<RemoteProxyConfig, 'remoteUser' | 'remoteHost' | 'remotePort'>): string {
  return `${remote.remoteUser}@${remote.remoteHost}:${remote.remotePort}`;
}

function createSshStderrLogState(): SshStderrLogState {
  return {
    lastLocalTargetConnectFailureLogAt: new Map<string, number>(),
    localTargetConnectFailureContextUntilMs: 0
  };
}

function getOrCreateRemoteTunnelState(remoteKey: string): RemoteTunnelRuntimeState {
  const existing = remoteTunnelStates.get(remoteKey);
  if (existing) {
    return existing;
  }

  const created: RemoteTunnelRuntimeState = {
    state: 'stopped',
    sshProcess: null,
    externalPid: null,
    connectTimer: null,
    stopRequested: false,
    lastError: null,
    stderrLogState: createSshStderrLogState()
  };
  remoteTunnelStates.set(remoteKey, created);
  return created;
}

function getReverseTunnelAggregateState(rows: ReverseTunnelViewRow[]): ProxyState {
  if (rows.some((row) => row.tone === 'failed')) {
    return 'failed';
  }
  if (rows.some((row) => row.tone === 'starting')) {
    return 'starting';
  }
  if (rows.some((row) => row.tone === 'connected')) {
    return 'connected';
  }
  if (rows.some((row) => row.tone === 'external')) {
    return 'external';
  }
  return 'stopped';
}

function formatRemoteTunnelTooltip(remote: RuntimeRemoteProxyConfig, state: RemoteTunnelRuntimeState): string {
  const lines = [
    `target: ${remote.remoteTarget}`,
    `ssh: ${remote.remoteHost}:${remote.remotePort}`,
    `bind: ${remote.remoteBindPort}`,
    `local: ${remote.reverseSpec.split(':').slice(1).join(':')}`,
    `state: ${getStateLabel(state.state)}`
  ];

  if (state.externalPid) {
    lines.push(`Started externally, pid=${state.externalPid}`);
  } else if (state.sshProcess?.pid) {
    lines.push(`pid: ${state.sshProcess.pid}`);
  }
  if (state.lastError) {
    lines.push(`error: ${state.lastError}`);
  }

  return lines.join('\n');
}

async function getReverseTunnelViewModel(): Promise<ReverseTunnelViewModel> {
  let config: RuntimeProxyConfig;
  try {
    config = getConfig();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      stateLabel: 'Config Error',
      detail: message,
      tone: 'failed',
      actions: getReverseTunnelActions(),
      issue: message,
      rows: []
    };
  }

  const rows: ReverseTunnelViewRow[] = config.remotes.map((remote) => {
    const state = getOrCreateRemoteTunnelState(remote.key);
    const isManagedStarted = state.state === 'connected' || state.state === 'starting';
    const action: ReverseTunnelViewRow['action'] = state.state === 'stopped' || state.state === 'failed' ? 'start' : isManagedStarted ? 'stop' : 'none';
    const actionLabel = action === 'start' ? 'Start' : action === 'stop' ? 'Stop' : '-';
    return {
      key: remote.key,
      hostLabel: remote.hostLabel,
      targetLabel: remote.remoteTarget,
      bindLabel: String(remote.remoteBindPort),
      stateLabel: getStateLabel(state.state),
      tone: getReverseTunnelTone(state.state),
      tooltip: formatRemoteTunnelTooltip(remote, state),
      action,
      actionLabel,
      actionEnabled: action !== 'none' && state.state !== 'starting'
    };
  });

  const aggregateState = getReverseTunnelAggregateState(rows);
  const startedCount = rows.filter((row) => row.tone === 'connected' || row.tone === 'external').length;
  return {
    stateLabel: `${startedCount}/${rows.length} Started`,
    detail: `${rows.length} reverse tunnel remote${rows.length === 1 ? '' : 's'} configured.`,
    tone: getReverseTunnelTone(aggregateState),
    actions: getReverseTunnelActions(),
    issue: null,
    rows
  };
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
    reverseTunnel: await getReverseTunnelViewModel(),
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

function escapeHtmlAttribute(value: string): string {
  return escapeHtml(value).replace(/\r?\n/g, '&#10;');
}

function createNonce(): string {
  return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
}

function getReverseTunnelActionIconSvg(actionId: string): string {
  if (actionId === 'logs') {
    return '<svg viewBox="0 0 16 16" fill="currentColor" focusable="false" aria-hidden="true"><path d="M5 10.5a.5.5 0 0 1 .5-.5h2a.5.5 0 0 1 0 1h-2a.5.5 0 0 1-.5-.5m0-2a.5.5 0 0 1 .5-.5h5a.5.5 0 0 1 0 1h-5a.5.5 0 0 1-.5-.5m0-2a.5.5 0 0 1 .5-.5h5a.5.5 0 0 1 0 1h-5a.5.5 0 0 1-.5-.5m0-2a.5.5 0 0 1 .5-.5h5a.5.5 0 0 1 0 1h-5a.5.5 0 0 1-.5-.5"/><path d="M3 0h10a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2v-1h1v1a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V2a1 1 0 0 0-1-1H3a1 1 0 0 0-1 1v1H1V2a2 2 0 0 1 2-2"/><path d="M1 5v-.5a.5.5 0 0 1 1 0V5h.5a.5.5 0 0 1 0 1h-2a.5.5 0 0 1 0-1zm0 3v-.5a.5.5 0 0 1 1 0V8h.5a.5.5 0 0 1 0 1h-2a.5.5 0 0 1 0-1zm0 3v-.5a.5.5 0 0 1 1 0v.5h.5a.5.5 0 0 1 0 1h-2a.5.5 0 0 1 0-1z"/></svg>';
  }
  return '<svg viewBox="0 0 16 16" fill="currentColor" focusable="false" aria-hidden="true"><path d="M7.068.727c.243-.97 1.62-.97 1.864 0l.071.286a.96.96 0 0 0 1.622.434l.205-.211c.695-.719 1.888-.03 1.613.931l-.08.284a.96.96 0 0 0 1.187 1.187l.283-.081c.96-.275 1.65.918.931 1.613l-.211.205a.96.96 0 0 0 .434 1.622l.286.071c.97.243.97 1.62 0 1.864l-.286.071a.96.96 0 0 0-.434 1.622l.211.205c.719.695.03 1.888-.931 1.613l-.284-.08a.96.96 0 0 0-1.187 1.187l.081.283c.275.96-.918 1.65-1.613.931l-.205-.211a.96.96 0 0 0-1.622.434l-.071.286c-.243.97-1.62.97-1.864 0l-.071-.286a.96.96 0 0 0-1.622-.434l-.205.211c-.695.719-1.888.03-1.613-.931l.08-.284a.96.96 0 0 0-1.186-1.187l-.284.081c-.96.275-1.65-.918-.931-1.613l.211-.205a.96.96 0 0 0-.434-1.622l-.286-.071c-.97-.243-.97-1.62 0-1.864l.286-.071a.96.96 0 0 0 .434-1.622l-.211-.205c-.719-.695-.03-1.888.931-1.613l.284.08a.96.96 0 0 0 1.187-1.186l-.081-.284c-.275-.96.918-1.65 1.613-.931l.205.211a.96.96 0 0 0 1.622-.434zM12.973 8.5H8.25l-2.834 3.779A4.998 4.998 0 0 0 12.973 8.5m0-1a4.998 4.998 0 0 0-7.557-3.779l2.834 3.78zM5.048 3.967l-.087.065zm-.431.355A4.98 4.98 0 0 0 3.002 8c0 1.455.622 2.765 1.615 3.678L7.375 8zm.344 7.646.087.065z"/></svg>';
}

function getReverseTunnelStateIconSvg(tone: ReverseTunnelViewRow['tone']): string {
  if (tone === 'connected') {
    return '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" focusable="false" aria-hidden="true"><path d="M8 1.75v6"/><path d="M4.7 4.55a5 5 0 1 0 6.6 0"/></svg>';
  }
  if (tone === 'external') {
    return '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round" focusable="false" aria-hidden="true"><path d="M8 1.8v5.2"/><path d="M4.7 4.9a4.8 4.8 0 1 0 6.6 0"/><path d="M2.6 8.8 1.4 10a2 2 0 0 0 2.8 2.8l1.1-1.1"/><path d="M10.7 4.3 11.8 3.2A2 2 0 0 1 14.6 6l-1.2 1.2"/></svg>';
  }
  if (tone === 'starting') {
    return '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" focusable="false" aria-hidden="true"><path d="M13.2 8a5.2 5.2 0 0 1-8.9 3.7"/><path d="M2.8 8a5.2 5.2 0 0 1 8.9-3.7"/><path d="M11.7 1.9v2.4H9.3"/><path d="M4.3 14.1v-2.4h2.4"/></svg>';
  }
  if (tone === 'failed') {
    return '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.55" stroke-linecap="round" stroke-linejoin="round" focusable="false" aria-hidden="true"><path d="M8 1.9 14.4 13a1 1 0 0 1-.9 1.5h-11a1 1 0 0 1-.9-1.5z"/><path d="M8 5.8v3.2"/><path d="M8 12h.01"/></svg>';
  }
  return '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" focusable="false" aria-hidden="true"><path d="M8 1.75v6"/><path d="M4.7 4.55a5 5 0 1 0 6.6 0"/><path d="M3 13 13 3"/></svg>';
}

function getInfoIconSvg(): string {
  return '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round" focusable="false" aria-hidden="true"><circle cx="8" cy="8" r="6"/><path d="M8 7.4v3.6"/><path d="M8 5h.01"/></svg>';
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
      const icon = getReverseTunnelActionIconSvg(action.id);
      return '<button class="' + classes.join(' ') + '" data-action="' + escapeHtml(action.id) + '" title="' + escapeHtml(action.label) + '" aria-label="' + escapeHtml(action.label) + '" ' + (action.enabled ? '' : 'disabled') + '><span class="action-icon" aria-hidden="true">' + icon + '</span></button>';
    })
    .join('');

  const reverseRows = model.reverseTunnel.rows
    .map((row) => {
      const stateIcon = getReverseTunnelStateIconSvg(row.tone);
      const infoIcon = getInfoIconSvg();
      const tooltip = escapeHtmlAttribute(row.tooltip);
      const actionButton =
        row.action === 'none'
          ? '<span class="rt-action-empty">-</span>'
          : '<button class="rt-action-button ' + escapeHtml(row.action) + '" data-remote-action="' + escapeHtml(row.action) + '" data-remote-key="' + escapeHtml(row.key) + '" title="' + escapeHtml(row.actionLabel + ' ' + row.targetLabel) + '" ' + (row.actionEnabled ? '' : 'disabled') + '>' + escapeHtml(row.actionLabel) + '</button>';
      return [
        '<div class="rt-row">',
        '  <span class="rt-cell rt-host"><code class="rt-host-code">' + escapeHtml(row.hostLabel) + '</code></span>',
        '  <span class="rt-cell rt-state" title="' + escapeHtml(row.stateLabel) + '" aria-label="' + escapeHtml(row.stateLabel) + '"><span class="rt-state-icon ' + escapeHtml(row.tone) + '">' + stateIcon + '</span><span class="rt-info-icon" data-tooltip="' + tooltip + '" aria-label="Tunnel details">' + infoIcon + '</span></span>',
        '  <span class="rt-cell rt-action">' + actionButton + '</span>',
        '</div>'
      ].join('');
    })
    .join('');

  const reverseBody = model.reverseTunnel.issue
    ? '<div class="empty">' + escapeHtml(model.reverseTunnel.issue) + '</div>'
    : [
        '<div class="rt-table">',
        '  <div class="rt-rows">' + reverseRows + '</div>',
        '</div>'
      ].join('');

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
      width: 100%;
      justify-self: start;
      margin-left: 0;
      overflow: visible;
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
    .tone.external { background: color-mix(in srgb, var(--vscode-testing-iconPassed) 62%, var(--vscode-descriptionForeground)); }
    .tone.starting { background: var(--vscode-testing-iconQueued); }
    .tone.failed, .dot.dirty { background: var(--vscode-testing-iconFailed); }
    .tone.stopped, .dot.unavailable { background: var(--vscode-disabledForeground); }
    .reverse-toolbar {
      display: flex;
      gap: 8px;
      padding: 12px 12px 10px;
    }
    .rt-table {
      padding: 0 12px 12px;
    }
    .rt-row {
      display: grid;
      grid-template-columns: minmax(92px, 1fr) 48px 54px;
      gap: 8px;
      align-items: center;
      box-sizing: border-box;
      width: 100%;
      min-height: 30px;
      padding: 7px 4px;
    }
    .rt-row {
      border-bottom: 1px solid color-mix(in srgb, var(--vscode-panel-border) 65%, transparent);
    }
    .rt-row:last-child {
      border-bottom: 0;
    }
    .rt-cell {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .rt-host {
      display: inline-flex;
      align-items: center;
    }
    .rt-host-code {
      min-width: 0;
      max-width: 100%;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      box-sizing: border-box;
      padding: 2px 5px;
      border: 1px solid color-mix(in srgb, var(--vscode-panel-border) 82%, transparent);
      border-radius: 4px;
      background: var(--vscode-textCodeBlock-background, color-mix(in srgb, var(--vscode-editor-background) 76%, var(--vscode-foreground) 6%));
      color: var(--vscode-textPreformat-foreground, var(--vscode-foreground));
      font-family: var(--vscode-editor-font-family, var(--vscode-font-family));
      font-size: 11px;
      line-height: 1.45;
    }
    .rt-state {
      display: inline-flex;
      gap: 6px;
      align-items: center;
      justify-content: flex-start;
    }
    .rt-state-icon,
    .rt-info-icon {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 16px;
      height: 16px;
      flex: 0 0 auto;
    }
    .rt-state-icon svg,
    .rt-info-icon svg {
      width: 15px;
      height: 15px;
      display: block;
    }
    .rt-state-icon.connected { color: var(--vscode-testing-iconPassed); }
    .rt-state-icon.external { color: color-mix(in srgb, var(--vscode-testing-iconPassed) 62%, var(--vscode-descriptionForeground)); }
    .rt-state-icon.starting { color: var(--vscode-testing-iconQueued); }
    .rt-state-icon.failed { color: var(--vscode-testing-iconFailed); }
    .rt-state-icon.stopped { color: var(--vscode-disabledForeground); }
    .rt-info-icon {
      color: var(--vscode-descriptionForeground);
      opacity: 0.86;
      position: relative;
      cursor: help;
    }
    .rt-info-icon:hover,
    .rt-info-icon:focus {
      opacity: 1;
      color: var(--vscode-foreground);
    }
    .rt-info-icon:hover::after,
    .rt-info-icon:focus::after {
      content: attr(data-tooltip);
      position: absolute;
      z-index: 50;
      top: calc(100% + 7px);
      right: -8px;
      width: min(280px, calc(100vw - 32px));
      box-sizing: border-box;
      padding: 9px 10px;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 6px;
      background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
      color: var(--vscode-editorWidget-foreground, var(--vscode-foreground));
      box-shadow: 0 8px 18px rgba(0, 0, 0, 0.22);
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      font-family: var(--vscode-editor-font-family, var(--vscode-font-family));
      font-size: 11px;
      line-height: 1.45;
      text-align: left;
      pointer-events: none;
    }
    .rt-info-icon:hover::before,
    .rt-info-icon:focus::before {
      content: '';
      position: absolute;
      z-index: 51;
      top: calc(100% + 2px);
      right: 4px;
      border: 5px solid transparent;
      border-bottom-color: var(--vscode-panel-border);
      pointer-events: none;
    }
    .rt-action {
      display: inline-flex;
      justify-content: flex-start;
    }
    .rt-action-button {
      border: 1px solid var(--vscode-button-border, transparent);
      border-radius: 6px;
      height: 24px;
      min-width: 48px;
      padding: 0 8px;
      background: var(--vscode-button-secondaryBackground, var(--vscode-button-background));
      color: var(--vscode-button-secondaryForeground, var(--vscode-button-foreground));
      cursor: pointer;
      font: inherit;
    }
    .rt-action-button.start {
      color: var(--vscode-testing-iconPassed);
    }
    .rt-action-button.stop {
      color: var(--vscode-testing-iconFailed);
    }
    .rt-action-button:disabled {
      cursor: default;
      opacity: 0.6;
    }
    .rt-action-empty {
      color: var(--vscode-descriptionForeground);
      display: inline-flex;
      width: 48px;
      justify-content: center;
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
        <div class="reverse-toolbar">${reverseActions}</div>
        ${reverseBody}
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
    document.querySelectorAll('button[data-remote-action][data-remote-key]').forEach((button) => {
      button.addEventListener('click', () => {
        const action = button.getAttribute('data-remote-action');
        const remoteKey = button.getAttribute('data-remote-key');
        if (action && remoteKey) {
          vscode.postMessage({ type: 'reverseTunnel', action, remoteKey });
        }
      });
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
    webviewView.webview.onDidReceiveMessage(async (message: { type?: string; repoName?: string; action?: string; remoteKey?: string; left?: number; top?: number }) => {
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
        if (message.type === 'reverseTunnel' && message.action && message.remoteKey) {
          if (message.action === 'start') {
            await startRemoteTunnel(message.remoteKey);
          } else if (message.action === 'stop') {
            stopRemoteTunnel(message.remoteKey);
          }
        }
        return;
      }
      switch (message.action) {
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


function setRemoteTunnelState(remoteKey: string, state: ProxyState): void {
  const remoteState = getOrCreateRemoteTunnelState(remoteKey);
  remoteState.state = state;
  updateReverseTunnelStatusBar();
  void toolBoxWebviewProvider?.refresh();
}

function updateReverseTunnelStatusBar(): void {
  if (!statusBarItem) {
    return;
  }

  let config: RuntimeProxyConfig | null = null;
  try {
    config = getConfig();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    statusBarItem.text = '$(error) ReverseTun setup';
    statusBarItem.tooltip = message;
    statusBarItem.show();
    return;
  }

  const states = config.remotes.map((remote) => getOrCreateRemoteTunnelState(remote.key));
  const startedCount = states.filter((state) => state.state === 'connected' || state.state === 'external').length;
  const hasFailed = states.some((state) => state.state === 'failed');
  const hasStarting = states.some((state) => state.state === 'starting');
  const icon = hasFailed ? '$(error)' : hasStarting ? '$(sync~spin)' : startedCount > 0 ? '$(check)' : '$(circle-slash)';
  statusBarItem.text = `${icon} ReverseTun ${startedCount}/${config.remotes.length}`;
  statusBarItem.tooltip = config.remotes
    .map((remote) => {
      const state = getOrCreateRemoteTunnelState(remote.key);
      return `${remote.hostLabel}: ${getStateLabel(state.state)}`;
    })
    .join('\n');
  statusBarItem.show();
}

function getReverseTunnelSidebarItemsForTest(): SidebarTestItem[] {
  let config: RuntimeProxyConfig;
  try {
    config = getConfig();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return [
      {
        kind: 'info',
        label: message,
        tooltip: message,
        enabled: false,
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

  const remoteItems = config.remotes.map((remote) => {
    const state = getOrCreateRemoteTunnelState(remote.key);
    const isManagedStarted = state.state === 'connected' || state.state === 'starting';
    const command = state.state === 'stopped' || state.state === 'failed'
      ? 'reverseProxy.test.startRemoteTunnel'
      : isManagedStarted
        ? 'reverseProxy.test.stopRemoteTunnel'
        : undefined;
    return {
      kind: 'remote',
      label: `${remote.hostLabel}: ${getStateLabel(state.state)}`,
      description: state.state === 'external' ? 'external' : undefined,
      tooltip: formatRemoteTunnelTooltip(remote, state),
      command,
      arguments: command ? [remote.key] : undefined,
      enabled: Boolean(command) && state.state !== 'starting',
      parentLabel: 'ReverseTunnel'
    };
  });

  return [
    ...remoteItems,
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

function assertObject(value: unknown, key: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid config field '${key}': expected object.`);
  }
  return value as Record<string, unknown>;
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
  const connectionReadyDelayMs = assertNumber(data.connectionReadyDelayMs, 'ReverseTunnel.connectionReadyDelayMs');
  if (connectionReadyDelayMs <= 0) {
    throw new Error(`Invalid config field 'ReverseTunnel.connectionReadyDelayMs': expected > 0.`);
  }

  if (!Array.isArray(data.remotes)) {
    throw new Error(`Invalid config field 'ReverseTunnel.remotes': expected remote config array.`);
  }

  const seenRemoteKeys = new Set<string>();
  const remotes = data.remotes.map((entry, index) => {
    const remoteData = assertObject(entry, `ReverseTunnel.remotes[${index}]`);
    const remote: RemoteProxyConfig = {
      remoteHost: assertString(remoteData.remoteHost, `ReverseTunnel.remotes[${index}].remoteHost`),
      remotePort: assertNumber(remoteData.remotePort, `ReverseTunnel.remotes[${index}].remotePort`),
      remoteUser: assertString(remoteData.remoteUser, `ReverseTunnel.remotes[${index}].remoteUser`),
      remoteBindPort: assertNumber(remoteData.remoteBindPort, `ReverseTunnel.remotes[${index}].remoteBindPort`),
      identityFile: typeof remoteData.identityFile === 'string' ? remoteData.identityFile.trim() : ''
    };
    const key = getRemoteKey(remote);
    if (seenRemoteKeys.has(key)) {
      throw new Error(`Invalid config field 'ReverseTunnel.remotes[${index}]': duplicate remote '${key}'.`);
    }
    seenRemoteKeys.add(key);
    return remote;
  });

  if (remotes.length === 0) {
    throw new Error(`Invalid config field 'ReverseTunnel.remotes': expected at least one remote.`);
  }

  return {
    sshPath: assertString(data.sshPath, 'ReverseTunnel.sshPath'),
    connectionReadyDelayMs,
    localHost: assertString(data.localHost, 'ReverseTunnel.localHost'),
    localPort: assertNumber(data.localPort, 'ReverseTunnel.localPort'),
    remotes
  };
}

function getConfig(): RuntimeProxyConfig {
  const config = vscode.workspace.getConfiguration('reverseProxy');
  const configFile = config.get<string>('configFile', 'reverse-proxy.config.json');
  const configPath = resolveConfigPath(configFile);
  const fileConfig = loadFileProxyConfig(configPath);

  return {
    sshPath: fileConfig.sshPath,
    connectionReadyDelayMs: fileConfig.connectionReadyDelayMs,
    localHost: fileConfig.localHost,
    localPort: fileConfig.localPort,
    loadedConfigPath: configPath,
    remotes: fileConfig.remotes.map((remote) => ({
      ...remote,
      key: getRemoteKey(remote),
      hostLabel: `${remote.remoteHost}:${remote.remotePort}`,
      remoteTarget: `${remote.remoteUser}@${remote.remoteHost}`,
      reverseSpec: `${remote.remoteBindPort}:${fileConfig.localHost}:${fileConfig.localPort}`
    }))
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

function isMatchingTunnelCommand(commandLine: string, remote: RuntimeRemoteProxyConfig): boolean {
  const normalized = normalizeCommandLine(commandLine);
  if (!normalized) {
    return false;
  }

  const reverseSpecLower = remote.reverseSpec.toLowerCase();
  const normalizedLower = normalized.toLowerCase();

  const hasReverseFlag = /(^|\s)-R(?=\s|$)/i.test(normalized);
  const hasReverseSpec = normalizedLower.includes(reverseSpecLower);
  if (!hasReverseFlag || !hasReverseSpec) {
    return false;
  }

  const hasRemoteTarget =
    commandLineHasArg(normalized, remote.remoteTarget) ||
    (commandLineHasArg(normalized, remote.remoteHost) && commandLineHasArg(normalized, remote.remoteUser));

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

async function findExistingTunnelProcess(remote: RuntimeRemoteProxyConfig, processes?: ExistingTunnelMatch[]): Promise<ExistingTunnelMatch | null> {
  const candidates = processes ?? (await listCandidateProcesses());
  const currentPid = process.pid;
  const state = getOrCreateRemoteTunnelState(remote.key);

  for (const candidate of candidates) {
    if (candidate.pid === currentPid) {
      continue;
    }
    if (state.sshProcess?.pid && candidate.pid === state.sshProcess.pid) {
      return candidate;
    }
    if (isMatchingTunnelCommand(candidate.commandLine, remote)) {
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
    const processes = await listCandidateProcesses();
    let foundAny = false;
    for (const remote of runtimeConfig.remotes) {
      const state = getOrCreateRemoteTunnelState(remote.key);
      const existing = await findExistingTunnelProcess(remote, processes);
      if (!existing) {
        state.externalPid = null;
        if (!state.sshProcess && (state.state === 'connected' || state.state === 'external')) {
          setRemoteTunnelState(remote.key, 'stopped');
        }
        continue;
      }

      foundAny = true;
      if (state.sshProcess?.pid === existing.pid) {
        state.externalPid = null;
      } else {
        state.externalPid = existing.pid;
        if (state.state !== 'external') {
          outputChannel.appendLine(`[sync] detected external reverse tunnel remote=${remote.key} pid=${existing.pid}`);
          setRemoteTunnelState(remote.key, 'external');
        }
      }
    }
    return foundAny;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    outputChannel.appendLine(`[warn] unable to inspect existing tunnel processes: ${message}`);
    return false;
  }
}

function getRuntimeRemote(config: RuntimeProxyConfig, remoteKey: string): RuntimeRemoteProxyConfig | null {
  return config.remotes.find((remote) => remote.key === remoteKey) ?? null;
}

async function startRemoteTunnel(remoteKey: string): Promise<void> {
  let config: RuntimeProxyConfig;
  try {
    config = getConfig();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    outputChannel.appendLine(`[error] ${message}`);
    vscode.window.showErrorMessage(`Failed to load reverse proxy config: ${message}`);
    return;
  }

  const remote = getRuntimeRemote(config, remoteKey);
  if (!remote) {
    vscode.window.showErrorMessage(`Reverse tunnel remote not found: ${remoteKey}`);
    return;
  }

  const state = getOrCreateRemoteTunnelState(remote.key);
  if (state.sshProcess || state.state === 'starting' || state.state === 'connected') {
    vscode.window.showInformationMessage(`Reverse tunnel is already started: ${remote.hostLabel}`);
    return;
  }
  if (state.state === 'external') {
    vscode.window.showInformationMessage(`Reverse tunnel is already started externally: ${remote.hostLabel}`);
    return;
  }

  outputChannel.appendLine(`[config] using file: ${config.loadedConfigPath}`);
  if (vscode.env.remoteName) {
    outputChannel.appendLine(`[mode] workspace is remote (${vscode.env.remoteName}), tunnel runs on local UI host.`);
  }

  await syncProxyStateFromSystem(config);
  const syncedState = getOrCreateRemoteTunnelState(remote.key);
  if (syncedState.state === 'external') {
    vscode.window.showInformationMessage(`Reverse tunnel is already started externally: ${remote.hostLabel}`);
    return;
  }

  setRemoteTunnelState(remote.key, 'starting');
  state.lastError = null;
  state.stopRequested = false;
  state.externalPid = null;
  state.stderrLogState = createSshStderrLogState();

  try {
    await verifySshExists(config.sshPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    outputChannel.appendLine(`[error] ${message}`);
    state.lastError = message;
    setRemoteTunnelState(remote.key, 'failed');
    vscode.window.showErrorMessage(
      `SSH command is unavailable. Install OpenSSH or update 'sshPath' in reverse-proxy.config.json. Details: ${message}`
    );
    return;
  }

  const args = [
    '-N',
    '-p',
    String(remote.remotePort),
    '-o',
    'ExitOnForwardFailure=yes',
    '-o',
    'ServerAliveInterval=30',
    '-o',
    'ServerAliveCountMax=3',
    '-R',
    remote.reverseSpec
  ];

  if (remote.identityFile.length > 0) {
    args.push('-i', remote.identityFile);
  }

  args.push(remote.remoteTarget);

  outputChannel.appendLine(`[start] ${config.sshPath} ${args.join(' ')}`);

  try {
    state.sshProcess = spawn(config.sshPath, args);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    state.lastError = message;
    outputChannel.appendLine(`[error] failed to spawn ssh remote=${remote.key}: ${message}`);
    vscode.window.showErrorMessage(`Failed to start reverse tunnel ${remote.hostLabel}: ${message}`);
    state.sshProcess = null;
    setRemoteTunnelState(remote.key, 'failed');
    return;
  }

  let hasFailed = false;
  const markFailed = (message: string): void => {
    if (hasFailed) {
      return;
    }
    hasFailed = true;
    state.lastError = message;
    outputChannel.appendLine(`[error] ${message}`);
    setRemoteTunnelState(remote.key, 'failed');
    vscode.window.showErrorMessage(message);
  };

  if (state.connectTimer) {
    clearTimeout(state.connectTimer);
  }
  state.connectTimer = setTimeout(() => {
    if (state.sshProcess && !hasFailed && !state.stopRequested) {
      setRemoteTunnelState(remote.key, 'connected');
      vscode.window.showInformationMessage(`Reverse tunnel started: ${remote.hostLabel}`);
    }
  }, config.connectionReadyDelayMs);

  state.sshProcess.stdout.on('data', (data: Buffer) => {
    outputChannel.appendLine(`[stdout] [${remote.key}] ${data.toString().trim()}`);
  });

  state.sshProcess.stderr.on('data', (data: Buffer) => {
    const lines = data
      .toString()
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    for (const text of lines) {
      if (shouldLogSshStderr(text, config, Date.now(), state.stderrLogState)) {
        outputChannel.appendLine(`[stderr] [${remote.key}] ${text}`);
      }
    }

    const text = lines.join('\n');
    if (/remote port forwarding failed/i.test(text) || /address already in use/i.test(text)) {
      markFailed(`Reverse tunnel failed: remote port ${remote.remoteBindPort} is already in use on ${remote.hostLabel}.`);
      if (state.sshProcess) {
        state.sshProcess.kill();
      }
    }
  });

  state.sshProcess.on('error', (err: Error) => {
    markFailed(`Reverse tunnel failed for ${remote.hostLabel}: ${err.message}`);
  });

  state.sshProcess.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
    outputChannel.appendLine(`[stop] [${remote.key}] ssh exited with code=${code} signal=${signal}`);
    if (state.connectTimer) {
      clearTimeout(state.connectTimer);
      state.connectTimer = null;
    }

    state.sshProcess = null;
    state.externalPid = null;
    if (state.stopRequested) {
      setRemoteTunnelState(remote.key, 'stopped');
    } else if (hasFailed) {
      // Keep failed state.
    } else if (state.state === 'starting') {
      markFailed(`Reverse tunnel failed before connection established for ${remote.hostLabel} (code=${code}, signal=${signal}).`);
    } else if (state.state === 'connected') {
      markFailed(`Reverse tunnel disconnected unexpectedly for ${remote.hostLabel} (code=${code}, signal=${signal}).`);
    } else {
      setRemoteTunnelState(remote.key, 'stopped');
    }

    state.stopRequested = false;
  });

  outputChannel.show(true);
}

function stopRemoteTunnel(remoteKey: string): void {
  const state = remoteTunnelStates.get(remoteKey);
  if (!state || !state.sshProcess) {
    vscode.window.showInformationMessage(`Reverse tunnel is not managed by this window: ${remoteKey}`);
    return;
  }

  outputChannel.appendLine(`[stop] stopping ssh reverse tunnel remote=${remoteKey}`);
  state.stopRequested = true;
  if (state.connectTimer) {
    clearTimeout(state.connectTimer);
    state.connectTimer = null;
  }
  state.sshProcess.kill();
  state.sshProcess = null;
  state.externalPid = null;
  setRemoteTunnelState(remoteKey, 'stopped');
  vscode.window.showInformationMessage(`Reverse tunnel stopping: ${remoteKey}`);
}

function showStatus(): void {
  const started = Array.from(remoteTunnelStates.values()).filter((state) => state.state === 'connected' || state.state === 'external').length;
  vscode.window.showInformationMessage(`Reverse tunnel status: ${started} started remote(s).`);
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
        localHost: '127.0.0.1',
        localPort: 7897,
        remotes: [
          {
            remoteHost: 'FOO_ADDRESS',
            remotePort: 4001,
            remoteUser: 'FOO_USER',
            remoteBindPort: 17897,
            identityFile: ''
          }
        ]
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
  updateReverseTunnelStatusBar();
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
        updateReverseTunnelStatusBar();
      }
      if (event.affectsConfiguration('reverseProxy')) {
        void toolBoxWebviewProvider?.refresh();
        updateReverseTunnelStatusBar();
      }
      void updateKeyStatusBar();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('reverseProxy.showStatus', () => {
      showStatus();
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
    vscode.commands.registerCommand('reverseProxy.test.renderToolBoxHtml', async () => {
      return renderToolBoxWebview({ cspSource: 'vscode-test-resource' } as vscode.Webview, await getToolBoxViewModel());
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
      return Array.from(remoteTunnelStates.entries()).map(([remoteKey, state]) => ({
        remoteKey,
        state: state.state,
        externalPid: state.externalPid
      }));
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('reverseProxy.test.startRemoteTunnel', async (remoteKey: string) => {
      await startRemoteTunnel(remoteKey);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('reverseProxy.test.stopRemoteTunnel', (remoteKey: string) => {
      stopRemoteTunnel(remoteKey);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('reverseProxy.test.resetRemoteTunnelStates', () => {
      for (const state of remoteTunnelStates.values()) {
        if (state.connectTimer) {
          clearTimeout(state.connectTimer);
        }
        if (state.sshProcess) {
          state.stopRequested = true;
          state.sshProcess.kill();
        }
      }
      remoteTunnelStates.clear();
      updateReverseTunnelStatusBar();
      void toolBoxWebviewProvider?.refresh();
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
  if (keyStatusBarItem) {
    keyStatusBarItem.dispose();
  }

  for (const state of remoteTunnelStates.values()) {
    if (state.connectTimer) {
      clearTimeout(state.connectTimer);
      state.connectTimer = null;
    }
    if (state.sshProcess) {
      state.stopRequested = true;
      state.sshProcess.kill();
      state.sshProcess = null;
    }
  }
  remoteTunnelStates.clear();
}



