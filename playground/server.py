#!/usr/bin/env python3
"""Sprout playground web server — a thin, dependency-free HTTP front-end.

It serves a one-page editor and a POST /run endpoint. Every submission is handed
to the already-hardened runner (`/usr/local/bin/run-sprout`, i.e. playground/run.sh),
which runs `sprout --sandbox` with a wall-clock + CPU timeout, output cap, and ulimits.
This server adds NOTHING that touches the untrusted code itself — it only does HTTP,
caps the request size, caps concurrency, and shows the runner's (already capped) output.

Standard library only (no pip). Meant to run as a NON-ROOT user inside the locked-down
container defined by docker-compose.yml / playground/Dockerfile.web.
"""
import json
import os
import socket
import subprocess
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

RUNNER = os.environ.get("SPROUT_RUNNER", "/usr/local/bin/run-sprout")
PORT = int(os.environ.get("PORT", "8080"))
WALL = int(os.environ.get("SPROUT_WALL_SECONDS", "5"))
MAX_INPUT = int(os.environ.get("SPROUT_MAX_INPUT_BYTES", "65536"))
MAX_OUTPUT = int(os.environ.get("SPROUT_MAX_OUTPUT_BYTES", "65536"))
MAX_CONCURRENT = int(os.environ.get("SPROUT_MAX_CONCURRENT", "4"))
# Hard cap on simultaneous TCP connections (NOT runs) — bounds threads/FDs/pids so a
# slowloris flood of dripping connections can't exhaust them and wedge the shared server.
MAX_CONNECTIONS = int(os.environ.get("SPROUT_MAX_CONNECTIONS", "64"))
# Total wall-clock budget for ONE request, enforced by a watchdog that force-closes the
# socket. Unlike the per-recv idle timeout, this kills slow-drip clients no matter how they
# pace their bytes. Comfortably above the runner's own WALL + subprocess backstop.
REQUEST_DEADLINE = int(os.environ.get("SPROUT_REQUEST_DEADLINE", str(WALL + 15)))

# One permit per concurrent run. Excess requests get 429 instead of piling up threads.
_slots = threading.BoundedSemaphore(MAX_CONCURRENT)

SAMPLE = """~ Welcome to the Sprout playground. Edit and press Run (Ctrl+Enter).
make squares = [n * n for each n in 1 to 10]
show "squares: " + squares
show "sum:     " + (squares |> sum)

task greet(name):
    give "hello, " + name + "!"
show greet("world")
"""

PAGE = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sprout playground</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 15px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
         background: #0f1410; color: #d7e4d2; }
  header { padding: 14px 20px; border-bottom: 1px solid #25341f;
           display: flex; align-items: center; gap: 10px; }
  header h1 { font-size: 16px; margin: 0; font-weight: 600; }
  header .leaf { font-size: 20px; }
  header .tag { margin-left: auto; font-size: 12px; color: #7fa06f; }
  main { display: grid; grid-template-rows: 1fr auto 1fr; gap: 0; height: calc(100vh - 51px); }
  textarea { width: 100%; height: 100%; resize: none; border: 0; outline: 0;
             background: #0f1410; color: #e7f1e2; padding: 16px 20px;
             font: inherit; tab-size: 4; }
  .bar { display: flex; align-items: center; gap: 12px; padding: 8px 20px;
         background: #16201180; border-top: 1px solid #25341f; border-bottom: 1px solid #25341f; }
  button { font: inherit; font-weight: 600; cursor: pointer; border: 0; border-radius: 6px;
           padding: 7px 18px; background: #4f9e3f; color: #06140a; }
  button:disabled { opacity: .5; cursor: default; }
  .bar .hint { font-size: 12px; color: #6f8a62; }
  pre#out { margin: 0; padding: 16px 20px; overflow: auto; white-space: pre-wrap;
            word-break: break-word; background: #0c100a; color: #cfe0c8; }
  pre#out.err { color: #f2b8a2; }
</style>
</head>
<body>
<header>
  <span class="leaf">&#127793;</span>
  <h1>Sprout playground</h1>
  <span class="tag">sandboxed &middot; no files, shell, or network</span>
</header>
<main>
  <textarea id="src" spellcheck="false" autocapitalize="off" autocomplete="off"></textarea>
  <div class="bar">
    <button id="run">Run &#9654;</button>
    <span class="hint">Ctrl/&#8984;+Enter</span>
    <span class="hint" id="status"></span>
  </div>
  <pre id="out"></pre>
</main>
<script>
  const src = document.getElementById('src');
  const out = document.getElementById('out');
  const btn = document.getElementById('run');
  const status = document.getElementById('status');
  src.value = __SAMPLE__;
  async function run() {
    btn.disabled = true; status.textContent = 'running...'; out.className = '';
    out.textContent = '';
    try {
      const res = await fetch('run', { method: 'POST',
        headers: { 'Content-Type': 'text/plain' }, body: src.value });
      if (res.status === 429) { out.className = 'err';
        out.textContent = 'The playground is busy. Try again in a moment.';
        return; }
      const data = await res.json();
      // The runner already appends any '[stopped: ...]' / '[output truncated]' notes.
      out.className = data.timed_out ? 'err' : '';
      out.textContent = data.output || '(no output)';
    } catch (e) { out.className = 'err'; out.textContent = 'Could not reach the server.'; }
    finally { btn.disabled = false; status.textContent = ''; }
  }
  btn.addEventListener('click', run);
  src.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); run(); }
  });
