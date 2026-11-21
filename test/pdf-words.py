"""Dump word boxes from a PDF in the shape src/layout.js expects.
Stands in for pdf.js, which produces the same boxes in the browser."""
import json
import sys

import pymupdf

pdf = sys.argv[1] if len(sys.argv) > 1 else "out/menu.pdf"
page = pymupdf.open(pdf)[0]
words = []
for x0, y0, x1, y1, text, *_ in page.get_text("words"):
    if not text.strip():
        continue
    words.append({
        "text": text,
        "x": round(x0, 2),
        "y": round(y0, 2),
        "w": round(x1 - x0, 2),
        "h": round(y1 - y0, 2),
    })
with open("out/pdf-words.json", "w") as fh:
    json.dump(words, fh)
print(f"{len(words)} words from {pdf} -> out/pdf-words.json")
