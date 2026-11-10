#!/usr/bin/env python3
"""Term Here filesystem host: gives an approved web page (webshell) access to
the local filesystem, as the current user, over Chrome native messaging.

Requests:  {"id": n, "op": "<op>", "path": "/abs/path", ...}
Responses: {"id": n, "ok": true, ...} or {"id": n, "ok": false, "err": "ENOENT"}
           (errno *names*, since numbers differ between Linux and macOS)

Ops:
  list   path                      -> entries: [[name, kind, mode, size, mtime, target], ...]
                                      kind: d=dir f=file l=symlink o=other; sent in
                                      chunks with "more": true until the last one
  stat   path                      -> st: [kind, mode, size, mtime]
  read   path offset count         -> data (base64), regular files only
  write  path offset data(b64)     -> n
  truncate path size
  create path mode                 (O_CREAT|O_TRUNC)
  mkdir  path mode
  unlink path / rmdir path
  rename path dest
  symlink path target
  chmod  path mode
  utime  path atime mtime          (seconds; null = now)
"""

import base64
import errno
import json
import os
import stat
import struct
import sys

STDIN = sys.stdin.fileno()
STDOUT = sys.stdout.fileno()
MAX_READ = 512 * 1024      # base64 of this stays well under Chrome's 1 MB host->browser limit
LIST_CHUNK = 4000          # directory entries per message


def send(msg):
    data = json.dumps(msg, separators=(",", ":")).encode()
    buf = struct.pack("=I", len(data)) + data
    while buf:
        buf = buf[os.write(STDOUT, buf):]


def read_exact(n):
    buf = b""
    while len(buf) < n:
        chunk = os.read(STDIN, n - len(buf))
        if not chunk:
            return None
        buf += chunk
    return buf


def kind_of(mode):
    if stat.S_ISDIR(mode):
        return "d"
    if stat.S_ISREG(mode):
        return "f"
    if stat.S_ISLNK(mode):
        return "l"
    return "o"


def op_list(req):
    path = req["path"]
    entries = []
    with os.scandir(path) as it:
        for e in it:
            try:
                st = e.stat(follow_symlinks=False)
            except OSError:
                continue
            k = kind_of(st.st_mode)
            target = None
            if k == "l":
                try:
                    target = os.readlink(e.path)
                except OSError:
                    target = ""
            entries.append([e.name, k, stat.S_IMODE(st.st_mode), st.st_size, int(st.st_mtime), target])
    # Stream big directories in chunks.
    for i in range(0, max(len(entries), 1), LIST_CHUNK):
        chunk = entries[i:i + LIST_CHUNK]
        more = i + LIST_CHUNK < len(entries)
        send({"id": req["id"], "ok": True, "entries": chunk, "more": more})
    return None


def op_stat(req):
    st = os.lstat(req["path"])
    return {"st": [kind_of(st.st_mode), stat.S_IMODE(st.st_mode), st.st_size, int(st.st_mtime)]}


def op_read(req):
    fd = os.open(req["path"], os.O_RDONLY | os.O_NONBLOCK | getattr(os, "O_CLOEXEC", 0))
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            raise OSError(errno.EINVAL, "not a regular file")
        data = os.pread(fd, min(int(req["count"]), MAX_READ), int(req["offset"]))
    finally:
        os.close(fd)
    return {"data": base64.b64encode(data).decode()}


def op_write(req):
    data = base64.b64decode(req["data"])
    fd = os.open(req["path"], os.O_WRONLY | os.O_CREAT, 0o644)
    try:
        n = os.pwrite(fd, data, int(req["offset"]))
    finally:
        os.close(fd)
    return {"n": n}


def op_truncate(req):
    os.truncate(req["path"], int(req["size"]))


def op_create(req):
    os.close(os.open(req["path"], os.O_WRONLY | os.O_CREAT | os.O_TRUNC, int(req.get("mode", 0o644)) & 0o7777))


def op_mkdir(req):
    os.mkdir(req["path"], int(req.get("mode", 0o755)) & 0o7777)


def op_unlink(req):
    os.unlink(req["path"])


def op_rmdir(req):
    os.rmdir(req["path"])


def op_rename(req):
    os.rename(req["path"], req["dest"])


def op_symlink(req):
    os.symlink(req["target"], req["path"])


def op_chmod(req):
    os.chmod(req["path"], int(req["mode"]) & 0o7777)


def op_utime(req):
    st = os.lstat(req["path"])
    at = req.get("atime")
    mt = req.get("mtime")
    os.utime(req["path"], (st.st_atime if at is None else at, st.st_mtime if mt is None else mt))


OPS = {name[3:]: fn for name, fn in globals().items() if name.startswith("op_")}


def main():
    while True:
        header = read_exact(4)
        if header is None:
            return
        (length,) = struct.unpack("=I", header)
        body = read_exact(length)
        if body is None:
            return
        req = json.loads(body)
        rid = req.get("id")
        fn = OPS.get(req.get("op"))
        try:
            if fn is None:
                raise OSError(errno.ENOSYS, "unknown op")
            if not isinstance(req.get("path"), str) or not req["path"].startswith("/"):
                raise OSError(errno.EINVAL, "path must be absolute")
            res = fn(req)
            if res is not False and not (fn is op_list):
                send({"id": rid, "ok": True, **(res or {})})
        except OSError as e:
            send({"id": rid, "ok": False, "err": errno.errorcode.get(e.errno, "EIO"), "msg": e.strerror or str(e)})
        except Exception as e:  # malformed request
            send({"id": rid, "ok": False, "err": "EINVAL", "msg": str(e)})


if __name__ == "__main__":
    main()
