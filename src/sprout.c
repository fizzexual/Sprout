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

static char *dup_str(const char *s) { size_t n = strlen(s) + 1; char *p = (char *)malloc(n); memcpy(p, s, n); return p; }

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
typedef enum { V_NUM, V_STR, V_BOOL, V_NONE, V_LIST, V_MAP } VType;
typedef struct Value Value;
typedef struct { Value *items; int n, cap; } SList;
typedef struct { char **keys; Value *vals; int n, cap; } SMap;
struct Value { VType type; double num; char *str; int boolean; SList *list; SMap *map; };

static Value vnum(double n)  { Value v = {0}; v.type = V_NUM;  v.num = n; return v; }
static Value vstr(char *s)   { Value v = {0}; v.type = V_STR;  v.str = s; return v; }
static Value vbool(int b)    { Value v = {0}; v.type = V_BOOL; v.boolean = b; return v; }
static Value vnone(void)     { Value v = {0}; v.type = V_NONE; return v; }
static Value vlist(SList *l) { Value v = {0}; v.type = V_LIST; v.list = l; return v; }
static Value vmap(SMap *m)   { Value v = {0}; v.type = V_MAP;  v.map = m;  return v; }

static SList *list_new(void) { return (SList *)calloc(1, sizeof(SList)); }
static void list_push(SList *l, Value x) {
  if (l->n >= l->cap) {
    l->cap = l->cap ? l->cap * 2 : 8;
    Value *ni = (Value *)realloc(l->items, l->cap * sizeof(Value));
    if (!ni) fail(0, "ran out of memory building a list.");
    l->items = ni;
  }
  l->items[l->n++] = x;
}
static SMap *map_new(void) { return (SMap *)calloc(1, sizeof(SMap)); }
static int map_index(SMap *m, const char *k) { for (int i = 0; i < m->n; i++) if (!strcmp(m->keys[i], k)) return i; return -1; }
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
}

static char *num_to_str(double n) {
  char buf[64];
  if (isfinite(n) && n == (double)(long long)n && fabs(n) < 1e15) snprintf(buf, sizeof buf, "%lld", (long long)n);
  else snprintf(buf, sizeof buf, "%g", n);
  return dup_str(buf);
}
/* a tiny growing-string helper for stringify */
static void sb_add(char **buf, size_t *cap, size_t *len, const char *s) {
  size_t sl = strlen(s);
  while (*len + sl + 1 > *cap) { *cap = *cap ? *cap * 2 : 16; char *nb = (char *)realloc(*buf, *cap); if (!nb) fail(0, "ran out of memory building text."); *buf = nb; }
  memcpy(*buf + *len, s, sl + 1); *len += sl;
}
static char *stringify(Value v) {
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
      SMap *m = v.map; size_t cap = 0, len = 0; char *out = NULL;
      sb_add(&out, &cap, &len, "{");
      for (int i = 0; m && i < m->n; i++) { if (i) sb_add(&out, &cap, &len, ", "); sb_add(&out, &cap, &len, m->keys[i]); sb_add(&out, &cap, &len, ": "); char *p = stringify(m->vals[i]); sb_add(&out, &cap, &len, p); }
      sb_add(&out, &cap, &len, "}"); return out;
    }
    default:     return dup_str("nothing");
  }
}
static const char *type_name(Value v) {
  switch (v.type) { case V_NUM: return "a number"; case V_STR: return "text"; case V_BOOL: return "a yes/no"; case V_LIST: return "a list"; case V_MAP: return "a map"; default: return "nothing"; }
}
static int is_truthy(Value v) {
  switch (v.type) { case V_NUM: return v.num != 0; case V_STR: return v.str && v.str[0]; case V_BOOL: return v.boolean; case V_LIST: return v.list && v.list->n > 0; case V_MAP: return v.map && v.map->n > 0; default: return 0; }
}
static int values_equal(Value a, Value b) {
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
    default:     return 1;
  }
}

/* ------------------------------------------------------------------- errors */
static void fail(int line, const char *msg) {
  fprintf(stderr, "\n  Sprout error");
  if (line > 0) fprintf(stderr, " (line %d)", line);
  fprintf(stderr, ": %s\n\n", msg);
  exit(1);
}
static void failf(int line, const char *fmt, const char *arg) {
  char buf[256]; snprintf(buf, sizeof buf, fmt, arg); fail(line, buf);
}

