/* Sprout native I/O foundations. Included after Value helpers and g_sandbox.
   No shell interpolation. Host failures are result maps; invalid arguments throw.
   Pure CSV functions are available in sandbox / WebAssembly builds. */
#include <errno.h>
#include <stdint.h>
#include <limits.h>
#include <sys/stat.h>
#include <stdatomic.h>
#ifdef _WIN32
#include <winhttp.h>
#include <wchar.h>
#else
#include <fcntl.h>
#include <sys/wait.h>
#include <signal.h>
#include <poll.h>
#endif
#ifdef SPROUT_SQLITE
#include "vendor/sqlite/sqlite3.h"
#endif

#include "process_native.h"
static Value pr_result(int ok, const char *error, int code) {
  SMap *m = map_new(); map_set(m, "ok", vbool(ok));
  map_set(m, "error", error && *error ? vstr(error) : vnone());
  map_set(m, "code", vnum(code)); return vmap(m);
}
static Value pr_errno_result(const char *operation, int code) {
  char msg[320]; snprintf(msg, sizeof msg, "%s: %s", operation, strerror(code));
  return pr_result(0, msg, code);
}
static Value pr_option(SMap *m, const char *key) {
  int i = m ? map_index(m, key) : -1; return i >= 0 ? m->vals[i] : vnone();
}
static inline double pr_number(Value v, int line, const char *description) {
  if (v.type != V_NUM && v.type != V_INT && v.type != V_DECIMAL) failf(line, "%s must be a number.", description);
  return v.num;
}
static int pr_deadline_timeout(int requested) {
  if (g_runtime_deadline) {
    uint64_t now = runtime_now_ms();
    if (now >= g_runtime_deadline) return 1;
    uint64_t remaining = g_runtime_deadline - now;
    if (remaining < (uint64_t)requested) return (int)remaining;
  }
  return requested;
}
static int pr_int_option(SMap *m, const char *key, int fallback, int min, int max, int line) {
  Value v = pr_option(m, key); if (v.type == V_NONE) return fallback;
  if ((v.type != V_NUM && !is_exact(v)) || !isfinite(v.num) || floor(v.num) != v.num || v.num < min || v.num > max) {
    char msg[256]; snprintf(msg, sizeof msg, "option '%s' must be a whole number from %d to %d.", key, min, max); fail(line, msg);
  }
  return (int)v.num;
}
static const char *pr_text_option(SMap *m, const char *key, const char *fallback, int line) {
  Value v = pr_option(m, key); if (v.type == V_NONE) return fallback;
  if (v.type != V_STR) failf(line, "option '%s' must be text.", key);
  return v.str;
}
static void pr_options(SMap *m, const char *const *names, int line) {
  if (!m) return;
  for (int i = 0; i < m->n; i++) {
    int found = 0; for (int j = 0; names[j]; j++) if (!strcmp(m->keys[i], names[j])) { found = 1; break; }
    if (!found) failf(line, "unknown option '%s'.", m->keys[i]);
  }
}
static void pr_host_guard(const char *name, int line) {
  if (g_sandbox) failf(line, "'%s' is turned off in sandbox mode — file, shell, and network access are disabled here.", name);
}
#ifdef _WIN32
static Value pr_win_result(const char *operation, DWORD code) {
  wchar_t w[256]; char message[512];
  DWORD n = FormatMessageW(FORMAT_MESSAGE_FROM_SYSTEM | FORMAT_MESSAGE_IGNORE_INSERTS, NULL, code, 0, w, 256, NULL);
  char *detail = n ? pr_utf8(w) : NULL;
  snprintf(message, sizeof message, "%s: %s (Windows error %lu)", operation, detail ? detail : "operation failed", (unsigned long)code);
  free(detail); return pr_result(0, message, (int)code);
}
static FILE *pr_fopen(const char *path, const char *mode) {
  wchar_t *w = pr_wide(path), *m = pr_wide(mode); FILE *f = w && m ? _wfopen(w, m) : NULL;
  free(w); free(m); if (!f && !errno) errno = EINVAL; return f;
}
#else
static FILE *pr_fopen(const char *path, const char *mode) { return fopen(path, mode); }
#endif

static Value pr_process_value(PRProcess *r) {
  const char *error = r->error ? r->error : r->cancelled ? "process: cancelled; process tree terminated" : r->timed_out ? "process: timeout; process tree terminated" : r->truncated ? "process: output limit exceeded; process tree terminated" : NULL;
  Value v = pr_result(!error && r->exit_code == 0, error, r->code);
  map_set(v.map, "exit", vnum(r->exit_code)); map_set(v.map, "stdout", vstr(r->out)); map_set(v.map, "stderr", vstr(r->err));
  map_set(v.map, "timed_out", vbool(r->timed_out)); map_set(v.map, "truncated", vbool(r->truncated)); map_set(v.map, "cancelled", vbool(r->cancelled)); return v;
}

