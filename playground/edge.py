#!/usr/bin/env python3
"""Sprout playground edge relay — the ONLY container in docker-compose.yml with a published port.

docker-compose.yml runs two containers from the same image:

    browser --> edge (this file; on the `public` and `sandbox` networks)
                  --> sprout-playground (server.py + run.sh; on `sandbox` ONLY)

`sandbox` is an `internal: true` network: Docker gives it no route off the host, so the
container that runs untrusted code has no network egress at all. Even code that got past
`sprout --sandbox` could not reach the internet or a cloud metadata endpoint. The server has
to be reachable for HTTP, and an internal network can't publish a port, so this relay is
the one door in. It forwards raw TCP to ONE fixed upstream and nothing else, so it can't be
used as an open proxy, and it never runs submitted code.

Standard library only. Usage:  edge.py <upstream-host> <upstream-port> [listen-port]
"""
import socket
import sys
import threading

UPSTREAM = (sys.argv[1], int(sys.argv[2]))
LISTEN_PORT = int(sys.argv[3]) if len(sys.argv) > 3 else 8080
# Bounds this relay's threads/FDs. Above server.py's own connection cap (64), which still
# decides; a flood beyond this is dropped here before it costs a thread.
MAX_CONNECTIONS = 128
# A connection that moves no bytes either way for this long is closed. server.py's own
# per-request deadline bounds a slow-drip client well before this.
IDLE_SECONDS = 30

_slots = threading.BoundedSemaphore(MAX_CONNECTIONS)


def _pump(src, dst):
    """Copy src -> dst until EOF or an error, then half-close dst so its peer sees EOF."""
    try:
        while True:
            data = src.recv(65536)
            if not data:
                break
            dst.sendall(data)
    except OSError:
        pass
    finally:
        try:
            dst.shutdown(socket.SHUT_WR)
        except OSError:
            pass


def _relay(client):
    upstream = None
    try:
        client.settimeout(IDLE_SECONDS)
        upstream = socket.create_connection(UPSTREAM, timeout=5)
        upstream.settimeout(IDLE_SECONDS)
        back = threading.Thread(target=_pump, args=(upstream, client), daemon=True)
        back.start()
        _pump(client, upstream)
        back.join()
    except OSError:
        pass  # upstream down or connection reset: just drop this client
    finally:
        for s in (client, upstream):
            if s is not None:
                try:
                    s.close()
                except OSError:
                    pass
        _slots.release()


def main():
    srv = socket.create_server(("0.0.0.0", LISTEN_PORT), backlog=128)
    print("sprout playground edge on :%d -> %s:%d (max_conn=%d)"
          % (LISTEN_PORT, UPSTREAM[0], UPSTREAM[1], MAX_CONNECTIONS), flush=True)
    while True:
        try:
            client, _ = srv.accept()
        except OSError:
            continue
        if not _slots.acquire(blocking=False):
            client.close()   # over the cap: drop instead of spawning a thread
            continue
        threading.Thread(target=_relay, args=(client,), daemon=True).start()


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass
