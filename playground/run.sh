#!/bin/sh
# Sprout playground runner — runs ONE untrusted submission, sandboxed and resource-limited.
#
# The program text arrives on stdin (or as a file path in $1). Output is the program's
# combined stdout+stderr, capped. Meant to run as a NON-ROOT user inside an ephemeral,
# locked-down container (see README.md) — this script is defence in depth, not the only
# defence. Tunable via env vars (defaults set in the Dockerfile).
set -u

# In-container resource limits. The host should ALSO cap memory/cpu/pids via `docker run`.
ulimit -t "${SPROUT_CPU_SECONDS:-5}"   2>/dev/null || true   # CPU seconds (SIGKILL past this)
ulimit -v "${SPROUT_VMEM_KB:-262144}"  2>/dev/null || true   # address space (~256 MB)
ulimit -f "${SPROUT_FILE_KB:-8192}"    2>/dev/null || true   # max file written (bounds the temp)
ulimit -u "${SPROUT_PROCS:-64}"        2>/dev/null || true   # processes/threads (fork-bomb cap)

prog="${1:-}"
if [ -z "$prog" ]; then
  prog="$(mktemp 2>/dev/null || echo /tmp/sub.$$)" || { echo "runner: no temp space" >&2; exit 70; }
  cat > "$prog"                                # the submission, from stdin
fi

cap="${SPROUT_MAX_OUTPUT_BYTES:-65536}"
out="$(mktemp 2>/dev/null || echo /tmp/out.$$)" || { echo "runner: no temp space" >&2; exit 70; }

# Wall-clock timeout catches loops that print nothing; ulimit -f bounds the captured output;
# SPROUT_SANDBOX=1 (set in the image) blocks every file / shell / network builtin.
timeout -s KILL "${SPROUT_WALL_SECONDS:-5}" sprout --sandbox run "$prog" > "$out" 2>&1
rc=$?

head -c "$cap" "$out"
[ "$(wc -c < "$out" 2>/dev/null || echo 0)" -gt "$cap" ] && printf '\n…[output truncated at %s bytes]\n' "$cap"
{ [ "$rc" = 124 ] || [ "$rc" = 137 ]; } && printf '\n[stopped: exceeded the %ss time limit]\n' "${SPROUT_WALL_SECONDS:-5}"
exit 0
