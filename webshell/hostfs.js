// webshell: the host computer's filesystem inside the VM, through the Term Here extension.
//
//   /host/...         your real filesystem (read/write, as your user)
//   file:///path      works as a path for every program: a lookup of "file:" in any
//                     directory resolves to a hidden symlink to /host, and Linux
//                     collapses the remaining slashes ("file:///etc/hosts" ->
//                     file: + /etc/hosts -> /host/etc/hosts)
//
// How: v86 serves the VM's root filesystem over virtio-9p from JS. Its request
// handler is synchronous for path lookups, but host data has to be fetched
// asynchronously through the extension. So we sit in front of the 9p request
// queue: each request is decoded, and requests that touch /host first do their
// host I/O (list a directory, write a file, rename, ...). Then they're either
// handed to v86, which sees an up-to-date tree, or answered with the host's error.
"use strict";

window.HostFS = (() => {
  const S_IFMT = 0xf000, S_IFREG = 0x8000, S_IFDIR = 0x4000, S_IFLNK = 0xa000;
  const STATUS_ON_STORAGE = 2;
  const STALE_MS = 1500; // re-list a host directory when it's opened again after this long
  const WINDOW = 256 * 1024; // host read-ahead window
  const SKIP_AT_ROOT = new Set(["proc", "sys", "dev", "run"]);
  const ERRNO = {
    EPERM: 1, ENOENT: 2, EIO: 5, EBADF: 9, EAGAIN: 11, ENOMEM: 12, EACCES: 13, EBUSY: 16,
    EEXIST: 17, EXDEV: 18, ENOTDIR: 20, EISDIR: 21, EINVAL: 22, ETXTBSY: 26, EFBIG: 27,
    ENOSPC: 28, EROFS: 30, EMLINK: 31, ENAMETOOLONG: 36, ENOSYS: 38, ENOTEMPTY: 39,
    ELOOP: 40, EOPNOTSUPP: 95, EDQUOT: 122,
  };

  /* ------------------------------------------------- extension bridge --- */

  class Bridge {
    constructor(onState) {
      this.seq = 0;
      this.calls = new Map();
      this.onState = onState;
      this.ready = null;
      addEventListener("message", (e) => this.onMessage(e));
    }

    post(msg) {
      window.postMessage({ termhere: "to-ext", ...msg }, "*");
    }

    /** Resolves to "ready" | "denied" | "absent" | "error". */
    connect() {
      this.ready = new Promise((resolve) => {
        this.settle = resolve;
        this.presentTimer = setTimeout(() => resolve("absent"), 1500);
      });
      this.post({ type: "hello" });
      return this.ready;
    }

    onMessage(e) {
      if (e.source !== window || !e.data || e.data.termhere !== "to-page") return;
      const d = e.data;
      if (d.type === "present") {
        clearTimeout(this.presentTimer);
      } else if (d.type === "closed") {
        for (const c of this.calls.values()) c.reject(Object.assign(new Error("host connection closed"), { errno: ERRNO.EIO }));
        this.calls.clear();
        this.settle?.("error");
        this.onState("closed");
      } else if (d.type === "msg") {
        const m = d.msg;
        if (m.kind === "status") {
          this.onState(m.state, m.message);
          if (m.state !== "approval") this.settle?.(m.state);
        } else if (m.kind === "res") {
          const c = this.calls.get(m.res.id);
          if (!c) return;
          const r = m.res;
          if (!r.ok) {
            this.calls.delete(r.id);
            c.reject(Object.assign(new Error(`${r.err}: ${r.msg || ""}`), { errno: ERRNO[r.err] || ERRNO.EIO }));
          } else if (r.entries) {
            c.entries.push(...r.entries);
            if (!r.more) { this.calls.delete(r.id); c.resolve(c.entries); }
          } else {
            this.calls.delete(r.id);
            c.resolve(r);
          }
        }
      }
    }

    call(op, args) {
      return new Promise((resolve, reject) => {
        const id = ++this.seq;
        this.calls.set(id, { resolve, reject, entries: [] });
        this.post({ type: "req", req: { id, op, ...args } });
      });
    }
  }

  const b64 = (bytes) => {
    if (bytes.toBase64) return bytes.toBase64();
    let s = "";
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  };
  const unb64 = (s) => {
    if (Uint8Array.fromBase64) return Uint8Array.fromBase64(s);
    const bin = atob(s), out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  };

  /* ------------------------------------------------------ 9p decoding --- */

  class Reader {
    constructor(buf) { this.v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength); this.o = 0; this.buf = buf; }
    u8() { return this.v.getUint8(this.o++); }
    u16() { const x = this.v.getUint16(this.o, true); this.o += 2; return x; }
    u32() { const x = this.v.getUint32(this.o, true); this.o += 4; return x; }
    u64() { const lo = this.u32(), hi = this.u32(); return hi * 0x100000000 + lo; }
    str() { const n = this.u16(); const s = new TextDecoder().decode(this.buf.subarray(this.o, this.o + n)); this.o += n; return s; }
    bytes(n) { const b = this.buf.subarray(this.o, this.o + n); this.o += n; return b; }
  }

  /* ---------------------------------------------------------- install --- */

  /**
   * @param emulator  V86 instance (booted)
   * @param onState   (state, detail) => void   UI status updates
   * @returns { ready: Promise<string> }
   */
  function install(emulator, { onState = () => {}, onError = () => {} } = {}) {
    const fs = emulator.fs9p;
    const dev = emulator.v86.cpu.devices.virtio_9p;
    const bridge = new Bridge(onState);

    const hostPath = new Map(); // inode id -> absolute host path ("/" = /host)
    const loadedAt = new Map(); // host dir inode id -> time of last listing
    const loading = new Map(); // host dir inode id -> Promise
    const readCache = new Map(); // host file inode id -> { offset, data }
    const checkedAt = new Map(); // host file inode id -> when size/mtime were last fetched
    const parentOf = new Map(); // host inode id -> its directory's inode id
    let hostRoot = -1;
    let ghost = -1; // the hidden "file:" -> /host symlink
    let walking = false;
    const stats = { delivered: 0, held: 0, failed: 0, inflight: new Map() }; // for debugging

    const join = (dir, name) => (dir === "/" ? "/" + name : dir + "/" + name);
    const ifmt = (id) => fs.inodes[id] && fs.inodes[id].mode & S_IFMT;
    const isHost = (id) => hostPath.has(id);
    const isHostDir = (id) => isHost(id) && ifmt(id) === S_IFDIR;
    const isHostFile = (id) => isHost(id) && ifmt(id) === S_IFREG;
    const fidInode = (fid) => (dev.fids[fid] ? dev.fids[fid].inodeid : -1);
    const toGuestTarget = (t) => (t.startsWith("/") ? "/host" + t : t);
    const toHostTarget = (t) => (t === "/host" ? "/" : t.startsWith("/host/") ? t.slice(5) : t);

    /* ----- bookkeeping wrappers around v86's FS (no host I/O here) ----- */

    const orig = {};
    for (const m of ["Search", "CreateFile", "CreateDirectory", "CreateSymlink", "Write", "ChangeSize", "Rename", "Unlink"]) {
      orig[m] = fs[m].bind(fs);
    }

    fs.Search = (parentid, name) => {
      const r = orig.Search(parentid, name);
      return r === -1 && walking && name === "file:" && ghost !== -1 ? ghost : r;
    };
    fs.CreateFile = (name, parentid) => {
      const id = orig.CreateFile(name, parentid);
      if (isHost(parentid)) {
        hostPath.set(id, join(hostPath.get(parentid), name));
        parentOf.set(id, parentid);
        const ino = fs.inodes[id];
        ino.status = STATUS_ON_STORAGE;
        ino.sha256sum = "hostfs:" + id;
        ino.size = 0;
      }
      return id;
    };
    fs.CreateDirectory = (name, parentid) => {
      const id = orig.CreateDirectory(name, parentid);
      if (isHost(parentid)) {
        hostPath.set(id, join(hostPath.get(parentid), name));
        parentOf.set(id, parentid);
        loadedAt.set(id, Date.now()); // created by the guest: empty and known
      }
      return id;
    };
    fs.CreateSymlink = (name, parentid, target) => {
      const id = orig.CreateSymlink(name, parentid, target);
      if (isHost(parentid)) {
        hostPath.set(id, join(hostPath.get(parentid), name));
        parentOf.set(id, parentid);
      }
      return id;
    };
    fs.Write = async (id, offset, count, buffer) => {
      if (!isHostFile(id)) return orig.Write(id, offset, count, buffer);
      const ino = fs.inodes[id]; // data already written to disk in prepare()
      ino.size = Math.max(ino.size, offset + count);
      ino.mtime = Math.floor(Date.now() / 1000);
      readCache.delete(id);
    };
    fs.ChangeSize = async (id, size) => {
      if (!isHostFile(id)) return orig.ChangeSize(id, size);
      fs.inodes[id].size = size; // truncated on disk in prepare()
      readCache.delete(id);
    };
    fs.Rename = async (olddirid, oldname, newdirid, newname) => {
      const moved = orig.Search(olddirid, oldname);
      const from = hostPath.get(moved);
      const ret = await orig.Rename(olddirid, oldname, newdirid, newname);
      if (ret === 0 && from !== undefined && isHost(newdirid)) {
        parentOf.set(moved, newdirid);
        const to = join(hostPath.get(newdirid), newname);
        for (const [id, p] of hostPath) {
          if (p === from || p.startsWith(from + "/")) hostPath.set(id, to + p.slice(from.length));
        }
      }
      return ret;
    };
    fs.Unlink = (parentid, name) => {
      const id = orig.Search(parentid, name);
      const ret = orig.Unlink(parentid, name);
      if (ret === 0 && id !== -1 && isHost(id)) { // no hard links in the host tree
        hostPath.delete(id);
        loadedAt.delete(id);
        readCache.delete(id);
        checkedAt.delete(id);
        parentOf.delete(id);
      }
      return ret;
    };

    /* ----- file contents: v86 storage keys "hostfs:<inode id>" ----- */

    async function fetchWindow(id, offset) {
      const path = hostPath.get(id);
      const start = offset - (offset % 4096);
      const r = await bridge.call("read", { path, offset: start, count: WINDOW });
      const w = { offset: start, data: unb64(r.data) };
      readCache.set(id, w);
      return w;
    }

    const storage = fs.storage;
    const origRead = storage.read.bind(storage);
    storage.read = async (key, offset, count, size) => {
      if (!key.startsWith("hostfs:")) return origRead(key, offset, count, size);
      const id = +key.slice(7);
      const out = new Uint8Array(count); // v86 expects exactly `count` bytes
      try {
        let pos = offset;
        while (pos < offset + count) {
          let w = readCache.get(id);
          if (!w || pos < w.offset || pos >= w.offset + w.data.length) w = await fetchWindow(id, pos);
          if (pos >= w.offset + w.data.length) break; // EOF on host (file shrank)
          const chunk = w.data.subarray(pos - w.offset, Math.min(w.data.length, offset + count - w.offset));
          out.set(chunk, pos - offset);
          pos += chunk.length;
        }
      } catch (e) {
        onError(`read ${hostPath.get(id)}: ${e.message}`);
      }
      return out;
    };

    /* ----- directory listings ----- */

    function removeChild(parentid, name, id) {
      if (ifmt(id) === S_IFDIR) {
        for (const [n, cid] of [...fs.inodes[id].direntries]) if (n !== "." && n !== "..") removeChild(id, n, cid);
      }
      fs.Unlink(parentid, name);
    }

    function applyListing(id, path, entries) {
      const seen = new Set();
      for (const [name, kind, mode, size, mtime, target] of entries) {
        if ((path === "/" && SKIP_AT_ROOT.has(name)) || kind === "o") continue;
        seen.add(name);
        const want = kind === "d" ? S_IFDIR : kind === "l" ? S_IFLNK : S_IFREG;
        let cid = orig.Search(id, name);
        if (cid !== -1 && ifmt(cid) !== want) {
          removeChild(id, name, cid);
          cid = -1;
        }
        if (cid === -1) {
          if (kind === "d") {
            cid = fs.CreateDirectory(name, id);
            loadedAt.delete(cid); // contents not fetched yet
          } else if (kind === "l") {
            cid = fs.CreateSymlink(name, id, toGuestTarget(target || ""));
          } else {
            cid = fs.CreateFile(name, id);
          }
        }
        const ino = fs.inodes[cid];
        ino.mode = want | mode;
        ino.uid = ino.gid = 0;
        if (kind === "f" && ino.status === STATUS_ON_STORAGE && (ino.size !== size || ino.mtime !== mtime)) {
          readCache.delete(cid);
          ino.size = size;
        }
        if (kind === "f") checkedAt.set(cid, Date.now());
        if (kind === "l") { ino.symlink = toGuestTarget(target || ""); ino.size = ino.symlink.length; }
        ino.mtime = ino.ctime = mtime;
      }
      for (const [name, cid] of [...fs.inodes[id].direntries]) {
        if (name !== "." && name !== ".." && !seen.has(name)) removeChild(id, name, cid);
      }
    }

    function loadDir(id) {
      if (loading.has(id)) return loading.get(id);
      const path = hostPath.get(id);
      const p = bridge
        .call("list", { path })
        .then((entries) => {
          if (hostPath.get(id) !== path || ifmt(id) !== S_IFDIR) return; // moved/removed meanwhile
          applyListing(id, path, entries);
          loadedAt.set(id, Date.now());
        })
        .finally(() => loading.delete(id));
      loading.set(id, p);
      return p;
    }

    const isStale = (id) => !loadedAt.has(id) || Date.now() - loadedAt.get(id) > STALE_MS;

    async function refreshFile(id) {
      const r = await bridge.call("stat", { path: hostPath.get(id) });
      const [, mode, size, mtime] = r.st;
      const ino = fs.inodes[id];
      if (ino.size !== size || ino.mtime !== mtime) readCache.delete(id);
      ino.size = size;
      ino.mtime = mtime;
      ino.mode = S_IFREG | mode;
      checkedAt.set(id, Date.now());
    }

    /* ----- request interception ----- */

    // Returns null (hand to v86 now) or a Promise (do host I/O first; reject with .errno to fail).
    function prepare(type, r) {
      switch (type) {
        case 110: { // Twalk
          const fid = r.u32(); r.u32();
          const names = Array.from({ length: r.u16() }, () => r.str());
          let id = fidInode(fid);
          for (let i = 0; i < names.length; i++) {
            if (isHostDir(id) && (!loadedAt.has(id) || (orig.Search(id, names[i]) === -1 && isStale(id)))) {
              return (async () => {
                for (let j = i; j < names.length; j++) {
                  if (isHostDir(id) && (!loadedAt.has(id) || (orig.Search(id, names[j]) === -1 && isStale(id)))) {
                    try { await loadDir(id); } catch (e) { if (j === 0) throw e; return; }
                  }
                  id = orig.Search(id, names[j]);
                  if (id === -1) return;
                }
              })();
            }
            id = orig.Search(id, names[i]);
            if (id === -1) break;
          }
          return null;
        }
        case 12: { // Tlopen
          const id = fidInode(r.u32());
          if (isHostDir(id) && isStale(id)) return loadDir(id);
          if (isHostFile(id)) return refreshFile(id);
          return null;
        }
        case 24: { // Tgetattr: the kernel sizes reads from this, so keep host files current.
          // Re-list the parent (one call refreshes every sibling, e.g. during `ls -l`).
          const id = fidInode(r.u32());
          if (!isHostFile(id) || Date.now() - (checkedAt.get(id) || 0) <= STALE_MS) return null;
          const dir = parentOf.get(id);
          return dir !== undefined && isHostDir(dir) ? loadDir(dir).catch(() => refreshFile(id)) : refreshFile(id);
        }
        case 40: { // Treaddir
          const id = fidInode(r.u32());
          return isHostDir(id) && !loadedAt.has(id) ? loadDir(id) : null;
        }
        case 116: { // Tread: fetch up front so host errors become proper 9p errors
          const id = fidInode(r.u32());
          if (!isHostFile(id)) return null;
          const offset = r.u64();
          const w = readCache.get(id);
          if (offset >= fs.inodes[id].size || (w && offset >= w.offset && offset < w.offset + w.data.length)) return null;
          return fetchWindow(id, offset);
        }
        case 118: { // Twrite
          const id = fidInode(r.u32());
          if (!isHostFile(id)) return null;
          const offset = r.u64();
          const data = r.bytes(r.u32());
          return bridge.call("write", { path: hostPath.get(id), offset, data: b64(data) });
        }
        case 14: { // Tlcreate
          const dir = fidInode(r.u32());
          if (!isHostDir(dir)) return null;
          const name = r.str(); r.u32();
          const mode = r.u32();
          return bridge.call("create", { path: join(hostPath.get(dir), name), mode: mode & 0o7777 });
        }
        case 72: { // Tmkdir
          const dir = fidInode(r.u32());
          if (!isHostDir(dir)) return null;
          const name = r.str();
          return bridge.call("mkdir", { path: join(hostPath.get(dir), name), mode: r.u32() & 0o7777 });
        }
        case 16: { // Tsymlink
          const dir = fidInode(r.u32());
          if (!isHostDir(dir)) return null;
          const name = r.str();
          return bridge.call("symlink", { path: join(hostPath.get(dir), name), target: toHostTarget(r.str()) });
        }
        case 18: // Tmknod
          return isHostDir(fidInode(r.u32())) ? Promise.reject({ errno: ERRNO.EPERM }) : null;
        case 70: { // Tlink (hard links on the host aren't supported)
          const a = fidInode(r.u32()), b = fidInode(r.u32());
          return isHost(a) || isHost(b) ? Promise.reject({ errno: isHost(a) && isHost(b) ? ERRNO.EPERM : ERRNO.EXDEV }) : null;
        }
        case 74: { // Trenameat
          const od = fidInode(r.u32()); const on = r.str();
          const nd = fidInode(r.u32()); const nn = r.str();
          return renameOp(od, on, nd, nn);
        }
        case 20: { // Trename
          const src = fidInode(r.u32()); const nd = fidInode(r.u32()); const nn = r.str();
          if (!isHost(src) && !isHost(nd)) return null;
          if (isHost(src) !== isHost(nd)) return Promise.reject({ errno: ERRNO.EXDEV });
          return bridge.call("rename", { path: hostPath.get(src), dest: join(hostPath.get(nd), nn) });
        }
        case 76: { // Tunlinkat
          const dir = fidInode(r.u32());
          if (!isHostDir(dir)) return null;
          const name = r.str();
          const id = orig.Search(dir, name);
          if (id === -1) return null; // v86 answers ENOENT
          return bridge.call(ifmt(id) === S_IFDIR ? "rmdir" : "unlink", { path: join(hostPath.get(dir), name) });
        }
        case 26: { // Tsetattr
          const id = fidInode(r.u32());
          if (!isHost(id)) return null;
          const valid = r.u32(), mode = r.u32(); r.u32(); r.u32();
          const size = r.u64(), atime = r.u64(); r.u64(); const mtime = r.u64();
          const path = hostPath.get(id);
          return (async () => {
            if (valid & 0x1) await bridge.call("chmod", { path, mode: mode & 0o7777 });
            if (valid & 0x8) await bridge.call("truncate", { path, size });
            if (valid & 0x30) {
              await bridge.call("utime", {
                path,
                atime: valid & 0x10 ? (valid & 0x80 ? atime : null) : undefined,
                mtime: valid & 0x20 ? (valid & 0x100 ? mtime : null) : undefined,
              });
            }
          })();
        }
      }
      return null;
    }

    function renameOp(od, on, nd, nn) {
      const a = isHost(od), b = isHost(nd);
      if (!a && !b) return null;
      if (a !== b) return Promise.reject({ errno: ERRNO.EXDEV }); // mv falls back to copy + delete
      return bridge.call("rename", { path: join(hostPath.get(od), on), dest: join(hostPath.get(nd), nn) });
    }

    function deliver(bc, type) {
      stats.delivered++;
      walking = type === 110; // only Twalk lookups see the "file:" alias
      try {
        dev.ReceiveRequest(bc).catch((e) => onError("9p: " + e.message));
      } finally {
        walking = false;
      }
    }

    function handle(bc) {
      // Peek at the request without consuming it.
      const buf = new Uint8Array(bc.length_readable);
      bc.get_next_blob(buf);
      bc.read_buffer_idx = 0;
      bc.read_buffer_offset = 0;
      const r = new Reader(buf);
      r.u32();
      const type = r.u8();
      const tag = r.u16();

      let pending = null;
      if (hostRoot !== -1) {
        try {
          pending = prepare(type, r);
        } catch (e) {
          onError("hostfs: " + e.message);
        }
      }
      if (!pending) return deliver(bc, type);
      stats.held++;
      stats.inflight.set(tag, type);
      pending.then(
        () => { stats.inflight.delete(tag); deliver(bc, type); },
        (e) => {
          stats.inflight.delete(tag);
          stats.failed++;
          dev.SendError(tag, "", e.errno || ERRNO.EIO);
          dev.SendReply(bc);
        }
      );
    }

    const queue = dev.virtio.queues[0];
    const hasRequest = queue.has_request.bind(queue);
    const popRequest = queue.pop_request.bind(queue);
    // v86's notify handler loops `while (has_request()) receive(pop_request())`.
    // We drain and dispatch ourselves, so the loop always sees an empty queue.
    // (pop_request itself calls has_request, so internal calls get the real answer.)
    let draining = false;
    queue.has_request = () => {
      if (draining) return hasRequest();
      draining = true;
      try {
        while (hasRequest()) handle(popRequest());
      } finally {
        draining = false;
      }
      return false;
    };

    /* ----- connect ----- */

    const ready = bridge.connect().then((state) => {
      if (state !== "ready") return state;
      const rootDir = 0;
      if (orig.Search(rootDir, "host") === -1) hostRoot = orig.CreateDirectory("host", rootDir);
      else hostRoot = orig.Search(rootDir, "host");
      fs.inodes[hostRoot].mode = S_IFDIR | 0o755;
      hostPath.set(hostRoot, "/");
      let hidden = orig.Search(rootDir, ".webshell");
      if (hidden === -1) hidden = orig.CreateDirectory(".webshell", rootDir);
      ghost = orig.CreateSymlink("file:", hidden, "/host");
      return state;
    });

    return { ready, bridge, stats };
  }

  return { install };
})();
