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

suite('CodeOps Panel Extension Integration Tests', () => {
  const config = vscode.workspace.getConfiguration('myToolbox');
  const win = vscode.window as unknown as {
    showErrorMessage: typeof vscode.window.showErrorMessage;
    showInformationMessage: typeof vscode.window.showInformationMessage;
    showInputBox: typeof vscode.window.showInputBox;
    showQuickPick: typeof vscode.window.showQuickPick;
    showWarningMessage: typeof vscode.window.showWarningMessage;
    showOpenDialog: typeof vscode.window.showOpenDialog;
  };

  let fakeSshPath = '';
  let fakeGitPath = '';
  let testDir = '';
  let testConfigFilePath = '';
  let originalConfigFile = '.vscode/mytoolbox.config.json';

  const readTestConfig = (): Record<string, unknown> => {
    if (!testConfigFilePath || !fs.existsSync(testConfigFilePath)) {
      return {};
    }
    return JSON.parse(fs.readFileSync(testConfigFilePath, 'utf8')) as Record<string, unknown>;
  };

  const getDefaultKeyProjectsConfig = () => ({
    mode: 'local',
    rootDir: '',
    repoNames: [],
    sshTarget: '',
    sshPort: 22,
    gitPath: 'git',
    sshPath: 'ssh'
  });

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
          },
          keyProjects: readTestConfig().keyProjects ?? getDefaultKeyProjectsConfig(),
          favoriteWorkspaces: readTestConfig().favoriteWorkspaces ?? { workspaceFiles: [] }
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
          },
          keyProjects: readTestConfig().keyProjects ?? getDefaultKeyProjectsConfig(),
          favoriteWorkspaces: readTestConfig().favoriteWorkspaces ?? { workspaceFiles: [] }
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
    void workspaceDir;
    const existing = readTestConfig();
    fs.writeFileSync(
      testConfigFilePath,
      JSON.stringify({ ...existing, keyProjects: data.keyProjects }, null, 2) + '\n',
      'utf8'
    );
    return testConfigFilePath;
  };

  const writeFavoriteWorkspacesConfig = (workspaceFiles: string[]): string => {
    const existing = readTestConfig();
    fs.writeFileSync(
      testConfigFilePath,
      JSON.stringify({ ...existing, favoriteWorkspaces: { workspaceFiles } }, null, 2) + '\n',
      'utf8'
    );
    return testConfigFilePath;
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

  const withWindowPrompts = async <T>(
    prompts: {
      inputs?: Array<string | undefined>;
      picks?: Array<string | undefined>;
      warnings?: Array<string | undefined>;
      folders?: Array<string | vscode.Uri | undefined>;
    },
    run: () => Promise<T>
  ): Promise<T> => {
    const originalShowInputBox = win.showInputBox;
    const originalShowQuickPick = win.showQuickPick;
    const originalShowWarningMessage = win.showWarningMessage;
    const originalShowOpenDialog = win.showOpenDialog;
    const inputs = [...(prompts.inputs ?? [])];
    const picks = [...(prompts.picks ?? [])];
    const warnings = [...(prompts.warnings ?? [])];
    const folders = [...(prompts.folders ?? [])];

    win.showInputBox = (async () => inputs.shift()) as typeof vscode.window.showInputBox;
    win.showQuickPick = (async () => picks.shift()) as typeof vscode.window.showQuickPick;
    win.showWarningMessage = (async () => warnings.shift()) as typeof vscode.window.showWarningMessage;
    win.showOpenDialog = (async () => {
      const folder = folders.shift();
      return folder === undefined ? undefined : [typeof folder === 'string' ? vscode.Uri.file(folder) : folder];
    }) as typeof vscode.window.showOpenDialog;

    try {
      return await run();
    } finally {
      win.showInputBox = originalShowInputBox;
      win.showQuickPick = originalShowQuickPick;
      win.showWarningMessage = originalShowWarningMessage;
      win.showOpenDialog = originalShowOpenDialog;
    }
  };

  suiteSetup(async () => {
    const extension = vscode.extensions.getExtension('YangWeijian.code-ops-panel-extension');
    assert.ok(extension, 'Extension YangWeijian.code-ops-panel-extension should be installed for tests');
    await extension!.activate();

    originalConfigFile = config.get<string>('configFile', '.vscode/mytoolbox.config.json');

    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reverse-proxy-ext-test-'));
    testConfigFilePath = path.join(testDir, 'mytoolbox.config.json');
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
    assert.ok(!commands.includes('reverseProxy.showStatus'));
    assert.ok(commands.includes('reverseProxy.showLogs'));
    assert.ok(commands.includes('reverseProxy.openSettings'));
    assert.ok(commands.includes('reverseProxy.bootstrapConfig'));
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
      name?: string;
      displayName?: string;
      version?: string;
      extensionKind?: string[];
      contributes?: {
        configuration?: { properties?: Record<string, unknown> };
        viewsContainers?: { activitybar?: Array<{ title?: string }> };
        views?: { reverseProxy?: Array<{ name?: string }> };
      };
    };
    assert.strictEqual(manifest.name, 'code-ops-panel-extension');
    assert.strictEqual(manifest.displayName, 'CodeOps Panel');
    assert.strictEqual(manifest.version, '0.1.1');
    assert.ok(Array.isArray(manifest.extensionKind), 'extensionKind should be an array');
    assert.deepStrictEqual(manifest.extensionKind, ['ui']);
    assert.ok(manifest.contributes?.configuration, 'reverse proxy settings should still be contributed');
    assert.ok(manifest.contributes?.configuration?.properties?.['myToolbox.debugLogs'], 'debug log setting should be contributed');
    assert.strictEqual(manifest.contributes?.viewsContainers?.activitybar?.[0]?.title, 'CodeOps Panel');
    assert.strictEqual(manifest.contributes?.views?.reverseProxy?.[0]?.name, 'CodeOps Panel');
  });

  test('path resolution should use workspace in local and remote mode', async () => {
    const localWorkspace = path.join(testDir, 'workspace-local');
    const localHome = path.join(testDir, 'home-local');
    const fakeExtension = path.join(testDir, 'fake-extension');
    fs.mkdirSync(localWorkspace, { recursive: true });
    fs.mkdirSync(localHome, { recursive: true });
    fs.mkdirSync(path.join(fakeExtension, 'resources'), { recursive: true });

    const relativeConfigName = '.vscode/mytoolbox.config.json';
    const workspaceConfigPath = path.join(localWorkspace, relativeConfigName);
    const homeConfigPath = path.join(localHome, relativeConfigName);
    fs.mkdirSync(path.dirname(workspaceConfigPath), { recursive: true });
    fs.mkdirSync(path.dirname(homeConfigPath), { recursive: true });
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

    assert.strictEqual(remoteResult.loadPath, workspaceConfigPath);
    assert.strictEqual(remoteResult.configuredPath, workspaceConfigPath);

    const tokenResult = (await vscode.commands.executeCommand('reverseProxy.test.resolvePaths', {
      configFile: '${workspaceFolder}/.vscode/mytoolbox.config.json',
      workspaceFolder: localWorkspace,
      remoteName: 'ssh-remote',
      homeDir: localHome,
      extensionPath: fakeExtension
    })) as { loadPath: string; configuredPath: string };

    assert.strictEqual(tokenResult.loadPath, workspaceConfigPath);
    assert.strictEqual(tokenResult.configuredPath, workspaceConfigPath);
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
    assert.strictEqual(keyProjectChildren.length, 2, `Expected issue message and refresh for key projects, got ${keyProjectChildren.length}`);
    assert.ok(keyProjectChildren[0]?.label.includes('keyProjects.rootDir'));
    assert.strictEqual(keyProjectChildren[1]?.label, 'Refresh');
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

  test('webview should render compact soft graphite dashboard sections', async () => {
    const workspaceDir = path.join(testDir, 'workspace-webview-dashboard');
    const localRoot = path.join(testDir, 'webview-projects');
    fs.mkdirSync(path.join(localRoot, 'clean-repo'), { recursive: true });
    fs.mkdirSync(workspaceDir, { recursive: true });
    writeKeyProjectsConfig(workspaceDir, {
      keyProjects: {
        mode: 'local',
        rootDir: localRoot,
        repoNames: ['clean-repo'],
        gitPath: fakeGitPath,
        sshPath: fakeSshPath,
        sshTarget: '',
        sshPort: 22
      }
    });
    writeProxyConfigWithRemotes(
      [
        { remoteHost: '10.99.0.1', remotePort: 4001, remoteUser: 'yangweijian', remoteBindPort: 17897, identityFile: '' }
      ],
      { sshPath: fakeSshPath, connectionReadyDelayMs: 200 }
    );

    try {
      await setKeyProjectsWorkspaceOverride(workspaceDir);
      await config.update('configFile', testConfigFilePath, vscode.ConfigurationTarget.Global);
      await vscode.commands.executeCommand('reverseProxy.refreshKeyProjects');

      const html = (await vscode.commands.executeCommand('reverseProxy.test.renderToolBoxHtml')) as string;

      assert.ok(html.includes('<h1 class="app-title">My Dashboard</h1>'), 'Dashboard brand title should render in the global toolbar');
      assert.ok(html.includes('data-action="bootstrap"'), 'Top toolbar should render Bootstrap action');
      assert.ok(html.includes('title="Bootstrap"'), 'Bootstrap button should have a tooltip');
      assert.ok(!html.includes('Your development command center'), 'Dashboard subtitle should not be rendered');
      assert.ok(html.includes('Reverse Tunnel Proxies'), 'Reverse tunnel dashboard section should be rendered');
      assert.ok(!html.includes('Manage your tunnel connections'), 'Reverse tunnel helper text should not be rendered');
      assert.ok(html.includes('Pinned Projects'), 'Pinned projects dashboard section should be rendered');
      assert.ok(html.includes('Favorite Workspaces'), 'Favorite workspaces dashboard section should be rendered');
      assert.ok(html.includes('id="favorite-add"'), 'Favorite workspaces add button should render');
      assert.ok(html.includes('grid-template-columns: repeat(auto-fill, minmax(118px, 136px));'), 'Favorite workspaces should use a narrow multi-column card grid');
      assert.ok(html.includes('justify-content: start;'), 'Favorite workspace cards should keep their narrow width instead of stretching across the row');
      assert.ok(!html.includes('<div class="card"><div class="workspace-grid">'), 'Favorite workspaces should not render an outer card frame');
      assert.ok(!html.includes('Track your repository status'), 'Pinned projects helper text should not be rendered');
      assert.ok(html.includes('<th>Proxy</th><th class="align-right">Action</th>'), 'Reverse tunnel table header should be rendered');
      assert.ok(html.includes('<th>State</th><th>Repository</th><th>Branch</th><th>Remote</th>'), 'Pinned projects table header should match Figma sample');
      assert.ok(!html.includes('class="brand-icon"'), 'Lucide-style brand icon should not be rendered');
      assert.ok(html.includes('class="section-title-mark reverse-title-icon"'), 'Reverse tunnel section should render a title icon');
      assert.ok(html.includes('class="section-title-mark pinned-title-icon"'), 'Pinned projects section should render a title icon');
      assert.ok(html.includes('class="section-title-mark favorite-title-icon"'), 'Favorite workspaces section should render a title icon');
      assert.ok(html.includes('--bg: #11161c;'), 'Webview should use the deep graphite background');
      assert.ok(html.includes('--card: rgba(29, 35, 44, 0.76);'), 'Webview should use a translucent glass card color');
      assert.ok(html.includes('--purple-soft: rgba(177, 128, 255, 0.16);'), 'Webview should expose the purple accent wash');
      assert.ok(html.includes('--start-500: #3794ff;'), 'Start button should use the Blue Gray accent');
      assert.ok(html.includes('background: linear-gradient(135deg, #4a9cff, var(--start-600));'), 'Start button should use the blue gradient');
      assert.ok(html.includes('backdrop-filter: blur(18px);'), 'Cards and popovers should use a glass blur treatment');
      assert.ok(html.includes('.workspace-card::before'), 'Favorite workspace cards should include a purple side accent');
      assert.ok(html.includes('min-height: 124px;'), 'Favorite workspace cards should be slightly roomier');
      assert.ok(html.includes('font-size: 14px;'), 'Favorite workspace titles should use the roomier title size');
      assert.ok(html.includes('<table class="dashboard-table rt-table">'), 'Reverse tunnel should use a table wrapper');
      assert.ok(html.includes('class="rt-proxy-main"'), 'Reverse tunnel should combine state, host, and info in one proxy cell');
      assert.ok(html.includes('class="rt-host-code">10.99.0.1:4001</code>'), 'Host should render with inline-code styling');
      assert.ok(html.includes('class="rt-state-icon stopped"'), 'Stopped state should render as icon class');
      assert.ok(html.includes('class="rt-server-state"'), 'Reverse tunnel state should render as a compact server icon');
      assert.ok(html.includes('class="rt-server-state-dot stopped"'), 'Reverse tunnel server icon should include a status dot');
      assert.ok(html.includes('class="rt-info-icon"'), 'Info icon should be rendered next to state icon');
      assert.ok(html.includes('class="rt-action-button start"'), 'Start action button should be rendered');
      assert.ok(html.includes('data-tooltip="remote: 10.99.0.1:4001'), 'Info icon should use immediate custom tooltip data');
      assert.ok(!html.includes('class="rt-info-icon" title='), 'Info icon should not use delayed native title tooltip');
      assert.ok(html.includes('id="rt-tooltip" class="rt-tooltip"'), 'Reverse tunnel tooltip should render as an independent fixed overlay');
      assert.ok(html.includes('position: fixed;'), 'Tooltip overlay should use fixed positioning to avoid clipping');
      assert.ok(html.includes('showReverseTooltip'), 'Tooltip JS should position the independent overlay on hover');
      assert.ok(html.includes('target: yangweijian@10.99.0.1'), 'Info tooltip should include remote target details');
      assert.ok(html.includes('external: no'), 'Info tooltip should include external state');
      assert.ok(html.includes('clean-repo.git'), 'Pinned project repository should render in the table after refresh');
      assert.ok(html.includes('class="project-state-icon synced"'), 'Pinned project sync state should render as icon class');
      assert.ok(!html.includes('id="key-settings"'), 'Pinned projects section should not render a settings button');
    } finally {
      await setKeyProjectsWorkspaceOverride();
    }
  });

  test('favorite workspaces should render cards from workspace files and stable summaries', async () => {
    const workspaceBase = path.join(testDir, 'favorite-workspaces');
    const frontendDir = path.join(workspaceBase, 'frontend');
    const apiDir = path.join(workspaceBase, 'api');
    fs.mkdirSync(frontendDir, { recursive: true });
    fs.mkdirSync(apiDir, { recursive: true });
    fs.writeFileSync(path.join(frontendDir, 'README.md'), '# Frontend\n\nReact and TypeScript projects with modern tooling. More details.', 'utf8');
    const workspaceFile = path.join(workspaceBase, 'Frontend Development.code-workspace');
    fs.writeFileSync(
      workspaceFile,
      JSON.stringify(
        {
          folders: [
            { name: 'Frontend Development', path: 'frontend' },
            { path: 'api' },
            { path: 'docs' }
          ]
        },
        null,
        2
      ),
      'utf8'
    );
    writeFavoriteWorkspacesConfig([workspaceFile]);
    await config.update('configFile', testConfigFilePath, vscode.ConfigurationTarget.Global);

    const model = (await vscode.commands.executeCommand('reverseProxy.test.getFavoriteWorkspacesViewState')) as {
      rows: Array<{ name: string; description: string; available: boolean; workspacePath: string }>;
    };
    assert.strictEqual(model.rows.length, 1);
    assert.strictEqual(model.rows[0]?.name, 'Frontend Development');
    assert.strictEqual(model.rows[0]?.available, true);
    assert.strictEqual(model.rows[0]?.workspacePath, workspaceFile);
    assert.ok(model.rows[0]?.description.includes('Frontend Development, api, +1 more'));
    assert.ok(!model.rows[0]?.description.includes('folders:'));
    assert.ok(!model.rows[0]?.description.includes('Frontend React and TypeScript projects with modern tooling.'));

    const html = (await vscode.commands.executeCommand('reverseProxy.test.renderToolBoxHtml')) as string;
    assert.ok(html.includes('class="workspace-card"'), 'Favorite workspace card should render');
    assert.ok(html.includes('Frontend Development'), 'Workspace name should render');
    assert.ok(html.includes('title="Frontend Development"'), 'Workspace name should expose full title on hover');
    assert.ok(html.includes('Frontend Development, api, +1 more'), 'Folder summary should render');
    assert.ok(html.includes('class="workspace-folder-icon"'), 'Folder summary should render with a folder icon');
    assert.ok(!html.includes('3 folders:'), 'Folder summary should not include folder count prefix');
    assert.ok(!html.includes('workspace-language-divider'), 'Language divider should not render');
    assert.ok(!html.includes('class="workspace-language-bar"'), 'Language distribution should not render without languages');
    assert.ok(html.includes('data-workspace-path="'), 'Workspace card should include open path data');
    assert.ok(html.includes('data-workspace-remove="'), 'Workspace card should include remove path data');
    assert.ok(html.includes('id="favorite-refresh"'), 'Favorite workspace refresh button should render');
    assert.ok(html.includes("type: 'action', action: 'favoriteRefresh'"), 'Webview should post favorite refresh messages');
    assert.ok(!html.includes('workspace-star'), 'Favorite workspace cards should not render star icons');
    assert.ok(!html.includes('<div class="card"><div class="workspace-grid">'), 'Favorite workspace list should not be wrapped in an outer card frame');
    assert.ok(html.includes("type: 'favoriteWorkspace', action: 'open'"), 'Webview should post open workspace messages');
    assert.ok(html.includes("type: 'favoriteWorkspace', action: 'remove'"), 'Webview should post remove workspace messages');
  });

  test('favorite workspaces add should write config, dedupe, and remove should delete entry', async () => {
    const workspaceBase = path.join(testDir, 'favorite-add-remove');
    fs.mkdirSync(workspaceBase, { recursive: true });
    const workspaceFile = path.join(workspaceBase, 'Backend Services.code-workspace');
    fs.writeFileSync(workspaceFile, JSON.stringify({ folders: [] }, null, 2), 'utf8');
    writeFavoriteWorkspacesConfig([]);
    await config.update('configFile', testConfigFilePath, vscode.ConfigurationTarget.Global);

    await withWindowPrompts(
      { folders: [workspaceFile] },
      async () => {
        await vscode.commands.executeCommand('reverseProxy.test.addFavoriteWorkspace');
      }
    );
    await withWindowPrompts(
      { folders: [workspaceFile] },
      async () => {
        await vscode.commands.executeCommand('reverseProxy.test.addFavoriteWorkspace');
      }
    );

    let created = readTestConfig() as { favoriteWorkspaces?: { workspaceFiles?: string[] } };
    assert.deepStrictEqual(
      created.favoriteWorkspaces?.workspaceFiles?.map((entry) => entry.toLowerCase()),
      [workspaceFile.toLowerCase()]
    );

    await vscode.commands.executeCommand('reverseProxy.test.removeFavoriteWorkspace', workspaceFile);
    created = readTestConfig() as { favoriteWorkspaces?: { workspaceFiles?: string[] } };
    assert.deepStrictEqual(created.favoriteWorkspaces?.workspaceFiles, []);
  });

  test('favorite workspaces add should analyze top local languages', async () => {
    const workspaceBase = path.join(testDir, 'favorite-language-scan');
    const appDir = path.join(workspaceBase, 'app');
    const nativeDir = path.join(workspaceBase, 'native');
    const cppDir = path.join(workspaceBase, 'cpp');
    const ignoredDir = path.join(appDir, 'node_modules', 'ignored');
    fs.mkdirSync(appDir, { recursive: true });
    fs.mkdirSync(nativeDir, { recursive: true });
    fs.mkdirSync(cppDir, { recursive: true });
    fs.mkdirSync(ignoredDir, { recursive: true });
    fs.writeFileSync(path.join(appDir, 'index.ts'), 'const message: string = "typescript";\n'.repeat(20), 'utf8');
    fs.writeFileSync(path.join(nativeDir, 'lib.rs'), 'pub fn run() {}\n'.repeat(2), 'utf8');
    fs.writeFileSync(path.join(cppDir, 'main.cpp'), 'int main() { return 0; }\n'.repeat(15), 'utf8');
    fs.writeFileSync(path.join(ignoredDir, 'ignored.py'), 'print("ignored")\n'.repeat(200), 'utf8');

    const workspaceFile = path.join(workspaceBase, 'Language Scan.code-workspace');
    fs.writeFileSync(
      workspaceFile,
      JSON.stringify({ folders: [{ path: 'app' }, { path: 'native' }, { uri: vscode.Uri.file(cppDir).toString() }] }, null, 2),
      'utf8'
    );
    writeFavoriteWorkspacesConfig([]);
    await config.update('configFile', testConfigFilePath, vscode.ConfigurationTarget.Global);

    await withWindowPrompts(
      { folders: [workspaceFile] },
      async () => {
        await vscode.commands.executeCommand('reverseProxy.test.addFavoriteWorkspace');
      }
    );

    const model = (await vscode.commands.executeCommand('reverseProxy.test.getFavoriteWorkspacesViewState')) as {
      rows: Array<{ languageSummary: string; languages: Array<{ name: string; percent: number }> }>;
    };
    assert.ok(model.rows[0]?.languageSummary.includes('TypeScript'), 'TypeScript should be included in language summary');
    assert.ok(model.rows[0]?.languageSummary.includes('C++'), 'C++ should be included in language summary');
    assert.ok(!model.rows[0]?.languageSummary.includes('Python'), 'Ignored directories should not contribute languages');
    assert.strictEqual(model.rows[0]?.languages.length, 2);
    const html = (await vscode.commands.executeCommand('reverseProxy.test.renderToolBoxHtml')) as string;
    assert.ok(!html.includes('workspace-language-divider'), 'Language divider should not render');
    assert.ok(html.includes('class="workspace-language-bar"'), 'Language distribution bar should render when languages exist');
    assert.ok(html.includes('workspace-language-segment typescript'), 'TypeScript distribution segment should render');
    assert.ok(html.includes('workspace-language-dot typescript'), 'TypeScript language dot should render');
    assert.ok(html.includes('workspace-language-dot cpp'), 'C++ language dot should render');
    assert.ok(html.includes('--workspace-accent: var(--lang-typescript);'), 'Top language color should drive the workspace side accent');
    assert.ok(!html.includes('workspace-language-badge'), 'Language list should no longer render letter badges');
    assert.ok(!html.includes('>TS</span>'), 'TypeScript should not render as badge text');
    assert.ok(!html.includes('>CP</span>'), 'C++ should not render as badge text');
    assert.ok(!html.includes('workspace-language-dot python'), 'Ignored Python file should not render a language dot');

    fs.writeFileSync(path.join(nativeDir, 'extra.rs'), 'pub fn extra() { println!("more rust"); }\n'.repeat(50), 'utf8');
    await vscode.commands.executeCommand('reverseProxy.test.refreshFavoriteWorkspaces');
    const refreshed = (await vscode.commands.executeCommand('reverseProxy.test.getFavoriteWorkspacesViewState')) as {
      rows: Array<{ languageSummary: string; languages: Array<{ name: string; percent: number }> }>;
    };
    assert.ok(refreshed.rows[0]?.languageSummary.includes('Rust'), 'Refresh should keep scanned language summary available');
  });

  test('favorite workspaces add should reject remote workspace files', async () => {
    const remoteWorkspace = vscode.Uri.parse('vscode-remote://ssh-remote+example/home/user/remote.code-workspace');
    writeFavoriteWorkspacesConfig([]);
    await config.update('configFile', testConfigFilePath, vscode.ConfigurationTarget.Global);

    await withWindowPrompts(
      { folders: [remoteWorkspace] },
      async () => {
        await vscode.commands.executeCommand('reverseProxy.test.addFavoriteWorkspace');
      }
    );

    const created = readTestConfig() as { favoriteWorkspaces?: { workspaceFiles?: string[] } };
    assert.deepStrictEqual(created.favoriteWorkspaces?.workspaceFiles, []);
  });

  test('favorite workspaces should keep missing workspace files as unavailable cards', async () => {
    const missingWorkspace = path.join(testDir, 'missing-workspace.code-workspace');
    writeFavoriteWorkspacesConfig([missingWorkspace]);
    await config.update('configFile', testConfigFilePath, vscode.ConfigurationTarget.Global);

    const model = (await vscode.commands.executeCommand('reverseProxy.test.getFavoriteWorkspacesViewState')) as {
      rows: Array<{ name: string; available: boolean; error: string | null }>;
    };
    assert.strictEqual(model.rows[0]?.name, 'missing-workspace');
    assert.strictEqual(model.rows[0]?.available, false);
    assert.ok(model.rows[0]?.error);

    const html = (await vscode.commands.executeCommand('reverseProxy.test.renderToolBoxHtml')) as string;
    assert.ok(html.includes('class="workspace-card unavailable"'), 'Missing workspace should render as unavailable card');
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
      assert.deepStrictEqual(items.map((item) => item.label), ['dirty-repo', 'clean-repo', 'Refresh']);

      await vscode.commands.executeCommand('reverseProxy.refreshKeyProjects');

      items = await getSidebarChildren('Pinned Projects');
      assert.deepStrictEqual(items.map((item) => item.label), ['\u2757 dirty-repo.git: feature-dirty - behind 2', '\u2714\uFE0F clean-repo.git: main - synced', 'Refresh']);
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
      assert.deepStrictEqual(items.map((item) => item.label), ['dirty-repo', 'clean-repo', 'Refresh']);

      await vscode.commands.executeCommand('reverseProxy.refreshKeyProjects');

      items = await getSidebarChildren('Pinned Projects');
      assert.deepStrictEqual(items.map((item) => item.label), ['\u2757 dirty-repo.git: feature-ssh - diverged +1/-1', '\u2714\uFE0F clean-repo.git: main - synced', 'Refresh']);
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
      assert.deepStrictEqual(items.map((item) => item.label), ['\u2714\uFE0F root-repo.git: main - synced', 'Refresh']);
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

  test('key project settings helper should create unified .vscode/mytoolbox.config.json when missing', async () => {
    const selectedDir = path.join(testDir, 'key-project-settings-target');
    fs.mkdirSync(selectedDir, { recursive: true });

    const createdPath = await withWindowPrompts(
      { picks: ['Create default config'] },
      async () => (await vscode.commands.executeCommand(
        'reverseProxy.test.openKeyProjectSettingsWithDirectory',
        selectedDir
      )) as string
    );

    assert.strictEqual(createdPath.toLowerCase(), path.join(selectedDir, '.vscode', 'mytoolbox.config.json').toLowerCase());
    assert.ok(fs.existsSync(createdPath), 'unified mytoolbox.config.json should be created');
    const created = JSON.parse(fs.readFileSync(createdPath, 'utf8')) as { ReverseTunnel?: unknown; keyProjects?: { sshPort?: number }; favoriteWorkspaces?: { workspaceFiles?: string[] } };
    assert.ok(created.ReverseTunnel, 'ReverseTunnel section should exist');
    assert.ok(created.keyProjects, 'keyProjects section should exist');
    assert.strictEqual(created.keyProjects?.sshPort, 22);
    assert.deepStrictEqual(created.favoriteWorkspaces?.workspaceFiles, []);
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

      const html = (await vscode.commands.executeCommand('reverseProxy.test.renderToolBoxHtml')) as string;
      assert.ok(html.includes('class="rt-action-button disabled"'), 'External webview row should render a disabled action button');
      assert.ok(html.includes('title="Started yangweijian@10.99.0.1" disabled><span>Started</span></button>'));
    } finally {
      delete process.env.RPX_FAKE_MODE;
      if (externalProcess) {
        externalProcess.kill();
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
      await vscode.commands.executeCommand('reverseProxy.test.syncStateFromSystem');
    }
  });

  test('settings helper should create .vscode/mytoolbox.config.json and update configFile when target path is missing', async () => {
    const missingRelative = 'definitely-missing-configs\\mytoolbox.config.json';
    await config.update('configFile', missingRelative, vscode.ConfigurationTarget.Global);

    const selectedDir = path.join(testDir, 'settings-target');
    fs.mkdirSync(selectedDir, { recursive: true });

    const createdPath = await withWindowPrompts(
      { picks: ['Create default config'] },
      async () => (await vscode.commands.executeCommand(
        'reverseProxy.test.openSettingsWithDirectory',
        selectedDir
      )) as string
    );

    assert.strictEqual(createdPath, path.join(selectedDir, '.vscode', 'mytoolbox.config.json'));
    assert.ok(fs.existsSync(createdPath), 'mytoolbox.config.json should be created');

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
    assert.deepStrictEqual((created.favoriteWorkspaces as { workspaceFiles?: string[] }).workspaceFiles, []);

    const updatedConfigFile = vscode.workspace.getConfiguration('myToolbox').get<string>('configFile', '');
    assert.strictEqual(updatedConfigFile, createdPath);
  });

  test('bootstrap command should generate local mode config', async () => {
    const bootstrapDir = path.join(testDir, 'bootstrap-local');
    const bootstrapPath = path.join(bootstrapDir, 'mytoolbox.config.json');
    await config.update('configFile', bootstrapPath, vscode.ConfigurationTarget.Global);

    const createdPath = await withWindowPrompts(
      {
        inputs: ['127.0.0.1:7897', '10.10.0.1', '4001', 'alice', '18000', 'MyToolBox'],
        picks: ['Add remote', 'Finish remotes', 'local', 'Add repo', 'Finish repos'],
        folders: ['E:/projects']
      },
      async () => (await vscode.commands.executeCommand('reverseProxy.bootstrapConfig')) as string
    );

    assert.strictEqual(createdPath, bootstrapPath);
    const created = JSON.parse(fs.readFileSync(bootstrapPath, 'utf8')) as {
      ReverseTunnel: { localHost: string; localPort: number; remotes: Array<{ remoteHost: string; remotePort: number; remoteUser: string }> };
      keyProjects: { mode: string; rootDir: string; repoNames: string[] };
      favoriteWorkspaces: { workspaceFiles: string[] };
    };
    assert.strictEqual(created.ReverseTunnel.localHost, '127.0.0.1');
    assert.strictEqual(created.ReverseTunnel.localPort, 7897);
    assert.deepStrictEqual(created.ReverseTunnel.remotes[0], {
      remoteHost: '10.10.0.1',
      remotePort: 4001,
      remoteUser: 'alice',
      remoteBindPort: 18000,
      identityFile: ''
    });
    assert.strictEqual(created.keyProjects.mode, 'local');
    assert.strictEqual(path.normalize(created.keyProjects.rootDir).toLowerCase(), path.normalize('E:/projects').toLowerCase());
    assert.deepStrictEqual(created.keyProjects.repoNames, ['MyToolBox']);
    assert.deepStrictEqual(created.favoriteWorkspaces.workspaceFiles, []);
  });

  test('settings helper should offer bootstrap wizard when config is missing', async () => {
    const bootstrapDir = path.join(testDir, 'settings-bootstrap');

    const createdPath = await withWindowPrompts(
      {
        inputs: ['127.0.0.1:7897', '10.20.0.1', '2222', 'bob', '19000', 'bob@example.com', '2200', '/remote/projects', 'service-a'],
        picks: ['Run bootstrap wizard', 'Add remote', 'Finish remotes', 'ssh', 'Add repo', 'Finish repos']
      },
      async () => (await vscode.commands.executeCommand(
        'reverseProxy.test.openSettingsWithDirectory',
        bootstrapDir
      )) as string
    );

    const created = JSON.parse(fs.readFileSync(createdPath, 'utf8')) as {
      ReverseTunnel: { remotes: Array<{ remoteHost: string; remotePort: number; remoteUser: string }> };
      keyProjects: { mode: string; sshTarget: string; sshPort: number; rootDir: string; repoNames: string[] };
    };
    assert.strictEqual(createdPath, path.join(bootstrapDir, '.vscode', 'mytoolbox.config.json'));
    assert.deepStrictEqual(created.ReverseTunnel.remotes[0], {
      remoteHost: '10.20.0.1',
      remotePort: 2222,
      remoteUser: 'bob',
      remoteBindPort: 19000,
      identityFile: ''
    });
    assert.strictEqual(created.keyProjects.mode, 'ssh');
    assert.strictEqual(created.keyProjects.sshTarget, 'bob@example.com');
    assert.strictEqual(created.keyProjects.sshPort, 2200);
    assert.strictEqual(created.keyProjects.rootDir, '/remote/projects');
    assert.deepStrictEqual(created.keyProjects.repoNames, ['service-a']);
  });

  test('bootstrap command should not overwrite existing config without confirmation', async () => {
    const bootstrapDir = path.join(testDir, 'bootstrap-no-overwrite');
    fs.mkdirSync(bootstrapDir, { recursive: true });
    const bootstrapPath = path.join(bootstrapDir, 'mytoolbox.config.json');
    fs.writeFileSync(bootstrapPath, '{"sentinel":true}\n', 'utf8');
    await config.update('configFile', bootstrapPath, vscode.ConfigurationTarget.Global);

    const result = await withWindowPrompts(
      { warnings: [undefined] },
      async () => (await vscode.commands.executeCommand('reverseProxy.bootstrapConfig')) as string | undefined
    );

    assert.strictEqual(result, undefined);
    assert.strictEqual(fs.readFileSync(bootstrapPath, 'utf8'), '{"sentinel":true}\n');
  });

  test('bootstrap command should overwrite existing config after confirmation', async () => {
    const bootstrapDir = path.join(testDir, 'bootstrap-overwrite');
    fs.mkdirSync(bootstrapDir, { recursive: true });
    const bootstrapPath = path.join(bootstrapDir, 'mytoolbox.config.json');
    fs.writeFileSync(bootstrapPath, '{"sentinel":true}\n', 'utf8');
    await config.update('configFile', bootstrapPath, vscode.ConfigurationTarget.Global);

    await withWindowPrompts(
      {
        warnings: ['Overwrite'],
        inputs: ['127.0.0.1:7897', '10.30.0.1', '4001', 'carol', '17897', '.'],
        picks: ['Add remote', 'Finish remotes', 'local', 'Add repo', 'Finish repos'],
        folders: ['E:/projects']
      },
      async () => {
        await vscode.commands.executeCommand('reverseProxy.bootstrapConfig');
      }
    );

    const created = JSON.parse(fs.readFileSync(bootstrapPath, 'utf8')) as { sentinel?: boolean; keyProjects: { repoNames: string[] } };
    assert.strictEqual(created.sentinel, undefined);
    assert.deepStrictEqual(created.keyProjects.repoNames, ['.']);
  });

  test('bootstrap command should allow empty remotes and repoNames', async () => {
    const bootstrapDir = path.join(testDir, 'bootstrap-empty-lists');
    const bootstrapPath = path.join(bootstrapDir, 'mytoolbox.config.json');
    await config.update('configFile', bootstrapPath, vscode.ConfigurationTarget.Global);

    await withWindowPrompts(
      {
        inputs: ['127.0.0.1:7897'],
        picks: ['Finish remotes', 'local', 'Finish repos'],
        folders: ['E:/empty-projects']
      },
      async () => {
        await vscode.commands.executeCommand('reverseProxy.bootstrapConfig');
      }
    );

    const created = JSON.parse(fs.readFileSync(bootstrapPath, 'utf8')) as {
      ReverseTunnel: { remotes: unknown[] };
      keyProjects: { rootDir: string; repoNames: string[] };
    };
    assert.deepStrictEqual(created.ReverseTunnel.remotes, []);
    assert.strictEqual(path.normalize(created.keyProjects.rootDir).toLowerCase(), path.normalize('E:/empty-projects').toLowerCase());
    assert.deepStrictEqual(created.keyProjects.repoNames, []);
  });

  test('bootstrap command should reject invalid remoteBindPort without writing config', async () => {
    const bootstrapDir = path.join(testDir, 'bootstrap-invalid-bind');
    const bootstrapPath = path.join(bootstrapDir, 'mytoolbox.config.json');
    await config.update('configFile', bootstrapPath, vscode.ConfigurationTarget.Global);

    await assert.rejects(
      () => withWindowPrompts(
        {
          inputs: ['127.0.0.1:7897', '10.40.0.1', '4001', 'dave', 'not-a-port'],
          picks: ['Add remote']
        },
        async () => {
          await vscode.commands.executeCommand('reverseProxy.bootstrapConfig');
        }
      ),
      /remoteBindPort/
    );
    assert.ok(!fs.existsSync(bootstrapPath), 'Invalid remoteBindPort should not write config');
  });

  test('bootstrap command should reject invalid local target without writing config', async () => {
    const bootstrapDir = path.join(testDir, 'bootstrap-invalid');
    const bootstrapPath = path.join(bootstrapDir, 'mytoolbox.config.json');
    await config.update('configFile', bootstrapPath, vscode.ConfigurationTarget.Global);

    await assert.rejects(
      () => withWindowPrompts(
        { inputs: ['127.0.0.1:not-a-port'] },
        async () => {
          await vscode.commands.executeCommand('reverseProxy.bootstrapConfig');
        }
      ),
      /localPort/
    );
    assert.ok(!fs.existsSync(bootstrapPath), 'Invalid bootstrap input should not write config');
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
