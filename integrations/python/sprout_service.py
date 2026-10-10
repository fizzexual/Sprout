"""Bounded HTTP host for a Sprout JSON worker; Python 3.10+, no dependencies."""
import argparse
import http.server
import json
import socket
import threading
from pathlib import Path
from urllib.parse import urlsplit, parse_qs
from sprout_host import run, encode, decode, SproutError


class SproutServer(http.server.ThreadingHTTPServer):
    daemon_threads = True
    request_queue_size = 32
    def __init__(self, address, program, *, command="sprout", workers=8, allow_io=False,
                 timeout_ms=5000, max_body=65536):
        if not 1 <= workers <= 64 or not 1 <= max_body <= 1048576:
            raise ValueError("workers must be 1..64 and body limit 1..1048576")
        self.program = Path(program).resolve()
        self.command, self.allow_io = command, allow_io
        self.timeout_ms, self.max_body = timeout_ms, max_body
        self.capacity = threading.BoundedSemaphore(workers)
        super().__init__(address, SproutHandler)
    def get_request(self):
        connection, address = super().get_request()
        connection.settimeout(2)
        return connection, address
    def process_request(self, request, address):
        if not self.capacity.acquire(blocking=False):
            try:
                request.settimeout(.2)
                request.sendall(b"HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
            except OSError:
                pass
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, address)
        except BaseException:
            self.capacity.release()
            raise
    def process_request_thread(self, request, address):
        try:
            super().process_request_thread(request, address)
        finally:
            self.capacity.release()


class SproutHandler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.0"
    def log_message(self, *_):
        pass
    def respond(self, status, body, headers=None):
        payload = body if isinstance(body, bytes) else encode(body).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/octet-stream" if isinstance(body, bytes) else "application/json; charset=utf-8")
        for key, value in (headers or {}).items():
            if key.lower() not in ("content-type", "content-length", "connection", "transfer-encoding"):
                self.send_header(key, value)
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Connection", "close")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(payload)
    def handle_worker(self):
        self.close_connection = True
        path = urlsplit(self.path)
        if path.path == "/health" and self.command in ("GET", "HEAD"):
            self.respond(200, {"ok": True, "protocol": 1})
            return
        if self.headers.get("Transfer-Encoding"):
            self.respond(400, {"error": "Content-Length required"}); return
        lengths = self.headers.get_all("Content-Length", [])
        if len(lengths) > 1:
            self.respond(400, {"error": "ambiguous Content-Length"}); return
        try:
            length = int(lengths[0]) if lengths else 0
            if length < 0:
                raise ValueError()
            if length > self.server.max_body:
                self.respond(413, {"error": "request too large"}); return
            raw = self.rfile.read(length)
            if len(raw) != length:
                raise ValueError()
            body = decode(raw.decode("utf-8")) if raw else None
        except (ValueError, UnicodeError, socket.timeout):
            self.respond(400, {"error": "invalid JSON request"}); return
        try:
            query = parse_qs(path.query, max_num_fields=100)
        except ValueError:
            self.respond(400, {"error": "too many query fields"}); return
        request = {"method": self.command, "path": path.path, "query": query, "body": body}
        try:
            encoded_request = encode(request).encode("utf-8")
        except (ValueError, TypeError):
            self.respond(400, {"error": "invalid JSON request"}); return
        if len(encoded_request) + 1 > 1048576:
            self.respond(413, {"error": "request too large"}); return
        try:
            response = run(self.server.program, request, command=self.server.command,
                           sandbox=not self.server.allow_io, timeout_ms=self.server.timeout_ms,
                           runtime_timeout_ms=max(1, self.server.timeout_ms - 250))
            if not isinstance(response, dict):
                raise ValueError("response must be a map")
            status, headers = response.get("status", 200), response.get("headers", {})
            if isinstance(status, bool) or not isinstance(status, int) or not 200 <= status <= 599:
                raise ValueError("invalid response status")
            if not isinstance(headers, dict):
                raise ValueError("invalid response headers")
            for key, value in headers.items():
                if not isinstance(key, str) or not key or any(c not in "!#$%&'*+-.^_`|~0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ" for c in key):
                    raise ValueError("invalid response header")
                if not isinstance(value, str) or any(ord(c) < 32 or ord(c) > 126 for c in value):
                    raise ValueError("invalid response header")
            self.respond(status, response.get("body"), headers)
        except SproutError as error:
            self.respond(504 if error.code == "timeout" else 502, {"error": "worker failed", "code": error.code})
        except (ValueError, TypeError):
            self.respond(502, {"error": "invalid worker response"})
    do_GET = do_POST = do_PUT = do_PATCH = do_DELETE = do_HEAD = handle_worker


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("program")
    parser.add_argument("--command", default="sprout")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8080)
    parser.add_argument("--workers", type=int, default=8)
    parser.add_argument("--allow-io", action="store_true")
    args = parser.parse_args()
    with SproutServer((args.host, args.port), args.program, command=args.command,
                      workers=args.workers, allow_io=args.allow_io) as server:
        print(f"Sprout worker service at http://{args.host}:{server.server_port}", flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass

if __name__ == "__main__": main()
