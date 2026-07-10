/* sprout.c — a NATIVE Sprout interpreter, written in C. No Node, no runtime,
 * no dependencies but the C standard library + the operating system.
 *
 *   gcc -O2 -o sprout sprout.c
 *   ./sprout program.sprout
 *
 * Implements the core language: make/set/show, numbers, text, booleans, nothing,
 * the math/compare/and/or/not operators, `when`/`orwhen`/`otherwise`, `repeat`,
 * `task`/`give` with recursion, and lists/maps with indexing, `for each`, and the
 * collection builtins (range, length, add, keys, contains, first, last).
 * (f-strings, input, and the libraries come in later slices.)
 *
 * Memory is intentionally never freed — a Sprout program is short-lived and the
 * OS reclaims everything on exit. A later slice can add a small garbage collector.
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <ctype.h>
#include <math.h>
#include <setjmp.h>
#include <time.h>
#ifdef _WIN32
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <urlmon.h>
#include <io.h>         /* _setmode — clean LF stdout for `sprout format` */
#include <fcntl.h>
#endif

#ifndef _WIN32
#include <sys/stat.h>   /* mkdir() for `sprout new` on POSIX */
#include <dirent.h>     /* opendir() to test if a folder is empty */
#include <limits.h>     /* PATH_MAX for realpath() */
#include <unistd.h>     /* getpid() for the POSIX http_get temp file */
#include <sys/resource.h>  /* getrlimit() — size the deep-recursion guard to the real stack */
#endif
#ifdef __APPLE__
#include <mach-o/dyld.h>   /* _NSGetExecutablePath, for `sprout bundle` */
#endif

static char *dup_str(const char *s) { size_t n = strlen(s) + 1; char *p = (char *)malloc(n); memcpy(p, s, n); return p; }
static char *gc_strdup(const char *s);   /* a GC-tracked copy of s (defined just after the GC allocator below) */

/* terminal colours, used across messages, the TUI, and learn mode */
#define C_RESET "\x1b[0m"
#define C_GREEN "\x1b[32m"
#define C_RED   "\x1b[31m"
#define C_BOLD  "\x1b[1m"
#define C_DIM   "\x1b[2m"
#define C_CYAN  "\x1b[36m"

static void fail(int line, const char *msg);   /* defined below; declared early so allocators can bail out */

/* byte-length of the UTF-8 character starting at byte c (1..4; 1 for an invalid byte) */
static int utf8_clen(unsigned char c) {
  if (c < 0x80) return 1;
  if ((c >> 5) == 0x6) return 2;
  if ((c >> 4) == 0xE) return 3;
  if ((c >> 3) == 0x1E) return 4;
  return 1;
}

/* ------------------------------------------------------------------ values */
typedef enum { V_NUM, V_STR, V_BOOL, V_NONE, V_LIST, V_MAP, V_TASK } VType;
typedef struct Value Value;
typedef struct TaskDef TaskDef;   /* a first-class task value points at one of these (defined later) */
static const char *taskdef_name(TaskDef *t);   /* TaskDef's fields aren't known this early; reach the name through here */
typedef struct { Value *items; int n, cap; } SList;
/* keys[]/vals[] stay insertion-ordered (so iteration order is unchanged); idx[] is an
   open-addressing hash index (storing position+1, 0 = empty) that makes key lookup O(1). */
typedef struct { char **keys; Value *vals; int n, cap; int *idx; int idxcap; const char *classname; } SMap;  /* classname != NULL marks an object instance of that type */
struct Value { VType type; double num; char *str; int boolean; SList *list; SMap *map; TaskDef *task; };

static Value vnum(double n)  { Value v = {0}; v.type = V_NUM;  v.num = n; return v; }
static Value vstr(const char *s) { Value v = {0}; v.type = V_STR; v.str = gc_strdup(s ? s : ""); return v; }
static Value vbool(int b)    { Value v = {0}; v.type = V_BOOL; v.boolean = b; return v; }
static Value vnone(void)     { Value v = {0}; v.type = V_NONE; return v; }
static Value vlist(SList *l) { Value v = {0}; v.type = V_LIST; v.list = l; return v; }
static Value vmap(SMap *m)   { Value v = {0}; v.type = V_MAP;  v.map = m;  return v; }
static Value vtask(TaskDef *t){ Value v = {0}; v.type = V_TASK; v.task = t; return v; }

/* ---------------- garbage collector: header + allocator (the collector is below) ----------------
   A conservative mark-sweep GC. Every collectible object (list, map, environment, lambda
   closure) carries a GCObj header and is tracked in `gc_all`; the collector finds roots by
   scanning the C stack + registers plus a few precise globals, so it never frees a live
   object. Heap strings are collected too: every Value's text is a GC_STR copy (vstr copies
   into the GC), so strings are marked and swept alongside the values that hold them. The
   strings that map keys / env names / module tables own stay plain malloc — they live in
   places the conservative scan never reaches, so the GC must not touch them. */
typedef enum { GC_LIST, GC_MAP, GC_ENV, GC_TASK, GC_STR } GCKind;
typedef struct GCObj { struct GCObj *next; GCKind kind; int mark; } GCObj;
static GCObj *gc_all = NULL;                        /* every live collectible allocation */
static size_t gc_bytes = 0, gc_threshold = 4u << 20;   /* collect once ~4 MB has been allocated since the last GC */
static int gc_stress = 0;                           /* SPROUT_GC_STRESS=1 -> collect aggressively (testing) */
static void *gc_alloc(GCKind kind, size_t size) {   /* a zeroed object + header, tracked for sweeping */
  GCObj *h = (GCObj *)calloc(1, sizeof(GCObj) + size);
  if (!h) fail(0, "ran out of memory.");
  h->kind = kind; h->next = gc_all; gc_all = h;
  gc_bytes += size;
  return (void *)(h + 1);
}
#define GC_HDR(p) ((GCObj *)(p) - 1)
/* A heap string the collector owns: it carries a GCObj header like any other object, so the
   conservative scan can find it and the sweep can free it. vstr() copies into one of these;
   vstr_take() does the same but frees a malloc'd original (used for builtin-built buffers). */
static char *gc_strdup(const char *s) { size_t n = strlen(s) + 1; char *p = (char *)gc_alloc(GC_STR, n); memcpy(p, s, n); return p; }
static Value vstr_take(char *owned) { Value v = vstr(owned ? owned : ""); free(owned); return v; }

static SList *list_new(void) { return (SList *)gc_alloc(GC_LIST, sizeof(SList)); }
static void list_push(SList *l, Value x) {
  if (l->n >= l->cap) {
    l->cap = l->cap ? l->cap * 2 : 8;
    Value *ni = (Value *)realloc(l->items, l->cap * sizeof(Value));
    if (!ni) fail(0, "ran out of memory building a list.");
    l->items = ni;
  }
  l->items[l->n++] = x;
}
static SMap *map_new(void) { return (SMap *)gc_alloc(GC_MAP, sizeof(SMap)); }
static unsigned map_hash(const char *s) {            /* FNV-1a */
  unsigned h = 2166136261u;
  while (*s) { h ^= (unsigned char)*s++; h *= 16777619u; }
  return h;
}
/* find k -> its position in keys[]/vals[], or -1. O(1) average via the hash index. */
static int map_index(SMap *m, const char *k) {
  if (m->idxcap == 0) {                              /* no index yet (empty map) */
    for (int i = 0; i < m->n; i++) if (!strcmp(m->keys[i], k)) return i;
    return -1;
  }
  unsigned mask = (unsigned)m->idxcap - 1, slot = map_hash(k) & mask;
  while (m->idx[slot]) {                             /* probe until an empty slot */
    int pos = m->idx[slot] - 1;
    if (!strcmp(m->keys[pos], k)) return pos;
    slot = (slot + 1) & mask;
  }
  return -1;
}
static void map_idx_put(SMap *m, int pos) {          /* record keys[pos] -> pos in the index */
  unsigned mask = (unsigned)m->idxcap - 1, slot = map_hash(m->keys[pos]) & mask;
  while (m->idx[slot]) slot = (slot + 1) & mask;
  m->idx[slot] = pos + 1;
}
/* (re)build the index from keys[], sized to keep the load factor <= 1/2. Call after any
   change that shifts positions (e.g. remove), and to grow as the map fills. */
static void map_reindex(SMap *m) {
  m->idxcap = m->idxcap ? m->idxcap : 16;
  while (m->idxcap < m->n * 2) m->idxcap *= 2;
  m->idx = (int *)realloc(m->idx, (size_t)m->idxcap * sizeof(int));
  if (!m->idx) fail(0, "ran out of memory building a map.");
  memset(m->idx, 0, (size_t)m->idxcap * sizeof(int));
  for (int i = 0; i < m->n; i++) map_idx_put(m, i);
}
static void map_set(SMap *m, const char *k, Value x) {
  int i = map_index(m, k);
  if (i >= 0) { m->vals[i] = x; return; }
  if (m->n >= m->cap) {
    m->cap = m->cap ? m->cap * 2 : 8;
    char **nk = (char **)realloc(m->keys, m->cap * sizeof(char *));
    Value *nv = (Value *)realloc(m->vals, m->cap * sizeof(Value));
    if (!nk || !nv) fail(0, "ran out of memory building a map.");
    m->keys = nk; m->vals = nv;
  }
  m->keys[m->n] = dup_str(k); m->vals[m->n] = x; m->n++;
  if (m->idxcap < m->n * 2) map_reindex(m);          /* grow + rebuild (also builds it the first time) */
  else map_idx_put(m, m->n - 1);                     /* otherwise just index the new key */
}

static char *num_to_str(double n) {
  char buf[64];
  if (!isfinite(n)) return dup_str(n != n ? "nan" : (n < 0 ? "-inf" : "inf"));
  double a = fabs(n);
  /* whole numbers print with ALL their digits (never 1.2e+19 style) up to 1e21 — matching
     how Java/JavaScript show integers; %g's old 6-sig-fig scientific form looked broken. */
  if (n == floor(n) && a < 1e21) {
    if (a < 9007199254740992.0) snprintf(buf, sizeof buf, "%lld", (long long)n);   /* exact-integer range (2^53), fast path */
    else snprintf(buf, sizeof buf, "%.0f", n);                                     /* still integral, just beyond 2^53 */
  } else {
    /* a fraction (or an astronomically large value): the shortest decimal that reparses to
       the same double, so `show 0.1 + 0.2` tells the truth instead of rounding to "0.3". */
    for (int prec = 15; prec <= 17; prec++) { snprintf(buf, sizeof buf, "%.*g", prec, n); if (strtod(buf, NULL) == n) break; }
  }
  return dup_str(buf);
}
/* a tiny growing-string helper for stringify */
static void sb_add(char **buf, size_t *cap, size_t *len, const char *s) {
  size_t sl = strlen(s);
  while (*len + sl + 1 > *cap) { *cap = *cap ? *cap * 2 : 16; char *nb = (char *)realloc(*buf, *cap); if (!nb) fail(0, "ran out of memory building text."); *buf = nb; }
  memcpy(*buf + *len, s, sl + 1); *len += sl;
}
static int g_str_depth = 0;
/* object types (classes) are defined much further down; declare what stringify() and
   eval_binary() need so they can dispatch to a type's text()/plus()/compare()/... methods. */
typedef struct TypeReg TypeReg;
static TypeReg *type_find(const char *name);
static int type_is_a(TypeReg *t, const char *name);
static TaskDef *type_method(TypeReg *t, const char *name);
static Value call_task_v(TaskDef *t, Value *argv, int argc, int line);
/* if v is an object whose type defines method `name`, return that method, else NULL */
static TaskDef *type_op_method(Value v, const char *name) {
  if (v.type != V_MAP || !v.map || !v.map->classname) return NULL;
  TypeReg *t = type_find(v.map->classname);
  return t ? type_method(t, name) : NULL;
}
static char *stringify_inner(Value v);
/* a map key prints bare only if it reads back as one word (letters/digits/_ , not starting with a
   digit); anything else (spaces, brackets, a stringified list/number) is quoted so the display
   doesn't lie about the key being text — e.g. group_by with a list key shows {"[1]": ...}. */
static int key_is_bare(const char *k) {
  if (!k || !k[0]) return 0;
  if (!isalpha((unsigned char)k[0]) && k[0] != '_') return 0;
  for (const char *p = k; *p; p++) if (!isalnum((unsigned char)*p) && *p != '_') return 0;
  return 1;
}
static char *stringify(Value v) {
  if (++g_str_depth > 300) { g_str_depth--; return dup_str("..."); }   /* guard self-referential values */
  char *r = stringify_inner(v);
  g_str_depth--;
  return r;
}
static char *stringify_inner(Value v) {
  switch (v.type) {
    case V_NUM:  return num_to_str(v.num);
    case V_STR:  return dup_str(v.str ? v.str : "");
    case V_BOOL: return dup_str(v.boolean ? "yes" : "no");
    case V_LIST: {
      SList *l = v.list; size_t cap = 0, len = 0; char *out = NULL;
      sb_add(&out, &cap, &len, "[");
      for (int i = 0; l && i < l->n; i++) { if (i) sb_add(&out, &cap, &len, ", "); char *p = stringify(l->items[i]); sb_add(&out, &cap, &len, p); }
      sb_add(&out, &cap, &len, "]"); return out;
    }
    case V_MAP: {
      if (v.map && v.map->classname) {                 /* an object with a text() method renders itself */
        TaskDef *tm = type_op_method(v, "text");
        if (tm) { Value rv = call_task_v(tm, &v, 1, 0); if (rv.type == V_STR) return dup_str(rv.str ? rv.str : ""); }
      }
      SMap *m = v.map; size_t cap = 0, len = 0; char *out = NULL;
      if (m && m->classname) { sb_add(&out, &cap, &len, m->classname); sb_add(&out, &cap, &len, " "); }
      sb_add(&out, &cap, &len, "{");
      for (int i = 0; m && i < m->n; i++) {
        if (i) sb_add(&out, &cap, &len, ", ");
        if (key_is_bare(m->keys[i])) sb_add(&out, &cap, &len, m->keys[i]);
        else { sb_add(&out, &cap, &len, "\""); sb_add(&out, &cap, &len, m->keys[i]); sb_add(&out, &cap, &len, "\""); }
        sb_add(&out, &cap, &len, ": "); char *p = stringify(m->vals[i]); sb_add(&out, &cap, &len, p);
      }
      sb_add(&out, &cap, &len, "}"); return out;
    }
    case V_TASK: { char buf[128]; snprintf(buf, sizeof buf, "task %s", taskdef_name(v.task)); return dup_str(buf); }
    default:     return dup_str("nothing");
  }
}
static const char *type_name(Value v) {
  switch (v.type) { case V_NUM: return "a number"; case V_STR: return "text"; case V_BOOL: return "a yes/no"; case V_LIST: return "a list"; case V_MAP: return "a map"; case V_TASK: return "a task"; default: return "nothing"; }
}
static int is_truthy(Value v) {
  switch (v.type) { case V_NUM: return v.num != 0; case V_STR: return v.str && v.str[0]; case V_BOOL: return v.boolean; case V_LIST: return v.list && v.list->n > 0; case V_MAP: return v.map && v.map->n > 0; case V_TASK: return 1; default: return 0; }
}
static int g_eq_depth = 0;
static int values_equal_inner(Value a, Value b);
static int values_equal(Value a, Value b) {
  if (++g_eq_depth > 300) { g_eq_depth--; return 0; }   /* guard self-referential values */
  int r = values_equal_inner(a, b);
  g_eq_depth--;
  return r;
}
static int values_equal_inner(Value a, Value b) {
  if (a.type != b.type) return 0;
  switch (a.type) {
    case V_NUM:  return a.num == b.num;
    case V_STR:  return strcmp(a.str ? a.str : "", b.str ? b.str : "") == 0;
    case V_BOOL: return a.boolean == b.boolean;
    case V_LIST: {
      SList *x = a.list, *y = b.list; if (!x || !y) return x == y;
      if (x->n != y->n) return 0;
      for (int i = 0; i < x->n; i++) if (!values_equal(x->items[i], y->items[i])) return 0;
      return 1;
    }
    case V_MAP: {
      SMap *x = a.map, *y = b.map; if (!x || !y) return x == y;
      if (x->n != y->n) return 0;
      for (int i = 0; i < x->n; i++) { int j = map_index(y, x->keys[i]); if (j < 0 || !values_equal(x->vals[i], y->vals[j])) return 0; }
      return 1;
    }
    case V_TASK: return a.task == b.task;   /* two task values are equal iff they're the same task */
    default:     return 1;
  }
}

/* ------------------------------------------------------------------- errors */
/* Two boundary kinds:
   - err_jmp  = the nearest boundary of ANY sort. A `try:` sets this so a SOFT error
                (a runtime condition: bad input, divide-by-zero, a file miss, `fail`) is caught.
   - g_top_jmp = the nearest SYSTEM boundary (a test, the REPL, a file/project run). HARD errors
                (name/task typos - the "did you mean?" mistakes) skip every `try:` and stop here,
                so a beginner can't accidentally swallow the diagnostics that exist to help them.
   A system boundary sets BOTH (it catches everything); a `try:` sets only err_jmp.

   On mingw, libc setjmp/longjmp unwind via Windows SEH (RtlUnwindEx), which is fragile across
   -O2 frames - it crashed in v0.0.13->14 and again on the Windows CI runner in v0.0.15 (a
   longjmp issued from inside a block itself reached via longjmp - a re-raise from `caught`).
   So on Windows we use __builtin_setjmp/longjmp (a plain sp/fp/pc save+restore, no unwinder -
   exactly right for a C interpreter with no destructors). macOS clang doesn't support
   __builtin_longjmp ("not supported for the current target"), and libc setjmp/longjmp are
   fine on Linux/macOS - so use those there. The rest of the error code is identical. */
#if defined(_WIN32)
  typedef void *sjmp_buf[8];                /* gcc needs >= 5 words; 8 is a safe margin */
  #define SJSET(b)   __builtin_setjmp(b)
  #define SJLONG(b)  __builtin_longjmp((b), 1)
#else
  typedef jmp_buf sjmp_buf;
  #define SJSET(b)   setjmp(b)
  #define SJLONG(b)  longjmp((b), 1)
#endif
static sjmp_buf *err_jmp = NULL;
static sjmp_buf *g_top_jmp = NULL;
static const char *g_current_file = NULL;   /* the file being parsed/run, for multi-file errors */
static int  g_quiet_fail = 0;     /* >0 inside a 'try:' - a caught soft error is handed to 'caught', not printed */
static char g_err_msg[512];       /* the most recent error's message  (the caught error's `message`) */
static int  g_err_line = 0;       /* ...its line                       (the caught error's `line`)    */
static const char *g_err_kind = "error";  /* ...its category           (the caught error's `kind`)    */
/* the task-call stack, for tracebacks. call_depth is also the recursion guard (capped at MAX_DEPTH);
   g_frames[d] holds the task running at depth d + the line it was called from. Restoring call_depth
   on a caught 'try:' automatically forgets the deeper frames, so nothing extra is needed there. */
#define MAX_CALL_FRAMES 6001
static int call_depth = 0;
static struct { const char *name; int line; } g_frames[MAX_CALL_FRAMES];
static void fail_full(int line, const char *msg, const char *kind, int hard) {
  snprintf(g_err_msg, sizeof g_err_msg, "%s", msg ? msg : "something went wrong.");
  g_err_line = line;
  g_err_kind = kind ? kind : "error";
  if (!hard && g_quiet_fail && err_jmp) SJLONG(*err_jmp);   /* soft error caught by an enclosing try: (don't print) */
  fprintf(stderr, "\n  Sprout error");
  if (g_current_file) fprintf(stderr, " in %s", g_current_file);
  if (line > 0) fprintf(stderr, " (line %d)", line);
  fprintf(stderr, ": %s\n\n", msg);
  if (call_depth > 0) {                                  /* the chain of task calls that led here */
    fprintf(stderr, "  call trace (innermost first):\n");
    int limit = 12, shown = 0, d0 = call_depth < MAX_CALL_FRAMES ? call_depth : MAX_CALL_FRAMES - 1;
    for (int d = d0; d >= 1 && shown < limit; d--, shown++)
      fprintf(stderr, "    %s  (called at line %d)\n", g_frames[d].name ? g_frames[d].name : "a task", g_frames[d].line);
    if (call_depth > limit) fprintf(stderr, "    ... and %d earlier call%s\n", call_depth - limit, call_depth - limit == 1 ? "" : "s");
    fprintf(stderr, "\n");
  }
  sjmp_buf *target = g_top_jmp ? g_top_jmp : err_jmp;   /* uncaught or hard: stop at the nearest SYSTEM boundary */
  if (target) SJLONG(*target);
  exit(1);
}
static void fail(int line, const char *msg)                          { fail_full(line, msg, "error", 0); }
static void fail_kind(int line, const char *kind, const char *msg)   { fail_full(line, msg, kind, 0); }   /* soft, categorised */
static void fail_hard(int line, const char *kind, const char *msg)   { fail_full(line, msg, kind, 1); }   /* uncatchable (a code mistake) */
static void failf(int line, const char *fmt, const char *arg) {
  char buf[256]; snprintf(buf, sizeof buf, fmt, arg); fail(line, buf);
}
/* The value a try: hands to its `caught` block - ALWAYS a map {message, kind, line}.
   A `fail <map>` supplies its own map (we only guarantee those three keys exist), so a
   library or the web `kind` can carry structure (e.g. {kind:"http", status:404}). */
static int   g_have_fail_override = 0;
static Value g_fail_override;
static Value current_error_value(void) {
  if (g_have_fail_override) { g_have_fail_override = 0; return g_fail_override; }
  SMap *m = map_new();
  map_set(m, "message", vstr_take(dup_str(g_err_msg)));
  map_set(m, "kind",    vstr_take(dup_str(g_err_kind ? g_err_kind : "error")));
  map_set(m, "line",    vnum((double)g_err_line));
  return vmap(m);
}

/* ------------------------------------------------- value-aware error helpers
   These make every error name the thing that actually broke: which input, the
   real type + value you passed, and a fix. val_describe() renders a short preview
   of a value; arg_error()/arity_error() are the two workhorses the builtins call,
   and want_num()/want_str()/... check-and-extract one expected type in a line. */
static int snprint_num(char *buf, size_t cap, double d) {   /* a number the way Sprout shows it */
  if (isfinite(d) && d == (double)(long long)d && d >= -1e15 && d <= 1e15) return snprintf(buf, cap, "%lld", (long long)d);
  return snprintf(buf, cap, "%g", d);
}
static void val_describe(Value v, char *buf, size_t cap) {  /* a short, human preview: 'a number (5)', 'text ("hi")', 'an empty list' */
  switch (v.type) {
    case V_NUM: { char n[40]; snprint_num(n, sizeof n, v.num); snprintf(buf, cap, "a number (%s)", n); break; }
    case V_STR: { const char *s = v.str ? v.str : ""; char clip[44]; size_t i = 0;
                  for (; s[i] && i < 40; i++) { clip[i] = s[i]; }
                  clip[i] = 0;
                  snprintf(buf, cap, "text (\"%s%s\")", clip, s[i] ? "\xE2\x80\xA6" : ""); break; }
    case V_BOOL: snprintf(buf, cap, "%s", v.boolean ? "yes" : "no"); break;
    case V_NONE: snprintf(buf, cap, "nothing"); break;
    case V_LIST: { int k = v.list ? v.list->n : 0;
                   if (k == 0) snprintf(buf, cap, "an empty list"); else snprintf(buf, cap, "a list of %d item%s", k, k == 1 ? "" : "s"); break; }
    case V_MAP:  if (v.map && v.map->classname) snprintf(buf, cap, "a %s", v.map->classname);
                 else { int k = v.map ? v.map->n : 0; if (k == 0) snprintf(buf, cap, "an empty map"); else snprintf(buf, cap, "a map with %d entr%s", k, k == 1 ? "y" : "ies"); } break;
    case V_TASK: snprintf(buf, cap, "a task"); break;
    default:     snprintf(buf, cap, "a value"); break;
  }
}
/* (type_name() near the top of the file already renders a value's type for messages) */
static const char *nth_word(int n) {
  switch (n) { case 1: return "1st"; case 2: return "2nd"; case 3: return "3rd"; case 4: return "4th";
    case 5: return "5th"; case 6: return "6th"; case 7: return "7th"; case 8: return "8th"; }
  return "next";
}
/* "<fn> expected its <pos> input to be <expected>, but got <actual>.  Try: <hint>" */
static void arg_error(int line, const char *fn, int pos, const char *expected, Value got, const char *hint) {
  char desc[96]; val_describe(got, desc, sizeof desc);
  char msg[512];
  if (hint && *hint) snprintf(msg, sizeof msg, "%s expected its %s input to be %s, but got %s.\n\n  Try:  %s", fn, nth_word(pos), expected, desc, hint);
  else               snprintf(msg, sizeof msg, "%s expected its %s input to be %s, but got %s.", fn, nth_word(pos), expected, desc);
  fail_kind(line, "error", msg);   /* a built-in called the wrong way is the generic 'error' kind (operators/[ ] use 'type') */
}
/* "<fn> takes <usage>, but you gave <got> input(s)." */
static void arity_error(int line, const char *fn, const char *usage, int got) {
  char msg[512]; snprintf(msg, sizeof msg, "%s takes %s, but you gave %d input%s.", fn, usage, got, got == 1 ? "" : "s");
  fail(line, msg);
}
/* check-and-extract one expected type; on mismatch, a detailed arg_error naming what you passed */
static double   want_num (int line, const char *fn, int pos, Value v, const char *hint) { if (v.type != V_NUM)  arg_error(line, fn, pos, "a number", v, hint);  return v.num; }
static char    *want_str (int line, const char *fn, int pos, Value v, const char *hint) { if (v.type != V_STR)  arg_error(line, fn, pos, "some text", v, hint); return v.str; }
static SList   *want_list(int line, const char *fn, int pos, Value v, const char *hint) { if (v.type != V_LIST) arg_error(line, fn, pos, "a list", v, hint);   return v.list; }
static SMap    *want_map (int line, const char *fn, int pos, Value v, const char *hint) { if (v.type != V_MAP)  arg_error(line, fn, pos, "a map", v, hint);    return v.map; }
static TaskDef *want_task(int line, const char *fn, int pos, Value v, const char *hint) { if (v.type != V_TASK) arg_error(line, fn, pos, "a task", v, hint);   return v.task; }
/* the very common "exactly one <type>" builtin guard, with detailed arity + value messages */
static void want_one_num(int line, const char *fn, int n, Value *a, const char *hint) { if (n != 1) arity_error(line, fn, "one number", n); if (a[0].type != V_NUM) arg_error(line, fn, 1, "a number", a[0], hint); }
static void want_one_str(int line, const char *fn, int n, Value *a, const char *hint) { if (n != 1) arity_error(line, fn, "one piece of text", n); if (a[0].type != V_STR) arg_error(line, fn, 1, "some text", a[0], hint); }

/* -------------------------------------------------------------------- lexer */
typedef enum {
  T_NUM, T_STR, T_IDENT,
  T_MAKE, T_SET, T_SHOW, T_WHEN, T_ORWHEN, T_OTHERWISE, T_REPEAT, T_WHILE, T_TIMES,
  T_MATCH, T_IS,
  T_TASK, T_TYPE, T_GIVE, T_FOR, T_EACH, T_IN, T_TO, T_USE, T_PUBLIC, T_PRIVATE, T_LEARN, T_TEST, T_EXPECT,
  T_TRY, T_CAUGHT, T_FAIL, T_STOP, T_SKIP,
  T_AND, T_OR, T_NOT, T_YES, T_NO, T_NOTHING,
  T_PLUS, T_MINUS, T_STAR, T_SLASH, T_PERCENT, T_DOT,
  T_PLUSEQ, T_MINUSEQ, T_STAREQ, T_SLASHEQ, T_PERCENTEQ,
  T_EQ, T_EQEQ, T_BANGEQ, T_LT, T_LE, T_GT, T_GE, T_PIPE,
  T_LPAREN, T_RPAREN, T_LBRACK, T_RBRACK, T_LBRACE, T_RBRACE, T_COMMA, T_COLON,
  T_NEWLINE, T_INDENT, T_DEDENT, T_EOF
} TokType;

typedef struct { TokType type; char *text; double num; int line; } Token;

static Token *toks = NULL; static int ntok = 0, captok = 0;
/* depth of open ( ) [ ] { }. While > 0, the tokenizer suppresses NEWLINE/INDENT/DEDENT so a
   list, map, or call can span several lines (Python-style implicit line joining). */
static int g_bracket_depth = 0;
static char *gc_stack_bottom = NULL;        /* captured in main(): the outermost end of the stack */
static size_t g_stack_budget = 6u * 1024 * 1024;   /* refined in main() to ~75% of the REAL stack (so the guard works on an 8 MB default stack, not just the 64 MB Windows build) */
/* true once recursion has eaten most of the stack — lets the parser and evaluator fail cleanly
   ("nested too deeply") instead of overflowing the C stack and segfaulting. */
static int stack_too_deep(void) {
  char probe;
  if (!gc_stack_bottom) return 0;
  long long used = (long long)((char *)gc_stack_bottom - &probe);
  return used > (long long)g_stack_budget;
}
static void push_tok(TokType type, char *text, double num, int line) {
  if (ntok >= captok) { captok = captok ? captok * 2 : 128; toks = (Token *)realloc(toks, captok * sizeof(Token)); }
  Token t; t.type = type; t.text = text; t.num = num; t.line = line; toks[ntok++] = t;
}

static TokType keyword(const char *w) {
  static const struct { const char *word; TokType type; } table[] = {
    { "make", T_MAKE }, { "set", T_SET }, { "show", T_SHOW }, { "when", T_WHEN },
    { "orwhen", T_ORWHEN }, { "otherwise", T_OTHERWISE }, { "repeat", T_REPEAT },
    { "while", T_WHILE }, { "times", T_TIMES }, { "task", T_TASK }, { "type", T_TYPE }, { "give", T_GIVE },
    { "match", T_MATCH }, { "is", T_IS },
    { "for", T_FOR }, { "each", T_EACH }, { "in", T_IN }, { "to", T_TO }, { "use", T_USE },
    { "public", T_PUBLIC }, { "private", T_PRIVATE }, { "learn", T_LEARN },
    { "test", T_TEST }, { "expect", T_EXPECT },
    { "try", T_TRY }, { "caught", T_CAUGHT }, { "fail", T_FAIL }, { "stop", T_STOP }, { "skip", T_SKIP },
    { "and", T_AND }, { "or", T_OR },   /* 'else' is NOT a keyword - it's only special right after 'or' (see expression()) */
    { "not", T_NOT }, { "yes", T_YES }, { "no", T_NO }, { "nothing", T_NOTHING },
  };
  for (size_t k = 0; k < sizeof table / sizeof table[0]; k++)
    if (!strcmp(w, table[k].word)) return table[k].type;
  return T_IDENT;
}

static void scan_fstring(const char *src, int *ip, int len, int line);

/* scan exactly one token at *ip (the caller has already skipped spaces/comments) */
static void scan_token(const char *src, int *ip, int len, int line) {
  int i = *ip;
  char c = src[i];
  if (c == 'f' && i + 1 < len && src[i + 1] == '"') { scan_fstring(src, ip, len, line); return; }
  if (isdigit((unsigned char)c) || (c == '.' && i + 1 < len && isdigit((unsigned char)src[i + 1]))) {
    int s = i, dot = 0;                              /* at most one '.' in the mantissa (1.2.3 isn't one number) */
    while (i < len && (isdigit((unsigned char)src[i]) || (src[i] == '.' && !dot) ||
           (src[i] == '_' && i > s && isdigit((unsigned char)src[i-1]) && i+1 < len && isdigit((unsigned char)src[i+1])))) {   /* 1_000_000 readability separators */
      if (src[i] == '.') dot = 1;
      i++;
    }
    /* scientific notation: an 'e'/'E' that is actually followed by an exponent (1e3, 2.5e-4).
       Only consume the 'e' when a digit follows (optionally after a +/-), so a name like
       `e` after a number isn't swallowed. */
    if (i < len && (src[i] == 'e' || src[i] == 'E')) {
      int j = i + 1;
      if (j < len && (src[j] == '+' || src[j] == '-')) j++;
      if (j < len && isdigit((unsigned char)src[j])) { i = j + 1; while (i < len && isdigit((unsigned char)src[i])) i++; }
    }
    char *t = (char *)malloc(i - s + 1); int tb = 0;
    for (int k = s; k < i; k++) if (src[k] != '_') t[tb++] = src[k];   /* drop the separators before parsing */
    t[tb] = 0;
    double nv = atof(t);
    if (!isfinite(nv)) fail(line, "that number is too large to represent.");
    push_tok(T_NUM, t, nv, line); *ip = i; return;
  }
  if (c == '"') {
    i++; char *buf = (char *)malloc(len - i + 1); int b = 0;
    while (i < len && src[i] != '"' && src[i] != '\n') {       /* text stays on one line */
      if (src[i] == '\\' && i + 1 < len) {
        char nx = src[i + 1];
        if (nx == 'n') buf[b++] = '\n'; else if (nx == 't') buf[b++] = '\t';
        else if (nx == '"') buf[b++] = '"'; else if (nx == '\\') buf[b++] = '\\'; else buf[b++] = nx;
        i += 2;
      } else buf[b++] = src[i++];
    }
    if (i >= len || src[i] != '"') fail(line, "this text is missing its closing quote (text can't span lines - join with \\n).");
    i++; buf[b] = 0; push_tok(T_STR, buf, 0, line); *ip = i; return;
  }
  if (isalpha((unsigned char)c) || c == '_') {
    int s = i; while (i < len && (isalnum((unsigned char)src[i]) || src[i] == '_')) i++;
    char *w = (char *)malloc(i - s + 1); memcpy(w, src + s, i - s); w[i - s] = 0;
    push_tok(keyword(w), w, 0, line); *ip = i; return;
  }
  switch (c) {
    case '+': if (i + 1 < len && src[i + 1] == '=') { push_tok(T_PLUSEQ,    NULL, 0, line); i += 2; } else { push_tok(T_PLUS,    NULL, 0, line); i++; } break;
    case '-': if (i + 1 < len && src[i + 1] == '=') { push_tok(T_MINUSEQ,   NULL, 0, line); i += 2; } else { push_tok(T_MINUS,   NULL, 0, line); i++; } break;
    case '*': if (i + 1 < len && src[i + 1] == '=') { push_tok(T_STAREQ,    NULL, 0, line); i += 2; } else { push_tok(T_STAR,    NULL, 0, line); i++; } break;
    case '/': if (i + 1 < len && src[i + 1] == '=') { push_tok(T_SLASHEQ,   NULL, 0, line); i += 2; } else { push_tok(T_SLASH,   NULL, 0, line); i++; } break;
    case '%': if (i + 1 < len && src[i + 1] == '=') { push_tok(T_PERCENTEQ, NULL, 0, line); i += 2; } else { push_tok(T_PERCENT, NULL, 0, line); i++; } break;
    case '(': push_tok(T_LPAREN, NULL, 0, line); g_bracket_depth++; i++; break;
    case ')': push_tok(T_RPAREN, NULL, 0, line); if (g_bracket_depth > 0) g_bracket_depth--; i++; break;
    case '[': push_tok(T_LBRACK, NULL, 0, line); g_bracket_depth++; i++; break;
    case ']': push_tok(T_RBRACK, NULL, 0, line); if (g_bracket_depth > 0) g_bracket_depth--; i++; break;
    case '{': push_tok(T_LBRACE, NULL, 0, line); g_bracket_depth++; i++; break;
    case '}': push_tok(T_RBRACE, NULL, 0, line); if (g_bracket_depth > 0) g_bracket_depth--; i++; break;
    case ',': push_tok(T_COMMA, NULL, 0, line); i++; break;
    case '.': push_tok(T_DOT, NULL, 0, line); i++; break;
    case ':': push_tok(T_COLON, NULL, 0, line); i++; break;
    case '=': if (i + 1 < len && src[i + 1] == '=') { push_tok(T_EQEQ, NULL, 0, line); i += 2; } else { push_tok(T_EQ, NULL, 0, line); i++; } break;
    case '!': if (i + 1 < len && src[i + 1] == '=') { push_tok(T_BANGEQ, NULL, 0, line); i += 2; } else fail(line, "I didn't expect a '!' here (use 'not', or '!=' for not-equal)."); break;
    case '<': if (i + 1 < len && src[i + 1] == '=') { push_tok(T_LE, NULL, 0, line); i += 2; } else { push_tok(T_LT, NULL, 0, line); i++; } break;
    case '>': if (i + 1 < len && src[i + 1] == '=') { push_tok(T_GE, NULL, 0, line); i += 2; } else { push_tok(T_GT, NULL, 0, line); i++; } break;
    case '|': if (i + 1 < len && src[i + 1] == '>') { push_tok(T_PIPE, NULL, 0, line); i += 2; } else fail(line, "I didn't expect a '|' here (use 'or' for logical or, or '|>' for the pipe)."); break;
    case '#': fail(line, "Sprout comments start with ~, not #.");
    default: { char m[64]; snprintf(m, sizeof m, "I don't understand the character '%c'.", c); fail(line, m); }
  }
  *ip = i;
}

/* f"Hello, {name}!" desugars to  ( "Hello, " + (name) + "!" )  so it needs no new AST/eval. */
static void scan_fstring(const char *src, int *ip, int len, int line) {
  int i = *ip + 2;                       /* skip the  f"  */
  push_tok(T_LPAREN, NULL, 0, line);
  char *lit = (char *)malloc(len - i + 2); int b = 0, emitted = 0;
  while (i < len && src[i] != '"' && src[i] != '\n') {        /* f-strings stay on one line */
    char c = src[i];
    if (c == '\\' && i + 1 < len) {
      char nx = src[i + 1];
      if (nx == 'n') lit[b++] = '\n'; else if (nx == 't') lit[b++] = '\t';
      else if (nx == '"') lit[b++] = '"'; else if (nx == '\\') lit[b++] = '\\';
      else if (nx == '{') lit[b++] = '{'; else if (nx == '}') lit[b++] = '}';
      else lit[b++] = nx;
      i += 2; continue;
    }
    if (c == '{') {
      /* flush the literal collected so far as a string token */
      if (emitted) push_tok(T_PLUS, NULL, 0, line);
      char *s = (char *)malloc(b + 1); memcpy(s, lit, b); s[b] = 0; push_tok(T_STR, s, 0, line);
      emitted = 1; b = 0;
      i++;                               /* skip {  */
      while (i < len && (src[i] == ' ' || src[i] == '\t')) i++;
      if (i < len && src[i] == '}') fail(line, "this f-string has an empty {} - put a value inside, like {name}.");
      push_tok(T_PLUS, NULL, 0, line); push_tok(T_LPAREN, NULL, 0, line);
      int depth = 1;                     /* lex the inner expression up to the matching } */
      while (i < len && src[i] != '\n') {
        while (i < len && (src[i] == ' ' || src[i] == '\t')) i++;
        if (i >= len || src[i] == '\n') break;
        char ic = src[i];
        if (ic == '}') { if (--depth == 0) { i++; break; } }
        else if (ic == '{') depth++;
        else if (ic == '"') {
          /* a string literal inside {...} must close on the same line; if not, this " is really
             the f-string's own terminator and the { was left unclosed */
          int j = i + 1; while (j < len && src[j] != '"' && src[j] != '\n') { if (src[j] == '\\') j++; j++; }
          if (j >= len || src[j] == '\n') break;          /* no same-line close -> stop (depth>0 -> error below) */
        }
        scan_token(src, &i, len, line);
      }
      if (depth > 0) fail(line, "this f-string has a '{' that was never closed with '}'.");
      push_tok(T_RPAREN, NULL, 0, line);
      continue;
    }
    lit[b++] = c; i++;
  }
  if (i >= len || src[i] != '"') fail(line, "this f-string is missing its closing quote.");
  i++;                                   /* skip closing "  */
  if (emitted) push_tok(T_PLUS, NULL, 0, line);
  char *s = (char *)malloc(b + 1); memcpy(s, lit, b); s[b] = 0; push_tok(T_STR, s, 0, line);
  free(lit);
  push_tok(T_RPAREN, NULL, 0, line);
  *ip = i;
}

