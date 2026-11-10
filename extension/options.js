async function render() {
  const { approvals = {} } = await chrome.storage.local.get("approvals");
  const list = document.getElementById("list");
  list.textContent = "";
  const keys = Object.keys(approvals).sort();
  if (!keys.length) {
    list.innerHTML = '<li class="empty">None yet.</li>';
    return;
  }
  for (const key of keys) {
    const li = document.createElement("li");
    const code = document.createElement("code");
    code.textContent = key;
    const btn = document.createElement("button");
    btn.textContent = "Revoke";
    btn.onclick = async () => {
      const { approvals = {} } = await chrome.storage.local.get("approvals");
      delete approvals[key];
      await chrome.storage.local.set({ approvals });
      render();
    };
    li.append(code, btn);
    list.appendChild(li);
  }
}
render();
