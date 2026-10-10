/* Shared native subprocess backend: no VM/Value/global runtime dependencies. */
#ifndef SPROUT_PROCESS_NATIVE_H
#define SPROUT_PROCESS_NATIVE_H
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>
#include <stdint.h>
#include <time.h>
#include <stdatomic.h>
#ifdef _WIN32
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include <wchar.h>
#include <io.h>
#include <fcntl.h>
#else
#include <unistd.h>
#include <fcntl.h>
#include <sys/wait.h>
#include <sys/resource.h>
#include <signal.h>
#include <poll.h>
#ifdef __linux__
#include <sys/syscall.h>
extern long syscall(long, ...);
#endif
#endif
static inline char *pr_strdup(const char *s) {
  size_t n = strlen(s) + 1; char *p = (char *)malloc(n);
  if (p) memcpy(p, s, n);
  return p;
}
#define PR_MAX_BYTES (16u * 1024u * 1024u)
#define PR_DEFAULT_BYTES (1024u * 1024u)
#define PR_DEFAULT_TIMEOUT 30000
typedef struct { char *p; size_t n, cap; int truncated, binary; } PRBuffer;
static inline int pr_append(PRBuffer *b, const char *p, size_t n, size_t limit) {
  if (memchr(p, 0, n)) b->binary = 1;
  if (n > limit - b->n) { n = limit - b->n; b->truncated = 1; }
  if (b->n + n + 1 > b->cap) {
    size_t cap = b->cap ? b->cap : 256;
    while (cap < b->n + n + 1) cap *= 2;
    char *r = (char *)realloc(b->p, cap);
    if (!r) return 0;
    b->p = r; b->cap = cap;
  }
  if (n) memcpy(b->p + b->n, p, n);
  b->n += n; b->p[b->n] = 0; return 1;
}
static inline char *pr_buffer_take(PRBuffer *b) { return b->p ? b->p : pr_strdup(""); }
static inline unsigned long long pr_clock_ms(void) {
#ifdef _WIN32
  return GetTickCount64();
#else
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return (unsigned long long)ts.tv_sec * 1000 + (unsigned long long)ts.tv_nsec / 1000000;
#endif
}
#ifdef _WIN32
static inline wchar_t *pr_wide(const char *s) {
  int n = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, s, -1, NULL, 0);
  if (!n) return NULL;
  wchar_t *w = (wchar_t *)malloc((size_t)n * sizeof(wchar_t));
  if (!w) return NULL;
  if (!MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, s, -1, w, n)) { free(w); return NULL; }
  return w;
}
static inline char *pr_utf8(const wchar_t *s) {
  int n = WideCharToMultiByte(CP_UTF8, 0, s, -1, NULL, 0, NULL, NULL);
  if (!n) return NULL;
  char *p = (char *)malloc((size_t)n); if (!p) return NULL;
  if (!WideCharToMultiByte(CP_UTF8, 0, s, -1, p, n, NULL, NULL)) { free(p); return NULL; }
  return p;
}
#endif
/* Captures both pipes concurrently, with a process-tree deadline and finite output.
   This raw helper has no Sprout allocations and is reusable by host/worker code. */