/* Tokenize the whole source, handling Python-style indentation. */
static void tokenize(const char *src, int len) {
  int indents[256]; int top = 0; indents[0] = 0;
  int i = 0, line = 0;
  g_bracket_depth = 0;
  while (i < len) {
    line++;
    int lineStart = i;
    int spaces = 0;
    while (i < len && (src[i] == ' ' || src[i] == '\t')) { spaces++; i++; }
    /* blank line or comment-only line: skip without affecting indentation */
    if (i >= len || src[i] == '\n' || src[i] == '\r' || src[i] == '~') {
      while (i < len && src[i] != '\n') i++;
      if (i < len) i++;
      continue;
    }
    /* indentation changes — but NOT while inside ( ) [ ] { }, where leading space is just padding */
    if (g_bracket_depth == 0) {
      if (spaces > indents[top]) { if (top >= 254) fail(line, "this is nested too deeply (too many indentation levels)."); indents[++top] = spaces; push_tok(T_INDENT, NULL, 0, line); }
      while (spaces < indents[top]) { top--; push_tok(T_DEDENT, NULL, 0, line); }
      if (spaces != indents[top]) fail(line, "the indentation doesn't line up with the block.");
    }
    /* tokens on this line */
    while (i < len && src[i] != '\n' && src[i] != '\r') {
      char c = src[i];
      if (c == ' ' || c == '\t') { i++; continue; }
      if (c == '~') { while (i < len && src[i] != '\n') i++; break; }
      scan_token(src, &i, len, line);
    }
    /* an unfinished line inside brackets joins the next one — no statement break here */
    if (g_bracket_depth == 0) push_tok(T_NEWLINE, NULL, 0, line);
    while (i < len && src[i] != '\n') i++;
    if (i < len) i++;
    (void)lineStart;
  }
  while (top > 0) { top--; push_tok(T_DEDENT, NULL, 0, line); }
  push_tok(T_EOF, NULL, 0, line);
}

/* ---------------------------------------------------------------------- AST */
typedef enum { E_NUM, E_STR, E_BOOL, E_NONE, E_VAR, E_UNARY, E_BINARY, E_LOGICAL, E_COALESCE, E_CALL, E_LIST, E_MAP, E_INDEX, E_SLICE, E_MEMBER, E_LAMBDA, E_RANGE, E_COMPREHENSION, E_METHODCALL } EKind;
typedef struct Expr {
  EKind kind; double num; char *str; int boolean; char *name; char *module;  /* module: server.name */
  TokType op; struct Expr *left, *right, *operand; int line;
  struct Expr **args; int nargs;         /* call inputs / list items / map values */
  char **keys;                            /* E_MAP keys (parallel to args) */
  struct Expr *target, *index;            /* E_INDEX: target[index] */
  TaskDef *lambda;                        /* E_LAMBDA: the anonymous task's static template (home set at eval) */
} Expr;

typedef enum { S_MAKE, S_SET, S_SHOW, S_WHEN, S_MATCH, S_REPEAT_TIMES, S_REPEAT_WHILE, S_TASK, S_GIVE, S_EXPR, S_FOREACH, S_INDEXSET, S_USE, S_LEARN, S_TEST, S_EXPECT, S_EXPECT_ERROR, S_TRY, S_FAIL, S_STOP, S_SKIP, S_TYPE } SKind;
typedef struct Stmt Stmt;
typedef struct { Expr *cond; Stmt **body; int nbody; } Branch;
/* one arm of a `match`. patkind: 0 = literal (compare `lit` by value), 1 = list-destructure
   (bind `names` to a list of exactly nnames items), 2 = map-destructure (the value must be a
   map containing every key in `names`; each binds a same-named variable), 3 = otherwise. */
typedef struct { int patkind; Expr *lit; char **names; int nnames; Stmt **body; int nbody; } MatchArm;
struct Stmt {
  SKind kind; char *name; char *name2; Expr *expr;   /* name2: the optional 2nd `for each k, v` binding */
  Expr **values; int nvalues;            /* show */
  Branch *branches; int nbranches; Stmt **otherwise; int notherwise; /* when */
  MatchArm *arms; int narms;             /* match */
  Expr *count; Stmt **body; int nbody;   /* repeat / task / for-each body */
  char **params; int nparams; Expr **pdefaults;   /* task: params + optional per-param default exprs (NULL = required) */
  Expr *target, *index;                   /* S_INDEXSET: target[index] = expr */
  TokType setop;                          /* S_SET/S_INDEXSET: 0 = plain '=', else +=,-=,*=,/=,%= */
  int is_public;                          /* make/task: shared across the whole project? */
  int line;
};

static Expr *new_expr(EKind k, int line) { Expr *e = (Expr *)calloc(1, sizeof(Expr)); e->kind = k; e->line = line; return e; }
static Stmt *new_stmt(SKind k, int line) { Stmt *s = (Stmt *)calloc(1, sizeof(Stmt)); s->kind = k; s->line = line; return s; }

/* ------------------------------------------------------------------- parser */
static int pos = 0;
static Token peek(void) { return toks[pos]; }
static Token advance(void) { return toks[pos++]; }
static int check(TokType t) { return toks[pos].type == t; }
static int match(TokType t) { if (check(t)) { pos++; return 1; } return 0; }
static Token expect(TokType t, const char *msg) { if (!check(t)) fail(toks[pos].line, msg); return advance(); }

static Expr *expression(void);
static Expr *parse_anon_task(int line);   /* anonymous task literal (lambda): task(params): body */

static Expr *primary(void) {
  Token t = peek();
  if (match(T_NUM))     { Expr *e = new_expr(E_NUM, t.line); e->num = t.num; return e; }
  if (match(T_STR))     { Expr *e = new_expr(E_STR, t.line); e->str = t.text; return e; }
  if (match(T_YES))     { Expr *e = new_expr(E_BOOL, t.line); e->boolean = 1; return e; }
  if (match(T_NO))      { Expr *e = new_expr(E_BOOL, t.line); e->boolean = 0; return e; }
  if (match(T_NOTHING)) { return new_expr(E_NONE, t.line); }
  if (match(T_TASK))    { return parse_anon_task(t.line); }   /* a lambda: task(x): x * 2 */
  if (match(T_LBRACK)) {              /* a list [a, b, c] OR a comprehension [expr for each x in xs] */
    if (check(T_RBRACK)) { advance(); Expr *e = new_expr(E_LIST, t.line); return e; }   /* the empty list */
    Expr *first = expression();
    if (check(T_FOR)) {               /* a comprehension: [expr for each x in xs (when cond)] */
      advance();                                                /* 'for' */
      expect(T_EACH, "I expected 'each' after 'for', like [n * 2 for each n in xs].");
      Token var = expect(T_IDENT, "I expected a name after 'for each' here.");
      expect(T_IN, "I expected 'in' here, like [n * 2 for each n in xs].");
      Expr *iter = expression();
      Expr *filt = NULL;
      if (match(T_WHEN)) filt = expression();                   /* an optional filter */
      expect(T_RBRACK, "I expected a ']' to close the comprehension.");
      Expr *e = new_expr(E_COMPREHENSION, t.line);
      e->left = first; e->right = iter; e->operand = filt; e->name = var.text; return e;
    }
    Expr *e = new_expr(E_LIST, t.line);                          /* an ordinary list */
    Expr **items = NULL; int n = 0, cap = 0;
    items = (Expr **)realloc(items, (cap = 4) * sizeof(Expr *)); items[n++] = first;
    while (match(T_COMMA)) {
      if (check(T_RBRACK)) break;                /* a trailing comma is fine */
      if (n >= cap) { cap *= 2; items = (Expr **)realloc(items, cap * sizeof(Expr *)); }
      items[n++] = expression();
    }
    expect(T_RBRACK, "I expected a ']' to close the list.");
    e->args = items; e->nargs = n; return e;
  }
  if (match(T_LBRACE)) {              /* a map: {key: value, ...} */
    Expr *e = new_expr(E_MAP, t.line);
    Expr **vals = NULL; char **keys = NULL; int n = 0, cap = 0;
    if (!check(T_RBRACE)) {
      do {
        if (check(T_RBRACE)) break;             /* a trailing comma is fine */
        Token k = peek();
        int wordlike = (k.type == T_IDENT || k.type == T_STR || (k.type >= T_MAKE && k.type <= T_NOTHING));
        if (!wordlike) fail(k.line, "I expected a key name in this map.");
        advance();
        expect(T_COLON, "I expected a ':' between a map key and its value.");
        Expr *val = expression();
        if (n >= cap) { cap = cap ? cap * 2 : 4; keys = (char **)realloc(keys, cap * sizeof(char *)); vals = (Expr **)realloc(vals, cap * sizeof(Expr *)); }
        keys[n] = k.text; vals[n] = val; n++;
      } while (match(T_COMMA));
    }
    expect(T_RBRACE, "I expected a '}' to close the map.");
    e->keys = keys; e->args = vals; e->nargs = n; return e;
  }
  if (match(T_IDENT)) {
    char *module = NULL; char *who = t.text; int line = t.line;
    if (check(T_DOT)) {              /* a module member: server.start(...) or server.config */
      advance();
      Token m = expect(T_IDENT, "I expected a name after '.' (like server.start).");
      module = who; who = m.text;
      /* a deeper chain (a.b.c) or method on a field is handled by postfix() below */
    }
    if (check(T_LPAREN)) {           /* a call: name(args) or module.name(args) */
      advance();
      Expr *e = new_expr(E_CALL, line); e->name = who; e->module = module;
      Expr **args = NULL; int n = 0, cap = 0;
      if (!check(T_RPAREN)) {
        do {
          if (check(T_RPAREN)) break;           /* a trailing comma is fine */
          if (n >= cap) { cap = cap ? cap * 2 : 4; args = (Expr **)realloc(args, cap * sizeof(Expr *)); }
          args[n++] = expression();
        } while (match(T_COMMA));
      }
      expect(T_RPAREN, "I expected a ')' to close the inputs.");
      e->args = args; e->nargs = n; return e;
    }
    if (module) { Expr *e = new_expr(E_MEMBER, line); e->module = module; e->name = who; return e; }
    Expr *e = new_expr(E_VAR, line); e->name = who; return e;
  }
  if (match(T_LPAREN))  { Expr *e = expression(); expect(T_RPAREN, "I expected a ')' to close this group."); return e; }
  fail(t.line, "I expected a value here (a number, some text, or a name).");
  return NULL;
}
static Expr *postfix(void) {        /* primary followed by any number of [index], .field, or .method(args) */
  Expr *e = primary();
  while (check(T_LBRACK) || check(T_DOT)) {
    int line = peek().line;
    if (check(T_LBRACK)) {
      advance();
      Expr *start = NULL, *end = NULL; int is_slice = 0;
      if (!check(T_COLON)) start = expression();                                  /* xs[i] or xs[start:...] */
      if (match(T_COLON)) { is_slice = 1; if (!check(T_RBRACK)) end = expression(); }   /* xs[a:b], xs[a:], xs[:b], xs[:] */
      expect(T_RBRACK, "I expected a ']' to close the index.");
      if (is_slice) { Expr *sl = new_expr(E_SLICE, line); sl->target = e; sl->index = start; sl->operand = end; e = sl; }
      else          { Expr *ix = new_expr(E_INDEX, line); ix->target = e; ix->index = start; e = ix; }
    } else {                          /* '.' on a value: a field (e.field) or a method call (e.method(...)) */
      advance();
      Token nm = expect(T_IDENT, "I expected a name after '.' (a field or method).");
      if (check(T_LPAREN)) {          /* e.method(args)  ->  E_METHODCALL */
        advance();
        Expr **args = NULL; int n = 0, cap = 0;
        if (!check(T_RPAREN)) do {
          if (check(T_RPAREN)) break;
          if (n >= cap) { cap = cap ? cap * 2 : 4; args = (Expr **)realloc(args, cap * sizeof(Expr *)); }
          args[n++] = expression();
        } while (match(T_COMMA));
        expect(T_RPAREN, "I expected a ')' to close the inputs.");
        Expr *mc = new_expr(E_METHODCALL, line); mc->target = e; mc->name = nm.text; mc->args = args; mc->nargs = n; e = mc;
      } else {                        /* e.field  ->  index by the field name (reuses map get/set) */
        Expr *ix = new_expr(E_INDEX, line); ix->target = e;
        Expr *key = new_expr(E_STR, line); key->str = nm.text; ix->index = key; e = ix;
      }
    }
  }
  return e;
}
static Expr *unary(void) {
  Token t = peek();
  if (check(T_MINUS) || check(T_NOT)) { advance(); Expr *e = new_expr(E_UNARY, t.line); e->op = t.type; e->operand = unary(); return e; }
  return postfix();
}
static Expr *binary_level(Expr *(*next)(void), const TokType *ops, int nops, int logical) {
  Expr *left = next();
  for (;;) {
    int found = 0; TokType op = T_EOF;
    for (int k = 0; k < nops; k++) if (check(ops[k])) { op = ops[k]; found = 1; break; }
    if (!found) break;
    int line = peek().line; advance();
    Expr *right = next();
    Expr *e = new_expr(logical ? E_LOGICAL : E_BINARY, line);
    e->op = op; e->left = left; e->right = right; left = e;
  }
  return left;
}
static Expr *factor(void)     { static const TokType o[] = { T_STAR, T_SLASH, T_PERCENT }; return binary_level(unary, o, 3, 0); }
static Expr *term(void)       { static const TokType o[] = { T_PLUS, T_MINUS }; return binary_level(factor, o, 2, 0); }
/* a range:  a to b  (inclusive both ends). Binds looser than +,-,*,/ (so `1 to n + 1`
   is `1 to (n+1)`) but tighter than comparisons. A single `to` only — it does not chain. */
static Expr *range_expr(void) {
  Expr *left = term();
  if (check(T_TO)) {
    int line = peek().line; advance();
    Expr *right = term();
    Expr *e = new_expr(E_RANGE, line); e->left = left; e->right = right; return e;
  }
  return left;
}
/* the pipe:  x |> f  is  f(x), and  x |> f(a)  is  f(x, a)  (left threaded in as the FIRST
   argument). Left-associative, so  x |> f |> g  is  g(f(x)). Desugars to a normal call at
   parse time, so it reuses all the existing call machinery (tasks, lambdas-in-variables,
   module calls, arity checks). Binds looser than arithmetic, tighter than comparisons. */
static Expr *pipe_expr(void) {
  Expr *left = range_expr();
  while (check(T_PIPE)) {
    int line = peek().line; advance();
    Expr *right = range_expr();
    if (right->kind == E_CALL) {                 /* x |> f(a)  ->  f(x, a)   (also module.f(a)) */
      Expr **args = (Expr **)malloc((right->nargs + 1) * sizeof(Expr *));
      args[0] = left;
      for (int k = 0; k < right->nargs; k++) args[k + 1] = right->args[k];
      right->args = args; right->nargs += 1; left = right;
    } else if (right->kind == E_VAR) {           /* x |> f  ->  f(x) */
      Expr *call = new_expr(E_CALL, line); call->name = right->name;
      call->args = (Expr **)malloc(sizeof(Expr *)); call->args[0] = left; call->nargs = 1; left = call;
    } else if (right->kind == E_MEMBER) {         /* x |> mod.f  ->  mod.f(x) */
      Expr *call = new_expr(E_CALL, line); call->module = right->module; call->name = right->name;
      call->args = (Expr **)malloc(sizeof(Expr *)); call->args[0] = left; call->nargs = 1; left = call;
    } else {
      fail(line, "the right side of '|>' must be a task or a call, like  x |> double  or  x |> add(2).");
    }
  }
  return left;
}
/* comparisons do NOT chain: `a < b < c` is a friendly error (use 'and'), not a confusing
   (a < b) < c type error. All six relational/equality ops share this one non-associative level. */
static Expr *compare(void) {
  static const TokType o[] = { T_LT, T_LE, T_GT, T_GE, T_EQEQ, T_BANGEQ, T_IN };  /* `x in xs` = membership */
  Expr *left = pipe_expr();
  TokType op = T_EOF; int found = 0;
  for (int k = 0; k < 7; k++) if (check(o[k])) { op = o[k]; found = 1; break; }
  if (!found) return left;
  int line = peek().line; advance();
  Expr *right = pipe_expr();
  for (int k = 0; k < 7; k++) if (check(o[k])) fail(peek().line, "comparisons can't be chained - use 'and', like  a < b and b < c.");
  Expr *e = new_expr(E_BINARY, line); e->op = op; e->left = left; e->right = right; return e;
}
static Expr *and_expr(void)   { static const TokType o[] = { T_AND }; return binary_level(compare, o, 1, 1); }
/* the `or` level, hand-written so `or else` (nothing-coalescing) is distinct from logical `or` */
static Expr *expression(void) {
  if (stack_too_deep()) fail(peek().line, "this is nested too deeply.");
  Expr *left = and_expr();
  while (check(T_OR)) {
    int line = peek().line; advance();
    Expr *right;
    if (check(T_IDENT) && !strcmp(peek().text, "else")) {   /* `or else` — 'else' is contextual, not a reserved word */
      advance(); right = and_expr(); Expr *e = new_expr(E_COALESCE, line); e->left = left; e->right = right; left = e;
    } else { right = and_expr(); Expr *e = new_expr(E_LOGICAL, line); e->op = T_OR; e->left = left; e->right = right; left = e; }
  }
  return left;
}

static Stmt *statement(void);

/* a `:` then a NEWLINE then an indented run of statements */
static int g_block_depth = 0;   /* >0 while parsing inside an indented block (tasks must be top-level) */
static int g_in_task = 0;       /* >0 while parsing a task body ('give' only works inside a task) */
static int g_in_test = 0;       /* >0 while parsing a test body ('expect' only works inside a test) */
static int g_in_loop = 0;       /* >0 while parsing a loop body ('stop'/'skip' only work in loops) */
static int g_repl_active = 0;   /* in the live REPL, `make` may re-bind a name (re-running a line) */
static Stmt **block(int *count) {
  expect(T_COLON, "I expected a ':' to start the block.");
  expect(T_NEWLINE, "the block should begin on the next line.");
  expect(T_INDENT, "I expected the next lines to be indented (that's the block).");
  Stmt **list = NULL; int n = 0, cap = 0;
  g_block_depth++;
  while (!check(T_DEDENT) && !check(T_EOF)) {
    if (match(T_NEWLINE)) continue;
    if (n >= cap) { cap = cap ? cap * 2 : 8; list = (Stmt **)realloc(list, cap * sizeof(Stmt *)); }
    list[n++] = statement();
  }
  g_block_depth--;
  expect(T_DEDENT, "I expected this block to finish here.");
  *count = n; return list;
}

static int edit_distance(const char *a, const char *b);   /* forward decl — defined in the runtime section */
/* the closest statement-starting keyword to a misspelled word, or NULL if nothing is close */
static const char *suggest_keyword(const char *w) {
  static const char *kw[] = { "make","set","show","when","orwhen","otherwise","repeat","task","type",
                              "give","match","for","use","try","fail","test","expect","learn","public","private","stop","skip" };
  const char *best = NULL; int bestd = 3;
  for (size_t i = 0; i < sizeof kw / sizeof kw[0]; i++) { int d = edit_distance(w, kw[i]); if (d < bestd) { bestd = d; best = kw[i]; } }
  return best;
}
static Stmt *statement(void) {
  Token t = peek();
  int is_public = 0;
  if (t.type == T_PUBLIC || t.type == T_PRIVATE) {       /* a visibility marker before make/task */
    is_public = (t.type == T_PUBLIC);
    advance(); t = peek();
    if (t.type != T_MAKE && t.type != T_TASK)
      fail(t.line, "'public' and 'private' can only go before 'make' or 'task'.");
  }
  switch (t.type) {
    case T_MAKE: {
      advance(); Token name = expect(T_IDENT, "I expected a name here.");
      if (check(T_COMMA)) {    /* make a, b = pair  — unpack a list into several names */
        char **names = (char **)malloc(4 * sizeof(char *)); int n = 0, cap = 4; names[n++] = name.text;
        while (match(T_COMMA)) {
          Token nm = expect(T_IDENT, "I expected another name here, like  make a, b = pair.");
          if (n >= cap) { cap *= 2; names = (char **)realloc(names, cap * sizeof(char *)); }
          names[n++] = nm.text;
        }
        expect(T_EQ, "I expected '=' after the names (make a, b = pair).");
        Stmt *s = new_stmt(S_MAKE, t.line); s->params = names; s->nparams = n; s->expr = expression(); s->is_public = is_public; return s;
      }
      if (check(T_LBRACK)) {   /* make m["k"] = ... : a beginner reaching for set */
        char m[256]; snprintf(m, sizeof m, "to put a value into '%s', use 'set' (like  set %s[\"key\"] = value) - 'make' is only for brand-new names.", name.text, name.text);
        fail(t.line, m);
      }
      expect(T_EQ, "I expected '=' here.");
      Stmt *s = new_stmt(S_MAKE, t.line); s->name = name.text; s->expr = expression(); s->is_public = is_public; return s;
    }
    case T_SET: {
      advance();
      Expr *lhs = postfix();             /* a name, name[i], or grid[i][j] */
      TokType op = 0;                    /* 0 = plain '='; otherwise the arithmetic op of a +=, -=, ... */
      Token a = peek();
      switch (a.type) {
        case T_EQ:        advance(); break;
        case T_PLUSEQ:    advance(); op = T_PLUS;    break;
        case T_MINUSEQ:   advance(); op = T_MINUS;   break;
        case T_STAREQ:    advance(); op = T_STAR;    break;
        case T_SLASHEQ:   advance(); op = T_SLASH;   break;
        case T_PERCENTEQ: advance(); op = T_PERCENT; break;
        default: fail(a.line, "I expected '=' here (or +=, -=, *=, /=, %=).");
      }
      Expr *val = expression();
      if (lhs->kind == E_VAR)   { Stmt *s = new_stmt(S_SET, t.line);      s->name = lhs->name;       s->expr = val; s->setop = op; return s; }
      if (lhs->kind == E_INDEX) { Stmt *s = new_stmt(S_INDEXSET, t.line); s->target = lhs->target; s->index = lhs->index; s->expr = val; s->setop = op; return s; }
      if (lhs->kind == E_MEMBER){ Stmt *s = new_stmt(S_INDEXSET, t.line); /* set obj.field = v  ->  obj["field"] = v */
        Expr *tv = new_expr(E_VAR, t.line); tv->name = lhs->module;
        Expr *key = new_expr(E_STR, t.line); key->str = lhs->name;
        s->target = tv; s->index = key; s->expr = val; s->setop = op; return s; }
      fail(t.line, "you can only 'set' a name, an item inside a list or map, or an object's field.");
      return NULL;
    }
    case T_TYPE: {                       /* type Point:  <make fields...>  <task methods...> */
      advance();
      Token name = expect(T_IDENT, "I expected a name for the type, like: type Point:");
      char *parent = NULL;                 /* optional single inheritance: type Dog from Animal: */
      if (check(T_IDENT) && !strcmp(peek().text, "from")) { advance(); Token pp = expect(T_IDENT, "I expected a parent type name after 'from' (like: type Dog from Animal:)."); parent = pp.text; }
      expect(T_COLON, "I expected ':' after the type name.");
      expect(T_NEWLINE, "I expected the type's body on the next lines.");
      expect(T_INDENT, "I expected the type's fields and tasks to be indented.");
      char **fields = NULL; Expr **defs = NULL; int nf = 0, fcap = 0;
      Stmt **methods = NULL; int nm = 0, mcap = 0;
      while (!check(T_DEDENT) && !check(T_EOF)) {
        if (match(T_NEWLINE)) continue;
        if (check(T_MAKE)) {             /* a field, with an optional default:  make x   |   make x = 0 */
          advance();
          Token fn = expect(T_IDENT, "I expected a field name after 'make'.");
          Expr *def = NULL;
          if (match(T_EQ)) def = expression();
          if (nf >= fcap) { fcap = fcap ? fcap * 2 : 4; fields = (char **)realloc(fields, fcap * sizeof(char *)); defs = (Expr **)realloc(defs, fcap * sizeof(Expr *)); }
          fields[nf] = fn.text; defs[nf] = def; nf++;
        } else if (check(T_TASK)) {      /* a method: task name(self, ...):  <body> */
          Stmt *m = statement();
          if (nm >= mcap) { mcap = mcap ? mcap * 2 : 4; methods = (Stmt **)realloc(methods, mcap * sizeof(Stmt *)); }
          methods[nm++] = m;
        } else {
          fail(peek().line, "inside a type, write 'make <field>' for a field or 'task <name>(self, ...):' for a method.");
        }
      }
      expect(T_DEDENT, "I expected the type's body to finish here.");
      Stmt *s = new_stmt(S_TYPE, name.line);
      s->name = name.text; s->name2 = parent; s->params = fields; s->nparams = nf; s->values = defs; s->nvalues = nf; s->body = methods; s->nbody = nm;
      return s;
    }
    case T_FOR: {
      advance();
      expect(T_EACH, "I expected 'each' here (like: for each item in things:).");
      Token name = expect(T_IDENT, "I expected a name for each item.");
      Stmt *s = new_stmt(S_FOREACH, t.line); s->name = name.text;
      if (match(T_COMMA)) {                          /* for each key, value in map  (or index, item in a list) */
        Token name2 = expect(T_IDENT, "I expected a second name after the comma (like: for each key, value in m:).");
        s->name2 = name2.text;
      }
      expect(T_IN, "I expected 'in' here (like: for each item in things:).");
      s->expr = expression();
      int save_loop = g_in_loop; g_in_loop = 1;   /* 'stop'/'skip' allowed in this body */
      s->body = block(&s->nbody);
      g_in_loop = save_loop; return s;
    }
    case T_SHOW: {
      advance(); Stmt *s = new_stmt(S_SHOW, t.line);
      Expr **vals = NULL; int n = 0, cap = 0;
      do {
        /* a trailing comma is fine (show ends at the line, so check the line terminators) */
        if (n > 0 && (check(T_NEWLINE) || check(T_DEDENT) || check(T_EOF))) break;
        if (n >= cap) { cap = cap ? cap * 2 : 4; vals = (Expr **)realloc(vals, cap * sizeof(Expr *)); }
        vals[n++] = expression();
      } while (match(T_COMMA));
      s->values = vals; s->nvalues = n; return s;
    }
    case T_WHEN: {
      advance(); Stmt *s = new_stmt(S_WHEN, t.line);
      Branch *br = NULL; int n = 0, cap = 0;
      Expr *cond = expression(); int bc; Stmt **body = block(&bc);
      cap = 4; br = (Branch *)malloc(cap * sizeof(Branch)); br[n].cond = cond; br[n].body = body; br[n].nbody = bc; n++;
      while (check(T_ORWHEN)) {
        advance(); Expr *c = expression(); int bc2; Stmt **b2 = block(&bc2);
        if (n >= cap) { cap *= 2; br = (Branch *)realloc(br, cap * sizeof(Branch)); }
        br[n].cond = c; br[n].body = b2; br[n].nbody = bc2; n++;
      }
      if (check(T_OTHERWISE)) { advance(); s->otherwise = block(&s->notherwise); }
      s->branches = br; s->nbranches = n; return s;
    }
    case T_MATCH: {
      advance();
      Stmt *s = new_stmt(S_MATCH, t.line);
      s->expr = expression();                 /* the value being matched */
      expect(T_COLON, "I expected ':' after the match value.");
      expect(T_NEWLINE, "the match arms should begin on the next line.");
      expect(T_INDENT, "I expected the arms ('is ...:' / 'otherwise:') to be indented.");
      MatchArm *arms = NULL; int n = 0, cap = 0;
      while (!check(T_DEDENT) && !check(T_EOF)) {
        if (match(T_NEWLINE)) continue;
        if (n >= cap) { cap = cap ? cap * 2 : 4; arms = (MatchArm *)realloc(arms, cap * sizeof(MatchArm)); }
        MatchArm *arm = &arms[n];
        arm->patkind = 0; arm->lit = NULL; arm->names = NULL; arm->nnames = 0; arm->body = NULL; arm->nbody = 0;
        if (match(T_OTHERWISE)) {
          arm->patkind = 3;
        } else if (match(T_IS)) {
          if (check(T_LBRACK)) {                /* maybe a list-destructure [a, b] — bare names only */
            int save = pos; advance();
            char **names = NULL; int nn = 0, ncap = 0, ok = 1;
            if (!check(T_RBRACK)) {
              do {
                if (check(T_RBRACK)) break;             /* a trailing comma is fine */
                if (!check(T_IDENT)) { ok = 0; break; }
                if (nn >= ncap) { ncap = ncap ? ncap * 2 : 4; names = (char **)realloc(names, ncap * sizeof(char *)); }
                names[nn++] = advance().text;
              } while (match(T_COMMA));
            }
            if (ok && check(T_RBRACK)) { advance(); arm->patkind = 1; arm->names = names; arm->nnames = nn; }
            else { pos = save; free(names); arm->lit = expression(); }   /* it was a list literal -> compare by value */
          } else if (check(T_LBRACE)) {         /* maybe a map-destructure {name, age} — bare names, no colons */
            int save = pos; advance();
            char **names = NULL; int nn = 0, ncap = 0, ok = 1;
            if (!check(T_RBRACE)) {
              do {
                if (check(T_RBRACE)) break;            /* a trailing comma is fine */
                if (!check(T_IDENT)) { ok = 0; break; }
                char *kn = advance().text;
                if (check(T_COLON)) { ok = 0; break; }   /* `key: value` -> a map literal, not a binding */
                if (nn >= ncap) { ncap = ncap ? ncap * 2 : 4; names = (char **)realloc(names, ncap * sizeof(char *)); }
                names[nn++] = kn;
              } while (match(T_COMMA));
            }
            if (ok && check(T_RBRACE)) { advance(); arm->patkind = 2; arm->names = names; arm->nnames = nn; }
            else { pos = save; free(names); arm->lit = expression(); }   /* a map literal -> compare by value */
          } else {
            arm->lit = expression();            /* a literal/value to compare with == */
          }
        } else {
          fail(peek().line, "inside 'match', each line should be 'is <pattern>:' or 'otherwise:'.");
        }
        arm->body = block(&arm->nbody);
        n++;
      }
      expect(T_DEDENT, "I expected the match to finish here.");
      s->arms = arms; s->narms = n; return s;
    }
    case T_REPEAT: {
      advance();
      int save_loop = g_in_loop; g_in_loop = 1;   /* 'stop'/'skip' allowed in the loop body */
      if (match(T_WHILE)) { Stmt *s = new_stmt(S_REPEAT_WHILE, t.line); s->expr = expression(); s->body = block(&s->nbody); g_in_loop = save_loop; return s; }
      Stmt *s = new_stmt(S_REPEAT_TIMES, t.line); s->count = expression();
      expect(T_TIMES, "I expected 'times' here (like: repeat 3 times:).");
      s->body = block(&s->nbody); g_in_loop = save_loop; return s;
    }
    case T_TASK: {
      if (g_block_depth > 0) fail(t.line, "a task must be defined at the top level (the far-left margin), not inside another block.");
      advance(); Token name = expect(T_IDENT, "I expected the task's name here.");
      expect(T_LPAREN, "I expected '(' after the task name.");
      char **params = NULL; Expr **pdefs = NULL; int n = 0, cap = 0, seen_default = 0;
      if (!check(T_RPAREN)) {
        do {
          Token p = expect(T_IDENT, "I expected an input name here.");
          if (n >= cap) { cap = cap ? cap * 2 : 4; params = (char **)realloc(params, cap * sizeof(char *)); pdefs = (Expr **)realloc(pdefs, cap * sizeof(Expr *)); }
          params[n] = p.text;
          if (match(T_EQ)) { pdefs[n] = expression(); seen_default = 1; }         /* task greet(name = "world"): */
          else { if (seen_default) fail(p.line, "an input with no default can't come after one that has a default \xE2\x80\x94 put the defaults last."); pdefs[n] = NULL; }
          n++;
        } while (match(T_COMMA));
      }
      expect(T_RPAREN, "I expected ')' to close the inputs.");
      Stmt *s = new_stmt(S_TASK, t.line); s->name = name.text; s->params = params; s->nparams = n; s->pdefaults = pdefs;
      s->is_public = is_public;
      int save_in_task = g_in_task; g_in_task = 1;   /* 'give' is allowed inside this body */
      s->body = block(&s->nbody);
      g_in_task = save_in_task;
      return s;
    }
    case T_GIVE: {
      if (!g_in_task) fail(t.line, "'give' only works inside a task (it hands a value back to whoever called it).");
      advance(); Stmt *s = new_stmt(S_GIVE, t.line);
      if (!check(T_NEWLINE)) s->expr = expression();   /* bare `give` hands back nothing */
      return s;
    }
    case T_USE: {
      advance(); Stmt *s = new_stmt(S_USE, t.line);
      if (check(T_IDENT) || check(T_STR)) s->name = advance().text;     /* use server   |   use "modules/server.sprout" */
      else fail(t.line, "'use' needs a module name, like:  use server");
      return s;
    }
    case T_LEARN: {
      advance(); Stmt *s = new_stmt(S_LEARN, t.line);
      if (check(T_IDENT) && !strcmp(peek().text, "on"))  { s->is_public = 1; advance(); }
      else if (check(T_IDENT) && !strcmp(peek().text, "off")) { s->is_public = 0; advance(); }
      else fail(t.line, "say 'learn on' to explain each step, or 'learn off' to stop.");
      return s;
    }
    case T_TEST: {
      if (g_block_depth > 0) fail(t.line, "a test must be at the top level (the far-left margin).");
      advance(); Stmt *s = new_stmt(S_TEST, t.line);
      Token nm = expect(T_STR, "I expected a name in quotes here, like:  test \"greeting\":");
      s->name = nm.text;
      int save = g_in_test; g_in_test = 1;     /* 'expect' is allowed inside this body */
      s->body = block(&s->nbody);
      g_in_test = save;
      return s;
    }
    case T_EXPECT: {
      if (!g_in_test) fail(t.line, "'expect' only works inside a test (like:  test \"x\":  then  expect ...).");
      advance();
      if (check(T_IDENT) && !strcmp(peek().text, "error")) {   /* expect error: <block> (asserts the block fails) */
        advance(); Stmt *s = new_stmt(S_EXPECT_ERROR, t.line);
        if (check(T_STR)) s->name = advance().text;            /* optional required kind: expect error "math": */
        s->body = block(&s->nbody);
        return s;
      }
      Stmt *s = new_stmt(S_EXPECT, t.line); s->expr = expression();
      return s;
    }
    case T_TRY: {
      advance(); Stmt *s = new_stmt(S_TRY, t.line);
      s->body = block(&s->nbody);                          /* the protected steps */
      if (!check(T_CAUGHT)) fail(t.line, "a 'try:' needs a 'caught:' block to handle problems (like:  try:  ...  caught problem:  ...).");
      advance();
      if (check(T_IDENT)) s->name = advance().text;        /* caught problem:  -> 'problem' holds the error map */
      s->otherwise = block(&s->notherwise);
      return s;
    }
    case T_FAIL: {
      advance(); Stmt *s = new_stmt(S_FAIL, t.line);
      if (!check(T_NEWLINE)) s->expr = expression();       /* fail "message"  (bare 'fail' uses a default) */
      return s;
    }
    case T_STOP: {
      if (!g_in_loop) fail(t.line, "'stop' only works inside a loop (it ends the loop early).");
      advance(); return new_stmt(S_STOP, t.line);
    }
    case T_SKIP: {
      if (!g_in_loop) fail(t.line, "'skip' only works inside a loop (it jumps to the next turn).");
      advance(); return new_stmt(S_SKIP, t.line);
    }
    default:
      if (check(T_IDENT)) {
        TokType nxt = toks[pos + 1].type;
        if (nxt == T_EQ) {   /* `x = 5` — forgot make/set */
          char m[200]; snprintf(m, sizeof m, "to create a variable use 'make', to change one use 'set' — like:  make %s = ...", t.text);
          fail(t.line, m);
        }
        /* a misspelled keyword followed by a value reads like a broken expression — suggest the keyword */
        if (nxt == T_STR || nxt == T_NUM || nxt == T_IDENT || nxt == T_YES || nxt == T_NO || nxt == T_NOTHING) {
          const char *kw = suggest_keyword(t.text);
          if (kw) { char m[200]; snprintf(m, sizeof m, "I didn't expect '%s' at the start of a line. Did you mean '%s'?", t.text, kw); fail(t.line, m); }
        }
        Stmt *s = new_stmt(S_EXPR, t.line); s->expr = expression(); return s;
      }
      if (t.text) { char m[160]; snprintf(m, sizeof m, "I didn't expect '%s' at the start of a line.", t.text); fail(t.line, m); }
      fail(t.line, "I didn't expect this at the start of a line.");
  }
  return NULL;
}

static Stmt **parse_program(int *count) {
  g_block_depth = 0; g_in_task = 0; g_in_test = 0; g_in_loop = 0;   /* fresh per parse, so a prior error's longjmp can't leave them stuck */
  Stmt **list = NULL; int n = 0, cap = 0;
  while (!check(T_EOF)) {
    if (match(T_NEWLINE)) continue;
    if (n >= cap) { cap = cap ? cap * 2 : 16; list = (Stmt **)realloc(list, cap * sizeof(Stmt *)); }
    list[n++] = statement();
  }
  *count = n; return list;
}

/* -------------------------------------------------------------- interpreter */
typedef struct { char *name; Value val; } Var;
typedef struct Env { Var *vars; int n, cap; struct Env *parent; } Env;
static Env *global_env;           /* the PUBLIC space: shared by every file in the project */
static Env *cur_file_env = NULL;  /* the file scope currently running its top-level code */
static int  cur_fileid = 0;       /* which file's code is executing (for private-task visibility) */
static int  g_next_fileid = 0;

