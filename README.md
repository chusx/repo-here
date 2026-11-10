# Term Here

A Chromium extension that opens a real shell on your machine in a terminal
overlay on the current page.

Browser extensions can't start processes, so this has two parts:

| Part | What it does |
| --- | --- |
| `extension/` | MV3 extension: toolbar button / `Alt+T` injects a draggable, resizable terminal window (xterm.js) into the page |
| `host/term_here_host.py` | [Native messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging) host: spawns your login shell on a PTY and relays I/O |

Works on Linux and macOS with Chrome, Chromium, Brave, Edge, Vivaldi (and Arc on macOS). Needs `python3`.

## Install

```sh
./install.sh          # registers the native host for every browser found
```

Then open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**,
and pick the `extension/` folder.

The extension ID is pinned by the `key` in `manifest.json` to
`ipldffceopngiolfclkimmjkbgapjnfp`, and the native host only accepts
connections from that ID. If you change or remove the key, run
`./install.sh --extension-id <your-id>`.

Remove with `./install.sh --uninstall`.

## Use

- Click the toolbar button or press **Alt+T** to open the terminal on the current page.
  Press it again to hide/show the same session.
- Drag the title bar to move it; drag the bottom-right corner to resize; □ maximizes.
- **×** closes the window and ends the shell (SIGHUP). Navigating away or closing the tab does the same.
- On `file://` pages the shell starts in the directory of the open file. To use this, enable
  "Allow access to file URLs" for the extension. Otherwise the shell starts in `$HOME`.
- On pages extensions can't modify (`chrome://…`, the Web Store), the terminal opens in a new tab instead.

## Security notes

- This gives a full shell as your user. Only the extension ID in the host manifest can launch it.
- The terminal page is web-accessible so it can be embedded in pages. Every overlay gets a
  single-use, 60-second token from the service worker. The terminal won't connect to the
  native host until it redeems that token, so other pages can't frame it and get a shell.
- The overlay lives in a closed shadow root. The iframe is cross-origin, so page scripts
  can't read the terminal's contents or send it keystrokes.
- The page's own scripts can still see that an overlay element exists and could cover it
  with their own content. Don't type secrets into a terminal on a page you don't trust.

## Layout

```
extension/
  manifest.json     MV3 manifest (nativeMessaging, activeTab, scripting, storage)
  background.js     toolbar handler, token issuing/redeeming
  content.js        overlay window injected into the page
  terminal.html/js  xterm.js UI ⇄ native port
  vendor/           xterm.js 6.0.0 + fit addon (MIT)
host/
  term_here_host.py PTY shell bridge (native messaging protocol)
install.sh          registers/unregisters the native host
```
