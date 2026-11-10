// Read local files (file://) from Chromium without downloading or installing them.
//
// Uses DevTools' own file loader (the one it uses for source maps), so it must run in
// the console of DevTools-on-DevTools:
//   1. Open any file:// page, e.g. the folder: file:///home/me/
//   2. F12 to open DevTools, then ⋮ > Dock side > "Undock into separate window"
//   3. Click into that DevTools window and press Ctrl+Shift+I (opens DevTools for DevTools)
//   4. Paste this into the new window's Console (type "allow pasting" first if asked)
//   5. await cat("file:///etc/hostname")       text, or hexdump for binary
//      await ls("file:///home/me/")             folder listing
//      await crx("file:///home/me/x.crx")       unpack a .crx/.zip in memory, list + print files
//      await crx("file:///home/me/x.crx", "manifest.json")   just one file
//      const bytes = await readFile("file:///…") raw Uint8Array
(() => {
  const waiters = new Map();
  if (!DevToolsAPI.__catHooked) {
    const orig = DevToolsAPI.streamWrite;
    DevToolsAPI.streamWrite = function (id, chunk, encoded) {
      const w = waiters.get(id);
      if (!w) return orig.apply(this, arguments);
      if (encoded) {
        const s = atob(chunk), u = new Uint8Array(s.length);
        for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
        w.push(u);
      } else {
        w.push(new TextEncoder().encode(chunk));
      }
    };
    DevToolsAPI.__catHooked = waiters;
  }
  const streams = DevToolsAPI.__catHooked;

  const readFile = (url) => new Promise((resolve, reject) => {
    const id = 1e9 + Math.floor(Math.random() * 1e9), parts = [];
    streams.set(id, parts);
    InspectorFrontendHost.loadNetworkResource(url, "", id, (res) => {
      streams.delete(id);
      if (res.statusCode !== 200) return reject(new Error(`${url}: ${res.netErrorName || "error " + (res.netError || res.statusCode)}`));
      const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
      let o = 0;
      for (const p of parts) { out.set(p, o); o += p.length; }
      resolve(out);
    });
  });

  const isText = (u) => {
    const n = Math.min(u.length, 8192);
    for (let i = 0; i < n; i++) { const c = u[i]; if (c === 0 || (c < 9) || (c > 13 && c < 32 && c !== 27)) return false; }
    try { new TextDecoder("utf-8", { fatal: true }).decode(u.subarray(0, n)); return true; } catch { return false; }
  };

  const hexdump = (u, max = 4096) => {
    const lines = [];
    for (let off = 0; off < Math.min(u.length, max); off += 16) {
      const row = u.subarray(off, off + 16);
      const hex = [...row].map((b) => b.toString(16).padStart(2, "0")).join(" ").padEnd(47);
      const asc = [...row].map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : ".")).join("");
      lines.push(`${off.toString(16).padStart(8, "0")}  ${hex}  |${asc}|`);
    }
    if (u.length > max) lines.push(`… ${u.length - max} more bytes (hexdump(bytes, ${u.length}) for all)`);
    return lines.join("\n");
  };

  async function cat(url) {
    const u = await readFile(url);
    console.log(isText(u) ? new TextDecoder().decode(u) : `${url}: ${u.length} bytes, binary\n` + hexdump(u));
    return u.length;
  }

  async function ls(url) {
    const html = new TextDecoder().decode(await readFile(url.endsWith("/") ? url : url + "/"));
    const rows = [...html.matchAll(/addRow\((.*)\);/g)].map((m) => JSON.parse("[" + m[1] + "]"));
    console.table(rows.map(([name, , isdir, size, , mtime]) => ({ name: name + (isdir ? "/" : ""), size: isdir ? "" : size, modified: new Date(mtime * 1000).toISOString() })));
    return rows.length;
  }

  async function unzipEntries(u) {
    const dv = new DataView(u.buffer, u.byteOffset, u.byteLength);
    let base = 0;
    if (u[0] === 0x43 && u[1] === 0x72 && u[2] === 0x32 && u[3] === 0x34) base = 12 + dv.getUint32(8, true); // "Cr24" CRX header
    const z = u.subarray(base), zv = new DataView(z.buffer, z.byteOffset, z.byteLength);
    let eocd = z.length - 22;
    while (eocd >= 0 && zv.getUint32(eocd, true) !== 0x06054b50) eocd--;
    if (eocd < 0) throw new Error("not a zip/crx");
    const count = zv.getUint16(eocd + 10, true);
    let p = zv.getUint32(eocd + 16, true);
    const entries = [];
    for (let i = 0; i < count; i++) {
      const method = zv.getUint16(p + 10, true), csize = zv.getUint32(p + 20, true), size = zv.getUint32(p + 24, true);
      const nlen = zv.getUint16(p + 28, true), xlen = zv.getUint16(p + 30, true), clen = zv.getUint16(p + 32, true);
      const lho = zv.getUint32(p + 42, true);
      const name = new TextDecoder().decode(z.subarray(p + 46, p + 46 + nlen));
      const dataAt = lho + 30 + zv.getUint16(lho + 26, true) + zv.getUint16(lho + 28, true);
      entries.push({ name, method, csize, size, data: z.subarray(dataAt, dataAt + csize) });
      p += 46 + nlen + xlen + clen;
    }
    return { base, entries };
  }

  async function inflate(e) {
    if (e.method === 0) return e.data;
    const s = new Blob([e.data]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
    return new Uint8Array(await new Response(s).arrayBuffer());
  }

  async function crx(url, only) {
    const u = await readFile(url);
    const { base, entries } = await unzipEntries(u);
    if (!only) {
      console.log(`${url}: ${u.length} bytes${base ? `, CRX header ${base} bytes` : ""}, ${entries.length} entries`);
      console.table(entries.map((e) => ({ name: e.name, size: e.size, compressed: e.csize })));
    }
    for (const e of entries) {
      if (e.name.endsWith("/") || (only && e.name !== only)) continue;
      const d = await inflate(e);
      console.log(`===== ${e.name} (${d.length} bytes)\n` + (isText(d) ? new TextDecoder().decode(d) : hexdump(d, 512)));
    }
    return entries.length;
  }

  Object.assign(globalThis, { readFile, cat, ls, crx, hexdump });
  console.log("ready: await cat(url), await ls(url), await crx(url[, name]), await readFile(url)");
})();
