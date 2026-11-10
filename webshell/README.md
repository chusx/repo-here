# webshell

A single-page web app with a real Linux shell **that works on your computer's files**.
Alpine Linux (i686) runs in the browser in the [v86](https://github.com/copy/v86) WebAssembly emulator,
with bash, coreutils, grep/sed/awk, vim/nano, less, python3, git, sqlite, ripgrep, fd, jq, make…
Your filesystem appears inside it, and `file://` paths work with every tool:

```sh
cat file:///etc/hosts
grep -rn TODO file:///home/me/project
cp file:///home/me/report.csv . && python3 analyze.py report.csv
sed -i 's/foo/bar/' file:///home/me/notes.txt      # writes straight to the real file
ls -la /host/home/me                               # /host is the same thing
```

## Host files need the Term Here extension

A web page can't read your files by itself. Browsers forbid it, and that's not something
a page can work around. So host access goes through the [Term Here](../README.md) extension
and its native helper, which runs as your user:

1. Run `./install.sh` from the repo root, then load `extension/` unpacked in Chrome/Edge/Brave.
2. Open webshell. Term Here asks **once per site** whether to allow it. Revoke in the extension's options.
3. To open webshell from `file://`, also enable **Allow access to file URLs** for Term Here.

The header shows the state: *Host files: /host · file:///* when connected. Without the extension,
webshell still works, but only with folders you pick (below).

| | |
| --- | --- |
| `/host/…`, `file:///…` | your whole filesystem (minus `/proc`, `/sys`, `/dev`, `/run`), read/write, as your user. Changes go straight to disk. |
| **Mount folder…** / drop a folder | no extension needed: mounts one picked folder at `/mnt/<name>`. **Save to disk** / `hostsave` writes changes back. |
| **Upload files…** / drop files | copies files into `/root`. |
| `download <file>` | saves a file to your computer through the browser. |
| `open <file\|url>` | opens a file (HTML, image, PDF, text…) or an http(s) URL in a new tab. |

## Run

```sh
image/build.sh                 # once: builds the OS image into os/ (needs Docker + Node + Python)
xdg-open index.html            # or: python3 -m http.server, then visit http://localhost:8000
```

The shell is ready in ~3 s: the build boots the VM once and saves a snapshot (`os/state.js`)
that the page restores. Without the snapshot the page cold-boots, which takes about a minute.

## Limits

- The VM has no network access.
- The VM itself starts fresh on each page load. Changes under `/host` / `file:///` are on your disk.
- It's an emulated 32-bit x86 CPU: fine for shell work, scripting, and git. Heavy builds will be slow.
  Listing is ~5 ms per entry (`ls -l` of a 2,700-file directory takes ~15 s), the same as the VM's own files.
- Hard links, device nodes and FIFOs can't be created under `/host`. Moving between `/host` and the VM's
  own files is a copy + delete, which `mv` does automatically.
- `file:///…` paths resolve anywhere except inside the `/proc`, `/sys`, `/dev` and `/run` mounts.

## How it works

```
index.html, app.js   UI, xterm.js terminal, folder mounts, save flow
hostfs.js            host filesystem: /host and file:/// via the Term Here extension
vm-config.js         VM settings shared with the snapshot builder
vendor/              v86 (BSD-2), SeaBIOS (LGPL), xterm.js (MIT)
image/
  Dockerfile         i386 Alpine + tools; busybox init (fast boot); helper commands
  pack.py            rootfs tar -> os/fs.js (9p tree) + os/files/** (one gzip'd chunk per file) + os/boot.js
  build-state.mjs    boots once in Node and saves os/state.js
os/                  generated, git-ignored
```

- **Host files.** v86 serves the VM's root filesystem over virtio-9p from JavaScript. `hostfs.js` sits in
  front of the 9p request queue and decodes each request. Requests that touch `/host` first do their I/O
  on the real filesystem, through `extension/bridge.js` → the extension → `host/term_here_fs.py`. Examples:
  listing a directory on first lookup, writing data, creating, renaming, deleting, chmod, truncate.
  The request then goes to v86, or fails with the host's error (`Permission denied`, `ENOENT`, …).
  File contents are read lazily in 256 KB windows. The guest mounts with `cache=mmap`, so it doesn't
  cache directory entries or file data, and changes made outside the VM show up immediately.
- **`file:///…`.** Linux collapses repeated slashes, so `file:///etc/hosts` is the relative path
  `file:` + `/etc/hosts`. Lookups of the name `file:` in any directory resolve to a hidden symlink to `/host`.
  So the path works in any program, with no wrappers. `/tmp` is on 9p (not tmpfs) so this works there too.
- **Everything loads with `<script>` tags.** Each payload is a JS file calling `__webshell.*()`.
  That's what lets the page work from `file://`, where `fetch()` is blocked.
- **The root filesystem is v86's in-memory 9p server.** File contents are fetched lazily per file
  (6,500 files, ~143 MB uncompressed, so only what you use is loaded).
- **Picked-folder mounts** are 9p inodes whose storage key points at a `FileSystemFileHandle`.
  Edits stay in memory until *Save* diffs the tree and writes through the handles.
- **The shell runs on a virtio console**, which supports terminal resize. The serial port carries
  a small control channel (`/sbin/webshell-ctl`) that sets the clock and seeds entropy after a snapshot restore.
- **VM → page requests** (`download`, `open`, `hostsave`) are files dropped into
  `/var/host-outbox`, which the page polls.
