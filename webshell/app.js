// webshell — Alpine Linux in the browser (v86), with local folders mounted over 9p.
"use strict";

const $ = (sel) => document.querySelector(sel);
const S_IFMT = 0xf000, S_IFREG = 0x8000, S_IFDIR = 0x4000;
const STATUS_ON_STORAGE = 2;
const OUTBOX = "/var/host-outbox";
const GREETING =
  "\x1b[1mwebshell\x1b[0m — Alpine Linux running in your browser (v86).\r\n" +
  "  Your computer's files: \x1b[36m/host/…\x1b[0m or \x1b[36mfile:///…\x1b[0m  (e.g. cat file:///etc/hosts) — needs the Term Here extension\r\n" +
  "  \x1b[36mdownload\x1b[0m <file>   \x1b[36mopen\x1b[0m <file|url>   copy: select + Ctrl+Shift+C\r\n";

/* ---------------------------------------------------------------- loading ---
 * All payloads are JS files calling __webshell.<fn>(...), so they load with
 * <script> tags. That works from file:// where fetch() is blocked. */

const W = (window.__webshell = {});
const fileWaiters = new Map();
W.file = (key, b64) => fileWaiters.get(key)?.(b64);

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.onload = () => { s.remove(); resolve(); };
    s.onerror = () => { s.remove(); reject(new Error("failed to load " + src)); };
    document.head.appendChild(s);
  });
}

function loadPayload(name, src) {
  return new Promise((resolve, reject) => {
    W[name] = resolve;
    loadScript(src).catch(reject);
  });
}

