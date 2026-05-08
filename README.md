# CodeOps Panel

[![MIT licensed][mit-badge]][mit-url]
[![Build Status][actions-badge]][actions-url]

<p align="center">
  <img src="media/Icon1.png" alt="CodeOps Panel icon" width="128" height="128">
</p>

CodeOps Panel is a VS Code sidebar dashboard for local development operations. It keeps reverse SSH tunnels, important Git repositories, and favorite workspace files in one compact panel.

## Screenshot

<p align="center">
  <img src="media/screenshot.png" alt="CodeOps Panel dashboard screenshot">
</p>

## Features

- **Reverse Tunnel Proxies**: start and stop configured SSH reverse tunnels from the sidebar.
- **Pinned Projects**: refresh local or SSH-hosted Git repositories and inspect branch, sync, and working tree status.
- **Favorite Workspaces**: save `.code-workspace` files and reopen them in a new VS Code window.
- **Unified configuration**: use one JSON file for tunnels, pinned projects, and favorite workspaces.
- **Bootstrap wizard**: create an initial configuration through VS Code prompts.

## Quick Start

1. Install CodeOps Panel.
2. Open the `CodeOps Panel` activity bar view.
3. Click `Bootstrap` to create a configuration file, or click `Settings` to open the configured file.
4. Use `Start`, `Stop`, `Refresh`, and `Add` from the sidebar panel.

The default configuration path is `.vscode/mytoolbox.config.json`. You can override it with the VS Code setting `myToolbox.configFile`. For per-workspace configs, use:

```json
"myToolbox.configFile": "${workspaceFolder}/.vscode/mytoolbox.config.json"
```

## Configuration

CodeOps Panel uses a single JSON file with three top-level sections. `myToolbox.configFile` accepts absolute paths, relative paths, and `${workspaceFolder}`:

- `${workspaceFolder}/.vscode/mytoolbox.config.json` resolves to the current workspace folder.
- Relative paths such as `.vscode/mytoolbox.config.json` also resolve from the current workspace folder when a workspace is open.
- In Remote SSH windows, workspace-relative paths are read and written through VS Code's workspace filesystem, so the config file lives in the remote workspace.
- There is no built-in fallback config. If the target file does not exist, use `Settings` or `Bootstrap` to create it.

Example config:

```json
{
  "ReverseTunnel": {
    "sshPath": "ssh",
    "connectionReadyDelayMs": 1200,
    "localHost": "127.0.0.1",
    "localPort": 7897,
    "remotes": [
      {
        "remoteHost": "example.com",
        "remotePort": 22,
        "remoteUser": "user",
        "remoteBindPort": 17897,
        "identityFile": ""
      }
    ]
  },
  "keyProjects": {
    "mode": "local",
    "rootDir": "E:/projects",
    "repoNames": ["my-repo"],
    "sshTarget": "",
    "sshPort": 22,
    "gitPath": "git",
    "sshPath": "ssh"
  },
  "favoriteWorkspaces": {
    "workspaceFiles": []
  }
}
```

### UI Host Mode

CodeOps Panel runs as a VS Code UI extension. In local windows this is the same machine as the workspace. In Remote SSH windows, the webview can read and write workspace-relative config files through VS Code, but helper processes are still started from the local UI Host:

- Reverse tunnel `ssh` processes use the local `ReverseTunnel.sshPath`.
- Pinned Projects `local` mode runs local `gitPath` against a local `rootDir`.
- Pinned Projects `ssh` mode runs local `sshPath` against `sshTarget`, then runs Git on that remote target.

Use `keyProjects.mode: "ssh"` for remote project status when the opened workspace is remote or when repositories live on another host.

### Reverse Tunnel Proxies

Each remote maps to an SSH reverse tunnel equivalent to:

```bash
ssh -N -p 22 -R 17897:127.0.0.1:7897 user@example.com
```

The extension checks that the local `ssh` command is available before starting a tunnel. Tunnels started outside the extension may be shown as already running, but CodeOps Panel will not stop external tunnels.

### Pinned Projects

Pinned Projects can run in `local` or `ssh` mode.

- `local`: checks repositories under `rootDir` on the local UI Host.
- `ssh`: runs local SSH against `sshTarget` and checks repositories under `rootDir` on that remote host.

Refresh runs Git status checks and shows clean/dirty state plus upstream sync labels such as `synced`, `ahead`, `behind`, `diverged`, and `no upstream`.

### Favorite Workspaces

Use `Add` to select a `.code-workspace` file. The card opens that workspace in a new VS Code window. Add/remove writes the `favoriteWorkspaces.workspaceFiles` list back to the configured ToolBox JSON file. Relative paths configured by hand are resolved from the configuration file directory.

## Troubleshooting

- If Git status is unavailable, confirm that `rootDir` and `repoNames` point to real Git repositories.
- If SSH mode fails, confirm that `sshPath` works locally, `sshTarget` is reachable, and Git is installed on the remote host.
- If a tunnel fails to start, check whether the remote bind port is already in use and whether `localHost:localPort` is reachable.
- If the settings file does not open, confirm the `myToolbox.configFile` path. Use `${workspaceFolder}/.vscode/mytoolbox.config.json` when each workspace should own its own config.

## Limitations

- CodeOps Panel only stops reverse tunnels that it started.
- SSH project refresh depends on a working remote shell and Git installation.
- The configuration file can contain private hosts and local paths; keep personal configs out of source control when needed.

## Chinese Documentation

See `readme-cn.md` for Chinese usage documentation.

[mit-badge]: https://img.shields.io/badge/license-MIT-blue.svg
[mit-url]: LICENSE
[actions-badge]: https://github.com/linkensphere201/CodeOps-Panel/actions/workflows/ci.yml/badge.svg
[actions-url]: https://github.com/linkensphere201/CodeOps-Panel/actions/workflows/ci.yml

