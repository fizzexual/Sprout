/* Structured native process work. Workers never access Sprout values or the GC. */
#if !defined(_WIN32) && !defined(__EMSCRIPTEN__)
#include <pthread.h>
#endif
typedef struct {
  char **argv; int argc; char *cwd, *input;
  int timeout, attempted; size_t cap; PRProcess result;
} ParallelJob;
typedef struct {
  ParallelJob *jobs; int count, fail_fast;
  _Atomic int next; PRCancel cancel; uint64_t deadline;
} ParallelGroup;
static int parallel_builtin_name(const char *name) { return !strcmp(name, "parallel"); }
static void parallel_work(ParallelGroup *group) {
  for (;;) {
    int i = atomic_fetch_add(&group->next, 1);
    if (i >= group->count) return;
    ParallelJob *job = &group->jobs[i];
    if (atomic_load(&group->cancel.cancelled)) {
      job->result = pr_process_error("process: cancelled before launch", ECANCELED);
      job->result.cancelled = 1; continue;
    }
    int timeout = job->timeout;
    if (group->deadline) {
      uint64_t now = pr_clock_ms();
      if (now >= group->deadline) {
        job->result = pr_process_error("process: deadline expired before launch", ETIMEDOUT);
        job->result.timed_out = 1; continue;
      }
      uint64_t remaining = group->deadline - now;
      if (remaining < (uint64_t)timeout) timeout = (int)remaining;
    }
    job->attempted = 1;
    job->result = pr_run_control(job->argv, job->argc, job->cwd, job->input,
                                 timeout, job->cap, &group->cancel);
    PRProcess *r = &job->result;
    if (group->fail_fast && (r->exit_code != 0 || r->error || r->timed_out || r->truncated))
      atomic_store(&group->cancel.cancelled, 1);
  }
}
#ifdef _WIN32
static DWORD WINAPI parallel_thread(LPVOID p) { parallel_work((ParallelGroup *)p); return 0; }
#elif !defined(__EMSCRIPTEN__)
static void *parallel_thread(void *p) { parallel_work((ParallelGroup *)p); return NULL; }
#endif
static Value parallel_run(Value commands, SMap *options, int line) {
  pr_host_guard("parallel", line);
#ifdef __EMSCRIPTEN__
  (void)commands; (void)options;
  fail(line, "parallel native processes are unavailable in WebAssembly.");
  return vnone();
#else
  const char *const allowed[] = {"workers", "fail_fast", "timeout_ms", "max_output", NULL};
  const char *const job_allowed[] = {"argv", "cwd", "stdin", "timeout_ms", "max_output", NULL};
  pr_options(options, allowed, line);
  if (commands.type != V_LIST || !commands.list || commands.list->n < 0 || commands.list->n > 128)
    fail(line, "parallel needs a list of at most 128 argv lists or command maps.");
  int count = commands.list->n;
  int workers = pr_int_option(options, "workers", 4, 1, 16, line);
  int timeout = pr_deadline_timeout(pr_int_option(options, "timeout_ms", PR_DEFAULT_TIMEOUT, 1, 3600000, line));
  int cap = pr_int_option(options, "max_output", PR_DEFAULT_BYTES, 1, PR_MAX_BYTES, line);
  Value fast = pr_option(options, "fail_fast");
  if (fast.type != V_NONE && fast.type != V_BOOL) fail(line, "fail_fast must be yes or no.");
  /* Validate the complete group before creating any OS resources. */
  for (int i = 0; i < count; i++) {
    Value command = commands.list->items[i], argv = command;
    SMap *opts = command.type == V_MAP ? command.map : NULL;
    if (opts) {
      pr_options(opts, job_allowed, line); argv = pr_option(opts, "argv");
      pr_text_option(opts, "cwd", NULL, line); pr_text_option(opts, "stdin", NULL, line);
      pr_int_option(opts, "timeout_ms", timeout, 1, 3600000, line);
      pr_int_option(opts, "max_output", cap, 1, PR_MAX_BYTES, line);
    }
    if (argv.type != V_LIST || !argv.list || argv.list->n < 1 || argv.list->n > 256)
      fail(line, "each parallel command needs 1..256 text argv elements.");
    size_t size = 0;
    for (int j = 0; j < argv.list->n; j++) {
      if (argv.list->items[j].type != V_STR) fail(line, "parallel argv elements must be text.");
      size += strlen(argv.list->items[j].str);
    }
    if (size > 1048576 || !*argv.list->items[0].str) fail(line, "parallel command is empty or exceeds one MiB.");
    const char *input = pr_text_option(opts, "stdin", "", line);
    if (strlen(input) > PR_MAX_BYTES) fail(line, "parallel stdin exceeds 16 MiB.");
  }
  SList *result = list_new(); if (!count) return vlist(result);
  ParallelJob *jobs = calloc(128, sizeof(*jobs));
  if (!jobs) fail_kind(line, "memory", "could not allocate parallel jobs.");
  for (int i = 0; i < count; i++) {
    Value command = commands.list->items[i]; SMap *opts = command.type == V_MAP ? command.map : NULL;
    Value argv = opts ? pr_option(opts, "argv") : command;
    jobs[i].argc = argv.list->n; jobs[i].argv = calloc((size_t)jobs[i].argc + 1, sizeof(char *));
    if (!jobs[i].argv) { fprintf(stderr, "parallel: out of memory\n"); exit(1); }
    for (int j = 0; j < jobs[i].argc; j++) jobs[i].argv[j] = dup_str(argv.list->items[j].str);
    const char *cwd = pr_text_option(opts, "cwd", NULL, line);
    jobs[i].cwd = cwd ? dup_str(cwd) : NULL;
    jobs[i].input = dup_str(pr_text_option(opts, "stdin", "", line));
    jobs[i].timeout = pr_deadline_timeout(pr_int_option(opts, "timeout_ms", timeout, 1, 3600000, line));
    jobs[i].cap = (size_t)pr_int_option(opts, "max_output", cap, 1, PR_MAX_BYTES, line);
    /* Both pipes across the whole group fit within 16 MiB. */
    size_t share = PR_MAX_BYTES / (2u * (unsigned)count);
    if (jobs[i].cap > share) jobs[i].cap = share;
  }
  ParallelGroup group = {0}; group.jobs = jobs; group.count = count;
  group.deadline = g_runtime_deadline;
  group.fail_fast = fast.type == V_NONE || fast.boolean;
  atomic_init(&group.next, 0); atomic_init(&group.cancel.cancelled, 0);
  if (workers > count) workers = count;
#ifdef _WIN32
  HANDLE threads[16]; int launched = 0;
  for (; launched < workers; launched++) {
    threads[launched] = CreateThread(NULL, 0, parallel_thread, &group, 0, NULL);
    if (!threads[launched]) break;
  }
  if (!launched) parallel_work(&group);
  for (int i = 0; i < launched; i++) { WaitForSingleObject(threads[i], INFINITE); CloseHandle(threads[i]); }
#else
  pthread_t threads[16]; int launched = 0;
  for (; launched < workers; launched++) if (pthread_create(&threads[launched], NULL, parallel_thread, &group)) break;
  if (!launched) parallel_work(&group);
  for (int i = 0; i < launched; i++) pthread_join(threads[i], NULL);
#endif
  for (int i = 0; i < count; i++) {
    Value v = pr_process_value(&jobs[i].result); map_set(v.map, "index", vnum(i));
    map_set(v.map, "attempted", vbool(jobs[i].attempted)); list_push(result, v);
    pr_process_free(&jobs[i].result);
    for (int j = 0; j < jobs[i].argc; j++) free(jobs[i].argv[j]);
    free(jobs[i].argv); free(jobs[i].cwd); free(jobs[i].input);
  }
  free(jobs); return vlist(result);
#endif
}
static int parallel_builtin(const char *name, int n, Value *a, int line, Value *out) {
  if (!parallel_builtin_name(name)) return 0;
  if (n < 1 || n > 2) arity_error(line, name, "commands and optional options", n);
  if (n == 2 && a[1].type != V_MAP) fail(line, "parallel options must be a map.");
  *out = parallel_run(a[0], n == 2 ? a[1].map : NULL, line);
  runtime_tick(line); return 1;
}