/* CSV preserves cells as text, including empty cells and quoted newlines. */
static char pr_delimiter(int n, Value *a, int line, const char *name) {
  if (n == 1) return ',';
  const char *p = want_str(line, name, 2, a[1], NULL);
  if (strlen(p) != 1 || p[0] == '"' || p[0] == '\r' || p[0] == '\n') fail(line, "CSV delimiter must be one character other than a quote or newline.");
  return p[0];
}
static Value pr_csv_parse(const char *text, char delimiter, int line) {
  if (strlen(text) > PR_MAX_BYTES) fail(line, "CSV input exceeds the 16 MiB text limit.");
  SList *rows = list_new(); if (!*text) return vlist(rows);
  int cells = 0;
  const char *p = text;
  while (*p) {
    SList *row = list_new();
    for (;;) {
      PRBuffer field = {0};
      if (*p == '"') {
        p++; int closed = 0;
        while (*p) {
          if (*p == '"') { p++; if (*p == '"') { if (!pr_append(&field, p++, 1, PR_MAX_BYTES)) break; } else { closed = 1; break; } }
          else if (!pr_append(&field, p++, 1, PR_MAX_BYTES)) break;
        }
        if (!closed || (*p && *p != delimiter && *p != '\r' && *p != '\n')) { free(field.p); fail(line, "CSV has an unclosed quote or characters after a closing quote."); }
      } else {
        while (*p && *p != delimiter && *p != '\r' && *p != '\n') {
          if (*p == '"') { free(field.p); fail(line, "CSV quotes must surround the entire field."); }
          if (!pr_append(&field, p++, 1, PR_MAX_BYTES)) { free(field.p); fail(line, "ran out of memory reading CSV."); }
        }
      }
      if (field.truncated) { free(field.p); fail(line, "CSV field exceeds the 16 MiB text limit."); }
      if (++cells > 100000) { free(field.p); fail(line, "CSV exceeds the 100,000 cell limit."); }
      list_push(row, vstr_take(pr_buffer_take(&field)));
      if (*p == delimiter) { p++; continue; }
      if (*p == '\r') { p++; if (*p == '\n') p++; }
      else if (*p == '\n') p++;
      break;
    }
    list_push(rows, vlist(row));
    if (rows->n > 100000) fail(line, "CSV exceeds the 100,000 row limit.");
  }
  return vlist(rows);
}
static void pr_csv_add(PRBuffer *out, const char *p, size_t n, int line) {
  if (!pr_append(out, p, n, PR_MAX_BYTES)) { free(out->p); fail(line, "ran out of memory writing CSV."); }
  if (out->truncated) { free(out->p); fail(line, "CSV output exceeds the 16 MiB text limit."); }
}
static Value pr_csv_write(SList *rows, char delimiter, int line) {
  PRBuffer out = {0};
  for (int i = 0; i < rows->n; i++) {
    if (rows->items[i].type != V_LIST) { free(out.p); fail(line, "csv_write expects a list of rows, each row a list."); }
    SList *row = rows->items[i].list;
    for (int j = 0; j < row->n; j++) {
      if (row->items[j].type != V_STR && row->items[j].type != V_NUM && !is_exact(row->items[j]) && row->items[j].type != V_BOOL && row->items[j].type != V_NONE) { free(out.p); fail(line, "CSV cells must be text, numbers, booleans, or nothing."); }
      char *s = row->items[j].type == V_NONE ? dup_str("") : stringify(row->items[j]);
      int quoted = strchr(s, delimiter) || strchr(s, '"') || strchr(s, '\r') || strchr(s, '\n');
      if (j) pr_csv_add(&out, &delimiter, 1, line);
      if (quoted) pr_csv_add(&out, "\"", 1, line);
      for (const char *p = s; *p; p++) { if (*p == '"') pr_csv_add(&out, "\"", 1, line); pr_csv_add(&out, p, 1, line); }
      if (quoted) pr_csv_add(&out, "\"", 1, line);
      free(s);
    }
    pr_csv_add(&out, "\r\n", 2, line);
    if (out.truncated) { free(out.p); fail(line, "CSV output exceeds the 16 MiB text limit."); }
  }
  return vstr_take(pr_buffer_take(&out));
}

