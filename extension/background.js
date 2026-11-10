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

chrome.action.onClicked.addListener(async (tab) => {
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
});

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

  if (msg?.type === "close" && sender.tab) {
    // Ask the overlay in the top frame to remove itself.
    chrome.tabs
      .sendMessage(sender.tab.id, { type: "term-here:close" }, { frameId: 0 })
      .catch(() => {});
  }
});
