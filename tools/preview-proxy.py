#!/usr/bin/env python3
"""One origin for the editor and its sidecar, so a single tunnel can carry both.

The studio page is static files on :8791 and talks to a sidecar on :8793, derived from the
page's host. Through a tunnel there is one hostname and one port, so the page cannot reach
:8793 at all: this listens on :8795 and puts the API paths on the same origin as the files.
Load the page with ?svc=same and the client uses relative URLs.

Deliberately small. Set PREVIEW_TOKEN and every request needs it once, as ?k=…, which is then
kept in a cookie so the assets, the fetches and the PDF downloads all follow. Unset it and the
proxy is open, like the sidecar — a preview tool that must be killed when the preview is over.
Only what the editor actually calls is routed.
"""

import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

STATIC = "http://127.0.0.1:8791"
API = "http://127.0.0.1:8793"
PORT = int(os.environ.get("PREVIEW_PORT", "8795"))
TOKEN = os.environ.get("PREVIEW_TOKEN") or ""
COOKIE = "pv"
MONTH = 2592000

# The sidecar owns everything under /projects plus these three verbs. Everything else is a file.
API_PREFIXES = ("/projects", "/splice", "/health", "/reimport")
HOP = {"connection", "keep-alive", "transfer-encoding", "te", "trailer", "upgrade",
       "proxy-authorization", "proxy-authenticate", "host", "content-length"}


def upstream_for(path):
    return API if path.startswith(API_PREFIXES) else STATIC


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        sys.stderr.write("%s %s\n" % (self.address_string(), fmt % args))

    def _gate(self):
        """True when this request may pass; answers the request itself when it may not.

        A phone cannot send a header, so the token arrives once in the URL and is swapped for a
        cookie: the page then loads its scripts, its fonts and its PDFs without the token coming
        back in every one of them.
        """
        if not TOKEN:
            return True
        parts = urllib.parse.urlsplit(self.path)
        given = (urllib.parse.parse_qs(parts.query).get("k") or [""])[0]
        if given == TOKEN:
            keep = urllib.parse.parse_qsl(parts.query)
            keep = [(k, v) for k, v in keep if k != "k"]
            where = parts.path + ("?" + urllib.parse.urlencode(keep) if keep else "")
            self.send_response(302)
            self.send_header("Location", where or "/")
            self.send_header("Set-Cookie", "%s=%s; Path=/; Max-Age=%d; HttpOnly; SameSite=Lax"
                             % (COOKIE, TOKEN, MONTH))
            self.send_header("Content-Length", "0")
            self.end_headers()
            return False
        sent = ""
        for chunk in (self.headers.get("Cookie") or "").split(";"):
            name, _, value = chunk.strip().partition("=")
            if name == COOKIE:
                sent = value
        if sent == TOKEN:
            return True
        body = (b"<!doctype html><meta name=viewport content='width=device-width,initial-scale=1'>"
                b"<p style=\"font:16px/1.5 system-ui;padding:32px\">This preview needs its link. "
                b"Ask Dave for the address with the key on the end.</p>")
        self.send_response(401)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)
        return False

    def _relay(self, method):
        if not self._gate():
            return
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else None
        target = upstream_for(self.path) + self.path
        headers = {k: v for k, v in self.headers.items() if k.lower() not in HOP}
        req = urllib.request.Request(target, data=body, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=300) as r:
                payload = r.read()
                self.send_response(r.status)
                for k, v in r.headers.items():
                    if k.lower() not in HOP and k.lower() != "content-encoding":
                        self.send_header(k, v)
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                if method != "HEAD":
                    self.wfile.write(payload)
        except urllib.error.HTTPError as e:
            payload = e.read()
            self.send_response(e.code)
            for k, v in e.headers.items():
                if k.lower() not in HOP:
                    self.send_header(k, v)
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
        except Exception as e:                                  # upstream down
            msg = ("upstream unreachable: %s" % e).encode()
            self.send_response(502)
            self.send_header("Content-Type", "text/plain")
            self.send_header("Content-Length", str(len(msg)))
            self.end_headers()
            self.wfile.write(msg)

    def do_GET(self):
        self._relay("GET")

    def do_HEAD(self):
        self._relay("HEAD")

    def do_POST(self):
        self._relay("POST")

    def do_PUT(self):
        self._relay("PUT")

    def do_DELETE(self):
        self._relay("DELETE")

    def do_OPTIONS(self):
        # the sidecar answers its own preflight; anything else is a plain file
        self._relay("OPTIONS")


if __name__ == "__main__":
    print("preview proxy: :%d  files %s  api %s" % (PORT, STATIC, API), flush=True)
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
