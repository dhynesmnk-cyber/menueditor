"""RapidOCR (PaddleOCR models on onnxruntime) over the reference menus.
Writes word boxes in the shape src/layout.js expects."""
import json
import os
import sys
import time

from rapidocr_onnxruntime import RapidOCR

engine = RapidOCR()
os.makedirs("out/ocr", exist_ok=True)

for path in sys.argv[1:]:
    t0 = time.time()
    result = engine(path)
    if isinstance(result, tuple):
        result = result[0]
    words = []
    for item in (result or []):
        box, text, score = item[0], item[1], item[2]
        xs = [p[0] for p in box]
        ys = [p[1] for p in box]
        if not str(text).strip():
            continue
        words.append({
            "text": str(text),
            "x": round(min(xs), 2), "y": round(min(ys), 2),
            "w": round(max(xs) - min(xs), 2), "h": round(max(ys) - min(ys), 2),
            "conf": round(float(score), 3),
        })
    name = os.path.basename(path).rsplit(".", 1)[0].replace(" ", "-").replace("(", "").replace(")", "")
    out = f"out/ocr/{name}.json"
    with open(out, "w") as fh:
        json.dump(words, fh)
    confs = [w["conf"] for w in words] or [0]
    print(f"{name}: {len(words)} lines/words in {time.time() - t0:.1f}s, "
          f"mean conf {sum(confs) / len(confs):.3f} -> {out}")