static Env *env_new(Env *parent) { Env *e = (Env *)gc_alloc(GC_ENV, sizeof(Env)); e->parent = parent; return e; }
static Value *env_local(Env *e, const char *name) { for (int i = 0; i < e->n; i++) if (!strcmp(e->vars[i].name, name)) return &e->vars[i].val; return NULL; }
static Value *env_find(Env *e, const char *name) { for (; e; e = e->parent) { Value *v = env_local(e, name); if (v) return v; } return NULL; }
static void env_define(Env *e, const char *name, Value v) {
  Value *slot = env_local(e, name);
  if (slot) { *slot = v; return; }
  if (e->n >= e->cap) { e->cap = e->cap ? e->cap * 2 : 8; e->vars = (Var *)realloc(e->vars, e->cap * sizeof(Var)); }
  /* Borrow the name — every caller passes a permanent string (an AST identifier: a task
     param, a `make`/`for each` target, a destructure name, …), so there's no need to copy
     it per definition. (This is hot: a recursive call binds its params on every call.) */
  e->vars[e->n].name = (char *)name; e->vars[e->n].val = v; e->n++;
}
static const char *suggest_name(const char *name, Env *env, int include_vars);   /* defined below */
static void env_assign(Env *e, const char *name, Value v, int line) {
  Value *slot = env_find(e, name);
  if (!slot) {
    char msg[400]; const char *sug = suggest_name(name, e, 1);
    if (sug) snprintf(msg, sizeof msg, "I can't set '%s' because it was never made.\n\n  Did you mean '%s'?  (or make it first:  make %s = ...)", name, sug, name);
    else snprintf(msg, sizeof msg, "I can't set '%s' because it was never made.\n\n  Make it first, like:  make %s = ...", name, name);
    fail_hard(line, "name", msg);   /* a typo'd name is a code mistake - try: never swallows it */
  }
  *slot = v;
}

/* tasks: top-level functions, hoisted so call order doesn't matter */
struct TaskDef { char *name; char **params; int nparams; Expr **defaults; Stmt **body; int nbody; int line;
                 int is_public; int fileid; Env *home; Env *file_env; char *owner_type; };   /* home = closure/scope base; file_env = where `public make` lands; owner_type = the type a method is defined on (NULL for plain tasks/lambdas, so `super` knows the parent). TaskDef typedef is forward-declared up by Value */
static const char *taskdef_name(TaskDef *t) { return (t && t->name) ? t->name : "?"; }
static TaskDef *tasks = NULL; static int ntasks = 0, captasks = 0;
/* bare calls only see tasks of the CURRENT file; cross-file goes through a module namespace */
static TaskDef *task_find(const char *name) {
  for (int i = 0; i < ntasks; i++) if (tasks[i].fileid == cur_fileid && !strcmp(tasks[i].name, name)) return &tasks[i];
  return NULL;
}
/* a PUBLIC task of a specific file, reached as module.name() */
static TaskDef *task_find_public(int fileid, const char *name) {
  for (int i = 0; i < ntasks; i++) if (tasks[i].fileid == fileid && tasks[i].is_public && !strcmp(tasks[i].name, name)) return &tasks[i];
  return NULL;
}
static void task_register(Stmt *s, int fileid, Env *home) {
  for (int i = 0; i < ntasks; i++)
    if (tasks[i].fileid == fileid && !strcmp(tasks[i].name, s->name))
      failf(s->line, "there are two tasks named '%s' in this file.", s->name);
  if (ntasks >= captasks) { captasks = captasks ? captasks * 2 : 8; tasks = (TaskDef *)realloc(tasks, captasks * sizeof(TaskDef)); }
  TaskDef *t = &tasks[ntasks++];
  t->name = s->name; t->params = s->params; t->nparams = s->nparams; t->defaults = s->pdefaults; t->body = s->body; t->nbody = s->nbody; t->line = s->line;
  t->is_public = s->is_public; t->fileid = fileid; t->home = home; t->file_env = home; t->owner_type = NULL;
}

/* Parse an anonymous task literal (lambda):  task(a, b): expr   or   task(a):\n<indented block>.
   Defined here (not next to primary()) because it needs the COMPLETE TaskDef type above.
   A one-line body is an implicit `give` of a single expression — the everyday case
   (`map(xs, task(x): x * 2)`); a `give` keyword is allowed but optional. The closure's
   `home`/`fileid` are filled in at eval time, capturing wherever the literal runs. */
static Expr *parse_anon_task(int line) {
  expect(T_LPAREN, "I expected '(' after 'task' for an anonymous task, like task(x): x * 2.");
  char **params = NULL; Expr **pdefs = NULL; int np = 0, cap = 0, seen_default = 0;
  if (!check(T_RPAREN)) {
    do {
      Token p = expect(T_IDENT, "I expected an input name here.");
      if (np >= cap) { cap = cap ? cap * 2 : 4; params = (char **)realloc(params, cap * sizeof(char *)); pdefs = (Expr **)realloc(pdefs, cap * sizeof(Expr *)); }
      params[np] = p.text;
      if (match(T_EQ)) { pdefs[np] = expression(); seen_default = 1; }
      else { if (seen_default) fail(p.line, "an input with no default can't come after one that has a default \xE2\x80\x94 put the defaults last."); pdefs[np] = NULL; }
      np++;
    } while (match(T_COMMA));
  }
  expect(T_RPAREN, "I expected ')' to close the inputs.");
  expect(T_COLON, "I expected ':' before the task's body.");
  Stmt **body = NULL; int nbody = 0;
  int save_in_task = g_in_task; g_in_task = 1;        /* `give` is allowed inside the body */
  if (check(T_NEWLINE)) {                              /* multi-line body: an indented block */
    advance();                                         /* the newline */
    expect(T_INDENT, "I expected the task body to be indented (or write it on one line).");
    int bcap = 0; g_block_depth++;
    while (!check(T_DEDENT) && !check(T_EOF)) {
      if (match(T_NEWLINE)) continue;
      if (nbody >= bcap) { bcap = bcap ? bcap * 2 : 8; body = (Stmt **)realloc(body, bcap * sizeof(Stmt *)); }
      body[nbody++] = statement();
    }
    g_block_depth--;
    expect(T_DEDENT, "I expected the task body to finish here.");
  } else {                                             /* one-liner: implicit `give` of one expression */
    int had_give = match(T_GIVE);                       /* an explicit `give` is allowed but optional */
    Stmt *g = new_stmt(S_GIVE, line);
    /* a bare `give` (no value) is allowed, just like in a named task — it gives nothing */
    int ends_here = check(T_NEWLINE) || check(T_DEDENT) || check(T_EOF) ||
                    check(T_RPAREN)  || check(T_RBRACK) || check(T_RBRACE) || check(T_COMMA);
    if (!(had_give && ends_here)) {
      TokType nx = peek().type;     /* a statement keyword here means a multi-step body got flattened to one line */
      if (nx == T_MAKE || nx == T_SET || nx == T_SHOW || nx == T_WHEN || nx == T_REPEAT || nx == T_FOR ||
          nx == T_MATCH || nx == T_TRY || nx == T_USE || nx == T_LEARN || nx == T_TEST || nx == T_STOP ||
          nx == T_SKIP || nx == T_PUBLIC || nx == T_PRIVATE)
        fail(line, "a one-line lambda body must be a single expression. For several steps, write the task on its own indented lines (and inside a list/map/call, give it a name first with 'make').");
      g->expr = expression();
    }
    body = (Stmt **)malloc(sizeof(Stmt *)); body[0] = g; nbody = 1;
  }
  g_in_task = save_in_task;
  TaskDef *td = (TaskDef *)calloc(1, sizeof(TaskDef));
  td->name = "anonymous task"; td->params = params; td->nparams = np; td->defaults = pdefs;
  td->body = body; td->nbody = nbody; td->line = line;
  Expr *e = new_expr(E_LAMBDA, line); e->lambda = td;
  return e;
}

/* module namespaces: a use'd file is reachable as  name.member  */
typedef struct { char *name; int fileid; Env *env; } ModNS;
static ModNS *g_mods = NULL; static int g_nmods = 0, g_capmods = 0;
static void modns_register(const char *name, int fileid, Env *env) {
  for (int i = 0; i < g_nmods; i++) if (!strcmp(g_mods[i].name, name)) {
    if (g_mods[i].fileid == fileid) return;     /* same file (shouldn't re-register, but harmless) */
    failf(0, "two files in this project are both named '%s' - module names must be unique. Rename one.", name);
  }
  if (g_nmods >= g_capmods) { g_capmods = g_capmods ? g_capmods * 2 : 8; g_mods = (ModNS *)realloc(g_mods, g_capmods * sizeof(ModNS)); }
  g_mods[g_nmods].name = dup_str(name); g_mods[g_nmods].fileid = fileid; g_mods[g_nmods].env = env; g_nmods++;
}
static ModNS *modns_get(const char *name) { for (int i = 0; i < g_nmods; i++) if (!strcmp(g_mods[i].name, name)) return &g_mods[i]; return NULL; }

/* per-file imports: a file may only name a module it has `use`d */
typedef struct { int fileid; char *name; } Pair;
static Pair *g_uses = NULL; static int g_nuses = 0, g_capuses = 0;
static void mark_use(int fileid, const char *name) {
  for (int i = 0; i < g_nuses; i++) if (g_uses[i].fileid == fileid && !strcmp(g_uses[i].name, name)) return;
  if (g_nuses >= g_capuses) { g_capuses = g_capuses ? g_capuses * 2 : 8; g_uses = (Pair *)realloc(g_uses, g_capuses * sizeof(Pair)); }
  g_uses[g_nuses].fileid = fileid; g_uses[g_nuses].name = dup_str(name); g_nuses++;
}
static int has_use(int fileid, const char *name) {
  for (int i = 0; i < g_nuses; i++) if (g_uses[i].fileid == fileid && !strcmp(g_uses[i].name, name)) return 1;
  return 0;
}

/* public variables, exposed on a module namespace as name.var */
static Pair *g_pubvars = NULL; static int g_npv = 0, g_cappv = 0;
static void mark_public_var(int fileid, const char *name) {
  for (int i = 0; i < g_npv; i++) if (g_pubvars[i].fileid == fileid && !strcmp(g_pubvars[i].name, name)) return;
  if (g_npv >= g_cappv) { g_cappv = g_cappv ? g_cappv * 2 : 8; g_pubvars = (Pair *)realloc(g_pubvars, g_cappv * sizeof(Pair)); }
  g_pubvars[g_npv].fileid = fileid; g_pubvars[g_npv].name = dup_str(name); g_npv++;
}
static int is_public_var(int fileid, const char *name) {
  for (int i = 0; i < g_npv; i++) if (g_pubvars[i].fileid == fileid && !strcmp(g_pubvars[i].name, name)) return 1;
  return 0;
}

/* `give` is signalled with a flag + slot so it unwinds cleanly through blocks/loops */
static int returning = 0;
static int g_loopctl = 0;   /* 0 = none, 1 = skip (next turn), 2 = stop (end the loop) */
static Value return_value;
/* call_depth is declared up by the error globals (shared with the g_frames traceback stack). */
static int repl_echo = 0;   /* in the live prompt, print the value of a bare expression */
static int g_learn = 0;     /* `learn on`: narrate each step as the program runs */
static int g_tpass = 0, g_tfail = 0;   /* test results so far */
static const char *g_cur_test = NULL;  /* the test currently running (for expect messages) */
static int g_test_failed = 0;          /* did the current test fail? */

/* ---------------- garbage collector: the mark-sweep collector ----------------
   At a safe point (the top of each statement) we mark everything reachable from a few
   precise global roots PLUS anything the C stack/registers point at, then free the rest.
   Over-approximating the roots means we never free a live object. */
static void **gc_set = NULL; static size_t gc_setcap = 0;   /* live-object pointer set, rebuilt per collection */
static GCObj *gc_lookup(void *p) {          /* is p a live collectible object? -> its header, else NULL */
  if (!p || gc_setcap == 0) return NULL;
  size_t mask = gc_setcap - 1, i = ((size_t)p >> 4) & mask;
  while (gc_set[i]) { if (gc_set[i] == p) return GC_HDR(p); i = (i + 1) & mask; }
  return NULL;
}
static void gc_set_put(void *p) { size_t mask = gc_setcap - 1, i = ((size_t)p >> 4) & mask; while (gc_set[i]) i = (i + 1) & mask; gc_set[i] = p; }
/* Marking uses an explicit WORKLIST, not recursion, so arbitrarily deep structures
   (a 30k-nested list, a long parent chain) can never overflow the C stack. The mark bit
   doubles as the "already discovered" guard, which also terminates cycles. */
static GCObj **gc_work = NULL; static size_t gc_workn = 0, gc_workcap = 0;
static void gc_push(void *p) {                 /* discover an object: mark it + queue it to scan */
  GCObj *h = gc_lookup(p);
  if (!h || h->mark) return;
  h->mark = 1;
  if (gc_workn >= gc_workcap) { gc_workcap = gc_workcap ? gc_workcap * 2 : 1024; gc_work = (GCObj **)realloc(gc_work, gc_workcap * sizeof(GCObj *)); }
  gc_work[gc_workn++] = h;
}
static void gc_push_value(Value v) {
  if (v.type == V_LIST)      gc_push(v.list);
  else if (v.type == V_MAP)  gc_push(v.map);
  else if (v.type == V_TASK) gc_push(v.task);
  else if (v.type == V_STR)  gc_push(v.str);   /* the string itself is a GC_STR object */
}
static void gc_drain(void) {                    /* process the worklist iteratively (constant C-stack) */
  while (gc_workn) {
    GCObj *h = gc_work[--gc_workn];
    void *p = (void *)(h + 1);
    if (h->kind == GC_LIST)      { SList *l = (SList *)p; for (int i = 0; i < l->n; i++) gc_push_value(l->items[i]); }
    else if (h->kind == GC_MAP)  { SMap *m = (SMap *)p; for (int i = 0; i < m->n; i++) gc_push_value(m->vals[i]); }
    else if (h->kind == GC_ENV)  { Env *e = (Env *)p; for (int i = 0; i < e->n; i++) gc_push_value(e->vars[i].val); gc_push(e->parent); }
    else if (h->kind == GC_TASK) { TaskDef *t = (TaskDef *)p; gc_push(t->home); gc_push(t->file_env); }
  }
}
/* The conservative scan deliberately reads the WHOLE C stack (and the register-spill
   buffer) looking for pointers — including the redzones AddressSanitizer poisons around
   stack variables. That's intentional and safe, so tell ASan not to instrument it. */
#if defined(__SANITIZE_ADDRESS__)        /* defined by gcc and clang under -fsanitize=address */
#  define GC_NO_ASAN __attribute__((no_sanitize_address))
#else
#  define GC_NO_ASAN
#endif
static void GC_NO_ASAN gc_scan_range(char *lo, char *hi) { for (; lo + sizeof(void *) <= hi; lo += sizeof(void *)) gc_push(*(void **)lo); }
static void gc_collect(void) {
  jmp_buf regs; setjmp(regs);               /* spill all callee-saved registers so we can scan them (never longjmp'd) */
  char marker; char *sp = &marker;          /* current stack top (lowest live address) */
  size_t count = 0; for (GCObj *h = gc_all; h; h = h->next) count++;
  gc_setcap = 16; while (gc_setcap < count * 2) gc_setcap *= 2;
  gc_set = (void **)calloc(gc_setcap, sizeof(void *));
  for (GCObj *h = gc_all; h; h = h->next) gc_set_put((void *)(h + 1));
  gc_workn = 0;                                               /* queue all the roots, then drain once */
  gc_push(global_env); gc_push(cur_file_env);
  for (int i = 0; i < g_nmods; i++) gc_push(g_mods[i].env);
  for (int i = 0; i < ntasks; i++) { gc_push(tasks[i].home); gc_push(tasks[i].file_env); }
  gc_push_value(return_value);
  if (g_have_fail_override) gc_push_value(g_fail_override);
  gc_scan_range((char *)&regs, (char *)&regs + sizeof regs);   /* the spilled registers */
  char *lo = sp, *hi = gc_stack_bottom;
  if (lo > hi) { char *t = lo; lo = hi; hi = t; }
  while ((size_t)lo % sizeof(void *)) lo++;
  gc_scan_range(lo, hi);                                       /* the whole live C stack */
  gc_drain();                                                 /* mark everything reachable, iteratively */
  GCObj **pp = &gc_all;                                        /* sweep */
  while (*pp) {
    GCObj *h = *pp;
    if (h->mark) { h->mark = 0; pp = &h->next; continue; }
    *pp = h->next;
    void *p = (void *)(h + 1);
    if (h->kind == GC_LIST)      free(((SList *)p)->items);
    else if (h->kind == GC_MAP)  { SMap *m = (SMap *)p; for (int i = 0; i < m->n; i++) free(m->keys[i]); free(m->keys); free(m->vals); free(m->idx); }
    else if (h->kind == GC_ENV)  { Env *e = (Env *)p; free(e->vars); }   /* var names are borrowed (permanent AST text), never owned — only the array is ours */
    free(h);
  }
  free(gc_set); gc_set = NULL; gc_setcap = 0;
  gc_bytes = 0;
}

#define MAX_DEPTH 6000

static Value eval(Expr *e, Env *env);
static void exec(Stmt *s, Env *env);
static void load_module(const char *name);   /* defined near main(); pulls in another project file */
static char *module_basename(const char *path);   /* "server" from "modules/server.sprout" */
static int test_report(void);                 /* prints the test summary + returns exit code */
static void exec_block(Stmt **list, int n, Env *env) { for (int i = 0; i < n; i++) { exec(list[i], env); if (returning || g_loopctl) return; } }
/* run a block in its OWN child scope, so `make` inside it doesn't leak out */
static void exec_scoped(Stmt **list, int n, Env *parent) { Env *be = env_new(parent); exec_block(list, n, be); }
/* Does this block bind a name in its own scope? Only `make` defines into the current env —
   `set` modifies an existing var, and `when`/`repeat`/`for each`/`try` run their bodies in
   their own child scopes. So a block with no direct `make` needs no scope of its own, and a
   loop can run it straight in the parent env instead of allocating a fresh one every turn.
   (An empty scope is transparent to closures, so this is safe even when the body has lambdas.) */
static int block_binds_names(Stmt **list, int n) { for (int i = 0; i < n; i++) if (list[i]->kind == S_MAKE) return 1; return 0; }

/* run a task body in a prepared frame (the params are already bound). Shared by the Expr-based
   caller and the Value-based one (which higher-order builtins like map/filter use). */
static Value run_task(TaskDef *t, Env *frame, int line) {
  if (++call_depth > MAX_DEPTH) fail(line, "this went too deep — a task may be calling itself with no way to stop.");
  g_frames[call_depth].name = t->name; g_frames[call_depth].line = line;   /* record this frame for tracebacks */
  if (g_learn) {
    printf("  " C_DIM "Calling %s(", t->name);
    for (int i = 0; i < t->nparams; i++) { if (i) printf(", "); Value *pv = env_find(frame, t->params[i]); char *ps = stringify(*pv); printf("%s", ps); free(ps); }
    printf(")" C_RESET "\n\n");
  }
  int saved_ret = returning; Value saved_rv = return_value;
  int saved_loopctl = g_loopctl;                               /* a stop/skip inside the body must not leak into a CALLER's loop */
  int saved_fid = cur_fileid; cur_fileid = t->fileid;          /* inside the body, see THIS task's file */
  Env *saved_fe = cur_file_env; cur_file_env = t->file_env;    /* ...and a `public make` lands in the FILE env (not a lambda's capture frame) */
  returning = 0; g_loopctl = 0;
  exec_block(t->body, t->nbody, frame);
  Value result = returning ? return_value : vnone();
  if (g_learn) { char *rs = stringify(result); printf("  " C_DIM "%s gave back %s" C_RESET "\n\n", t->name, rs); free(rs); }
  returning = saved_ret; return_value = saved_rv; g_loopctl = saved_loopctl;
  cur_fileid = saved_fid; cur_file_env = saved_fe;
  call_depth--;
  return result;
}
static void task_arity_check(TaskDef *t, int got, int line) {
  int req = t->nparams;
  if (t->defaults) while (req > 0 && t->defaults[req - 1]) req--;   /* trailing params with a default are optional */
  if (got < req || got > t->nparams) { char m[200];
    if (req == t->nparams) snprintf(m, sizeof m, "the task '%s' wants %d input%s, but got %d.", t->name, t->nparams, t->nparams == 1 ? "" : "s", got);
    else snprintf(m, sizeof m, "the task '%s' wants %d to %d inputs, but got %d.", t->name, req, t->nparams, got);
    fail(line, m); }
}
static Value call_task_def(TaskDef *t, Expr *call, Env *env) {
  task_arity_check(t, call->nargs, call->line);
  Env *frame = env_new(t->home);      /* a task sees its OWN file (privates + publics) + its locals */
  for (int i = 0; i < call->nargs; i++) env_define(frame, t->params[i], eval(call->args[i], env));
  for (int i = call->nargs; i < t->nparams; i++) env_define(frame, t->params[i], eval(t->defaults[i], frame));   /* fill trailing defaults */
  return run_task(t, frame, call->line);
}
/* call a task VALUE with already-evaluated args (used by map/filter/reduce/each) */
static Value call_task_v(TaskDef *t, Value *argv, int argc, int line) {
  task_arity_check(t, argc, line);
  Env *frame = env_new(t->home);
  for (int i = 0; i < argc; i++) env_define(frame, t->params[i], argv[i]);
  for (int i = argc; i < t->nparams; i++) env_define(frame, t->params[i], eval(t->defaults[i], frame));   /* fill trailing defaults */
  if (t->owner_type) env_define(frame, "__class__", vstr(t->owner_type));   /* so `super` inside a method finds the defining type's parent */
  return run_task(t, frame, line);
}
static Value call_task(Expr *call, Env *env) {
  TaskDef *t = task_find(call->name);
  if (!t) failf(call->line, "I don't know a task called '%s'.", call->name);
  return call_task_def(t, call, env);
}

/* ---- "did you mean?" suggestions, so errors can teach instead of just scold ---- */
static int edit_distance(const char *a, const char *b) {
  int la = (int)strlen(a), lb = (int)strlen(b);
  if (la > 64 || lb > 64) return 99;
  int prev[66], cur[66];
  for (int j = 0; j <= lb; j++) prev[j] = j;
  for (int i = 1; i <= la; i++) {
    cur[0] = i;
    for (int j = 1; j <= lb; j++) {
      int cost = (tolower((unsigned char)a[i-1]) == tolower((unsigned char)b[j-1])) ? 0 : 1;
      int del = prev[j] + 1, ins = cur[j-1] + 1, sub = prev[j-1] + cost;
      int m = del < ins ? del : ins; if (sub < m) m = sub;
      cur[j] = m;
    }
    for (int j = 0; j <= lb; j++) prev[j] = cur[j];
  }
  return prev[lb];
}

static const char *const BUILTIN_NAMES[] = {
  "range","length","add","keys","contains","first","last",
  "remove","insert","sort","sort_by","reverse","index_of","values","copy","kind_of","is_a","map","filter","reduce","group_by","min_by","max_by","partition","chunk",
  "sum","count","unique","zip","flatten","slice","words","lines","title","seed",
  "abs","round","floor","ceil","sqrt","pow","min","max","random","number","is_number","clamp","sign","format",
  "sin","cos","tan","log","exp","pi","args","env","exit",
  "code","char","pad_start","pad_end",
  "matches","find","find_all","captures",
  "upper","lower","trim","replace","split","join","starts_with","ends_with",
  "ask","now","today","wait","read","write","append","exists","remember","recall","forget",
  "time","time_parts","time_make","time_format","days","hours","minutes",
  "get","json","explore","color",
};
static const int NBUILTIN_NAMES = (int)(sizeof BUILTIN_NAMES / sizeof BUILTIN_NAMES[0]);
static int is_builtin_name(const char *name) {
  for (int i = 0; i < NBUILTIN_NAMES; i++) if (!strcmp(BUILTIN_NAMES[i], name)) return 1;
  return 0;
}

/* the closest known name to `name` within a small edit distance, or NULL if nothing is close */
static const char *suggest_name(const char *name, Env *env, int include_vars) {
  const char *best = NULL; int bestd = 1000;
  if (include_vars)
    for (Env *e = env; e; e = e->parent)
      for (int i = 0; i < e->n; i++) { int d = edit_distance(name, e->vars[i].name); if (d < bestd) { bestd = d; best = e->vars[i].name; } }
  for (int i = 0; i < ntasks; i++) { int d = edit_distance(name, tasks[i].name); if (d < bestd) { bestd = d; best = tasks[i].name; } }
  for (int i = 0; i < NBUILTIN_NAMES; i++) { int d = edit_distance(name, BUILTIN_NAMES[i]); if (d < bestd) { bestd = d; best = BUILTIN_NAMES[i]; } }
  int L = (int)strlen(name); int thr = L <= 3 ? 1 : 2;
  /* bestd == 0 means a same-spelled name exists but isn't usable here (e.g. another file's
     private) — suggesting the identical word back is unhelpful, so skip it. */
  return (best && bestd >= 1 && bestd <= thr) ? best : NULL;
}
/* the closest existing map key to a missing one, for a 'did you mean' on a typo'd lookup.
   Returns NULL unless a key is within a small edit distance, so a genuinely-absent optional
   key still just reads as nothing (same threshold rule as suggest_name). */
static const char *nearest_map_key(SMap *m, const char *key) {
  if (!m || !key || !*key) return NULL;
  const char *best = NULL; int bestd = 1000;
  for (int i = 0; i < m->n; i++) { int d = edit_distance(key, m->keys[i]); if (d < bestd) { bestd = d; best = m->keys[i]; } }
  int L = (int)strlen(key), thr = L <= 3 ? 1 : 2;
  if (!best || bestd < 1 || bestd > thr) return NULL;
  int pre = 0; while (key[pre] && best[pre] && key[pre] == best[pre]) pre++;   /* shared leading chars */
  return pre >= 2 ? best : NULL;   /* a real typo keeps a common prefix (cost/cost2); avoids x/y, next/text */
}
/* fail on a typo'd map key, SHOWING the offending map so the reader sees the bad key in context */
static void fail_map_key(int line, Value mapval, const char *key, const char *sug) {
  char *r = stringify(mapval);
  char msg[512];
  snprintf(msg, sizeof msg, "I was looking for the key \"%s\", but found \"%s\" in this map:\n\n  %.300s\n\n  Did you mean \"%s\"?", key, sug, r ? r : "{ ... }", sug);
  free(r);
  fail_kind(line, "key", msg);
}

/* built-in functions — called like tasks: name(args). */
/* ---- helpers for the "superpower" builtins: files, shell, web, json, text ---- */

static char *read_whole_file(const char *path) {
  FILE *f = fopen(path, "rb");
  if (!f) return NULL;
  if (fseek(f, 0, SEEK_END) != 0) { fclose(f); return NULL; }
  long sz = ftell(f);
  if (sz < 0) { fclose(f); return NULL; }       /* not a normal seekable file (e.g. a directory) */
  fseek(f, 0, SEEK_SET);
  char *buf = (char *)malloc(sz + 1);
  if (!buf) { fclose(f); return NULL; }
  size_t got = fread(buf, 1, sz, f); buf[got] = 0; fclose(f);
  return buf;
}

/* run a shell command and capture its output */
static char *run_command(const char *cmd) {
#ifdef __EMSCRIPTEN__
  (void)cmd; return NULL;                 /* no subprocesses in the browser build */
#else
#ifdef _WIN32
  FILE *p = _popen(cmd, "r");
#else
  FILE *p = popen(cmd, "r");
#endif
  if (!p) return NULL;
  size_t cap = 256, len = 0; char *buf = (char *)malloc(cap); char chunk[1024]; size_t r;
  while ((r = fread(chunk, 1, sizeof chunk, p)) > 0) {
    while (len + r + 1 > cap) { cap *= 2; buf = (char *)realloc(buf, cap); }
    memcpy(buf + len, chunk, r); len += r;
  }
  buf[len] = 0;
#ifdef _WIN32
  _pclose(p);
#else
  pclose(p);
#endif
  return buf;
#endif
}

/* fetch a URL's body (downloads to a temp file, reads it back) */
static char *http_get(const char *url) {
#ifdef __EMSCRIPTEN__
  (void)url; return NULL;                 /* no network in the browser build (the playground runs sandboxed anyway) */
#elif defined(_WIN32)
  char tmp[MAX_PATH]; GetTempPathA(MAX_PATH, tmp);
  char file[MAX_PATH + 48]; snprintf(file, sizeof file, "%ssprout_get_%lu.tmp", tmp, (unsigned long)GetCurrentProcessId());
  if (URLDownloadToFileA(NULL, url, file, 0, NULL) != S_OK) { DeleteFileA(file); return NULL; }
  char *body = read_whole_file(file);
  DeleteFileA(file);
  return body;
#else
  /* POSIX: shell out to curl if it's available. Single-quote the URL (and escape any
     embedded single quote) so it can't be a shell-injection vector. */
  size_t ulen = strlen(url);
  char *q = (char *)malloc(ulen * 4 + 3);
  if (!q) return NULL;
  int qi = 0; q[qi++] = '\'';
  for (size_t i = 0; i < ulen; i++) {
    if (url[i] == '\'') { q[qi++] = '\''; q[qi++] = '\\'; q[qi++] = '\''; q[qi++] = '\''; }
    else q[qi++] = url[i];
  }
  q[qi++] = '\''; q[qi] = 0;
  /* a safe, unpredictable temp file we own (no /tmp symlink/clobber) */
  const char *tmpdir = getenv("TMPDIR"); if (!tmpdir || !*tmpdir) tmpdir = "/tmp";
  char file[512]; snprintf(file, sizeof file, "%s/sprout_get_XXXXXX", tmpdir);
  int fd = mkstemp(file);
  if (fd < 0) { free(q); return NULL; }
  close(fd);
  char cmd[8192];
  int need = snprintf(cmd, sizeof cmd, "curl -fsSL %s -o '%s' 2>/dev/null", q, file);
  free(q);
  if (need < 0 || (size_t)need >= sizeof cmd) { remove(file); return NULL; }   /* URL too long: fail, don't truncate */
  int rc = system(cmd);
  if (rc != 0) { remove(file); return NULL; }
  char *body = read_whole_file(file);
  remove(file);
  return body;
#endif
}

/* ---- tiny JSON parser: text -> a Sprout value (map / list / text / number / yes-no / nothing) ---- */
typedef struct { const char *s; int pos, len, ok, depth; } JParse;
static Value jvalue(JParse *j);
static Value jvalue_inner(JParse *j);
static int jhex4(const char *p) {
  int v = 0;
  for (int k = 0; k < 4; k++) { char h = p[k]; int d;
    if (h>='0'&&h<='9') d=h-'0'; else if (h>='a'&&h<='f') d=h-'a'+10; else if (h>='A'&&h<='F') d=h-'A'+10; else return -1;
    v = v*16 + d; }
  return v;
}
static void jskip(JParse *j) { while (j->pos < j->len) { char c = j->s[j->pos]; if (c==' '||c=='\t'||c=='\n'||c=='\r') j->pos++; else break; } }
static Value jstring(JParse *j) {
  j->pos++;  /* opening quote */
  char *buf = (char *)malloc(j->len - j->pos + 1); int b = 0;
  while (j->pos < j->len && j->s[j->pos] != '"') {
    char c = j->s[j->pos];
    if (c == '\\' && j->pos + 1 < j->len) {
      char nx = j->s[j->pos + 1];
      if (nx=='n') buf[b++]='\n'; else if (nx=='t') buf[b++]='\t'; else if (nx=='r') buf[b++]='\r';
      else if (nx=='"') buf[b++]='"'; else if (nx=='\\') buf[b++]='\\'; else if (nx=='/') buf[b++]='/';
      else if (nx=='u' && j->pos + 5 < j->len) {
        int cp = jhex4(j->s + j->pos + 2);
        if (cp < 0) { j->ok = 0; break; }
        j->pos += 6;
        if (cp >= 0xD800 && cp <= 0xDBFF && j->pos + 5 < j->len && j->s[j->pos]=='\\' && j->s[j->pos+1]=='u') {
          int lo = jhex4(j->s + j->pos + 2);
          if (lo >= 0xDC00 && lo <= 0xDFFF) { cp = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00); j->pos += 6; }
        }
        if (cp < 0x80) buf[b++]=(char)cp;
        else if (cp < 0x800) { buf[b++]=(char)(0xC0|(cp>>6)); buf[b++]=(char)(0x80|(cp&0x3F)); }
        else if (cp < 0x10000) { buf[b++]=(char)(0xE0|(cp>>12)); buf[b++]=(char)(0x80|((cp>>6)&0x3F)); buf[b++]=(char)(0x80|(cp&0x3F)); }
        else { buf[b++]=(char)(0xF0|(cp>>18)); buf[b++]=(char)(0x80|((cp>>12)&0x3F)); buf[b++]=(char)(0x80|((cp>>6)&0x3F)); buf[b++]=(char)(0x80|(cp&0x3F)); }
        continue;
      } else buf[b++]=nx;
      j->pos += 2;
    } else { buf[b++]=c; j->pos++; }
  }
  if (j->pos < j->len) j->pos++; else j->ok = 0;
  buf[b]=0; return vstr_take(buf);
}
static Value jvalue(JParse *j) {
  if (++j->depth > 256) { j->ok = 0; j->depth--; return vnone(); }   /* guard the C stack; cap sits ABOVE the writer's (200 + the store-map wrap + a truncation null) so written output always re-parses */
  Value r = jvalue_inner(j);
  j->depth--;
  return r;
}
static Value jvalue_inner(JParse *j) {
  jskip(j);
  if (j->pos >= j->len) { j->ok=0; return vnone(); }
  char c = j->s[j->pos];
  if (c=='"') return jstring(j);
  if (c=='{') {
    j->pos++; SMap *m = map_new(); jskip(j);
    if (j->pos<j->len && j->s[j->pos]=='}') { j->pos++; return vmap(m); }
    for (;;) {
      jskip(j);
      if (j->pos>=j->len || j->s[j->pos]!='"') { j->ok=0; break; }
      Value k = jstring(j); jskip(j);
      if (j->pos<j->len && j->s[j->pos]==':') j->pos++; else { j->ok=0; break; }
      Value v = jvalue(j); if (!j->ok) break; map_set(m, k.str?k.str:"", v); jskip(j);
      if (j->pos<j->len && j->s[j->pos]==',') { j->pos++; continue; }
      if (j->pos<j->len && j->s[j->pos]=='}') { j->pos++; break; }
      j->ok=0; break;
    }
    return vmap(m);
  }
  if (c=='[') {
    j->pos++; SList *l = list_new(); jskip(j);
    if (j->pos<j->len && j->s[j->pos]==']') { j->pos++; return vlist(l); }
    for (;;) {
      Value v = jvalue(j); if (!j->ok) break; list_push(l, v); jskip(j);
      if (j->pos<j->len && j->s[j->pos]==',') { j->pos++; continue; }
      if (j->pos<j->len && j->s[j->pos]==']') { j->pos++; break; }
      j->ok=0; break;
    }
    return vlist(l);
  }
  if (c=='t') { if (j->pos+4<=j->len && strncmp(j->s+j->pos,"true",4)==0){ j->pos+=4; return vbool(1);} j->ok=0; return vnone(); }
  if (c=='f') { if (j->pos+5<=j->len && strncmp(j->s+j->pos,"false",5)==0){ j->pos+=5; return vbool(0);} j->ok=0; return vnone(); }
  if (c=='n') { if (j->pos+4<=j->len && strncmp(j->s+j->pos,"null",4)==0){ j->pos+=4; return vnone();} j->ok=0; return vnone(); }
  if (c=='-' || (c>='0'&&c<='9')) {
    int s0=j->pos; if (c=='-') j->pos++;
    while (j->pos<j->len) { char d=j->s[j->pos]; if ((d>='0'&&d<='9')||d=='.'||d=='e'||d=='E'||d=='+'||d=='-') j->pos++; else break; }
    char tmp[64]; int ln=j->pos-s0; if (ln>63) ln=63; memcpy(tmp,j->s+s0,ln); tmp[ln]=0; return vnum(atof(tmp));
  }
  j->ok=0; return vnone();
}
static Value parse_json(const char *text) {
  JParse j; j.s=text; j.pos=0; j.len=(int)strlen(text); j.ok=1; j.depth=0;
  Value v = jvalue(&j);
  jskip(&j);
  if (!j.ok || j.pos != j.len) return vnone();   /* malformed or trailing garbage -> nothing */
  return v;
}

/* ---- JSON writer: a Sprout value -> valid JSON text (round-trips through parse_json) ---- */
static int g_json_w_depth = 0;
static void json_escape(const char *s, char **o, size_t *c, size_t *l) {
  sb_add(o, c, l, "\"");
  for (const char *p = s ? s : ""; *p; p++) {
    unsigned char ch = (unsigned char)*p;
    switch (ch) {
      case '"':  sb_add(o, c, l, "\\\""); break;
      case '\\': sb_add(o, c, l, "\\\\"); break;
      case '\n': sb_add(o, c, l, "\\n"); break;
      case '\t': sb_add(o, c, l, "\\t"); break;
      case '\r': sb_add(o, c, l, "\\r"); break;
      case '\b': sb_add(o, c, l, "\\b"); break;
      case '\f': sb_add(o, c, l, "\\f"); break;
      default:
        if (ch < 0x20) { char u[8]; snprintf(u, sizeof u, "\\u%04x", ch); sb_add(o, c, l, u); }
        else { char one[2] = { (char)ch, 0 }; sb_add(o, c, l, one); }   /* UTF-8 bytes pass through */
    }
  }
  sb_add(o, c, l, "\"");
}
/* a number formatted to round-trip EXACTLY through parse_json: clean whole numbers, and the
   shortest decimal that reparses to the same double (num_to_str's %g is only 6 sig-figs, which
   would silently truncate a stored fraction so recall("x") * 3 != 1). */
static char *num_to_json(double n) {
  char buf[40];
  if (!isfinite(n)) return dup_str("null");                          /* JSON has no nan/inf (unreachable in Sprout) */
  if (n == (double)(long long)n && fabs(n) < 1e15) { snprintf(buf, sizeof buf, "%lld", (long long)n); return dup_str(buf); }
  for (int prec = 15; prec <= 17; prec++) { snprintf(buf, sizeof buf, "%.*g", prec, n); if (strtod(buf, NULL) == n) break; }
  return dup_str(buf);
}
static void to_json(Value v, char **o, size_t *c, size_t *l) {
  if (++g_json_w_depth > 200) { sb_add(o, c, l, "null"); g_json_w_depth--; return; }   /* match parse_json's depth cap (200) so output always round-trips */
  switch (v.type) {
    case V_NUM:  { char *t = num_to_json(v.num); sb_add(o, c, l, t); free(t); break; }
    case V_STR:  json_escape(v.str ? v.str : "", o, c, l); break;
    case V_BOOL: sb_add(o, c, l, v.boolean ? "true" : "false"); break;
    case V_LIST: sb_add(o, c, l, "["); for (int i = 0; v.list && i < v.list->n; i++) { if (i) sb_add(o, c, l, ","); to_json(v.list->items[i], o, c, l); } sb_add(o, c, l, "]"); break;
    case V_MAP:  sb_add(o, c, l, "{"); for (int i = 0; v.map && i < v.map->n; i++) { if (i) sb_add(o, c, l, ","); json_escape(v.map->keys[i], o, c, l); sb_add(o, c, l, ":"); to_json(v.map->vals[i], o, c, l); } sb_add(o, c, l, "}"); break;
    case V_TASK: sb_add(o, c, l, "null"); break;   /* tasks aren't data - they don't persist */
    default:     sb_add(o, c, l, "null"); break;   /* nothing */
  }
  g_json_w_depth--;
}
static char *value_to_json(Value v) { char *o = NULL; size_t c = 0, l = 0; g_json_w_depth = 0; to_json(v, &o, &c, &l); return o ? o : dup_str("null"); }

