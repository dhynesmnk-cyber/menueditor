"""Static checks for the single-page app, since a headless browser is not
always available on this box:

1. the inline script must parse (node --check)
2. every element id the script looks up must exist in the markup
3. every asset the page references must exist on disk
"""
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
html = (ROOT / "index.html").read_text()

blocks = re.findall(r"<script>(.*?)</script>", html, re.S)
src = "\n".join(blocks)
out = ROOT / "out" / "app-inline.js"
out.parent.mkdir(exist_ok=True)
out.write_text(src)

fails = []

r = subprocess.run(["node", "--check", str(out)], capture_output=True, text=True)
if r.returncode != 0:
    tail = (r.stderr.strip().splitlines() or ["syntax error"])[-1]
    fails.append("syntax: " + tail)
else:
    print(f"  ok    inline script parses ({src.count(chr(10)) + 1} lines)")

# ---- ids referenced by the script vs ids defined in the markup
referenced = set(re.findall(r"getElementById\(\s*'([^']+)'\s*\)", src))
referenced |= set(re.findall(r"querySelector\(\s*'#([A-Za-z0-9_-]+)'", src))
defined = set(re.findall(r'\bid="([^"]+)"', html))
# ids the script creates at runtime (el.id = 'x') are legitimate lookups
defined |= set(re.findall(r"\.id\s*=\s*'([^']+)'", src))

missing = sorted(referenced - defined)
if missing:
    fails.append("script references ids missing from the markup: " + ", ".join(missing))
else:
    print(f"  ok    all {len(referenced)} referenced element ids exist")

# ---- assets referenced vs files present
assets = set(re.findall(r'(?:src|href)="((?!http)[^"]+)"', html))
assets |= set(re.findall(r"url\('([^']+)'\)", html))
assets |= set(re.findall(r"fetch\('([^']+)'", src))
# a cache-busting query is part of the reference, not of the filename: ?v=201 still means
# src/canvas.js, and the file has to exist for it to be worth busting
missing_assets = sorted(
    a for a in assets
    if not a.startswith("data:") and not (ROOT / a.split("?")[0].split("#")[0]).exists()
)
if missing_assets:
    fails.append("missing assets: " + ", ".join(missing_assets))
else:
    print(f"  ok    all {len(assets)} referenced assets exist")

if fails:
    for f in fails:
        print("  FAIL  " + f)
    sys.exit(1)
print("PASS — markup, script and assets agree")
