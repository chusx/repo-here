// Term Here — service worker.
//
// Clicking the toolbar button (or pressing Alt+T) injects a small overlay into
// the current tab. The overlay hosts terminal.html in an iframe, which talks to
// the native host (a real PTY shell) over Chrome native messaging.
//
// Because terminal.html is web-accessible, any page could try to frame it. To
// make sure only overlays *we* created get a shell, each overlay receives a
// single-use token that the terminal page must redeem here before it connects.

const TOKEN_TTL_MS = 60_000;

async function issueToken(cwd) {
  const all = await chrome.storage.session.get(null);
  const now = Date.now();
  const stale = Object.keys(all).filter(
    (k) => k.startsWith("tok:") && now - all[k].created > TOKEN_TTL_MS
  );
  if (stale.length) await chrome.storage.session.remove(stale);

  const token = crypto.randomUUID();
  await chrome.storage.session.set({ ["tok:" + token]: { cwd, created: now } });
  return token;
}

async function redeemToken(token) {
  if (typeof token !== "string" || !token) return null;
  const key = "tok:" + token;
  const { [key]: entry } = await chrome.storage.session.get(key);
  if (!entry) return null;
  await chrome.storage.session.remove(key);
  if (Date.now() - entry.created > TOKEN_TTL_MS) return null;
  return entry;
}

// For file:// pages, start the shell in the directory of the open file.
function cwdFromUrl(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== "file:") return null;
    const path = decodeURIComponent(u.pathname);
    return path.endsWith("/") ? path : path.slice(0, path.lastIndexOf("/") + 1) || "/";
  } catch {
    return null;
  }
}

async function openTerminal(tab) {
  const cwd = cwdFromUrl(tab.url);
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["content.js"],
    });
    const token = await issueToken(cwd);
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (t) => globalThis.__termHere.toggle(t),
      args: [token],
    });
  } catch (err) {
    // Pages we can't inject into (chrome://, the Web Store, PDFs, file:// without
    // "Allow access to file URLs"): open the terminal in its own tab instead.
    const token = await issueToken(cwd);
    chrome.tabs.create({
      url: chrome.runtime.getURL("terminal.html") + "#" + token,
      index: tab.index + 1,
      openerTabId: tab.id,
    });
  }
}

chrome.action.onClicked.addListener(openTerminal);

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Only accept messages from our own extension pages (not content scripts).
  const fromExtensionPage =
    sender.id === chrome.runtime.id &&
    typeof sender.url === "string" &&
    sender.url.startsWith("chrome-extension://");
  if (!fromExtensionPage) return;

  if (msg?.type === "claim") {
    redeemToken(msg.token).then((entry) =>
      sendResponse(entry ? { ok: true, cwd: entry.cwd } : { ok: false })
    );
    return true; // async response
  }

  if (msg?.type === "hostfs-approval") {
    settleApproval(msg.key, !!msg.allow);
    return;
  }

  if (msg?.type === "close" && sender.tab) {
    // Ask the overlay in the top frame to remove itself.
    chrome.tabs
      .sendMessage(sender.tab.id, { type: "term-here:close" }, { frameId: 0 })
      .catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// Host filesystem access for webshell pages.
//
// bridge.js (content script) connects a port named "hostfs" when the page asks.
// After the user approves the page's site once, the port is wired to the
// com.termhere.fs native host, which serves the local filesystem.

const FS_HOST = "com.termhere.fs";
const pendingApprovals = new Map(); // site key -> { promise, resolve, windowId }

// Approval is per site: origin + directory of the page (file:// pages: their folder).
function siteKey(url) {
  const u = new URL(url);
  const dir = u.pathname.slice(0, u.pathname.lastIndexOf("/") + 1);
  return (u.protocol === "file:" ? "file://" : u.origin) + dir;
}

async function isApproved(key) {
  const { approvals = {} } = await chrome.storage.local.get("approvals");
  return !!approvals[key];
}

function settleApproval(key, allow) {
  const p = pendingApprovals.get(key);
  if (!p) return;
  pendingApprovals.delete(key);
  p.resolve(allow);
}

function askApproval(key) {
  if (pendingApprovals.has(key)) return pendingApprovals.get(key).promise;
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  const entry = { promise, resolve, windowId: null };
  pendingApprovals.set(key, entry);
  chrome.windows
    .create({
      url: chrome.runtime.getURL("approve.html") + "?site=" + encodeURIComponent(key),
      type: "popup",
      width: 520,
      height: 360,
      focused: true,
    })
    .then((w) => (entry.windowId = w.id))
    .catch(() => settleApproval(key, false));
  return promise;
}

chrome.windows.onRemoved.addListener((windowId) => {
  for (const [key, p] of pendingApprovals) if (p.windowId === windowId) settleApproval(key, false);
});

chrome.runtime.onConnect.addListener(async (port) => {
  if (port.name !== "hostfs") return;
  const s = port.sender;
  if (s?.id !== chrome.runtime.id || !s.tab || s.frameId !== 0 || !s.url) return port.disconnect();

  let alive = true;
  port.onDisconnect.addListener(() => (alive = false));
  const status = (state, message) => alive && port.postMessage({ kind: "status", state, message });

  const key = siteKey(s.url);
  if (!(await isApproved(key))) {
    status("approval", key);
    const ok = await askApproval(key);
    if (!alive) return;
    if (!ok) {
      status("denied", key);
      return port.disconnect();
    }
  }

  const native = chrome.runtime.connectNative(FS_HOST);
  native.onMessage.addListener((res) => alive && port.postMessage({ kind: "res", res }));
  native.onDisconnect.addListener(() => {
    status("error", chrome.runtime.lastError?.message || "filesystem host exited");
    if (alive) port.disconnect();
  });
  port.onMessage.addListener((req) => native.postMessage(req));
  port.onDisconnect.addListener(() => native.disconnect());
  status("ready", key);
});
