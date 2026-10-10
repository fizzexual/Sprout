/* Checkpointed DAGs of native process commands. No exactly-once side-effect claim. */
#if !defined(_WIN32) && !defined(__EMSCRIPTEN__)
#include <sys/file.h>
#endif
static void dist_shahex(const unsigned char *, size_t, char [65]);
static int workflow_builtin_name(const char *name) { return !strcmp(name, "workflow_run"); }
static int workflow_index(Value jobs, const char *id) {
  for (int i = 0; i < jobs.list->n; i++) {
    Value v = pr_option(jobs.list->items[i].map, "id");
    if (v.type == V_STR && !strcmp(v.str, id)) return i;
  }
  return -1;
}
typedef struct {
#ifdef _WIN32
  HANDLE handle;
#else
  int fd;
#endif
} WorkflowLock;
static int workflow_lock(const char *path, WorkflowLock *lock) {
  char *name = malloc(strlen(path) + 6); if (!name) return 0;
  sprintf(name, "%s.lock", path);
#ifdef _WIN32
  wchar_t *wide = pr_wide(name); free(name);
  lock->handle = wide ? CreateFileW(wide, GENERIC_READ | GENERIC_WRITE, 0, NULL, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL) : INVALID_HANDLE_VALUE;
  free(wide); return lock->handle != INVALID_HANDLE_VALUE;
#elif !defined(__EMSCRIPTEN__)
  lock->fd = open(name, O_CREAT | O_RDWR, 0600); free(name);
  if (lock->fd < 0) return 0;
  if (flock(lock->fd, LOCK_EX | LOCK_NB)) { close(lock->fd); return 0; }
  return 1;
#else
  free(name); (void)lock; return 0;
#endif
}
static void workflow_unlock(WorkflowLock *lock) {
#ifdef _WIN32
  CloseHandle(lock->handle);
#elif !defined(__EMSCRIPTEN__)
  flock(lock->fd, LOCK_UN); close(lock->fd);
#else
  (void)lock;
#endif
}
static int workflow_save(const char *path, SMap *state) {
  char *text = value_to_json(vmap(state));
  int ok = strlen(text) <= 24u * 1024u * 1024u && runtime_atomic_write(path, text);
  free(text); return ok;
}
static Value workflow_run(Value jobs, SMap *options, int line) {
  pr_host_guard("workflow_run", line);
  const char *const allowed[] = {"checkpoint", "workers", "fail_fast", "max_output", "resume", NULL};
  const char *const job_keys[] = {"id", "argv", "after", "cwd", "stdin", "timeout_ms", "max_output", "idempotent", "retries", NULL};
  pr_options(options, allowed, line);
  const char *checkpoint = pr_text_option(options, "checkpoint", NULL, line);
  if (!checkpoint || !*checkpoint) fail(line, "workflow_run requires a checkpoint path.");
  int workers = pr_int_option(options, "workers", 4, 1, 16, line);
  int output = pr_int_option(options, "max_output", 1048576, 1, PR_MAX_BYTES, line);
  Value fast = pr_option(options, "fail_fast"), resume = pr_option(options, "resume");
  if ((fast.type != V_NONE && fast.type != V_BOOL) || (resume.type != V_NONE && resume.type != V_BOOL))
    fail(line, "workflow fail_fast and resume must be yes or no.");
  if (jobs.type != V_LIST || !jobs.list || jobs.list->n < 1 || jobs.list->n > 128)
    fail(line, "workflow_run needs 1..128 job maps.");
  int count = jobs.list->n, retries[128] = {0}, idempotent[128] = {0}, graph[128] = {0};
  for (int i = 0; i < count; i++) {
    Value job = jobs.list->items[i]; if (job.type != V_MAP || !job.map) fail(line, "workflow jobs must be maps.");
    pr_options(job.map, job_keys, line);
    const char *id = pr_text_option(job.map, "id", NULL, line);
    if (!id || !*id || strlen(id) > 64) fail(line, "workflow id must have 1..64 text bytes.");
    if (workflow_index(jobs, id) != i) fail(line, "workflow job ids must be unique.");
    Value safe = pr_option(job.map, "idempotent");
    if (safe.type != V_NONE && safe.type != V_BOOL) fail(line, "workflow idempotent must be yes or no.");
    idempotent[i] = safe.type == V_BOOL && safe.boolean;
    retries[i] = pr_int_option(job.map, "retries", 0, 0, 5, line);
    if (retries[i] && !idempotent[i]) fail(line, "workflow retries require idempotent: yes.");
    Value argv = pr_option(job.map, "argv");
    if (argv.type != V_LIST || !argv.list || argv.list->n < 1 || argv.list->n > 256) fail(line, "workflow argv needs 1..256 text elements.");
    size_t size = 0;
    for (int j = 0; j < argv.list->n; j++) {
      if (argv.list->items[j].type != V_STR) fail(line, "workflow argv elements must be text.");
      size += strlen(argv.list->items[j].str);
    }
    if (size > 1048576 || !*argv.list->items[0].str) fail(line, "workflow command is empty or exceeds one MiB.");
    pr_text_option(job.map, "cwd", NULL, line);
    if (strlen(pr_text_option(job.map, "stdin", "", line)) > PR_MAX_BYTES) fail(line, "workflow stdin exceeds 16 MiB.");
    pr_int_option(job.map, "timeout_ms", PR_DEFAULT_TIMEOUT, 1, 3600000, line);
    pr_int_option(job.map, "max_output", output, 1, PR_MAX_BYTES, line);
    Value after = pr_option(job.map, "after");
    if (after.type != V_NONE) {
      if (after.type != V_LIST || !after.list || after.list->n > count) fail(line, "workflow after must be a list of dependency ids.");
      for (int j = 0; j < after.list->n; j++) {
        if (after.list->items[j].type != V_STR || workflow_index(jobs, after.list->items[j].str) < 0)
          fail(line, "workflow dependency does not name a job.");
      }
    }
  }
  /* Kahn-style validation detects cycles before the first command is launched. */
  int changed = 1, reached = 0;
  while (changed) {
    changed = 0;
    for (int i = 0; i < count; i++) if (!graph[i]) {
      Value after = pr_option(jobs.list->items[i].map, "after"); int ready = 1;
      if (after.type == V_LIST) for (int j = 0; j < after.list->n; j++) if (!graph[workflow_index(jobs, after.list->items[j].str)]) ready = 0;
      if (ready) { graph[i] = 1; changed = 1; reached++; }
    }
  }
  if (reached != count) fail(line, "workflow dependencies contain a cycle.");
  char fingerprint[65]; char *serialized = value_to_json(jobs);
  dist_shahex((unsigned char *)serialized, strlen(serialized), fingerprint); free(serialized);
  WorkflowLock lock;
  if (!workflow_lock(checkpoint, &lock)) fail(line, "workflow checkpoint is locked by another run or its directory is unavailable.");
  SMap *state = map_new(); SList *entries = list_new(); int resumed = 0;
  FILE *file = pr_fopen(checkpoint, "rb");
  const char *error = NULL;
  if (file) {
    if (resume.type == V_BOOL && !resume.boolean) error = "checkpoint already exists; use a new path or resume it.";
    PRBuffer buf = {0}; char chunk[4096]; size_t got;
    while (!error && (got = fread(chunk, 1, sizeof chunk, file))) if (!pr_append(&buf, chunk, got, 24u * 1024u * 1024u) || buf.truncated || buf.binary) error = "checkpoint is too large or invalid text.";
    if (ferror(file)) error = "could not read workflow checkpoint.";
    fclose(file);
    if (!error) {
      Value saved = parse_json(buf.p ? buf.p : "");
      if (saved.type != V_MAP) error = "workflow checkpoint is corrupt; original file was preserved.";
      else {
        Value version = pr_option(saved.map, "version"), hash = pr_option(saved.map, "fingerprint"), items = pr_option(saved.map, "jobs");
        if (version.type != V_NUM || version.num != 1 || hash.type != V_STR || strcmp(hash.str, fingerprint) || items.type != V_LIST || !items.list || items.list->n != count)
          error = "workflow checkpoint does not match this job specification.";
        else { state = saved.map; entries = items.list; resumed = 1; }
      }
    }
    free(buf.p);
  } else if (errno != ENOENT) error = "could not open workflow checkpoint.";
  if (!resumed && !error) {
    map_set(state, "version", vnum(1)); map_set(state, "fingerprint", vstr(fingerprint));
    map_set(state, "jobs", vlist(entries));
    for (int i = 0; i < count; i++) {
      SMap *entry = map_new(); map_set(entry, "id", pr_option(jobs.list->items[i].map, "id"));
      map_set(entry, "status", vstr("pending")); map_set(entry, "attempts", vnum(0)); map_set(entry, "result", vnone()); list_push(entries, vmap(entry));
    }
  }
  for (int i = 0; i < count && !error; i++) {
    Value entry = entries->items[i];
    if (entry.type != V_MAP) { error = "workflow checkpoint job is corrupt."; break; }
    Value status = pr_option(entry.map, "status"), tries = pr_option(entry.map, "attempts"), id = pr_option(entry.map, "id"), result = pr_option(entry.map, "result");
    Value wanted = pr_option(jobs.list->items[i].map, "id");
    if (id.type != V_STR || strcmp(id.str, wanted.str) || status.type != V_STR || tries.type != V_NUM || tries.num < 0 || tries.num > 6 || floor(tries.num) != tries.num ||
        (strcmp(status.str, "pending") && strcmp(status.str, "running") && strcmp(status.str, "done") && strcmp(status.str, "failed"))) { error = "workflow checkpoint job is corrupt."; break; }
    if (!strcmp(status.str, "done") && (result.type != V_MAP || !is_truthy(pr_option(result.map, "ok")))) { error = "workflow checkpoint completion is corrupt."; break; }
    if (!strcmp(status.str, "running")) {
      if (!idempotent[i]) { error = "interrupted job has uncertain side effects; recovery requires idempotent: yes and a matching specification."; break; }
      map_set(entry.map, "status", vstr("pending"));
    }
    if (!strcmp(status.str, "failed") && idempotent[i] && tries.num <= retries[i]) map_set(entry.map, "status", vstr("pending"));
  }
  if (error) { workflow_unlock(&lock); fail_kind(line, "workflow", error); }
  int stopped = 0;
  for (;;) {
    if (stopped) break;
    SList *commands = list_new(); int indices[16], selected = 0;
    for (int i = 0; i < count && selected < workers; i++) {
      SMap *entry = entries->items[i].map;
      if (strcmp(pr_option(entry, "status").str, "pending")) continue;
      Value job = jobs.list->items[i], after = pr_option(job.map, "after"); int ready = 1;
      if (after.type == V_LIST) for (int j = 0; j < after.list->n; j++) {
        int dependency = workflow_index(jobs, after.list->items[j].str);
        if (strcmp(pr_option(entries->items[dependency].map, "status").str, "done")) ready = 0;
      }
      if (!ready) continue;
      SMap *command = map_new(); const char *keys[] = {"argv", "cwd", "stdin", "timeout_ms", NULL};
      for (int j = 0; keys[j]; j++) { Value v = pr_option(job.map, keys[j]); if (v.type != V_NONE) map_set(command, keys[j], v); }
      int limit = pr_int_option(job.map, "max_output", output, 1, PR_MAX_BYTES, line);
      int share = (int)(PR_MAX_BYTES / (2u * (unsigned)count)); if (limit > share) limit = share;
      map_set(command, "max_output", vnum(limit));
      list_push(commands, vmap(command)); indices[selected++] = i;
      map_set(entry, "status", vstr("running")); map_set(entry, "attempts", vnum(pr_option(entry, "attempts").num + 1));
    }
    if (!selected) break;
    if (!workflow_save(checkpoint, state)) { error = "could not persist workflow launch checkpoint; no commands in this batch were launched."; break; }
    SMap *parallel_options = map_new(); map_set(parallel_options, "workers", vnum(workers));
    map_set(parallel_options, "fail_fast", vbool(fast.type == V_NONE || fast.boolean));
    Value results = parallel_run(vlist(commands), parallel_options, line);
    for (int j = 0; j < selected; j++) {
      int i = indices[j]; SMap *entry = entries->items[i].map; Value result = results.list->items[j];
      map_set(entry, "result", result);
      int ok = is_truthy(pr_option(result.map, "ok"));
      int retry = !ok && idempotent[i] && pr_option(entry, "attempts").num <= retries[i];
      map_set(entry, "status", vstr(ok ? "done" : retry ? "pending" : "failed"));
      if (!ok && !retry && (fast.type == V_NONE || fast.boolean)) stopped = 1;
    }
    if (!workflow_save(checkpoint, state)) { error = "commands finished but their result checkpoint could not be persisted; recover using idempotent jobs only."; break; }
  }
  workflow_unlock(&lock);
  if (error) fail_kind(line, "workflow", error);
  int ok = 1; for (int i = 0; i < count; i++) if (strcmp(pr_option(entries->items[i].map, "status").str, "done")) ok = 0;
  SMap *result = map_new(); map_set(result, "ok", vbool(ok)); map_set(result, "resumed", vbool(resumed)); map_set(result, "jobs", vlist(entries));
  return restore_exact_json(vmap(result), 0);
}
static int workflow_builtin(const char *name, int n, Value *a, int line, Value *out) {
  if (!workflow_builtin_name(name)) return 0;
  if (n != 2 || a[1].type != V_MAP) fail(line, "workflow_run(jobs, {checkpoint: path, ...}) needs two inputs.");
  *out = workflow_run(a[0], a[1].map, line); return 1;
}
