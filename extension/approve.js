const key = new URLSearchParams(location.search).get("site") || "";
document.getElementById("site").textContent = key;

async function answer(allow) {
  if (allow && key) {
    const { approvals = {} } = await chrome.storage.local.get("approvals");
    approvals[key] = { at: Date.now() };
    await chrome.storage.local.set({ approvals });
  }
  await chrome.runtime.sendMessage({ type: "hostfs-approval", key, allow }).catch(() => {});
  window.close();
}

document.getElementById("allow").onclick = () => answer(true);
document.getElementById("deny").onclick = () => answer(false);