/* -------------------------------------------------------------------- lexer */
typedef enum {
  T_NUM, T_STR, T_IDENT,
  T_MAKE, T_SET, T_SHOW, T_WHEN, T_ORWHEN, T_OTHERWISE, T_REPEAT, T_WHILE, T_TIMES,
  T_TASK, T_GIVE, T_FOR, T_EACH, T_IN,
  T_AND, T_OR, T_NOT, T_YES, T_NO, T_NOTHING,
  T_PLUS, T_MINUS, T_STAR, T_SLASH, T_PERCENT,
  T_EQ, T_EQEQ, T_BANGEQ, T_LT, T_LE, T_GT, T_GE,
  T_LPAREN, T_RPAREN, T_LBRACK, T_RBRACK, T_LBRACE, T_RBRACE, T_COMMA, T_COLON,
  T_NEWLINE, T_INDENT, T_DEDENT, T_EOF
} TokType;

typedef struct { TokType type; char *text; double num; int line; } Token;

static Token *toks = NULL; static int ntok = 0, captok = 0;
static void push_tok(TokType type, char *text, double num, int line) {
  if (ntok >= captok) { captok = captok ? captok * 2 : 128; toks = (Token *)realloc(toks, captok * sizeof(Token)); }
  Token t; t.type = type; t.text = text; t.num = num; t.line = line; toks[ntok++] = t;
}

static TokType keyword(const char *w) {
  static const struct { const char *word; TokType type; } table[] = {
    { "make", T_MAKE }, { "set", T_SET }, { "show", T_SHOW }, { "when", T_WHEN },
    { "orwhen", T_ORWHEN }, { "otherwise", T_OTHERWISE }, { "repeat", T_REPEAT },
    { "while", T_WHILE }, { "times", T_TIMES }, { "task", T_TASK }, { "give", T_GIVE },
    { "for", T_FOR }, { "each", T_EACH }, { "in", T_IN },
    { "and", T_AND }, { "or", T_OR },
    { "not", T_NOT }, { "yes", T_YES }, { "no", T_NO }, { "nothing", T_NOTHING },
  };
  for (size_t k = 0; k < sizeof table / sizeof table[0]; k++)
    if (!strcmp(w, table[k].word)) return table[k].type;
  return T_IDENT;
}

/* Tokenize the whole source, handling Python-style indentation. */
static void tokenize(const char *src, int len) {
  int indents[256]; int top = 0; indents[0] = 0;
  int i = 0, line = 0;
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
    /* indentation changes */
    if (spaces > indents[top]) { indents[++top] = spaces; push_tok(T_INDENT, NULL, 0, line); }
    while (spaces < indents[top]) { top--; push_tok(T_DEDENT, NULL, 0, line); }
    if (spaces != indents[top]) fail(line, "the indentation doesn't line up with the block.");
    /* tokens on this line */
    while (i < len && src[i] != '\n' && src[i] != '\r') {
      char c = src[i];
      if (c == ' ' || c == '\t') { i++; continue; }
      if (c == '~') { while (i < len && src[i] != '\n') i++; break; }
      if (isdigit((unsigned char)c) || (c == '.' && i + 1 < len && isdigit((unsigned char)src[i + 1]))) {
        int s = i; while (i < len && (isdigit((unsigned char)src[i]) || src[i] == '.')) i++;
        char *t = (char *)malloc(i - s + 1); memcpy(t, src + s, i - s); t[i - s] = 0;
        push_tok(T_NUM, t, atof(t), line); continue;
      }
      if (c == '"') {
        i++; char *buf = (char *)malloc(len - i + 1); int b = 0;
        while (i < len && src[i] != '"') {
          if (src[i] == '\\' && i + 1 < len) {
            char nx = src[i + 1];
            if (nx == 'n') buf[b++] = '\n'; else if (nx == 't') buf[b++] = '\t';
            else if (nx == '"') buf[b++] = '"'; else if (nx == '\\') buf[b++] = '\\'; else buf[b++] = nx;
            i += 2;
          } else buf[b++] = src[i++];
        }
        if (i >= len || src[i] != '"') fail(line, "this text is missing its closing quote.");
        i++; buf[b] = 0; push_tok(T_STR, buf, 0, line); continue;
      }
      if (isalpha((unsigned char)c) || c == '_') {
        int s = i; while (i < len && (isalnum((unsigned char)src[i]) || src[i] == '_')) i++;
        char *w = (char *)malloc(i - s + 1); memcpy(w, src + s, i - s); w[i - s] = 0;
        push_tok(keyword(w), w, 0, line); continue;
      }
      switch (c) {
        case '+': push_tok(T_PLUS, NULL, 0, line); i++; break;
        case '-': push_tok(T_MINUS, NULL, 0, line); i++; break;
        case '*': push_tok(T_STAR, NULL, 0, line); i++; break;
        case '/': push_tok(T_SLASH, NULL, 0, line); i++; break;
        case '%': push_tok(T_PERCENT, NULL, 0, line); i++; break;
        case '(': push_tok(T_LPAREN, NULL, 0, line); i++; break;
        case ')': push_tok(T_RPAREN, NULL, 0, line); i++; break;
        case '[': push_tok(T_LBRACK, NULL, 0, line); i++; break;
        case ']': push_tok(T_RBRACK, NULL, 0, line); i++; break;
        case '{': push_tok(T_LBRACE, NULL, 0, line); i++; break;
        case '}': push_tok(T_RBRACE, NULL, 0, line); i++; break;
        case ',': push_tok(T_COMMA, NULL, 0, line); i++; break;
        case ':': push_tok(T_COLON, NULL, 0, line); i++; break;
        case '=': if (i + 1 < len && src[i + 1] == '=') { push_tok(T_EQEQ, NULL, 0, line); i += 2; } else { push_tok(T_EQ, NULL, 0, line); i++; } break;
        case '!': if (i + 1 < len && src[i + 1] == '=') { push_tok(T_BANGEQ, NULL, 0, line); i += 2; } else fail(line, "I didn't expect a '!' here (use 'not', or '!=' for not-equal)."); break;
        case '<': if (i + 1 < len && src[i + 1] == '=') { push_tok(T_LE, NULL, 0, line); i += 2; } else { push_tok(T_LT, NULL, 0, line); i++; } break;
        case '>': if (i + 1 < len && src[i + 1] == '=') { push_tok(T_GE, NULL, 0, line); i += 2; } else { push_tok(T_GT, NULL, 0, line); i++; } break;
        default: { char m[64]; snprintf(m, sizeof m, "I don't understand the character '%c'.", c); fail(line, m); }
      }
    }
    push_tok(T_NEWLINE, NULL, 0, line);
    while (i < len && src[i] != '\n') i++;
    if (i < len) i++;
    (void)lineStart;
  }
  while (top > 0) { top--; push_tok(T_DEDENT, NULL, 0, line); }
  push_tok(T_EOF, NULL, 0, line);
}