function b64ToBytes(b64) {
  if (Uint8Array.fromBase64) return Uint8Array.fromBase64(b64);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function gunzip(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/* ---------------------------------------------------------------- storage ---
 * Replaces v86's file storage. Two kinds of keys:
 *   <hex>    rootfs file, lazily loaded from os/files/<xx>/<hex>.js (LRU cached)
 *   host:<n> file on the user's disk (File System Access handle or File) */

const hostFiles = new Map(); // "host:<n>" -> { handle?: FileSystemFileHandle, file?: File }
let hostSeq = 0;
const stats = { files: 0, bytes: 0 };

class WebshellStorage {
  constructor(maxBytes = 192 << 20) {
    this.lru = new Map();
    this.lruBytes = 0;
    this.maxBytes = maxBytes;
    this.inflight = new Map();
  }

  async read(key, offset, count) {
    if (key.startsWith("host:")) return readHostFile(key, offset, count);
    let data = this.lru.get(key);
    if (data) {
      this.lru.delete(key);
      this.lru.set(key, data); // bump
    } else {
      data = await this.load(key);
    }
    // v86 may modify the returned buffer in place (FS.Write), and identical files
    // share a key, so always hand out a copy.
    return data.slice(offset, offset + count);
  }

  load(key) {
    if (this.inflight.has(key)) return this.inflight.get(key);
    const p = new Promise((resolve, reject) => {
      fileWaiters.set(key, resolve);
      loadScript(`os/files/${key.slice(0, 2)}/${key}.js`).catch(reject);
    })
      .then((b64) => gunzip(b64ToBytes(b64)))
      .then((data) => {
        stats.files++;
        stats.bytes += data.length;
        this.lru.set(key, data);
        this.lruBytes += data.length;
        for (const [k, v] of this.lru) {
          if (this.lruBytes <= this.maxBytes || k === key) break;
          this.lru.delete(k);
          this.lruBytes -= v.length;
        }
        return data;
      })
      .finally(() => {
        fileWaiters.delete(key);
        this.inflight.delete(key);
      });
    this.inflight.set(key, p);
    return p;
  }

  async cache() {}
  uncache() {} // keep files in the LRU across open/close
}

async function readHostFile(key, offset, count) {
  const entry = hostFiles.get(key);
  if (!entry) return null;
  // Fresh File each time: a File snapshot goes stale if the file changes on disk.
  const file = entry.handle ? await entry.handle.getFile() : entry.file;
  return new Uint8Array(await file.slice(offset, offset + count).arrayBuffer());
}

function newHostKey(entry) {
  const key = "host:" + ++hostSeq;
  hostFiles.set(key, entry);
  return key;
}

/* --------------------------------------------------------------- terminal --- */

const term = new Terminal({
  cursorBlink: true,
  fontSize: 14,
  fontFamily: 'ui-monospace, Menlo, "DejaVu Sans Mono", "Cascadia Mono", Consolas, monospace',
  scrollback: 10000,
  theme: { background: "#16181d", foreground: "#d7dae0", cursor: "#4fb3ff" },
});
const fit = new FitAddon.FitAddon();
term.loadAddon(fit);
term.open($("#term"));
fit.fit();
term.focus();
new ResizeObserver(() => fit.fit()).observe($("#term"));

// Ctrl+Shift+C copies the selection (Ctrl+C goes to the shell as ^C).
term.attachCustomKeyEventHandler((e) => {
  if (e.type === "keydown" && e.ctrlKey && e.shiftKey && e.code === "KeyC") {
    if (term.hasSelection()) navigator.clipboard?.writeText(term.getSelection());
    return false;
  }
  return true;
});

function setStatus(text, cls = "") {
  const el = $("#status");
  el.textContent = text;
  el.className = cls;
}

function toast(msg, { error = false, action = null, timeout = 6000 } = {}) {
  const el = document.createElement("div");
  el.className = "toast" + (error ? " err" : "");
  const span = document.createElement("span");
  span.className = "msg";
  span.textContent = msg;
  el.appendChild(span);
  if (action) el.appendChild(action);
  const close = document.createElement("button");
  close.textContent = "✕";
  close.onclick = () => el.remove();
  el.appendChild(close);
  $("#toasts").appendChild(el);
  if (timeout) setTimeout(() => el.remove(), timeout);
  return el;
}

/* --------------------------------------------------------------- emulator --- */

let emulator;
let fs; // emulator.fs9p
let shellUp = false;

async function boot() {
  setStatus("Loading emulator…");
  const [bins, bootFiles, fsJson, state64] = await Promise.all([
    loadPayload("bins", "vendor/v86-bins.js"),
    loadPayload("boot", "os/boot.js"),
    loadPayload("fs", "os/fs.js"),
    // Boot snapshot (optional): restores a booted VM in seconds instead of a ~1 min cold boot.
    loadPayload("state", "os/state.js").catch(() => null),
  ]).catch((e) => {
    throw new Error(
      e.message + "\nThe OS image is missing. Build it with webshell/image/build.sh (needs Docker)."
    );
  });
  const state = state64 && (await gunzip(b64ToBytes(state64)));

  const wasm = b64ToBytes(bins.wasm);
  emulator = new V86({
    wasm_fn: async (imports) => (await WebAssembly.instantiate(wasm, imports)).instance.exports,
    bios: { buffer: b64ToBytes(bins.bios).buffer },
    vga_bios: { buffer: b64ToBytes(bins.vgabios).buffer },
    bzimage: { buffer: b64ToBytes(bootFiles.kernel).buffer },
    initrd: { buffer: b64ToBytes(bootFiles.initrd).buffer },
    ...WEBSHELL_VM,
    ...(state && { initial_state: { buffer: state.buffer } }),
    filesystem: {},
    virtio_console: true,
    autostart: false,
    disable_keyboard: true,
    disable_mouse: true,
    disable_speaker: true,
  });

  emulator.add_listener("emulator-loaded", () => {
    fs = emulator.fs9p;
    fs.storage = new WebshellStorage();
    if (state) {
      // Restored VM is already sitting at a prompt; Enter makes bash redraw it.
      emulator.run();
      setStatus("Restoring snapshot…");
      setTimeout(() => emulator.bus.send("virtio-console0-input-bytes", new Uint8Array([13])), 50);
      return;
    }
    fs.load_from_json(fsJson);
    emulator.run();
    setStatus("Booting Linux… (no snapshot; build one with image/build-state.mjs)");
    const t0 = performance.now();
    const progress = setInterval(() => {
      if (shellUp) return clearInterval(progress);
      const s = ((performance.now() - t0) / 1000).toFixed(0);
      setStatus(`Booting Linux… ${s}s · ${stats.files} files (${(stats.bytes / 1e6).toFixed(1)} MB)`);
    }, 250);
  });

  // Kernel/early boot messages arrive on the serial port; show them dimmed until the shell is up.
  const dec = new TextDecoder();
  emulator.add_listener("serial0-output-byte", (b) => {
    if (!shellUp) term.write("\x1b[2m" + dec.decode(new Uint8Array([b]), { stream: true }) + "\x1b[0m");
  });

  // The shell lives on the virtio console (hvc0), which supports window resizing.
  emulator.add_listener("virtio-console0-output-bytes", (bytes) => {
    if (!shellUp) {
      shellUp = true;
      term.reset();
      term.write(GREETING);
      sendResize();
      syncGuest();
      setStatus("Running", "ok");
      startOutboxPolling();
      startHostFS();
    }
    term.write(bytes);
  });
}

// Browser -> guest control channel (serial port, read by /sbin/webshell-ctl).
const ctl = (line) => emulator.serial0_send(line + "\n");

function syncGuest() {
  const seed = Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, "0")).join("");
  ctl("time " + Math.floor(Date.now() / 1000));
  ctl("seed " + seed);
}
// Snapshots freeze the guest clock; also keep it from drifting when the tab is throttled.
setInterval(() => shellUp && ctl("time " + Math.floor(Date.now() / 1000)), 30000);

