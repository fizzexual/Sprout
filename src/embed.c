/* Native host SDK: bounded subprocess execution, not shared global VM state. */
#ifndef _WIN32
#define _POSIX_C_SOURCE 200809L
#endif
#include "embed.h"
#include "process_native.h"
#include <ctype.h>

struct SproutHostCancel { PRCancel token; };
SproutHostCancel *sprout_host_cancel_new(void) {
  SproutHostCancel *cancel = (SproutHostCancel *)malloc(sizeof *cancel);
  if (cancel) atomic_init(&cancel->token.cancelled, 0);
  return cancel;
}
void sprout_host_cancel_request(SproutHostCancel *cancel) { if (cancel) atomic_store(&cancel->token.cancelled, 1); }
void sprout_host_cancel_free(SproutHostCancel *cancel) { free(cancel); }

unsigned sprout_host_abi_version(void) { return SPROUT_HOST_ABI_VERSION; }
void sprout_host_options_init(SproutHostOptions *options) {
  sprout_host_options_init_sized(options, offsetof(SproutHostOptions, max_memory_bytes));
}
void sprout_host_options_init_sized(SproutHostOptions *options, size_t struct_size) {
  if (!options) return;
  size_t clear = struct_size < sizeof *options ? struct_size : sizeof *options;
  memset(options, 0, clear);
  if (clear < offsetof(SproutHostOptions, max_memory_bytes)) return;
  options->struct_size = struct_size;
  options->timeout_ms = 5000; options->max_steps = 10000000;
  options->max_output_bytes = PR_DEFAULT_BYTES;
}
void sprout_host_result_free(SproutHostResult *result) {
  if (!result) return;
  free(result->output_json); free(result->diagnostics); free(result->error);
  memset(result, 0, sizeof *result);
}
static SproutHostStatus host_error(SproutHostResult *result, SproutHostStatus status, const char *message) {
  result->status = status; result->exit_code = -1; result->error = pr_strdup(message); return status;
}
static int host_absolute(const char *p) {
  if (!p || !*p) return 0;
#ifdef _WIN32
  return (isalpha((unsigned char)p[0]) && p[1] == ':' && (p[2] == '/' || p[2] == '\\')) || (p[0] == '\\' && p[1] == '\\');
#else
  return p[0] == '/';
#endif
}
static int host_utf8(const unsigned char *p, size_t n) {
  for (size_t i = 0; i < n;) {
    unsigned char c = p[i++]; if (c == 0) return 0; if (c < 0x80) continue;
    unsigned value; int continuation;
    if (c >= 0xc2 && c <= 0xdf) { continuation = 1; value = c & 31; }
    else if (c >= 0xe0 && c <= 0xef) { continuation = 2; value = c & 15; }
    else if (c >= 0xf0 && c <= 0xf4) { continuation = 3; value = c & 7; }
    else return 0;
    if (i + (size_t)continuation > n) return 0;
    for (int j = 0; j < continuation; j++) { unsigned char d = p[i++]; if ((d & 0xc0) != 0x80) return 0; value = (value << 6) | (d & 63); }
    if ((continuation == 1 && value < 0x80) || (continuation == 2 && value < 0x800) || (continuation == 3 && value < 0x10000) || value > 0x10ffff || (value >= 0xd800 && value <= 0xdfff)) return 0;
  }
  return 1;
}
static int host_one_line(const char *text, size_t length) {
  size_t start = 0, end = length;
  while (start < end && (text[start] == ' ' || text[start] == '\t' || text[start] == '\r' || text[start] == '\n')) start++;
  while (end > start && (text[end - 1] == ' ' || text[end - 1] == '\t' || text[end - 1] == '\r' || text[end - 1] == '\n')) end--;
  if (start == end) return 0;
  for (size_t i = start; i < end; i++) if (text[i] == '\r' || text[i] == '\n') return 0;
  return host_utf8((const unsigned char *)text + start, end - start);
}
SproutHostStatus sprout_host_run_cancellable(const SproutHostOptions *options, SproutHostResult *result, SproutHostCancel *cancel) {
  if (!result) return SPROUT_HOST_INVALID_ARGUMENT;
  memset(result, 0, sizeof *result); result->struct_size = sizeof *result; result->exit_code = -1;
  if (!options || options->struct_size < offsetof(SproutHostOptions, max_memory_bytes)) return host_error(result, SPROUT_HOST_INVALID_ARGUMENT, "host options must be initialized with sprout_host_options_init_sized");
  if (!host_absolute(options->executable) || !host_absolute(options->program) || (options->cwd && !host_absolute(options->cwd))) return host_error(result, SPROUT_HOST_INVALID_ARGUMENT, "executable, program, and optional cwd must use absolute paths");
  if (options->flags & ~SPROUT_HOST_ALLOW_IO) return host_error(result, SPROUT_HOST_INVALID_ARGUMENT, "unknown host flags");
  unsigned timeout = options->timeout_ms ? options->timeout_ms : 5000;
  uint64_t steps = options->max_steps ? options->max_steps : 10000000;
  size_t max = options->max_output_bytes ? options->max_output_bytes : PR_DEFAULT_BYTES;
  uint64_t memory = options->struct_size >= offsetof(SproutHostOptions, max_memory_bytes) + sizeof options->max_memory_bytes ? options->max_memory_bytes : 0;
  if (memory && (memory < 16u * 1024u * 1024u || memory > (1ULL << 46) || memory > SIZE_MAX)) return host_error(result, SPROUT_HOST_INVALID_ARGUMENT, "host memory cap must be zero or from 16 MiB to 64 TiB (within native size_t)");
  if (timeout > 3600000 || steps > 1000000000000ULL || max > PR_MAX_BYTES) return host_error(result, SPROUT_HOST_INVALID_ARGUMENT, "host limits exceed their supported ranges");
  const char *request = options->request_json ? options->request_json : "{}";
  size_t request_length = options->request_json && options->request_length ? options->request_length : strlen(request);
  if (request_length > PR_DEFAULT_BYTES || !host_utf8((const unsigned char *)request, request_length)) return host_error(result, SPROUT_HOST_INVALID_ARGUMENT, "request JSON must be UTF-8 without NUL bytes and at most 1 MiB");
  if (cancel && atomic_load(&cancel->token.cancelled)) return host_error(result, SPROUT_HOST_CANCELLED, "host execution cancelled before launch");
  char time_arg[32], step_arg[32]; snprintf(time_arg, sizeof time_arg, "%u", timeout); snprintf(step_arg, sizeof step_arg, "%llu", (unsigned long long)steps);
  char *argv[10]; int n = 0;
  argv[n++] = (char *)options->executable; argv[n++] = "run"; argv[n++] = (char *)options->program;
  argv[n++] = "--max-steps"; argv[n++] = step_arg; argv[n++] = "--timeout-ms"; argv[n++] = time_arg;
  if (!(options->flags & SPROUT_HOST_ALLOW_IO)) argv[n++] = "--sandbox";
  argv[n] = NULL;
  PRProcess child = pr_run_raw_limited(argv, n, options->cwd, request, request_length, (int)timeout, max, 0, cancel ? &cancel->token : NULL, memory);
  result->exit_code = child.exit_code; result->system_code = child.code; result->timed_out = child.timed_out; result->truncated = child.truncated;
  result->output_json = child.out; result->output_length = child.out_len; result->diagnostics = child.err; result->diagnostics_length = child.err_len; result->error = child.error;
  if (!result->output_json || !result->diagnostics) { result->status = SPROUT_HOST_NO_MEMORY; if (!result->error) result->error = pr_strdup("host capture allocation failed"); }
  else if (child.cancelled) { result->status = SPROUT_HOST_CANCELLED; if (!result->error) result->error = pr_strdup("host execution cancelled; owned process tree terminated"); }
  else if (child.timed_out) { result->status = SPROUT_HOST_TIMEOUT; if (!result->error) result->error = pr_strdup("host execution timed out; owned process tree terminated"); }
  else if (child.truncated) { result->status = SPROUT_HOST_OUTPUT_LIMIT; if (!result->error) result->error = pr_strdup("host output limit exceeded; owned process tree terminated"); }
  else if (child.error) result->status = SPROUT_HOST_START_FAILED;
  else if (child.exit_code) result->status = SPROUT_HOST_CHILD_FAILED;
  else if (!host_one_line(child.out, child.out_len)) { result->status = SPROUT_HOST_PROTOCOL_ERROR; result->error = pr_strdup("worker must emit exactly one UTF-8 JSON line; the caller must parse its JSON syntax"); }
  else result->status = SPROUT_HOST_OK;
  return result->status;
}
SproutHostStatus sprout_host_run(const SproutHostOptions *options, SproutHostResult *result) { return sprout_host_run_cancellable(options, result, NULL); }
