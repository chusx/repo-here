#!/usr/bin/env python3
"""Wrap v86.wasm + SeaBIOS/VGA BIOS into v86-bins.js so they load via <script> (works on file://).
usage: make-v86-bins.py <v86 npm package dir> <v86 repo bios/ dir>"""
import base64, json, os, sys
pkg, bios = sys.argv[1], sys.argv[2]
b = lambda p: base64.b64encode(open(p, "rb").read()).decode()
data = {"wasm": b(os.path.join(pkg, "build/v86.wasm")),
        "bios": b(os.path.join(bios, "seabios.bin")),
        "vgabios": b(os.path.join(bios, "vgabios.bin"))}
out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "v86-bins.js")
open(out, "w").write("__webshell.bins(" + json.dumps(data) + ");\n")
print("wrote", out)
