#!/usr/bin/env python3
"""Pack an exported rootfs tar into the lazily-loaded image used by webshell.

Output (DIR, default ../os):
  fs.js            __webshell.fs({...})        v86 9p filesystem tree (JSONFS v3)
  boot.js          __webshell.boot({...})      kernel + initramfs (base64)
  files/ab/<key>.js __webshell.file(key, b64)  gzip'd file contents, one per unique file

Everything is wrapped in JS so the page can load it with <script> tags. That
works from file:// as well as http(s)://, unlike fetch().
"""

import argparse
import base64
import gzip
import hashlib
import json
import os
import stat
import sys
import tarfile

S_IFLNK, S_IFREG, S_IFDIR = 0xA000, 0x8000, 0x4000
KEY_LEN = 20  # hex chars of sha256 used as the content key


def js_call(fn, *args):
    return f"__webshell.{fn}({','.join(json.dumps(a, separators=(',', ':')) for a in args)});\n"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("tar")
    ap.add_argument("--out", default=os.path.join(os.path.dirname(__file__), "..", "os"))
    ap.add_argument("--kernel", default="boot/vmlinuz-virt")
    ap.add_argument("--initrd", default="boot/initramfs-virt")
    ap.add_argument("--exclude", action="append", default=["boot", ".dockerenv"])
    args = ap.parse_args()

    out = os.path.abspath(args.out)
    os.makedirs(os.path.join(out, "files"), exist_ok=True)
    tar = tarfile.open(args.tar)
    members = tar.getmembers()
    by_name = {m.name.lstrip("./").rstrip("/"): m for m in members}

    # Build the tree.
    root = {"children": {}}
    nodes = {"": root}

    def ensure_dir(path):
        if path in nodes:
            return nodes[path]
        parent = ensure_dir(os.path.dirname(path))
        m = by_name.get(path)
        node = {"name": os.path.basename(path), "children": {},
                "mode": (m.mode if m else 0o755) | S_IFDIR,
                "mtime": int(m.mtime) if m else 0,
                "uid": m.uid if m else 0, "gid": m.gid if m else 0}
        parent["children"][node["name"]] = node
        nodes[path] = node
        return node

    def excluded(path):
        return any(path == e or path.startswith(e + "/") for e in args.exclude)

    written = set(os.path.basename(p)[:-3] for d in os.listdir(os.path.join(out, "files"))
                  for p in os.listdir(os.path.join(out, "files", d)))
    total = new = 0
    content_cache = {}

    def file_key(m):
        nonlocal new
        if m.name in content_cache:
            return content_cache[m.name]
        data = tar.extractfile(m).read()
        key = hashlib.sha256(data).hexdigest()[:KEY_LEN]
        if key not in written:
            d = os.path.join(out, "files", key[:2])
            os.makedirs(d, exist_ok=True)
            b64 = base64.b64encode(gzip.compress(data, 9, mtime=0)).decode()
            with open(os.path.join(d, key + ".js"), "w") as f:
                f.write(js_call("file", key, b64))
            written.add(key)
            new += 1
        content_cache[m.name] = key
        return key

    for m in members:
        path = m.name.lstrip("./").rstrip("/")
        if not path or excluded(path):
            continue
        if m.isdir():
            ensure_dir(path)
            continue
        parent = ensure_dir(os.path.dirname(path))
        entry = {"name": os.path.basename(path), "mtime": int(m.mtime), "uid": m.uid, "gid": m.gid}
        if m.issym():
            entry.update(mode=(m.mode & 0o7777) | S_IFLNK, size=len(m.linkname), target=m.linkname)
        elif m.isfile() or m.islnk():
            src = tar.getmember(m.linkname) if m.islnk() else m
            src = by_name.get(src.name.lstrip("./"), src)
            entry.update(mode=(m.mode & 0o7777) | S_IFREG, size=src.size, key=file_key(src))
            total += src.size
        else:
            continue  # device nodes, fifos: devtmpfs provides /dev
        parent["children"][entry["name"]] = entry

    def to_json(node):
        out = []
        for c in node["children"].values():
            if "children" in c:
                out.append([c["name"], 0, c["mtime"], c["mode"], c["uid"], c["gid"], to_json(c)])
            elif c["mode"] & 0xF000 == S_IFLNK:
                out.append([c["name"], c["size"], c["mtime"], c["mode"], c["uid"], c["gid"], c["target"]])
            else:
                out.append([c["name"], c["size"], c["mtime"], c["mode"], c["uid"], c["gid"], c["key"]])
        return out

    with open(os.path.join(out, "fs.js"), "w") as f:
        f.write(js_call("fs", {"fsroot": to_json(root), "version": 3, "size": total}))

    boot = {}
    for name, path in (("kernel", args.kernel), ("initrd", args.initrd)):
        boot[name] = base64.b64encode(tar.extractfile(by_name[path]).read()).decode()
    with open(os.path.join(out, "boot.js"), "w") as f:
        f.write(js_call("boot", boot))

    print(f"packed {len(written)} unique files ({new} new), {total / 1e6:.1f} MB uncompressed -> {out}",
          file=sys.stderr)


if __name__ == "__main__":
    main()
