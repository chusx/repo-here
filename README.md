# Term Here

Two ways to get a shell in the browser:

- **Term Here** (this page): a Chromium extension that opens a real shell **on your machine**
  in a terminal overlay on the current page.
- **[webshell](webshell/)**: a single-page app that runs Alpine Linux **inside the browser**
  (WebAssembly). With this extension installed, it works on your computer's files:
  `cat file:///etc/hosts`, `grep -r … file:///home/you/…`, or `/host/…`.

Browser extensions can't start processes or read files on their own, so Term Here has these parts:

| Part | What it does |
| --- | --- |
| `extension/` | MV3 extension: toolbar button / `Alt+T` injects a draggable, resizable terminal window (xterm.js) into the page |
| `host/term_here_host.py` | [Native messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging) host: spawns your login shell on a PTY and relays I/O |
| `host/term_here_fs.py` | Native messaging host that serves your filesystem to webshell (list, read, write, rename…), as your user |

Works on Linux and macOS with Chrome, Chromium, Brave, Edge, Vivaldi (and Arc on macOS). Needs `python3`.

## Install

```sh
./install.sh          # registers both native hosts for every browser found
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
- **webshell:** open it and approve the site when Term Here asks. Your files then appear at
  `/host` and `file:///…` inside webshell. See [webshell/README.md](webshell/README.md).

## Security notes

- This gives a full shell as your user. Only the extension ID in the host manifest can launch it.
- The terminal page is web-accessible so it can be embedded in pages. Every overlay gets a
  single-use, 60-second token from the service worker. The terminal won't connect to the
  native host until it redeems that token, so other pages can't frame it and get a shell.
- The overlay lives in a closed shadow root. The iframe is cross-origin, so page scripts
  can't read the terminal's contents or send it keystrokes.
- The page's own scripts can still see that an overlay element exists and could cover it
  with their own content. Don't type secrets into a terminal on a page you don't trust.
- **File access for webshell** is opt-in per site. `bridge.js` runs only on webshell's own URL,
  `localhost`, and `file://` pages, and stays idle until the page asks. Then Term Here opens a popup
  asking you to allow that site (origin + folder) to read and write all your files. Nothing is connected
  until you click Allow. Approvals are listed, and can be revoked, in the extension's options. An approved
  page has the same file access as your user account, so only approve pages you trust.

## Layout

```
extension/
  manifest.json     MV3 manifest (nativeMessaging, activeTab, scripting, storage)
  background.js     toolbar handler, terminal tokens, webshell file-access approvals
  content.js        overlay window injected into the page
  bridge.js         webshell page <-> extension relay (idle unless the page asks)
  approve.html/js   "allow this site to access your files?" popup
  options.html/js   list/revoke approved sites
  terminal.html/js  xterm.js UI ⇄ native port
  vendor/           xterm.js 6.0.0 + fit addon (MIT)
host/
  term_here_host.py PTY shell bridge (native messaging protocol)
  term_here_fs.py   filesystem service for webshell (native messaging protocol)
install.sh          registers/unregisters the native hosts
```