/* Checked filesystem operations. No recursive deletion, no implicit mkdir. */
static Value pr_file_read(const char *path, size_t max, int binary) {
  FILE *f = pr_fopen(path, "rb"); if (!f) return pr_errno_result("file_read", errno);
  PRBuffer b = {0}; char chunk[4096]; size_t n;
  while ((n = fread(chunk, 1, sizeof chunk, f)) > 0) {
    if (!pr_append(&b, chunk, n, max)) { fclose(f); free(b.p); return pr_result(0, "file_read: memory allocation failed", ENOMEM); }
    if ((!binary && b.binary) || b.truncated) break;
  }
  int e = ferror(f) ? errno : 0; if (fclose(f) && !e) e = errno;
  if (e || (!binary && b.binary) || b.truncated) { free(b.p); return e ? pr_errno_result("file_read", e) : pr_result(0, b.binary && !binary ? "file_read: NUL bytes cannot be represented as text" : "file_read: file exceeds max_bytes", b.binary && !binary ? EILSEQ : EFBIG); }
  Value data = binary ? vbytes((const unsigned char *)b.p, b.n) : vstr(b.p ? b.p : ""); free(b.p);
  Value v = pr_result(1, NULL, 0); map_set(v.map, "data", data); if (!binary) map_set(v.map, "text", data); return v;
}
static int pr_replace(const char *from, const char *to) {
#ifdef _WIN32
  wchar_t *f = pr_wide(from), *t = pr_wide(to); int ok = f && t && MoveFileExW(f, t, MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH);
  free(f); free(t); return ok;
#else
  return rename(from, to) == 0;
#endif

}
static int pr_unlink(const char *path) {
#ifdef _WIN32
  wchar_t *w = pr_wide(path); int ok = w && DeleteFileW(w); free(w); return ok;
#else
  return unlink(path) == 0;
#endif
}
static Value pr_file_write(const char *path, const char *text, size_t len) {
  size_t plen = strlen(path); if (plen > 30000 || len > PR_MAX_BYTES) return pr_result(0, "file_write: path or text exceeds supported limit", EFBIG);
  char *tmp = (char *)malloc(plen + 80); if (!tmp) return pr_result(0, "file_write: memory allocation failed", ENOMEM);
  FILE *f = NULL; int fd = -1;
#ifdef _WIN32
  static unsigned long serial = 0;
  for (int i = 0; i < 100; i++) {
    snprintf(tmp, plen + 80, "%s.sprout-%lu-%lu.tmp", path, (unsigned long)GetCurrentProcessId(), ++serial);
    wchar_t *w = pr_wide(tmp); if (!w) { free(tmp); return pr_result(0, "file_write: path must be UTF-8", EINVAL); }
    HANDLE h = CreateFileW(w, GENERIC_WRITE, 0, NULL, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, NULL); free(w);
    if (h != INVALID_HANDLE_VALUE) {
      fd = _open_osfhandle((intptr_t)h, _O_BINARY | _O_WRONLY); if (fd < 0) CloseHandle(h); else f = _fdopen(fd, "wb");
      if (!f && fd >= 0) _close(fd);
      break;
    }
    if (GetLastError() != ERROR_FILE_EXISTS && GetLastError() != ERROR_ALREADY_EXISTS) { DWORD e = GetLastError(); free(tmp); return pr_win_result("file_write", e); }
  }
#else
  snprintf(tmp, plen + 80, "%s.sprout-XXXXXX", path); fd = mkstemp(tmp); if (fd >= 0) f = fdopen(fd, "wb"); if (!f && fd >= 0) close(fd);
#endif
  if (!f) { int e = errno ? errno : EIO; pr_unlink(tmp); free(tmp); return pr_errno_result("file_write", e); }
  int e = 0; if (fwrite(text, 1, len, f) != len || fflush(f)) e = errno ? errno : EIO;
#ifdef _WIN32
  if (!e && _commit(_fileno(f))) e = errno;
#else
  if (!e && fsync(fileno(f))) e = errno;
#endif
  if (fclose(f) && !e) e = errno;
  if (e) { pr_unlink(tmp); free(tmp); return pr_errno_result("file_write", e); }
  if (!pr_replace(tmp, path)) {
#ifdef _WIN32
    DWORD code = GetLastError(); pr_unlink(tmp); free(tmp); return pr_win_result("file_write replacement", code);
#else
    int code = errno; pr_unlink(tmp); free(tmp); return pr_errno_result("file_write replacement", code);
#endif
  }
#if !defined(_WIN32) && !defined(__EMSCRIPTEN__)
  /* Persist the rename as well as its contents. A sync failure is reported even
     though replacement may already be visible, so callers can handle durability. */
  char *parent = dup_str(path); char *slash = strrchr(parent, '/'); if (slash) { if (slash == parent) slash[1] = 0; else *slash = 0; } else { free(parent); parent = dup_str("."); }
  int dfd = open(parent, O_RDONLY); free(parent);
  if (dfd < 0 || fsync(dfd)) { int code = errno; if (dfd >= 0) close(dfd); free(tmp); return pr_errno_result("file_write directory sync (file was replaced)", code); }
  close(dfd);
#endif
  free(tmp); Value v = pr_result(1, NULL, 0); map_set(v.map, "bytes", vnum((double)len)); return v;
}
static Value pr_file_info(const char *path) {
  Value v;
#ifdef _WIN32
  wchar_t *w = pr_wide(path); WIN32_FILE_ATTRIBUTE_DATA data; int ok = w && GetFileAttributesExW(w, GetFileExInfoStandard, &data); DWORD e = ok ? 0 : GetLastError(); free(w);
  if (!ok) { if (e != ERROR_FILE_NOT_FOUND && e != ERROR_PATH_NOT_FOUND) return pr_win_result("file_info", e); v = pr_result(1, NULL, 0); map_set(v.map, "exists", vbool(0)); return v; }
  v = pr_result(1, NULL, 0); map_set(v.map, "exists", vbool(1)); map_set(v.map, "is_dir", vbool((data.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0));
  unsigned long long size = ((unsigned long long)data.nFileSizeHigh << 32) | data.nFileSizeLow;
  if (size <= INT64_MAX) map_set(v.map, "size", vexact((int64_t)size, 0, 0));
  else { char s[32]; snprintf(s, sizeof s, "%llu", size); map_set(v.map, "size", vstr(s)); }
#else
  struct stat st; if (stat(path, &st)) { if (errno != ENOENT && errno != ENOTDIR) return pr_errno_result("file_info", errno); v = pr_result(1, NULL, 0); map_set(v.map, "exists", vbool(0)); return v; }
  v = pr_result(1, NULL, 0); map_set(v.map, "exists", vbool(1)); map_set(v.map, "is_dir", vbool(S_ISDIR(st.st_mode))); map_set(v.map, "size", vexact((int64_t)st.st_size, 0, 0));
#endif
  return v;
}
static int pr_cmp_string(const void *a, const void *b) { return strcmp(((const Value *)a)->str, ((const Value *)b)->str); }
static Value pr_file_list(const char *path) {
  SList *entries = list_new();
#ifdef _WIN32
  PRBuffer pattern = {0}; pr_append(&pattern, path, strlen(path), 32760); pr_append(&pattern, "\\*", 2, 32760);
  wchar_t *w = pr_wide(pattern.p); free(pattern.p); if (!w) return pr_result(0, "file_list: path must be UTF-8", EINVAL);
  WIN32_FIND_DATAW data; HANDLE h = FindFirstFileW(w, &data); DWORD e = GetLastError(); free(w);
  if (h == INVALID_HANDLE_VALUE) return pr_win_result("file_list", e);
  do {
    if (!wcscmp(data.cFileName, L".") || !wcscmp(data.cFileName, L"..")) continue;
    char *s = pr_utf8(data.cFileName); if (!s) { FindClose(h); return pr_result(0, "file_list: filename encoding failed", EILSEQ); }
    list_push(entries, vstr_take(s));
    if (entries->n > 100000) { FindClose(h); return pr_result(0, "file_list: directory exceeds 100,000 entries", EFBIG); }
  } while (FindNextFileW(h, &data));
  e = GetLastError(); FindClose(h); if (e != ERROR_NO_MORE_FILES) return pr_win_result("file_list", e);
#else
  DIR *d = opendir(path); if (!d) return pr_errno_result("file_list", errno);
  struct dirent *ent; errno = 0;
  while ((ent = readdir(d))) { if (!strcmp(ent->d_name, ".") || !strcmp(ent->d_name, "..")) continue; list_push(entries, vstr(ent->d_name)); if (entries->n > 100000) { closedir(d); return pr_result(0, "file_list: directory exceeds 100,000 entries", EFBIG); } }
  int e = errno; closedir(d); if (e) return pr_errno_result("file_list", e);
#endif
  if (entries->n > 1) qsort(entries->items, (size_t)entries->n, sizeof(Value), pr_cmp_string);
  Value v = pr_result(1, NULL, 0); map_set(v.map, "entries", vlist(entries)); return v;
}
static Value pr_file_mkdir(const char *path) {
#ifdef _WIN32
  wchar_t *w = pr_wide(path); int ok = w && CreateDirectoryW(w, NULL); DWORD e = GetLastError(); free(w); return ok ? pr_result(1, NULL, 0) : pr_win_result("file_mkdir", e);
#else
  return mkdir(path, 0777) == 0 ? pr_result(1, NULL, 0) : pr_errno_result("file_mkdir", errno);
#endif
}
static Value pr_file_remove(const char *path) {
#ifdef _WIN32
  wchar_t *w = pr_wide(path); if (!w) return pr_result(0, "file_remove: path must be UTF-8", EINVAL);
  DWORD attr = GetFileAttributesW(w); int ok = attr != INVALID_FILE_ATTRIBUTES && ((attr & FILE_ATTRIBUTE_DIRECTORY) ? RemoveDirectoryW(w) : DeleteFileW(w)); DWORD e = GetLastError(); free(w);
  return ok ? pr_result(1, NULL, 0) : pr_win_result("file_remove", e);
#else
  return remove(path) == 0 ? pr_result(1, NULL, 0) : pr_errno_result("file_remove", errno);
#endif
}
static Value pr_file_move(const char *from, const char *to) {
  if (pr_replace(from, to)) return pr_result(1, NULL, 0);
#ifdef _WIN32
  return pr_win_result("file_move", GetLastError());
#else
  return pr_errno_result("file_move", errno);
#endif
}

/* HTTP transport. Windows uses the system WinHTTP TLS stack; POSIX uses curl
   through execvp (never a shell). Neither follows redirects implicitly. */
static int pr_token(const char *s) {
  if (!*s) return 0;
  for (; *s; s++) if (!isalnum((unsigned char)*s) && !strchr("!#$%&'*+-.^_`|~", *s)) return 0;
  return 1;
}
static void pr_header_put(SMap *headers, const char *key, const char *value) {
  char *lower = dup_str(key); for (char *p = lower; *p; p++) *p = (char)tolower((unsigned char)*p);
  int i = map_index(headers, lower); SList *vals = i < 0 ? list_new() : headers->vals[i].list;
  list_push(vals, vstr(value)); if (i < 0) map_set(headers, lower, vlist(vals)); free(lower);
}
static void pr_parse_headers(SMap *headers, const char *text, size_t length) {
  const char *p = text, *end = text + length;
  while (p < end) {
    const char *e = memchr(p, '\n', (size_t)(end - p)); if (!e) e = end;
    const char *trim = e; if (trim > p && trim[-1] == '\r') trim--;
    const char *colon = memchr(p, ':', (size_t)(trim - p));
    if (colon) {
      size_t klen = (size_t)(colon - p); char *k = (char *)malloc(klen + 1); if (!k) return;
      memcpy(k, p, klen); k[klen] = 0;
      const char *v = colon + 1; while (v < trim && (*v == ' ' || *v == '\t')) v++;
      while (trim > v && (trim[-1] == ' ' || trim[-1] == '\t')) trim--;
      size_t vlen = (size_t)(trim - v); char *s = (char *)malloc(vlen + 1);
      if (s) { memcpy(s, v, vlen); s[vlen] = 0; pr_header_put(headers, k, s); free(s); }
      free(k);
    }
    p = e < end ? e + 1 : end;
  }
}
static Value pr_http_result_raw(int status, const char *body, size_t body_len, int binary, SMap *headers, const char *error, int code, int timed_out) {
  Value v = pr_result(!error && status >= 200 && status < 300, error, code);
  map_set(v.map, "status", vnum(status)); map_set(v.map, "body", binary ? vbytes((const unsigned char *)body, body_len) : vstr(body ? body : ""));
  map_set(v.map, "headers", vmap(headers ? headers : map_new())); map_set(v.map, "timed_out", vbool(timed_out));
  return v;
}
static Value pr_http_result(int status, const char *body, SMap *headers, const char *error, int code, int timed_out) {
  return pr_http_result_raw(status, body, body ? strlen(body) : 0, 0, headers, error, code, timed_out);
}
#ifdef _WIN32
typedef struct {
  HMODULE library;
  HINTERNET (WINAPI *open)(LPCWSTR,DWORD,LPCWSTR,LPCWSTR,DWORD);
  BOOL (WINAPI *crack)(LPCWSTR,DWORD,DWORD,LPURL_COMPONENTS);
  HINTERNET (WINAPI *connect)(HINTERNET,LPCWSTR,INTERNET_PORT,DWORD);
  HINTERNET (WINAPI *open_request)(HINTERNET,LPCWSTR,LPCWSTR,LPCWSTR,LPCWSTR,LPCWSTR*,DWORD);
  BOOL (WINAPI *timeouts)(HINTERNET,int,int,int,int);
  BOOL (WINAPI *option)(HINTERNET,DWORD,LPVOID,DWORD);
  BOOL (WINAPI *send)(HINTERNET,LPCWSTR,DWORD,LPVOID,DWORD,DWORD,DWORD_PTR);
  BOOL (WINAPI *receive)(HINTERNET,LPVOID);
  BOOL (WINAPI *query)(HINTERNET,DWORD,LPCWSTR,LPVOID,LPDWORD,LPDWORD);
  BOOL (WINAPI *read)(HINTERNET,LPVOID,DWORD,LPDWORD);
  BOOL (WINAPI *close)(HINTERNET);
  WINHTTP_STATUS_CALLBACK (WINAPI *callback)(HINTERNET,WINHTTP_STATUS_CALLBACK,DWORD,DWORD_PTR);
} PRWinHTTP;
static int pr_http_load(PRWinHTTP *h) {
  memset(h, 0, sizeof *h); h->library = LoadLibraryW(L"winhttp.dll"); if (!h->library) return 0;
#define PR_HTTP_LOAD(field, symbol) do { FARPROC address = GetProcAddress(h->library, symbol); if (!address) return 0; memcpy(&h->field, &address, sizeof h->field); } while (0)
  PR_HTTP_LOAD(open,"WinHttpOpen"); PR_HTTP_LOAD(crack,"WinHttpCrackUrl"); PR_HTTP_LOAD(connect,"WinHttpConnect");
  PR_HTTP_LOAD(open_request,"WinHttpOpenRequest"); PR_HTTP_LOAD(timeouts,"WinHttpSetTimeouts"); PR_HTTP_LOAD(option,"WinHttpSetOption");
  PR_HTTP_LOAD(send,"WinHttpSendRequest"); PR_HTTP_LOAD(receive,"WinHttpReceiveResponse"); PR_HTTP_LOAD(query,"WinHttpQueryHeaders");
  PR_HTTP_LOAD(read,"WinHttpReadData"); PR_HTTP_LOAD(close,"WinHttpCloseHandle");
  PR_HTTP_LOAD(callback,"WinHttpSetStatusCallback");
#undef PR_HTTP_LOAD
  return 1;
}
typedef struct {
  volatile LONG refs;
  HANDLE event;
  DWORD code, got;
  char buffer[8192];
  char *body;
} PRHTTPAsync;
static void pr_http_release(PRHTTPAsync *a) {
  if (InterlockedDecrement(&a->refs) == 0) { CloseHandle(a->event); free(a->body); free(a); }
}
static void CALLBACK pr_http_callback(HINTERNET request, DWORD_PTR context, DWORD status, LPVOID info, DWORD length) {
  (void)request; PRHTTPAsync *a = (PRHTTPAsync *)context; if (!a) return;
  if (status == WINHTTP_CALLBACK_STATUS_HANDLE_CLOSING) { pr_http_release(a); return; }
  if (status == WINHTTP_CALLBACK_STATUS_REQUEST_ERROR) { a->code = ((WINHTTP_ASYNC_RESULT *)info)->dwError; SetEvent(a->event); }
  else if (status == WINHTTP_CALLBACK_STATUS_SENDREQUEST_COMPLETE || status == WINHTTP_CALLBACK_STATUS_HEADERS_AVAILABLE) SetEvent(a->event);
  else if (status == WINHTTP_CALLBACK_STATUS_READ_COMPLETE) { a->got = length; SetEvent(a->event); }
}
static int pr_http_wait(PRHTTPAsync *a, unsigned long long deadline) {
  unsigned long long now = pr_clock_ms();
  if (now >= deadline) { SetLastError(ERROR_WINHTTP_TIMEOUT); return 0; }
  DWORD wait = WaitForSingleObject(a->event, (DWORD)(deadline - now));
  if (wait != WAIT_OBJECT_0) { SetLastError(wait == WAIT_TIMEOUT ? ERROR_WINHTTP_TIMEOUT : GetLastError()); return 0; }
  if (a->code) { SetLastError(a->code); return 0; }
  return 1;
}
static Value pr_request(const char *url, const char *method, SMap *request_headers, const char *body, size_t body_len, int binary, int timeout_ms, size_t max_bytes) {
  /* A fixed DLL reference remains for async cancellation callbacks, which may
     finish after the caller's total deadline. Per-request state is ref-counted. */
  static PRWinHTTP shared; if (!shared.library && !pr_http_load(&shared)) { if (shared.library) FreeLibrary(shared.library); shared.library = NULL; return pr_http_result(0, "", NULL, "request: WinHTTP is unavailable", ENOSYS, 0); }
  PRWinHTTP h = shared; PRHTTPAsync *async = NULL; int async_bound = 0;
  wchar_t *wurl = pr_wide(url), *wmethod = pr_wide(method), *host = NULL, *path = NULL, *wheaders = NULL;
  HINTERNET session = NULL, connection = NULL, req = NULL; DWORD code = 0, status = 0;
  const char *error = NULL; PRBuffer out = {0}, headersbuf = {0}; SMap *headers = map_new(); int timed_out = 0;
  unsigned long long start = pr_clock_ms(), deadline = start + (unsigned)timeout_ms;
  URL_COMPONENTS c; memset(&c, 0, sizeof c); c.dwStructSize = sizeof c;
  c.dwHostNameLength = c.dwUrlPathLength = c.dwExtraInfoLength = c.dwUserNameLength = c.dwPasswordLength = (DWORD)-1;
  if (!wurl || !wmethod || !h.crack(wurl, 0, 0, &c) || (c.nScheme != INTERNET_SCHEME_HTTP && c.nScheme != INTERNET_SCHEME_HTTPS) || c.dwUserNameLength || c.dwPasswordLength) { error = "request: expected an http(s) URL without embedded credentials"; code = ERROR_INVALID_PARAMETER; goto http_cleanup; }
  host = (wchar_t *)calloc((size_t)c.dwHostNameLength + 1, sizeof(wchar_t));
  path = (wchar_t *)calloc((size_t)c.dwUrlPathLength + c.dwExtraInfoLength + 2, sizeof(wchar_t));
  if (!host || !path) { error = "request: memory allocation failed"; code = ERROR_NOT_ENOUGH_MEMORY; goto http_cleanup; }
  memcpy(host, c.lpszHostName, c.dwHostNameLength * sizeof(wchar_t));
  if (c.dwUrlPathLength) memcpy(path, c.lpszUrlPath, c.dwUrlPathLength * sizeof(wchar_t)); else path[0] = '/';
  if (c.dwExtraInfoLength) memcpy(path + wcslen(path), c.lpszExtraInfo, c.dwExtraInfoLength * sizeof(wchar_t));
  /* A fragment belongs to the client, never to the HTTP request target. */
  wchar_t *fragment = wcschr(path, L'#'); if (fragment) *fragment = 0;
  session = h.open(L"Sprout/production", WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY, WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, WINHTTP_FLAG_ASYNC);
  if (!session || !h.timeouts(session, timeout_ms, timeout_ms, timeout_ms, timeout_ms)) goto http_os_error;
  connection = h.connect(session, host, c.nPort, 0); if (!connection) goto http_os_error;
  req = h.open_request(connection, wmethod, path, NULL, WINHTTP_NO_REFERER, WINHTTP_DEFAULT_ACCEPT_TYPES, c.nScheme == INTERNET_SCHEME_HTTPS ? WINHTTP_FLAG_SECURE : 0);
  if (!req) goto http_os_error;
  DWORD policy = WINHTTP_OPTION_REDIRECT_POLICY_NEVER;
  if (!h.option(req, WINHTTP_OPTION_REDIRECT_POLICY, &policy, sizeof policy)) goto http_os_error;
  async = (PRHTTPAsync *)calloc(1, sizeof *async);
  if (!async) { error = "request: memory allocation failed"; code = ERROR_NOT_ENOUGH_MEMORY; goto http_cleanup; }
  async->refs = 1; async->event = CreateEventW(NULL, TRUE, FALSE, NULL); if (!async->event) goto http_os_error;
  if (h.callback(req, pr_http_callback, WINHTTP_CALLBACK_FLAG_ALL_COMPLETIONS | WINHTTP_CALLBACK_FLAG_HANDLES, 0) == WINHTTP_INVALID_STATUS_CALLBACK) goto http_os_error;
  DWORD_PTR context = (DWORD_PTR)async;
  if (!h.option(req, WINHTTP_OPTION_CONTEXT_VALUE, &context, sizeof context)) goto http_os_error;
  InterlockedIncrement(&async->refs); async_bound = 1;
  for (int i = 0; request_headers && i < request_headers->n; i++) {
    pr_append(&headersbuf, request_headers->keys[i], strlen(request_headers->keys[i]), 65536);
    pr_append(&headersbuf, ": ", 2, 65536); pr_append(&headersbuf, request_headers->vals[i].str, strlen(request_headers->vals[i].str), 65536); pr_append(&headersbuf, "\r\n", 2, 65536);
  }
  if (headersbuf.truncated) { error = "request: headers exceed 64 KiB"; code = ERROR_INVALID_PARAMETER; goto http_cleanup; }
  if (headersbuf.p) { wheaders = pr_wide(headersbuf.p); if (!wheaders) { error = "request: headers must be UTF-8"; code = ERROR_INVALID_PARAMETER; goto http_cleanup; } }
  DWORD blen = (DWORD)body_len;
  if (body) { async->body = (char *)malloc(body_len + 1); if (!async->body) { error = "request: memory allocation failed"; code = ERROR_NOT_ENOUGH_MEMORY; goto http_cleanup; } memcpy(async->body, body, body_len); async->body[body_len] = 0; }
  if (!h.send(req, wheaders ? wheaders : WINHTTP_NO_ADDITIONAL_HEADERS, wheaders ? (DWORD)-1 : 0, body ? (LPVOID)async->body : WINHTTP_NO_REQUEST_DATA, blen, blen, context) || !pr_http_wait(async, deadline)) goto http_os_error;
  ResetEvent(async->event);
  if (!h.receive(req, NULL) || !pr_http_wait(async, deadline)) goto http_os_error;
  DWORD size = sizeof status;
  if (!h.query(req, WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER, WINHTTP_HEADER_NAME_BY_INDEX, &status, &size, WINHTTP_NO_HEADER_INDEX)) goto http_os_error;
  size = 0;
  h.query(req, WINHTTP_QUERY_RAW_HEADERS_CRLF, WINHTTP_HEADER_NAME_BY_INDEX, NULL, &size, WINHTTP_NO_HEADER_INDEX);
  if (size && size <= 131072) {
    wchar_t *wh = (wchar_t *)calloc(1, (size_t)size + sizeof(wchar_t));
    if (!wh) { error = "request: memory allocation failed"; code = ERROR_NOT_ENOUGH_MEMORY; goto http_cleanup; }
    if (!h.query(req, WINHTTP_QUERY_RAW_HEADERS_CRLF, WINHTTP_HEADER_NAME_BY_INDEX, wh, &size, WINHTTP_NO_HEADER_INDEX)) { free(wh); goto http_os_error; }
    char *raw = pr_utf8(wh); free(wh); if (raw) { pr_parse_headers(headers, raw, strlen(raw)); free(raw); }
  } else if (size > 131072) { error = "request: response headers exceed 64 KiB"; code = ERROR_NOT_ENOUGH_MEMORY; goto http_cleanup; }
  for (;;) {
    ResetEvent(async->event); async->got = 0;
    if (!h.read(req, async->buffer, sizeof async->buffer, NULL) || !pr_http_wait(async, deadline)) goto http_os_error;
    if (!async->got) break;
    if (!pr_append(&out, async->buffer, async->got, max_bytes)) { error = "request: memory allocation failed"; code = ERROR_NOT_ENOUGH_MEMORY; goto http_cleanup; }
    if ((!binary && out.binary) || out.truncated) { error = out.binary && !binary ? "request: NUL bytes cannot be represented as text" : "request: response exceeds max_bytes"; code = ERROR_INSUFFICIENT_BUFFER; goto http_cleanup; }
  }
  goto http_cleanup;
http_os_error:
  code = GetLastError(); timed_out = code == ERROR_WINHTTP_TIMEOUT; error = timed_out ? "request: timeout" : "request: transport failure (see code)";
http_cleanup:
  if (req) h.close(req);
  if (connection) h.close(connection);
  if (session) h.close(session);
  if (async) { if (!async_bound) async->refs = 1; pr_http_release(async); }
  free(wurl); free(wmethod); free(host); free(path); free(wheaders); free(headersbuf.p);
  Value v = pr_http_result_raw((int)status, out.binary && !binary ? "" : out.p, out.binary && !binary ? 0 : out.n, binary, headers, error, (int)code, timed_out); free(out.p); return v;
}
#elif !defined(__EMSCRIPTEN__)
static Value pr_request(const char *url, const char *method, SMap *request_headers, const char *body, size_t body_len, int binary, int timeout_ms, size_t max_bytes) {
  int count = request_headers ? request_headers->n : 0;
  char **argv = (char **)calloc((size_t)count * 2 + 32, sizeof(char *)); if (!argv) return pr_http_result(0, "", NULL, "request: memory allocation failed", ENOMEM, 0);
  char timeout[40], limit[40]; snprintf(timeout, sizeof timeout, "%d.%03d", timeout_ms / 1000, timeout_ms % 1000); snprintf(limit, sizeof limit, "%zu", max_bytes);
  int n = 0;
#define PR_CURL_ARG(s) argv[n++] = (char *)(s)
  PR_CURL_ARG("curl"); PR_CURL_ARG("--disable"); PR_CURL_ARG("--silent"); PR_CURL_ARG("--show-error"); PR_CURL_ARG("--include");
  PR_CURL_ARG("--proto"); PR_CURL_ARG("=http,https"); PR_CURL_ARG("--max-time"); PR_CURL_ARG(timeout);
  PR_CURL_ARG("--max-filesize"); PR_CURL_ARG(limit); PR_CURL_ARG("--request"); PR_CURL_ARG(method);
  /* Suppress proxy CONNECT headers, so they cannot masquerade as origin status. */
  PR_CURL_ARG("--suppress-connect-headers");
  if (!strcmp(method, "HEAD")) PR_CURL_ARG("--head");
  char **owned = (char **)calloc((size_t)count + 1, sizeof(char *)); if (!owned) { free(argv); return pr_http_result(0, "", NULL, "request: memory allocation failed", ENOMEM, 0); }
  for (int i = 0; i < count; i++) {
    size_t len = strlen(request_headers->keys[i]) + strlen(request_headers->vals[i].str) + 3; owned[i] = (char *)malloc(len);
    if (!owned[i]) { for (int j = 0; j < i; j++) free(owned[j]); free(owned); free(argv); return pr_http_result(0, "", NULL, "request: memory allocation failed", ENOMEM, 0); }
    snprintf(owned[i], len, "%s: %s", request_headers->keys[i], request_headers->vals[i].str); PR_CURL_ARG("--header"); PR_CURL_ARG(owned[i]);
  }
  if (body) { PR_CURL_ARG("--data-binary"); PR_CURL_ARG("@-"); }
  PR_CURL_ARG("--url"); PR_CURL_ARG(url); argv[n] = NULL;
#undef PR_CURL_ARG
  PRProcess r = pr_run_raw(argv, n, NULL, body, body_len, pr_deadline_timeout(timeout_ms + 1000), max_bytes + 65536, binary, NULL);
  for (int i = 0; i < count; i++) free(owned[i]);
  free(owned); free(argv);
  SMap *headers = map_new(); int status = 0; const char *response = r.out + r.out_len, *p = r.out;
  while (!strncmp(p, "HTTP/", 5)) {
    const char *space = strchr(p, ' '); if (!space) break; int parsed = atoi(space + 1);
    const char *end = strstr(p, "\r\n\r\n"); size_t sep = 4; if (!end) { end = strstr(p, "\n\n"); sep = 2; }
    if (!end || (size_t)(end - p) > 65536) break;
    if (parsed >= 100 && parsed < 200 && parsed != 101) { p = end + sep; continue; }
    status = parsed; pr_parse_headers(headers, p, (size_t)(end - p)); response = end + sep; break;
  }
  const char *error = r.error; int timed_out = r.timed_out || r.exit_code == 28;
  if (!error && timed_out) error = "request: timeout";
  size_t response_len = r.out_len - (size_t)(response - r.out);
  if (!error && (r.truncated || r.exit_code == 63 || response_len > max_bytes)) error = "request: response exceeds max_bytes";
  if (!error && r.exit_code) error = r.err && *r.err ? r.err : "request: curl transport failure";
  if (!error && (!status || status < 100 || status > 599)) error = "request: invalid HTTP response";
  Value v = pr_http_result_raw(status, response, response_len, binary, headers, error, r.code ? r.code : r.exit_code, timed_out); pr_process_free(&r); return v;
}
#else
static Value pr_request(const char *url, const char *method, SMap *headers, const char *body, size_t body_len, int binary, int timeout_ms, size_t max_bytes) {
  (void)url; (void)method; (void)headers; (void)body; (void)body_len; (void)binary; (void)timeout_ms; (void)max_bytes;
  return pr_http_result(0, "", NULL, "request: unavailable in WebAssembly", ENOSYS, 0);
}
#endif



#include "sqlite.inc"

static const char *const PR_BUILTINS[] = {
  "request", "process", "file_read", "file_write", "file_info", "file_list", "file_mkdir", "file_remove", "file_move",
  "csv_parse", "csv_write", "sql_open", "sql_execute", "sql_transaction", "sql_close", NULL
};
static int production_builtin_name(const char *name) {
  for (int i = 0; PR_BUILTINS[i]; i++) if (!strcmp(name, PR_BUILTINS[i])) return 1;
  return 0;
}
static int production_builtin(const char *name, int n, Value *a, int line, Value *out) {
  if (!production_builtin_name(name)) return 0;
  if (!strcmp(name, "csv_parse") || !strcmp(name, "csv_write")) {
    if (n != 1 && n != 2) arity_error(line, name, "text/rows and an optional delimiter", n);
    char delim = pr_delimiter(n, a, line, name);
    if (!strcmp(name, "csv_parse")) *out = pr_csv_parse(want_str(line, name, 1, a[0], "csv_parse(text)"), delim, line);
    else *out = pr_csv_write(want_list(line, name, 1, a[0], "csv_write(rows)"), delim, line);
    return 1;
  }
  pr_host_guard(name, line);
  if (!strcmp(name, "process")) {
    if (n != 1 && n != 2) arity_error(line, name, "an argument list and an optional options map", n);
    SList *args = want_list(line, name, 1, a[0], "process([\"python\", \"report.py\"], {timeout_ms: 5000})");
    SMap *opts = n == 2 ? want_map(line, name, 2, a[1], NULL) : NULL;
    const char *const allowed[] = {"cwd", "stdin", "timeout_ms", "max_output", NULL}; pr_options(opts, allowed, line);
    if (args->n < 1 || args->n > 4096) fail(line, "process expects 1 to 4096 text arguments, starting with an executable.");
    for (int i = 0; i < args->n; i++) if (args->items[i].type != V_STR) fail(line, "each process argument must be text; arguments are passed literally without a shell.");
    if (!*args->items[0].str) fail(line, "process executable cannot be empty.");
    const char *cwd = pr_text_option(opts, "cwd", NULL, line), *input = pr_text_option(opts, "stdin", NULL, line);
    if (input && strlen(input) > PR_MAX_BYTES) fail(line, "process stdin exceeds the 16 MiB limit.");
    int timeout = pr_deadline_timeout(pr_int_option(opts, "timeout_ms", PR_DEFAULT_TIMEOUT, 1, 3600000, line));
    int max = pr_int_option(opts, "max_output", PR_DEFAULT_BYTES, 1, PR_MAX_BYTES, line);
    char **argv = (char **)calloc((size_t)args->n + 1, sizeof(char *)); if (!argv) fail(line, "ran out of memory starting a process.");
    for (int i = 0; i < args->n; i++) argv[i] = args->items[i].str;
    PRProcess result = pr_run(argv, args->n, cwd, input, timeout, (size_t)max); free(argv);
    *out = pr_process_value(&result); pr_process_free(&result); return 1;
  }
  if (!strcmp(name, "request")) {
    if (n != 1 && n != 2) arity_error(line, name, "an http(s) URL and an optional options map", n);
    const char *url = want_str(line, name, 1, a[0], "request(url, {method: \"POST\", body: text})");
    SMap *opts = n == 2 ? want_map(line, name, 2, a[1], NULL) : NULL;
    const char *const allowed[] = {"method", "headers", "body", "binary", "timeout_ms", "max_bytes", NULL}; pr_options(opts, allowed, line);
    const char *method = pr_text_option(opts, "method", "GET", line); Value body_value = pr_option(opts, "body"), binary_value = pr_option(opts, "binary");
    if (body_value.type != V_NONE && body_value.type != V_STR && body_value.type != V_BYTES) fail(line, "HTTP body must be text or bytes.");
    if (binary_value.type != V_NONE && binary_value.type != V_BOOL) fail(line, "HTTP binary option must be yes or no.");
    const char *body = body_value.type == V_NONE ? NULL : body_value.str;
    size_t body_len = body_value.type == V_BYTES ? body_value.length : body ? strlen(body) : 0;
    int binary = binary_value.type == V_BOOL && binary_value.boolean;
    if (!pr_token(method) || strlen(method) > 32) fail(line, "HTTP method must be a valid token, such as GET or POST.");
    if (strlen(url) > 32760 || (strncmp(url, "http://", 7) && strncmp(url, "https://", 8)) || strchr(url, '\r') || strchr(url, '\n')) fail(line, "request needs an http:// or https:// URL without newline characters.");
    if (body_len > PR_MAX_BYTES) fail(line, "HTTP request body exceeds the 16 MiB limit.");
    Value hv = pr_option(opts, "headers"); if (hv.type != V_NONE && hv.type != V_MAP) fail(line, "HTTP headers must be a map of names to text values.");
    SMap *headers = hv.type == V_MAP ? hv.map : NULL; size_t header_bytes = 0;
    if (headers && headers->n > 1000) fail(line, "HTTP request supports at most 1000 headers.");
    for (int i = 0; headers && i < headers->n; i++) {
      if (!pr_token(headers->keys[i]) || headers->vals[i].type != V_STR || strchr(headers->vals[i].str, '\r') || strchr(headers->vals[i].str, '\n')) fail(line, "HTTP header names must be tokens and values text without newline characters.");
      header_bytes += strlen(headers->keys[i]) + strlen(headers->vals[i].str) + 4;
    }
    if (header_bytes > 65536) fail(line, "HTTP request headers exceed 64 KiB.");
    int timeout = pr_deadline_timeout(pr_int_option(opts, "timeout_ms", PR_DEFAULT_TIMEOUT, 1, 3600000, line));
    int max = pr_int_option(opts, "max_bytes", PR_DEFAULT_BYTES, 1, PR_MAX_BYTES, line);
    *out = pr_request(url, method, headers, body, body_len, binary, timeout, (size_t)max); return 1;
  }
  if (!strncmp(name, "file_", 5)) {
    int two = !strcmp(name, "file_write") || !strcmp(name, "file_move");
    if ((!strcmp(name, "file_read") && n != 1 && n != 2) || (strcmp(name, "file_read") && n != (two ? 2 : 1))) arity_error(line, name, two ? "two text inputs" : "a path (file_read also accepts an options map)", n);
    const char *path = want_str(line, name, 1, a[0], NULL);
    if (!*path || strlen(path) > 30000) fail(line, "file path must be nonempty text of at most 30,000 bytes.");
    if (!strcmp(name, "file_read")) {
      SMap *opts = n == 2 ? want_map(line, name, 2, a[1], NULL) : NULL; const char *const allowed[] = {"max_bytes", "binary", NULL}; pr_options(opts, allowed, line);
      Value bv = pr_option(opts, "binary"); if (bv.type != V_NONE && bv.type != V_BOOL) fail(line, "file_read binary option must be yes or no.");
      int max = pr_int_option(opts, "max_bytes", PR_DEFAULT_BYTES, 1, PR_MAX_BYTES, line); *out = pr_file_read(path, (size_t)max, bv.type == V_BOOL && bv.boolean);
    } else if (!strcmp(name, "file_write")) {
      if (a[1].type != V_STR && a[1].type != V_BYTES) arg_error(line, name, 2, "text or bytes", a[1], NULL);
      *out = pr_file_write(path, a[1].str, a[1].type == V_BYTES ? a[1].length : strlen(a[1].str));
    }
    else if (!strcmp(name, "file_info")) *out = pr_file_info(path);
    else if (!strcmp(name, "file_list")) *out = pr_file_list(path);
    else if (!strcmp(name, "file_mkdir")) *out = pr_file_mkdir(path);
    else if (!strcmp(name, "file_remove")) *out = pr_file_remove(path);
    else *out = pr_file_move(path, want_str(line, name, 2, a[1], NULL));
    return 1;
  }
#ifdef SPROUT_SQLITE
  if (!strcmp(name, "sql_open")) {
    if (n != 1 && n != 2) arity_error(line, name, "a database path and optional options map", n);
    *out = pr_sql_open(want_str(line, name, 1, a[0], "sql_open(\"app.db\")"), n == 2 ? want_map(line, name, 2, a[1], NULL) : NULL, line); return 1;
  }
  if (!strcmp(name, "sql_close")) { if (n != 1) arity_error(line, name, "a database handle", n); *out = pr_sql_close(a[0], line); return 1; }
  if (!strcmp(name, "sql_execute")) {
    if (n < 2 || n > 4) arity_error(line, name, "a handle, SQL text, optional params list and options map", n);
    *out = pr_sql_execute(a[0], want_str(line, name, 2, a[1], NULL), n >= 3 ? want_list(line, name, 3, a[2], NULL) : NULL, n == 4 ? want_map(line, name, 4, a[3], NULL) : NULL, line); return 1;
  }
  if (n != 2 && n != 3) arity_error(line, name, "a handle, statement list and optional options map", n);
  *out = pr_sql_transaction(a[0], want_list(line, name, 2, a[1], NULL), n == 3 ? want_map(line, name, 3, a[2], NULL) : NULL, line); return 1;
#else
  *out = pr_result(0, "SQLite support was not included in this build (compile with SPROUT_SQLITE)", ENOSYS); return 1;
#endif
}
