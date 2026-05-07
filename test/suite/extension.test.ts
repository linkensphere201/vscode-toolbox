import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { ChildProcessWithoutNullStreams, spawn } from 'child_process';

type SidebarSnapshot = {
  root: Array<{ label: string; command?: string; enabled: boolean; parentLabel?: string; tooltip?: string }>;
  children: Array<{
    label: string;
    command?: string;
    enabled: boolean;
    parentLabel?: string;
    tooltip?: string;
    description?: string;
    kind: string;
  }>;
};

suite('Reverse Proxy Extension Integration Tests', () => {
  const config = vscode.workspace.getConfiguration('reverseProxy');
  const win = vscode.window as unknown as {
    showErrorMessage: typeof vscode.window.showErrorMessage;
    showInformationMessage: typeof vscode.window.showInformationMessage;
  };

  let fakeSshPath = '';
  let fakeGitPath = '';
  let testDir = '';
  let testConfigFilePath = '';
  let originalConfigFile = 'reverse-proxy.config.json';

  const writeProxyConfig = (
    remoteBindPort: number,
    options?: { sshPath?: string; connectionReadyDelayMs?: number; remoteHost?: string; remotePort?: number; remoteUser?: string }
  ): void => {
    fs.writeFileSync(
      testConfigFilePath,
      JSON.stringify(
        {
          ReverseTunnel: {
            sshPath: options?.sshPath ?? 'ssh',
            connectionReadyDelayMs: options?.connectionReadyDelayMs ?? 1200,
            localHost: '127.0.0.1',
            localPort: 7897,
            remotes: [
              {
                remoteHost: options?.remoteHost ?? '10.99.0.1',
                remotePort: options?.remotePort ?? 4001,
                remoteUser: options?.remoteUser ?? 'yangweijian',
                remoteBindPort,
                identityFile: ''
              }
            ]
          }
        },
        null,
        2
      ),
      'utf8'
    );
  };

  const writeProxyConfigWithRemotes = (
    remotes: Array<{ remoteHost: string; remotePort: number; remoteUser: string; remoteBindPort: number; identityFile?: string }>,
    options?: { sshPath?: string; connectionReadyDelayMs?: number }
  ): void => {
    fs.writeFileSync(
      testConfigFilePath,
      JSON.stringify(
        {
          ReverseTunnel: {
            sshPath: options?.sshPath ?? 'ssh',
            connectionReadyDelayMs: options?.connectionReadyDelayMs ?? 1200,
            localHost: '127.0.0.1',
            localPort: 7897,
            remotes
          }
        },
        null,
        2
      ),
      'utf8'
    );
  };

  const writeKeyProjectsConfig = (
    workspaceDir: string,
    data: {
      keyProjects: {
        mode: 'local' | 'ssh';
        rootDir: string;
        repoNames: string[];
        sshTarget?: string;
        sshPort?: number;
        gitPath?: string;
        sshPath?: string;
      };
    }
  ): string => {
    const vscodeDir = path.join(workspaceDir, '.vscode');
    fs.mkdirSync(vscodeDir, { recursive: true });
    const configPath = path.join(vscodeDir, 'mytoolbox.json');
    fs.writeFileSync(configPath, JSON.stringify(data, null, 2) + '\n', 'utf8');
    return configPath;
  };

  const setKeyProjectsWorkspaceOverride = async (workspaceDir?: string): Promise<void> => {
    await vscode.commands.executeCommand('reverseProxy.test.setKeyProjectsWorkspaceOverride', workspaceDir ?? null);
  };

  const getSidebarSnapshot = async (): Promise<SidebarSnapshot> => {
    return (await vscode.commands.executeCommand('reverseProxy.test.getSidebarItems')) as SidebarSnapshot;
  };

  const getSidebarChildren = async (parentLabel: string) => {
    const snapshot = await getSidebarSnapshot();
    return snapshot.children.filter((child) => child.parentLabel === parentLabel);
  };

  const getDefaultRemoteKey = () => 'yangweijian@10.99.0.1:4001';

  suiteSetup(async () => {
    const extension = vscode.extensions.getExtension('local.reverse-proxy-extension');
    assert.ok(extension, 'Extension local.reverse-proxy-extension should be installed for tests');
    await extension!.activate();

    originalConfigFile = config.get<string>('configFile', 'reverse-proxy.config.json');

    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reverse-proxy-ext-test-'));
    testConfigFilePath = path.join(testDir, 'reverse-proxy.config.json');
    writeProxyConfig(17897);

    fakeGitPath = path.join(testDir, 'fake-git.cmd');
    fs.writeFileSync(
      fakeGitPath,
      [
        '@echo off',
        'set "REPO=%~nx2"',
        'if /I "%1"=="-C" (',
        '  if not "%RPX_FAKE_KEYPROJECT_DELAY%"=="" ping 127.0.0.1 -n %RPX_FAKE_KEYPROJECT_DELAY% >nul',
        '  echo %* | findstr /I /C:"config --get remote.origin.url" >nul',
        '  if not errorlevel 1 goto emit_remote_url',
        '  echo %* | findstr /I /C:"fetch --prune --quiet" >nul',
        '  if not errorlevel 1 exit /b 0',
        '  echo %* | findstr /I /C:"status --porcelain=v2 --branch" >nul',
        '  if not errorlevel 1 goto emit_porcelain',
        '  echo %* | findstr /I /C:"status" >nul',
        '  if not errorlevel 1 goto emit_full_status',
        ')',
        'echo fatal: unknown fake git invocation 1>&2',
        'exit /b 1',
        ':emit_remote_url',
        'if /I "%REPO%"=="clean-repo" echo git@example.com:team/clean-repo.git',
        'if /I "%REPO%"=="root-repo" echo git@example.com:team/root-repo.git',
        'if /I "%REPO%"=="dirty-repo" echo git@example.com:team/dirty-repo.git',
        'exit /b 0',
        ':emit_porcelain',
        'if /I "%REPO%"=="clean-repo" (',
        '  echo # branch.head main',
        '  echo # branch.upstream origin/main',
        '  echo # branch.ab +0 -0',
        '  exit /b 0',
        ')',
        'if /I "%REPO%"=="root-repo" (',
        '  echo # branch.head main',
        '  echo # branch.upstream origin/main',
        '  echo # branch.ab +0 -0',
        '  exit /b 0',
        ')',
        'if /I "%REPO%"=="dirty-repo" (',
        '  echo # branch.head feature-dirty',
        '  echo # branch.upstream origin/feature-dirty',
        '  echo # branch.ab +0 -2',
        '  echo 1 .M N... 100644 100644 100644 123456 123456 src/app.ts',
        '  echo ? notes.txt',
        '  exit /b 0',
        ')',
        'exit /b 1',
        ':emit_full_status',
        'if /I "%REPO%"=="clean-repo" (',
        '  echo On branch main',
        '  echo nothing to commit, working tree clean',
        '  exit /b 0',
        ')',
        'if /I "%REPO%"=="root-repo" (',
        '  echo On branch main',
        '  echo nothing to commit, working tree clean',
        '  exit /b 0',
        ')',
        'if /I "%REPO%"=="dirty-repo" (',
        '  echo On branch feature-dirty',
        '  echo Changes not staged for commit:',
        '  echo   modified:   src/app.ts',
        '  echo.',
        '  echo Untracked files:',
        '  echo   notes.txt',
        '  exit /b 0',
        ')',
        'exit /b 1'
      ].join('\r\n'),
      'utf8'
    );

    fakeSshPath = path.join(testDir, 'fake-ssh.cmd');
    fs.writeFileSync(
      fakeSshPath,
      [
        '@echo off',
        'setlocal EnableDelayedExpansion',
        'if "%1"=="-V" (',
        '  echo OpenSSH_for_Test 1>&2',
        '  exit /b 0',
        ')',
        'set "TARGET=%1"',
        'set "REMOTE_CMD=%2"',
        'if /I "%1"=="-p" (',
        '  set "TARGET=%3"',
        '  set "REMOTE_CMD=%4"',
        ')',
        'if /I "!TARGET!"=="test@example" (',
        '  echo !REMOTE_CMD! | findstr /I /C:"/tmp/mytoolbox-key-projects-script-" >nul',
        '  if not errorlevel 1 goto remote_batch',
        '  echo !REMOTE_CMD! | findstr /I /C:"/remote/dirty-repo" >nul',
        '  if not errorlevel 1 goto remote_dirty',
        '  echo !REMOTE_CMD! | findstr /I /C:"/remote/clean-repo" >nul',
        '  if not errorlevel 1 goto remote_clean',
        '  echo fatal: unknown remote repo 1>&2',
        '  exit /b 1',
        ')',
        'goto after_remote_batch',
        ':remote_batch',
        'if not "%RPX_FAKE_KEYPROJECT_DELAY%"=="" ping 127.0.0.1 -n %RPX_FAKE_KEYPROJECT_DELAY% >nul',
        'echo __MYTB_BEGIN__ 0 dirty-repo',
        'echo __MYTB_FIELD__ repoPath',
        'echo /remote/dirty-repo',
        'echo __MYTB_END_FIELD__ repoPath',
        'echo __MYTB_FIELD__ remoteUrl',
        'echo ssh://git@example.com/team/dirty-repo.git',
        'echo __MYTB_END_FIELD__ remoteUrl',
        'echo __MYTB_FIELD__ fetchError',
        'echo __MYTB_END_FIELD__ fetchError',
        'echo __MYTB_FIELD__ error',
        'echo __MYTB_END_FIELD__ error',
        'echo __MYTB_FIELD__ status',
        'echo # branch.head feature-ssh',
        'echo # branch.upstream origin/feature-ssh',
        'echo # branch.ab +1 -1',
        'echo 1 .M N... 100644 100644 100644 123456 123456 remote/file.txt',
        'echo __MYTB_END_FIELD__ status',
        'echo __MYTB_END__ 0 dirty-repo',
        'echo __MYTB_BEGIN__ 1 clean-repo',
        'echo __MYTB_FIELD__ repoPath',
        'echo /remote/clean-repo',
        'echo __MYTB_END_FIELD__ repoPath',
        'echo __MYTB_FIELD__ remoteUrl',
        'echo ssh://git@example.com/team/clean-repo.git',
        'echo __MYTB_END_FIELD__ remoteUrl',
        'echo __MYTB_FIELD__ fetchError',
        'echo __MYTB_END_FIELD__ fetchError',
        'echo __MYTB_FIELD__ error',
        'echo __MYTB_END_FIELD__ error',
        'echo __MYTB_FIELD__ status',
        'echo # branch.head main',
        'echo # branch.upstream origin/main',
        'echo # branch.ab +0 -0',
        'echo __MYTB_END_FIELD__ status',
        'echo __MYTB_END__ 1 clean-repo',
        'exit /b 0',
        ':after_remote_batch',
        'if /I "%RPX_FAKE_MODE%"=="port_busy" (',
        '  echo Warning: remote port forwarding failed for listen port %RPX_FAKE_BIND_PORT% 1>&2',
        '  exit /b 1',
        ')',
        'if /I "%RPX_FAKE_MODE%"=="success" (',
        '  ping 127.0.0.1 -n 30 >nul',
        '  exit /b 0',
        ')',
        'if /I "%RPX_FAKE_MODE%"=="fake_other_existing" (',
        '  ping 127.0.0.1 -n 30 >nul',
        '  exit /b 0',
        ')',
        'echo Unknown fake mode: %RPX_FAKE_MODE% 1>&2',
        'exit /b 1',
        ':remote_clean',
        'if not "%RPX_FAKE_KEYPROJECT_DELAY%"=="" ping 127.0.0.1 -n %RPX_FAKE_KEYPROJECT_DELAY% >nul',
        'echo !REMOTE_CMD! | findstr /I /C:"config --get remote.origin.url" >nul',
        'if not errorlevel 1 (',
        '  echo ssh://git@example.com/team/clean-repo.git',
        '  exit /b 0',
        ')',
        'echo !REMOTE_CMD! | findstr /I /C:"fetch --prune --quiet" >nul',
        'if not errorlevel 1 exit /b 0',
        'echo !REMOTE_CMD! | findstr /I /C:"status --porcelain=v2 --branch" >nul',
        'if not errorlevel 1 (',
        '  echo # branch.head main',
        '  echo # branch.upstream origin/main',
        '  echo # branch.ab +0 -0',
        '  exit /b 0',
        ')',
        'echo On branch main',
        'echo nothing to commit, working tree clean',
        'exit /b 0',
        ':remote_dirty',
        'if not "%RPX_FAKE_KEYPROJECT_DELAY%"=="" ping 127.0.0.1 -n %RPX_FAKE_KEYPROJECT_DELAY% >nul',
        'echo !REMOTE_CMD! | findstr /I /C:"config --get remote.origin.url" >nul',
        'if not errorlevel 1 (',
        '  echo ssh://git@example.com/team/dirty-repo.git',
        '  exit /b 0',
        ')',
        'echo !REMOTE_CMD! | findstr /I /C:"fetch --prune --quiet" >nul',
        'if not errorlevel 1 exit /b 0',
        'echo !REMOTE_CMD! | findstr /I /C:"status --porcelain=v2 --branch" >nul',
        'if not errorlevel 1 (',
        '  echo # branch.head feature-ssh',
        '  echo # branch.upstream origin/feature-ssh',
        '  echo # branch.ab +1 -1',
        '  echo 1 .M N... 100644 100644 100644 123456 123456 remote/file.txt',
        '  exit /b 0',
        ')',
        'echo On branch feature-ssh',
        'echo Changes not staged for commit:',
        'echo   modified:   remote/file.txt',
        'exit /b 0'
      ].join('\r\n'),
      'utf8'
    );
  });

  suiteTeardown(async () => {
    await setKeyProjectsWorkspaceOverride();
    await config.update('configFile', originalConfigFile, vscode.ConfigurationTarget.Global);
    delete process.env.RPX_FAKE_MODE;
    delete process.env.RPX_FAKE_BIND_PORT;
  });

  test('commands should be registered', async () => {
    const commands = await vscode.commands.getCommands(true);
    assert.ok(!commands.includes('reverseProxy.start'));
    assert.ok(!commands.includes('reverseProxy.stop'));
    assert.ok(commands.includes('reverseProxy.showStatus'));
    assert.ok(commands.includes('reverseProxy.showLogs'));
    assert.ok(commands.includes('reverseProxy.openSettings'));
    assert.ok(!commands.includes('reverseProxy.sidebarToggle'));
    assert.ok(commands.includes('reverseProxy.openKeyProjectSettings'));
    assert.ok(commands.includes('reverseProxy.refreshKeyProjects'));
    assert.ok(commands.includes('reverseProxy.showKeyProjectStatus'));
  });

  test('log lines should include local timestamp prefix', async () => {
    const line = (await vscode.commands.executeCommand(
      'reverseProxy.test.formatLogLine',
      '[start] ssh test',
      '2026-05-06T07:08:09.123'
    )) as string;

    assert.strictEqual(line, '[2026-05-06 07:08:09.123] [start] ssh test');
  });

  test('repeated local target connection failures should be throttled', async () => {
    const results = (await vscode.commands.executeCommand(
      'reverseProxy.test.shouldLogSshStderrSequence',
      [
        'connect to 127.0.0.1 port 7897 failed: No error',
        'socket: No error',
        'connect to 127.0.0.1 port 7897 failed: No error',
        'socket: No error',
        'connect to 127.0.0.1 port 7897 failed: No error',
        'socket: No error',
        'Warning: remote port forwarding failed for listen port 17897'
      ],
      '127.0.0.1',
      7897,
      [0, 1, 10_000, 10_001, 31_000, 31_001, 31_002]
    )) as boolean[];

    assert.deepStrictEqual(results, [true, false, false, false, true, false, true]);
  });

  test('manifest should restrict extensionKind to ui', () => {
    const packageJsonPath = path.resolve(__dirname, '../../package.json');
    const manifest = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as {
      extensionKind?: string[];
      contributes?: { configuration?: unknown };
    };
    assert.ok(Array.isArray(manifest.extensionKind), 'extensionKind should be an array');
    assert.deepStrictEqual(manifest.extensionKind, ['ui']);
    assert.ok(manifest.contributes?.configuration, 'reverse proxy settings should still be contributed');
  });

  test('path resolution should use local home in remote mode and workspace in local mode', async () => {
    const localWorkspace = path.join(testDir, 'workspace-local');
    const localHome = path.join(testDir, 'home-local');
    const fakeExtension = path.join(testDir, 'fake-extension');
    fs.mkdirSync(localWorkspace, { recursive: true });
    fs.mkdirSync(localHome, { recursive: true });
    fs.mkdirSync(path.join(fakeExtension, 'resources'), { recursive: true });

    const relativeConfigName = 'reverse-proxy.config.json';
    const workspaceConfigPath = path.join(localWorkspace, relativeConfigName);
    const homeConfigPath = path.join(localHome, relativeConfigName);
    writeProxyConfig(29991);
    fs.copyFileSync(testConfigFilePath, workspaceConfigPath);
    fs.copyFileSync(testConfigFilePath, homeConfigPath);

    const localResult = (await vscode.commands.executeCommand('reverseProxy.test.resolvePaths', {
      configFile: relativeConfigName,
      workspaceFolder: localWorkspace,
      remoteName: '',
      homeDir: localHome,
      extensionPath: fakeExtension
    })) as { loadPath: string; configuredPath: string };

    assert.strictEqual(localResult.loadPath, workspaceConfigPath);
    assert.strictEqual(localResult.configuredPath, workspaceConfigPath);

    const remoteResult = (await vscode.commands.executeCommand('reverseProxy.test.resolvePaths', {
      configFile: relativeConfigName,
      workspaceFolder: localWorkspace,
      remoteName: 'ssh-remote',
      homeDir: localHome,
      extensionPath: fakeExtension
    })) as { loadPath: string; configuredPath: string };

    assert.strictEqual(remoteResult.loadPath, homeConfigPath);
    assert.strictEqual(remoteResult.configuredPath, homeConfigPath);
  });

  test('sidebar should expose reverse tunnel and key project groups', async () => {
    const emptyWorkspace = path.join(testDir, 'workspace-empty');
    fs.mkdirSync(emptyWorkspace, { recursive: true });
    await setKeyProjectsWorkspaceOverride(emptyWorkspace);
    writeProxyConfig(17897, { sshPath: fakeSshPath, connectionReadyDelayMs: 200 });
    await config.update('configFile', testConfigFilePath, vscode.ConfigurationTarget.Global);

    const tree = await getSidebarSnapshot();
    const reverseChildren = tree.children.filter((child) => child.parentLabel === 'ReverseTunnel');
    const keyProjectChildren = tree.children.filter((child) => child.parentLabel === 'Pinned Projects');

    assert.strictEqual(tree.root.length, 2, `Expected two root groups, got ${tree.root.length}`);
    assert.deepStrictEqual(tree.root.map((item) => item.label), ['ReverseTunnel', 'Pinned Projects']);
    assert.strictEqual(reverseChildren.length, 3, `Expected three reverse tunnel items, got ${reverseChildren.length}`);
    assert.strictEqual(reverseChildren[0]?.label, '10.99.0.1:4001: Stopped');
    assert.strictEqual(reverseChildren[1]?.label, 'Open Logs');
    assert.strictEqual(reverseChildren[2]?.label, 'Settings');
    assert.strictEqual(keyProjectChildren.length, 3, `Expected issue message, refresh, and settings for key projects, got ${keyProjectChildren.length}`);
    assert.ok(keyProjectChildren[0]?.label.includes('.vscode/mytoolbox.json'));
    assert.strictEqual(keyProjectChildren[1]?.label, 'Refresh');
    assert.strictEqual(keyProjectChildren[2]?.label, 'Settings');
  });

  test('reverse tunnel view should show multiple remotes as host port rows', async () => {
    writeProxyConfigWithRemotes(
      [
        { remoteHost: '10.99.0.1', remotePort: 4001, remoteUser: 'yangweijian', remoteBindPort: 17897, identityFile: '' },
        { remoteHost: '10.111.90.10', remotePort: 4001, remoteUser: 'foo', remoteBindPort: 17897, identityFile: '' }
      ],
      { sshPath: fakeSshPath, connectionReadyDelayMs: 200 }
    );
    await config.update('configFile', testConfigFilePath, vscode.ConfigurationTarget.Global);

    const model = (await vscode.commands.executeCommand('reverseProxy.test.getToolBoxViewState')) as {
      reverseTunnel: { rows: Array<{ hostLabel: string; stateLabel: string; actionLabel: string; tooltip: string }> };
    };

    assert.deepStrictEqual(
      model.reverseTunnel.rows.map((row) => `${row.hostLabel}:${row.stateLabel}:${row.actionLabel}`),
      ['10.99.0.1:4001:Stopped:Start', '10.111.90.10:4001:Stopped:Start']
    );
    assert.ok(model.reverseTunnel.rows[0]?.tooltip.includes('target: yangweijian@10.99.0.1'));
    assert.ok(model.reverseTunnel.rows[0]?.tooltip.includes('remote: 10.99.0.1:4001'));
    assert.ok(model.reverseTunnel.rows[0]?.tooltip.includes('state: Stopped'));
    assert.ok(model.reverseTunnel.rows[0]?.tooltip.includes('external: no'));
    assert.ok(model.reverseTunnel.rows[1]?.tooltip.includes('target: foo@10.111.90.10'));
  });

  test('reverse tunnel webview should render compact icon rows without table header', async () => {
    writeProxyConfigWithRemotes(
      [
        { remoteHost: '10.99.0.1', remotePort: 4001, remoteUser: 'yangweijian', remoteBindPort: 17897, identityFile: '' }
      ],
      { sshPath: fakeSshPath, connectionReadyDelayMs: 200 }
    );
    await config.update('configFile', testConfigFilePath, vscode.ConfigurationTarget.Global);

    const html = (await vscode.commands.executeCommand('reverseProxy.test.renderToolBoxHtml')) as string;

    assert.ok(!html.includes('<span>Host</span>'), 'Reverse tunnel table header should be removed');
    assert.ok(!html.includes('<span>State</span>'), 'Reverse tunnel table header should be removed');
    assert.ok(!html.includes('<span>Action</span>'), 'Reverse tunnel table header should be removed');
    assert.ok(html.includes('grid-template-columns: 20ch minmax(16px, 1fr) 48px 54px;'), 'Right controls should sit after a flexible spacer');
    assert.ok(html.includes('width: 20ch;'), 'Host code should fit max IPv4 plus four-digit port');
    assert.ok(html.includes('grid-column: 3;'), 'State and tooltip cell should be moved after the spacer');
    assert.ok(html.includes('grid-column: 4;'), 'Action button should be moved after the spacer');
    assert.ok(html.includes('class="rt-host-code">10.99.0.1:4001</code>'), 'Host should render with inline-code styling');
    assert.ok(html.includes('class="rt-state-icon stopped"'), 'Stopped state should render as icon class');
    assert.ok(html.includes('class="rt-info-icon"'), 'Info icon should be rendered next to state icon');
    assert.ok(html.includes('data-tooltip="remote: 10.99.0.1:4001'), 'Info icon should use immediate custom tooltip data');
    assert.ok(!html.includes('class="rt-info-icon" title='), 'Info icon should not use delayed native title tooltip');
    assert.ok(html.includes('target: yangweijian@10.99.0.1'), 'Info tooltip should include remote target details');
    assert.ok(html.includes('external: no'), 'Info tooltip should include external state');
    assert.ok(html.includes('overflow: visible;'), 'State cell should not clip the custom tooltip');
    assert.ok(html.includes('z-index: 60;'), 'Hovered tooltip trigger should sit above adjacent controls');
    assert.ok(!html.includes('>Stopped</span></span>'), 'State text should not be visible in the state cell');
  });

  test('reverse tunnel config should reject legacy single remote shape and duplicate remotes', async () => {
    const errors: string[] = [];
    const originalShowErrorMessage = win.showErrorMessage;

    win.showErrorMessage = async (message: string) => {
      errors.push(message);
      return undefined;
    };

    try {
      fs.writeFileSync(
        testConfigFilePath,
        JSON.stringify(
          {
            ReverseTunnel: {
              sshPath: 'ssh',
              connectionReadyDelayMs: 1200,
              remoteHost: '10.99.0.1',
              remotePort: 4001,
              remoteUser: 'yangweijian',
              remoteBindPort: 17897,
              localHost: '127.0.0.1',
              localPort: 7897,
              identityFile: ''
            }
          },
          null,
          2
        ),
        'utf8'
      );
      await config.update('configFile', testConfigFilePath, vscode.ConfigurationTarget.Global);
      await vscode.commands.executeCommand('reverseProxy.test.startRemoteTunnel', getDefaultRemoteKey());
      assert.ok(errors.some((message) => message.includes('ReverseTunnel.remotes')), `Expected legacy config error, got: ${errors.join(' | ')}`);

      errors.length = 0;
      writeProxyConfigWithRemotes(
        [
          { remoteHost: '10.99.0.1', remotePort: 4001, remoteUser: 'yangweijian', remoteBindPort: 17897, identityFile: '' },
          { remoteHost: '10.99.0.1', remotePort: 4001, remoteUser: 'yangweijian', remoteBindPort: 17898, identityFile: '' }
        ],
        { sshPath: fakeSshPath }
      );
      await vscode.commands.executeCommand('reverseProxy.test.startRemoteTunnel', getDefaultRemoteKey());
      assert.ok(errors.some((message) => message.includes('duplicate remote')), `Expected duplicate remote error, got: ${errors.join(' | ')}`);
    } finally {
      win.showErrorMessage = originalShowErrorMessage;
      writeProxyConfig(17897);
      await config.update('configFile', testConfigFilePath, vscode.ConfigurationTarget.Global);
    }
  });

  test('key projects should show local git branch, clean state, tooltip, and click details', async () => {
    const workspaceDir = path.join(testDir, 'workspace-local-key-projects');
    const localRoot = path.join(testDir, 'local-projects');
    fs.mkdirSync(path.join(localRoot, 'dirty-repo'), { recursive: true });
    fs.mkdirSync(path.join(localRoot, 'clean-repo'), { recursive: true });
    fs.mkdirSync(workspaceDir, { recursive: true });
    writeKeyProjectsConfig(workspaceDir, {
      keyProjects: {
        mode: 'local',
        rootDir: localRoot,
        repoNames: ['dirty-repo', 'clean-repo'],
        gitPath: fakeGitPath,
        sshPath: fakeSshPath,
        sshTarget: '',
        sshPort: 22
      }
    });

    try {
      await setKeyProjectsWorkspaceOverride(workspaceDir);
      let items = await getSidebarChildren('Pinned Projects');
      assert.deepStrictEqual(items.map((item) => item.label), ['Click Refresh to load key project status.', 'Refresh', 'Settings']);

      await vscode.commands.executeCommand('reverseProxy.refreshKeyProjects');

      items = await getSidebarChildren('Pinned Projects');
      assert.deepStrictEqual(items.map((item) => item.label), ['\u2757 dirty-repo.git: feature-dirty - behind 2', '\u2714\uFE0F clean-repo.git: main - synced', 'Refresh', 'Settings']);
      assert.ok(items[0]?.tooltip?.includes('- repo: `dirty-repo.git`') && items[0]?.tooltip?.includes('- remote: `behind 2`'));
      assert.ok(items[0]?.tooltip?.includes('- upstream: `origin/feature-dirty`'));
      assert.ok(items[0]?.tooltip?.includes('  - `1 .M N... 100644 100644 100644 123456 123456 src/app.ts`'));
      assert.ok(items[1]?.tooltip?.includes('- fetch: `ok`'));
      assert.ok(items[1]?.tooltip?.includes('- changes: `working tree clean`'));

      const clicked = (await vscode.commands.executeCommand('reverseProxy.test.clickSidebarItem', {
        parentLabel: 'Pinned Projects',
        label: '\u2757 dirty-repo.git: feature-dirty - behind 2'
      })) as string;
      assert.ok(clicked.includes('repo=dirty-repo.git'));

      const statusBarState = (await vscode.commands.executeCommand('reverseProxy.test.getStatusBarState')) as {
        proxyText: string;
        keyText: string;
        keyTooltip?: string;
      };
      assert.strictEqual(statusBarState.keyText, '$(bookmark) dirty-repo.git - feature-dirty');
      assert.ok(clicked.includes('Remote Sync: behind 2'));
      assert.ok(clicked.includes('Fetch: ok'));
      assert.ok(clicked.includes('modified:   src/app.ts'));
    } finally {
      await setKeyProjectsWorkspaceOverride();
    }
  });

  test('key projects should support ssh mode and keep configured order', async () => {
    const workspaceDir = path.join(testDir, 'workspace-ssh-key-projects');
    fs.mkdirSync(workspaceDir, { recursive: true });
    writeKeyProjectsConfig(workspaceDir, {
      keyProjects: {
        mode: 'ssh',
        rootDir: '/remote',
        repoNames: ['dirty-repo', 'clean-repo'],
        sshTarget: 'test@example',
        sshPort: 2222,
        sshPath: fakeSshPath,
        gitPath: fakeGitPath
      }
    });

    try {
      await setKeyProjectsWorkspaceOverride(workspaceDir);
      let items = await getSidebarChildren('Pinned Projects');
      assert.deepStrictEqual(items.map((item) => item.label), ['Click Refresh to load key project status.', 'Refresh', 'Settings']);

      await vscode.commands.executeCommand('reverseProxy.refreshKeyProjects');

      items = await getSidebarChildren('Pinned Projects');
      assert.deepStrictEqual(items.map((item) => item.label), ['\u2757 dirty-repo.git: feature-ssh - diverged +1/-1', '\u2714\uFE0F clean-repo.git: main - synced', 'Refresh', 'Settings']);
      assert.ok(items[0]?.tooltip?.includes('- repo: `dirty-repo.git`') && items[0]?.tooltip?.includes('- path: `/remote/dirty-repo`'));
      assert.ok(items[0]?.tooltip?.includes('- remote: `diverged +1/-1`'));
      assert.ok(items[0]?.tooltip?.includes('  - `1 .M N... 100644 100644 100644 123456 123456 remote/file.txt`'));
    } finally {
      await setKeyProjectsWorkspaceOverride();
    }
  });

  test('key projects refresh should show a running indicator', async () => {
    const workspaceDir = path.join(testDir, 'workspace-refresh-indicator');
    const localRoot = path.join(testDir, 'local-projects', 'spinner-repo');
    fs.mkdirSync(localRoot, { recursive: true });
    fs.mkdirSync(workspaceDir, { recursive: true });
    writeKeyProjectsConfig(workspaceDir, {
      keyProjects: {
        mode: 'local',
        rootDir: localRoot,
        repoNames: ['.'],
        gitPath: fakeGitPath,
        sshPath: fakeSshPath,
        sshTarget: '',
        sshPort: 22
      }
    });

    try {
      process.env.RPX_FAKE_KEYPROJECT_DELAY = '2';
      await setKeyProjectsWorkspaceOverride(workspaceDir);
      const pending = vscode.commands.executeCommand('reverseProxy.refreshKeyProjects');
      await new Promise((resolve) => setTimeout(resolve, 50));

      const items = await getSidebarChildren('Pinned Projects');
      assert.ok(items.some((item) => item.label === 'Refreshing...'));

      await pending;
    } finally {
      delete process.env.RPX_FAKE_KEYPROJECT_DELAY;
      await setKeyProjectsWorkspaceOverride();
    }
  });

  test('key projects should support dot repoNames and display the actual repo name', async () => {
    const workspaceDir = path.join(testDir, 'workspace-dot-key-projects');
    const localRoot = path.join(testDir, 'local-projects', 'root-repo');
    fs.mkdirSync(localRoot, { recursive: true });
    fs.mkdirSync(workspaceDir, { recursive: true });
    writeKeyProjectsConfig(workspaceDir, {
      keyProjects: {
        mode: 'local',
        rootDir: localRoot,
        repoNames: ['.'],
        gitPath: fakeGitPath,
        sshPath: fakeSshPath,
        sshTarget: '',
        sshPort: 22
      }
    });

    try {
      await setKeyProjectsWorkspaceOverride(workspaceDir);
      await vscode.commands.executeCommand('reverseProxy.refreshKeyProjects');

      const items = await getSidebarChildren('Pinned Projects');
      assert.deepStrictEqual(items.map((item) => item.label), ['\u2714\uFE0F root-repo.git: main - synced', 'Refresh', 'Settings']);
      assert.ok(items[0]?.tooltip?.includes('- repo: `root-repo.git`'));
      assert.ok(items[0]?.tooltip?.includes('- remote: `synced`'));

      const clicked = (await vscode.commands.executeCommand('reverseProxy.test.clickSidebarItem', {
        parentLabel: 'Pinned Projects',
        label: '\u2714\uFE0F root-repo.git: main - synced'
      })) as string;
      assert.ok(clicked.includes('repo=root-repo.git'));
      assert.ok(clicked.includes(`Path: ${localRoot}`));
    } finally {
      await setKeyProjectsWorkspaceOverride();
    }
  });

  test('key project settings helper should create workspace mytoolbox.json when missing', async () => {
    const selectedDir = path.join(testDir, 'key-project-settings-target');
    fs.mkdirSync(selectedDir, { recursive: true });

    const createdPath = (await vscode.commands.executeCommand(
      'reverseProxy.test.openKeyProjectSettingsWithDirectory',
      selectedDir
    )) as string;

    assert.strictEqual(createdPath.toLowerCase(), path.join(selectedDir, '.vscode', 'mytoolbox.json').toLowerCase());
    assert.ok(fs.existsSync(createdPath), 'workspace mytoolbox.json should be created');
    const created = JSON.parse(fs.readFileSync(createdPath, 'utf8')) as { keyProjects?: { sshPort?: number } };
    assert.ok(created.keyProjects, 'keyProjects section should exist');
    assert.strictEqual(created.keyProjects?.sshPort, 22);
  });

  test('sidebar remote row should switch Stopped -> Started -> Stopped end-to-end', async () => {
    const infos: string[] = [];
    const originalShowInformationMessage = win.showInformationMessage;

    win.showInformationMessage = async (message: string) => {
      infos.push(message);
      return undefined;
    };

    try {
      writeProxyConfig(29103, { sshPath: fakeSshPath, connectionReadyDelayMs: 200 });
      process.env.RPX_FAKE_MODE = 'success';
      await config.update('configFile', testConfigFilePath, vscode.ConfigurationTarget.Global);
      await vscode.commands.executeCommand('reverseProxy.test.resetRemoteTunnelStates');

      await vscode.commands.executeCommand('reverseProxy.test.clickSidebarItem', {
        parentLabel: 'ReverseTunnel',
        label: '10.99.0.1:4001: Stopped'
      });
      await new Promise((resolve) => setTimeout(resolve, 700));
      assert.ok(
        infos.some((m) => m.includes('Reverse tunnel started: 10.99.0.1:4001')),
        `Expected started message after row click, got: ${infos.join(' | ')}`
      );

      const treeAfterStart = await getSidebarChildren('ReverseTunnel');
      assert.strictEqual(treeAfterStart.length, 3);
      assert.strictEqual(treeAfterStart[0]?.label, '10.99.0.1:4001: Started');
      assert.ok(treeAfterStart[0]?.enabled, 'Started row should be clickable');
      assert.strictEqual(treeAfterStart[1]?.label, 'Open Logs');
      assert.strictEqual(treeAfterStart[2]?.label, 'Settings');

      await vscode.commands.executeCommand('reverseProxy.test.clickSidebarItem', {
        parentLabel: 'ReverseTunnel',
        label: '10.99.0.1:4001: Started'
      });
      await new Promise((resolve) => setTimeout(resolve, 350));
      const treeAfterStop = await getSidebarChildren('ReverseTunnel');
      assert.strictEqual(treeAfterStop.length, 3);
      assert.strictEqual(treeAfterStop[0]?.label, '10.99.0.1:4001: Stopped');
      assert.ok(treeAfterStop[0]?.enabled, 'Stopped row should be clickable after stop');
      assert.strictEqual(treeAfterStop[1]?.label, 'Open Logs');
      assert.strictEqual(treeAfterStop[2]?.label, 'Settings');
    } finally {
      win.showInformationMessage = originalShowInformationMessage;
      delete process.env.RPX_FAKE_MODE;
      await vscode.commands.executeCommand('reverseProxy.test.stopRemoteTunnel', getDefaultRemoteKey());
    }
  });

  test('external reverse tunnel should show Started but remain non-clickable', async () => {
    let externalProcess: ChildProcessWithoutNullStreams | null = null;
    try {
      writeProxyConfig(29111, { sshPath: fakeSshPath, connectionReadyDelayMs: 200 });
      await config.update('configFile', testConfigFilePath, vscode.ConfigurationTarget.Global);
      process.env.RPX_FAKE_MODE = 'success';
      externalProcess = spawn(fakeSshPath, [
        '-N',
        '-p',
        '4001',
        '-o',
        'ExitOnForwardFailure=yes',
        '-o',
        'ServerAliveInterval=30',
        '-o',
        'ServerAliveCountMax=3',
        '-R',
        '29111:127.0.0.1:7897',
        'yangweijian@10.99.0.1'
      ]);

      await new Promise((resolve) => setTimeout(resolve, 250));
      await vscode.commands.executeCommand('reverseProxy.test.syncStateFromSystem');

      const items = await getSidebarChildren('ReverseTunnel');
      assert.strictEqual(items[0]?.label, '10.99.0.1:4001: Started');
      assert.strictEqual(items[0]?.description, 'external');
      assert.strictEqual(items[0]?.enabled, false);
      assert.ok(items[0]?.tooltip?.includes('Started externally'));
      assert.ok(items[0]?.tooltip?.includes('external: yes'));
    } finally {
      delete process.env.RPX_FAKE_MODE;
      if (externalProcess) {
        externalProcess.kill();
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
      await vscode.commands.executeCommand('reverseProxy.test.syncStateFromSystem');
    }
  });

  test('settings helper should create configs.json and update configFile when target path is missing', async () => {
    const missingRelative = 'definitely-missing-configs\\proxy-config.json';
    await config.update('configFile', missingRelative, vscode.ConfigurationTarget.Global);

    const selectedDir = path.join(testDir, 'settings-target');
    fs.mkdirSync(selectedDir, { recursive: true });

    const createdPath = (await vscode.commands.executeCommand(
      'reverseProxy.test.openSettingsWithDirectory',
      selectedDir
    )) as string;

    assert.strictEqual(createdPath, path.join(selectedDir, 'configs.json'));
    assert.ok(fs.existsSync(createdPath), 'configs.json should be created');

    const created = JSON.parse(fs.readFileSync(createdPath, 'utf8')) as Record<string, unknown>;
    const section = created.ReverseTunnel as Record<string, unknown>;
    assert.ok(section, 'ReverseTunnel section should exist');
    assert.strictEqual(section.sshPath, 'ssh');
    assert.strictEqual(section.connectionReadyDelayMs, 1200);
    assert.strictEqual(section.localHost, '127.0.0.1');
    const remotes = section.remotes as Array<Record<string, unknown>>;
    assert.ok(Array.isArray(remotes), 'ReverseTunnel.remotes should be an array');
    assert.strictEqual(remotes[0]?.remoteHost, 'FOO_ADDRESS');
    assert.strictEqual(remotes[0]?.remoteUser, 'FOO_USER');

    const updatedConfigFile = vscode.workspace.getConfiguration('reverseProxy').get<string>('configFile', '');
    assert.strictEqual(updatedConfigFile, createdPath);
  });

  test('remote row start should show error when ssh does not exist', async () => {
    let capturedError = '';
    const originalShowErrorMessage = win.showErrorMessage;

    win.showErrorMessage = async (message: string) => {
      capturedError = message;
      return undefined;
    };

    try {
      writeProxyConfig(49017, { sshPath: '__definitely_missing_ssh_binary__', connectionReadyDelayMs: 200 });
      await config.update('configFile', testConfigFilePath, vscode.ConfigurationTarget.Global);
      await vscode.commands.executeCommand('reverseProxy.test.startRemoteTunnel', getDefaultRemoteKey());

      assert.ok(
        capturedError.includes('SSH command is unavailable'),
        `Expected SSH unavailable error message, got: ${capturedError}`
      );
    } finally {
      win.showErrorMessage = originalShowErrorMessage;
      await vscode.commands.executeCommand('reverseProxy.test.stopRemoteTunnel', getDefaultRemoteKey());
    }
  });

  test('remote row start should show error when config file path is invalid', async () => {
    const errors: string[] = [];
    const originalShowErrorMessage = win.showErrorMessage;

    win.showErrorMessage = async (message: string) => {
      errors.push(message);
      return undefined;
    };

    try {
      await config.update('configFile', path.join(testDir, 'missing-config.json'), vscode.ConfigurationTarget.Global);
      await vscode.commands.executeCommand('reverseProxy.test.startRemoteTunnel', getDefaultRemoteKey());

      assert.ok(
        errors.some((m) => m.includes('Failed to load reverse proxy config')),
        `Expected config load error message, got: ${errors.join(' | ')}`
      );
    } finally {
      win.showErrorMessage = originalShowErrorMessage;
      await config.update('configFile', testConfigFilePath, vscode.ConfigurationTarget.Global);
      await vscode.commands.executeCommand('reverseProxy.test.stopRemoteTunnel', getDefaultRemoteKey());
    }
  });

  test('remote row start should show error when config file JSON is malformed', async () => {
    const errors: string[] = [];
    const originalShowErrorMessage = win.showErrorMessage;

    win.showErrorMessage = async (message: string) => {
      errors.push(message);
      return undefined;
    };

    try {
      const brokenConfigPath = path.join(testDir, 'broken-config.json');
      fs.writeFileSync(brokenConfigPath, '{"remoteHost": "10.99.0.1",', 'utf8');
      await config.update('configFile', brokenConfigPath, vscode.ConfigurationTarget.Global);
      await vscode.commands.executeCommand('reverseProxy.test.startRemoteTunnel', getDefaultRemoteKey());

      assert.ok(
        errors.some((m) => m.includes('Failed to load reverse proxy config')),
        `Expected config parse error message, got: ${errors.join(' | ')}`
      );
    } finally {
      win.showErrorMessage = originalShowErrorMessage;
      await config.update('configFile', testConfigFilePath, vscode.ConfigurationTarget.Global);
      await vscode.commands.executeCommand('reverseProxy.test.stopRemoteTunnel', getDefaultRemoteKey());
    }
  });

  test('remote row start should show clear error when remote port is occupied', async () => {
    const errors: string[] = [];
    const originalShowErrorMessage = win.showErrorMessage;
    const occupiedPort = 28901;

    win.showErrorMessage = async (message: string) => {
      errors.push(message);
      return undefined;
    };

    try {
      writeProxyConfig(occupiedPort, { sshPath: fakeSshPath, connectionReadyDelayMs: 200 });
      process.env.RPX_FAKE_MODE = 'port_busy';
      process.env.RPX_FAKE_BIND_PORT = String(occupiedPort);
      await config.update('configFile', testConfigFilePath, vscode.ConfigurationTarget.Global);

      await vscode.commands.executeCommand('reverseProxy.test.startRemoteTunnel', getDefaultRemoteKey());
      await new Promise((resolve) => setTimeout(resolve, 800));

      assert.ok(
        errors.some((m) => m.includes(`remote port ${occupiedPort} is already in use`)),
        `Expected occupied-port error message, got: ${errors.join(' | ')}`
      );
    } finally {
      win.showErrorMessage = originalShowErrorMessage;
      delete process.env.RPX_FAKE_MODE;
      delete process.env.RPX_FAKE_BIND_PORT;
      await vscode.commands.executeCommand('reverseProxy.test.stopRemoteTunnel', getDefaultRemoteKey());
    }
  });

  test('windows process inspection script should separate statements correctly', async () => {
    const script = (await vscode.commands.executeCommand(
      'reverseProxy.test.getWindowsProcessInspectionScript'
    )) as string;

    assert.ok(script.includes('$ErrorActionPreference = "Stop"; Get-CimInstance Win32_Process |'));
    assert.ok(!script.includes('$ErrorActionPreference = "Stop" Get-CimInstance'));
  });

  test('remote row start should show started message when tunnel is established', async () => {
    const infos: string[] = [];
    const originalShowInformationMessage = win.showInformationMessage;

    win.showInformationMessage = async (message: string) => {
      infos.push(message);
      return undefined;
    };

    try {
      writeProxyConfig(29002, { sshPath: fakeSshPath, connectionReadyDelayMs: 200 });
      process.env.RPX_FAKE_MODE = 'success';
      await config.update('configFile', testConfigFilePath, vscode.ConfigurationTarget.Global);

      await vscode.commands.executeCommand('reverseProxy.test.startRemoteTunnel', getDefaultRemoteKey());
      await new Promise((resolve) => setTimeout(resolve, 700));

      assert.ok(
        infos.some((m) => m.includes('Reverse tunnel started: 10.99.0.1:4001')),
        `Expected started message, got: ${infos.join(' | ')}`
      );
    } finally {
      win.showInformationMessage = originalShowInformationMessage;
      delete process.env.RPX_FAKE_MODE;
      await vscode.commands.executeCommand('reverseProxy.test.stopRemoteTunnel', getDefaultRemoteKey());
    }
  });
});
