/* Process-isolated C host ABI, version 1. Caller and runtime keep separate heaps. */
#ifndef SPROUT_EMBED_H
#define SPROUT_EMBED_H
#include <stddef.h>
#include <stdint.h>
#ifdef __cplusplus
extern "C" {
#endif
#define SPROUT_HOST_ABI_VERSION 1u
#define SPROUT_HOST_ALLOW_IO 1u

typedef enum {
  SPROUT_HOST_OK = 0,
  SPROUT_HOST_INVALID_ARGUMENT = 1,
  SPROUT_HOST_START_FAILED = 2,
  SPROUT_HOST_TIMEOUT = 3,
  SPROUT_HOST_OUTPUT_LIMIT = 4,
  SPROUT_HOST_CHILD_FAILED = 5,
  SPROUT_HOST_PROTOCOL_ERROR = 6,
  SPROUT_HOST_NO_MEMORY = 7,
  SPROUT_HOST_CANCELLED = 8
} SproutHostStatus;

typedef struct {
  size_t struct_size;
  const char *executable;       /* Absolute path to the native Sprout executable. */
  const char *program;          /* Absolute .sprout source path. */
  const char *cwd;              /* Optional absolute working directory. */
  const char *request_json;     /* UTF-8 JSON request; NULL means {}. */
  size_t request_length;        /* Explicit byte count; zero means strlen. */
  unsigned timeout_ms;          /* Zero means 5000; hard host deadline. */
  uint64_t max_steps;           /* Zero means 10000000. */
  size_t max_output_bytes;      /* Zero means 1 MiB per stream. */
  unsigned flags;               /* Sandbox by default; ALLOW_IO opts in. */
  uint64_t max_memory_bytes;    /* Zero disables OS memory cap. See platform semantics. */
} SproutHostOptions;

typedef struct {
  size_t struct_size;
  SproutHostStatus status;
  int exit_code;
  int system_code;
  int timed_out;
  int truncated;
  char *output_json;            /* malloc-owned UTF-8; caller parses JSON. */
  size_t output_length;
  char *diagnostics;            /* stderr, preserved without transcoding. */
  size_t diagnostics_length;
  char *error;                  /* malloc-owned host error, or NULL. */
} SproutHostResult;
typedef struct SproutHostCancel SproutHostCancel;

unsigned sprout_host_abi_version(void);
void sprout_host_options_init(SproutHostOptions *options);
/* Preferred for new callers: initialize only the caller-provided allocation.
   The original initializer intentionally keeps the ABI1 prefix size. */
void sprout_host_options_init_sized(SproutHostOptions *options, size_t struct_size);
/* Initialize a fresh result before each call. A child nonzero exit is reported
   in result.status, not as an unsafe longjmp into the host. Returns status. */
SproutHostStatus sprout_host_run(const SproutHostOptions *options, SproutHostResult *result);
SproutHostCancel *sprout_host_cancel_new(void);
void sprout_host_cancel_request(SproutHostCancel *cancel);
/* Keep the cancellation handle alive until run_cancellable returns and every
   concurrent cancel_request call has joined. */
void sprout_host_cancel_free(SproutHostCancel *cancel);
SproutHostStatus sprout_host_run_cancellable(const SproutHostOptions *options, SproutHostResult *result, SproutHostCancel *cancel);
void sprout_host_result_free(SproutHostResult *result);
#ifdef __cplusplus
}
#endif
#endif
