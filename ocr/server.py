"""Local OCR sidecar for Menu Studio.

The app is browser-only; browsers have no good OCR engine. This is the smallest
honest way to give it a strong one: a local HTTP service that returns word boxes,
which the app then feeds through the same layout reconstruction used for PDFs.

    POST /ocr     image bytes  ->  {"words":[{text,x,y,w,h,conf}, ...]}
    GET  /health  ->  {"ok":true,"engine":"rapidocr"}

Run it:
    python3 -m venv .ocr && .ocr/bin/pip install rapidocr-onnxruntime
    .ocr/bin/python ocr/server.py            # port 8792

The browser will use it when it answers and fall back to design-only when it
doesn't, so nothing breaks if it isn't running.
"""
import io
import json
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np
from PIL import Image
from rapidocr_onnxruntime import RapidOCR

try:
    ENGINE = RapidOCR()
except Exception as exc:                                    # pragma: no cover
    print(f"could not start the OCR engine: {exc}", file=sys.stderr)
    raise

MAX_BYTES = 25 * 1024 * 1024


class Handler(BaseHTTPRequestHandler):
    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "content-type")
        self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")

    def _json(self, status, payload):
        body = json.dumps(payload).encode()
        self.send_response(status)
        self._cors()
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self):
        if self.path.split("?")[0] in ("/health", "/"):
            self._json(200, {"ok": True, "engine": "rapidocr"})
        else:
            self._json(404, {"error": "not found"})

    def do_POST(self):
        if self.path.split("?")[0] != "/ocr":
            self._json(404, {"error": "not found"})
            return

        length = int(self.headers.get("content-length") or 0)
        if length <= 0 or length > MAX_BYTES:
            self._json(413, {"error": f"image must be 1 byte - {MAX_BYTES} bytes"})
            return

        try:
            image = Image.open(io.BytesIO(self.rfile.read(length))).convert("RGB")
        except Exception as exc:
            self._json(400, {"error": f"could not decode image: {exc}"})
            return

        try:
            result = ENGINE(np.asarray(image))
            if isinstance(result, tuple):
                result = result[0]
        except Exception as exc:
            self._json(500, {"error": f"ocr failed: {exc}"})
            return

        words = []
        for item in (result or []):
            box, text, score = item[0], item[1], item[2]
            if not str(text).strip():
                continue
            xs = [p[0] for p in box]
            ys = [p[1] for p in box]
            words.append({
                "text": str(text),
                "x": round(min(xs), 2), "y": round(min(ys), 2),
                "w": round(max(xs) - min(xs), 2), "h": round(max(ys) - min(ys), 2),
                "conf": round(float(score), 3),
            })

        self._json(200, {
            "engine": "rapidocr",
            "width": image.width,
            "height": image.height,
            "words": words,
        })

    def log_message(self, fmt, *args):
        pass


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8792
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"OCR service on http://127.0.0.1:{port}  (POST /ocr, GET /health)")
    server.serve_forever()
