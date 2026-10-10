/* Runtime control and data boundary APIs. Limits stop at a SYSTEM boundary. */
static uint64_t g_runtime_deadline = 0, g_runtime_steps = 0, g_runtime_max_steps = 0;
static int g_trace_json = 0;
static unsigned g_trace_events = 0;
static size_t g_trace_bytes = 0;
static int runtime_atomic_write(const char *path, const char *text) {
  size_t size = strlen(text); char *tmp = malloc(strlen(path) + 96); int ok = 0;
  if (!tmp) return 0;
#ifdef _WIN32
  int wide_len = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, path, -1, NULL, 0);
  wchar_t *wide_path = wide_len ? malloc((size_t)wide_len * sizeof(wchar_t)) : NULL;
  if (!wide_path || !MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, path, -1, wide_path, wide_len)) { free(wide_path); free(tmp); return 0; }
  HANDLE handle = INVALID_HANDLE_VALUE;
  wchar_t *wide_tmp = NULL;
  for (unsigned attempt = 0; attempt < 100; attempt++) {
    snprintf(tmp, strlen(path) + 96, "%s.tmp-%lu-%llu-%u", path, (unsigned long)GetCurrentProcessId(), (unsigned long long)GetTickCount64(), attempt);
    int n = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, tmp, -1, NULL, 0);
    free(wide_tmp); wide_tmp = n ? malloc((size_t)n * sizeof(wchar_t)) : NULL;
    if (!wide_tmp || !MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, tmp, -1, wide_tmp, n)) break;
    handle = CreateFileW(wide_tmp, GENERIC_WRITE, 0, NULL, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, NULL);
    if (handle != INVALID_HANDLE_VALUE) break;
  }
  if (handle != INVALID_HANDLE_VALUE) {
    DWORD wrote = 0;
    ok = size <= MAXDWORD && WriteFile(handle, text, (DWORD)size, &wrote, NULL) && wrote == size && FlushFileBuffers(handle);
    if (!CloseHandle(handle)) ok = 0;
    if (ok) ok = MoveFileExW(wide_tmp, wide_path, MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH) != 0;
    if (!ok) DeleteFileW(wide_tmp);
  }
  free(wide_tmp); free(wide_path);
#elif defined(__EMSCRIPTEN__)
  snprintf(tmp, strlen(path) + 96, "%s.tmp", path);
  FILE *f = fopen(tmp, "wb");
  if (f) { ok = fwrite(text, 1, size, f) == size; if (fclose(f)) ok = 0; if (ok) ok = !rename(tmp, path); if (!ok) remove(tmp); }
#else
  snprintf(tmp, strlen(path) + 96, "%s.tmp-XXXXXX", path);
  int fd = mkstemp(tmp);
  if (fd >= 0) {
    size_t at = 0;
    while (at < size) { ssize_t n = write(fd, text + at, size - at); if (n < 0 && errno == EINTR) continue; if (n <= 0) break; at += (size_t)n; }
    ok = at == size && fsync(fd) == 0;
    if (close(fd)) ok = 0;
    if (ok) ok = rename(tmp, path) == 0;
    if (ok) {
      char *parent = dup_str(path), *slash = strrchr(parent, '/');
      if (slash) { if (slash == parent) slash[1] = 0; else *slash = 0; }
      else { free(parent); parent = dup_str("."); }
      int directory = open(parent, O_RDONLY);
      if (directory < 0) ok = 0;
      else { if (fsync(directory)) ok = 0; if (close(directory)) ok = 0; }
      free(parent);
    }
    if (!ok) unlink(tmp);
  }
