# webshell

A single-page web app that runs a real Linux shell **entirely in your browser**.
Alpine Linux (i686) runs in the [v86](https://github.com/copy/v86) WebAssembly emulator,
with bash, coreutils, grep/sed/awk, vim/nano, less, python3, git, sqlite, ripgrep, fd, jq, make…
There's no server and nothing to install. It works opened straight from disk (`file://`) or from any static host.

## Run

```sh
image/build.sh                 # once: builds the OS image into os/ (needs Docker + Node + Python)
xdg-open index.html            # or: python3 -m http.server, then visit http://localhost:8000
```

The shell is ready in ~3 s: the build boots the VM once and saves a snapshot (`os/state.js`)
that the page restores. Without the snapshot the page cold-boots, which takes about a minute.

## Local files

| | |
| --- | --- |
| **Mount folder…** / drop a folder | mounts it at `/mnt/<name>`. Files are read lazily from disk as the VM touches them. |
| **Save to disk** / `hostsave` | writes the VM's changes (new, modified, deleted files and dirs) back to the real folder, after showing you the list. Edits stay in memory until then. |
| **Upload files…** / drop files | copies files into `/root`. |
| `download <file>` | saves a VM file to your computer. |
| `open <file>` / `open file:///path` | opens a VM file (HTML, image, PDF, text…) in a new tab. `file://` paths refer to the VM's filesystem. |
| `open https://…` | opens a URL in a new tab. |

Mounting with write-back uses the File System Access API (Chrome, Edge, Brave, Opera, also from `file://`).
In Firefox and Safari, **Mount folder…** falls back to a read-only copy.

## Limits

- The VM has no network access.
- Each page load starts fresh. Only mounted folders persist, once you save them.
- It's an emulated 32-bit x86 CPU: fine for shell work, scripting, and git. Heavy builds will be slow.

## How it works

```
index.html, app.js   UI, xterm.js terminal, mounts, save flow
vm-config.js         VM settings shared with the snapshot builder
vendor/              v86 (BSD-2), SeaBIOS (LGPL), xterm.js (MIT)
image/
  Dockerfile         i386 Alpine + tools; busybox init (fast boot); helper commands
  pack.py            rootfs tar -> os/fs.js (9p tree) + os/files/** (one gzip'd chunk per file) + os/boot.js
  build-state.mjs    boots once in Node and saves os/state.js
os/                  generated, git-ignored
```

- **Everything loads with `<script>` tags.** Each payload is a JS file calling `__webshell.*()`.
  That's what lets the page work from `file://`, where `fetch()` is blocked.
- **The root filesystem is v86's in-memory 9p server.** File contents are fetched lazily per file
  (6,500 files, ~143 MB uncompressed, so only what you use is loaded).
- **Mounted host files are 9p inodes whose storage key points at a `FileSystemFileHandle`.**
  When the guest writes a file, v86 copies it into memory, which marks it dirty. *Save* diffs the tree
  against the last-synced state, writes through the handles, and re-points the inodes back at the disk copies.
- **The shell runs on a virtio console**, which supports terminal resize. The serial port carries
  a small control channel (`/sbin/webshell-ctl`) that sets the clock and seeds entropy after a snapshot
  restore, and refreshes 9p caches when mounts change.
- **VM → page requests** (`download`, `open`, `hostsave`) are files dropped into
  `/var/host-outbox`, which the page polls.
