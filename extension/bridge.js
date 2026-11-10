// Term Here: relay between a webshell page and the extension's filesystem host.
// Injected into webshell pages, localhost, and file:// pages. It stays idle unless
// the page itself asks for host access, and the background then asks the user to
// approve the site before any file is touched.
(() => {
  let port = null;
  const toPage = (msg) => window.postMessage({ termhere: "to-page", ...msg }, "*");

  window.addEventListener("message", (e) => {
    // Only the page's own window, never iframes.
    if (e.source !== window || !e.data || e.data.termhere !== "to-ext") return;
    const m = e.data;
    if (m.type === "hello") {
      if (port) return;
      port = chrome.runtime.connect({ name: "hostfs" });
      port.onMessage.addListener((msg) => toPage({ type: "msg", msg }));
      port.onDisconnect.addListener(() => {
        port = null;
        toPage({ type: "closed" });
      });
      toPage({ type: "present" });
    } else if (m.type === "req" && port) {
      port.postMessage(m.req);
    }
  });
})();