/* ---- persistence: a single per-folder key/value store, kept as JSON in sprout.data.json ---- */
#define SPROUT_STORE "sprout.data.json"
static SMap *store_load(void) {
  char *txt = read_whole_file(SPROUT_STORE);
  if (!txt) return map_new();
  Value v = parse_json(txt);
  if (v.type == V_MAP && v.map) { free(txt); return v.map; }
  /* the file exists but won't parse: keep a backup before starting fresh, so we never silently lose data */
  if (txt[0]) { FILE *b = fopen(SPROUT_STORE ".bak", "wb"); if (b) { fwrite(txt, 1, strlen(txt), b); fclose(b); } }
  free(txt);
  return map_new();
}
static int store_save(SMap *m) {
  char *json = value_to_json(vmap(m));
  FILE *f = fopen(SPROUT_STORE, "wb");
  if (!f) { free(json); return 0; }
  size_t jl = strlen(json), wrote = fwrite(json, 1, jl, f);
  fclose(f); free(json);
  return wrote == jl;
}

/* replace every occurrence of `find` in `s` with `repl` */
static char *str_replace_all(const char *s, const char *find, const char *repl) {
  if (!find || !*find) return dup_str(s);
  size_t fl=strlen(find), rl=strlen(repl), cap=strlen(s)+1, len=0;
  char *out=(char*)malloc(cap); const char *p=s;
  while (*p) {
    if (strncmp(p, find, fl)==0) { while (len+rl+1>cap){cap=cap*2+rl;out=(char*)realloc(out,cap);} memcpy(out+len,repl,rl); len+=rl; p+=fl; }
    else { if (len+2>cap){cap*=2;out=(char*)realloc(out,cap);} out[len++]=*p++; }
  }
  out[len]=0; return out;
}

/* flatten a value into "path = value" lines — the heart of explore() / `sprout api` */
static void explore_flatten(Value v, const char *prefix, SList *out, int depth) {
  if (depth > 256) { list_push(out, vstr_take(dup_str("... (too deeply nested)"))); return; }
  if (v.type == V_MAP && v.map && v.map->n > 0) {
    for (int i = 0; i < v.map->n; i++) {
      const char *k = v.map->keys[i];
      size_t need = strlen(prefix) + strlen(k) + 2;
      char *path = (char *)malloc(need);
      if (prefix[0]) snprintf(path, need, "%s.%s", prefix, k);
      else           snprintf(path, need, "%s", k);
      explore_flatten(v.map->vals[i], path, out, depth + 1);
      free(path);
    }
  } else if (v.type == V_LIST && v.list && v.list->n > 0) {
    for (int i = 0; i < v.list->n; i++) {
      size_t need = strlen(prefix) + 24;
      char *path = (char *)malloc(need);
      snprintf(path, need, "%s[%d]", prefix, i);
      explore_flatten(v.list->items[i], path, out, depth + 1);
      free(path);
    }
  } else {
    char *val = stringify(v);
    const char *p = prefix[0] ? prefix : "(value)";
    size_t need = strlen(p) + strlen(val) + 8;
    char *line = (char *)malloc(need);
    snprintf(line, need, "%s = %s", p, val);
    list_push(out, vstr_take(line));
  }
}

/* a deep, independent copy of a value (for the `copy` builtin). Lists/maps are SHARED references in
   Sprout, so `copy` is how you get a snapshot that later mutations of the original won't touch.
   Numbers/yes-no/nothing are value types already; text is immutable - all returned as-is. */
static int g_copy_depth = 0;
static Value deep_copy(Value v) {
  if (++g_copy_depth > 256) { g_copy_depth--; return vnone(); }   /* guard self-referential structures */
  Value r;
  if (v.type == V_LIST) {
    SList *l = list_new();
    for (int i = 0; v.list && i < v.list->n; i++) list_push(l, deep_copy(v.list->items[i]));
    r = vlist(l);
  } else if (v.type == V_MAP) {
    SMap *m = map_new();
    if (v.map) m->classname = v.map->classname;   /* a copied object keeps its type */
    for (int i = 0; v.map && i < v.map->n; i++) map_set(m, v.map->keys[i], deep_copy(v.map->vals[i]));
    r = vmap(m);
  } else {
    r = v;   /* numbers, yes/no, nothing are value types; text is immutable */
  }
  g_copy_depth--;
  return r;
}

/* sort comparator (the list is pre-checked to be all-numbers or all-text) */
static int value_cmp(const void *pa, const void *pb) {
  const Value *a = (const Value *)pa, *b = (const Value *)pb;
  if (a->type == V_NUM && b->type == V_NUM) return (a->num > b->num) - (a->num < b->num);
  if (a->type == V_STR && b->type == V_STR) return strcmp(a->str ? a->str : "", b->str ? b->str : "");
  return 0;
}

/* --sandbox (or the SPROUT_SANDBOX env var): for an online playground or any host that
   runs untrusted code, turn off every builtin that can touch the filesystem, a shell, or
   the network — otherwise a stranger's program gets file + shell + SSRF access to the host. */
static int g_sandbox = 0;
static char **g_prog_args = NULL; static int g_prog_nargs = 0;   /* the program's own CLI args, for args() */
static int builtin_blocked(const char *name) {
  static const char *const b[] = { "read", "write", "append", "exists",        /* filesystem */
                                   "remember", "recall", "forget",             /* on-disk store */
                                   "get", "explore",                           /* network */
                                   "env" };                                    /* host environment (may hold secrets) */
  for (size_t i = 0; i < sizeof b / sizeof *b; i++) if (!strcmp(name, b[i])) return 1;
  return 0;
}

/* ===================== a small regex engine (from scratch) =====================
   A byte-oriented backtracking matcher. Supports: literals, '.', '^'/'$', character
   classes [..] / [^..] with ranges, the shorthands \d \w \s \D \W \S, escapes
   (\. \\ \n \t ...), and greedy quantifiers * + ? and {n} / {n,} / {n,m}. (Groups (...)
   and alternation a|b are a planned follow-up.) A step budget bounds backtracking so a
   pathological pattern can never hang. Byte-oriented: '.' and classes match one byte,
   which is exactly right for ASCII patterns. */
#define RE_BUDGET 3000000L
#define RE_MAXGROUP 9
typedef struct { int s[RE_MAXGROUP+1], e[RE_MAXGROUP+1]; } RECaps;   /* match spans; [0] = whole match, [1..] = capture groups */

static void re_set_add(unsigned char *set, unsigned char ch) { set[ch >> 3] |= (unsigned char)(1u << (ch & 7)); }
static int  re_set_has(const unsigned char *set, unsigned char ch) { return (set[ch >> 3] >> (ch & 7)) & 1; }
static void re_set_range(unsigned char *set, unsigned a, unsigned b) { for (unsigned x = a; x <= b && x < 256; x++) re_set_add(set, (unsigned char)x); }

/* OR a \-shorthand's members into set; returns 1 if `e` was d/w/s/D/W/S, else 0. */
static int re_shorthand(unsigned char e, unsigned char *set) {
  unsigned char low = (e=='D'?'d':(e=='W'?'w':(e=='S'?'s':e)));
  if (low!='d' && low!='w' && low!='s') return 0;
  unsigned char tmp[32]; memset(tmp, 0, 32);
  if (low=='d') re_set_range(tmp,'0','9');
  else if (low=='w') { re_set_range(tmp,'a','z'); re_set_range(tmp,'A','Z'); re_set_range(tmp,'0','9'); re_set_add(tmp,'_'); }
  else { re_set_add(tmp,' '); re_set_add(tmp,'\t'); re_set_add(tmp,'\n'); re_set_add(tmp,'\r'); re_set_add(tmp,'\f'); re_set_add(tmp,'\v'); }
  if (e=='D'||e=='W'||e=='S') for (int i=0;i<32;i++) tmp[i] = (unsigned char)~tmp[i];   /* negate the shorthand */
  for (int i=0;i<32;i++) set[i] |= tmp[i];
  return 1;
}
static unsigned char re_escape_char(unsigned char e) {
  switch (e) { case 'n': return '\n'; case 't': return '\t'; case 'r': return '\r'; case 'f': return '\f'; case 'v': return '\v'; default: return e; }
}
/* The pattern compiles to a small tree. Each char of the pattern makes at most a few nodes,
   so a pool sized to a multiple of the pattern length never reallocates (keeping child
   pointers stable). Groups are numbered 1..9 by opening '('; a 10th+ group is non-capturing. */
typedef enum { RN_LIT, RN_ANY, RN_CLASS, RN_BOL, RN_EOL, RN_SEQ, RN_ALT, RN_GROUP, RN_REP } RNType;
typedef struct RENode {
  RNType t;
  unsigned char c;                  /* RN_LIT */
  unsigned char set[32]; int neg;   /* RN_CLASS */
  struct RENode **kids; int nkids;  /* RN_SEQ / RN_ALT */
  struct RENode *child;             /* RN_GROUP / RN_REP */
  int group, mn, mx;                /* RN_GROUP capture #; RN_REP repeat bounds */
} RENode;
typedef struct { RENode *nodes; int n, cap; } REProg;
static RENode *rn_alloc(REProg *g, RNType t) { RENode *n = &g->nodes[g->n++]; memset(n, 0, sizeof *n); n->t = t; return n; }

typedef struct { const char *p; int i; REProg *g; int ngroup; int ok; } REParse;
static RENode *re_parse_alt(REParse *s);

static RENode *re_parse_atom(REParse *s) {
  const char *p = s->p; int i = s->i; unsigned char c = (unsigned char)p[i]; RENode *n;
  if (c == '(') {
    s->i = i + 1;
    int grp = (s->ngroup < RE_MAXGROUP) ? ++s->ngroup : 0;          /* a 10th+ group is non-capturing */
    RENode *child = re_parse_alt(s);
    if (p[s->i] == ')') s->i++; else s->ok = 0;
    n = rn_alloc(s->g, RN_GROUP); n->group = grp; n->child = child; return n;
  }
  if (c == '.') { s->i = i + 1; return rn_alloc(s->g, RN_ANY); }
  if (c == '^') { s->i = i + 1; return rn_alloc(s->g, RN_BOL); }
  if (c == '$') { s->i = i + 1; return rn_alloc(s->g, RN_EOL); }
  if (c == '\\' && p[i + 1]) {
    unsigned char e = (unsigned char)p[i + 1];
    n = rn_alloc(s->g, RN_CLASS);
    if (re_shorthand(e, n->set)) { s->i = i + 2; return n; }
    n->t = RN_LIT; n->c = re_escape_char(e); s->i = i + 2; return n;   /* an escaped literal */
  }
  if (c == '[') {
    n = rn_alloc(s->g, RN_CLASS); int j = i + 1;
    if (p[j] == '^') { n->neg = 1; j++; }
    if (p[j] == ']') { re_set_add(n->set, ']'); j++; }                /* a leading ] is a literal */
    while (p[j] && p[j] != ']') {
      if (p[j] == '\\' && p[j + 1]) { unsigned char e = (unsigned char)p[j + 1]; if (re_shorthand(e, n->set)) j += 2; else { re_set_add(n->set, re_escape_char(e)); j += 2; } continue; }
      if (p[j + 1] == '-' && p[j + 2] && p[j + 2] != ']') { re_set_range(n->set, (unsigned char)p[j], (unsigned char)p[j + 2]); j += 3; continue; }
      re_set_add(n->set, (unsigned char)p[j]); j++;
    }
    if (p[j] == ']') j++;
    s->i = j; return n;
  }
  s->i = i + 1; n = rn_alloc(s->g, RN_LIT); n->c = c; return n;
}
static RENode *re_parse_quant(REParse *s) {
  RENode *atom = re_parse_atom(s);
  const char *p = s->p; int i = s->i; unsigned char q = (unsigned char)p[i];
  int mn = -1, mx = -1, kind = 0;
  if      (q == '*') { mn = 0; mx = 1 << 30; kind = 1; }
  else if (q == '+') { mn = 1; mx = 1 << 30; kind = 1; }
  else if (q == '?') { mn = 0; mx = 1;       kind = 1; }
  else if (q == '{') {
    int j = i + 1, lo = 0, nd = 0;
    while (p[j] >= '0' && p[j] <= '9') { lo = lo * 10 + (p[j] - '0'); j++; nd++; }
    int hi = lo;
    if (nd && p[j] == ',') { j++; if (p[j] >= '0' && p[j] <= '9') { hi = 0; while (p[j] >= '0' && p[j] <= '9') { hi = hi * 10 + (p[j] - '0'); j++; } } else hi = 1 << 30; }
    if (nd && p[j] == '}') { mn = lo; mx = hi; s->i = j + 1; kind = 2; }
  }
  if (kind == 1) s->i = i + 1;
  if (kind) { RENode *r = rn_alloc(s->g, RN_REP); r->child = atom; r->mn = mn; r->mx = mx; return r; }
  return atom;
}
static RENode *re_parse_seq(REParse *s) {
  RENode *seq = rn_alloc(s->g, RN_SEQ);
  RENode **kids = NULL; int n = 0, cap = 0;
  while (s->p[s->i] && s->p[s->i] != '|' && s->p[s->i] != ')') {
    RENode *item = re_parse_quant(s);
    if (n >= cap) { cap = cap ? cap * 2 : 8; kids = (RENode **)realloc(kids, cap * sizeof(RENode *)); }
    kids[n++] = item;
    if (!s->ok) break;
  }
  seq->kids = kids; seq->nkids = n; return seq;
}
static RENode *re_parse_alt(REParse *s) {
  RENode *first = re_parse_seq(s);
  if (s->p[s->i] != '|') return first;
  RENode *alt = rn_alloc(s->g, RN_ALT);
  RENode **kids = NULL; int n = 0, cap = 8; kids = (RENode **)realloc(kids, cap * sizeof(RENode *)); kids[n++] = first;
  while (s->p[s->i] == '|') {
    s->i++;
    RENode *seq = re_parse_seq(s);
    if (n >= cap) { cap *= 2; kids = (RENode **)realloc(kids, cap * sizeof(RENode *)); }
    kids[n++] = seq;
  }
  alt->kids = kids; alt->nkids = n; return alt;
}
static RENode *re_compile(const char *pat, REProg *prog, int *ngroups) {
  int patlen = (int)strlen(pat);
  prog->cap = patlen * 6 + 32; prog->n = 0;
  prog->nodes = (RENode *)malloc((size_t)prog->cap * sizeof(RENode));
  REParse s; s.p = pat; s.i = 0; s.g = prog; s.ngroup = 0; s.ok = 1;
  RENode *root = re_parse_alt(&s);
  *ngroups = s.ngroup;
  return root;
}
static void re_free(REProg *prog) {
  for (int i = 0; i < prog->n; i++) if (prog->nodes[i].kids) free(prog->nodes[i].kids);
  free(prog->nodes);
}
/* ---- continuation-passing matcher: walks the node tree, threading "what's left to match"
   as a small stack of RECont frames (so groups + alternation work). A step budget bounds
   backtracking; a zero-width repeat can't loop forever (the progress guard in re_rep). ---- */
typedef struct { const char *text; int tlen; RECaps *caps; long budget; } RECtx;
typedef struct RECont {
  int kind;                          /* 1 close-group, 2 repeat-continue, 3 seq-rest, 4 require-end */
  int group;                         /* kind 1 */
  RENode *rchild; int rcount, rmn, rmx, rfrom;   /* kind 2 */
  RENode **skids; int sidx, snkids;  /* kind 3 */
  struct RECont *next;
} RECont;
static int re_run(RENode *n, RECont *k, RECtx *cx, int ti);
static int re_rep(RENode *child, int mn, int mx, int count, int progress, RECont *k, RECtx *cx, int ti);
static int re_seq(RENode **kids, int idx, int nkids, RECont *k, RECtx *cx, int ti);

static int re_cont(RECont *k, RECtx *cx, int ti) {     /* run whatever still has to match after the current node */
  if (--cx->budget < 0) return -1;
  if (!k) return ti;                                   /* nothing left: the whole pattern matched, ending here */
  switch (k->kind) {
    case 1: { int save = cx->caps->e[k->group]; cx->caps->e[k->group] = ti; int r = re_cont(k->next, cx, ti); if (r < 0) cx->caps->e[k->group] = save; return r; }
    case 2: return re_rep(k->rchild, k->rmn, k->rmx, k->rcount, ti != k->rfrom, k->next, cx, ti);
    case 3: return re_seq(k->skids, k->sidx, k->snkids, k->next, cx, ti);
    case 4: return (ti == cx->tlen) ? re_cont(k->next, cx, ti) : -1;
  }
  return -1;
}
static int re_seq(RENode **kids, int idx, int nkids, RECont *k, RECtx *cx, int ti) {
  if (idx >= nkids) return re_cont(k, cx, ti);
  RECont cont; memset(&cont, 0, sizeof cont); cont.kind = 3; cont.skids = kids; cont.sidx = idx + 1; cont.snkids = nkids; cont.next = k;
  return re_run(kids[idx], &cont, cx, ti);
}
static int re_rep(RENode *child, int mn, int mx, int count, int progress, RECont *k, RECtx *cx, int ti) {
  if (--cx->budget < 0) return -1;
  if (count < mx && (count < mn || progress)) {        /* greedy: try one more, but never loop on a zero-width match */
    RECont cont; memset(&cont, 0, sizeof cont); cont.kind = 2; cont.rchild = child; cont.rcount = count + 1; cont.rmn = mn; cont.rmx = mx; cont.rfrom = ti; cont.next = k;
    int r = re_run(child, &cont, cx, ti);
    if (r >= 0) return r;
  }
  if (count >= mn) return re_cont(k, cx, ti);          /* enough repetitions: hand off to the continuation */
  return -1;
}
static int re_run(RENode *n, RECont *k, RECtx *cx, int ti) {
  if (--cx->budget < 0) return -1;
  switch (n->t) {
    case RN_LIT:   return (ti < cx->tlen && (unsigned char)cx->text[ti] == n->c) ? re_cont(k, cx, ti + 1) : -1;
    case RN_ANY:   return (ti < cx->tlen && cx->text[ti] != '\n') ? re_cont(k, cx, ti + 1) : -1;
    case RN_CLASS: { if (ti >= cx->tlen) return -1; int m = re_set_has(n->set, (unsigned char)cx->text[ti]); if (n->neg) m = !m; return m ? re_cont(k, cx, ti + 1) : -1; }
    case RN_BOL:   return (ti == 0) ? re_cont(k, cx, ti) : -1;
    case RN_EOL:   return (ti == cx->tlen) ? re_cont(k, cx, ti) : -1;
    case RN_SEQ:   return re_seq(n->kids, 0, n->nkids, k, cx, ti);
    case RN_ALT:   for (int i = 0; i < n->nkids; i++) { int r = re_run(n->kids[i], k, cx, ti); if (r >= 0) return r; } return -1;
    case RN_GROUP: {
      if (!n->group) return re_run(n->child, k, cx, ti);
      int ss = cx->caps->s[n->group], se = cx->caps->e[n->group];
      cx->caps->s[n->group] = ti;
      RECont close; memset(&close, 0, sizeof close); close.kind = 1; close.group = n->group; close.next = k;
      int r = re_run(n->child, &close, cx, ti);
      if (r < 0) { cx->caps->s[n->group] = ss; cx->caps->e[n->group] = se; }   /* undo a failed capture */
      return r;
    }
    case RN_REP:   return re_rep(n->child, n->mn, n->mx, 0, 1, k, cx, ti);
  }
  return -1;
}
static void re_caps_reset(RECaps *c) { for (int g = 0; g <= RE_MAXGROUP; g++) { c->s[g] = c->e[g] = -1; } }
/* does the WHOLE text match the pattern? (for `matches`) */
static int re_full(RENode *root, const char *text, int tlen, RECaps *caps) {
  RECtx cx; cx.text = text; cx.tlen = tlen; cx.caps = caps; cx.budget = RE_BUDGET;
  re_caps_reset(caps);
  RECont endk; memset(&endk, 0, sizeof endk); endk.kind = 4; endk.next = NULL;
  return re_run(root, &endk, &cx, 0) >= 0;
}
/* leftmost match at start >= from; on success fills caps (group 0 = whole match) and returns 1. */
static int re_search(RENode *root, const char *text, int from, int tlen, RECaps *caps) {
  RECtx cx; cx.text = text; cx.tlen = tlen; cx.caps = caps; cx.budget = RE_BUDGET;   /* ONE budget across all start positions, so find()/find_all() can't hang on a pathological pattern */
  for (int start = from; start <= tlen; start++) {
    re_caps_reset(caps);
    int r = re_run(root, NULL, &cx, start);
    if (r >= 0) { caps->s[0] = start; caps->e[0] = r; return 1; }
    if (cx.budget < 0) break;                                                        /* exhausted: give up rather than re-arm the budget at every start */
  }
  return 0;
}

