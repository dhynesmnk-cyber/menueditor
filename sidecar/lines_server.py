"""Canvas-mode sidecar for Menu Studio.

    .lines/bin/python sidecar/lines_server.py       # http://127.0.0.1:8793

Jobs the browser cannot do on its own:

    POST /lines                    PDF bytes  -> line objects, rules, images, fonts
    POST /splice                   JSON       -> the edited PDF (edits, deletes, adds, images)

and the workspace, so a menu is a folder rather than a tab:

    GET  /projects                     -> [{slug, name, updated, pages, ...}]
    POST /projects                     {name, pdf} -> {meta, lines}
    GET  /projects/<slug>              -> {meta, lines, work, fonts}
    GET  /projects/<slug>/original     -> the designer's PDF, untouched
    POST /projects/<slug>/work         {edits, images, adds, deletes} -> saved
    POST /projects/<slug>/fonts        {name, data} -> {family, file}
    GET  /projects/<slug>/fonts/<file> -> font bytes (for @font-face)
    POST /projects/<slug>/export       -> PDF, and a copy in exports/

Localhost only, probed via /health; the app degrades to its model-based import
when nothing answers.
"""
import base64
import json
import os
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import grouping    # noqa: E402
import splice      # noqa: E402
import workspace   # noqa: E402

PORT = int(os.environ.get("LINES_PORT", "8793"))
# Bind to loopback by default. LINES_HOST=0.0.0.0 puts it on the network so a phone can
# reach it, and there is no authentication on this service: anyone who can route to the
# port can read and edit every project in projects/. Use it on a network you trust.
HOST = os.environ.get("LINES_HOST", "127.0.0.1")
MAX_BODY = 40 * 1024 * 1024


def _b64(data):
    return base64.b64decode(data or b"")