#endif
  free(tmp); return ok;
}
static uint64_t runtime_now_ms(void) {
#ifdef _WIN32
  return (uint64_t)GetTickCount64();
#elif defined(CLOCK_MONOTONIC)
  struct timespec ts; clock_gettime(CLOCK_MONOTONIC, &ts);
  return (uint64_t)ts.tv_sec * 1000 + (uint64_t)ts.tv_nsec / 1000000;
#else
  return (uint64_t)((double)clock() * 1000 / CLOCKS_PER_SEC);
#endif
}
static void runtime_tick(int line) {
  if (g_runtime_max_steps && ++g_runtime_steps > g_runtime_max_steps)
    fail_hard(line, "limit", "execution exceeded --max-steps.");
  if (g_runtime_deadline && runtime_now_ms() >= g_runtime_deadline)
    fail_hard(line, "limit", "execution exceeded --timeout-ms.");
}
static double runtime_profile_ms(void) {
#ifdef _WIN32
  LARGE_INTEGER count, frequency;
  if (QueryPerformanceCounter(&count) && QueryPerformanceFrequency(&frequency))
    return (double)count.QuadPart * 1000.0 / (double)frequency.QuadPart;
  return (double)runtime_now_ms();
#elif defined(CLOCK_MONOTONIC)
  struct timespec ts; clock_gettime(CLOCK_MONOTONIC, &ts);
  return (double)ts.tv_sec * 1000.0 + (double)ts.tv_nsec / 1000000.0;
#else
  return (double)runtime_now_ms();
#endif
}
static void runtime_trace(const char *event, Stmt *s, Env *env) {
  if (!g_trace_json || g_trace_events >= 5000 || g_trace_bytes >= 2097152) return;
  static double started = 0; double now = runtime_profile_ms();
  if (!g_trace_events) started = now;
  SMap *m = map_new(), *vars = map_new(); int count = 0;
  map_set(m, "elapsed_ms", vnum(now - started));
  map_set(m, "type", vstr(event)); map_set(m, "sequence", vnum(++g_trace_events));
  map_set(m, "file", vstr(g_current_file ? g_current_file : "<input>"));
  map_set(m, "line", vnum(s ? s->line : 0)); map_set(m, "depth", vnum(call_depth));
  for (Env *scope = env; scope && count < 100; scope = scope->parent) {
    for (int i = 0; i < scope->n && count < 100; i++) {
      if (map_index(vars, scope->vars[i].name) >= 0) continue;
      char preview[512]; val_describe(scope->vars[i].val, preview, sizeof preview);
      if (is_exact(scope->vars[i].val)) {
        char *text = exact_to_str(scope->vars[i].val);
        snprintf(preview, sizeof preview, "%s (%s)", type_name(scope->vars[i].val), text); free(text);
      }
      map_set(vars, scope->vars[i].name, vstr(preview)); count++;
    }
  }
  map_set(m, "variables", vmap(vars));
  SList *stack = list_new();
  for (int i = 1; i <= call_depth && i < MAX_CALL_FRAMES; i++) {
    SMap *frame = map_new(); map_set(frame, "task", vstr(g_frames[i].name));
    map_set(frame, "line", vnum(g_frames[i].line)); list_push(stack, vmap(frame));
  }
  map_set(m, "stack", vlist(stack));
  char *text = value_to_json(vmap(m)); g_trace_bytes += strlen(text);
  fprintf(stderr, "@sprout-trace %s\n", text); free(text);
}
static int foundation_builtin_name(const char *name) {
  return !strcmp(name, "json_encode") || !strcmp(name, "json_decode") || !strcmp(name, "read_input");
}
static int foundation_builtin(const char *name, int n, Value *a, int line, Value *out) {
  if (!foundation_builtin_name(name)) return 0;
  if (!strcmp(name, "json_encode")) {
    if (n != 1) arity_error(line, name, "one data value", n);
    *out = vstr_take(value_to_json(a[0])); return 1;
  }
  if (!strcmp(name, "json_decode")) {
    want_one_str(line, name, n, a, "json_decode(text)");
    *out = restore_exact_json(parse_json(a[0].str), 0); return 1;
  }
  if (n != 0) arity_error(line, name, "no arguments", n);
  size_t cap = 4096, used = 0; char *buf = malloc(cap); int ch;
  if (!buf) fail_kind(line, "memory", "could not allocate input buffer.");
  while ((ch = getchar()) != EOF) {
    if (used >= 1048576) { free(buf); fail_kind(line, "limit", "read_input is limited to one MiB."); }
    if (ch == 0) { free(buf); fail_kind(line, "data", "read_input accepts text without NUL bytes."); }
    if (used + 1 >= cap) { cap *= 2; char *next = realloc(buf, cap); if (!next) { free(buf); fail_kind(line, "memory", "could not grow input buffer."); } buf = next; }
    buf[used++] = (char)ch;
  }
  if (ferror(stdin)) { free(buf); fail_kind(line, "io", "could not read standard input."); }
  buf[used] = 0; *out = vstr_take(buf); return 1;
}
static int runtime_cli_flags(int *argc, char **argv) {
  int w = 1; uint64_t timeout = 0;
  for (int r = 1; r < *argc; r++) {
    if (!strcmp(argv[r], "--")) { while (++r < *argc) argv[w++] = argv[r]; break; }
    if (!strcmp(argv[r], "--trace-json")) { g_trace_json = 1; continue; }
    if (!strcmp(argv[r], "--max-steps") || !strcmp(argv[r], "--timeout-ms")) {
      const char *flag = argv[r]; char *tail; errno = 0;
      if (++r >= *argc || argv[r][0] == '-') { fprintf(stderr, "%s needs a positive integer.\n", flag); return 0; }
      unsigned long long limit = strtoull(argv[r], &tail, 10);
      if (errno || *tail || !limit || limit > 1000000000000ULL) { fprintf(stderr, "%s is outside 1..1000000000000.\n", flag); return 0; }
      if (!strcmp(flag, "--max-steps")) g_runtime_max_steps = limit; else timeout = limit;
      continue;
    }
    argv[w++] = argv[r];
  }
  *argc = w;
  if (timeout) g_runtime_deadline = runtime_now_ms() + timeout;
  return 1;
}
