// Term Here — overlay injected into the current page (isolated world).
// Safe to inject more than once; only the first injection sets things up.
(() => {
  if (globalThis.__termHere) return;

  let host = null; // element attached to the page
  let win = null; // the window frame inside the closed shadow root

  const STYLE = `
    :host { all: initial; }
    .win {
      position: fixed; z-index: 2147483647;
      right: 16px; bottom: 16px;
      width: min(900px, calc(100vw - 32px));
      height: min(520px, calc(100vh - 32px));
      min-width: 320px; min-height: 160px;
      display: flex; flex-direction: column;
      background: #1e1e1e; border: 1px solid #3c3c3c; border-radius: 8px;
      box-shadow: 0 12px 40px rgba(0,0,0,.45);
      overflow: hidden; resize: both;
      font: 12px/1 system-ui, -apple-system, "Segoe UI", sans-serif;
    }
    .win.max { left: 8px !important; top: 8px !important; right: 8px; bottom: 8px;
               width: auto !important; height: auto !important; resize: none; }
    .win.hidden { display: none; }
    .bar {
      flex: none; height: 28px; display: flex; align-items: center; gap: 8px;
      padding: 0 6px 0 12px; background: #2d2d2d; color: #ccc;
      cursor: move; user-select: none;
    }
    .title { flex: 1; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
    button {
      all: unset; width: 22px; height: 22px; border-radius: 4px;
      display: grid; place-items: center; color: #bbb; cursor: pointer; font-size: 14px;
    }
    button:hover { background: #444; color: #fff; }
    button.close:hover { background: #c42b1c; }
    iframe { flex: 1; width: 100%; border: 0; display: block; background: #1e1e1e; }
    .dragging iframe { pointer-events: none; }
  `;

  function open(token) {
    host = document.createElement("term-here-overlay");
    const root = host.attachShadow({ mode: "closed" });
    root.innerHTML = `
      <style>${STYLE}</style>
      <div class="win">
        <div class="bar">
          <span class="title">Terminal</span>
          <button class="hide" title="Hide (Alt+T)">&#8211;</button>
          <button class="max" title="Maximize">&#9633;</button>
          <button class="close" title="Close and end shell">&#10005;</button>
        </div>
      </div>`;
    win = root.querySelector(".win");

    const frame = document.createElement("iframe");
    frame.src = chrome.runtime.getURL("terminal.html") + "#" + token;
    frame.allow = "clipboard-read; clipboard-write";
    win.appendChild(frame);

    root.querySelector(".hide").onclick = () => win.classList.add("hidden");
    root.querySelector(".max").onclick = () => win.classList.toggle("max");
    root.querySelector(".close").onclick = close;
    makeDraggable(win, root.querySelector(".bar"));

    (document.body || document.documentElement).appendChild(host);
    frame.focus();
  }

  function close() {
    host?.remove(); // destroying the iframe disconnects the native port → shell exits
    host = win = null;
  }

  function makeDraggable(el, handle) {
    handle.addEventListener("pointerdown", (e) => {
      if (e.target.closest("button") || el.classList.contains("max")) return;
      const rect = el.getBoundingClientRect();
      const dx = e.clientX - rect.left;
      const dy = e.clientY - rect.top;
      // Switch from right/bottom anchoring to explicit left/top.
      Object.assign(el.style, {
        left: rect.left + "px", top: rect.top + "px", right: "auto", bottom: "auto",
        width: rect.width + "px", height: rect.height + "px",
      });
      el.classList.add("dragging");
      handle.setPointerCapture(e.pointerId);
      const move = (ev) => {
        const x = Math.min(Math.max(ev.clientX - dx, 0), innerWidth - 60);
        const y = Math.min(Math.max(ev.clientY - dy, 0), innerHeight - 28);
        el.style.left = x + "px";
        el.style.top = y + "px";
      };
      const up = () => {
        el.classList.remove("dragging");
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", up);
      };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", up);
    });
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === "term-here:close") close();
  });

  globalThis.__termHere = {
    // Toolbar click: open if absent, otherwise show/hide the existing terminal
    // (keeping the same shell session alive).
    toggle(token) {
      if (!host || !host.isConnected) return open(token);
      win.classList.toggle("hidden");
      if (!win.classList.contains("hidden")) win.querySelector("iframe")?.focus();
    },
  };
})();
