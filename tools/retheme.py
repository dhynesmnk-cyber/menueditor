"""Retheme Menu Studio from warm brown to white / silver / blue.

Only the app chrome is touched: the design system that renders the menu itself keeps
its own colours (they belong to the document, not the UI).

    python3 tools/retheme.py           # rewrites index.html and src/canvas.js
"""
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# ── app chrome (index.html) ────────────────────────────────────────────────────
VARS = {
    "--chrome": "#f2f5f9",   # window background, a cool silver
    "--panel": "#ffffff",    # panels and bars
    "--line": "#dbe2ec",     # silver hairlines
    "--text": "#131a24",     # near-black with a blue cast
    "--dim": "#667485",      # secondary text
    "--accent": "#2f6fed",   # Hermes blue
}

# every hardcoded shade in the stylesheet, mapped onto the new palette
HTML_MAP = {
    "#33291f": "#ffffff",              # .btn
    "#3d3126": "#eef2f8",              # .btn:hover
    "#d98a52": "#1f5cd6",              # .btn.primary border / hover
    "#201509": "#ffffff",              # .btn.primary text
    "#191411": "#ffffff",              # inputs
    "#30261f": "#f1f5fb",              # .list button:hover
    "#4a3423": "#e7eefe",              # .list button.sel  (replaced below with a rule)
    "#e0a06a": "#b42318",              # .warn / .warnline
    "#e5896b": "#b42318",              # .warnline.error
    "#15110e": "#f7f9fc",              # #importText
    "#0b0806d0": "rgba(13,21,34,.45)",
    "#000a": "rgba(16,32,64,.16)",
    "#0006": "rgba(16,32,64,.10)",
    "#000c": "rgba(16,32,64,.22)",
    "#c8763f66": "rgba(47,111,237,.40)",   # #trim outline
    "#c8763f88": "rgba(47,111,237,.55)",   # .bound:hover
    "#c8763f0d": "rgba(47,111,237,.06)",   # .bound.sel fill
    "#a3763c": "#2f6fed",              # low-confidence price border (JS)
}

# ── canvas mode (src/canvas.js) ────────────────────────────────────────────────
CANVAS_MAP = {
    "#f3f2ef": "#f2f5f9",              # overlay background
    "#ffffff": "#ffffff",
    "#fff": "#fff",
    "#ddd": "#dbe2ec",                 # bar / tracking bar hairlines
    "#26241f": "#131a24",              # bar text
    "#8b867c": "#667485",              # hints, page numbers
    "#c9c4b8": "#c9d2e0",              # button borders
    "#faf9f6": "#ffffff",              # button faces
    "#2f2b25": "#2f6fed",              # primary button (fill)
    "#b3492e": "#2f6fed",              # selection, guides, input border
    "rgba(179,73,46,.05)": "rgba(47,111,237,.06)",
    "rgba(179,73,46,.22)": "rgba(47,111,237,.22)",
    "rgba(179,73,46,.12)": "rgba(47,111,237,.10)",
    "rgba(179,73,46,.3)": "rgba(47,111,237,.35)",
    "rgba(32,120,84,.55)": "rgba(47,111,237,.60)",   # edited line outline
    "#a3231b": "#b42318",              # invalid input
    "rgba(163,35,27,.25)": "rgba(180,35,24,.22)",
    "#fff6e5": "#eef3fb",              # warn bar
    "#f0d9a8": "#c3d4f2",
    "#6b4c12": "#17427f",
    "#5d574c": "#3f4a58",              # status text
}


def rewrite(path, mapping, vars_map=None):
    text = open(path, encoding="utf-8").read()
    orig = text
    if vars_map:
        for name, value in vars_map.items():
            text = re.sub(r"(%s:\s*)#[0-9a-fA-F]{3,8}" % re.escape(name), r"\g<1>" + value, text)
    # longest keys first so "#000a" never eats "#000c"
    for old in sorted(mapping, key=len, reverse=True):
        text = text.replace(old, mapping[old])
    if text != orig:
        open(path, "w", encoding="utf-8").write(text)
    return text != orig


def main():
    changed = []
    if rewrite(os.path.join(ROOT, "index.html"), HTML_MAP, VARS):
        changed.append("index.html")
    if rewrite(os.path.join(ROOT, "src", "canvas.js"), CANVAS_MAP):
        changed.append("src/canvas.js")
    print("rethemed:", ", ".join(changed) or "nothing changed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
