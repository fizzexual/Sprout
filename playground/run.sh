#!/bin/sh
# Sprout playground runner — runs ONE untrusted submission, sandboxed and resource-limited.
#
# The program text arrives on stdin (or as a file path in $1). Output is the program's
# combined stdout+stderr, truncated to a cap. Works for both the one-shot container model
# (ephemeral container per run) and the long-lived web server (server.py calls this per
# request) — so it must clean up after itself and never let one run affect the next.
set -u

# Per-run resource limits (the host/container should ALSO cap memory/cpu/pids via Docker).
ulimit -t "${SPROUT_CPU_SECONDS:-5}"   2>/dev/null || true   # CPU seconds  (RLIMIT_CPU)
ulimit -v "${SPROUT_VMEM_KB:-262144}"  2>/dev/null || true   # address space (~256 MB)
ulimit -u "${SPROUT_PROCS:-64}"        2>/dev/null || true   # processes/threads (dash may ignore -u)
# NOTE: deliberately NO `ulimit -f`. Output is bounded by piping through `head -c` below,
# so a flood is truncated cleanly and the temp file never exceeds the cap. A hard
# RLIMIT_FSIZE instead SIGXFSZ's the writer mid-output (core dump, lost output, and it can
# take down this shell), which is far messier than a clean truncation. Disk is bounded by
# the container's tmpfs size cap.

cap="${SPROUT_MAX_OUTPUT_BYTES:-65536}"
wall="${SPROUT_WALL_SECONDS:-5}"

prog="${1:-}"
own_prog=""                                    # only delete the temp file WE created
if [ -z "$prog" ]; then
  prog="$(mktemp 2>/dev/null || echo /tmp/sub.$$)" || { echo "runner: no temp space" >&2; exit 70; }
  own_prog="$prog"
  cat > "$prog"                                # the submission, from stdin
fi
out="$(mktemp 2>/dev/null || echo /tmp/out.$$)" || { echo "runner: no temp space" >&2; exit 70; }
rcf="$(mktemp 2>/dev/null || echo /tmp/rc.$$)" || { echo "runner: no temp space" >&2; exit 70; }
# Never leak temp files (critical for the long-lived server: otherwise /tmp fills up).
trap 'rm -f "$out" "$rcf" $own_prog' EXIT INT TERM

# Run sandboxed with a wall-clock timeout, streaming through `head -c` so the captured
# output is truncated to the cap as it flows (the temp file stays <= cap; no huge files).
# The producer records sprout's real exit status in $rcf. If `head` stops early at the cap
# it closes the pipe, so the producer is SIGPIPE'd (status 141) — i.e. "hit the output cap".
{ timeout -s KILL "$wall" sprout --sandbox run "$prog" 2>&1; echo $? > "$rcf"; } \
  | head -c "$cap" > "$out"

rc="$(cat "$rcf" 2>/dev/null || echo 0)"
cat "$out"
[ "$(wc -c < "$out" 2>/dev/null || echo 0)" -ge "$cap" ] && printf '\n…[output truncated at %s bytes]\n' "$cap"
{ [ "$rc" = 124 ] || [ "$rc" = 137 ]; } && printf '\n[stopped: exceeded the %ss time limit]\n' "$wall"
exit 0