const enc = new TextEncoder();
const inputQueue = [];
let inputTimer = null;

// The virtio console silently drops input when the guest has no receive buffer
// queued (v86 has no buffering there), which loses data on large pastes. So only
// hand over a chunk when the device's receive queue has room.
function consoleRxReady() {
  const q = emulator.v86?.cpu?.devices?.virtio_console?.virtio?.queues?.[0];
  return q ? q.has_request() : true;
}
function sendBytes(bytes) {
  for (let i = 0; i < bytes.length; i += 256) inputQueue.push(bytes.subarray(i, i + 256));
  if (!inputTimer) pumpInput();
}
function pumpInput() {
  inputTimer = null;
  while (inputQueue.length && consoleRxReady()) {
    emulator.bus.send("virtio-console0-input-bytes", inputQueue.shift());
  }
  if (inputQueue.length) inputTimer = setTimeout(pumpInput, 2);
}
const sendInput = (str) => sendBytes(enc.encode(str));

term.onData((d) => shellUp && sendInput(d));
term.onBinary((d) => shellUp && sendBytes(Uint8Array.from(d, (c) => c.charCodeAt(0) & 0xff)));

function sendResize() {
  emulator?.bus.send("virtio-console0-resize", [term.cols, term.rows]);
}
term.onResize(() => shellUp && sendResize());

/* ------------------------------------------------------- host files --- */

const HOSTFS_HELP = "install.html";
let hostfs = null;

function setHostState(state, detail) {
  const el = $("#hostfs");
  const text = {
    checking: "Host files: connecting…",
    approval: "Host files: approve access in the Term Here popup",
    ready: "Host files: /host  ·  file:///",
    denied: "Host files: denied (click to retry)",
    absent: "Host files: install the Term Here extension",
    error: "Host files: disconnected (click to retry)",
    closed: "Host files: disconnected (click to retry)",
  }[state] || "Host files: " + state;
  el.textContent = text;
  el.className = "hostfs " + state;
  el.title = state === "absent"
    ? "Reading your computer's files needs the Term Here extension + its native host. Click for setup."
    : state === "ready" ? "Your filesystem is at /host; file:///path works as a path in any program." : "";
  el.onclick = state === "absent" ? () => window.open(HOSTFS_HELP, "_blank")
    : ["denied", "error", "closed"].includes(state) ? () => { setHostState("checking"); hostfs.bridge.connect(); } : null;
}

function startHostFS() {
  if (hostfs || !window.HostFS) return;
  setHostState("checking");
  hostfs = HostFS.install(emulator, {
    onState: setHostState,
    onError: (msg) => console.warn(msg),
  });
  hostfs.ready.then((state) => setHostState(state));
}

/* ---------------------------------------------------------- 9p helpers --- */

function lookup(path) {
  const r = fs.SearchPath(path);
  return r.id;
}