/* ---------------------------------------------------------------------- AST */
typedef enum { E_NUM, E_STR, E_BOOL, E_NONE, E_VAR, E_UNARY, E_BINARY, E_LOGICAL, E_CALL, E_LIST, E_MAP, E_INDEX } EKind;
typedef struct Expr {
  EKind kind; double num; char *str; int boolean; char *name;
  TokType op; struct Expr *left, *right, *operand; int line;
  struct Expr **args; int nargs;         /* call inputs / list items / map values */
  char **keys;                            /* E_MAP keys (parallel to args) */
  struct Expr *target, *index;            /* E_INDEX: target[index] */
} Expr;

typedef enum { S_MAKE, S_SET, S_SHOW, S_WHEN, S_REPEAT_TIMES, S_REPEAT_WHILE, S_TASK, S_GIVE, S_EXPR, S_FOREACH, S_INDEXSET } SKind;
typedef struct Stmt Stmt;
typedef struct { Expr *cond; Stmt **body; int nbody; } Branch;
struct Stmt {
  SKind kind; char *name; Expr *expr;
  Expr **values; int nvalues;            /* show */
  Branch *branches; int nbranches; Stmt **otherwise; int notherwise; /* when */
  Expr *count; Stmt **body; int nbody;   /* repeat / task / for-each body */
  char **params; int nparams;            /* task */
  Expr *target, *index;                   /* S_INDEXSET: target[index] = expr */
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

static Expr *primary(void) {
  Token t = peek();
  if (match(T_NUM))     { Expr *e = new_expr(E_NUM, t.line); e->num = t.num; return e; }
  if (match(T_STR))     { Expr *e = new_expr(E_STR, t.line); e->str = t.text; return e; }
  if (match(T_YES))     { Expr *e = new_expr(E_BOOL, t.line); e->boolean = 1; return e; }
  if (match(T_NO))      { Expr *e = new_expr(E_BOOL, t.line); e->boolean = 0; return e; }
  if (match(T_NOTHING)) { return new_expr(E_NONE, t.line); }
  if (match(T_LBRACK)) {              /* a list: [a, b, c] */
    Expr *e = new_expr(E_LIST, t.line);
    Expr **items = NULL; int n = 0, cap = 0;
    if (!check(T_RBRACK)) {
      do {
        if (n >= cap) { cap = cap ? cap * 2 : 4; items = (Expr **)realloc(items, cap * sizeof(Expr *)); }
        items[n++] = expression();
      } while (match(T_COMMA));
    }
    expect(T_RBRACK, "I expected a ']' to close the list.");
    e->args = items; e->nargs = n; return e;
  }
  if (match(T_LBRACE)) {              /* a map: {key: value, ...} */
    Expr *e = new_expr(E_MAP, t.line);
    Expr **vals = NULL; char **keys = NULL; int n = 0, cap = 0;
    if (!check(T_RBRACE)) {
      do {
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
    if (check(T_LPAREN)) {           /* a call: name(args) */
      advance();
      Expr *e = new_expr(E_CALL, t.line); e->name = t.text;
      Expr **args = NULL; int n = 0, cap = 0;
      if (!check(T_RPAREN)) {
        do {
          if (n >= cap) { cap = cap ? cap * 2 : 4; args = (Expr **)realloc(args, cap * sizeof(Expr *)); }
          args[n++] = expression();
        } while (match(T_COMMA));
      }
      expect(T_RPAREN, "I expected a ')' to close the inputs.");
      e->args = args; e->nargs = n; return e;
    }
    Expr *e = new_expr(E_VAR, t.line); e->name = t.text; return e;
  }
  if (match(T_LPAREN))  { Expr *e = expression(); expect(T_RPAREN, "I expected a ')' to close this group."); return e; }
  fail(t.line, "I expected a value here (a number, some text, or a name).");
  return NULL;
}
static Expr *postfix(void) {        /* primary followed by any number of [index] */
  Expr *e = primary();
  while (check(T_LBRACK)) {
    int line = peek().line; advance();
    Expr *idx = expression();
    expect(T_RBRACK, "I expected a ']' to close the index.");
    Expr *ix = new_expr(E_INDEX, line); ix->target = e; ix->index = idx; e = ix;
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
static Expr *comparison(void) { static const TokType o[] = { T_LT, T_LE, T_GT, T_GE }; return binary_level(term, o, 4, 0); }
static Expr *equality(void)   { static const TokType o[] = { T_EQEQ, T_BANGEQ }; return binary_level(comparison, o, 2, 0); }
static Expr *and_expr(void)   { static const TokType o[] = { T_AND }; return binary_level(equality, o, 1, 1); }
static Expr *expression(void) { static const TokType o[] = { T_OR }; return binary_level(and_expr, o, 1, 1); }

static Stmt *statement(void);

/* a `:` then a NEWLINE then an indented run of statements */
static Stmt **block(int *count) {
  expect(T_COLON, "I expected a ':' to start the block.");
  expect(T_NEWLINE, "the block should begin on the next line.");
  expect(T_INDENT, "I expected the next lines to be indented (that's the block).");
  Stmt **list = NULL; int n = 0, cap = 0;
  while (!check(T_DEDENT) && !check(T_EOF)) {
    if (match(T_NEWLINE)) continue;
    if (n >= cap) { cap = cap ? cap * 2 : 8; list = (Stmt **)realloc(list, cap * sizeof(Stmt *)); }
    list[n++] = statement();
  }
  expect(T_DEDENT, "I expected this block to finish here.");
  *count = n; return list;
}

static Stmt *statement(void) {
  Token t = peek();
  switch (t.type) {
    case T_MAKE: {
      advance(); Token name = expect(T_IDENT, "I expected a name here.");
      expect(T_EQ, "I expected '=' here.");
      Stmt *s = new_stmt(S_MAKE, t.line); s->name = name.text; s->expr = expression(); return s;
    }
    case T_SET: {
      advance();
      Expr *lhs = postfix();             /* a name, name[i], or grid[i][j] */
      expect(T_EQ, "I expected '=' here.");
      Expr *val = expression();
      if (lhs->kind == E_VAR)   { Stmt *s = new_stmt(S_SET, t.line); s->name = lhs->name; s->expr = val; return s; }
      if (lhs->kind == E_INDEX) { Stmt *s = new_stmt(S_INDEXSET, t.line); s->target = lhs->target; s->index = lhs->index; s->expr = val; return s; }
      fail(t.line, "you can only 'set' a name, or an item inside a list or map.");
      return NULL;
    }
    case T_FOR: {
      advance();
      expect(T_EACH, "I expected 'each' here (like: for each item in things:).");
      Token name = expect(T_IDENT, "I expected a name for each item.");
      expect(T_IN, "I expected 'in' here (like: for each item in things:).");
      Stmt *s = new_stmt(S_FOREACH, t.line); s->name = name.text; s->expr = expression();
      s->body = block(&s->nbody); return s;
    }
    case T_SHOW: {
      advance(); Stmt *s = new_stmt(S_SHOW, t.line);
      Expr **vals = NULL; int n = 0, cap = 0;
      do {
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
    case T_REPEAT: {
      advance();
      if (match(T_WHILE)) { Stmt *s = new_stmt(S_REPEAT_WHILE, t.line); s->expr = expression(); s->body = block(&s->nbody); return s; }
      Stmt *s = new_stmt(S_REPEAT_TIMES, t.line); s->count = expression();
      expect(T_TIMES, "I expected 'times' here (like: repeat 3 times:).");
      s->body = block(&s->nbody); return s;
    }
    case T_TASK: {
      advance(); Token name = expect(T_IDENT, "I expected the task's name here.");
      expect(T_LPAREN, "I expected '(' after the task name.");
      char **params = NULL; int n = 0, cap = 0;
      if (!check(T_RPAREN)) {
        do {
          Token p = expect(T_IDENT, "I expected an input name here.");
          if (n >= cap) { cap = cap ? cap * 2 : 4; params = (char **)realloc(params, cap * sizeof(char *)); }
          params[n++] = p.text;
        } while (match(T_COMMA));
      }
      expect(T_RPAREN, "I expected ')' to close the inputs.");
      Stmt *s = new_stmt(S_TASK, t.line); s->name = name.text; s->params = params; s->nparams = n;
      s->body = block(&s->nbody); return s;
    }
    case T_GIVE: {
      advance(); Stmt *s = new_stmt(S_GIVE, t.line);
      if (!check(T_NEWLINE)) s->expr = expression();   /* bare `give` hands back nothing */
      return s;
    }
    default:
      if (check(T_IDENT)) { Stmt *s = new_stmt(S_EXPR, t.line); s->expr = expression(); return s; }
      fail(t.line, "I didn't expect this at the start of a line.");
  }
  return NULL;
}

static Stmt **parse_program(int *count) {
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
static Env *global_env;

static Env *env_new(Env *parent) { Env *e = (Env *)calloc(1, sizeof(Env)); e->parent = parent; return e; }
static Value *env_local(Env *e, const char *name) { for (int i = 0; i < e->n; i++) if (!strcmp(e->vars[i].name, name)) return &e->vars[i].val; return NULL; }
static Value *env_find(Env *e, const char *name) { for (; e; e = e->parent) { Value *v = env_local(e, name); if (v) return v; } return NULL; }
static void env_define(Env *e, const char *name, Value v) {
  Value *slot = env_local(e, name);
  if (slot) { *slot = v; return; }
  if (e->n >= e->cap) { e->cap = e->cap ? e->cap * 2 : 8; e->vars = (Var *)realloc(e->vars, e->cap * sizeof(Var)); }
  e->vars[e->n].name = dup_str(name); e->vars[e->n].val = v; e->n++;
}
static void env_assign(Env *e, const char *name, Value v, int line) {
  Value *slot = env_find(e, name);
  if (!slot) failf(line, "I can't set '%s' because it was never made.", name);
  *slot = v;
}

/* tasks: top-level functions, hoisted so call order doesn't matter */
typedef struct { char *name; char **params; int nparams; Stmt **body; int nbody; int line; } TaskDef;
static TaskDef *tasks = NULL; static int ntasks = 0, captasks = 0;
static TaskDef *task_find(const char *name) { for (int i = 0; i < ntasks; i++) if (!strcmp(tasks[i].name, name)) return &tasks[i]; return NULL; }
static void task_register(Stmt *s) {
  if (task_find(s->name)) failf(s->line, "there are two tasks named '%s'.", s->name);
  if (ntasks >= captasks) { captasks = captasks ? captasks * 2 : 8; tasks = (TaskDef *)realloc(tasks, captasks * sizeof(TaskDef)); }
  TaskDef *t = &tasks[ntasks++];
  t->name = s->name; t->params = s->params; t->nparams = s->nparams; t->body = s->body; t->nbody = s->nbody; t->line = s->line;
}

/* `give` is signalled with a flag + slot so it unwinds cleanly through blocks/loops */
static int returning = 0;
static Value return_value;
static int call_depth = 0;
#define MAX_DEPTH 6000

static Value eval(Expr *e, Env *env);
static void exec(Stmt *s, Env *env);
static void exec_block(Stmt **list, int n, Env *env) { for (int i = 0; i < n; i++) { exec(list[i], env); if (returning) return; } }

static Value call_task(Expr *call, Env *env) {
  TaskDef *t = task_find(call->name);
  if (!t) failf(call->line, "I don't know a task called '%s'.", call->name);
  if (call->nargs != t->nparams) {
    char m[160]; snprintf(m, sizeof m, "the task '%s' wants %d input%s, but got %d.", t->name, t->nparams, t->nparams == 1 ? "" : "s", call->nargs);
    fail(call->line, m);
  }
  if (++call_depth > MAX_DEPTH) fail(call->line, "this went too deep — a task may be calling itself with no way to stop.");
  Env *frame = env_new(global_env);   /* a task sees globals + its own locals, not the caller's */
  for (int i = 0; i < t->nparams; i++) env_define(frame, t->params[i], eval(call->args[i], env));
  int saved_ret = returning; Value saved_rv = return_value;
  returning = 0;
  exec_block(t->body, t->nbody, frame);
  Value result = returning ? return_value : vnone();
  returning = saved_ret; return_value = saved_rv;
  call_depth--;
  return result;
}

/* built-in functions — called like tasks: name(args). */
static Value call_builtin(Expr *call, Env *env) {
  const char *name = call->name;
  int n = call->nargs;
  if (n > 16) fail(call->line, "that's too many inputs for a builtin.");
  Value a[16];
  for (int i = 0; i < n; i++) a[i] = eval(call->args[i], env);

  if (!strcmp(name, "range")) {
    if ((n != 1 && n != 2) || a[0].type != V_NUM || (n == 2 && a[1].type != V_NUM)) fail(call->line, "range needs 1 or 2 numbers, like range(5) or range(2, 8).");
    long long start = (n == 2) ? (long long)a[0].num : 0;
    long long end   = (n == 2) ? (long long)a[1].num : (long long)a[0].num;
    if (end - start > 100000000LL) fail(call->line, "that range is too big.");
    SList *l = list_new();
    for (long long i = start; i < end; i++) list_push(l, vnum((double)i));
    return vlist(l);
  }
  if (!strcmp(name, "length")) {
    if (n != 1) fail(call->line, "length needs one thing.");
    if (a[0].type == V_LIST) return vnum(a[0].list ? a[0].list->n : 0);
    if (a[0].type == V_MAP)  return vnum(a[0].map ? a[0].map->n : 0);
    if (a[0].type == V_STR)  { const char *p = a[0].str ? a[0].str : ""; long long c = 0; for (int i = 0; p[i]; i += utf8_clen((unsigned char)p[i])) c++; return vnum((double)c); }
    fail(call->line, "length works on a list, a map, or text.");
  }
  if (!strcmp(name, "add")) {
    if (n != 2) fail(call->line, "add needs a list and a value, like add(things, 5).");
    if (a[0].type != V_LIST || !a[0].list) fail(call->line, "add's first input must be a list.");
    list_push(a[0].list, a[1]);
    return vnone();
  }
  if (!strcmp(name, "keys")) {
    if (n != 1 || a[0].type != V_MAP) fail(call->line, "keys needs a map.");
    SList *l = list_new();
    for (int i = 0; a[0].map && i < a[0].map->n; i++) list_push(l, vstr(dup_str(a[0].map->keys[i])));
    return vlist(l);
  }
  if (!strcmp(name, "contains")) {
    if (n != 2) fail(call->line, "contains needs a collection and a value.");
    if (a[0].type == V_LIST) { for (int i = 0; a[0].list && i < a[0].list->n; i++) if (values_equal(a[0].list->items[i], a[1])) return vbool(1); return vbool(0); }
    if (a[0].type == V_MAP)  return vbool(a[1].type == V_STR && a[0].map && map_index(a[0].map, a[1].str) >= 0);
    if (a[0].type == V_STR && a[1].type == V_STR) return vbool(strstr(a[0].str ? a[0].str : "", a[1].str ? a[1].str : "") != NULL);
    fail(call->line, "contains works on a list, a map, or text.");
  }
  if (!strcmp(name, "first")) {
    if (n != 1 || a[0].type != V_LIST) fail(call->line, "first needs a list.");
    return (a[0].list && a[0].list->n > 0) ? a[0].list->items[0] : vnone();
  }
  if (!strcmp(name, "last")) {
    if (n != 1 || a[0].type != V_LIST) fail(call->line, "last needs a list.");
    return (a[0].list && a[0].list->n > 0) ? a[0].list->items[a[0].list->n - 1] : vnone();
  }
  failf(call->line, "I don't know a task or function called '%s'.", name);
  return vnone();
}

static Value eval_binary(Expr *e, Env *env) {
  Value l = eval(e->left, env), r = eval(e->right, env);
  switch (e->op) {
    case T_PLUS:
      if (l.type == V_STR || r.type == V_STR) { char *a = stringify(l), *b = stringify(r); char *out = (char *)malloc(strlen(a) + strlen(b) + 1); strcpy(out, a); strcat(out, b); return vstr(out); }
      if (l.type == V_NUM && r.type == V_NUM) return vnum(l.num + r.num);
      failf(e->line, "I can't add %s and a different kind of value.", type_name(l)); break;
    case T_MINUS: case T_STAR: case T_SLASH: case T_PERCENT:
      if (l.type != V_NUM || r.type != V_NUM) fail(e->line, "math needs two numbers.");
      if (e->op == T_MINUS) return vnum(l.num - r.num);
      if (e->op == T_STAR)  return vnum(l.num * r.num);
      if (r.num == 0) fail(e->line, e->op == T_SLASH ? "you tried to divide by zero." : "you tried to take a remainder with zero.");
      return vnum(e->op == T_SLASH ? l.num / r.num : fmod(l.num, r.num));
    case T_LT: case T_LE: case T_GT: case T_GE: {
      int cmp;
      if (l.type == V_NUM && r.type == V_NUM) cmp = (l.num < r.num) ? -1 : (l.num > r.num) ? 1 : 0;
      else if (l.type == V_STR && r.type == V_STR) cmp = strcmp(l.str, r.str);
      else { fail(e->line, "I can only compare two numbers or two pieces of text."); return vnone(); }
      if (e->op == T_LT) return vbool(cmp < 0);
      if (e->op == T_LE) return vbool(cmp <= 0);
      if (e->op == T_GT) return vbool(cmp > 0);
      return vbool(cmp >= 0);
    }
    case T_EQEQ:  return vbool(values_equal(l, r));
    case T_BANGEQ:return vbool(!values_equal(l, r));
    default: fail(e->line, "unknown operator."); return vnone();
  }
  return vnone();
}

static Value eval(Expr *e, Env *env) {
  switch (e->kind) {
    case E_NUM:  return vnum(e->num);
    case E_STR:  return vstr(e->str);
    case E_BOOL: return vbool(e->boolean);
    case E_NONE: return vnone();
    case E_VAR: { Value *v = env_find(env, e->name); if (!v) failf(e->line, "I don't know what '%s' is.", e->name); return *v; }
    case E_UNARY:
      if (e->op == T_NOT) return vbool(!is_truthy(eval(e->operand, env)));
      { Value v = eval(e->operand, env); if (v.type != V_NUM) fail(e->line, "I can only put a minus sign in front of a number."); return vnum(-v.num); }
    case E_LOGICAL: {
      int l = is_truthy(eval(e->left, env));
      if (e->op == T_AND) return vbool(l ? is_truthy(eval(e->right, env)) : 0);
      return vbool(l ? 1 : is_truthy(eval(e->right, env)));
    }
    case E_BINARY: return eval_binary(e, env);
    case E_CALL:   return task_find(e->name) ? call_task(e, env) : call_builtin(e, env);
    case E_LIST: { SList *l = list_new(); for (int i = 0; i < e->nargs; i++) list_push(l, eval(e->args[i], env)); return vlist(l); }
    case E_MAP:  { SMap *m = map_new(); for (int i = 0; i < e->nargs; i++) map_set(m, e->keys[i], eval(e->args[i], env)); return vmap(m); }
    case E_INDEX: {
      Value c = eval(e->target, env), ix = eval(e->index, env);
      if (c.type == V_LIST) {
        if (ix.type != V_NUM) fail(e->line, "a list position must be a number.");
        if (ix.num != (double)(long long)ix.num) fail(e->line, "a list position must be a whole number.");
        long long i = (long long)ix.num;
        if (!c.list || i < 0 || i >= c.list->n) fail(e->line, "that position doesn't exist in the list.");
        return c.list->items[i];
      }
      if (c.type == V_MAP) {
        if (ix.type != V_STR) fail(e->line, "a map key must be text.");
        int i = c.map ? map_index(c.map, ix.str) : -1;
        return i >= 0 ? c.map->vals[i] : vnone();
      }
      fail(e->line, "I can only look inside a list or a map with [ ].");
      return vnone();
    }
  }
  return vnone();
}

static void exec(Stmt *s, Env *env) {
  switch (s->kind) {
    case S_MAKE: env_define(env, s->name, eval(s->expr, env)); break;
    case S_SET:  env_assign(env, s->name, eval(s->expr, env), s->line); break;
    case S_SHOW: {
      for (int i = 0; i < s->nvalues; i++) { if (i) fputc(' ', stdout); char *t = stringify(eval(s->values[i], env)); fputs(t, stdout); }
      fputc('\n', stdout); break;
    }
    case S_WHEN: {
      for (int i = 0; i < s->nbranches; i++) if (is_truthy(eval(s->branches[i].cond, env))) { exec_block(s->branches[i].body, s->branches[i].nbody, env); return; }
      if (s->otherwise) exec_block(s->otherwise, s->notherwise, env);
      break;
    }
    case S_REPEAT_TIMES: {
      Value c = eval(s->count, env); if (c.type != V_NUM) fail(s->line, "'repeat ... times' needs a number.");
      long long times = (long long)c.num;
      for (long long k = 0; k < times; k++) { exec_block(s->body, s->nbody, env); if (returning) break; }
      break;
    }
    case S_REPEAT_WHILE:
      while (is_truthy(eval(s->expr, env))) { exec_block(s->body, s->nbody, env); if (returning) break; }
      break;
    case S_TASK: break;  /* registered before the run */
    case S_GIVE: return_value = s->expr ? eval(s->expr, env) : vnone(); returning = 1; break;
    case S_EXPR: eval(s->expr, env); break;
    case S_FOREACH: {
      Value it = eval(s->expr, env);
      if (it.type == V_LIST) {
        int len = it.list ? it.list->n : 0;            /* snapshot: appending inside the loop won't extend it */
        for (int i = 0; i < len; i++) { env_define(env, s->name, it.list->items[i]); exec_block(s->body, s->nbody, env); if (returning) break; }
      } else if (it.type == V_MAP) {
        int len = it.map ? it.map->n : 0;
        for (int i = 0; i < len; i++) { env_define(env, s->name, vstr(dup_str(it.map->keys[i]))); exec_block(s->body, s->nbody, env); if (returning) break; }
      } else if (it.type == V_STR) {
        const char *p = it.str ? it.str : "";
        for (int i = 0; p[i]; ) {                       /* one whole UTF-8 character per step */
          int cl = utf8_clen((unsigned char)p[i]); char ch[5]; int k = 0;
          for (; k < cl && p[i + k]; k++) ch[k] = p[i + k];
          ch[k] = 0;
          env_define(env, s->name, vstr(dup_str(ch)));
          exec_block(s->body, s->nbody, env); if (returning) break;
          i += k ? k : 1;
        }
      } else fail(s->line, "I can only loop over a list, a map, or text with 'for each'.");
      break;
    }
    case S_INDEXSET: {
      Value c = eval(s->target, env);                  /* the list/map to set into (a reference) */
      Value ix = eval(s->index, env), val = eval(s->expr, env);
      if (c.type == V_LIST) {
        if (ix.type != V_NUM) fail(s->line, "a list position must be a number.");
        if (ix.num != (double)(long long)ix.num) fail(s->line, "a list position must be a whole number.");
        long long i = (long long)ix.num;
        if (!c.list || i < 0 || i >= c.list->n) fail(s->line, "that position doesn't exist in the list.");
        c.list->items[i] = val;
      } else if (c.type == V_MAP) {
        if (ix.type != V_STR) fail(s->line, "a map key must be text.");
        if (!c.map) fail(s->line, "this map isn't ready to set into.");
        map_set(c.map, ix.str, val);
      } else fail(s->line, "I can only set inside a list or a map with [ ].");
      break;
    }
  }
}

/* --------------------------------------------------------------------- main */
static char *read_file(const char *path, int *out_len) {
  FILE *f = fopen(path, "rb");
  if (!f) { fprintf(stderr, "\n  I couldn't open the file: %s\n\n", path); exit(1); }
  fseek(f, 0, SEEK_END); long n = ftell(f); fseek(f, 0, SEEK_SET);
  char *buf = (char *)malloc(n + 1); size_t got = fread(buf, 1, n, f); buf[got] = 0; fclose(f);
  *out_len = (int)got; return buf;
}

#define SPROUT_VERSION "0.0.2"

static void usage(void) {
  printf("Sprout v%s - a small, friendly language, written from scratch in C.\n\n", SPROUT_VERSION);
  printf("  sprout <file.sprout>     run a program\n");
  printf("  sprout run <file>        run a program\n");
  printf("  sprout version           show the version\n");
  printf("  sprout help              show this help\n");
}

int main(int argc, char **argv) {
  if (argc < 2) { usage(); return 0; }
  const char *arg = argv[1];
  if (!strcmp(arg, "version") || !strcmp(arg, "--version") || !strcmp(arg, "-v")) { printf("Sprout v%s\n", SPROUT_VERSION); return 0; }
  if (!strcmp(arg, "help") || !strcmp(arg, "--help") || !strcmp(arg, "-h")) { usage(); return 0; }

  const char *file = arg;
  if (!strcmp(arg, "run")) {
    if (argc < 3) { fprintf(stderr, "\n  Sprout: 'run' needs a file - try:  sprout run hello.sprout\n\n"); return 1; }
    file = argv[2];
  }

  int len; char *src = read_file(file, &len);
  tokenize(src, len);
  int ncount; Stmt **program = parse_program(&ncount);
  for (int i = 0; i < ncount; i++) if (program[i]->kind == S_TASK) task_register(program[i]);
  global_env = env_new(NULL);
  exec_block(program, ncount, global_env);
  return 0;
}