static Value call_builtin(Expr *call, Env *env) {
  const char *name = call->name;
  int n = call->nargs;
  if (g_sandbox && builtin_blocked(name))
    failf(call->line, "'%s' is turned off in sandbox mode — file, shell, and network access are disabled here.", name);
  if (n > 16) fail(call->line, "that's too many inputs for a builtin.");
  Value a[16];
  for (int i = 0; i < n; i++) a[i] = eval(call->args[i], env);

  if (!strcmp(name, "range")) {
    if (n != 1 && n != 2) arity_error(call->line, "range", "1 or 2 numbers, like range(5) or range(2, 8)", n);
    want_num(call->line, "range", 1, a[0], "range(5)  or  range(2, 8)");
    if (n == 2) want_num(call->line, "range", 2, a[1], "range(2, 8)");
    long long start = (n == 2) ? (long long)a[0].num : 0;
    long long end   = (n == 2) ? (long long)a[1].num : (long long)a[0].num;
    if (end - start > 100000000LL) fail(call->line, "that range is too big.");
    SList *l = list_new();
    for (long long i = start; i < end; i++) list_push(l, vnum((double)i));
    return vlist(l);
  }
  if (!strcmp(name, "length")) {
    if (n != 1) arity_error(call->line, "length", "one thing (a list, a map, or text), like length(items)", n);
    if (a[0].type == V_LIST) return vnum(a[0].list ? a[0].list->n : 0);
    if (a[0].type == V_MAP)  return vnum(a[0].map ? a[0].map->n : 0);
    if (a[0].type == V_STR)  { const char *p = a[0].str ? a[0].str : ""; long long c = 0; for (int i = 0; p[i]; i += utf8_clen((unsigned char)p[i])) c++; return vnum((double)c); }
    arg_error(call->line, "length", 1, "a list, a map, or text", a[0], "length(items)");
  }
  if (!strcmp(name, "add")) {
    if (n != 2) arity_error(call->line, "add", "a list and a value, like add(things, 5)", n);
    want_list(call->line, "add", 1, a[0], "add(things, 5)");
    list_push(a[0].list, a[1]);
    return vnone();
  }
  if (!strcmp(name, "keys")) {
    if (n != 1) arity_error(call->line, "keys", "one map, like keys(person)", n);
    want_map(call->line, "keys", 1, a[0], "keys(person)");
    SList *l = list_new();
    for (int i = 0; a[0].map && i < a[0].map->n; i++) list_push(l, vstr_take(dup_str(a[0].map->keys[i])));
    return vlist(l);
  }
  if (!strcmp(name, "contains")) {
    if (n != 2) arity_error(call->line, "contains", "a collection and a value, like contains(items, x)", n);
    if (a[0].type == V_LIST) { for (int i = 0; a[0].list && i < a[0].list->n; i++) if (values_equal(a[0].list->items[i], a[1])) return vbool(1); return vbool(0); }
    if (a[0].type == V_MAP)  return vbool(a[1].type == V_STR && a[0].map && map_index(a[0].map, a[1].str) >= 0);
    if (a[0].type == V_STR && a[1].type == V_STR) return vbool(strstr(a[0].str ? a[0].str : "", a[1].str ? a[1].str : "") != NULL);
    arg_error(call->line, "contains", 1, "a list, a map, or text", a[0], "contains(items, x)");
  }
  if (!strcmp(name, "first")) {
    if (n != 1) arity_error(call->line, "first", "one list, like first(items)", n);
    want_list(call->line, "first", 1, a[0], "first(items)");
    if (!a[0].list || a[0].list->n == 0) fail(call->line, "first() needs a list with at least one item (this list is empty).");
    return a[0].list->items[0];
  }
  if (!strcmp(name, "last")) {
    if (n != 1) arity_error(call->line, "last", "one list, like last(items)", n);
    want_list(call->line, "last", 1, a[0], "last(items)");
    if (!a[0].list || a[0].list->n == 0) fail(call->line, "last() needs a list with at least one item (this list is empty).");
    return a[0].list->items[a[0].list->n - 1];
  }
  if (!strcmp(name, "remove")) {
    if (n != 2) arity_error(call->line, "remove", "a list + a position, or a map + a key", n);
    if (a[0].type == V_LIST) {
      if (!a[0].list) fail(call->line, "remove's first input must be a list.");
      if (a[1].type != V_NUM || a[1].num != (double)(long long)a[1].num) arg_error(call->line, "remove", 2, "a whole-number position", a[1], "remove(items, 0)");
      long long i = (long long)a[1].num;
      if (i < 0 || i >= a[0].list->n) { char m[180]; if (a[0].list->n == 0) snprintf(m, sizeof m, "remove: the list is empty, so there's no position %lld to remove.", i); else snprintf(m, sizeof m, "remove: position %lld doesn't exist \xE2\x80\x94 the list has %d item%s (valid positions are 0 to %d).", i, a[0].list->n, a[0].list->n == 1 ? "" : "s", a[0].list->n - 1); fail_kind(call->line, "index", m); }
      Value gone = a[0].list->items[i];
      for (long long k = i; k < a[0].list->n - 1; k++) a[0].list->items[k] = a[0].list->items[k + 1];
      a[0].list->n--;
      return gone;                                   /* hands back what was removed (pop) */
    }
    if (a[0].type == V_MAP) {
      if (a[1].type != V_STR) arg_error(call->line, "remove", 2, "text (a map key)", a[1], "remove(person, \"name\")");
      if (!a[0].map) return vnone();
      int i = map_index(a[0].map, a[1].str);
      if (i < 0) return vnone();
      Value gone = a[0].map->vals[i];
      free(a[0].map->keys[i]);
      for (int k = i; k < a[0].map->n - 1; k++) { a[0].map->keys[k] = a[0].map->keys[k + 1]; a[0].map->vals[k] = a[0].map->vals[k + 1]; }
      a[0].map->n--;
      map_reindex(a[0].map);                          /* positions shifted, so rebuild the hash index */
      return gone;
    }
    arg_error(call->line, "remove", 1, "a list or a map", a[0], "remove(items, 0)  or  remove(person, \"name\")");
  }
  if (!strcmp(name, "insert")) {
    if (n != 3) arity_error(call->line, "insert", "a list, a position, and a value, like insert(items, 0, x)", n);
    want_list(call->line, "insert", 1, a[0], "insert(items, 0, x)");
    if (a[1].type != V_NUM || a[1].num != (double)(long long)a[1].num) arg_error(call->line, "insert", 2, "a whole-number position", a[1], "insert(items, 0, x)");
    long long i = (long long)a[1].num;
    if (i < 0 || i > a[0].list->n) { char m[180]; snprintf(m, sizeof m, "insert: position %lld is out of range \xE2\x80\x94 you can insert at 0 to %d (the list has %d item%s).", i, a[0].list->n, a[0].list->n, a[0].list->n == 1 ? "" : "s"); fail_kind(call->line, "index", m); }
    list_push(a[0].list, vnone());                   /* grow by one, then shift up */
    for (long long k = a[0].list->n - 1; k > i; k--) a[0].list->items[k] = a[0].list->items[k - 1];
    a[0].list->items[i] = a[2];
    return vnone();
  }
  if (!strcmp(name, "sort")) {
    if (n != 1) arity_error(call->line, "sort", "one list, like sort(items)", n);
    want_list(call->line, "sort", 1, a[0], "sort(items)");
    SList *l = a[0].list;
    if (l && l->n > 1) {
      VType t = l->items[0].type;
      if (t != V_NUM && t != V_STR) fail_kind(call->line, "type", "sort works on a list of numbers or a list of text.");
      for (int i = 1; i < l->n; i++) if (l->items[i].type != t) fail_kind(call->line, "type", "sort needs every item to be the same kind (all numbers, or all text).");
      qsort(l->items, l->n, sizeof(Value), value_cmp);
    }
    return a[0];                                     /* sorted in place; returned so show sort(xs) works */
  }
  if (!strcmp(name, "sort_by")) {                    /* sort a list by the value a task gives for each item */
    if (n != 2) arity_error(call->line, "sort_by", "a list and a task, like sort_by(people, get_score)", n);
    want_list(call->line, "sort_by", 1, a[0], "sort_by(people, get_score)");
    want_task(call->line, "sort_by", 2, a[1], "sort_by(people, get_score)");
    SList *l = a[0].list;
    if (l && l->n > 1) {
      Value *keys = (Value *)malloc((size_t)l->n * sizeof(Value));   /* each item's sort key, computed once */
      for (int i = 0; i < l->n; i++) keys[i] = call_task_v(a[1].task, &l->items[i], 1, call->line);
      VType t = keys[0].type;
      if (t != V_NUM && t != V_STR) { free(keys); fail_kind(call->line, "type", "sort_by's task must give a number or text to sort by."); }
      for (int i = 1; i < l->n; i++) if (keys[i].type != t) { free(keys); fail_kind(call->line, "type", "sort_by's task must give the same kind of value for every item."); }
      for (int i = 1; i < l->n; i++) {               /* stable insertion sort, ascending, by key */
        Value ki = keys[i], vi = l->items[i]; int j = i - 1;
        while (j >= 0) {
          int c = (t == V_NUM) ? ((keys[j].num > ki.num) - (keys[j].num < ki.num))
                               : strcmp(keys[j].str ? keys[j].str : "", ki.str ? ki.str : "");
          if (c <= 0) break;                          /* '<=' keeps equal keys in their original order */
          keys[j + 1] = keys[j]; l->items[j + 1] = l->items[j]; j--;
        }
        keys[j + 1] = ki; l->items[j + 1] = vi;
      }
      free(keys);
    }
    return a[0];                                     /* sorted in place (ascending); use reverse() for descending */
  }
  if (!strcmp(name, "reverse")) {
    if (n != 1) arity_error(call->line, "reverse", "one list, like reverse(items)", n);
    want_list(call->line, "reverse", 1, a[0], "reverse(items)");
    SList *l = a[0].list;
    for (int i = 0, j = l->n - 1; i < j; i++, j--) { Value t = l->items[i]; l->items[i] = l->items[j]; l->items[j] = t; }
    return a[0];
  }
  if (!strcmp(name, "index_of")) {
    if (n != 2) arity_error(call->line, "index_of", "a list + a value, or text + a piece of text", n);
    if (a[0].type == V_LIST) { for (int i = 0; a[0].list && i < a[0].list->n; i++) if (values_equal(a[0].list->items[i], a[1])) return vnum(i); return vnone(); }
    if (a[0].type == V_STR && a[1].type == V_STR) {
      const char *h = a[0].str ? a[0].str : "", *needle = a[1].str ? a[1].str : "";
      const char *at = strstr(h, needle);
      if (!at) return vnone();
      long long ci = 0; for (const char *p = h; p < at; ) { p += utf8_clen((unsigned char)*p); ci++; }   /* byte -> char index */
      return vnum((double)ci);
    }
    arg_error(call->line, "index_of", 1, "a list, or text (with text)", a[0], "index_of(items, x)  or  index_of(\"hello\", \"ll\")");
  }
  if (!strcmp(name, "values")) {
    if (n != 1) arity_error(call->line, "values", "one map, like values(person)", n);
    want_map(call->line, "values", 1, a[0], "values(person)");
    SList *l = list_new();
    for (int i = 0; a[0].map && i < a[0].map->n; i++) list_push(l, a[0].map->vals[i]);
    return vlist(l);
  }
  if (!strcmp(name, "copy")) { if (n != 1) arity_error(call->line, "copy", "one value, like copy(items)", n); return deep_copy(a[0]); }
  if (!strcmp(name, "kind_of")) {   /* a simple, switchable type tag for beginners: when kind_of(x) == "number": ... */
    if (n != 1) arity_error(call->line, "kind_of", "one value, like kind_of(x)", n);
    const char *k = "nothing";
    switch (a[0].type) { case V_NUM: k="number"; break; case V_STR: k="text"; break; case V_BOOL: k="yes-no"; break; case V_LIST: k="list"; break; case V_MAP: k=(a[0].map && a[0].map->classname) ? a[0].map->classname : "map"; break; case V_TASK: k="task"; break; default: k="nothing"; }
    return vstr_take(dup_str(k));
  }
  if (!strcmp(name, "is_a")) {   /* is this object that type, or a descendant of it? (like Java's instanceof) */
    if (n != 2) arity_error(call->line, "is_a", "a value and a type name, like is_a(d, \"Animal\")", n);
    want_str(call->line, "is_a", 2, a[1], "is_a(d, \"Animal\")");
    if (a[0].type != V_MAP || !a[0].map || !a[0].map->classname) return vbool(0);
    TypeReg *t = type_find(a[0].map->classname);
    return vbool(t && type_is_a(t, a[1].str ? a[1].str : ""));
  }
  /* ---- higher-order: run a task over a list (the "easy data" trio + each) ---- */
  if (!strcmp(name, "map")) {
    if (n != 2) arity_error(call->line, "map", "a list and a task, like map(names, shout)", n);
    want_list(call->line, "map", 1, a[0], "map(names, shout)");
    want_task(call->line, "map", 2, a[1], "map(names, shout)");
    SList *out = list_new(); int len = a[0].list ? a[0].list->n : 0;   /* snapshot length: a mutating task can't extend the loop */
    for (int i = 0; i < len; i++) { Value arg = a[0].list->items[i]; list_push(out, call_task_v(a[1].task, &arg, 1, call->line)); }
    return vlist(out);
  }
  if (!strcmp(name, "filter")) {
    if (n != 2) arity_error(call->line, "filter", "a list and a task that gives yes/no, like filter(nums, is_even)", n);
    want_list(call->line, "filter", 1, a[0], "filter(nums, is_even)");
    want_task(call->line, "filter", 2, a[1], "filter(nums, is_even)");
    SList *out = list_new(); int len = a[0].list ? a[0].list->n : 0;
    for (int i = 0; i < len; i++) { Value item = a[0].list->items[i]; if (is_truthy(call_task_v(a[1].task, &item, 1, call->line))) list_push(out, item); }
    return vlist(out);
  }
  if (!strcmp(name, "reduce")) {
    if (n != 3) arity_error(call->line, "reduce", "a list, a task taking (total, item), and a start value, like reduce(nums, add_up, 0)", n);
    want_list(call->line, "reduce", 1, a[0], "reduce(nums, add_up, 0)");
    want_task(call->line, "reduce", 2, a[1], "reduce(nums, add_up, 0)");
    Value acc = a[2]; int len = a[0].list ? a[0].list->n : 0;
    for (int i = 0; i < len; i++) { Value two[2] = { acc, a[0].list->items[i] }; acc = call_task_v(a[1].task, two, 2, call->line); }
    return acc;
  }
  if (!strcmp(name, "group_by")) {   /* group items into a map; the task gives each item's key (used as text) */
    if (n != 2) arity_error(call->line, "group_by", "a list and a task that gives each item's key, like group_by(people, get_city)", n);
    want_list(call->line, "group_by", 1, a[0], "group_by(people, get_city)");
    want_task(call->line, "group_by", 2, a[1], "group_by(people, get_city)");
    SMap *m = map_new(); int len = a[0].list ? a[0].list->n : 0;
    for (int i = 0; i < len; i++) {
      Value item = a[0].list->items[i];
      char *ks = stringify(call_task_v(a[1].task, &item, 1, call->line));
      int idx = map_index(m, ks);
      if (idx < 0) { map_set(m, ks, vlist(list_new())); idx = map_index(m, ks); }
      list_push(m->vals[idx].list, item);
      free(ks);
    }
    return vmap(m);
  }
  if (!strcmp(name, "min_by") || !strcmp(name, "max_by")) {   /* the item whose key (from the task) is smallest / largest */
    int wantmax = (name[1] == 'a');
    if (n != 2) arity_error(call->line, name, "a list and a task that gives a key, like min_by(people, get_age)", n);
    want_list(call->line, name, 1, a[0], "min_by(people, get_age)");
    want_task(call->line, name, 2, a[1], "min_by(people, get_age)");
    int len = a[0].list ? a[0].list->n : 0;
    if (len == 0) return vnone();
    Value best = a[0].list->items[0], bk = call_task_v(a[1].task, &best, 1, call->line);
    if (bk.type != V_NUM && bk.type != V_STR) fail_kind(call->line, "type", "min_by/max_by's task must give a number or text.");
    for (int i = 1; i < len; i++) {
      Value item = a[0].list->items[i], k = call_task_v(a[1].task, &item, 1, call->line);
      if (k.type != bk.type) fail_kind(call->line, "type", "min_by/max_by's task must give the same kind of value for every item.");
      int c = (bk.type == V_NUM) ? ((k.num > bk.num) - (k.num < bk.num)) : strcmp(k.str ? k.str : "", bk.str ? bk.str : "");
      if (wantmax ? (c > 0) : (c < 0)) { best = item; bk = k; }
    }
    return best;
  }
  if (!strcmp(name, "partition")) {   /* split a list into [matches, rest] by a yes/no task */
    if (n != 2) arity_error(call->line, "partition", "a list and a task that gives yes/no, like partition(nums, is_even)", n);
    want_list(call->line, "partition", 1, a[0], "partition(nums, is_even)");
    want_task(call->line, "partition", 2, a[1], "partition(nums, is_even)");
    SList *yes = list_new(), *no = list_new(); int len = a[0].list ? a[0].list->n : 0;
    for (int i = 0; i < len; i++) { Value item = a[0].list->items[i]; if (is_truthy(call_task_v(a[1].task, &item, 1, call->line))) list_push(yes, item); else list_push(no, item); }
    SList *pair = list_new(); list_push(pair, vlist(yes)); list_push(pair, vlist(no));
    return vlist(pair);
  }
  if (!strcmp(name, "chunk")) {   /* split a list into pieces of at most `size` items */
    if (n != 2) arity_error(call->line, "chunk", "a list and a size, like chunk(items, 3)", n);
    want_list(call->line, "chunk", 1, a[0], "chunk(items, 3)");
    want_num(call->line, "chunk", 2, a[1], "chunk(items, 3)");
    int size = (int)a[1].num;
    if (size < 1) { char m[120]; snprintf(m, sizeof m, "chunk's size must be at least 1, but you gave %d.", size); fail(call->line, m); }
    SList *out = list_new(); int len = a[0].list ? a[0].list->n : 0; SList *cur = NULL;
    for (int i = 0; i < len; i++) { if (i % size == 0) { cur = list_new(); list_push(out, vlist(cur)); } list_push(cur, a[0].list->items[i]); }
    return vlist(out);
  }
  /* ---- collection batteries ---- */
  if (!strcmp(name, "sum")) {
    if (n != 1) arity_error(call->line, "sum", "one list of numbers, like sum([1, 2, 3])", n);
    want_list(call->line, "sum", 1, a[0], "sum([1, 2, 3])");
    double s = 0;
    for (int i = 0; a[0].list && i < a[0].list->n; i++) { if (a[0].list->items[i].type != V_NUM) { char m[240], d[96]; val_describe(a[0].list->items[i], d, sizeof d); if (a[0].list->items[i].type == V_NONE) snprintf(m, sizeof m, "sum needs every item to be a number, but item %d is nothing \xE2\x80\x94 a 'nothing' here usually means a map key that doesn't exist (a typo?) or a value that was never set.", i + 1); else snprintf(m, sizeof m, "sum needs every item to be a number, but item %d is %s.", i + 1, d); fail_kind(call->line, "type", m); } s += a[0].list->items[i].num; }
    return vnum(s);
  }
  if (!strcmp(name, "count")) {
    if (n != 2) arity_error(call->line, "count", "a list + a value, or text + a piece of text", n);
    if (a[0].type == V_LIST) { int c = 0; for (int i = 0; a[0].list && i < a[0].list->n; i++) if (values_equal(a[0].list->items[i], a[1])) c++; return vnum(c); }
    if (a[0].type == V_STR && a[1].type == V_STR) { const char *h = a[0].str ? a[0].str : "", *ndl = a[1].str ? a[1].str : ""; if (!*ndl) return vnum(0); int c = 0; const char *p = h; while ((p = strstr(p, ndl))) { c++; p += strlen(ndl); } return vnum(c); }
    arg_error(call->line, "count", 1, "a list, or text (with text)", a[0], "count(items, x)  or  count(\"banana\", \"a\")");
  }
  if (!strcmp(name, "unique")) {
    if (n != 1) arity_error(call->line, "unique", "one list, like unique(items)", n);
    want_list(call->line, "unique", 1, a[0], "unique(items)");
    SList *out = list_new();
    for (int i = 0; a[0].list && i < a[0].list->n; i++) { int dup = 0; for (int j = 0; j < out->n; j++) if (values_equal(out->items[j], a[0].list->items[i])) { dup = 1; break; } if (!dup) list_push(out, a[0].list->items[i]); }
    return vlist(out);
  }
  if (!strcmp(name, "zip")) {
    if (n != 2) arity_error(call->line, "zip", "two lists, like zip(names, scores)", n);
    want_list(call->line, "zip", 1, a[0], "zip(names, scores)");
    want_list(call->line, "zip", 2, a[1], "zip(names, scores)");
    SList *out = list_new(); int la = a[0].list ? a[0].list->n : 0, lb = a[1].list ? a[1].list->n : 0, m = la < lb ? la : lb;
    for (int i = 0; i < m; i++) { SList *pair = list_new(); list_push(pair, a[0].list->items[i]); list_push(pair, a[1].list->items[i]); list_push(out, vlist(pair)); }
    return vlist(out);
  }
  if (!strcmp(name, "flatten")) {   /* one level deep */
    if (n != 1) arity_error(call->line, "flatten", "one list, like flatten(nested)", n);
    want_list(call->line, "flatten", 1, a[0], "flatten(nested)");
    SList *out = list_new();
    for (int i = 0; a[0].list && i < a[0].list->n; i++) { Value it = a[0].list->items[i]; if (it.type == V_LIST) { for (int j = 0; it.list && j < it.list->n; j++) list_push(out, it.list->items[j]); } else list_push(out, it); }
    return vlist(out);
  }
  if (!strcmp(name, "slice")) {     /* start inclusive, end exclusive (like other languages); clamped */
    if (n != 3) arity_error(call->line, "slice", "a list-or-text and two positions, like slice(xs, 1, 3)", n);
    want_num(call->line, "slice", 2, a[1], "slice(xs, 1, 3)");
    want_num(call->line, "slice", 3, a[2], "slice(xs, 1, 3)");
    if (a[1].num != (double)(long long)a[1].num) arg_error(call->line, "slice", 2, "a whole number", a[1], "slice(xs, 1, 3)");
    if (a[2].num != (double)(long long)a[2].num) arg_error(call->line, "slice", 3, "a whole number", a[2], "slice(xs, 1, 3)");
    long long s = (long long)a[1].num, e = (long long)a[2].num; if (s < 0) s = 0; if (e < 0) e = 0;
    if (a[0].type == V_LIST) {
      int len = a[0].list ? a[0].list->n : 0; if (e > len) e = len; SList *out = list_new();
      for (long long i = s; i < e; i++) list_push(out, a[0].list->items[i]);
      return vlist(out);
    }
    if (a[0].type == V_STR) {        /* by UTF-8 character index */
      const char *p = a[0].str ? a[0].str : ""; size_t cap = 0, ln = 0; char *out = NULL; long long idx = 0;
      for (int i = 0; p[i]; idx++) {
        int cl = utf8_clen((unsigned char)p[i]); int k = 0; while (k < cl && p[i + k]) k++;   /* ACTUAL bytes (capped at the terminator) - never advance past it */
        if (idx >= s && idx < e) { char ch[5]; for (int j = 0; j < k; j++) ch[j] = p[i + j]; ch[k] = 0; sb_add(&out, &cap, &ln, ch); }
        i += k ? k : 1;
      }
      return vstr_take(out ? out : dup_str(""));
    }
    arg_error(call->line, "slice", 1, "a list or text", a[0], "slice(items, 1, 3)");
  }
  /* ---- text batteries ---- */
  if (!strcmp(name, "pad_start") || !strcmp(name, "pad_end")) {   /* pad text to a width with a fill (default space) */
    if (n<2 || n>3) arity_error(call->line, name, "text, a width, and an optional fill: pad_start(\"7\", 3, \"0\")", n);
    want_num(call->line, name, 2, a[1], "pad_start(\"7\", 3, \"0\")");
    if (n==3) want_str(call->line, name, 3, a[2], "pad_start(\"7\", 3, \"0\")");
    if (a[1].num < 0 || a[1].num != floor(a[1].num) || a[1].num > 1e8) fail_kind(call->line, "value", "pad width must be a whole number from 0 to 100000000.");
    char *owned = (a[0].type == V_STR) ? NULL : stringify(a[0]);   /* a number/list/etc. is shown the same way `show`/`+` would */
    const char *s = owned ? owned : (a[0].str?a[0].str:""); int slen = (int)strlen(s); int width = (int)a[1].num;
    const char *fill = (n==3 && a[2].str && a[2].str[0]) ? a[2].str : " "; int flen = (int)strlen(fill);
    if (width <= slen) { Value rv = vstr(s); free(owned); return rv; }
    int padn = width - slen; char *out = (char*)malloc((size_t)width + 1); int b = 0; int atStart = (name[4]=='s');
    if (atStart) { for (int k=0;k<padn;k++) out[b++]=fill[k%flen]; memcpy(out+b,s,(size_t)slen); b+=slen; }
    else { memcpy(out,s,(size_t)slen); b=slen; for (int k=0;k<padn;k++) out[b++]=fill[k%flen]; }
    out[b]=0; Value rv = vstr_take(out); free(owned); return rv;
  }
  if (!strcmp(name, "words")) {
    want_one_str(call->line, "words", n, a, "words(sentence)");
    const char *p = a[0].str ? a[0].str : ""; SList *out = list_new();
    while (*p) {
      while (*p == ' ' || *p == '\t' || *p == '\n' || *p == '\r') p++;
      if (!*p) break;
      const char *st = p; while (*p && *p != ' ' && *p != '\t' && *p != '\n' && *p != '\r') p++;
      int ln = (int)(p - st); char *w = (char *)malloc(ln + 1); memcpy(w, st, ln); w[ln] = 0; list_push(out, vstr_take(w));
    }
    return vlist(out);
  }
  if (!strcmp(name, "lines")) {     /* split on newlines; a trailing newline does not add an empty line; "" -> [] */
    want_one_str(call->line, "lines", n, a, "lines(text)");
    const char *p = a[0].str ? a[0].str : ""; SList *out = list_new();
    if (*p) { const char *st = p; for (;;) {
        if (*p == '\n' || *p == 0) { int ln = (int)(p - st); if (ln > 0 && st[ln - 1] == '\r') ln--; char *w = (char *)malloc(ln + 1); memcpy(w, st, ln); w[ln] = 0; list_push(out, vstr_take(w)); if (!*p) break; p++; st = p; if (!*p) break; }
        else p++;
    } }
    return vlist(out);
  }
  if (!strcmp(name, "title")) {     /* Title Case: first letter of each word upper, rest lower (ASCII, like upper/lower) */
    want_one_str(call->line, "title", n, a, "title(name)");
    const char *p = a[0].str ? a[0].str : ""; size_t ln = strlen(p); char *out = (char *)malloc(ln + 1); int at_start = 1;
    for (size_t i = 0; i < ln; i++) { char c = p[i]; if (c == ' ' || c == '\t' || c == '\n' || c == '\r') { out[i] = c; at_start = 1; } else { out[i] = at_start ? (char)toupper((unsigned char)c) : (char)tolower((unsigned char)c); at_start = 0; } }
    out[ln] = 0; return vstr_take(out);
  }
  if (!strcmp(name, "seed")) {      /* make random() reproducible */
    want_one_num(call->line, "seed", n, a, "seed(42)");
    srand((unsigned)a[0].num);
    return vnone();
  }
  if (!strcmp(name, "pow")) {
    if (n != 2) arity_error(call->line, "pow", "two numbers, like pow(2, 10)", n);
    want_num(call->line, "pow", 1, a[0], "pow(2, 10)");
    want_num(call->line, "pow", 2, a[1], "pow(2, 10)");
    double r = pow(a[0].num, a[1].num);
    if (!isfinite(r)) fail_kind(call->line, "math", "pow can't compute that (a negative base with a fractional power, a zero base with a negative power, or a result too large to hold).");
    return vnum(r);
  }
  if (!strcmp(name, "starts_with")) { if (n != 2) arity_error(call->line, "starts_with", "two pieces of text, like starts_with(name, \"Dr\")", n); want_str(call->line, "starts_with", 1, a[0], "starts_with(name, \"Dr\")"); want_str(call->line, "starts_with", 2, a[1], "starts_with(name, \"Dr\")"); const char *h = a[0].str ? a[0].str : "", *p = a[1].str ? a[1].str : ""; return vbool(strncmp(h, p, strlen(p)) == 0); }
  if (!strcmp(name, "ends_with"))   { if (n != 2) arity_error(call->line, "ends_with", "two pieces of text, like ends_with(file, \".txt\")", n); want_str(call->line, "ends_with", 1, a[0], "ends_with(file, \".txt\")"); want_str(call->line, "ends_with", 2, a[1], "ends_with(file, \".txt\")");   const char *h = a[0].str ? a[0].str : "", *p = a[1].str ? a[1].str : ""; size_t hl = strlen(h), pl = strlen(p); return vbool(pl <= hl && strcmp(h + hl - pl, p) == 0); }
  /* ---- numbers ---- */
  if (!strcmp(name, "abs"))   { want_one_num(call->line,"abs",n,a,"abs(x)");   return vnum(fabs(a[0].num)); }
  if (!strcmp(name, "round")) {
    if (n<1||n>2) arity_error(call->line,"round","a number and optionally decimal places, like round(3.14159, 2)",n);
    want_num(call->line,"round",1,a[0],"round(3.14159, 2)");
    if (n==2) want_num(call->line,"round",2,a[1],"round(3.14159, 2)");
    if (n==1) return vnum(round(a[0].num));                       /* round half away from zero (no floor(x+0.5) double-rounding) */
    double m = pow(10.0, (int)a[1].num);
    double r = round(a[0].num * m) / m;
    return vnum(isfinite(r) ? r : a[0].num);                      /* absurd precision (m overflows/underflows) -> a no-op, never nan */
  }
  if (!strcmp(name, "clamp")) { if(n!=3) arity_error(call->line,"clamp","three numbers: clamp(x, low, high)",n); want_num(call->line,"clamp",1,a[0],"clamp(x, 0, 100)"); want_num(call->line,"clamp",2,a[1],"clamp(x, 0, 100)"); want_num(call->line,"clamp",3,a[2],"clamp(x, 0, 100)"); double x=a[0].num,lo=a[1].num,hi=a[2].num; return vnum(x<lo?lo:(x>hi?hi:x)); }
  if (!strcmp(name, "sign"))  { want_one_num(call->line,"sign",n,a,"sign(x)"); double x=a[0].num; return vnum(x>0?1:(x<0?-1:0)); }
  if (!strcmp(name, "format")) {   /* a number as text with EXACTLY N decimal places: format(159.6, 2) -> "159.60" (for money/columns) */
    if (n!=2) arity_error(call->line,"format","a number and decimal places, like format(3.14159, 2)",n);
    want_num(call->line,"format",1,a[0],"format(3.14159, 2)");
    want_num(call->line,"format",2,a[1],"format(3.14159, 2)");
    if (a[1].num < 0 || a[1].num != floor(a[1].num) || a[1].num > 30) fail_kind(call->line,"value","format's decimal places must be a whole number from 0 to 30.");
    char buf[400]; snprintf(buf, sizeof buf, "%.*f", (int)a[1].num, a[0].num);
    return vstr_take(dup_str(buf));
  }
  if (!strcmp(name, "floor")) { want_one_num(call->line,"floor",n,a,"floor(x)"); return vnum(floor(a[0].num)); }
  if (!strcmp(name, "ceil"))  { want_one_num(call->line,"ceil",n,a,"ceil(x)");  return vnum(ceil(a[0].num)); }
  if (!strcmp(name, "sqrt"))  { want_one_num(call->line,"sqrt",n,a,"sqrt(x)"); if (a[0].num<0) fail_kind(call->line,"math","sqrt can't take a negative number."); return vnum(sqrt(a[0].num)); }
  if (!strcmp(name, "sin"))   { want_one_num(call->line,"sin",n,a,"sin(radians)");  return vnum(sin(a[0].num)); }
  if (!strcmp(name, "cos"))   { want_one_num(call->line,"cos",n,a,"cos(radians)");  return vnum(cos(a[0].num)); }
  if (!strcmp(name, "tan"))   { want_one_num(call->line,"tan",n,a,"tan(radians)");  return vnum(tan(a[0].num)); }
  if (!strcmp(name, "exp"))   { want_one_num(call->line,"exp",n,a,"exp(x)"); double r=exp(a[0].num); if(!isfinite(r)) fail_kind(call->line,"math","exp overflowed — that result is too big to hold."); return vnum(r); }
  if (!strcmp(name, "log"))   {   /* natural log; log(x, base) for any base */
    if (n!=1 && n!=2) arity_error(call->line,"log","a number and an optional base: log(x) or log(x, base)",n);
    want_num(call->line,"log",1,a[0],"log(x)  or  log(x, base)");
    if (n==2) want_num(call->line,"log",2,a[1],"log(x, base)");
    if (a[0].num <= 0) fail_kind(call->line,"math","log needs a positive number.");
    if (n==2) { if (a[1].num<=0 || a[1].num==1) fail_kind(call->line,"math","a logarithm base must be positive and not 1."); return vnum(log(a[0].num)/log(a[1].num)); }
    return vnum(log(a[0].num));
  }
  if (!strcmp(name, "pi"))    { if (n!=0) arity_error(call->line,"pi","no inputs, like pi()",n); return vnum(3.14159265358979323846); }
  if (!strcmp(name, "args"))  { if (n!=0) arity_error(call->line,"args","no inputs, like args()",n); SList *l=list_new(); for (int i=0;i<g_prog_nargs;i++) list_push(l, vstr(g_prog_args[i])); return vlist(l); }
  if (!strcmp(name, "exit"))  { if (n>1) arity_error(call->line,"exit","an optional exit code, like exit(0) or exit(1)",n); if (n==1) want_num(call->line,"exit",1,a[0],"exit(0)"); exit(n==1 ? (int)a[0].num : 0); }
  if (!strcmp(name, "env"))   {   /* read an environment variable; off in --sandbox (may hold secrets) */
    if (n<1 || n>2) arity_error(call->line,"env","a name and an optional default: env(\"HOME\") or env(\"PORT\", \"8080\")",n);
    want_str(call->line,"env",1,a[0],"env(\"HOME\")");
    const char *v = getenv(a[0].str ? a[0].str : "");
    if (v) return vstr(v);
    return n==2 ? a[1] : vnone();
  }
  if (!strcmp(name, "matches")) {   /* does the WHOLE text match the regex pattern? */
    if (n!=2) arity_error(call->line,"matches","text and a pattern, like matches(name, \"[a-z]+\")",n);
    want_str(call->line,"matches",1,a[0],"matches(name, \"[a-z]+\")");
    want_str(call->line,"matches",2,a[1],"matches(name, \"[a-z]+\")");
    const char *s = a[0].str?a[0].str:"", *p = a[1].str?a[1].str:"";
    REProg prog; int ng; RENode *root = re_compile(p, &prog, &ng); RECaps caps;
    int ok = re_full(root, s, (int)strlen(s), &caps);
    re_free(&prog);
    return vbool(ok);
  }
  if (!strcmp(name, "find")) {      /* the first substring matching the pattern, or nothing */
    if (n!=2) arity_error(call->line,"find","text and a pattern, like find(s, \"[0-9]+\")",n);
    want_str(call->line,"find",1,a[0],"find(s, \"[0-9]+\")");
    want_str(call->line,"find",2,a[1],"find(s, \"[0-9]+\")");
    const char *s = a[0].str?a[0].str:"", *p = a[1].str?a[1].str:"";
    REProg prog; int ng; RENode *root = re_compile(p, &prog, &ng); RECaps caps;
    Value rv = vnone();
    if (re_search(root, s, 0, (int)strlen(s), &caps)) {
      int mb=caps.s[0], me=caps.e[0];
      char *buf = (char*)malloc((size_t)(me-mb)+1); memcpy(buf, s+mb, (size_t)(me-mb)); buf[me-mb]=0;
      rv = vstr_take(buf);
    }
    re_free(&prog);
    return rv;
  }
  if (!strcmp(name, "find_all")) {  /* every non-overlapping match, as a list of text */
    if (n!=2) arity_error(call->line,"find_all","text and a pattern, like find_all(s, \"[0-9]+\")",n);
    want_str(call->line,"find_all",1,a[0],"find_all(s, \"[0-9]+\")");
    want_str(call->line,"find_all",2,a[1],"find_all(s, \"[0-9]+\")");
    const char *s = a[0].str?a[0].str:"", *p = a[1].str?a[1].str:"";
    REProg prog; int ng; RENode *root = re_compile(p, &prog, &ng); RECaps caps;
    int tlen = (int)strlen(s); SList *l = list_new(); int pos = 0;
    while (pos <= tlen && re_search(root, s, pos, tlen, &caps)) {
      int mb=caps.s[0], me=caps.e[0];
      char *buf = (char*)malloc((size_t)(me-mb)+1); memcpy(buf, s+mb, (size_t)(me-mb)); buf[me-mb]=0;
      list_push(l, vstr_take(buf));
      pos = (me > mb) ? me : mb + 1;
    }
    re_free(&prog);
    return vlist(l);
  }
  if (!strcmp(name, "captures")) {  /* first match as [whole, group1, group2, ...]; a group that didn't match is nothing */
    if (n!=2) arity_error(call->line,"captures","text and a pattern, like captures(s, \"([0-9]+)-([0-9]+)\")",n);
    want_str(call->line,"captures",1,a[0],"captures(s, \"(\\\\d+)\")");
    want_str(call->line,"captures",2,a[1],"captures(s, \"(\\\\d+)\")");
    const char *s = a[0].str?a[0].str:"", *p = a[1].str?a[1].str:"";
    REProg prog; int ng; RENode *root = re_compile(p, &prog, &ng); RECaps caps;
    Value rv = vnone();
    if (re_search(root, s, 0, (int)strlen(s), &caps)) {
      SList *l = list_new();
      for (int g=0; g<=ng; g++) {
        if (caps.s[g] >= 0 && caps.e[g] >= caps.s[g]) { int len=caps.e[g]-caps.s[g]; char *buf=(char*)malloc((size_t)len+1); memcpy(buf, s+caps.s[g], (size_t)len); buf[len]=0; list_push(l, vstr_take(buf)); }
        else list_push(l, vnone());
      }
      rv = vlist(l);
    }
    re_free(&prog);
    return rv;
  }
  if (!strcmp(name, "min") || !strcmp(name, "max")) {
    if (n<1) arity_error(call->line, name, "at least one number, like min(3, 7) or min([3, 7])", n);
    double best=0; int set=0; int wantMin = (name[1]=='i');
    for (int i=0;i<n;i++){ if(a[i].type!=V_NUM){ char m[160], d[96]; val_describe(a[i], d, sizeof d); snprintf(m, sizeof m, "%s works on numbers, but input %d is %s.", name, i+1, d); fail_kind(call->line,"type",m); } if(!set||(wantMin?a[i].num<best:a[i].num>best)){best=a[i].num;set=1;} }
    return vnum(best);
  }
  if (!strcmp(name, "random")) {
    if (n==0) return vnum((double)rand()/((double)RAND_MAX+1.0));
    if (n==1 && a[0].type==V_NUM) { long long hi=(long long)a[0].num; if(hi<=0) return vnum(0); return vnum((double)(rand()%hi)); }
    if (n==2 && a[0].type==V_NUM && a[1].type==V_NUM) { long long lo=(long long)a[0].num,hi=(long long)a[1].num; if(hi<lo){long long t=lo;lo=hi;hi=t;} return vnum((double)(lo+rand()%(hi-lo+1))); }
    fail(call->line,"random() gives 0..1; random(n) or random(a,b) give whole numbers.");
  }
  if (!strcmp(name, "number")) {
    if (n!=1) arity_error(call->line,"number","one input, like number(\"42\")",n);
    if (a[0].type==V_NUM) return a[0];
    if (a[0].type==V_STR) {
      const char*p=a[0].str?a[0].str:"";
      while(*p==' '||*p=='\t'||*p=='\n'||*p=='\r')p++;
      if(*p!='+'&&*p!='-'&&*p!='.'&&!(*p>='0'&&*p<='9')) return vnone();   /* reject inf/nan/text */
      if(p[0]=='0'&&(p[1]=='x'||p[1]=='X')) return vnone();                /* reject hex */
      char*end; double d=strtod(p,&end);
      while(*end==' '||*end=='\t'||*end=='\n'||*end=='\r')end++;
      if(end!=p && *end==0 && isfinite(d)) return vnum(d);
    }
    return vnone();
  }
  if (!strcmp(name,"is_number")) {                  /* yes if number() would parse this as a number */
    if (n!=1) arity_error(call->line,"is_number","one input, like is_number(\"42\")",n);
    if (a[0].type==V_NUM) return vbool(1);
    if (a[0].type!=V_STR) return vbool(0);
    const char*p=a[0].str?a[0].str:"";
    while(*p==' '||*p=='\t'||*p=='\n'||*p=='\r')p++;
    if(*p!='+'&&*p!='-'&&*p!='.'&&!(*p>='0'&&*p<='9')) return vbool(0);
    if(p[0]=='0'&&(p[1]=='x'||p[1]=='X')) return vbool(0);
    char*end; double d=strtod(p,&end);
    while(*end==' '||*end=='\t'||*end=='\n'||*end=='\r')end++;
    return vbool(end!=p && *end==0 && isfinite(d));
  }
  if (!strcmp(name,"code")) {                        /* code("A") -> 65 — the first character's byte value */
    want_one_str(call->line,"code",n,a,"code(\"A\")");
    const char*s=a[0].str?a[0].str:"";
    if(!s[0]) fail_kind(call->line,"value","code needs at least one character, but the text is empty.");
    return vnum((double)(unsigned char)s[0]);
  }
  if (!strcmp(name,"char")) {                        /* char(65) -> "A" — a one-character string from a byte value */
    want_one_num(call->line,"char",n,a,"char(65)");
    int code=(int)a[0].num;
    if(code<1||code>255) fail_kind(call->line,"value","char needs a number from 1 to 255 (Sprout text can't hold a zero byte).");
    char buf[2]={(char)code,0}; return vstr_take(dup_str(buf));
  }
  /* ---- text ---- */
  if (!strcmp(name,"upper")||!strcmp(name,"lower")) {
    want_one_str(call->line, name, n, a, "upper(text)");
    char *s=dup_str(a[0].str?a[0].str:""); int up=(name[0]=='u');
    for (char*p=s;*p;p++) *p = up ? (char)toupper((unsigned char)*p) : (char)tolower((unsigned char)*p);
    return vstr_take(s);
  }
  if (!strcmp(name,"trim")) {
    want_one_str(call->line,"trim",n,a,"trim(text)");
    const char*p=a[0].str?a[0].str:""; while(*p==' '||*p=='\t'||*p=='\n'||*p=='\r')p++;
    int e=(int)strlen(p); while(e>0&&(p[e-1]==' '||p[e-1]=='\t'||p[e-1]=='\n'||p[e-1]=='\r'))e--;
    char*s=(char*)malloc(e+1); memcpy(s,p,e); s[e]=0; return vstr_take(s);
  }
  if (!strcmp(name,"replace")) {
    if (n!=3) arity_error(call->line,"replace","three pieces of text: replace(text, find, with)",n);
    want_str(call->line,"replace",1,a[0],"replace(text, \"a\", \"b\")");
    want_str(call->line,"replace",2,a[1],"replace(text, \"a\", \"b\")");
    want_str(call->line,"replace",3,a[2],"replace(text, \"a\", \"b\")");
    return vstr_take(str_replace_all(a[0].str?a[0].str:"", a[1].str?a[1].str:"", a[2].str?a[2].str:""));
  }
  if (!strcmp(name,"split")) {
    if (n!=2) arity_error(call->line,"split","text and a separator, like split(csv, \",\")",n);
    want_str(call->line,"split",1,a[0],"split(csv, \",\")");
    want_str(call->line,"split",2,a[1],"split(csv, \",\")");
    const char*s=a[0].str?a[0].str:""; const char*sep=a[1].str?a[1].str:""; SList*l=list_new();
    if (!*sep) { for(int i=0;s[i];){int cl=utf8_clen((unsigned char)s[i]);char ch[5];int k=0;for(;k<cl&&s[i+k];k++)ch[k]=s[i+k];ch[k]=0;list_push(l,vstr_take(dup_str(ch)));i+=k?k:1;} return vlist(l); }
    size_t sl=strlen(sep); const char*start=s;
    for(;;){ const char*hit=strstr(start,sep); if(!hit){ list_push(l,vstr_take(dup_str(start))); break; } int ln=(int)(hit-start); char*part=(char*)malloc(ln+1); memcpy(part,start,ln); part[ln]=0; list_push(l,vstr_take(part)); start=hit+sl; }
    return vlist(l);
  }
  if (!strcmp(name,"join")) {
    if (n!=2) arity_error(call->line,"join","a list and a separator, like join(items, \", \")",n);
    want_list(call->line,"join",1,a[0],"join(items, \", \")");
    const char*sep=(a[1].type==V_STR&&a[1].str)?a[1].str:""; size_t cap=0,len=0; char*out=NULL;
    for(int i=0;a[0].list&&i<a[0].list->n;i++){ if(i) sb_add(&out,&cap,&len,sep); char*t=stringify(a[0].list->items[i]); sb_add(&out,&cap,&len,t); }
    if(!out) out=dup_str("");
    return vstr_take(out);
  }
  /* ---- input ---- */
  if (!strcmp(name,"ask")) {
    if (n>=1 && a[0].type==V_STR) { fputs(a[0].str?a[0].str:"", stdout); fflush(stdout); }
    char line[4096]; if (!fgets(line,sizeof line,stdin)) return vnone();
    size_t L=strlen(line); while(L&&(line[L-1]=='\n'||line[L-1]=='\r')) line[--L]=0;
    return vstr_take(dup_str(line));
  }
  /* ---- time ---- */
  if (!strcmp(name,"now")||!strcmp(name,"today")) {
    time_t tt=time(NULL); struct tm*lt=localtime(&tt); char buf[64];
    if (name[0]=='n') strftime(buf,sizeof buf,"%Y-%m-%d %H:%M:%S",lt); else strftime(buf,sizeof buf,"%Y-%m-%d",lt);
    return vstr_take(dup_str(buf));
  }
  if (!strcmp(name,"time")) {   /* the current moment as a number: seconds since 1970 (the Unix epoch) */
    if (n!=0) arity_error(call->line,"time","no inputs, like time()",n);
    return vnum((double)time(NULL));
  }
  if (!strcmp(name,"days"))    { want_one_num(call->line,"days",n,a,"days(7)");    return vnum(a[0].num*86400.0); }
  if (!strcmp(name,"hours"))   { want_one_num(call->line,"hours",n,a,"hours(3)");  return vnum(a[0].num*3600.0); }
  if (!strcmp(name,"minutes")) { want_one_num(call->line,"minutes",n,a,"minutes(30)"); return vnum(a[0].num*60.0); }
  if (!strcmp(name,"time_parts")) {   /* break a timestamp into a map of named parts */
    want_one_num(call->line,"time_parts",n,a,"time_parts(time())");
    time_t tt=(time_t)a[0].num; struct tm*lt=localtime(&tt);
    if (!lt) fail_kind(call->line,"math","that timestamp is out of range.");
    static const char*const wd[]={"Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"};
    SMap*m=map_new();
    map_set(m,"year",vnum(lt->tm_year+1900)); map_set(m,"month",vnum(lt->tm_mon+1)); map_set(m,"day",vnum(lt->tm_mday));
    map_set(m,"hour",vnum(lt->tm_hour)); map_set(m,"minute",vnum(lt->tm_min)); map_set(m,"second",vnum(lt->tm_sec));
    map_set(m,"weekday",vstr(wd[lt->tm_wday%7]));
    return vmap(m);
  }
  if (!strcmp(name,"time_make")) {   /* build a timestamp from year, month, day [, hour, minute, second] */
    if (n<3||n>6) arity_error(call->line,"time_make","year, month, day (and optionally hour, minute, second)",n);
    for (int i=0;i<n;i++) if (a[i].type!=V_NUM) arg_error(call->line,"time_make",i+1,"a number",a[i],"time_make(2026, 12, 25)");
    struct tm t; memset(&t,0,sizeof t);
    t.tm_year=(int)a[0].num-1900; t.tm_mon=(int)a[1].num-1; t.tm_mday=(int)a[2].num;
    t.tm_hour=n>3?(int)a[3].num:0; t.tm_min=n>4?(int)a[4].num:0; t.tm_sec=n>5?(int)a[5].num:0; t.tm_isdst=-1;
    time_t tt=mktime(&t);
    if (tt==(time_t)-1) fail_kind(call->line,"math","that date can't be made (check the numbers).");
    return vnum((double)tt);
  }
  if (!strcmp(name,"time_format")) {   /* a timestamp as readable text: YYYY-MM-DD HH:MM:SS */
    want_one_num(call->line,"time_format",n,a,"time_format(time())");
    time_t tt=(time_t)a[0].num; struct tm*lt=localtime(&tt);
    if (!lt) fail_kind(call->line,"math","that timestamp is out of range.");
    char buf[64]; strftime(buf,sizeof buf,"%Y-%m-%d %H:%M:%S",lt);
    return vstr_take(dup_str(buf));
  }
  if (!strcmp(name,"wait")) {
    want_one_num(call->line,"wait",n,a,"wait(2)");
    if (a[0].num>0) {
#ifdef _WIN32
      Sleep((DWORD)(a[0].num*1000));
#else
      struct timespec ts; ts.tv_sec=(time_t)a[0].num; ts.tv_nsec=(long)((a[0].num-(double)(time_t)a[0].num)*1e9); nanosleep(&ts,NULL);
#endif
    }
    return vnone();
  }
  /* ---- files ---- */
  if (!strcmp(name,"read")) {
    want_one_str(call->line,"read",n,a,"read(\"notes.txt\")");
    char*c=read_whole_file(a[0].str?a[0].str:""); return c ? vstr_take(c) : vnone();
  }
  if (!strcmp(name,"write")||!strcmp(name,"append")) {
    if (n!=2) arity_error(call->line, name, "a file name and some text, like write(\"f.txt\", \"hi\")", n);
    want_str(call->line, name, 1, a[0], "write(\"f.txt\", \"hi\")");
    FILE*f=fopen(a[0].str?a[0].str:"", name[0]=='a'?"ab":"wb"); if(!f) fail_kind(call->line,"io","I couldn't open that file to write.");
    char*t=stringify(a[1]); fwrite(t,1,strlen(t),f); fclose(f); return vnone();
  }
  if (!strcmp(name,"exists")) {
    want_one_str(call->line,"exists",n,a,"exists(\"notes.txt\")");
    FILE*f=fopen(a[0].str?a[0].str:"","rb"); if(f){fclose(f);return vbool(1);} return vbool(0);
  }
  /* ---- persistence: remember/recall/forget across runs (a key/value store in sprout.data.json) ---- */
  if (!strcmp(name,"remember")) {
    if (n != 2) arity_error(call->line, "remember", "a name (text) and a value, like remember(\"score\", 10)", n);
    want_str(call->line, "remember", 1, a[0], "remember(\"score\", 10)");
    SMap *m = store_load();
    map_set(m, a[0].str ? a[0].str : "", a[1]);
    if (!store_save(m)) fail_kind(call->line, "io", "I couldn't save to the data file (sprout.data.json).");
    return vnone();
  }
  if (!strcmp(name,"recall")) {
    want_one_str(call->line,"recall",n,a,"recall(\"score\")");
    SMap *m = store_load();
    int i = map_index(m, a[0].str ? a[0].str : "");
    return i >= 0 ? deep_copy(m->vals[i]) : vnone();   /* missing -> nothing; deep_copy so the result is independent of the store */
  }
  if (!strcmp(name,"forget")) {
    want_one_str(call->line, "forget", n, a, "forget(\"score\")");
    SMap *m = store_load();
    int i = map_index(m, a[0].str ? a[0].str : "");
    if (i < 0) return vbool(0);                   /* nothing to forget */
    free(m->keys[i]);
    for (int k = i; k < m->n - 1; k++) { m->keys[k] = m->keys[k + 1]; m->vals[k] = m->vals[k + 1]; }
    m->n--;
    map_reindex(m);                               /* positions shifted, so rebuild the hash index (mirrors remove) */
    if (!store_save(m)) fail_kind(call->line, "io", "I couldn't save to the data file (sprout.data.json).");
    return vbool(1);
  }
  /* ---- the superpowers: web, json, shell ---- */
  if (!strcmp(name,"get")) {
    want_one_str(call->line, "get", n, a, "get(\"https://...\")");
    char*body=http_get(a[0].str?a[0].str:""); return body ? vstr_take(body) : vnone();
  }
  if (!strcmp(name,"json")) {
    want_one_str(call->line, "json", n, a, "json(text)");
    return parse_json(a[0].str?a[0].str:"");
  }
  /* `run` moved into the system module: use system  ->  system.run("...") */
  if (!strcmp(name,"run")) fail(call->line, "run now lives in the system module.\n\n  Put 'use system' at the top, then call:  system.run(\"echo hi\")");
  /* ---- discovery + color ---- */
  if (!strcmp(name,"explore")) {
    if (n!=1) arity_error(call->line, "explore", "one thing, like explore(json(get(url)))", n);
    Value v = a[0];
    if (v.type == V_STR) { Value parsed = parse_json(v.str?v.str:""); if (parsed.type==V_MAP || parsed.type==V_LIST) v = parsed; }
    SList *out = list_new();
    explore_flatten(v, "", out, 0);
    return vlist(out);
  }
  if (!strcmp(name,"color")) {
    if (n!=2) arity_error(call->line, "color", "a color name and text, like color(\"red\", \"hi\")", n);
    want_str(call->line, "color", 1, a[0], "color(\"red\", \"hi\")");
    want_str(call->line, "color", 2, a[1], "color(\"red\", \"hi\")");
    const char *cn=a[0].str?a[0].str:""; const char *code=NULL;
    if      (!strcmp(cn,"red"))    code="31";
    else if (!strcmp(cn,"green"))  code="32";
    else if (!strcmp(cn,"yellow")) code="33";
    else if (!strcmp(cn,"blue"))   code="34";
    else if (!strcmp(cn,"magenta")||!strcmp(cn,"purple")) code="35";
    else if (!strcmp(cn,"cyan"))   code="36";
    else if (!strcmp(cn,"white"))  code="37";
    else if (!strcmp(cn,"gray")||!strcmp(cn,"grey")) code="90";
    else if (!strcmp(cn,"bold"))   code="1";
    else if (!strcmp(cn,"dim"))    code="2";
    else fail(call->line,"unknown color. Try: red green yellow blue magenta cyan white gray bold dim.");
    const char *t=a[1].str?a[1].str:""; size_t need=strlen(t)+16; char*out=(char*)malloc(need);
    snprintf(out,need,"\x1b[%sm%s\x1b[0m",code,t); return vstr_take(out);
  }

  {
    char msg[400]; const char *sug = suggest_name(name, NULL, 0);
    if (sug) snprintf(msg, sizeof msg, "I don't know a task or function called '%s'.\n\n  Did you mean '%s'?", name, sug);
    else snprintf(msg, sizeof msg, "I don't know a task or function called '%s'.", name);
    fail_hard(call->line, "name", msg);
  }
  return vnone();
}

/* every arithmetic result passes through here, so a number is never silently inf/nan (Sprout's
   invariant): an overflow/non-finite outcome becomes a clean, catchable math error instead. */
