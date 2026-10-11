"""Bounded HTTP host for a Sprout JSON worker; Python 3.10+, no dependencies."""
import argparse
import http.server
import io
import json
import socket
import signal
import threading
import time
from pathlib import Path
from urllib.parse import urlsplit, parse_qs
from sprout_host import run, encode, decode, SproutError


class _DeadlineReader(io.RawIOBase):
    """Share one absolute deadline across buffered header and body reads."""
    def __init__(self, connection, raw, timeout):
        super().__init__()
        self.connection, self.raw = connection, raw
        self.deadline = time.monotonic() + timeout
        self.response_timeout = connection.gettimeout()

    def readable(self):
        return True

    def remaining(self):
        remaining = self.deadline - time.monotonic()
        if remaining <= 0:
            raise socket.timeout('request read deadline expired')
        return remaining

    def readinto(self, buffer):
        self.connection.settimeout(self.remaining())
        return self.raw.readinto(buffer)

    def finish_request(self):
        # Even a complete request already in BufferedReader must satisfy the
        # deadline before dispatch. Restore the response's socket timeout so a
        # successfully dispatched worker retains its normal graceful drain.
        self.remaining()
        self.connection.settimeout(self.response_timeout)

    def close(self):
        try:
            self.raw.close()
        finally:
            super().close()


class SproutServer(http.server.ThreadingHTTPServer):
    # Wait for bounded in-flight handlers when the listener closes. Otherwise
    # service shutdown can abandon workers after an already accepted request.
    daemon_threads = False
    block_on_close = True
    request_queue_size = 32
    request_read_timeout = 2.0
    def __init__(self, address, program, *, command="sprout", workers=8, allow_io=False,
                 timeout_ms=5000, max_body=65536, cwd=None):
        for value, label, maximum in ((workers, 'workers', 64), (max_body, 'body limit', 1048576),
                                      (timeout_ms, 'timeout_ms', 3600000)):
            if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= maximum:
                raise ValueError(f'{label} must be an integer from 1 to {maximum}')
        self.program = Path(program).resolve()
        self.working_dir = self.program.parent if cwd is None else Path(cwd).resolve()
        if not self.working_dir.is_dir():
            raise ValueError('working directory must be an existing directory')
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
    rbufsize = 0
    def setup(self):
        super().setup()
        self.request_reader = _DeadlineReader(self.connection, self.rfile,
                                              self.server.request_read_timeout)
        self.rfile = io.BufferedReader(self.request_reader)
    def parse_request(self):
        self.request_reader.remaining()
        parsed = super().parse_request()
        self.request_reader.remaining()
        return parsed
    def log_message(self, *_):
        pass
    def respond(self, status, body, headers=None):
        bodyless = status in (204, 205, 304)
        payload = b'' if bodyless else body if isinstance(body, bytes) else encode(body).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/octet-stream" if isinstance(body, bytes) else "application/json; charset=utf-8")
        for key, value in (headers or {}).items():
            if key.lower() not in ("content-type", "content-length", "connection", "transfer-encoding"):
                self.send_header(key, value)
        # RFC 9110 sections 8.6 and 15.3: 204 forbids Content-Length; a 304
        # length needs a known selected representation, which this bridge lacks.
        if status not in (204, 304): self.send_header("Content-Length", str(len(payload)))
        self.send_header("Connection", "close")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(payload)
    def handle_worker(self):
        try:
            self.handle_worker_response()
        except OSError:
            # A disconnected client cannot receive a response; always release
            # request capacity through process_request_thread's finally block.
            self.close_connection = True
    def handle_worker_response(self):
        self.close_connection = True
        try:
            path = urlsplit(self.path)
        except ValueError:
            self.respond(400, {"error": "invalid request target"}); return
        if self.headers.get_all("Transfer-Encoding", []):
            self.respond(400, {"error": "Content-Length required"}); return
        lengths = self.headers.get_all("Content-Length", [])
        if len(lengths) > 1:
            self.respond(400, {"error": "ambiguous Content-Length"}); return
        try:
            field = lengths[0].strip(' \t') if lengths else '0'
            if not field.isascii() or not field.isdecimal():
                raise ValueError()
            length = int(field)
            if length > self.server.max_body:
                self.respond(413, {"error": "request too large"}); return
            if path.path == "/health" and self.command in ("GET", "HEAD"):
                self.request_reader.finish_request()
                self.respond(200, {"ok": True, "protocol": 1}); return
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
        self.request_reader.finish_request()
        try:
            response = run(self.server.program, request, command=self.server.command,
                           cwd=self.server.working_dir,
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
    parser.add_argument("--timeout-ms", type=int, default=5000)
    parser.add_argument("--max-body", type=int, default=65536)
    parser.add_argument("--cwd", help="Existing writable state directory; defaults to the program's directory")
    parser.add_argument("--allow-io", action="store_true")
    args = parser.parse_args()
    with SproutServer((args.host, args.port), args.program, command=args.command,
                      workers=args.workers, allow_io=args.allow_io,
                      timeout_ms=args.timeout_ms, max_body=args.max_body, cwd=args.cwd) as server:
        print(f"Sprout worker service at http://{args.host}:{server.server_port}", flush=True)
        stopping = threading.Event()
        def stop(_signal, _frame):
            if not stopping.is_set():
                stopping.set()
                # shutdown waits for serve_forever and must run on another thread.
                threading.Thread(target=server.shutdown, daemon=True).start()
        previous = signal.signal(signal.SIGTERM, stop)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass
        finally:
            signal.signal(signal.SIGTERM, previous)

if __name__ == "__main__": main()
