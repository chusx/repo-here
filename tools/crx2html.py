#!/usr/bin/env python3
"""Turn a .crx (or .zip) into a static, self-contained HTML file you can open via file://.

Chromium downloads binaries and tries to install .crx files, and a locked-down browser
(no DevTools, extensions, file pickers or flags) can't read them. Plain HTML it will
display, even with JavaScript off. So convert the .crx somewhere normal and put the
.html next to it:

    tools/crx2html.py term-here.crx            # writes term-here.crx.html
    tools/crx2html.py term-here.crx -o out.html

The page shows: CRX header (version, extension ID, key, signature check), the file list,
every text file's contents, hexdumps of binary files, and a hexdump of the .crx itself.
No JavaScript, no external resources.
"""

import argparse
import hashlib
import html
import io
import os
import struct
import subprocess
import sys
import tempfile
import zipfile

MAX_HEX = 64 * 1024  # bytes of hexdump per binary entry


def varint(b, i):
    x = s = 0
    while True:
        c = b[i]
        i += 1
        x |= (c & 0x7F) << s
        s += 7
        if c < 0x80:
            return x, i


def proto_fields(b):
    i, out = 0, []
    while i < len(b):
        key, i = varint(b, i)
        num, wt = key >> 3, key & 7
        if wt == 0:
            v, i = varint(b, i)
        elif wt == 2:
            n, i = varint(b, i)
            v = b[i:i + n]
            i += n
        else:
            raise ValueError("unsupported protobuf wire type %d" % wt)
        out.append((num, v))
    return out


def ext_id(pubkey_der):
    h = hashlib.sha256(pubkey_der).hexdigest()[:32]
    return "".join(chr(ord("a") + int(c, 16)) for c in h)


def verify(pub, sig, msg):
    """RSA-SHA256 check with openssl, if available."""
    try:
        with tempfile.TemporaryDirectory() as d:
            for name, data in (("pub.der", pub), ("sig", sig), ("msg", msg)):
                with open(os.path.join(d, name), "wb") as f:
                    f.write(data)
            subprocess.run(["openssl", "pkey", "-pubin", "-inform", "DER", "-in", d + "/pub.der", "-out", d + "/pub.pem"],
                           check=True, capture_output=True)
            r = subprocess.run(["openssl", "dgst", "-sha256", "-verify", d + "/pub.pem", "-signature", d + "/sig", d + "/msg"],
                               capture_output=True, text=True)
            return "valid" if r.returncode == 0 else "INVALID"
    except Exception:
        return "not checked (openssl unavailable)"


def parse_crx(data):
    """Returns (info rows, zip bytes)."""
    if data[:4] != b"Cr24":
        return [("Format", "not a CRX: shown as a plain zip")], data
    version, hlen = struct.unpack("<II", data[4:12])
    if version != 3:
        return [("Format", "CRX version %d (only v3 headers are decoded)" % version)], data[12 + hlen:]
    header, archive = data[12:12 + hlen], data[12 + hlen:]
    fields = proto_fields(header)
    signed = next((v for n, v in fields if n == 10000), b"")
    crx_id = dict(proto_fields(signed)).get(1, b"") if signed else b""
    rows = [("Format", "CRX3"), ("Header size", "%d bytes" % hlen), ("Zip size", "%d bytes" % len(archive))]
    if crx_id:
        rows.append(("Declared ID", "".join(chr(ord("a") + int(c, 16)) for c in crx_id.hex()[:32])))
    msg = b"CRX3 SignedData\x00" + struct.pack("<I", len(signed)) + signed + archive
    for kind, name in ((2, "RSA-SHA256"), (3, "ECDSA-SHA256")):
        for n, v in fields:
            if n != kind:
                continue
            proof = dict(proto_fields(v))
            pub, sig = proof.get(1, b""), proof.get(2, b"")
            line = "key → ID %s" % ext_id(pub)
            if kind == 2:
                line += ", signature %s" % verify(pub, sig, msg)
            rows.append((name + " proof", line))
    if not any(n == 2 or n == 3 for n, _ in fields):
        rows.append(("Proofs", "none"))
    return rows, archive


def is_text(b):
    if b"\x00" in b[:8192]:
        return False
    try:
        b.decode("utf-8")
        return True
    except UnicodeDecodeError:
        return False


def hexdump(b, limit=MAX_HEX):
    out = []
    for off in range(0, min(len(b), limit), 16):
        row = b[off:off + 16]
        hx = " ".join("%02x" % c for c in row).ljust(47)
        asc = "".join(chr(c) if 32 <= c < 127 else "." for c in row)
        out.append("%08x  %s  |%s|" % (off, hx, asc))
    if len(b) > limit:
        out.append("… %d more bytes not shown" % (len(b) - limit))
    return "\n".join(out)


def render(path, data):
    rows, archive = parse_crx(data)
    e = html.escape
    parts = [
        "<!doctype html><html><head><meta charset='utf-8'><title>%s</title>" % e(os.path.basename(path)),
        "<style>body{font:14px/1.45 system-ui,sans-serif;margin:24px;color:#1d1f23}"
        "pre{background:#f4f5f7;border:1px solid #dde0e4;border-radius:6px;padding:10px;overflow:auto;"
        "font:12px/1.4 ui-monospace,Menlo,Consolas,monospace;white-space:pre}"
        "table{border-collapse:collapse}td,th{border:1px solid #dde0e4;padding:3px 8px;text-align:left;font-size:13px}"
        "h2{margin-top:28px}summary{cursor:pointer;font-weight:600}</style></head><body>",
        "<h1>%s</h1>" % e(os.path.basename(path)),
        "<p>%d bytes · sha256 <code>%s</code></p>" % (len(data), hashlib.sha256(data).hexdigest()),
        "<table>" + "".join("<tr><th>%s</th><td>%s</td></tr>" % (e(k), e(v)) for k, v in rows) + "</table>",
    ]
    try:
        z = zipfile.ZipFile(io.BytesIO(archive))
    except zipfile.BadZipFile as ex:
        parts.append("<p><b>Archive could not be read:</b> %s</p>" % e(str(ex)))
        z = None
    if z:
        infos = z.infolist()
        parts.append("<h2>Files (%d)</h2><table><tr><th>name</th><th>size</th><th>compressed</th></tr>" % len(infos))
        for i in infos:
            parts.append("<tr><td><a href='#f%d'>%s</a></td><td>%d</td><td>%d</td></tr>"
                         % (infos.index(i), e(i.filename), i.file_size, i.compress_size))
        parts.append("</table>")
        for n, i in enumerate(infos):
            if i.is_dir():
                continue
            body = z.read(i)
            kind = "text" if is_text(body) else "binary, hexdump"
            content = body.decode("utf-8") if kind == "text" else hexdump(body)
            parts.append("<h2 id='f%d'>%s <small>(%d bytes, %s)</small></h2><pre>%s</pre>"
                         % (n, e(i.filename), len(body), kind, e(content)))
    parts.append("<h2>Raw bytes</h2><details><summary>hexdump of the whole file</summary><pre>%s</pre></details>"
                 % e(hexdump(data, len(data))))
    parts.append("</body></html>\n")
    return "".join(parts)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("crx")
    ap.add_argument("-o", "--out")
    args = ap.parse_args()
    data = open(args.crx, "rb").read()
    out = args.out or args.crx + ".html"
    with open(out, "w", encoding="utf-8") as f:
        f.write(render(args.crx, data))
    print("wrote", out, file=sys.stderr)


if __name__ == "__main__":
    main()
