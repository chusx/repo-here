#!/usr/bin/env python3
"""Term Here native messaging host.

Chrome starts this process when the extension calls connectNative(). It spawns
the user's shell on a pseudo-terminal and relays bytes between the PTY and the
extension using the native messaging protocol (32-bit native-endian length
prefix + UTF-8 JSON) on stdin/stdout.

Messages from the extension:
  {"type": "start",  "cols": int, "rows": int, "cwd": str|null}
  {"type": "input",  "data": str, "binary": bool?}
  {"type": "resize", "cols": int, "rows": int}

Messages to the extension:
  {"type": "output", "data": <base64 bytes>}
  {"type": "exit",   "code": int}
  {"type": "error",  "message": str}

When Chrome closes the port (overlay closed, tab navigated) stdin hits EOF and
the shell's process group gets SIGHUP.
"""

import base64
import errno
import fcntl
import json
import os
import pty
import pwd
import select
import signal
import struct
import sys
import termios

STDIN = sys.stdin.fileno()
STDOUT = sys.stdout.fileno()
READ_CHUNK = 64 * 1024  # base64 of this stays far below Chrome's 1 MB limit


def send(msg):
    data = json.dumps(msg).encode()
    buf = struct.pack("=I", len(data)) + data
    while buf:
        n = os.write(STDOUT, buf)
        buf = buf[n:]


class MessageReader:
    def __init__(self):
        self.buf = b""

    def feed(self, chunk):
        self.buf += chunk
        msgs = []
        while len(self.buf) >= 4:
            (length,) = struct.unpack("=I", self.buf[:4])
            if len(self.buf) < 4 + length:
                break
            msgs.append(json.loads(self.buf[4 : 4 + length]))
            self.buf = self.buf[4 + length :]
        return msgs


def set_winsize(fd, rows, cols):
    rows = max(1, min(int(rows), 1000))
    cols = max(1, min(int(cols), 1000))
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))


def user_shell():
    shell = os.environ.get("SHELL")
    if not shell or not os.access(shell, os.X_OK):
        try:
            shell = pwd.getpwuid(os.getuid()).pw_shell
        except KeyError:
            shell = None
    return shell if shell and os.access(shell, os.X_OK) else "/bin/sh"


def spawn(cols, rows, cwd):
    shell = user_shell()
    home = os.path.expanduser("~")
    pid, fd = pty.fork()
    if pid == 0:  # child: stdin/stdout/stderr are the PTY slave
        try:
            set_winsize(0, rows, cols)
            os.chdir(cwd if cwd and os.path.isdir(cwd) else home)
        except Exception:
            pass
        env = dict(os.environ)
        env.update(TERM="xterm-256color", COLORTERM="truecolor", TERM_PROGRAM="term-here")
        # Leading "-" in argv[0] makes it a login shell (loads the user's profile).
        os.execve(shell, ["-" + os.path.basename(shell)], env)
    return pid, fd


def wait_for_start(reader):
    while True:
        chunk = os.read(STDIN, READ_CHUNK)
        if not chunk:
            sys.exit(0)
        for msg in reader.feed(chunk):
            if msg.get("type") == "start":
                return msg


def main():
    signal.signal(signal.SIGPIPE, signal.SIG_DFL)
    reader = MessageReader()
    start = wait_for_start(reader)
    pid, fd = spawn(start.get("cols", 80), start.get("rows", 24), start.get("cwd"))

    def handle(msg):
        kind = msg.get("type")
        if kind == "input":
            data = msg.get("data", "")
            raw = data.encode("latin-1", "replace") if msg.get("binary") else data.encode("utf-8", "replace")
            while raw:
                raw = raw[os.write(fd, raw):]
        elif kind == "resize":
            set_winsize(fd, msg.get("rows", 24), msg.get("cols", 80))

    browser_open = True
    while True:
        try:
            readable, _, _ = select.select([STDIN, fd], [], [])
        except InterruptedError:
            continue

        if fd in readable:
            try:
                out = os.read(fd, READ_CHUNK)
            except OSError as e:
                if e.errno != errno.EIO:
                    raise
                out = b""
            if not out:  # shell exited
                break
            send({"type": "output", "data": base64.b64encode(out).decode()})

        if STDIN in readable:
            chunk = os.read(STDIN, READ_CHUNK)
            if not chunk:  # extension closed the port
                browser_open = False
                break
            for msg in reader.feed(chunk):
                handle(msg)

    try:
        os.killpg(pid, signal.SIGHUP)
    except ProcessLookupError:
        pass
    _, status = os.waitpid(pid, 0)
    if browser_open:
        send({"type": "exit", "code": os.waitstatus_to_exitcode(status)})


if __name__ == "__main__":
    try:
        main()
    except Exception as e:  # surface failures in the terminal instead of a silent disconnect
        try:
            send({"type": "error", "message": f"term-here host error: {e}"})
        except Exception:
            pass
        raise
