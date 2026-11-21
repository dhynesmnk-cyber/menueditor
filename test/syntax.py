"""Extract the inline app script from index.html and syntax-check it with node."""
import re
import subprocess
import sys

html = open("index.html").read()
blocks = re.findall(r"<script>(.*?)</script>", html, re.S)
print(f"inline script blocks: {len(blocks)}")
src = "\n".join(blocks)
open("out/app-inline.js", "w").write(src)
r = subprocess.run(["node", "--check", "out/app-inline.js"], capture_output=True, text=True)
print("node --check:", "OK" if r.returncode == 0 else "FAILED")
if r.returncode:
    print(r.stderr[:2000])
    sys.exit(1)

# also report the line count and any obvious leftovers
print(f"lines: {src.count(chr(10)) + 1}")
