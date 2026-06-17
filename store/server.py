#!/usr/bin/env python3
"""Generic HTTP host for a Sprout web app.

Sprout has no built-in web server (it's on the roadmap), so — exactly like CGI or
classic PHP — this small, *app-agnostic* host does only the HTTP plumbing and hands every
request to `app.sprout`. ALL the store logic (auth, sessions, catalog, cart, orders, the
admin dashboard) lives in Sprout, and the data lives in Sprout's own `remember`/`recall`
store (`sprout.data.json`, created next to this file on first run).

Protocol (kept deliberately simple so Sprout can parse it with split/lines):
  host -> sprout  : request fed on STDIN as `key<TAB>value` lines, ending with `__END__`
                    (method, path, session, and each query/form field as `param.<name>`)
  sprout -> host  : response printed on STDOUT as header lines, then a `__BODY__` marker,
                    then the HTML body:
                        status<TAB>200
                        header<TAB>Set-Cookie<TAB>session=...; Path=/; HttpOnly
                        __BODY__
                        <!doctype html> ...

Run:  python server.py   (then open http://localhost:8090)
"""
import os
import subprocess
import threading
import urllib.parse
import http.cookies
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
APP = os.path.join(HERE, "app.sprout")
PORT = int(os.environ.get("PORT", "8090"))


def find_sprout():
    if os.environ.get("SPROUT_BIN"):
        return os.environ["SPROUT_BIN"]
    for cand in (os.path.join(HERE, "..", "src", "sprout.exe"),
                 os.path.join(HERE, "..", "src", "sprout")):
        if os.path.isfile(cand):
            return os.path.abspath(cand)
    return "sprout"   # fall back to PATH


SPROUT = find_sprout()
_lock = threading.Lock()   # serialize Sprout runs so the shared data file isn't raced


def clean(v):
    """Keep the line protocol intact (values never contain tab/newline)."""
    return v.replace("\t", " ").replace("\r", " ").replace("\n", " ")


class Handler(BaseHTTPRequestHandler):
    server_version = "sprout-store"
    sys_version = ""

    def _serve_static(self, path):
        rel = path[len("/static/"):]
        base = os.path.join(HERE, "static")
        fp = os.path.normpath(os.path.join(base, rel))
        if not fp.startswith(base) or not os.path.isfile(fp):
            self.send_response(404); self.end_headers(); return
        ctype = "text/css" if fp.endswith(".css") else "application/octet-stream"
        data = open(fp, "rb").read()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _handle(self, method):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        if path.startswith("/static/"):
            return self._serve_static(path)

        params = {}
        for k, vals in urllib.parse.parse_qs(parsed.query).items():
            params[k] = vals[0]
        if method == "POST":
            n = int(self.headers.get("Content-Length", "0") or "0")
            body = self.rfile.read(n).decode("utf-8", "replace") if n else ""
            for k, vals in urllib.parse.parse_qs(body).items():
                params[k] = vals[0]

        session = ""
        raw_cookie = self.headers.get("Cookie")
        if raw_cookie:
            jar = http.cookies.SimpleCookie(raw_cookie)
            if "session" in jar:
                session = jar["session"].value

        lines = [f"method\t{method}", f"path\t{path}", f"session\t{clean(session)}"]
        for k, v in params.items():
            lines.append(f"param.{clean(k)}\t{clean(v)}")
        lines.append("__END__")
        stdin = ("\n".join(lines) + "\n").encode("utf-8")

        try:
            with _lock:
                proc = subprocess.run([SPROUT, "run", APP], input=stdin,
                                      stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                      cwd=HERE, timeout=20)
            out = proc.stdout.decode("utf-8", "replace").replace("\r\n", "\n").replace("\r", "\n")
        except Exception as e:
            out = ""
            err = str(e)
        else:
            err = ""

        status, headers, body = 200, [], ""
        if "__BODY__\n" in out:
            head, body = out.split("__BODY__\n", 1)
            for ln in head.splitlines():
                parts = ln.split("\t")
                if parts[0] == "status" and len(parts) >= 2:
                    try:
                        status = int(parts[1])
                    except ValueError:
                        pass
                elif parts[0] == "header" and len(parts) >= 3:
                    headers.append((parts[1], "\t".join(parts[2:])))
        else:
            status = 500
            body = ("<h1>500 — the Sprout app did not return a response</h1>"
                    "<pre>" + (out or err).replace("<", "&lt;") + "</pre>")

        data = body.encode("utf-8")
        self.send_response(status)
        if not any(h[0].lower() == "content-type" for h in headers):
            self.send_header("Content-Type", "text/html; charset=utf-8")
        for name, val in headers:
            self.send_header(name, val)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        if method != "HEAD":
            self.wfile.write(data)

    def do_GET(self):
        self._handle("GET")

    def do_POST(self):
        self._handle("POST")

    def log_message(self, fmt, *args):
        pass


def main():
    print("Sprout store running on  http://localhost:%d   (Ctrl+C to stop)" % PORT, flush=True)
    print("  interpreter: %s" % SPROUT, flush=True)
    print("  data file:   %s" % os.path.join(HERE, "sprout.data.json"), flush=True)
    try:
        ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
    except KeyboardInterrupt:
        print("\nbye")


if __name__ == "__main__":
    main()