</script>
</body>
</html>
"""


def _page():
    return PAGE.replace("__SAMPLE__", json.dumps(SAMPLE))


class Handler(BaseHTTPRequestHandler):
    # Per-recv IDLE timeout. NOTE: this alone does not stop slowloris (a client can dribble
    # one byte just under it forever); the total-request watchdog below is what bounds that.
    timeout = 10
    # HTTP/1.0 => one request per connection (no keep-alive), so the watchdog deadline below
    # really is a per-request budget and connections don't linger.
    protocol_version = "HTTP/1.0"
    server_version = "sprout-playground"
    sys_version = ""  # don't advertise the Python version

    def setup(self):
        super().setup()
        # Hard total-request deadline: force-close the socket after REQUEST_DEADLINE seconds
        # regardless of how the client paces its bytes. This is the real slowloris guard —
        # it caps how long any one connection can occupy a worker thread / connection slot.
        self._watchdog = threading.Timer(REQUEST_DEADLINE, self._expire)
        self._watchdog.daemon = True
        self._watchdog.start()

    def _expire(self):
        try:
            self.connection.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass

    def finish(self):
        wd = getattr(self, "_watchdog", None)
        if wd is not None:
            wd.cancel()
        super().finish()

    def _send(self, code, body, ctype="application/json; charset=utf-8"):
        if isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Content-Security-Policy",
                         "default-src 'none'; style-src 'unsafe-inline'; "
                         "script-src 'unsafe-inline'; connect-src 'self'")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path == "/" or path == "/index.html":
            self._send(200, _page(), "text/html; charset=utf-8")
        elif path == "/health":
            self._send(200, json.dumps({"ok": True}))
        else:
            self._send(404, json.dumps({"error": "not found"}))

    do_HEAD = do_GET

    def do_POST(self):
        if self.path.split("?", 1)[0] != "/run":
            self._send(404, json.dumps({"error": "not found"}))
            return

        # Read the body with a HARD cap — never trust Content-Length blindly.
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = -1
        if length < 0 or length > MAX_INPUT:
            self._send(413, json.dumps({"error": "program too large"}))
            return
        code = self.rfile.read(length) if length else b""

        # Cap concurrency: if every slot is busy, shed load instead of queueing.
        if not _slots.acquire(blocking=False):
            self._send(429, json.dumps({"error": "busy"}))
            return
        try:
            output, timed_out = self._run(code)
        finally:
            _slots.release()

        truncated = len(output) > MAX_OUTPUT
        if truncated:
            output = output[:MAX_OUTPUT]
        self._send(200, json.dumps({
            "output": output.decode("utf-8", "replace"),
            "timed_out": timed_out,
            "truncated": truncated,
        }))

    def _run(self, code):
        """Hand the submission to the hardened runner. Returns (output_bytes, timed_out)."""
        try:
            proc = subprocess.run(
                [RUNNER],
                input=code,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                timeout=WALL + 3,      # backstop above the runner's own wall-clock timeout
                env=os.environ,
                close_fds=True,
            )
            out = proc.stdout or b""
            # The runner prints its own "[stopped: ... time limit]" note on timeout.
            timed_out = b"time limit" in out
            return out, timed_out
        except subprocess.TimeoutExpired as e:
            return (e.stdout or b"") + b"\n[stopped: time limit]", True
        except Exception:
            # Never leak internals to the client.
            return b"internal error running the program", False

    def log_message(self, *args):
        pass  # quiet; the container/proxy handles access logs


class Server(ThreadingHTTPServer):
    """ThreadingHTTPServer with a HARD cap on simultaneous connections.

    Without this, one thread is spawned per connection with no upper bound, so a flood of
    slow-drip (slowloris) connections exhausts threads / file descriptors / the container's
    pid limit and wedges the service for everyone. Here, excess connections are dropped
    immediately instead of spawning a worker thread.
    """
    daemon_threads = True
    _conns = threading.BoundedSemaphore(MAX_CONNECTIONS)

    def process_request(self, request, client_address):
        if not self._conns.acquire(blocking=False):
            try:
                request.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            self.close_request(request)
            return
        super().process_request(request, client_address)   # spawns the worker thread

    def shutdown_request(self, request):
        try:
            super().shutdown_request(request)
        finally:
            self._conns.release()   # always reached by the worker thread's finally-block


def main():
    httpd = Server(("0.0.0.0", PORT), Handler)
    print("sprout playground on :%d (runner=%s, wall=%ss, max_in=%dB, conc=%d, "
          "max_conn=%d, deadline=%ss)"
          % (PORT, RUNNER, WALL, MAX_INPUT, MAX_CONCURRENT, MAX_CONNECTIONS, REQUEST_DEADLINE),
          flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