static double check_finite(double d, int line) {
  if (!isfinite(d)) fail_kind(line, "math", "that number is too big to hold (it overflowed).");
  return d;
}
/* +, -, *, /, % on two values (shared by binary expressions and compound 'set x += ...') */
static Value apply_arith(TokType op, Value l, Value r, int line) {
  if (op == T_PLUS) {
    if (l.type == V_LIST && r.type == V_LIST) {        /* list concatenation: [1, 2] + [3, 4] -> [1, 2, 3, 4] */
      SList *out = list_new();
      for (int i = 0; l.list && i < l.list->n; i++) list_push(out, l.list->items[i]);
      for (int i = 0; r.list && i < r.list->n; i++) list_push(out, r.list->items[i]);
      return vlist(out);
    }
    if (l.type == V_MAP && r.type == V_MAP && !l.map->classname && !r.map->classname) {   /* map merge: right side wins on shared keys */
      SMap *out = map_new();
      for (int i = 0; l.map && i < l.map->n; i++) map_set(out, l.map->keys[i], l.map->vals[i]);
      for (int i = 0; r.map && i < r.map->n; i++) map_set(out, r.map->keys[i], r.map->vals[i]);
      return vmap(out);
    }
    if (l.type == V_STR || r.type == V_STR) { char *a = stringify(l), *b = stringify(r); char *out = (char *)malloc(strlen(a) + strlen(b) + 1); strcpy(out, a); strcat(out, b); Value rv = vstr_take(out); free(a); free(b); return rv; }
    if (l.type == V_NUM && r.type == V_NUM) return vnum(check_finite(l.num + r.num, line));
    { char buf[320]; const char *nn = (l.type==V_NONE||r.type==V_NONE) ? "\n\n  A 'nothing' here usually means a map key that doesn't exist (a typo?) or a value that was never set." : "\n\n  '+' adds two numbers or joins text \xE2\x80\x94 convert one first, e.g.  number(x)  or  \"\" + x."; snprintf(buf, sizeof buf, "I can't add %s and %s.%s", type_name(l), type_name(r), nn); fail_kind(line, "type", buf); }
  }
  if (op == T_STAR && (l.type == V_STR || r.type == V_STR)) {        /* text * n  ->  repeated text:  "=" * 40 */
    Value s = (l.type == V_STR) ? l : r, k = (l.type == V_STR) ? r : l;
    if (k.type != V_NUM || k.num < 0 || k.num != floor(k.num) || k.num > 1e8) fail_kind(line, "type", "to repeat text, multiply it by a whole number from 0 to 100000000, like \"ab\" * 3.");
    size_t times = (size_t)k.num; const char *src = s.str ? s.str : ""; size_t sl = strlen(src);
    char *out = (char *)malloc(sl * times + 1);
    if (!out) fail(line, "that repeated text is too large to build.");
    for (size_t i = 0; i < times; i++) memcpy(out + i * sl, src, sl);
    out[sl * times] = 0; return vstr_take(out);
  }
  if (op == T_STAR && (l.type == V_LIST || r.type == V_LIST)) {      /* list * n  ->  repeated list:  [0] * 10 */
    Value ls = (l.type == V_LIST) ? l : r, k = (l.type == V_LIST) ? r : l;
    if (k.type != V_NUM || k.num < 0 || k.num != floor(k.num) || k.num > 1e8) fail_kind(line, "type", "to repeat a list, multiply it by a whole number from 0 to 100000000, like [0] * 3.");
    long long times = (long long)k.num; SList *out = list_new();
    for (long long i = 0; i < times; i++) for (int j = 0; ls.list && j < ls.list->n; j++) list_push(out, ls.list->items[j]);
    return vlist(out);
  }
  if (l.type != V_NUM || r.type != V_NUM) { const char *ow = (op==T_MINUS)?"subtract":(op==T_STAR)?"multiply":(op==T_SLASH)?"divide":"take the remainder of"; const char *nn = (l.type==V_NONE||r.type==V_NONE) ? "  A 'nothing' here usually means a missing map key (a typo?) or an unset value." : ""; char buf[300]; snprintf(buf, sizeof buf, "I can't %s %s and %s \xE2\x80\x94 that needs two numbers.%s", ow, type_name(l), type_name(r), nn); fail_kind(line, "type", buf); }
  if (op == T_MINUS) return vnum(check_finite(l.num - r.num, line));
  if (op == T_STAR)  return vnum(check_finite(l.num * r.num, line));
  if (r.num == 0) fail_kind(line, "math", op == T_SLASH ? "you tried to divide by zero." : "you tried to take a remainder with zero.");
  return vnum(check_finite(op == T_SLASH ? l.num / r.num : fmod(l.num, r.num), line));
}

static Value eval_binary(Expr *e, Env *env) {
  Value l = eval(e->left, env), r = eval(e->right, env);
  switch (e->op) {
    case T_PLUS: case T_MINUS: case T_STAR: case T_SLASH: case T_PERCENT: {
      const char *opm = (e->op==T_PLUS)?"plus":(e->op==T_MINUS)?"minus":(e->op==T_STAR)?"multiply":(e->op==T_SLASH)?"divide":"modulo";
      TaskDef *om = type_op_method(l, opm);            /* a type overloads + - * / % via plus/minus/multiply/divide/modulo */
      if (om) { Value argv[2] = { l, r }; return call_task_v(om, argv, 2, e->line); }
      return apply_arith(e->op, l, r, e->line);
    }
    case T_LT: case T_LE: case T_GT: case T_GE: {
      int cmp;
      TaskDef *cm = type_op_method(l, "compare");      /* a type orders itself via compare(self, other) -> number */
      if (cm) {
        Value argv[2] = { l, r };
        Value cv = call_task_v(cm, argv, 2, e->line);
        if (cv.type != V_NUM) fail_kind(e->line, "type", "compare(self, other) must give a number (< 0, 0, or > 0).");
        cmp = (cv.num < 0) ? -1 : (cv.num > 0) ? 1 : 0;
      }
      else if (l.type == V_NUM && r.type == V_NUM) cmp = (l.num < r.num) ? -1 : (l.num > r.num) ? 1 : 0;
      else if (l.type == V_STR && r.type == V_STR) cmp = strcmp(l.str, r.str);
      else { char buf[256]; snprintf(buf, sizeof buf, "I can't compare %s with %s \xE2\x80\x94 I compare two numbers or two pieces of text (or a type with a compare method).", type_name(l), type_name(r)); fail_kind(e->line, "type", buf); return vnone(); }
      if (e->op == T_LT) return vbool(cmp < 0);
      if (e->op == T_LE) return vbool(cmp <= 0);
      if (e->op == T_GT) return vbool(cmp > 0);
      return vbool(cmp >= 0);
    }
    case T_EQEQ: case T_BANGEQ: {
      TaskDef *em = type_op_method(l, "equals");       /* a type defines equals(self, other) -> yes/no */
      int eq = em ? is_truthy(call_task_v(em, (Value[]){ l, r }, 2, e->line)) : values_equal(l, r);
      return vbool(e->op == T_EQEQ ? eq : !eq);
    }
    case T_IN:    /* `x in xs` — membership: list item, map key, or substring of text */
      if (r.type == V_LIST) { for (int i = 0; r.list && i < r.list->n; i++) if (values_equal(l, r.list->items[i])) return vbool(1); return vbool(0); }
      if (r.type == V_MAP)  return vbool(l.type == V_STR && r.map && map_index(r.map, l.str ? l.str : "") >= 0);
      if (r.type == V_STR)  { if (l.type != V_STR) fail_kind(e->line, "type", "to test text membership, the left side of 'in' must be text too."); return vbool(strstr(r.str ? r.str : "", l.str ? l.str : "") != NULL); }
      fail_kind(e->line, "type", "'in' needs a list, a map, or text on the right (like:  x in things)."); return vnone();
    default: fail(e->line, "unknown operator."); return vnone();
  }
  return vnone();
}

/* the built-in `system` module: OS-level, explicit (use system) actions like system.run(...) */
static Value call_system(Expr *e, Env *env) {
  if (g_sandbox) fail(e->line, "the 'system' module is turned off in sandbox mode — no shell access here.");
  if (!strcmp(e->name, "run")) {
    if (e->nargs != 1) fail(e->line, "system.run needs one piece of text, like system.run(\"echo hi\").");
    Value a = eval(e->args[0], env);
    if (a.type != V_STR) fail(e->line, "system.run needs text (the command to run).");
    char *out = run_command(a.str ? a.str : "");
    return out ? vstr_take(out) : vnone();
  }
  { char m[200]; snprintf(m, sizeof m, "the system module has no '%s' (it has: run).", e->name); fail(e->line, m); }
  return vnone();
}

/* a namespaced call:  server.start(...)  or  system.run(...)  */
/* ============================ types: classes of objects ============================
   `type Point:` defines a class. An instance is just a map (SMap) whose `classname` is the
   type name; its fields are the map's entries, so field get/set reuse the [ ] machinery.
   A method is a task whose first parameter is the receiver (by convention, `self`). */
struct TypeReg { char *name; char *parent; int fileid; char **fields; Expr **defaults; int nfields; TaskDef *methods; int nmethods; };
static TypeReg *g_types = NULL; static int g_ntypes = 0, g_captypes = 0;

static TypeReg *type_find(const char *name) {
  for (int i = 0; i < g_ntypes; i++) if (!strcmp(g_types[i].name, name)) return &g_types[i];
  return NULL;
}
/* find a method by name, looking up the inheritance chain (child overrides parent). */
static TaskDef *type_method(TypeReg *t, const char *name) {
  for (int i = 0; i < t->nmethods; i++) if (!strcmp(t->methods[i].name, name)) return &t->methods[i];
  if (t->parent) { TypeReg *p = type_find(t->parent); if (p) return type_method(p, name); }
  return NULL;
}
/* is `t` the type `name`, or does it inherit from it? (for is_a / instanceof) */
static int type_is_a(TypeReg *t, const char *name) {
  for (TypeReg *cur = t; cur; cur = cur->parent ? type_find(cur->parent) : NULL)
    if (!strcmp(cur->name, name)) return 1;
  return 0;
}
/* register a `type`: record its fields, and build a TaskDef for each method. */
static void type_register(Stmt *s, int fileid, Env *home) {
  if (type_find(s->name)) failf(s->line, "there are two types named '%s'.", s->name);
  if (g_ntypes >= g_captypes) { g_captypes = g_captypes ? g_captypes * 2 : 8; g_types = (TypeReg *)realloc(g_types, g_captypes * sizeof(TypeReg)); }
  TypeReg *t = &g_types[g_ntypes++];
  t->name = s->name; t->parent = s->name2; t->fileid = fileid; t->fields = s->params; t->defaults = s->values; t->nfields = s->nparams;
  t->nmethods = s->nbody;
  t->methods = s->nbody ? (TaskDef *)calloc((size_t)s->nbody, sizeof(TaskDef)) : NULL;
  for (int i = 0; i < s->nbody; i++) {
    Stmt *m = s->body[i];
    t->methods[i].name = m->name; t->methods[i].params = m->params; t->methods[i].nparams = m->nparams;
    t->methods[i].body = m->body; t->methods[i].nbody = m->nbody; t->methods[i].line = m->line;
    t->methods[i].is_public = 0; t->methods[i].fileid = fileid; t->methods[i].home = home; t->methods[i].file_env = home; t->methods[i].owner_type = t->name;
  }
}
/* total number of fields, including those inherited from ancestors. */
static int type_field_count(TypeReg *t) {
  int n = t->nfields;
  if (t->parent) { TypeReg *p = type_find(t->parent); if (p) n += type_field_count(p); }
  return n;
}
/* bind the constructor args (then defaults) to the fields — ancestors' fields first. */
static void type_bind_fields(TypeReg *t, Expr *call, Env *env, SMap *m, int *argi) {
  if (t->parent) {
    TypeReg *p = type_find(t->parent);
    if (!p) { char mm[200]; snprintf(mm, sizeof mm, "type '%s' inherits from unknown type '%s' (is it spelled right, and defined?).", t->name, t->parent); fail(call->line, mm); return; }
    type_bind_fields(p, call, env, m, argi);
  }
  for (int i = 0; i < t->nfields; i++) {
    Value fv;
    if (*argi < call->nargs) { fv = eval(call->args[*argi], env); (*argi)++; }
    else if (t->defaults[i]) fv = eval(t->defaults[i], env);
    else { char mm[200]; snprintf(mm, sizeof mm, "%s needs a value for '%s'.", t->name, t->fields[i]); fail(call->line, mm); return; }
    map_set(m, t->fields[i], fv);
  }
}
/* build a new instance: its own type tag, with all fields (inherited + own) bound in order. */
static Value type_instantiate(TypeReg *t, Expr *call, Env *env) {
  int total = type_field_count(t);
  if (call->nargs > total) { char m[200]; snprintf(m, sizeof m, "%s takes at most %d value(s), but got %d.", t->name, total, call->nargs); fail(call->line, m); }
  SMap *m = map_new(); m->classname = t->name;
  int argi = 0;
  type_bind_fields(t, call, env, m, &argi);
  return vmap(m);
}
/* call a method on an instance: bind `self` to the receiver, then the given args. */
static Value type_method_call(Value recv, const char *name, Expr **args, int nargs, Env *env, int line) {
  if (recv.type != V_MAP || !recv.map || !recv.map->classname)
    failf(line, "only an object has methods to call (tried '.%s').", name);
  TypeReg *t = type_find(recv.map->classname);
  if (!t) failf(line, "I don't know the type '%s'.", recv.map->classname);
  TaskDef *md = type_method(t, name);
  if (!md) {
    const char *best = NULL; int bestd = 3;
    for (TypeReg *c = t; c; c = c->parent ? type_find(c->parent) : NULL)
      for (int i = 0; i < c->nmethods; i++) { int d = edit_distance(name, c->methods[i].name); if (d < bestd) { bestd = d; best = c->methods[i].name; } }
    char m[220];
    if (best) snprintf(m, sizeof m, "a %s has no method called '%s'. Did you mean '%s'?", t->name, name, best);
    else snprintf(m, sizeof m, "a %s has no method called '%s'.", t->name, name);
    fail(line, m);
  }
  Value *argv = (Value *)malloc((size_t)(nargs + 1) * sizeof(Value));
  argv[0] = recv;
  for (int i = 0; i < nargs; i++) argv[i + 1] = eval(args[i], env);
  Value r = call_task_v(md, argv, nargs + 1, line);
  free(argv);
  return r;
}
/* register a freshly-parsed file's top-level tasks AND types before it runs. */
static void register_top(Stmt *s, int fileid, Env *home) {
  if (s->kind == S_TASK) task_register(s, fileid, home);
  else if (s->kind == S_TYPE) type_register(s, fileid, home);
}

/* super.method(args): call the PARENT type's version of `method`, with `self` unchanged.
   `super` is resolved from the type the running method is defined on (bound as __class__),
   not from self's runtime type — so it walks up one level instead of looping forever. */
static Value eval_super_call(Expr *e, Env *env) {
  Value *selfv = env_find(env, "self");
  if (!selfv || selfv->type != V_MAP || !selfv->map || !selfv->map->classname)
    fail_hard(e->line, "name", "'super' can only be used inside a method (there's no object here).");
  Value *clsv = env_find(env, "__class__");
  if (!clsv || clsv->type != V_STR) fail(e->line, "'super' is only available inside a type's method.");
  TypeReg *cur = type_find(clsv->str);
  if (!cur || !cur->parent) { char m[200]; snprintf(m, sizeof m, "'%s' has no parent type, so there's no super.%s(...) to call.", clsv->str, e->name); fail(e->line, m); }
  TypeReg *pt = type_find(cur->parent);
  if (!pt) { char m[200]; snprintf(m, sizeof m, "super refers to unknown parent type '%s'.", cur->parent); fail(e->line, m); }
  TaskDef *md = type_method(pt, e->name);
  if (!md) { char m[220]; snprintf(m, sizeof m, "no parent method '%s' to call with super (looking up from '%s').", e->name, cur->parent); fail(e->line, m); }
  Value *argv = (Value *)malloc((size_t)(e->nargs + 1) * sizeof(Value));
  argv[0] = *selfv;
  for (int i = 0; i < e->nargs; i++) argv[i + 1] = eval(e->args[i], env);
  Value r = call_task_v(md, argv, e->nargs + 1, e->line);
  free(argv);
  return r;
}

static Value call_module(Expr *e, Env *env) {
  if (!strcmp(e->module, "super")) return eval_super_call(e, env);
  /* if `module` is actually a variable holding a value, `.name(...)` is method-call syntax */
  { Value *ov = env_find(env, e->module);
    if (ov) {
      if (ov->type == V_MAP && ov->map && ov->map->classname) return type_method_call(*ov, e->name, e->args, e->nargs, env, e->line);   /* an object: real method call */
      /* a plain value (list/text/number/map): Sprout uses functions, not methods — redirect */
      char m[256];
      if (is_builtin_name(e->name)) snprintf(m, sizeof m, "%s is %s, not an object — write %s(%s) instead of %s.%s().", e->module, type_name(*ov), e->name, e->module, e->module, e->name);
      else snprintf(m, sizeof m, "%s is %s, not a module or object, so there's no '%s.%s' to call.", e->module, type_name(*ov), e->module, e->name);
      fail_hard(e->line, "name", m);
    }
  }
  if (!has_use(cur_fileid, e->module)) {
    char m[256]; snprintf(m, sizeof m, "to call %s.%s, add 'use %s' at the top of this file.", e->module, e->name, e->module);
    fail_hard(e->line, "name", m);
  }
  if (!strcmp(e->module, "system")) return call_system(e, env);
  ModNS *mod = modns_get(e->module);
  if (!mod) { char m[200]; snprintf(m, sizeof m, "I don't know a module called '%s'.", e->module); fail_hard(e->line, "name", m); }
  TaskDef *t = task_find_public(mod->fileid, e->name);
  if (!t) { char m[256]; snprintf(m, sizeof m, "the module '%s' has no public task called '%s'.", e->module, e->name); fail_hard(e->line, "name", m); }
  return call_task_def(t, e, env);
}

static Value eval(Expr *e, Env *env) {
  if (stack_too_deep()) fail(e->line, "this is nested too deeply.");
  switch (e->kind) {
    case E_NUM:  return vnum(e->num);
    case E_STR:  return vstr(e->str);
    case E_BOOL: return vbool(e->boolean);
    case E_NONE: return vnone();
    case E_LAMBDA: {                                  /* a lambda value: copy the static template, capture THIS env */
      TaskDef *t = (TaskDef *)gc_alloc(GC_TASK, sizeof(TaskDef));
      *t = *e->lambda;                                /* params/body/name/nparams/nbody/line (shared AST) */
      t->home = env;                                  /* the closure: a fresh capture per evaluation */
      t->fileid = cur_fileid;
      t->file_env = cur_file_env;                     /* where a `public make` inside this lambda belongs */
      return vtask(t);
    }
    case E_RANGE: {                                    /* a to b — an inclusive list of whole numbers */
      Value a = eval(e->left, env), b = eval(e->right, env);
      if (a.type != V_NUM || b.type != V_NUM) { char buf[220]; snprintf(buf, sizeof buf, "a range (a to b) needs two numbers, but got %s and %s.", type_name(a), type_name(b)); fail_kind(e->line, "type", buf); }
      if (a.num != (double)(long long)a.num || b.num != (double)(long long)b.num) fail_kind(e->line, "type", "a range (a to b) needs whole numbers.");
      long long lo = (long long)a.num, hi = (long long)b.num;
      if (hi - lo >= 100000000LL) fail(e->line, "that range is too big.");   /* inclusive: caps at 100M elements, matching range() */
      SList *out = list_new();
      for (long long i = lo; i <= hi; i++) list_push(out, vnum((double)i));  /* inclusive; EMPTY if a > b (use reverse(a to b) to count down) */
      return vlist(out);
    }
    case E_COMPREHENSION: {                            /* [expr for each x in xs (when cond)] */
      Value it = eval(e->right, env);
      SList *out = list_new();
      if (it.type == V_LIST) {
        int len = it.list ? it.list->n : 0;
        for (int i = 0; i < len; i++) {
          Env *be = env_new(env); env_define(be, e->name, it.list->items[i]);
          if (!e->operand || is_truthy(eval(e->operand, be))) list_push(out, eval(e->left, be));
        }
      } else if (it.type == V_MAP) {                   /* loops over the keys (like `for each k in map`) */
        int len = it.map ? it.map->n : 0;
        for (int i = 0; i < len; i++) {
          Env *be = env_new(env); env_define(be, e->name, vstr_take(dup_str(it.map->keys[i])));
          if (!e->operand || is_truthy(eval(e->operand, be))) list_push(out, eval(e->left, be));
        }
      } else if (it.type == V_STR) {                   /* one whole UTF-8 character per step */
        const char *p = it.str ? it.str : "";
        for (int i = 0; p[i]; ) {
          int cl = utf8_clen((unsigned char)p[i]); char ch[5]; int k = 0;
          for (; k < cl && p[i + k]; k++) { ch[k] = p[i + k]; }
          ch[k] = 0;
          Env *be = env_new(env); env_define(be, e->name, vstr_take(dup_str(ch)));
          if (!e->operand || is_truthy(eval(e->operand, be))) list_push(out, eval(e->left, be));
          i += k ? k : 1;
        }
      } else fail_kind(e->line, "type", "a comprehension can only loop over a list, a map, or text.");
      return vlist(out);
    }
    case E_VAR: {
      Value *v = env_find(env, e->name);
      if (!v) {
        TaskDef *t = task_find(e->name);
        if (t) return vtask(t);   /* a task's name used as a value -> a first-class task value */
        char msg[400];
        const char *sug = suggest_name(e->name, env, 1);
        if (sug) snprintf(msg, sizeof msg, "I don't know what '%s' is.\n\n  Did you mean '%s'?", e->name, sug);
        else snprintf(msg, sizeof msg, "I don't know what '%s' is.\n\n  Variables are made with 'make', like:\n      make %s = \"Sam\"", e->name, e->name);
        fail_hard(e->line, "name", msg);
      }
      return *v;
    }
    case E_UNARY:
      if (e->op == T_NOT) return vbool(!is_truthy(eval(e->operand, env)));
      { Value v = eval(e->operand, env); if (v.type != V_NUM) fail_kind(e->line, "type", "I can only put a minus sign in front of a number."); return vnum(-v.num); }
    case E_LOGICAL: {
      int l = is_truthy(eval(e->left, env));
      if (e->op == T_AND) return vbool(l ? is_truthy(eval(e->right, env)) : 0);
      return vbool(l ? 1 : is_truthy(eval(e->right, env)));
    }
    case E_COALESCE: {                               /* `a or else b`: b only if a is nothing */
      Value l = eval(e->left, env);
      return l.type == V_NONE ? eval(e->right, env) : l;
    }
    case E_BINARY: return eval_binary(e, env);
    case E_CALL:   if (e->module) return call_module(e, env);
                   { Value *fv = env_find(env, e->name); if (fv && fv->type == V_TASK) return call_task_def(fv->task, e, env); }  /* call a task held in a variable */
                   { TypeReg *ty = type_find(e->name); if (ty) return type_instantiate(ty, e, env); }  /* TypeName(args) -> a new object */
                   if (task_find(e->name)) return call_task(e, env);
                   if (is_builtin_name(e->name)) return call_builtin(e, env);   /* a builtin (even if a variable shadows the name) */
                   { Value *fv = env_find(env, e->name); if (fv) { char m[200]; snprintf(m, sizeof m, "'%s' is %s, not a task, so it can't be called with ( ).", e->name, type_name(*fv)); fail_hard(e->line, "type", m); } }
                   return call_builtin(e, env);   /* unknown name -> the friendly "did you mean" error */
    case E_METHODCALL: { Value recv = eval(e->target, env); return type_method_call(recv, e->name, e->args, e->nargs, env, e->line); }
    case E_MEMBER: {
      /* obj.field — when `module` is actually a variable holding an object, read its field */
      { Value *ov = env_find(env, e->module); if (ov && ov->type == V_MAP && ov->map && ov->map->classname) { int i = map_index(ov->map, e->name); return i >= 0 ? ov->map->vals[i] : vnone(); } }
      if (!has_use(cur_fileid, e->module)) { char m[256]; snprintf(m, sizeof m, "to read %s.%s, add 'use %s' at the top of this file.", e->module, e->name, e->module); fail_hard(e->line, "name", m); }
      if (!strcmp(e->module, "system")) { char m[200]; snprintf(m, sizeof m, "system.%s is an action - call it, like system.%s(...).", e->name, e->name); fail_hard(e->line, "name", m); }
      ModNS *mod = modns_get(e->module);
      if (!mod) { char m[200]; snprintf(m, sizeof m, "I don't know a module called '%s'.", e->module); fail_hard(e->line, "name", m); }
      if (!is_public_var(mod->fileid, e->name)) { char m[256]; snprintf(m, sizeof m, "the module '%s' has no public value called '%s'.", e->module, e->name); fail_hard(e->line, "name", m); }
      Value *v = env_local(mod->env, e->name);
      return v ? *v : vnone();
    }
    case E_LIST: { SList *l = list_new(); for (int i = 0; i < e->nargs; i++) list_push(l, eval(e->args[i], env)); return vlist(l); }
    case E_MAP:  { SMap *m = map_new(); for (int i = 0; i < e->nargs; i++) map_set(m, e->keys[i], eval(e->args[i], env)); return vmap(m); }
    case E_INDEX: {
      Value c = eval(e->target, env), ix = eval(e->index, env);
      if (c.type == V_LIST) {
        if (ix.type != V_NUM) { char m[160], d[96]; val_describe(ix, d, sizeof d); snprintf(m, sizeof m, "a list position must be a number, but you used %s.", d); fail_kind(e->line, "type", m); }
        if (ix.num != (double)(long long)ix.num) { char m[160]; snprintf(m, sizeof m, "a list position must be a whole number, but you used %g.", ix.num); fail_kind(e->line, "type", m); }
        int len = c.list ? c.list->n : 0; long long i = (long long)ix.num, at = i < 0 ? i + len : i;   /* xs[-1] is the last item */
        if (!c.list || at < 0 || at >= len) { char m[220]; if (len == 0) snprintf(m, sizeof m, "you asked for position %lld, but this list is empty.", i); else snprintf(m, sizeof m, "position %lld doesn't exist \xE2\x80\x94 this list has %d item%s (use 0 to %d, or -1 to -%d from the end).", i, len, len == 1 ? "" : "s", len - 1, len); fail_kind(e->line, "index", m); }
        return c.list->items[at];
      }
      if (c.type == V_MAP) {
        if (ix.type != V_STR) { char m[160], d[96]; val_describe(ix, d, sizeof d); snprintf(m, sizeof m, "a map key must be text, but you used %s.", d); fail_kind(e->line, "type", m); }
        int i = c.map ? map_index(c.map, ix.str) : -1;
        if (i >= 0) return c.map->vals[i];
        { const char *sug = nearest_map_key(c.map, ix.str); if (sug) fail_map_key(e->line, c, ix.str ? ix.str : "", sug); }
        return vnone();   /* a genuinely-absent key reads as nothing (optional lookups) */
      }
      if (c.type == V_STR) {                              /* text[i] -> the i-th character (UTF-8 aware) */
        if (ix.type != V_NUM) { char m[160], d[96]; val_describe(ix, d, sizeof d); snprintf(m, sizeof m, "a text position must be a number, but you used %s.", d); fail_kind(e->line, "type", m); }
        if (ix.num != (double)(long long)ix.num) { char m[160]; snprintf(m, sizeof m, "a text position must be a whole number, but you used %g.", ix.num); fail_kind(e->line, "type", m); }
        long long want = (long long)ix.num;
        const char *p = c.str ? c.str : "";
        if (want < 0) { long long n = 0; for (int j = 0; p[j]; j += utf8_clen((unsigned char)p[j])) n++; want += n; }   /* "hi"[-1] is the last char */
        long long idx = 0;
        for (int i = 0; p[i]; ) {
          int cl = utf8_clen((unsigned char)p[i]); int k = 0; char ch[5];
          for (; k < cl && p[i + k]; k++) ch[k] = p[i + k];
          ch[k] = 0;
          if (idx == want) return vstr_take(dup_str(ch));
          idx++; i += k ? k : 1;
        }
        { char m[200]; if (idx == 0) snprintf(m, sizeof m, "you asked for position %lld, but this text is empty.", want); else snprintf(m, sizeof m, "position %lld doesn't exist in this text \xE2\x80\x94 it has %lld character%s (valid positions are 0 to %lld).", want, idx, idx == 1 ? "" : "s", idx - 1); fail_kind(e->line, "index", m); }
      }
      if (c.type == V_NONE) fail_kind(e->line, "type", "you tried to look inside 'nothing' with [ ] - there's nothing there to index.");
      fail_kind(e->line, "type", "I can only look inside a list, a map, or text with [ ].");
      return vnone();
    }
    case E_SLICE: {                                     /* xs[a:b] / xs[a:] / xs[:b] / xs[:] — a sub-range (end exclusive) */
      Value c = eval(e->target, env);
      int have_s = e->index != NULL, have_e = e->operand != NULL;
      long long s = 0, en = 0;
      if (have_s) { Value v = eval(e->index, env); if (v.type != V_NUM || v.num != (double)(long long)v.num) fail_kind(e->line, "type", "a slice start must be a whole number, like xs[1:3]."); s = (long long)v.num; }
      if (have_e) { Value v = eval(e->operand, env); if (v.type != V_NUM || v.num != (double)(long long)v.num) fail_kind(e->line, "type", "a slice end must be a whole number, like xs[1:3]."); en = (long long)v.num; }
      if (c.type == V_LIST) {
        long long len = c.list ? c.list->n : 0;
        long long a = have_s ? (s < 0 ? s + len : s) : 0, b = have_e ? (en < 0 ? en + len : en) : len;
        if (a < 0) { a = 0; } if (b > len) { b = len; } if (b < a) { b = a; }
        SList *out = list_new(); for (long long i = a; i < b; i++) list_push(out, c.list->items[i]); return vlist(out);
      }
      if (c.type == V_STR) {                            /* char-aware (UTF-8), like text[i] */
        const char *p = c.str ? c.str : ""; long long n = 0;
        for (int j = 0; p[j]; j += utf8_clen((unsigned char)p[j])) n++;
        long long a = have_s ? (s < 0 ? s + n : s) : 0, b = have_e ? (en < 0 ? en + n : en) : n;
        if (a < 0) { a = 0; } if (b > n) { b = n; } if (b < a) { b = a; }
        size_t cap = 0, len = 0; char *out = NULL; long long idx = 0;
        for (int j = 0; p[j]; ) { int cl = utf8_clen((unsigned char)p[j]); if (idx >= a && idx < b) { char ch[5]; int k = 0; for (; k < cl && p[j + k]; k++) ch[k] = p[j + k]; ch[k] = 0; sb_add(&out, &cap, &len, ch); } idx++; j += cl ? cl : 1; }
        Value rv = vstr(out ? out : ""); free(out); return rv;
      }
      fail_kind(e->line, "type", "I can only slice a list or text with [a:b].");
      return vnone();
    }
  }
  return vnone();
}

/* ---- learn mode: narrate each step so the reader can watch a program think ---- */
static const char *op_sym(TokType op) {
  switch (op) {
    case T_PLUS: return "+"; case T_MINUS: return "-"; case T_STAR: return "*"; case T_SLASH: return "/"; case T_PERCENT: return "%";
    case T_EQEQ: return "=="; case T_BANGEQ: return "!="; case T_LT: return "<"; case T_LE: return "<="; case T_GT: return ">"; case T_GE: return ">=";
    case T_AND: return "and"; case T_OR: return "or"; case T_NOT: return "not"; case T_IN: return "in"; default: return "?";
  }
}
/* render an expression back to text; if with_values, substitute each variable's current value
   (it never calls functions, so it has no side effects — the real value comes from one eval) */
static int g_render_depth = 0;
static void render_expr(Expr *e, int wv, Env *env, char **o, size_t *c, size_t *l) {
  if (!e) return;
  if (++g_render_depth > 256) { sb_add(o, c, l, "..."); g_render_depth--; return; }   /* guard deep nesting */
  switch (e->kind) {
    case E_NUM:  { char *t = num_to_str(e->num); sb_add(o, c, l, t); free(t); break; }
    case E_STR:  sb_add(o, c, l, "\""); sb_add(o, c, l, e->str ? e->str : ""); sb_add(o, c, l, "\""); break;
    case E_BOOL: sb_add(o, c, l, e->boolean ? "yes" : "no"); break;
    case E_NONE: sb_add(o, c, l, "nothing"); break;
    case E_VAR:  {
      if (wv) { Value *v = env_find(env, e->name); if (v) { char *t = stringify(*v); sb_add(o, c, l, t); free(t); break; } }
      sb_add(o, c, l, e->name); break;
    }
    case E_UNARY: sb_add(o, c, l, op_sym(e->op)); if (e->op == T_NOT) sb_add(o, c, l, " "); render_expr(e->operand, wv, env, o, c, l); break;
    case E_BINARY: case E_LOGICAL: {
      if (e->op == T_PLUS) {   /* hide the empty-string pieces f-strings desugar into */
        int le = (e->left->kind == E_STR && (!e->left->str || !e->left->str[0]));
        int re = (e->right->kind == E_STR && (!e->right->str || !e->right->str[0]));
        if (le && !re) { render_expr(e->right, wv, env, o, c, l); break; }
        if (re && !le) { render_expr(e->left, wv, env, o, c, l); break; }
      }
      render_expr(e->left, wv, env, o, c, l); sb_add(o, c, l, " "); sb_add(o, c, l, op_sym(e->op)); sb_add(o, c, l, " "); render_expr(e->right, wv, env, o, c, l); break;
    }
    case E_COALESCE: render_expr(e->left, wv, env, o, c, l); sb_add(o, c, l, " or else "); render_expr(e->right, wv, env, o, c, l); break;
    case E_CALL: if (e->module) { sb_add(o, c, l, e->module); sb_add(o, c, l, "."); } sb_add(o, c, l, e->name); sb_add(o, c, l, "(");
      for (int i = 0; i < e->nargs; i++) { if (i) sb_add(o, c, l, ", "); render_expr(e->args[i], wv, env, o, c, l); } sb_add(o, c, l, ")"); break;
    case E_MEMBER: sb_add(o, c, l, e->module); sb_add(o, c, l, "."); sb_add(o, c, l, e->name); break;
    case E_LIST: sb_add(o, c, l, "[");
      for (int i = 0; i < e->nargs; i++) { if (i) sb_add(o, c, l, ", "); render_expr(e->args[i], wv, env, o, c, l); } sb_add(o, c, l, "]"); break;
    case E_MAP: sb_add(o, c, l, "{");
      for (int i = 0; i < e->nargs; i++) { if (i) sb_add(o, c, l, ", "); sb_add(o, c, l, e->keys[i]); sb_add(o, c, l, ": "); render_expr(e->args[i], wv, env, o, c, l); } sb_add(o, c, l, "}"); break;
    case E_INDEX: render_expr(e->target, wv, env, o, c, l); sb_add(o, c, l, "["); render_expr(e->index, wv, env, o, c, l); sb_add(o, c, l, "]"); break;
    case E_SLICE: render_expr(e->target, wv, env, o, c, l); sb_add(o, c, l, "["); if (e->index) render_expr(e->index, wv, env, o, c, l); sb_add(o, c, l, ":"); if (e->operand) render_expr(e->operand, wv, env, o, c, l); sb_add(o, c, l, "]"); break;
    case E_METHODCALL: render_expr(e->target, wv, env, o, c, l); sb_add(o, c, l, "."); sb_add(o, c, l, e->name); sb_add(o, c, l, "(");
      for (int i = 0; i < e->nargs; i++) { if (i) sb_add(o, c, l, ", "); render_expr(e->args[i], wv, env, o, c, l); } sb_add(o, c, l, ")"); break;
    case E_LAMBDA: sb_add(o, c, l, "task(");
      for (int i = 0; e->lambda && i < e->lambda->nparams; i++) { if (i) sb_add(o, c, l, ", "); sb_add(o, c, l, e->lambda->params[i]); } sb_add(o, c, l, "): ..."); break;
    case E_RANGE: render_expr(e->left, wv, env, o, c, l); sb_add(o, c, l, " to "); render_expr(e->right, wv, env, o, c, l); break;
    case E_COMPREHENSION: sb_add(o, c, l, "["); render_expr(e->left, wv, env, o, c, l); sb_add(o, c, l, " for each ");
      sb_add(o, c, l, e->name); sb_add(o, c, l, " in "); render_expr(e->right, wv, env, o, c, l);
      if (e->operand) { sb_add(o, c, l, " when "); render_expr(e->operand, wv, env, o, c, l); } sb_add(o, c, l, "]"); break;
  }
  g_render_depth--;
}
static char *render_str(Expr *e, int wv, Env *env) {
  char *o = NULL; size_t c = 0, l = 0; render_expr(e, wv, env, &o, &c, &l); return o ? o : dup_str("");
}
static void learn_show(Stmt *s, Env *env) {
  for (int i = 0; i < s->nvalues; i++) {
    Expr *e = s->values[i];
    char *src = render_str(e, 0, env);
    printf("  " C_DIM "Evaluating:" C_RESET "\n      %s\n\n", src);
    if (e->kind == E_BINARY || e->kind == E_LOGICAL || e->kind == E_UNARY) {
      char *vf = render_str(e, 1, env);
      Value res = eval(e, env); char *rs = stringify(res);
      if (strcmp(vf, src) != 0) printf("      %s = %s\n\n", vf, rs);
      printf("  " C_DIM "Output:" C_RESET "\n      %s\n\n", rs);
      free(vf); free(rs);
    } else {
      Value res = eval(e, env); char *rs = stringify(res);
      printf("  " C_DIM "Output:" C_RESET "\n      %s\n\n", rs); free(rs);
    }
    free(src);
  }
}
/* learn mode: announce a for-each turn with the loop variable(s) bound for this turn */
static void learn_loop(Env *be, const char *n1, const char *n2) {
  if (!g_learn) return;
  Value *v1 = env_find(be, n1); char *t1 = v1 ? stringify(*v1) : dup_str("nothing");
  if (n2) { Value *v2 = env_find(be, n2); char *t2 = v2 ? stringify(*v2) : dup_str("nothing");
    printf("  " C_DIM "Loop turn: %s = %s, %s = %s" C_RESET "\n\n", n1, t1, n2, t2); free(t2); }
  else printf("  " C_DIM "Loop turn: %s = %s" C_RESET "\n\n", n1, t1);
  free(t1);
}