class Handler(BaseHTTPRequestHandler):
    server_version = "menu-lines/0.2"

    def log_message(self, fmt, *args):
        sys.stderr.write("lines: %s\n" % (fmt % args))

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        # cross-origin JS can only read these if they are explicitly exposed
        self.send_header("Access-Control-Expose-Headers",
                         "X-Edits-Applied, X-Edits-Refused, X-Images-Placed, "
                         "X-Adds-Applied, X-Deletes-Applied, X-Export-Name")

    def _send(self, code, body, ctype="application/json", extra=None):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self._cors()
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def _json(self, code, data, extra=None):
        self._send(code, json.dumps(data).encode(), "application/json", extra)

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        if n <= 0 or n > MAX_BODY:
            raise ValueError("bad body size")
        return self.rfile.read(n)

    def _payload(self):
        return json.loads(self._body() or b"{}")

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    # ── routes ────────────────────────────────────────────────────────────────
    def do_GET(self):
        path = self.path.split("?")[0]
        parts = [p for p in path.split("/") if p]
        try:
            if path == "/health":
                self._json(200, {"ok": True, "engine": "pymupdf",
                                 "projects": workspace.PROJECTS})
                return
            if parts and parts[0] == "projects":
                if len(parts) == 1:
                    self._json(200, {"projects": workspace.listing()})
                    return
                slug = parts[1]
                if len(parts) == 2:
                    self._json(200, workspace.open_project(slug))
                    return
                if len(parts) == 3 and parts[2] == "original":
                    pdf = workspace.original(slug)
                    self._send(200, pdf, "application/pdf")
                    return
                if len(parts) == 3 and parts[2] == "exports":
                    self._json(200, {"exports": workspace.list_exports(slug)})
                    return
                if len(parts) == 4 and parts[2] == "exports":
                    # A phone downloads a blob badly (iOS opens it as a stray tab), so the
                    # export is also a real file behind a URL. Name is whitelisted: no paths.
                    import re
                    name = parts[3]
                    if not re.match(r"^[A-Za-z0-9._-]+\.pdf$", name):
                        self._json(400, {"error": "bad export name"})
                        return
                    epath = os.path.join(workspace.PROJECTS, slug, "exports", name)
                    with open(epath, "rb") as fh:
                        body = fh.read()
                    self._send(200, body, "application/pdf",
                               {"Content-Disposition": 'attachment; filename="%s"' % name})
                    return
                if len(parts) == 4 and parts[2] == "fonts":
                    path = workspace.font_path(slug, parts[3])
                    with open(path, "rb") as fh:
                        body = fh.read()
                    ctype = "font/otf" if path.lower().endswith((".otf", ".ttc")) else "font/ttf"
                    self._send(200, body, ctype)
                    return
            self._json(404, {"error": "not found"})
        except FileNotFoundError as exc:
            self._json(404, {"error": str(exc)})
        except Exception as exc:                                    # noqa: BLE001
            self._json(500, {"error": str(exc)})

    def do_POST(self):
        path = self.path.split("?")[0]
        parts = [p for p in path.split("/") if p]
        try:
            if path == "/lines":
                self._lines(self._body())
                return
            if path == "/splice":
                self._splice(self._payload())
                return
            if parts and parts[0] == "projects":
                if len(parts) == 1:
                    payload = self._payload()
                    image = _b64(payload.get("image"))
                    if image:
                        self._json(200, workspace.create_image(payload.get("name") or "Menu",
                                                               image,
                                                               payload.get("filename") or ""))
                        return
                    pdf = _b64(payload.get("pdf"))
                    if not pdf.startswith(b"%PDF"):
                        self._json(400, {"error": "missing pdf"})
                        return
                    self._json(200, workspace.create(payload.get("name") or "Menu", pdf))
                    return
                slug = parts[1]
                if len(parts) == 3 and parts[2] == "work":
                    self._json(200, workspace.save_work(slug, self._payload()))
                    return
                if len(parts) == 3 and parts[2] == "fonts":
                    payload = self._payload()
                    self._json(200, workspace.add_font(slug, payload.get("name") or "",
                                                       _b64(payload.get("data"))))
                    return
                if len(parts) == 3 and parts[2] == "reimport":
                    payload = self._payload()
                    pdf = _b64(payload.get("pdf"))
                    if not pdf.startswith(b"%PDF"):
                        self._json(400, {"error": "missing pdf"})
                        return
                    self._json(200, workspace.reimport_pdf(slug, pdf))
                    return
                if len(parts) == 3 and parts[2] == "manifest":
                    self._json(200, workspace.write_manifest(slug, self._payload()))
                    return
                if len(parts) == 3 and parts[2] == "export":
                    self._project_export(slug, self._payload())
                    return
            self._json(404, {"error": "not found"})
        except FileNotFoundError as exc:
            self._json(404, {"error": str(exc)})
        except ValueError as exc:
            self._json(400, {"error": str(exc)})
        except Exception as exc:                                    # noqa: BLE001
            self._json(500, {"error": str(exc)})

    # ── handlers ──────────────────────────────────────────────────────────────
    def _lines(self, pdf_bytes):
        if not pdf_bytes.startswith(b"%PDF"):
            self._json(400, {"error": "not a PDF"})
            return
        self._json(200, grouping.extract(pdf_bytes))

    def _splice(self, payload):
        pdf_bytes = _b64(payload.get("pdf"))
        if not pdf_bytes.startswith(b"%PDF"):
            self._json(400, {"error": "missing pdf"})
            return
        self._run_splice(pdf_bytes, payload, save_as=None)

    def _project_export(self, slug, payload):
        pdf_bytes = workspace.original(slug)
        payload.setdefault("font_paths", self._project_fonts(slug))
        self._run_splice(pdf_bytes, payload, save_as=slug)

    def _project_fonts(self, slug):
        out = {}
        for f in workspace.fonts(slug):
            try:
                out[f["family"]] = workspace.font_path(slug, f["file"])
            except FileNotFoundError:
                continue
        return out

    def _run_splice(self, pdf_bytes, payload, save_as):
        # a project's own fonts win over anything installed on the machine
        font_paths = dict(self._project_fonts(save_as) if save_as else {})
        font_paths.update(payload.get("font_paths") or {})
        out, info = splice.build(
            pdf_bytes,
            edits=payload.get("edits") or [],
            images=payload.get("images") or [],
            adds=payload.get("adds") or [],
            deletes=payload.get("deletes") or [],
            font_paths=font_paths,
            page_ops=payload.get("page_ops") or {},
            manifest=(workspace.manifest(save_as) if save_as else
                      (payload.get("manifest") or {})),
        )
        extra = {
            "X-Edits-Applied": str(info["applied"]),
            "X-Edits-Refused": str(len(info["refused"])),
            "X-Images-Placed": str(info.get("images", 0)),
            "X-Adds-Applied": str(info.get("added", 0)),
            "X-Pages-Added": str(info.get("pages_added", 0)),
            "X-Pages-Deleted": str(info.get("pages_deleted", 0)),
            "X-Deletes-Applied": str(info.get("deleted", 0)),
        }
        if save_as:
            extra["X-Export-Name"] = workspace.save_export(save_as, out)
        self._send(200, out, "application/pdf", extra)


if __name__ == "__main__":
    srv = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"menu lines sidecar on http://{HOST}:{PORT}/  (projects in {workspace.PROJECTS})")
    if HOST not in ("127.0.0.1", "localhost"):
        print("  on the network: no authentication, any device that can reach this port can")
        print("  read and edit every project. Serve the page from the same machine and open")
        print(f"  http://<this-machine's-ip>:{PORT}/health from the phone to confirm it answers.")
    srv.serve_forever()
