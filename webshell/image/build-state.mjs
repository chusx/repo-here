#!/usr/bin/env node
// Boot the packed image once in Node, wait for the shell prompt, and save the
// emulator state to ../os/state.js. The page restores it instead of cold-booting.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const OS = path.join(ROOT, "os");
const { V86 } = require(path.join(ROOT, "vendor/libv86.js"));
const VM = require(path.join(ROOT, "vm-config.js"));

// Payload files look like: __webshell.<fn>(<json>[,<json>]);
const args = (file) => {
  const s = fs.readFileSync(file, "utf8");
  return JSON.parse("[" + s.slice(s.indexOf("(") + 1, s.lastIndexOf(")")) + "]");
};
const b64 = (s) => new Uint8Array(Buffer.from(s, "base64"));

const [bins] = args(path.join(ROOT, "vendor/v86-bins.js"));
const [boot] = args(path.join(OS, "boot.js"));
const [fsJson] = args(path.join(OS, "fs.js"));

const files = new Map();
const storage = {
  async read(key, offset, count) {
    let data = files.get(key);
    if (!data) {
      const [, data64] = args(path.join(OS, "files", key.slice(0, 2), key + ".js"));
      data = new Uint8Array(zlib.gunzipSync(Buffer.from(data64, "base64")));
      files.set(key, data);
    }
    return data.slice(offset, offset + count);
  },
  async cache() {},
  uncache() {},
};

const wasm = b64(bins.wasm);
const emulator = new V86({
  wasm_fn: async (imports) => (await WebAssembly.instantiate(wasm, imports)).instance.exports,
  bios: { buffer: b64(bins.bios).buffer },
  vga_bios: { buffer: b64(bins.vgabios).buffer },
  bzimage: { buffer: b64(boot.kernel).buffer },
  initrd: { buffer: b64(boot.initrd).buffer },
  ...VM,
  filesystem: {},
  virtio_console: true,
  autostart: false,
  disable_keyboard: true,
  disable_mouse: true,
  disable_speaker: true,
});

const t0 = Date.now();
const elapsed = () => ((Date.now() - t0) / 1000).toFixed(1) + "s";
const send = (s) => emulator.bus.send("virtio-console0-input-bytes", new TextEncoder().encode(s));
let out = "";
let phase = "boot";

emulator.add_listener("emulator-loaded", () => {
  emulator.fs9p.storage = storage;
  emulator.fs9p.load_from_json(fsJson);
  emulator.run();
  console.log("booting…");
});

emulator.add_listener("virtio-console0-output-bytes", async (bytes) => {
  out += Buffer.from(bytes).toString("latin1");
  const plain = out.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
  if (phase === "boot" && /webshell:~# $/.test(plain)) {
    phase = "settle";
    console.log(`prompt after ${elapsed()}; warming up and settling…`);
    out = "";
    // Warm the page cache with common tools, then clear the screen.
    send(" (ls --color / >/dev/null; grep -q x /dev/null; python3 -c 1; git --version; vim --version; less --version) >/dev/null 2>&1; sync; clear\r");
  } else if (phase === "settle" && /webshell:~# $/.test(plain)) {
    phase = "save";
    await new Promise((r) => setTimeout(r, 3000));
    const state = new Uint8Array(await emulator.save_state());
    const gz = zlib.gzipSync(state, { level: 9 });
    fs.writeFileSync(path.join(OS, "state.js"), `__webshell.state(${JSON.stringify(gz.toString("base64"))});\n`);
    console.log(`state: ${(state.length / 1e6).toFixed(0)} MB raw, ${(gz.length / 1e6).toFixed(1)} MB gzip (${elapsed()})`);
    await emulator.destroy();
    process.exit(0);
  }
});

setTimeout(() => {
  console.error("timed out; last output:\n" + out.slice(-2000));
  process.exit(1);
}, 10 * 60 * 1000);