static void exec(Stmt *s, Env *env) {
  /* a safe point: between statements every live value is a root. Inline the common
     no-collect case (just a load + compare) so non-allocating loops pay almost nothing. */
#ifndef __EMSCRIPTEN__   /* the conservative stack scan can't see roots held in WASM locals; leak instead (playground programs are short, each run is a fresh instance) */
  if (gc_stack_bottom && (gc_bytes > gc_threshold || gc_stress)) gc_collect();
#endif
  switch (s->kind) {
    case S_MAKE: {
      Value v = eval(s->expr, env);
      Env *target = s->is_public ? cur_file_env : env;     /* public vars live in the file env */
      if (s->nparams > 0) {                                /* make a, b = pair — unpack a list into names */
        if (v.type != V_LIST) { char d[96], m[220]; val_describe(v, d, sizeof d); snprintf(m, sizeof m, "to unpack into %d names, the right side must be a list, but it's %s.", s->nparams, d); fail_kind(s->line, "type", m); }
        int have = v.list ? v.list->n : 0;
        if (have != s->nparams) { char m[220]; snprintf(m, sizeof m, "this unpacks %d name%s, but the list has %d item%s \xE2\x80\x94 they must match.", s->nparams, s->nparams == 1 ? "" : "s", have, have == 1 ? "" : "s"); fail_kind(s->line, "error", m); }
        for (int i = 0; i < s->nparams; i++) {
          if (!g_repl_active && env_local(target, s->params[i])) failf(s->line, "'%s' already exists here - use 'set' to change it (make is only for new names).", s->params[i]);
          env_define(target, s->params[i], v.list->items[i]);
          if (s->is_public) mark_public_var(cur_fileid, s->params[i]);
          if (g_learn) { char *t = stringify(v.list->items[i]); printf("  " C_DIM "Created variable" C_RESET " %s = %s\n", s->params[i], t); free(t); }
        }
        if (g_learn) printf("\n");
        break;
      }
      /* re-running a `public make` (loop / a task called twice) just updates the file-level slot;
         the live REPL also lets you re-`make` a name. Otherwise a duplicate in THIS scope is an error. */
      int relaxed = g_repl_active || (s->is_public && is_public_var(cur_fileid, s->name));
      if (!relaxed && env_local(target, s->name))
        failf(s->line, "'%s' already exists here - use 'set' to change it (make is only for new names).", s->name);
      env_define(target, s->name, v);
      if (s->is_public) mark_public_var(cur_fileid, s->name);
      if (g_learn) { char *t = stringify(v); printf("  " C_DIM "Created variable" C_RESET " %s = %s\n\n", s->name, t); free(t); }
      break;
    }
    case S_SET: {
      Value v = eval(s->expr, env);
      if (s->setop) { Value *cur = env_find(env, s->name); if (cur) v = apply_arith(s->setop, *cur, v, s->line); }  /* x += e  ->  x = x + e */
      env_assign(env, s->name, v, s->line);
      if (g_learn) { char *t = stringify(v); printf("  " C_DIM "Updated" C_RESET " %s to %s\n\n", s->name, t); free(t); }
      break;
    }
    case S_SHOW: {
      if (g_learn) { learn_show(s, env); break; }
      for (int i = 0; i < s->nvalues; i++) { if (i) fputc(' ', stdout); char *t = stringify(eval(s->values[i], env)); fputs(t, stdout); }
      fputc('\n', stdout); break;
    }
    case S_LEARN: g_learn = s->is_public; break;
    case S_TEST: {
      const char *prevn = g_cur_test; int prevf = g_test_failed;
      g_cur_test = s->name; g_test_failed = 0;
      /* a test is a SYSTEM boundary: it catches EVERYTHING (soft + hard), so a typo fails just this test.
         locals read after the longjmp are volatile (belt-and-suspenders for -O2 / Windows SEH). */
      sjmp_buf tb; sjmp_buf * volatile saved = err_jmp; sjmp_buf * volatile saved_top = g_top_jmp;
      err_jmp = &tb; g_top_jmp = &tb;
      volatile int sdepth = call_depth, sret = returning, sq = g_quiet_fail;
      volatile int sfid = cur_fileid; Env * volatile sfe = cur_file_env;   /* restore file context if a cross-file task failed */
      if (SJSET(tb) == 0) {
        exec_block(s->body, s->nbody, env_new(env));   /* each test runs in its own scope */
      } else {                                          /* a runtime error stopped the test */
        call_depth = sdepth; returning = sret; g_loopctl = 0; g_quiet_fail = sq; g_have_fail_override = 0; cur_fileid = sfid; cur_file_env = sfe;
        if (!g_test_failed) { g_test_failed = 1; printf("  " C_RED "x" C_RESET "  %s " C_DIM "(stopped by an error)" C_RESET "\n", s->name); }
      }
      err_jmp = saved; g_top_jmp = saved_top; g_quiet_fail = sq; g_have_fail_override = 0;
      if (g_test_failed) g_tfail++; else { g_tpass++; printf("  " C_GREEN "ok" C_RESET "  %s\n", s->name); }
      g_cur_test = prevn; g_test_failed = prevf;
      break;
    }
    case S_EXPECT: {
      if (!is_truthy(eval(s->expr, env))) {
        char *src = render_str(s->expr, 0, env), *vals = render_str(s->expr, 1, env);
        printf("  " C_RED "x" C_RESET "  %s\n        expected this to be true:  %s\n", g_cur_test ? g_cur_test : "(test)", src);
        if (strcmp(src, vals) != 0) printf("        but it was:                %s\n", vals);
        free(src); free(vals);
        g_test_failed = 1;
        if (err_jmp) SJLONG(*err_jmp);   /* stop this test, move to the next */
      }
      break;
    }
    case S_EXPECT_ERROR: {                              /* `expect error [\"kind\"]:` — the block MUST fail */
      sjmp_buf tb; sjmp_buf * volatile saved = err_jmp; volatile int sq = g_quiet_fail; volatile int sdepth = call_depth;
      volatile int sfid = cur_fileid; Env * volatile sfe = cur_file_env;
      err_jmp = &tb; g_quiet_fail = 1;                  /* catch SOFT errors; a hard error (typo) still aborts the test */
      volatile int errored = 0;
      if (SJSET(tb) == 0) {
        exec_block(s->body, s->nbody, env_new(env));    /* ran clean -> the assertion will fail */
        err_jmp = saved; g_quiet_fail = sq; g_have_fail_override = 0;
      } else {
        err_jmp = saved; g_quiet_fail = sq; call_depth = sdepth; returning = 0; g_loopctl = 0; cur_fileid = sfid; cur_file_env = sfe;
        errored = 1;
      }
      if (!errored) {
        g_test_failed = 1;
        printf("  " C_RED "x" C_RESET "  %s\n        expected an error here, but the steps succeeded\n", g_cur_test ? g_cur_test : "(test)");
        if (err_jmp) SJLONG(*err_jmp);
      } else if (s->name) {                             /* a required kind was given - check it (works for fail-maps too) */
        Value ev = current_error_value(); const char *got = "error";
        if (ev.type == V_MAP && ev.map) { int ki = map_index(ev.map, "kind"); if (ki >= 0 && ev.map->vals[ki].type == V_STR && ev.map->vals[ki].str) got = ev.map->vals[ki].str; }
        if (strcmp(got, s->name) != 0) {
          g_test_failed = 1;
          printf("  " C_RED "x" C_RESET "  %s\n        expected an error of kind \"%s\", but got kind \"%s\"\n", g_cur_test ? g_cur_test : "(test)", s->name, got);
          if (err_jmp) SJLONG(*err_jmp);
        }
      } else { g_have_fail_override = 0; }              /* passed (any error); clear a stray fail-override */
      break;
    }
    case S_WHEN: {
      for (int i = 0; i < s->nbranches; i++) if (is_truthy(eval(s->branches[i].cond, env))) {
        if (g_learn) { char *cs = render_str(s->branches[i].cond, 1, env); printf("  " C_DIM "Checking" C_RESET " %s " C_DIM "-> yes; running this branch" C_RESET "\n\n", cs); free(cs); }
        exec_scoped(s->branches[i].body, s->branches[i].nbody, env); return;
      }
      if (g_learn) printf("  " C_DIM "Checking when -> no branch was true%s" C_RESET "\n\n", s->otherwise ? "; running otherwise" : "; doing nothing");
      if (s->otherwise) exec_scoped(s->otherwise, s->notherwise, env);
      break;
    }
    case S_MATCH: {
      Value subj = eval(s->expr, env);
      for (int i = 0; i < s->narms; i++) {
        MatchArm *arm = &s->arms[i];
        if (arm->patkind == 3) {                                  /* otherwise */
          exec_scoped(arm->body, arm->nbody, env); return;
        } else if (arm->patkind == 0) {                           /* literal: compare by value */
          if (values_equal(subj, eval(arm->lit, env))) { exec_scoped(arm->body, arm->nbody, env); return; }
        } else if (arm->patkind == 1) {                           /* list-destructure [a, b] */
          if (subj.type == V_LIST && subj.list && subj.list->n == arm->nnames) {
            Env *be = env_new(env);
            for (int k = 0; k < arm->nnames; k++) env_define(be, arm->names[k], subj.list->items[k]);
            exec_block(arm->body, arm->nbody, be); return;
          }
        } else if (arm->patkind == 2) {                           /* map-destructure {name, age} */
          if (subj.type == V_MAP && subj.map) {
            int all = 1;
            for (int k = 0; k < arm->nnames; k++) if (map_index(subj.map, arm->names[k]) < 0) { all = 0; break; }
            /* {name, ...} matches a map that HAS those keys (a superset is fine); the empty pattern
               {} matches only an empty map — symmetric with [], not a match-any-map wildcard. */
            if (all && (arm->nnames > 0 || subj.map->n == 0)) {
              Env *be = env_new(env);
              for (int k = 0; k < arm->nnames; k++) { int mi = map_index(subj.map, arm->names[k]); env_define(be, arm->names[k], subj.map->vals[mi]); }
              exec_block(arm->body, arm->nbody, be); return;
            }
          }
        }
      }
      break;   /* nothing matched and no 'otherwise' — do nothing, like a `when` with no otherwise */
    }
    case S_REPEAT_TIMES: {
      Value c = eval(s->count, env); if (c.type != V_NUM) fail(s->line, "'repeat ... times' needs a number.");
      long long times = (long long)c.num;
      int scoped = block_binds_names(s->body, s->nbody);   /* skip the per-turn scope when the body makes nothing */
      for (long long k = 0; k < times; k++) { if (g_learn) printf("  " C_DIM "Repeat turn %lld of %lld" C_RESET "\n\n", k + 1, times); if (scoped) exec_scoped(s->body, s->nbody, env); else exec_block(s->body, s->nbody, env); if (returning) break; if (g_loopctl) { int stop = g_loopctl == 2; g_loopctl = 0; if (stop) break; } }
      break;
    }
    case S_REPEAT_WHILE: {
      long long turn = 0;
      int scoped = block_binds_names(s->body, s->nbody);
      while (is_truthy(eval(s->expr, env))) { if (g_learn) printf("  " C_DIM "While-loop turn %lld (the test was true)" C_RESET "\n\n", ++turn); if (scoped) exec_scoped(s->body, s->nbody, env); else exec_block(s->body, s->nbody, env); if (returning) break; if (g_loopctl) { int stop = g_loopctl == 2; g_loopctl = 0; if (stop) break; } }
      break;
    }
    case S_TASK: break;  /* registered before the run */
    case S_TYPE: break;  /* a type is registered before the run too */
    case S_USE: {                                /* import a module so this file can name it */
      char *base = module_basename(s->name);
      mark_use(cur_fileid, base);
      int builtin = !strcmp(base, "system");     /* system is built in - no file to load */
      free(base);
      if (!builtin) {
        /* loading a module reads (and runs) another file from disk — block it for untrusted code */
        if (g_sandbox) fail(s->line, "'use' is turned off in sandbox mode — a program can't load other files.");
        load_module(s->name);
      }
      break;
    }
    case S_GIVE: return_value = s->expr ? eval(s->expr, env) : vnone(); returning = 1; break;
    case S_EXPR: { Value v = eval(s->expr, env); if (repl_echo && v.type != V_NONE) printf("%s\n", stringify(v)); break; }
    case S_FOREACH: {
      Value it = eval(s->expr, env);
      /* each iteration runs in its own scope; the loop variable lives there (gone after the loop) */
      /* with a 2nd name: a LIST/text yields (index, item); a MAP yields (key, value). */
      if (it.type == V_LIST) {
        int len = it.list ? it.list->n : 0;            /* snapshot: appending inside the loop won't extend it */
        for (int i = 0; i < len; i++) { Env *be = env_new(env);
          if (s->name2) { env_define(be, s->name, vnum(i)); env_define(be, s->name2, it.list->items[i]); } else env_define(be, s->name, it.list->items[i]);
          learn_loop(be, s->name, s->name2);
          exec_block(s->body, s->nbody, be); if (returning) break; if (g_loopctl) { int stop = g_loopctl == 2; g_loopctl = 0; if (stop) break; } }
      } else if (it.type == V_MAP) {
        int len = it.map ? it.map->n : 0;
        for (int i = 0; i < len; i++) { Env *be = env_new(env); env_define(be, s->name, vstr_take(dup_str(it.map->keys[i])));
          if (s->name2) env_define(be, s->name2, it.map->vals[i]);
          learn_loop(be, s->name, s->name2);
          exec_block(s->body, s->nbody, be); if (returning) break; if (g_loopctl) { int stop = g_loopctl == 2; g_loopctl = 0; if (stop) break; } }
      } else if (it.type == V_STR) {
        const char *p = it.str ? it.str : ""; long long ci = 0;
        for (int i = 0; p[i]; ci++) {                   /* one whole UTF-8 character per step */
          int cl = utf8_clen((unsigned char)p[i]); char ch[5]; int k = 0;
          for (; k < cl && p[i + k]; k++) ch[k] = p[i + k];
          ch[k] = 0;
          Env *be = env_new(env);
          if (s->name2) { env_define(be, s->name, vnum((double)ci)); env_define(be, s->name2, vstr_take(dup_str(ch))); } else env_define(be, s->name, vstr_take(dup_str(ch)));
          learn_loop(be, s->name, s->name2);
          exec_block(s->body, s->nbody, be); if (returning) break; if (g_loopctl) { int stop = g_loopctl == 2; g_loopctl = 0; if (stop) { i += k ? k : 1; break; } }
          i += k ? k : 1;
        }
      } else fail(s->line, "I can only loop over a list, a map, or text with 'for each'.");
      break;
    }
    case S_INDEXSET: {
      Value c = eval(s->target, env);                  /* the list/map to set into (a reference) */
      Value ix = eval(s->index, env), val = eval(s->expr, env);
      if (c.type == V_LIST) {
        if (ix.type != V_NUM) { char m[160], d[96]; val_describe(ix, d, sizeof d); snprintf(m, sizeof m, "a list position must be a number, but you used %s.", d); fail_kind(s->line, "type", m); }
        if (ix.num != (double)(long long)ix.num) { char m[160]; snprintf(m, sizeof m, "a list position must be a whole number, but you used %g.", ix.num); fail_kind(s->line, "type", m); }
        int len = c.list ? c.list->n : 0; long long i = (long long)ix.num, at = i < 0 ? i + len : i;   /* set xs[-1] = ... targets the last item */
        if (!c.list || at < 0 || at >= len) { char m[220]; if (len == 0) snprintf(m, sizeof m, "you tried to set position %lld, but this list is empty.", i); else snprintf(m, sizeof m, "position %lld doesn't exist \xE2\x80\x94 this list has %d item%s (use 0 to %d, or -1 to -%d from the end).", i, len, len == 1 ? "" : "s", len - 1, len); fail_kind(s->line, "index", m); }
        if (s->setop) val = apply_arith(s->setop, c.list->items[at], val, s->line);   /* xs[i] += e */
        c.list->items[at] = val;
      } else if (c.type == V_MAP) {
        if (ix.type != V_STR) { char m[160], d[96]; val_describe(ix, d, sizeof d); snprintf(m, sizeof m, "a map key must be text, but you used %s.", d); fail_kind(s->line, "type", m); }
        if (!c.map) fail(s->line, "this map isn't ready to set into.");
        if (s->setop) {
          int mi = map_index(c.map, ix.str);
          if (mi < 0) { const char *sug = nearest_map_key(c.map, ix.str); if (sug) fail_map_key(s->line, c, ix.str ? ix.str : "", sug); else { char km[240]; snprintf(km, sizeof km, "can't update \"%s\" \xE2\x80\x94 this map has no such key yet.", ix.str ? ix.str : ""); fail_kind(s->line, "key", km); } }
          val = apply_arith(s->setop, c.map->vals[mi], val, s->line);
        }
        map_set(c.map, ix.str, val);
      } else { char m[160]; snprintf(m, sizeof m, "I can only set inside a list or a map with [ ], but this is %s.", type_name(c)); fail_kind(s->line, "type", m); }
      break;
    }
    case S_STOP: g_loopctl = 2; break;   /* end the loop now */
    case S_SKIP: g_loopctl = 1; break;   /* jump to the loop's next turn */
    case S_FAIL: {
      if (!s->expr) fail_kind(s->line, "fail", "the program stopped with 'fail'.");   /* bare `fail` */
      Value m = eval(s->expr, env);
      if (m.type == V_MAP) {                               /* fail <map>: the map IS the error - carry it whole */
        if (m.map) {
          if (map_index(m.map, "message") < 0) map_set(m.map, "message", vstr_take(dup_str("(no message)")));
          if (map_index(m.map, "kind")    < 0) map_set(m.map, "kind",    vstr_take(dup_str("fail")));
          if (map_index(m.map, "line")    < 0) map_set(m.map, "line",    vnum((double)s->line));
        }
        g_fail_override = m; g_have_fail_override = 1;
        const char *mt = "(custom error)";               /* the message text, for the printed/uncaught path */
        if (m.map) { int mi = map_index(m.map, "message"); if (mi >= 0 && m.map->vals[mi].type == V_STR && m.map->vals[mi].str) mt = m.map->vals[mi].str; }
        fail_kind(s->line, "fail", mt);
      } else {                                             /* fail "text" / fail 42: wrap into the standard error map */
        char *msg = (m.type == V_STR) ? (m.str ? m.str : "") : stringify(m);
        fail_kind(s->line, "fail", (msg && msg[0]) ? msg : "the program stopped with 'fail'.");
      }
      break;
    }
    case S_TRY: {
      sjmp_buf tb; sjmp_buf * volatile saved = err_jmp; err_jmp = &tb;   /* a try: is a CATCH boundary - sets err_jmp only, NOT g_top_jmp */
      volatile int sq = g_quiet_fail; g_quiet_fail = 1;   /* soft errors inside become catchable, not printed */
      volatile int sdepth = call_depth;                   /* read after the longjmp -> volatile (-O2 safety) */
      volatile int sfid = cur_fileid; Env * volatile sfe = cur_file_env;  /* a failing cross-file task value leaves these in ITS file; restore on catch */
      if (SJSET(tb) == 0) {
        exec_scoped(s->body, s->nbody, env);              /* the protected steps */
        err_jmp = saved; g_quiet_fail = sq;               /* clean exit: give/stop/skip flags pass through, caught does NOT run */
      } else {                                            /* a soft error was caught (a hard one would have skipped to g_top_jmp) */
        err_jmp = saved; g_quiet_fail = sq;
        call_depth = sdepth; returning = 0; g_loopctl = 0; cur_fileid = sfid; cur_file_env = sfe;   /* unwind the half-done try cleanly */
        Value err = current_error_value();                /* {message, kind, line} (or the user's fail-map) */
        Env *be = env_new(env);
        if (s->name) env_define(be, s->name, err);        /* caught problem:  ->  'problem' holds the error map */
        exec_block(s->otherwise, s->notherwise, be);
      }
      break;
    }
  }
}

/* --------------------------------------------------------------------- main */
static char *read_file(const char *path, int *out_len) {
  FILE *f = fopen(path, "rb");
  if (!f) { fprintf(stderr, "\n  I couldn't open the file: %s\n\n", path); exit(1); }
  if (fseek(f, 0, SEEK_END) != 0) { fclose(f); fprintf(stderr, "\n  I couldn't read '%s' (is it a folder?).\n\n", path); exit(1); }
  long n = ftell(f);
  if (n < 0) { fclose(f); fprintf(stderr, "\n  I couldn't read '%s' (is it a folder?).\n\n", path); exit(1); }
  fseek(f, 0, SEEK_SET);
  char *buf = (char *)malloc(n + 1);
  if (!buf) { fclose(f); fprintf(stderr, "\n  Out of memory reading %s\n\n", path); exit(1); }
  size_t got = fread(buf, 1, n, f); buf[got] = 0; fclose(f);
  *out_len = (int)got; return buf;
}

#define SPROUT_VERSION "0.1.21"

static void usage(void) {
  printf("Sprout v%s - a small, friendly language, written from scratch in C.\n\n", SPROUT_VERSION);
  printf("  sprout                   open the interactive screen\n");
  printf("  sprout new <folder>      create a new project folder\n");
  printf("  sprout build             run the project here (reads sprout.toml)\n");
  printf("  sprout test [file]       run tests (a file, or every tests/*.sprout)\n");
  printf("  sprout bundle <file>     package a program into a standalone executable\n");
  printf("  sprout format <file>     tidy a program's formatting (--write to edit, --check for CI)\n");
  printf("  sprout add <source>      install a library (a path, https url, or github:user/repo)\n");
  printf("  sprout install           fetch every library in sprout.packages\n");
  printf("  sprout remove <name>     uninstall a library\n");
  printf("  sprout <file.sprout>     run a single program\n");
  printf("  sprout run <file>        run a single program\n");
  printf("  sprout api <url>         show every field an API gives back\n");
  printf("  sprout template list     list project templates\n");
  printf("  sprout template load <name>   scaffold into THIS folder (wipes it)\n");
  printf("  sprout version           show the version\n");
  printf("  sprout help              show this help\n");
  printf("\n");
  printf("  --sandbox                run untrusted code safely: turns OFF file, shell, and\n");
  printf("                           network builtins (read/write/remember/get/system...).\n");
  printf("                           Works anywhere on the line; or set SPROUT_SANDBOX=1.\n");
}

/* --------------------------------------------------------- interactive (TUI) */
#define PROMPT  "  " C_GREEN "sprout " C_CYAN "\xE2\x96\xB8 " C_RESET   /* "sprout > " in colour */

static void console_setup(void) {
#ifdef _WIN32
  SetConsoleOutputCP(65001);                                   /* UTF-8 so the arrow + 🌱 render */
  HANDLE h = GetStdHandle(STD_OUTPUT_HANDLE); DWORD m;
  if (GetConsoleMode(h, &m)) SetConsoleMode(h, m | 0x0004);    /* ENABLE_VIRTUAL_TERMINAL_PROCESSING */
#endif
}

/* parse + run one snippet in the persistent REPL file scope (used by the REPL + run-a-file) */
static void run_snippet(const char *src) {
  ntok = 0; pos = 0;
  tokenize(src, (int)strlen(src));
  int n; Stmt **prog = parse_program(&n);
  for (int i = 0; i < n; i++) register_top(prog[i], cur_fileid, cur_file_env);
  exec_block(prog, n, cur_file_env);
  returning = 0; g_loopctl = 0;   /* don't let a stray flag carry over to the next snippet */
}

/* does this line open a block? (ends with ':' once trailing spaces/comment are removed) */
static int opens_block(const char *line) {
  int last = -1;
  for (int i = 0; line[i]; i++) {
    if (line[i] == '~') break;
    if (line[i] != ' ' && line[i] != '\t') last = i;
  }
  return last >= 0 && line[last] == ':';
}

static void banner(void) {
  printf("\n  " C_GREEN C_BOLD "Sprout" C_RESET " " C_DIM "v%s" C_RESET "  \xF0\x9F\x8C\xB1\n", SPROUT_VERSION);
  printf("  " C_DIM "a tiny language, written from scratch in C" C_RESET "\n\n");
}

static void repl(void) {
  printf("\n  " C_GREEN "Try Sprout live" C_RESET " " C_DIM "- type code, press Enter. 'back' returns to the menu." C_RESET "\n\n");
  sjmp_buf jb; err_jmp = &jb; g_top_jmp = &jb; repl_echo = 1; g_repl_active = 1;   /* allow re-`make` while experimenting */
  volatile int repl_fid = cur_fileid; Env * volatile repl_env = cur_file_env;   /* the session scope to restore after an error (read post-longjmp -> volatile) */
  char buf[8192]; buf[0] = 0; int inblock = 0; char line[1024];
  printf(PROMPT); fflush(stdout);
  while (fgets(line, sizeof line, stdin)) {
    size_t L = strlen(line); while (L && (line[L-1] == '\n' || line[L-1] == '\r')) line[--L] = 0;
    if (!inblock) {
      if (!strcmp(line, "back") || !strcmp(line, "quit") || !strcmp(line, "exit")) break;
      if (L == 0) { printf(PROMPT); fflush(stdout); continue; }
      if (opens_block(line)) { snprintf(buf, sizeof buf, "%s\n", line); inblock = 1; printf("  " C_DIM "...... " C_RESET); fflush(stdout); continue; }
      if (SJSET(jb) == 0) run_snippet(line); else { call_depth = 0; returning = 0; g_loopctl = 0; g_quiet_fail = 0; g_have_fail_override = 0; g_current_file = NULL; cur_fileid = repl_fid; cur_file_env = repl_env; }
      printf(PROMPT); fflush(stdout);
    } else if (L == 0) {                                        /* blank line ends the block */
      if (SJSET(jb) == 0) run_snippet(buf); else { call_depth = 0; returning = 0; g_loopctl = 0; g_quiet_fail = 0; g_have_fail_override = 0; g_current_file = NULL; cur_fileid = repl_fid; cur_file_env = repl_env; }
      buf[0] = 0; inblock = 0; printf(PROMPT); fflush(stdout);
    } else {
      size_t cur = strlen(buf); snprintf(buf + cur, sizeof buf - cur, "%s\n", line);
      printf("  " C_DIM "...... " C_RESET); fflush(stdout);
    }
  }
  err_jmp = NULL; g_top_jmp = NULL; repl_echo = 0; g_repl_active = 0; printf("\n");
}

static void run_file_prompt(void) {
  char line[1024];
  printf("\n  " C_GREEN "file" C_RESET " " C_CYAN "\xE2\x96\xB8 " C_RESET); fflush(stdout);
  if (!fgets(line, sizeof line, stdin)) return;
  size_t L = strlen(line); while (L && (line[L-1] == '\n' || line[L-1] == '\r' || line[L-1] == ' ' || line[L-1] == '"')) line[--L] = 0;
  char *path = line; while (*path == ' ' || *path == '"') path++;
  if (!*path) return;
  char *src = read_whole_file(path);
  if (!src) { printf("  " C_DIM "couldn't open '%s'" C_RESET "\n", path); return; }
  printf("\n");
  sjmp_buf jb; err_jmp = &jb; g_top_jmp = &jb; g_current_file = path;
  volatile int save_fid = cur_fileid; Env * volatile save_env = cur_file_env;   /* read after the longjmp -> volatile */
  cur_file_env = env_new(global_env); cur_fileid = ++g_next_fileid;   /* each run gets a fresh scope, so re-running works */
  if (SJSET(jb) != 0) { call_depth = 0; returning = 0; g_loopctl = 0; g_quiet_fail = 0; g_have_fail_override = 0; }
  else run_snippet(src);
  cur_fileid = save_fid; cur_file_env = save_env;                     /* restore the session scope */
  err_jmp = NULL; g_top_jmp = NULL; g_current_file = NULL;
  free(src);
}

static void wiz_help(void) {
  printf("\n  " C_BOLD "Sprout in a nutshell" C_RESET "\n\n");
  printf("    make x = 5                " C_DIM "make a variable" C_RESET "\n");
  printf("    show \"hi\", x              " C_DIM "print things" C_RESET "\n");
  printf("    when x > 3:               " C_DIM "a choice (orwhen / otherwise too)" C_RESET "\n");
  printf("    repeat 3 times:           " C_DIM "a loop (or: repeat while ...)" C_RESET "\n");
  printf("    for each i in range(3):   " C_DIM "walk a list / map / text" C_RESET "\n");
  printf("    make xs = [1, 2, 3]       " C_DIM "lists, and maps {name: \"Sam\"}" C_RESET "\n");
  printf("    task greet(who):          " C_DIM "your own action; 'give' hands a value back" C_RESET "\n\n");
  printf("  " C_DIM "Full guide: https://github.com/fizzexual/Sprout" C_RESET "\n");
}

static void wizard(void) {
  console_setup();
  global_env = env_new(NULL);                 /* the shared/public space */
  cur_file_env = env_new(global_env);         /* one persistent scope for this session */
  cur_fileid = ++g_next_fileid;
  for (;;) {
    banner();
    printf("  " C_BOLD "What would you like to do?" C_RESET "\n\n");
    printf("    " C_GREEN "1" C_RESET "  Try Sprout live\n");
    printf("    " C_GREEN "2" C_RESET "  Run a program " C_DIM "(.sprout file)" C_RESET "\n");
    printf("    " C_GREEN "3" C_RESET "  Help\n");
    printf("    " C_GREEN "4" C_RESET "  Quit\n\n");
    printf("  " C_CYAN "choose \xE2\x96\xB8 " C_RESET); fflush(stdout);
    char line[64];
    if (!fgets(line, sizeof line, stdin)) break;
    char c = line[0];
    if (c == '1') repl();
    else if (c == '2') run_file_prompt();
    else if (c == '3') wiz_help();
    else if (c == '4' || c == 'q' || c == 'Q') break;
    else printf("\n  " C_DIM "please pick 1-4." C_RESET "\n");
  }
  printf("\n  " C_GREEN "bye! \xF0\x9F\x8C\xB1" C_RESET "\n\n");
}

/* ----------------------------------------------------- filesystem helpers */
static int path_exists(const char *p) { FILE *f = fopen(p, "rb"); if (f) { fclose(f); return 1; } return 0; }

/* create every parent directory of a file path (like mkdir -p on the folder part) */
static void ensure_parent_dirs(const char *file) {
  char tmp[1024]; size_t L = strlen(file);
  if (L >= sizeof tmp) return;
  memcpy(tmp, file, L + 1);
  for (size_t i = 1; i < L; i++) {
    if (tmp[i] == '/' || tmp[i] == '\\') {
      char c = tmp[i]; tmp[i] = 0;
#ifdef _WIN32
      CreateDirectoryA(tmp, NULL);
#else
      mkdir(tmp, 0777);
#endif
      tmp[i] = c;
    }
  }
}

/* does this directory exist and contain anything? (so `sprout new` won't clobber it) */
static int dir_has_entries(const char *dir) {
#ifdef _WIN32
  char pat[1024]; snprintf(pat, sizeof pat, "%s\\*", dir);
  WIN32_FIND_DATAA fd; HANDLE h = FindFirstFileA(pat, &fd);
  if (h == INVALID_HANDLE_VALUE) return 0;          /* no such folder yet */
  int found = 0;
  do {
    if (strcmp(fd.cFileName, ".") && strcmp(fd.cFileName, "..")) { found = 1; break; }
  } while (FindNextFileA(h, &fd));
  FindClose(h);
  return found;
#else
  DIR *d = opendir(dir);
  if (!d) return 0;                                 /* no such folder yet */
  struct dirent *e; int found = 0;
  while ((e = readdir(d))) { if (strcmp(e->d_name, ".") && strcmp(e->d_name, "..")) { found = 1; break; } }
  closedir(d);
  return found;
#endif
}

/* ---------------------------------------------------------------- templates */
typedef struct { const char *path; const char *content; } TplFile;
typedef struct { const char *name; const char *desc; const TplFile *files; int nfiles; } Template;

/* every project shares one simple manifest + readme; the flagship 'app' adds modules + tests */
#define TOML_SIMPLE \
  "# This file is the project. Run everything with:  sprout build\n\n" \
  "project \"MyApp\"\n" \
  "main \"app.sprout\"\n\n" \
  "# As your project grows, add files here so they load together:\n" \
  "# include [\n" \
  "#     \"modules/thing.sprout\"\n" \
  "# ]\n"
#define README_SIMPLE \
  "# MyApp\n\nA Sprout project.\n\n## Run it\n\n    sprout build\n\n" \
  "`sprout build` reads `sprout.toml` and runs the `main` file.\n"

static const TplFile TPL_APP[] = {
  { "sprout.toml",
    "# This file ties the whole project together.\n"
    "# Run everything with:  sprout build\n\n"
    "project \"MyApp\"\n"
    "main \"app.sprout\"\n\n"
    "include [\n"
    "    \"modules/greeter.sprout\",\n"
    "    \"modules/server.sprout\"\n"
    "]\n" },
  { "app.sprout",
    "~ app.sprout - the entry point.  `sprout build` runs this last,\n"
    "~ after loading the modules listed in sprout.toml.\n\n"
    "use greeter\n"
    "use server\n\n"
    "show color(\"bold\", \"Welcome to MyApp!\")\n"
    "show greeter.greet(\"world\")\n\n"
    "server.start()\n" },
  { "modules/greeter.sprout",
    "~ The greeter module. 'public' means other files can call it as greeter.greet(...).\n\n"
    "public task greet(who):\n"
    "    give f\"Hello, {who}!\"\n" },
  { "modules/server.sprout",
    "~ The server module - it uses the greeter, and calls it as greeter.greet(...).\n"
    "~ 'public' tasks are reachable as server.<name>.  Plain tasks stay private to this file.\n\n"
    "use greeter\n\n"
    "public task start():\n"
    "    show color(\"cyan\", \"server: handling 2 requests...\")\n"
    "    show handle(\"Ada\")\n"
    "    show handle(\"Lin\")\n\n"
    "task handle(user):\n"
    "    ~ private helper - called bare (same file); greeter.greet is from another module\n"
    "    give f\"  200 OK  ->  {greeter.greet(user)}\"\n" },
  { "tests/test.sprout",
    "~ A test. Run the whole suite with:  sprout test\n"
    "use greeter\n\n"
    "test \"greet says hello\":\n"
    "    expect contains(greeter.greet(\"world\"), \"Hello\")\n" },
  { "README.md",
    "# MyApp\n\nA multi-file Sprout project.\n\n"
    "## Run it\n\n    sprout build\n\n"
    "That reads `sprout.toml`, loads every file, and runs `app.sprout` last.\n\n"
    "## Structure\n\n"
    "    sprout.toml        # the project: name, main file, files to include\n"
    "    app.sprout         # the entry point (main)\n"
    "    modules/\n"
    "      greeter.sprout   # task: greet(who)\n"
    "      server.sprout    # tasks: start(), handle(user)  - uses greeter\n"
    "    tests/\n"
    "      test.sprout      # a quick check\n\n"
    "## How files connect\n\n"
    "Put `use <name>` at the top of a file to import a module, then call its\n"
    "`public` tasks through its name:\n\n"
    "    use greeter            # import the greeter module\n"
    "    show greeter.greet(\"x\")  # call a public task as module.name(...)\n\n"
    "Each file keeps its own (private) tasks and variables; only `public` ones\n"
    "are reachable as `module.name`. Within a file you call your own tasks bare.\n\n"
    "Add a file by dropping it in (e.g. `modules/database.sprout`) and listing\n"
    "it under `include` in `sprout.toml`.\n" },
};
static const TplFile TPL_STARTER[] = {
  { "sprout.toml", TOML_SIMPLE },
  { "app.sprout",
    "~ Welcome to Sprout!  Edit me, then run:  sprout build\n"
    "make name = \"world\"\n"
    "show color(\"green\", f\"Hello, {name}!\")\n\n"
    "task greet(who):\n"
    "    give f\"Nice to meet you, {who}\"\n\n"
    "show greet(\"Sprout\")\n" },
  { "README.md", README_SIMPLE },
};
static const TplFile TPL_API[] = {
  { "sprout.toml", TOML_SIMPLE },
  { "app.sprout",
    "~ Fetch a web API and read it like a normal map - no libraries.\n"
    "make repo = json(get(\"https://api.github.com/repos/fizzexual/Sprout\"))\n\n"
    "show color(\"green\", \"name: \") + repo[\"name\"]\n"
    "show \"language:\", repo[\"language\"]\n"
    "show \"stars:\", repo[\"stargazers_count\"]\n\n"
    "~ Discover everything this API gives you:\n"
    "for each line in explore(repo):\n"
    "    show line\n" },
  { "README.md", README_SIMPLE },
};
static const TplFile TPL_CLI[] = {
  { "sprout.toml", TOML_SIMPLE },
  { "app.sprout",
    "~ A small interactive command-line tool.\n"
    "make name = ask(\"What's your name? \")\n"
    "show color(\"green\", \"Hi, \" + name + \"!\")\n\n"
    "make n = number(ask(\"Pick a number: \"))\n"
    "when n == nothing:\n"
    "    show color(\"red\", \"that wasn't a number\")\n"
    "otherwise:\n"
    "    show \"double is\", n * 2\n" },
  { "README.md", README_SIMPLE },
};
static const TplFile TPL_GAME[] = {
  { "sprout.toml", TOML_SIMPLE },
  { "app.sprout",
    "~ Guess the number between 1 and 10.\n"
    "make secret = random(1, 10)\n"
    "make won = no\n"
    "repeat while not won:\n"
    "    make g = number(ask(\"Your guess (1-10): \"))\n"
    "    when g == nothing:\n"
    "        show color(\"red\", \"please type a number\")\n"
    "    orwhen g == secret:\n"
    "        show color(\"green\", \"You got it!\")\n"
    "        set won = yes\n"
    "    orwhen g < secret:\n"
    "        show \"higher...\"\n"
    "    otherwise:\n"
    "        show \"lower...\"\n" },
  { "README.md", README_SIMPLE },
};

static const Template TEMPLATES[] = {
  { "app",     "a full multi-file project (sprout.toml + modules + tests)", TPL_APP, 6 },
  { "starter", "a tiny one-file project to start from",                     TPL_STARTER, 3 },
  { "api",     "fetch a web API and read it (get / json / explore)",        TPL_API, 3 },
  { "cli",     "an interactive command-line tool (ask + color)",            TPL_CLI, 3 },
  { "game",    "a guess-the-number game",                                   TPL_GAME, 3 },
};
static const int NTEMPLATES = (int)(sizeof TEMPLATES / sizeof TEMPLATES[0]);

#ifdef _WIN32
static void wipe_dir(const char *dir) {
  char pat[1024]; snprintf(pat, sizeof pat, "%s\\*", dir);
  WIN32_FIND_DATAA fd; HANDLE h = FindFirstFileA(pat, &fd);
  if (h == INVALID_HANDLE_VALUE) return;
  do {
    if (!strcmp(fd.cFileName, ".") || !strcmp(fd.cFileName, "..")) continue;
    char full[1024]; snprintf(full, sizeof full, "%s\\%s", dir, fd.cFileName);
    if (fd.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) {
      /* a junction/symlink: remove the LINK itself, NEVER recurse into its real target */
      SetFileAttributesA(full, FILE_ATTRIBUTE_NORMAL);
      if (fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) RemoveDirectoryA(full); else DeleteFileA(full);
    } else if (fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) { wipe_dir(full); RemoveDirectoryA(full); }
    else { SetFileAttributesA(full, FILE_ATTRIBUTE_NORMAL); DeleteFileA(full); }
  } while (FindNextFileA(h, &fd));
  FindClose(h);
}
static void wipe_cwd(void) { wipe_dir("."); }
#else
static void wipe_cwd(void) { int rc = system("rm -rf -- ./* ./.[!.]* 2>/dev/null"); (void)rc; }
#endif

static const Template *find_template(const char *name) {
  for (int i = 0; i < NTEMPLATES; i++) if (!strcmp(name, TEMPLATES[i].name)) return &TEMPLATES[i];
  return NULL;
}

/* write a template's files; if destdir is non-empty, everything lands under destdir/ */
static int scaffold(const Template *t, const char *destdir) {
  for (int i = 0; i < t->nfiles; i++) {
    char full[1024];
    if (destdir && *destdir) {
      int r = snprintf(full, sizeof full, "%s/%s", destdir, t->files[i].path);
      if (r < 0 || (size_t)r >= sizeof full) { fprintf(stderr, "  path too long, skipped: %s\n", t->files[i].path); continue; }
    } else { size_t L = strlen(t->files[i].path); if (L >= sizeof full) continue; memcpy(full, t->files[i].path, L + 1); }
    ensure_parent_dirs(full);
    FILE *f = fopen(full, "wb");
    if (!f) { fprintf(stderr, "  couldn't write %s\n", full); continue; }
    fputs(t->files[i].content, f); fclose(f);
    printf("    " C_GREEN "+" C_RESET " %s\n", full);
  }
  return 0;
}

static void list_templates(void) {
  printf("\n  " C_GREEN C_BOLD "Sprout templates" C_RESET "\n\n");
  for (int i = 0; i < NTEMPLATES; i++)
    printf("    " C_GREEN "%-9s" C_RESET " %s\n", TEMPLATES[i].name, TEMPLATES[i].desc);
  printf("\n  New project:    " C_CYAN "sprout new <folder> [template]" C_RESET "\n");
  printf("  In this folder: " C_CYAN "sprout template load <template>" C_RESET "\n\n");
}

static int cmd_template(int argc, char **argv) {
  console_setup();
  if (argc < 3 || !strcmp(argv[2], "list")) { list_templates(); return 0; }
  if (!strcmp(argv[2], "load")) {
    if (argc < 4) { fprintf(stderr, "  Which template? Try:  sprout template load app\n"); return 1; }
    const Template *t = find_template(argv[3]);
    if (!t) { fprintf(stderr, "  No template called '%s'. Try:  sprout template list\n", argv[3]); return 1; }
    printf("\n  \x1b[33mWARNING:\x1b[0m this will " C_BOLD "DELETE everything in the current folder" C_RESET "\n");
    printf("  and replace it with the '%s' template.\n\n", t->name);
    printf("  Type " C_GREEN "yes" C_RESET " to continue: "); fflush(stdout);
    char line[64]; if (!fgets(line, sizeof line, stdin)) return 1;
    size_t L = strlen(line); while (L && (line[L-1]=='\n'||line[L-1]=='\r'||line[L-1]==' ')) line[--L] = 0;
    if (strcmp(line, "yes") != 0) { printf("  Cancelled - nothing was changed.\n"); return 0; }
    wipe_cwd();
    scaffold(t, NULL);
    printf("\n  " C_GREEN "Created the '%s' template." C_RESET "  Run it:  " C_CYAN "sprout build" C_RESET "\n\n", t->name);
    return 0;
  }
  fprintf(stderr, "  Usage:  sprout template list   |   sprout template load <name>\n");
  return 1;
}

