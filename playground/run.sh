#!/bin/sh
# Sprout playground runner — runs ONE untrusted submission, sandboxed and resource-limited.
#
# The program text arrives on stdin (or as a file path in $1). Output is the program's
# combined stdout+stderr, truncated to a cap. Works for both the one-shot container model
# (ephemeral container per run) and the long-lived web server (server.py calls this per
# request) — so it must clean up after itself and never let one run affect the next.
set -u

# Per-run resource limits (the host/container should ALSO cap memory/cpu/pids via Docker).
# Every limit here MUST apply: if one can't be set (a bad value, or above a hard limit the
# host imposed) the runner refuses to run instead of silently running without it.
limit() {   # limit <ulimit flag> <value> <what it is>
  ulimit "$1" "$2" 2>/dev/null \
    || { echo "runner: could not apply the $3 (ulimit $1 $2) — refusing to run" >&2; exit 71; }
}
limit -t "${SPROUT_CPU_SECONDS:-5}"  "CPU-time limit"        # RLIMIT_CPU, seconds
limit -v "${SPROUT_VMEM_KB:-262144}" "address-space limit"   # RLIMIT_AS, KB (~256 MB)
# NOTE: deliberately NO per-run process limit. RLIMIT_NPROC (`ulimit -u`, which this image's
# /bin/sh, dash, rejects — it spells it `-p`) counts EVERY process and thread of the uid, not
# just this run: the web server's own threads and other containers running as uid 10001 all
# count, so under load it would make this runner's own forks fail. The process cap is the
# container's pids cgroup (`--pids-limit` / compose `pids_limit`), and under --sandbox sprout
# can't start a process anyway (`system`, `get`, `explore` are off).
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
# 137 = SIGKILL: the wall-clock timeout, the CPU-time limit (dash sets soft = hard, so it is
# a KILL, not SIGXCPU), or the container's memory cap. They look the same from here.
{ [ "$rc" = 124 ] || [ "$rc" = 137 ]; } \
  && printf '\n[stopped: exceeded the time limit (%ss wall clock, %ss CPU) or the memory limit]\n' \
       "$wall" "${SPROUT_CPU_SECONDS:-5}"
exit 0