function children(dirId) {
  const out = [];
  for (const [name, id] of fs.inodes[dirId].direntries) {
    if (name !== "." && name !== "..") out.push([name, id]);
  }
  return out;
}

const isDir = (id) => (fs.inodes[id].mode & S_IFMT) === S_IFDIR;
const isFile = (id) => (fs.inodes[id].mode & S_IFMT) === S_IFREG;

function uniqueName(dirId, base) {
  base = base.replace(/[\/\0]/g, "_") || "folder";
  let name = base;
  for (let i = 2; fs.Search(dirId, name) !== -1; i++) name = `${base}-${i}`;
  return name;
}

/** Add a host-backed file (contents read lazily from disk). */
function addHostFile(parentId, name, entry, size, lastModified) {
  const id = fs.CreateFile(name, parentId);
  const inode = fs.inodes[id];
  inode.mode = S_IFREG | 0o644;
  inode.status = STATUS_ON_STORAGE;
  inode.sha256sum = newHostKey(entry);
  inode.size = size;
  inode.mtime = inode.ctime = inode.atime = Math.floor(lastModified / 1000);
  return { id, key: inode.sha256sum };
}

function addDir(parentId, name) {
  const id = fs.CreateDirectory(name, parentId);
  fs.inodes[id].mode = S_IFDIR | 0o755;
  return id;
}

/* ----------------------------------------------------------------- mounts ---
 * A mounted folder becomes /mnt/<name> in the VM. Files are read lazily from
 * disk. Changes stay in memory until "Save to disk" (or `hostsave` in the VM). */

const mounts = new Map(); // name -> Mount

class Mount {
  constructor(name, rootId, dirHandle) {
    this.name = name;
    this.rootId = rootId;
    this.dirHandle = dirHandle; // null => read-only (no File System Access API)
    this.baseFiles = new Map(); // relPath -> host key it had when last synced
    this.baseDirs = new Set(); // relPaths of directories when last synced
  }
  get path() { return "/mnt/" + this.name; }

  /** Walk the VM tree under the mount. */
  scan() {
    const files = new Map(), dirs = new Set(), skipped = [];
    const walk = (dirId, rel) => {
      for (const [name, id] of children(dirId)) {
        const p = rel ? rel + "/" + name : name;
        if (isDir(id)) { dirs.add(p); walk(id, p); }
        else if (isFile(id)) files.set(p, id);
        else skipped.push(p);
      }
    };
    walk(this.rootId, "");
    return { files, dirs, skipped };
  }

  /** Compute what differs between the VM copy and what's on disk. */
  diff() {
    const { files, dirs, skipped } = this.scan();
    const changes = { write: [], newDirs: [], delFiles: [], delDirs: [], skipped };
    for (const [p, id] of files) {
      const inode = fs.inodes[id];
      const clean = inode.status === STATUS_ON_STORAGE && this.baseFiles.get(p) === inode.sha256sum;
      if (!clean) changes.write.push({ path: p, id, isNew: !this.baseFiles.has(p) });
    }
    for (const p of this.baseFiles.keys()) if (!files.has(p)) changes.delFiles.push(p);
    for (const d of dirs) if (!this.baseDirs.has(d)) changes.newDirs.push(d);
    for (const d of this.baseDirs) if (!dirs.has(d)) changes.delDirs.push(d);
    changes.newDirs.sort((a, b) => a.length - b.length); // parents first
    changes.delDirs.sort((a, b) => b.length - a.length); // children first
    changes.count = changes.write.length + changes.delFiles.length + changes.newDirs.length + changes.delDirs.length;
    return changes;
  }

  async dirHandleFor(relDir, create = false) {
    let h = this.dirHandle;
    for (const part of relDir ? relDir.split("/") : []) h = await h.getDirectoryHandle(part, { create });
    return h;
  }

  async apply(changes) {
    const split = (p) => [p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "", p.slice(p.lastIndexOf("/") + 1)];
    const ignoreMissing = (e) => { if (e.name !== "NotFoundError") throw e; };

    for (const p of changes.delFiles) {
      const [dir, name] = split(p);
      await (await this.dirHandleFor(dir)).removeEntry(name).catch(ignoreMissing);
      this.baseFiles.delete(p);
    }
    for (const p of changes.delDirs) {
      const [dir, name] = split(p);
      await (await this.dirHandleFor(dir).catch(() => null))?.removeEntry(name, { recursive: true }).catch(ignoreMissing);
      this.baseDirs.delete(p);
    }
    for (const p of changes.newDirs) {
      await this.dirHandleFor(p, true);
      this.baseDirs.add(p);
    }
    for (const { path: p, id } of changes.write) {
      const inode = fs.inodes[id];
      const data = (await fs.Read(id, 0, inode.size)) || new Uint8Array(0);
      const [dir, name] = split(p);
      const handle = await (await this.dirHandleFor(dir, true)).getFileHandle(name, { create: true });
      const w = await handle.createWritable();
      await w.write(data.slice(0, inode.size));
      await w.close();
      // Point the VM file back at the disk copy and drop the in-memory buffer.
      if (fs.inodes[id] === inode && inode.size === data.length) {
        inode.status = STATUS_ON_STORAGE;
        inode.sha256sum = newHostKey({ handle });
        delete fs.inodedata[id];
        this.baseFiles.set(p, inode.sha256sum);
      } else {
        this.baseFiles.set(p, null); // changed again meanwhile: stays dirty
      }
    }
  }
}

async function mountDirectoryHandle(dirHandle) {
  const name = uniqueName(lookup("/mnt"), dirHandle.name);
  const rootId = addDir(lookup("/mnt"), name);
  const m = new Mount(name, rootId, dirHandle);
  mounts.set(name, m);
  renderMounts();

  let count = 0;
  const walk = async (dh, dirId, rel) => {
    for await (const [entryName, h] of dh.entries()) {
      const p = rel ? rel + "/" + entryName : entryName;
      if (h.kind === "directory") {
        m.baseDirs.add(p);
        await walk(h, addDir(dirId, entryName), p);
      } else {
        const f = await h.getFile();
        const { key } = addHostFile(dirId, entryName, { handle: h }, f.size, f.lastModified);
        m.baseFiles.set(p, key);
      }
      if (++count % 500 === 0) setStatus(`Mounting ${m.path}… ${count} entries`);
    }
  };
  try {
    await walk(dirHandle, rootId, "");
  } finally {
    setStatus("Running", "ok");
  }
  ctl("drop");
  toast(`Mounted ${dirHandle.name} at ${m.path} (${count} entries)`);
  renderMounts();
  term.focus();
}

/** Fallback for browsers without showDirectoryPicker: read-only copy from <input webkitdirectory>. */
function mountFileList(files) {
  if (!files.length) return;
  const top = files[0].webkitRelativePath.split("/")[0] || "folder";
  const name = uniqueName(lookup("/mnt"), top);
  const rootId = addDir(lookup("/mnt"), name);
  const m = new Mount(name, rootId, null);
  const dirIds = new Map([["", rootId]]);
  const ensureDir = (rel) => {
    if (dirIds.has(rel)) return dirIds.get(rel);
    const parent = ensureDir(rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "");
    const id = addDir(parent, rel.slice(rel.lastIndexOf("/") + 1));
    dirIds.set(rel, id);
    return id;
  };
  for (const f of files) {
    const rel = f.webkitRelativePath.split("/").slice(1).join("/");
    const dir = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
    addHostFile(ensureDir(dir), rel.slice(rel.lastIndexOf("/") + 1), { file: f }, f.size, f.lastModified);
  }
  mounts.set(name, m);
  ctl("drop");
  toast(`Mounted ${top} read-only at ${m.path} (${files.length} files).\nThis browser can't write back to disk.`);
  renderMounts();
}

function copyFilesIn(files, dest = "/root") {
  const dirId = lookup(dest);
  const names = [];
  for (const f of files) {
    const name = uniqueName(dirId, f.name);
    addHostFile(dirId, name, { file: f }, f.size, f.lastModified);
    names.push(name);
  }
  if (names.length) toast(`Copied into ${dest}: ${names.join(", ")}`);
}

