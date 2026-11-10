// Term Here — terminal UI. Bridges xterm.js <-> native host (PTY shell).

const HOST_NAME = "com.termhere.shell";
const standalone = window.top === window; // opened in its own tab

const token = location.hash.slice(1);
history.replaceState(null, "", location.pathname); // don't leave the token in the URL

const term = new Terminal({
  cursorBlink: true,
  fontSize: 13,
  fontFamily: 'Menlo, "DejaVu Sans Mono", "Cascadia Mono", Consolas, monospace',
  scrollback: 5000,
  theme: { background: "#1e1e1e", foreground: "#d4d4d4" },
});
const fit = new FitAddon.FitAddon();
term.loadAddon(fit);
term.open(document.getElementById("term"));
fit.fit();
term.focus();
new ResizeObserver(() => fit.fit()).observe(document.getElementById("term"));
window.addEventListener("focus", () => term.focus());

function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function closeSoon() {
  term.write("\r\n\x1b[2m[process exited — press any key to close]\x1b[0m");
  term.onKey(() => {
    if (standalone) window.close();
    else chrome.runtime.sendMessage({ type: "close" });
  });
}

async function main() {
  const claim = await chrome.runtime.sendMessage({ type: "claim", token });
  if (!claim?.ok) {
    term.write("\x1b[31mInvalid or expired terminal session.\x1b[0m\r\n");
    return;
  }

  let exited = false;
  const port = chrome.runtime.connectNative(HOST_NAME);

  port.onMessage.addListener((msg) => {
    switch (msg.type) {
      case "output":
        term.write(b64ToBytes(msg.data));
        break;
      case "exit":
        exited = true;
        closeSoon();
        break;
      case "error":
        term.write(`\r\n\x1b[31m${msg.message}\x1b[0m\r\n`);
        break;
    }
  });

  port.onDisconnect.addListener(() => {
    if (exited) return;
    const err = chrome.runtime.lastError?.message || "Native host disconnected.";
    term.write(`\r\n\x1b[31m${err}\x1b[0m\r\n`);
    if (/not found|forbidden/i.test(err)) {
      term.write(
        "\r\nThe native host isn't installed (or doesn't allow this extension).\r\n" +
          "Run \x1b[1m./install.sh\x1b[0m from the term-here repo, then reload this terminal.\r\n"
      );
    }
  });

  term.onData((data) => port.postMessage({ type: "input", data }));
  term.onBinary((data) => port.postMessage({ type: "input", data, binary: true }));
  term.onResize(({ cols, rows }) => port.postMessage({ type: "resize", cols, rows }));
  term.onTitleChange((title) => {
    if (standalone) document.title = title || "Terminal";
  });

  port.postMessage({ type: "start", cols: term.cols, rows: term.rows, cwd: claim.cwd });
}

main();