typedef struct {
  int exit_code, timed_out, truncated, code, cancelled;
  char *error, *out, *err;
  size_t out_len, err_len;
} PRProcess;
typedef struct { _Atomic int cancelled; } PRCancel;
static inline void pr_process_free(PRProcess *r) { free(r->error); free(r->out); free(r->err); }
static inline PRProcess pr_process_error(const char *message, int code) {
  PRProcess r = {0}; r.exit_code = -1; r.code = code; r.error = pr_strdup(message);
  r.out = pr_strdup(""); r.err = pr_strdup(""); return r;
}
#ifdef _WIN32
/* Windows CRT argv quoting: backslashes before quotes/end are doubled. */
static inline int pr_arg_quote(PRBuffer *b, const char *arg) {
  if (!pr_append(b, "\"", 1, 32760)) return 0;
  const char *p = arg;
  while (*p) {
    int slashes = 0; while (*p == '\\') { slashes++; p++; }
    int count = (*p == '\"' || !*p) ? slashes * 2 : slashes;
    for (int i = 0; i < count; i++) if (!pr_append(b, "\\", 1, 32760)) return 0;
    if (*p == '\"' && !pr_append(b, "\\", 1, 32760)) return 0;
    if (*p && !pr_append(b, p++, 1, 32760)) return 0;
  }
  return pr_append(b, "\"", 1, 32760);
}
static inline int pr_drain_handle(HANDLE h, PRBuffer *b, size_t max, int binary) {
  char chunk[4096]; DWORD available = 0, got = 0;
  if (!PeekNamedPipe(h, NULL, 0, NULL, &available, NULL)) return GetLastError() == ERROR_BROKEN_PIPE ? 0 : -1;
  while (available) {
    DWORD take = available < sizeof chunk ? available : sizeof chunk;
    if (!ReadFile(h, chunk, take, &got, NULL)) return GetLastError() == ERROR_BROKEN_PIPE ? 0 : -1;
    if (!got) return 0;
    if (!pr_append(b, chunk, got, max)) return -1;
    if (b->truncated || (!binary && b->binary)) return 1;
    if (!PeekNamedPipe(h, NULL, 0, NULL, &available, NULL)) return GetLastError() == ERROR_BROKEN_PIPE ? 0 : -1;
  }
  return 1;
}
static inline PRProcess pr_run_raw_limited(char **argv, int argc, const char *cwd, const char *input, size_t input_len, int timeout_ms, size_t max_output, int binary, PRCancel *cancel, uint64_t max_memory_bytes) {
  PRProcess r = {0}; r.exit_code = -1;
  PRBuffer command = {0}, out = {0}, err = {0};
  for (int i = 0; i < argc; i++) {
    if ((i && !pr_append(&command, " ", 1, 32760)) || !pr_arg_quote(&command, argv[i])) { free(command.p); return pr_process_error("process: command is too large or memory allocation failed", E2BIG); }
  }
  if (command.truncated) { free(command.p); return pr_process_error("process: command exceeds Windows command-line limit", E2BIG); }
  wchar_t *cmd = pr_wide(command.p), *wcwd = cwd && *cwd ? pr_wide(cwd) : NULL;
  free(command.p);
  if (!cmd || (cwd && *cwd && !wcwd)) { free(cmd); free(wcwd); return pr_process_error("process: executable, arguments, and cwd must be UTF-8", EINVAL); }
  HANDLE orh = NULL, owh = NULL, erh = NULL, ewh = NULL, in = INVALID_HANDLE_VALUE, job = NULL;
  SECURITY_ATTRIBUTES sa = {sizeof(sa), NULL, TRUE}; PROCESS_INFORMATION pi = {0}; STARTUPINFOEXW si = {0};
  int attributes_ready = 0;
  FILE *input_file = NULL; DWORD code = 0;
  if (!CreatePipe(&orh, &owh, &sa, 0) || !CreatePipe(&erh, &ewh, &sa, 0) ||
      !SetHandleInformation(orh, HANDLE_FLAG_INHERIT, 0) || !SetHandleInformation(erh, HANDLE_FLAG_INHERIT, 0)) { code = GetLastError(); goto setup_error; }
  if (input && input_len) {
    input_file = tmpfile();
    if (input_file) _setmode(_fileno(input_file), _O_BINARY);
    if (!input_file || fwrite(input, 1, input_len, input_file) != input_len || fflush(input_file) || fseek(input_file, 0, SEEK_SET)) { code = ERROR_WRITE_FAULT; goto setup_error; }
    if (!DuplicateHandle(GetCurrentProcess(), (HANDLE)_get_osfhandle(_fileno(input_file)), GetCurrentProcess(), &in, 0, TRUE, DUPLICATE_SAME_ACCESS)) { code = GetLastError(); goto setup_error; }
  } else {
    in = CreateFileW(L"NUL", GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, &sa, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
    if (in == INVALID_HANDLE_VALUE) { code = GetLastError(); goto setup_error; }
  }
  job = CreateJobObjectW(NULL, NULL);
  if (!job) { code = GetLastError(); goto setup_error; }
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = {0}; limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  if (max_memory_bytes) {
    if (max_memory_bytes > SIZE_MAX) { code = ERROR_INVALID_PARAMETER; goto setup_error; }
    limits.BasicLimitInformation.LimitFlags |= JOB_OBJECT_LIMIT_JOB_MEMORY;
    limits.JobMemoryLimit = (SIZE_T)max_memory_bytes;
  }
  if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof limits)) { code = GetLastError(); goto setup_error; }
  si.StartupInfo.cb = sizeof si; si.StartupInfo.dwFlags = STARTF_USESTDHANDLES | STARTF_USESHOWWINDOW; si.StartupInfo.wShowWindow = SW_HIDE;
  si.StartupInfo.hStdInput = in; si.StartupInfo.hStdOutput = owh; si.StartupInfo.hStdError = ewh;
  SIZE_T bytes = 0; InitializeProcThreadAttributeList(NULL, 1, 0, &bytes);
  si.lpAttributeList = (LPPROC_THREAD_ATTRIBUTE_LIST)malloc(bytes);
  if (!si.lpAttributeList || !InitializeProcThreadAttributeList(si.lpAttributeList, 1, 0, &bytes)) { code = GetLastError(); goto setup_error; }
  attributes_ready = 1; HANDLE inherited[] = {in, owh, ewh};
  if (!UpdateProcThreadAttribute(si.lpAttributeList, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, inherited, sizeof inherited, NULL, NULL)) { code = GetLastError(); goto setup_error; }
  /* Suspended start closes the race where a child escapes before job assignment. */
  if (!CreateProcessW(NULL, cmd, NULL, NULL, TRUE, CREATE_NO_WINDOW | CREATE_SUSPENDED | EXTENDED_STARTUPINFO_PRESENT, NULL, wcwd, &si.StartupInfo, &pi)) { code = GetLastError(); goto setup_error; }
  if (!AssignProcessToJobObject(job, pi.hProcess)) { code = GetLastError(); TerminateProcess(pi.hProcess, 127); WaitForSingleObject(pi.hProcess, INFINITE); goto setup_error; }
  CloseHandle(owh); owh = NULL; CloseHandle(ewh); ewh = NULL; CloseHandle(in); in = INVALID_HANDLE_VALUE;
  if (input_file) { fclose(input_file); input_file = NULL; }
  if (ResumeThread(pi.hThread) == (DWORD)-1) { code = GetLastError(); TerminateJobObject(job, 127); goto setup_error; }
  CloseHandle(pi.hThread); pi.hThread = NULL;
  unsigned long long start = pr_clock_ms(); int ended = 0, terminated = 0;
  while (!ended) {
    int o = pr_drain_handle(orh, &out, max_output, binary), e = pr_drain_handle(erh, &err, max_output, binary);
    if (o < 0 || e < 0) { r.error = pr_strdup("process: could not capture output"); r.code = EIO; terminated = 1; }
    if (!binary && (out.binary || err.binary)) { r.error = pr_strdup("process: output contains a NUL byte; text capture cannot represent binary data"); r.code = EILSEQ; terminated = 1; }
    if (out.truncated || err.truncated) { r.truncated = 1; terminated = 1; }
    if (pr_clock_ms() - start >= (unsigned)timeout_ms) { r.timed_out = 1; terminated = 1; }
    if (cancel && atomic_load(&cancel->cancelled)) { r.cancelled = 1; r.code = ECANCELED; terminated = 1; }
    if (terminated) { TerminateJobObject(job, 124); WaitForSingleObject(pi.hProcess, INFINITE); ended = 1; }
    else if (WaitForSingleObject(pi.hProcess, 5) == WAIT_OBJECT_0) ended = 1;
  }
  /* Closing job also terminates descendants after the root has exited; inherited pipes cannot hang us. */
  CloseHandle(job); job = NULL;
  pr_drain_handle(orh, &out, max_output, binary); pr_drain_handle(erh, &err, max_output, binary);
  GetExitCodeProcess(pi.hProcess, &code); r.exit_code = (int)code;
  r.truncated |= out.truncated || err.truncated;
  if (!binary && (out.binary || err.binary) && !r.error) { r.error = pr_strdup("process: output contains a NUL byte"); r.code = EILSEQ; }
  goto cleanup;
