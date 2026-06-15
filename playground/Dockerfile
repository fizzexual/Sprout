# Hardened image for an online Sprout PLAYGROUND — runs untrusted submissions safely.
#
# Build from the REPO ROOT (the build needs src/sprout.c):
#   docker build -f playground/Dockerfile -t sprout-playground .
#
# Run ONE submission, ephemeral + locked down (see playground/README.md for every flag):
#   echo 'show 2 + 2' | docker run --rm -i --network none --memory 256m \
#     --pids-limit 64 --read-only --tmpfs /tmp:size=16m --cap-drop ALL \
#     --security-opt no-new-privileges sprout-playground

# ---- build: compile the interpreter (same flags as CI's Linux build) ----
FROM gcc:bookworm AS build
WORKDIR /b
COPY src/sprout.c .
RUN cc -O2 -Wall -s -o /sprout sprout.c -lm   # on Linux, Sprout links only libm

# ---- runtime: minimal, non-root, no compiler ----
FROM debian:bookworm-slim
# an unprivileged user with no home directory and no login shell
RUN useradd --no-create-home --shell /usr/sbin/nologin --uid 10001 runner
COPY --from=build /sprout /usr/local/bin/sprout
COPY playground/run.sh /usr/local/bin/run-sprout
# strip any CR (in case run.sh was checked out with CRLF on Windows) + make both executable
RUN sed -i 's/\r$//' /usr/local/bin/run-sprout && chmod 0555 /usr/local/bin/sprout /usr/local/bin/run-sprout
# Belt-and-suspenders: the sandbox is ON by default even if someone bypasses the entrypoint.
# These also serve as the runner's resource defaults.
ENV SPROUT_SANDBOX=1 \
    SPROUT_WALL_SECONDS=5 \
    SPROUT_CPU_SECONDS=5 \
    SPROUT_MAX_OUTPUT_BYTES=65536 \
    SPROUT_VMEM_KB=262144 \
    SPROUT_PROCS=64
USER runner
WORKDIR /tmp
ENTRYPOINT ["/usr/local/bin/run-sprout"]