function unmount(name) {
  const m = mounts.get(name);
  if (!m) return;
  if (m.dirHandle && m.diff().count && !confirm(`${m.path} has unsaved changes. Unmount and discard them?`)) return;
  fs.RecursiveDelete(m.path);
  fs.Unlink(lookup("/mnt"), name);
  mounts.delete(name);
  ctl("drop");
  renderMounts();
}

function renderMounts() {
  const box = $("#mounts");
  box.textContent = "";
  let anyDirty = false;
  for (const m of mounts.values()) {
    const el = document.createElement("span");
    el.className = "mount";
    const code = document.createElement("code");
    code.textContent = m.path;
    el.appendChild(code);
    const info = document.createElement("span");
    if (!m.dirHandle) { info.className = "ro"; info.textContent = "read-only"; }
    else {
      const n = m.diff().count;
      if (n) { info.className = "dirty"; info.textContent = `${n} unsaved`; anyDirty = true; }
    }
    el.appendChild(info);
    const x = document.createElement("button");
    x.textContent = "Unmount";
    x.onclick = () => unmount(m.name);
    el.appendChild(x);
    box.appendChild(el);
  }
  $("#btn-save").disabled = !anyDirty;
}
setInterval(() => fs && mounts.size && renderMounts(), 1500);

/* -------------------------------------------------------------- save flow --- */

let saving = false;
async function saveAll() {
  if (saving) return;
  const work = [...mounts.values()].filter((m) => m.dirHandle).map((m) => [m, m.diff()]).filter(([, d]) => d.count);
  if (!work.length) return toast("No unsaved changes in mounted folders.");

  const lines = [];
  for (const [m, d] of work) {
    lines.push(`${m.path}  →  ${m.dirHandle.name}/`);
    for (const p of d.newDirs) lines.push(`  <span class="add">+ ${esc(p)}/</span>`);
    for (const w of d.write) lines.push(`  <span class="${w.isNew ? "add" : "mod"}">${w.isNew ? "+" : "~"} ${esc(w.path)}</span>`);
    for (const p of d.delFiles) lines.push(`  <span class="del">- ${esc(p)}</span>`);
    for (const p of d.delDirs) lines.push(`  <span class="del">- ${esc(p)}/</span>`);
    for (const p of d.skipped) lines.push(`  (skipped, not a regular file: ${esc(p)})`);
  }
  $("#save-list").innerHTML = lines.join("\n");
  const dlg = $("#save-dialog");
  const ok = await new Promise((resolve) => {
    $("#save-ok").onclick = () => { dlg.close(); resolve(true); };
    $("#save-cancel").onclick = () => { dlg.close(); resolve(false); };
    dlg.oncancel = () => resolve(false);
    dlg.showModal();
  });
  term.focus();
  if (!ok) return;

  saving = true;
  try {
    for (const [m, d] of work) {
      if ((await m.dirHandle.requestPermission({ mode: "readwrite" })) !== "granted") {
        toast(`No write permission for ${m.dirHandle.name}`, { error: true });
        continue;
      }
      await m.apply(d);
    }
    toast("Saved changes to disk.");
  } catch (e) {
    toast("Save failed: " + e.message, { error: true, timeout: 0 });
  } finally {
    saving = false;
    renderMounts();
  }
}

const esc = (s) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);

/* ----------------------------------------------------------------- outbox ---
 * VM -> browser requests: guest scripts (download, open, hostsave) drop files
 * named <ts>.<action>.<name> into /var/host-outbox. */

const MIME = {
  html: "text/html", htm: "text/html", svg: "image/svg+xml", png: "image/png", jpg: "image/jpeg",
  jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", pdf: "application/pdf", json: "application/json",
  txt: "text/plain", md: "text/plain", csv: "text/plain", log: "text/plain", mp4: "video/mp4", mp3: "audio/mpeg",
};

function startOutboxPolling() {
  setInterval(async () => {
    const dirId = lookup(OUTBOX);
    if (dirId === -1) return;
    for (const [name] of children(dirId)) {
      if (name.startsWith(".")) continue;
      const m = name.match(/^\d+\.(\w+)\.(.*)$/);
      const path = OUTBOX + "/" + name;
      // read_file gives null for empty files (e.g. hostsave's request).
      const data = m && ((await emulator.read_file(path).catch(() => null)) ?? new Uint8Array(0));
      fs.Unlink(dirId, name); // (v86's DeleteNode is broken for existing paths: SearchPath returns name undefined)
      if (m) handleOutbox(m[1], m[2], data);
    }
  }, 400);
}