/* sprout new <folder> [template] - scaffold a brand-new project folder (never wipes) */
static int cmd_new(int argc, char **argv) {
  console_setup();
  if (argc < 3) { fprintf(stderr, "\n  Usage:  sprout new <folder> [template]\n  Example:  sprout new chat-app\n\n"); return 1; }
  const char *name = argv[2];
  if (strstr(name, "..")) { fprintf(stderr, "  Please pick a simple folder name (no '..').\n"); return 1; }
  if (name[0] == '/' || name[0] == '\\' || (name[0] && name[1] == ':')) {
    fprintf(stderr, "  Please pick a folder name, not an absolute path (e.g.  sprout new chat-app).\n"); return 1;
  }
  const char *tplname = (argc >= 4) ? argv[3] : "app";
  const Template *t = find_template(tplname);
  if (!t) { fprintf(stderr, "  No template called '%s'. Try:  sprout template list\n", tplname); return 1; }
  if (dir_has_entries(name)) { fprintf(stderr, "\n  The folder '%s' already exists and isn't empty.\n  Pick another name, or use it in place:  sprout template load %s\n\n", name, tplname); return 1; }
  printf("\n  " C_GREEN C_BOLD "Creating %s" C_RESET " " C_DIM "(%s template)" C_RESET "\n\n", name, t->name);
  scaffold(t, name);
  printf("\n  " C_GREEN "Done!" C_RESET "  Next:\n");
  printf("    " C_CYAN "cd %s" C_RESET "\n", name);
  printf("    " C_CYAN "sprout build" C_RESET "\n\n");
  return 0;
}

static int cmd_api(const char *url) {
  console_setup();
  char *body = http_get(url);
  if (!body) { fprintf(stderr, "  Couldn't reach %s\n", url); return 1; }
  Value v = parse_json(body);
  if (v.type != V_MAP && v.type != V_LIST) { printf("%s\n", body); return 0; }
  SList *out = list_new();
  explore_flatten(v, "", out, 0);
  printf("\n  " C_BOLD "%s" C_RESET "\n  " C_DIM "%d readable fields:" C_RESET "\n\n", url, out->n);
  for (int i = 0; i < out->n; i++) printf("    %s\n", stringify(out->items[i]));
  printf("\n");
  return 0;
}

/* ----------------------------------------------------- project / modules */
/* the include map from sprout.toml: a module name (e.g. "server") -> its file path */
static char **g_modname = NULL, **g_modpath = NULL; static int g_nmod = 0, g_capmod = 0;
static char **g_incpath = NULL; static int g_ninc = 0, g_capinc = 0;   /* include[] in listed order */
static char *g_main_file = NULL, *g_project_name = NULL;
static int  g_toml_done = 0;

/* the set of already-loaded files (by canonical path) so each loads exactly once */
static char **g_loaded = NULL; static int g_nloaded = 0, g_caploaded = 0;

static char *canon_path(const char *p) {
#ifdef _WIN32
  char buf[1024];
  if (_fullpath(buf, p, sizeof buf)) { for (char *c = buf; *c; c++) *c = (char)tolower((unsigned char)*c); return dup_str(buf); }
#else
  char buf[PATH_MAX];
  if (realpath(p, buf)) return dup_str(buf);   /* so './a.sprout' and 'a.sprout' dedup to one file */
#endif
  return dup_str(p);
}
static int loaded_has(const char *c) { for (int i = 0; i < g_nloaded; i++) if (!strcmp(g_loaded[i], c)) return 1; return 0; }
static void loaded_add(const char *c) {
  if (g_nloaded >= g_caploaded) { g_caploaded = g_caploaded ? g_caploaded * 2 : 8; g_loaded = (char **)realloc(g_loaded, g_caploaded * sizeof(char *)); }
  g_loaded[g_nloaded++] = dup_str(c);
}

/* the module name for a path: drop the folder and the .sprout extension */
static char *module_basename(const char *path) {
  const char *b = path;
  for (const char *p = path; *p; p++) if (*p == '/' || *p == '\\') b = p + 1;
  int n = (int)strlen(b);
  if (n > 7 && !strcmp(b + n - 7, ".sprout")) n -= 7;
  char *r = (char *)malloc(n + 1); memcpy(r, b, n); r[n] = 0; return r;
}
static void map_add(const char *name, const char *path) {
  for (int i = 0; i < g_nmod; i++) if (!strcmp(g_modname[i], name)) return;   /* first mention wins */
  if (g_nmod >= g_capmod) { g_capmod = g_capmod ? g_capmod * 2 : 8;
    g_modname = (char **)realloc(g_modname, g_capmod * sizeof(char *));
    g_modpath = (char **)realloc(g_modpath, g_capmod * sizeof(char *)); }
  g_modname[g_nmod] = dup_str(name); g_modpath[g_nmod] = dup_str(path); g_nmod++;
}
static void inc_add(const char *path) {
  if (g_ninc >= g_capinc) { g_capinc = g_capinc ? g_capinc * 2 : 8; g_incpath = (char **)realloc(g_incpath, g_capinc * sizeof(char *)); }
  g_incpath[g_ninc++] = dup_str(path);
}

/* read the next "..." string on the CURRENT line (so a value-less key can't steal the next line's) */
static char *toml_string(const char *s, int *i, int len) {
  while (*i < len && s[*i] != '"' && s[*i] != '\n') (*i)++;
  if (*i >= len || s[*i] != '"') return NULL;          /* no string before end of line */
  (*i)++; int start = *i;
  while (*i < len && s[*i] != '"' && s[*i] != '\n') (*i)++;   /* an unterminated quote ends at the line */
  int n = *i - start; char *r = (char *)malloc(n + 1); memcpy(r, s + start, n); r[n] = 0;
  if (*i < len && s[*i] == '"') (*i)++;
  return r;
}

/* parse sprout.toml (if present in the current folder): project name / main file / include map */
static void toml_load(void) {
  if (g_toml_done) return;
  g_toml_done = 1;
  char *s = read_whole_file("sprout.toml");
  if (!s) return;
  int len = (int)strlen(s), i = 0;
  while (i < len) {
    char c = s[i];
    if (c == '#' || c == '~') { while (i < len && s[i] != '\n') i++; continue; }   /* comment to end of line */
    if (isalpha((unsigned char)c)) {
      int st = i; while (i < len && isalpha((unsigned char)s[i])) i++;
      int wl = i - st;
      if (wl == 7 && !strncmp(s + st, "project", 7)) { char *v = toml_string(s, &i, len); if (v) { free(g_project_name); g_project_name = v; } }
      else if (wl == 4 && !strncmp(s + st, "main", 4)) { char *v = toml_string(s, &i, len); if (v) { free(g_main_file); g_main_file = v; } }
      else if (wl == 7 && !strncmp(s + st, "include", 7)) {
        while (i < len && s[i] != '[' && s[i] != '\n') i++;          /* find the opening bracket */
        if (i < len && s[i] == '[') {
          i++;
          while (i < len && s[i] != ']') {
            if (s[i] == '"') { char *v = toml_string(s, &i, len); if (v) { inc_add(v); char *nm = module_basename(v); map_add(nm, v); free(nm); free(v); } }
            else if (s[i] == '#' || s[i] == '~') { while (i < len && s[i] != '\n') i++; }
            else i++;
          }
        }
      }
    } else i++;
  }
  free(s);
  if (g_main_file) { char *nm = module_basename(g_main_file); map_add(nm, g_main_file); free(nm); }
}

/* turn a `use` target into a file path: a path as-is, or a bare name via the map / common folders */
static char *resolve_module(const char *name) {
  toml_load();
  int looks_path = strstr(name, ".sprout") || strchr(name, '/') || strchr(name, '\\');
  if (looks_path) return path_exists(name) ? dup_str(name) : NULL;
  for (int i = 0; i < g_nmod; i++) if (!strcmp(g_modname[i], name)) return dup_str(g_modpath[i]);
  const char *pre[] = { "", "modules/", "src/", "lib/", "sprout_packages/" };
  char buf[1024];
  for (int k = 0; k < (int)(sizeof pre / sizeof pre[0]); k++) { snprintf(buf, sizeof buf, "%s%s.sprout", pre[k], name); if (path_exists(buf)) return dup_str(buf); }
  return NULL;
}

/* parse one file into a fresh AST (token strings live in the AST, so re-parsing is safe) */
static Stmt **parse_file(const char *path, int *n) {
  char *src = read_whole_file(path);
  if (!src) { char m[600]; snprintf(m, sizeof m, "I couldn't open the file '%s'.", path); fail(0, m); return NULL; }
  /* A lex/parse error is a code mistake, never a runtime condition - it must NOT be caught by a try:.
     This matters when a `use` inside a try loads a module with a syntax error: suppress the try's catch
     for the whole tokenize+parse, then hand the try-state back to the enclosing runtime on success. */
  int saved_quiet = g_quiet_fail; g_quiet_fail = 0;
  ntok = 0; pos = 0;
  tokenize(src, (int)strlen(src));
  Stmt **prog = parse_program(n);
  g_quiet_fail = saved_quiet;
  free(src);
  return prog;
}

/* load another project file once: register its tasks, then run its top level */
static void load_module(const char *name) {
  char *path = resolve_module(name);
  if (!path) { char m[400]; snprintf(m, sizeof m, "I couldn't find a module called '%s' to use. (looked in sprout.toml, modules/, src/, lib/)", name); fail(0, m); return; }
  char *c = canon_path(path);
  if (loaded_has(c)) { free(path); free(c); return; }
  const char *prev = g_current_file; g_current_file = path;
  int n; Stmt **prog = parse_file(path, &n);   /* parse first: a parse error here must NOT poison the dedup set */
  loaded_add(c); free(c);                       /* commit only after a clean parse (still set before exec, so cycles break) */
  Env *fe = env_new(global_env);               /* this file's own scope (its privates live here) */
  int prevfid = cur_fileid; Env *prevfe = cur_file_env;
  cur_fileid = ++g_next_fileid; cur_file_env = fe;
  { char *base = module_basename(path); modns_register(base, cur_fileid, fe); free(base); }   /* reachable as base.member */
  for (int i = 0; i < n; i++) register_top(prog[i], cur_fileid, fe);
  exec_block(prog, n, fe);
  returning = 0;                 /* a module's top-level `give` (if any) doesn't return to the user */
  cur_fileid = prevfid; cur_file_env = prevfe;
  g_current_file = prev;
}

/* sprout build - read sprout.toml, load every file, run the main file last */
static int cmd_build(void) {
  console_setup();
  toml_load();
  if (!path_exists("sprout.toml")) {
    fprintf(stderr, "\n  No " C_BOLD "sprout.toml" C_RESET " here.  Start a project with:  " C_CYAN "sprout new myapp" C_RESET "\n  or run one file directly:  " C_CYAN "sprout run app.sprout" C_RESET "\n\n");
    return 1;
  }
  const char *mainf = g_main_file ? g_main_file : "app.sprout";
  printf("\n  " C_GREEN C_BOLD "Building %s" C_RESET "\n\n", g_project_name ? g_project_name : "project");
  global_env = env_new(NULL);
  sjmp_buf jb; err_jmp = &jb; g_top_jmp = &jb;
  if (SJSET(jb) != 0) { err_jmp = NULL; g_top_jmp = NULL; g_current_file = NULL; call_depth = 0; returning = 0; g_loopctl = 0; g_quiet_fail = 0; g_have_fail_override = 0; return 1; }
  char *mainc = canon_path(mainf);
  for (int i = 0; i < g_ninc; i++) {                            /* libraries first... */
    char *ic = canon_path(g_incpath[i]); int is_main = !strcmp(ic, mainc); free(ic);
    if (is_main) continue;                                      /* ...but never the entry file here */
    load_module(g_incpath[i]);
  }
  free(mainc);
  load_module(mainf);                                           /* entry point genuinely last */
  err_jmp = NULL; g_top_jmp = NULL;
  return test_report();   /* if the project ran any tests, report + set the exit code */
}

/* -------------------------------------------------------------------- tests */
static int test_report(void) {
  if (g_tpass + g_tfail == 0) return 0;
  printf("\n  " C_BOLD "%d passed" C_RESET, g_tpass);
  if (g_tfail) printf(", " C_RED C_BOLD "%d failed" C_RESET, g_tfail);
  printf("\n\n");
  return g_tfail > 0 ? 1 : 0;
}

/* run one file for its tests, in its own scope (per-test failures are tolerated) */
static void run_test_file(const char *path) {
  char *src = read_whole_file(path);
  if (!src) { printf("  " C_DIM "couldn't open %s" C_RESET "\n", path); return; }
  printf("\n  " C_DIM "%s" C_RESET "\n", path);
  ntok = 0; pos = 0;
  tokenize(src, (int)strlen(src));
  int n; Stmt **prog = parse_program(&n);
  free(src);
  const char *prev = g_current_file; g_current_file = path;
  Env *fe = env_new(global_env);
  int pf = cur_fileid; Env *pe = cur_file_env;
  cur_fileid = ++g_next_fileid; cur_file_env = fe;
  { char *base = module_basename(path); modns_register(base, cur_fileid, fe); free(base); }
  for (int i = 0; i < n; i++) register_top(prog[i], cur_fileid, fe);
  exec_block(prog, n, fe);
  returning = 0;
  cur_fileid = pf; cur_file_env = pe; g_current_file = prev;
}

/* sprout test [file] - run a test file, or every .sprout in the tests folder */
static int cmd_test(int argc, char **argv) {
  console_setup();
  toml_load();
  global_env = env_new(NULL);
  cur_file_env = env_new(global_env); cur_fileid = ++g_next_fileid;
  sjmp_buf jb; err_jmp = &jb; g_top_jmp = &jb;
  if (SJSET(jb) != 0) { err_jmp = NULL; g_top_jmp = NULL; g_current_file = NULL; call_depth = 0; returning = 0; g_loopctl = 0; g_quiet_fail = 0; g_have_fail_override = 0; test_report(); return 1; }
  if (argc >= 3) {
    run_test_file(argv[2]);
  } else {
    int found = 0;
#ifdef _WIN32
    WIN32_FIND_DATAA fd; HANDLE h = FindFirstFileA("tests\\*.sprout", &fd);
    if (h != INVALID_HANDLE_VALUE) { do { char p[600]; snprintf(p, sizeof p, "tests/%s", fd.cFileName); run_test_file(p); found = 1; } while (FindNextFileA(h, &fd)); FindClose(h); }
#else
    DIR *d = opendir("tests");
    if (d) { struct dirent *e; while ((e = readdir(d))) { size_t L = strlen(e->d_name); if (L > 7 && !strcmp(e->d_name + L - 7, ".sprout")) { char p[600]; snprintf(p, sizeof p, "tests/%s", e->d_name); run_test_file(p); found = 1; } } closedir(d); }
#endif
    if (!found) { fprintf(stderr, "\n  No tests found. Put them in a tests/ folder, or run one:  sprout test mytests.sprout\n\n"); err_jmp = NULL; g_top_jmp = NULL; return 1; }
  }
  err_jmp = NULL; g_top_jmp = NULL;
  return test_report();
}

/* ===================== standalone bundles: ship a program as one executable =====================
   `sprout bundle app.sprout` copies this interpreter and appends the script plus a trailer:
   [interpreter bytes][script bytes][MAGIC(16)][script length (8 bytes, little-endian)].
   At startup the interpreter reads its own tail; if the MAGIC is there it runs the embedded
   script instead of reading the command line. The OS loader ignores bytes appended after a
   valid PE/ELF executable, so the combined file still runs. Single-file programs (plus built-in
   modules like `use system`); a program that `use`s other files isn't bundled with them yet. */
#define SB_MAGIC "SPROUT_BUNDLE_01"
#define SB_MAGIC_LEN 16
#define SB_TRAILER (SB_MAGIC_LEN + 8)

static char *self_exe_path(void) {   /* the path to THIS running executable, or NULL */
#ifdef _WIN32
  char buf[1024]; DWORD n = GetModuleFileNameA(NULL, buf, (DWORD)sizeof buf);
  if (n == 0 || n >= sizeof buf) return NULL;
  return dup_str(buf);
#elif defined(__APPLE__)
  char buf[4096]; uint32_t sz = sizeof buf;
  if (_NSGetExecutablePath(buf, &sz) != 0) return NULL;
  return dup_str(buf);
#else
  char buf[4096]; ssize_t n = readlink("/proc/self/exe", buf, sizeof buf - 1);
  if (n <= 0) return NULL;
  buf[n] = 0;
  return dup_str(buf);
#endif
}
static unsigned char *read_bytes(const char *path, long *len) {   /* whole file as bytes; NULL on failure */
  FILE *f = fopen(path, "rb"); if (!f) return NULL;
  if (fseek(f, 0, SEEK_END) != 0) { fclose(f); return NULL; }
  long n = ftell(f); if (n < 0) { fclose(f); return NULL; }
  fseek(f, 0, SEEK_SET);
  unsigned char *buf = (unsigned char *)malloc((size_t)n + 1); if (!buf) { fclose(f); return NULL; }
  size_t got = fread(buf, 1, (size_t)n, f); fclose(f); buf[got] = 0; *len = (long)got; return buf;
}
/* if this exe has a script baked into its tail, return it (null-terminated, malloc'd), else NULL.
   Reads only the small trailer in the common (un-bundled) case, so startup stays fast. */
static char *embedded_script(void) {
  char *path = self_exe_path(); if (!path) return NULL;
  FILE *f = fopen(path, "rb"); free(path); if (!f) return NULL;
  if (fseek(f, 0, SEEK_END) != 0) { fclose(f); return NULL; }
  long total = ftell(f);
  if (total < SB_TRAILER) { fclose(f); return NULL; }
  unsigned char tr[SB_TRAILER];
  fseek(f, total - SB_TRAILER, SEEK_SET);
  if (fread(tr, 1, SB_TRAILER, f) != (size_t)SB_TRAILER || memcmp(tr, SB_MAGIC, SB_MAGIC_LEN) != 0) { fclose(f); return NULL; }
  unsigned long slen = 0; for (int i = 0; i < 8; i++) slen |= (unsigned long)tr[SB_MAGIC_LEN + i] << (8 * i);
  if (slen == 0 || (long)slen > total - SB_TRAILER) { fclose(f); return NULL; }
  char *src = (char *)malloc(slen + 1);
  fseek(f, total - SB_TRAILER - (long)slen, SEEK_SET);
  size_t got = fread(src, 1, slen, f); fclose(f);
  src[got] = 0; return src;
}
static int cmd_bundle(int argc, char **argv) {
  console_setup();
  if (argc < 3) { fprintf(stderr, "\n  Usage:  sprout bundle <app.sprout> [-o <output>]\n\n"); return 1; }
  const char *script = argv[2]; const char *out = NULL;
  for (int i = 3; i + 1 < argc; i++) if (!strcmp(argv[i], "-o")) out = argv[i + 1];
  char outbuf[1024];
  if (!out) {   /* default: the script's base name (+ .exe on Windows) */
    const char *b = script; for (const char *p = script; *p; p++) if (*p == '/' || *p == '\\') b = p + 1;
    int bl = (int)strlen(b); if (bl > 7 && !strcmp(b + bl - 7, ".sprout")) bl -= 7;
#ifdef _WIN32
    snprintf(outbuf, sizeof outbuf, "%.*s.exe", bl, b);
#else
    snprintf(outbuf, sizeof outbuf, "%.*s", bl, b);
#endif
    out = outbuf;
  }
#ifdef _WIN32
  else if (strlen(out) < 4 || strcmp(out + strlen(out) - 4, ".exe") != 0) {   /* a Windows exe must end in .exe to launch by name */
    snprintf(outbuf, sizeof outbuf, "%s.exe", out); out = outbuf;
  }
#endif
  char *self = self_exe_path();
  if (!self) { fprintf(stderr, "  I couldn't find my own program file to copy.\n"); return 1; }
  long ilen; unsigned char *interp = read_bytes(self, &ilen); free(self);
  if (!interp) { fprintf(stderr, "  I couldn't read my own program file.\n"); return 1; }
  if (ilen >= SB_TRAILER && memcmp(interp + ilen - SB_TRAILER, SB_MAGIC, SB_MAGIC_LEN) == 0) {   /* strip an old bundle */
    unsigned long old = 0; for (int i = 0; i < 8; i++) old |= (unsigned long)interp[ilen - 8 + i] << (8 * i);
    if ((long)(old + SB_TRAILER) <= ilen) ilen -= (long)(old + SB_TRAILER);
  }
  long slen; unsigned char *src = read_bytes(script, &slen);
  if (!src) { free(interp); fprintf(stderr, "  I couldn't open the script: %s\n", script); return 1; }
  FILE *o = fopen(out, "wb");
  if (!o) { free(interp); free(src); fprintf(stderr, "  I couldn't create %s\n", out); return 1; }
  fwrite(interp, 1, (size_t)ilen, o);
  fwrite(src, 1, (size_t)slen, o);
  fwrite(SB_MAGIC, 1, SB_MAGIC_LEN, o);
  unsigned char lenbytes[8]; for (int i = 0; i < 8; i++) lenbytes[i] = (unsigned char)((unsigned long)slen >> (8 * i));
  fwrite(lenbytes, 1, 8, o);
  fclose(o); free(interp); free(src);
#ifndef _WIN32
  chmod(out, 0755);
#endif
  printf("\n  " C_GREEN C_BOLD "Bundled" C_RESET " %s into a standalone program:  " C_CYAN "%s" C_RESET "\n  Run it directly — no Sprout needed.\n\n", script, out);
  return 0;
}

/* ===================== `sprout format` — a code formatter =====================
   Re-indents to 4 spaces per block level, trims trailing whitespace, collapses blank runs, and
   ends the file with one newline. Every comment and token is preserved; lines inside a multi-line
   ( [ { literal are left exactly as written. Structure-preserving (it only changes insignificant
   whitespace) and idempotent. Defaults to printing to stdout — `--write` edits in place. */
static int fmt_bracket_delta(const char *s, const char *e) {   /* net () [] {} on a line, ignoring strings/comments */
  int d = 0, instr = 0;
  for (const char *p = s; p < e; p++) {
    if (instr) { if (*p == '\\' && p + 1 < e) p++; else if (*p == '"') instr = 0; continue; }
    if (*p == '"') instr = 1;
    else if (*p == '~') break;
    else if (*p == '(' || *p == '[' || *p == '{') d++;
    else if (*p == ')' || *p == ']' || *p == '}') d--;
  }
  return d;
}
static char *format_source(const char *src) {
  size_t cap = strlen(src) * 2 + 256, len = 0; char *out = (char *)malloc(cap);
  int stack[256], sp = 0; stack[0] = 0;     /* original indent widths; depth = sp */
  int bracket = 0, blanks = 0;
  for (const char *p = src; *p; ) {
    const char *ls = p; while (*p && *p != '\n') p++;
    const char *le = p; if (*p == '\n') p++;
    const char *c = ls; int iw = 0;
    while (c < le && (*c == ' ' || *c == '\t')) { iw += (*c == '\t') ? 4 : 1; c++; }
    const char *ce = le; while (ce > c && (ce[-1] == ' ' || ce[-1] == '\t' || ce[-1] == '\r')) ce--;
    int clen = (int)(ce - c);
    if (len + (size_t)(le - ls) + 1200 > cap) { cap = (len + (size_t)(le - ls) + 1200) * 2; out = (char *)realloc(out, cap); }
    if (bracket > 0) {                        /* inside a multi-line literal: keep the line as written */
      if (clen > 0) { size_t n = (size_t)(ce - ls); memcpy(out + len, ls, n); len += n; }
      out[len++] = '\n'; bracket += fmt_bracket_delta(c, ce); blanks = 0; continue;
    }
    if (clen == 0) { if (++blanks <= 1) out[len++] = '\n'; continue; }   /* collapse blank runs to one */
    blanks = 0;
    int depth;
    if (*c != '~') {                          /* a real statement opens/closes the block level */
      while (sp > 0 && iw < stack[sp]) sp--;
      if (iw > stack[sp] && sp < 255) stack[++sp] = iw;
      depth = sp;
    } else {                                  /* a comment keeps the block level, but indents to ITS OWN column */
      depth = sp;
      while (depth > 0 && iw < stack[depth]) depth--;
    }
    for (int i = 0; i < depth * 4; i++) out[len++] = ' ';
    memcpy(out + len, c, (size_t)clen); len += (size_t)clen;
    out[len++] = '\n';
    bracket += fmt_bracket_delta(c, ce);
  }
  while (len > 1 && out[len - 1] == '\n' && out[len - 2] == '\n') len--;   /* exactly one trailing newline */
  if (len > 0 && out[len - 1] != '\n') out[len++] = '\n';
  out[len] = 0; return out;
}
static int cmd_format(int argc, char **argv) {
  console_setup();
  if (argc < 3) { fprintf(stderr, "\n  Usage:  sprout format <file.sprout> [--write] [--check]\n\n"); return 1; }
  const char *file = NULL; int dowrite = 0, docheck = 0;
  for (int i = 2; i < argc; i++) {   /* flags work in any position; the first non-flag is the file */
    if (!strcmp(argv[i], "--write") || !strcmp(argv[i], "-w")) dowrite = 1;
    else if (!strcmp(argv[i], "--check")) docheck = 1;
    else if (!file) file = argv[i];
  }
  if (!file) { fprintf(stderr, "\n  Usage:  sprout format <file.sprout> [--write] [--check]\n\n"); return 1; }
  int slen; char *src = read_file(file, &slen);
  char *fmt = format_source(src);
  int changed = (strcmp(src, fmt) != 0);
  int rc = 0;
  if (docheck) {
    if (changed) { fprintf(stderr, "  %s is not formatted (run: sprout format %s --write).\n", file, file); rc = 1; }
    else printf("  %s is already formatted.\n", file);
  } else if (dowrite) {
    if (changed) { FILE *f = fopen(file, "wb"); if (!f) { fprintf(stderr, "  I couldn't write %s\n", file); rc = 1; } else { fwrite(fmt, 1, strlen(fmt), f); fclose(f); printf("  Formatted %s\n", file); } }
    else printf("  %s is already formatted.\n", file);
  } else {
#ifdef _WIN32
    fflush(stdout); _setmode(_fileno(stdout), _O_BINARY);   /* emit clean LF, not CRLF */
#endif
    fwrite(fmt, 1, strlen(fmt), stdout);
  }
  free(src); free(fmt); return rc;
}

/* ===================== packages: `sprout add` / `install` / `remove` =====================
   A tiny package manager. A package is a Sprout file that exposes `public` tasks. `sprout add`
   fetches it — from a local path, an http(s) URL, or a `github:user/repo` shorthand — into
   sprout_packages/<name>.sprout and records it in the `sprout.packages` manifest; `use <name>`
   then finds it (sprout_packages/ is on the module search path). `sprout install` re-fetches
   everything in the manifest, so you can share a project without committing its packages. No
   central registry — a source is a path or URL you choose to trust. */
#define PKG_DIR "sprout_packages"
#define PKG_MANIFEST "sprout.packages"

static void pkg_name_of(const char *source, char *out, size_t outsz) {   /* a package's name from its source */
  const char *s = source;
  if (!strncmp(s, "github:", 7)) s += 7;
  const char *b = s;
  for (const char *p = s; *p; p++) if (*p == '/' || *p == '\\') b = p + 1;
  size_t n = strlen(b);
  if (n > 7 && !strcmp(b + n - 7, ".sprout")) n -= 7;
  if (n >= outsz) n = outsz - 1;
  memcpy(out, b, n); out[n] = 0;
}
static char *pkg_fetch(const char *source) {   /* a package's source text, or NULL */
  if (!strncmp(source, "http://", 7) || !strncmp(source, "https://", 8)) return http_get(source);
  if (!strncmp(source, "github:", 7)) {
    const char *spec = source + 7;             /* user/repo  ->  raw .../user/repo/main/repo.sprout */
    const char *slash = strchr(spec, '/');
    if (!slash || !slash[1]) return NULL;
    char url[700]; snprintf(url, sizeof url, "https://raw.githubusercontent.com/%s/main/%s.sprout", spec, slash + 1);
    return http_get(url);
  }
  return read_whole_file(source);              /* a local path */
}
static int pkg_install_one(const char *name, const char *source) {   /* fetch + write the package file */
  char *content = pkg_fetch(source);
  if (!content) { fprintf(stderr, "  Couldn't fetch package '%s' from %s\n", name, source); return 1; }
  char path[1024]; snprintf(path, sizeof path, "%s/%s.sprout", PKG_DIR, name);
  ensure_parent_dirs(path);
  FILE *f = fopen(path, "wb");
  if (!f) { free(content); fprintf(stderr, "  Couldn't write %s\n", path); return 1; }
  fwrite(content, 1, strlen(content), f); fclose(f); free(content);
  return 0;
}
static void pkg_manifest_set(const char *name, const char *source) {   /* one line per name in the manifest */
  char *old = read_whole_file(PKG_MANIFEST);
  FILE *f = fopen(PKG_MANIFEST, "wb");
  if (!f) { free(old); return; }
  if (!old || !old[0]) fputs("# Sprout packages: `sprout add` records here, `sprout install` restores them.\n", f);
  if (old) { for (char *line = strtok(old, "\n"); line; line = strtok(NULL, "\n")) {
      char ln[256] = ""; sscanf(line, "%255s", ln);
      if (line[0] && strcmp(ln, name) != 0) fprintf(f, "%s\n", line);
  } }
  fprintf(f, "%s %s\n", name, source);
  fclose(f); free(old);
}
static int cmd_add(int argc, char **argv) {
  console_setup();
  if (argc < 3) { fprintf(stderr, "\n  Usage:  sprout add <path | https://... | github:user/repo> [name]\n\n"); return 1; }
  const char *source = argv[2];
  char name[256];
  if (argc >= 4) snprintf(name, sizeof name, "%s", argv[3]); else pkg_name_of(source, name, sizeof name);
  if (!name[0]) { fprintf(stderr, "  I couldn't work out a package name — pass one:  sprout add %s <name>\n", source); return 1; }
  /* the manifest is one whitespace-separated line per package, so a name/source with a space
     could be added but never restored by `sprout install`. Reject it up front with a clear message. */
  for (const char *q = source; *q; q++) if (*q==' '||*q=='\t') { fprintf(stderr, "  A package source can't contain spaces (the manifest is space-separated): %s\n", source); return 1; }
  for (const char *q = name; *q; q++) if (*q==' '||*q=='\t') { fprintf(stderr, "  A package name can't contain spaces: %s\n", name); return 1; }
  if (pkg_install_one(name, source) != 0) return 1;
  pkg_manifest_set(name, source);
  printf("\n  " C_GREEN C_BOLD "Added" C_RESET " package " C_CYAN "%s" C_RESET " — use it with:  " C_CYAN "use %s" C_RESET "\n\n", name, name);
  return 0;
}
static int cmd_install(void) {
  console_setup();
  char *m = read_whole_file(PKG_MANIFEST);
  if (!m) { fprintf(stderr, "\n  No %s here. Add a package first:  sprout add <source>\n\n", PKG_MANIFEST); return 1; }
  int got = 0, have = 0, failed = 0;
  for (char *line = strtok(m, "\n"); line; line = strtok(NULL, "\n")) {
    if (!line[0] || line[0] == '#') continue;
    char name[256], source[768];
    if (sscanf(line, "%255s %767s", name, source) != 2) continue;
    char path[1024]; snprintf(path, sizeof path, "%s/%s.sprout", PKG_DIR, name);
    if (path_exists(path)) have++;
    else if (pkg_install_one(name, source) == 0) { printf("  installed %s\n", name); got++; }
    else failed++;
  }
  free(m);
  printf("\n  %d installed, %d already present%s.\n\n", got, have, failed ? " (some failed)" : "");
  return failed ? 1 : 0;
}
static int cmd_remove(int argc, char **argv) {
  console_setup();
  if (argc < 3) { fprintf(stderr, "\n  Usage:  sprout remove <name>\n\n"); return 1; }
  const char *name = argv[2];
  char path[1024]; snprintf(path, sizeof path, "%s/%s.sprout", PKG_DIR, name);
  int had_file = path_exists(path), in_manifest = 0;
  char *old = read_whole_file(PKG_MANIFEST);
  if (old) {
    FILE *f = fopen(PKG_MANIFEST, "wb");
    if (f) { for (char *line = strtok(old, "\n"); line; line = strtok(NULL, "\n")) { char ln[256] = ""; sscanf(line, "%255s", ln); if (strcmp(ln, name) == 0) in_manifest = 1; else fprintf(f, "%s\n", line); } fclose(f); }
    free(old);
  }
  if (!had_file && !in_manifest) { fprintf(stderr, "  No package called '%s' is installed.\n", name); return 1; }
  if (had_file) remove(path);
  printf("  Removed package %s\n", name);
  return 0;
}

/* size the deep-recursion guard to ~75% of THIS process's real stack, so it fails cleanly on
   any stack (the 8 MB POSIX default as well as the 64 MB Windows build) instead of segfaulting. */
static void detect_stack_budget(void) {
#ifdef _WIN32
  MEMORY_BASIC_INFORMATION mbi; char probe = 0;   /* the stack is one reserved region; its base is the low end */
  if (gc_stack_bottom && VirtualQuery(&probe, &mbi, sizeof mbi)) {
    char *base = (char *)mbi.AllocationBase;
    if ((char *)gc_stack_bottom > base) g_stack_budget = (size_t)(((char *)gc_stack_bottom - base) / 4 * 3);
  }
#else
  struct rlimit rl;
  if (getrlimit(RLIMIT_STACK, &rl) == 0 && rl.rlim_cur != RLIM_INFINITY && rl.rlim_cur > (2u << 20))
    g_stack_budget = (size_t)(rl.rlim_cur / 4 * 3);
#endif
}

int main(int argc, char **argv) {
  char gc_bottom_marker; gc_stack_bottom = &gc_bottom_marker;   /* the outermost stack address the GC scans up to */
  detect_stack_budget();                                        /* size the deep-recursion guard to the real stack */
  gc_stress = getenv("SPROUT_GC_STRESS") != NULL;               /* aggressive collection for testing */
  /* --sandbox anywhere on the command line (or SPROUT_SANDBOX in the environment) hardens
     this run for untrusted code; strip the flag so the normal positional args still line up. */
  if (getenv("SPROUT_SANDBOX")) g_sandbox = 1;
  { int w = 1; for (int r = 1; r < argc; r++) { if (!strcmp(argv[r], "--sandbox")) { g_sandbox = 1; continue; } argv[w++] = argv[r]; } argc = w; }
  srand((unsigned)time(NULL));
  console_setup();   /* enable UTF-8 + ANSI colour for every run */
  { char *baked = embedded_script();   /* a standalone bundle: run the script baked into this exe */
    if (baked) {
      g_prog_args = argv + 1; g_prog_nargs = argc - 1;   /* every arg goes straight to the program */
      g_current_file = "<bundled>";
      global_env = env_new(NULL); cur_file_env = env_new(global_env); cur_fileid = ++g_next_fileid;
      sjmp_buf jb; err_jmp = &jb; g_top_jmp = &jb;
      if (SJSET(jb) != 0) { return 1; }
      tokenize(baked, (int)strlen(baked));
      int ncount; Stmt **program = parse_program(&ncount);
      modns_register("main", cur_fileid, cur_file_env);
      for (int i = 0; i < ncount; i++) register_top(program[i], cur_fileid, cur_file_env);
      exec_block(program, ncount, cur_file_env);
      err_jmp = NULL; g_top_jmp = NULL;
      return test_report();
    }
  }
  if (argc < 2) { wizard(); return 0; }
  const char *arg = argv[1];
  if (!strcmp(arg, "version") || !strcmp(arg, "--version") || !strcmp(arg, "-v")) { printf("Sprout v%s\n", SPROUT_VERSION); return 0; }
  if (!strcmp(arg, "help") || !strcmp(arg, "--help") || !strcmp(arg, "-h")) { usage(); return 0; }
  if (!strcmp(arg, "template")) return cmd_template(argc, argv);
  if (!strcmp(arg, "new")) return cmd_new(argc, argv);
  if (!strcmp(arg, "build")) return cmd_build();
  if (!strcmp(arg, "test")) return cmd_test(argc, argv);
  if (!strcmp(arg, "bundle")) return cmd_bundle(argc, argv);
  if (!strcmp(arg, "format") || !strcmp(arg, "fmt")) return cmd_format(argc, argv);
  if (!strcmp(arg, "add")) return cmd_add(argc, argv);
  if (!strcmp(arg, "install")) return cmd_install();
  if (!strcmp(arg, "remove")) return cmd_remove(argc, argv);
  if (!strcmp(arg, "api")) {
    if (argc < 3) { fprintf(stderr, "  api needs a web address:  sprout api https://...\n"); return 1; }
    return cmd_api(argv[2]);
  }

  const char *file = arg;
  int prog_argstart = 2;                /* `sprout file.sprout ARGS...`  -> args start at argv[2] */
  if (!strcmp(arg, "run")) {
    if (argc < 3) return cmd_build();   /* `sprout run` with no file builds the project here */
    file = argv[2];
    prog_argstart = 3;                  /* `sprout run file.sprout ARGS...` -> args start at argv[3] */
  }
  g_prog_args = argv + prog_argstart;   /* what args() returns to the program */
  g_prog_nargs = argc > prog_argstart ? argc - prog_argstart : 0;

  int len; char *src = read_file(file, &len);
  g_current_file = file;
  { char *c = canon_path(file); loaded_add(c); free(c); }   /* so a `use` can't reload the entry file */
  global_env = env_new(NULL);                  /* the shared/public space */
  cur_file_env = env_new(global_env);          /* the entry file's own scope */
  cur_fileid = ++g_next_fileid;
  /* the top-level SYSTEM boundary: an uncaught error prints + stops cleanly here, and it's the
     landing point for hard errors (typos) that skip every `try:`. */
  sjmp_buf jb; err_jmp = &jb; g_top_jmp = &jb;
  if (SJSET(jb) != 0) { err_jmp = NULL; g_top_jmp = NULL; g_current_file = NULL; call_depth = 0; returning = 0; g_loopctl = 0; g_quiet_fail = 0; g_have_fail_override = 0; return 1; }
  tokenize(src, len);
  int ncount; Stmt **program = parse_program(&ncount);
  { char *base = module_basename(file); modns_register(base, cur_fileid, cur_file_env); free(base); }  /* same as `sprout build` */
  for (int i = 0; i < ncount; i++) register_top(program[i], cur_fileid, cur_file_env);
  exec_block(program, ncount, cur_file_env);
  err_jmp = NULL; g_top_jmp = NULL;
  return test_report();   /* if the file had tests, report + set the exit code */
}
