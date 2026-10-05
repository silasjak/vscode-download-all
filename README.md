# Download All

Download every selected file and folder from a remote VS Code workspace with **one** destination prompt instead of one dialog per item.

## The problem

VS Code's built-in **Download…** in the Explorer context menu handles one item at a time: `FileDownload` loops over the selection and opens a save dialog for every single entry, sequentially — the next dialog only appears once the previous transfer has finished. Selecting twelve files means confirming twelve dialogs. Upstream requests for batching this have been in the backlog for years ([vscode-remote-release#5886](https://github.com/microsoft/vscode-remote-release/issues/5886), [#3020](https://github.com/microsoft/vscode-remote-release/issues/3020)).

## What this does

Select several files or folders in the Explorer → right-click → **Download All…** → pick a destination folder once → everything lands there.

- One folder picker for the whole selection
- Transfers run in parallel with progress and cancellation
- Conflicts are handled per item or for the whole batch (overwrite / keep both / skip)
- Selecting a folder together with files inside it does not copy anything twice
- Pure VS Code API: no `rsync`, no SSH keys, no extra tooling — works over Remote-SSH, WSL, Dev Containers and Tunnels alike

**Download All…** appears right below the built-in **Download…** entry, and only when more than one item is selected in a remote window. The built-in entry stays where it is; extensions cannot replace it.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `downloadAll.onConflict` | `prompt` | What to do when a name already exists in the destination: `prompt`, `overwrite`, `skip` or `rename`. |
| `downloadAll.defaultDestination` | `""` | Local folder the dialog opens in, e.g. `~/Downloads`. The previous download's folder wins over this. |
| `downloadAll.concurrency` | `4` | Parallel transfers. Lower it on slow or unstable connections. |

## Limitations

- Desktop only. In VS Code for the Web the built-in download already uses a single directory picker.
- Only reachable from the Explorer context menu: there is no API to read the Explorer selection, so a keybinding or Command Palette entry could not know what is selected ([vscode#316820](https://github.com/microsoft/vscode/issues/316820)).

## Development

```bash
npm install
npm run compile        # or: npm run watch
npm run package        # builds download-all-<version>.vsix
```

Install a local build with `code --install-extension download-all-0.0.1.vsix`, then reload. The extension runs in the local (UI) extension host — that is what makes the destination dialog a native, local folder picker.

## License

MIT