function handleOutbox(action, name, data) {
  if (action === "hostsave") return saveAll();
  if (action === "openurl") {
    const url = new TextDecoder().decode(data).trim();
    if (!/^https?:\/\//i.test(url)) return toast("open: only http(s) URLs can be opened", { error: true });
    return openOrOffer(url, url);
  }
  const ext = name.split(".").pop().toLowerCase();
  const blob = new Blob([data], { type: action === "open" ? MIME[ext] || "text/plain" : "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  setTimeout(() => URL.revokeObjectURL(url), 10 * 60 * 1000);
  if (action === "download") {
    const a = Object.assign(document.createElement("a"), { href: url, download: name });
    a.click();
    toast(`Downloaded ${name}`);
  } else if (action === "open") {
    openOrOffer(url, name);
  }
}

// Popup blockers stop window.open() outside a click, so fall back to a link.
function openOrOffer(url, label) {
  if (window.open(url, "_blank")) return;
  const a = Object.assign(document.createElement("a"), { href: url, target: "_blank", textContent: "Open" });
  const t = toast(`Ready to open ${label}`, { action: a, timeout: 0 });
  a.onclick = () => setTimeout(() => t.remove(), 0);
}

/* ------------------------------------------------------------ UI wiring --- */

$("#btn-save").onclick = saveAll;

$("#btn-mount").onclick = async () => {
  if (!shellUp) return toast("Wait for Linux to finish booting.");
  if (window.showDirectoryPicker) {
    try {
      await mountDirectoryHandle(await showDirectoryPicker({ mode: "readwrite" }));
    } catch (e) {
      if (e.name !== "AbortError") toast("Mount failed: " + e.message, { error: true });
    }
  } else {
    $("#pick-dir").click();
  }
};
$("#pick-dir").onchange = (e) => { mountFileList([...e.target.files]); e.target.value = ""; };

$("#btn-upload").onclick = () => (shellUp ? $("#pick-files").click() : toast("Wait for Linux to finish booting."));
$("#pick-files").onchange = (e) => { copyFilesIn([...e.target.files]); e.target.value = ""; };

let dragDepth = 0;
addEventListener("dragenter", (e) => { e.preventDefault(); if (++dragDepth === 1) document.body.classList.add("dragging"); });
addEventListener("dragleave", () => { if (--dragDepth === 0) document.body.classList.remove("dragging"); });
addEventListener("dragover", (e) => e.preventDefault());
addEventListener("drop", async (e) => {
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove("dragging");
  if (!shellUp) return toast("Wait for Linux to finish booting.");
  // Grab every handle synchronously: the item list is cleared after the event.
  const items = [...e.dataTransfer.items].filter((i) => i.kind === "file");
  const handles = items.map((i) => i.getAsFileSystemHandle?.() ?? null);
  const plainFiles = items.map((i) => i.getAsFile());
  const loose = [];
  for (let i = 0; i < items.length; i++) {
    const h = await handles[i]?.catch(() => null);
    if (h?.kind === "directory") await mountDirectoryHandle(h).catch((err) => toast("Mount failed: " + err.message, { error: true }));
    else if (h?.kind === "file") loose.push(await h.getFile());
    else if (plainFiles[i]) loose.push(plainFiles[i]);
  }
  copyFilesIn(loose);
});

addEventListener("beforeunload", (e) => {
  if ([...mounts.values()].some((m) => m.dirHandle && m.diff().count)) e.preventDefault();
});

// Test/automation hook.
W.api = { get emulator() { return emulator; }, get hostfs() { return hostfs; }, mountDirectoryHandle, saveAll, mounts, term, get shellUp() { return shellUp; } };

boot().catch((e) => {
  setStatus("Failed to start", "bad");
  term.write("\x1b[31m" + String(e.message || e).replace(/\n/g, "\r\n") + "\x1b[0m\r\n");
  console.error(e);
});