setup_error:
  if (pi.hProcess) { TerminateProcess(pi.hProcess, 127); WaitForSingleObject(pi.hProcess, INFINITE); }
  { char msg[120]; snprintf(msg, sizeof msg, "process: unable to start executable (Windows error %lu)", (unsigned long)code); r.error = pr_strdup(msg); r.code = (int)code; }
cleanup:
  if (input_file) fclose(input_file);
  if (in != INVALID_HANDLE_VALUE) CloseHandle(in);
  if (owh) CloseHandle(owh);
  if (ewh) CloseHandle(ewh);
  if (orh) CloseHandle(orh);
  if (erh) CloseHandle(erh);
  if (pi.hThread) CloseHandle(pi.hThread);
  if (pi.hProcess) CloseHandle(pi.hProcess);
  if (job) CloseHandle(job);
  if (attributes_ready) DeleteProcThreadAttributeList(si.lpAttributeList);
  free(si.lpAttributeList);
  free(cmd); free(wcwd); r.out_len = out.n; r.err_len = err.n; r.out = pr_buffer_take(&out); r.err = pr_buffer_take(&err); return r;
}
#elif !defined(__EMSCRIPTEN__)
static inline PRProcess pr_run_raw_limited(char **argv, int argc, const char *cwd, const char *input, size_t input_len, int timeout_ms, size_t max_output, int binary, PRCancel *cancel, uint64_t max_memory_bytes) {
  (void)argc; PRProcess r = {0}; r.exit_code = -1;
  int op[2] = {-1,-1}, ep[2] = {-1,-1}, xp[2] = {-1,-1}; FILE *in = tmpfile();
  if (!in || (input && fwrite(input, 1, input_len, in) != input_len) || fflush(in) || fseek(in, 0, SEEK_SET) || pipe(op) || pipe(ep) || pipe(xp)) {
    int e = errno; if (in) fclose(in); for (int i = 0; i < 2; i++) { if (op[i] >= 0) close(op[i]); if (ep[i] >= 0) close(ep[i]); if (xp[i] >= 0) close(xp[i]); }
    return pr_process_error(strerror(e), e);
  }
  for (int i = 0; i < 2; i++) { fcntl(op[i], F_SETFD, FD_CLOEXEC); fcntl(ep[i], F_SETFD, FD_CLOEXEC); fcntl(xp[i], F_SETFD, FD_CLOEXEC); }
  fcntl(fileno(in), F_SETFD, FD_CLOEXEC);
  long descriptor_limit = sysconf(_SC_OPEN_MAX); if (descriptor_limit < 0) descriptor_limit = 1024;
  pid_t pid = fork();
  if (pid == 0) {
    close(op[0]); close(ep[0]); close(xp[0]);
    int e = 0;
    if (setpgid(0, 0) || dup2(fileno(in), STDIN_FILENO) < 0 || dup2(op[1], STDOUT_FILENO) < 0 || dup2(ep[1], STDERR_FILENO) < 0 || (cwd && *cwd && chdir(cwd))) e = errno;
    if (!e && max_memory_bytes) {
      struct rlimit memory = {(rlim_t)max_memory_bytes, (rlim_t)max_memory_bytes};
      if ((uint64_t)memory.rlim_cur != max_memory_bytes || setrlimit(RLIMIT_AS, &memory)) e = errno ? errno : EINVAL;
    }
    /* No malloc/stdio cleanup after fork: another host thread may have held a
       libc lock. Keep only stdio + an exec-error descriptor across this phase. */
    int error_fd = 3;
    if (xp[1] != error_fd && dup2(xp[1], error_fd) < 0) { error_fd = xp[1]; if (!e) e = errno; }
    fcntl(error_fd, F_SETFD, FD_CLOEXEC);
    int closed_all = 0;
#if defined(__linux__) && defined(SYS_close_range)
    if (error_fd == 3 && syscall(SYS_close_range, 4u, ~0u, 0u) == 0) closed_all = 1;
#endif
    if (!closed_all) for (long fd = 3; fd < descriptor_limit; fd++) if (fd != error_fd) close((int)fd);
    if (!e) { execvp(argv[0], argv); e = errno; }
    (void)write(error_fd, &e, sizeof e); _exit(127);
  }
  close(op[1]); close(ep[1]); close(xp[1]); fclose(in);
  if (pid < 0) { int e = errno; close(op[0]); close(ep[0]); close(xp[0]); return pr_process_error(strerror(e), e); }
  setpgid(pid, pid); fcntl(op[0], F_SETFL, O_NONBLOCK); fcntl(ep[0], F_SETFL, O_NONBLOCK); fcntl(xp[0], F_SETFL, O_NONBLOCK);
  PRBuffer out = {0}, err = {0}; int status = 0, done = 0, killed = 0, openo = 1, opene = 1;
  unsigned long long start = pr_clock_ms();
  while (!done || openo || opene) {
    struct pollfd ps[2] = {{op[0], POLLIN | POLLHUP, 0}, {ep[0], POLLIN | POLLHUP, 0}};
    if (poll(ps, 2, 5) < 0 && errno != EINTR) { r.error = pr_strdup("process: failed to poll output"); r.code = errno; killed = 1; }
    for (int i = 0; i < 2; i++) {
      int *isopen = i ? &opene : &openo; if (!*isopen) continue;
      PRBuffer *b = i ? &err : &out; char chunk[4096]; ssize_t nread;
      while ((nread = read(i ? ep[0] : op[0], chunk, sizeof chunk)) > 0) {
        if (!pr_append(b, chunk, (size_t)nread, max_output)) { r.error = pr_strdup("process: memory allocation failed"); r.code = ENOMEM; killed = 1; break; }
        if ((!binary && b->binary) || b->truncated) break;
      }
      if (nread == 0) *isopen = 0;
      else if (nread < 0 && errno != EAGAIN && errno != EINTR) { *isopen = 0; if (!r.error) { r.error = pr_strdup("process: could not read output"); r.code = errno; } killed = 1; }
    }
    if (!binary && (out.binary || err.binary)) { if (!r.error) r.error = pr_strdup("process: output contains a NUL byte; text capture cannot represent binary data"); r.code = EILSEQ; killed = 1; }
    if (out.truncated || err.truncated) { r.truncated = 1; killed = 1; }
    if (!done && pr_clock_ms() - start >= (unsigned)timeout_ms) { r.timed_out = 1; killed = 1; }
    if (cancel && atomic_load(&cancel->cancelled)) { r.cancelled = 1; r.code = ECANCELED; killed = 1; }
    if (killed) { kill(-pid, SIGKILL); if (!done) { while (waitpid(pid, &status, 0) < 0 && errno == EINTR) {} done = 1; } }
    if (!done) { pid_t w = waitpid(pid, &status, WNOHANG); if (w == pid) { done = 1; kill(-pid, SIGKILL); } else if (w < 0 && errno != EINTR) { done = 1; killed = 1; } }
    /* Descendants may be outside a process group only if deliberately detached.
       Never wait indefinitely for inherited handles after the root exits. */
    if (done) { kill(-pid, SIGKILL); if (pr_clock_ms() - start >= (unsigned)timeout_ms || killed) break; }
  }
  int exec_error = 0; if (read(xp[0], &exec_error, sizeof exec_error) == sizeof exec_error) { if (!r.error) r.error = pr_strdup(strerror(exec_error)); r.code = exec_error; }
  close(op[0]); close(ep[0]); close(xp[0]);
  r.exit_code = WIFEXITED(status) ? WEXITSTATUS(status) : WIFSIGNALED(status) ? 128 + WTERMSIG(status) : -1;
  r.out_len = out.n; r.err_len = err.n; r.out = pr_buffer_take(&out); r.err = pr_buffer_take(&err); return r;
}
#else
static inline PRProcess pr_run_raw_limited(char **argv, int argc, const char *cwd, const char *input, size_t input_len, int timeout_ms, size_t max_output, int binary, PRCancel *cancel, uint64_t max_memory_bytes) {
  (void)argv; (void)argc; (void)cwd; (void)input; (void)input_len; (void)timeout_ms; (void)max_output; (void)binary; (void)cancel;
  (void)max_memory_bytes;
  return pr_process_error("process: unavailable in WebAssembly", ENOSYS);
}
#endif
static inline PRProcess pr_run_raw(char **argv, int argc, const char *cwd, const char *input, size_t input_len, int timeout_ms, size_t max_output, int binary, PRCancel *cancel) {
  return pr_run_raw_limited(argv, argc, cwd, input, input_len, timeout_ms, max_output, binary, cancel, 0);
}
static inline PRProcess pr_run(char **argv, int argc, const char *cwd, const char *input, int timeout_ms, size_t max_output) {
  return pr_run_raw(argv, argc, cwd, input, input ? strlen(input) : 0, timeout_ms, max_output, 0, NULL);
}
static inline PRProcess pr_run_control(char **argv, int argc, const char *cwd, const char *input, int timeout_ms, size_t max_output, PRCancel *cancel) {
  return pr_run_raw(argv, argc, cwd, input, input ? strlen(input) : 0, timeout_ms, max_output, 0, cancel);
}

#endif
