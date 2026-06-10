/* sprout.c — a NATIVE Sprout interpreter, written in C. No Node, no runtime,
 * no dependencies but the C standard library + the operating system.
 *
 *   gcc -O2 -o sprout sprout.c
 *   ./sprout program.sprout
 *
 * Slice 1 of the native rewrite: the core language — make/set/show, numbers,
 * text, booleans, nothing, the math/compare/and/or/not operators, `when` /
 * `orwhen` / `otherwise`, and `repeat`. (Tasks, lists, maps, for-each, f-strings
 * and the libraries come in later slices.)
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

/* ------------------------------------------------------------------ values */
typedef enum { V_NUM, V_STR, V_BOOL, V_NONE } VType;
typedef struct { VType type; double num; char *str; int boolean; } Value;

static Value vnum(double n)  { Value v; v.type = V_NUM;  v.num = n; v.str = NULL; v.boolean = 0; return v; }
static Value vstr(char *s)   { Value v; v.type = V_STR;  v.str = s; v.num = 0;    v.boolean = 0; return v; }
static Value vbool(int b)    { Value v; v.type = V_BOOL; v.boolean = b; v.num = 0; v.str = NULL; return v; }
static Value vnone(void)     { Value v; v.type = V_NONE; v.num = 0; v.str = NULL; v.boolean = 0; return v; }

static char *num_to_str(double n) {
  char buf[64];
  if (isfinite(n) && n == (double)(long long)n && fabs(n) < 1e15) snprintf(buf, sizeof buf, "%lld", (long long)n);
  else snprintf(buf, sizeof buf, "%g", n);
  return dup_str(buf);
}
static char *stringify(Value v) {
  switch (v.type) {
    case V_NUM:  return num_to_str(v.num);
    case V_STR:  return dup_str(v.str ? v.str : "");
    case V_BOOL: return dup_str(v.boolean ? "yes" : "no");
    default:     return dup_str("nothing");
  }
}
static const char *type_name(Value v) {
  switch (v.type) { case V_NUM: return "a number"; case V_STR: return "text"; case V_BOOL: return "a yes/no"; default: return "nothing"; }
}
static int is_truthy(Value v) {
  switch (v.type) { case V_NUM: return v.num != 0; case V_STR: return v.str && v.str[0]; case V_BOOL: return v.boolean; default: return 0; }
}
static int values_equal(Value a, Value b) {
  if (a.type != b.type) return 0;
  switch (a.type) {
    case V_NUM:  return a.num == b.num;
    case V_STR:  return strcmp(a.str ? a.str : "", b.str ? b.str : "") == 0;
    case V_BOOL: return a.boolean == b.boolean;
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
  T_TASK, T_GIVE,
  T_AND, T_OR, T_NOT, T_YES, T_NO, T_NOTHING,
  T_PLUS, T_MINUS, T_STAR, T_SLASH, T_PERCENT,
  T_EQ, T_EQEQ, T_BANGEQ, T_LT, T_LE, T_GT, T_GE,
  T_LPAREN, T_RPAREN, T_COMMA, T_COLON,
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
typedef enum { E_NUM, E_STR, E_BOOL, E_NONE, E_VAR, E_UNARY, E_BINARY, E_LOGICAL, E_CALL } EKind;
typedef struct Expr {
  EKind kind; double num; char *str; int boolean; char *name;
  TokType op; struct Expr *left, *right, *operand; int line;
  struct Expr **args; int nargs;         /* call */
} Expr;

typedef enum { S_MAKE, S_SET, S_SHOW, S_WHEN, S_REPEAT_TIMES, S_REPEAT_WHILE, S_TASK, S_GIVE, S_EXPR } SKind;
typedef struct Stmt Stmt;
typedef struct { Expr *cond; Stmt **body; int nbody; } Branch;
struct Stmt {
  SKind kind; char *name; Expr *expr;
  Expr **values; int nvalues;            /* show */
  Branch *branches; int nbranches; Stmt **otherwise; int notherwise; /* when */
  Expr *count; Stmt **body; int nbody;   /* repeat / task body */
  char **params; int nparams;            /* task */
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
static Expr *unary(void) {
  Token t = peek();
  if (check(T_MINUS) || check(T_NOT)) { advance(); Expr *e = new_expr(E_UNARY, t.line); e->op = t.type; e->operand = unary(); return e; }
  return primary();
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
    case T_MAKE: case T_SET: {
      advance(); Token name = expect(T_IDENT, "I expected a name here.");
      expect(T_EQ, "I expected '=' here.");
      Stmt *s = new_stmt(t.type == T_MAKE ? S_MAKE : S_SET, t.line);
      s->name = name.text; s->expr = expression(); return s;
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
    case E_CALL:   return call_task(e, env);
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

#define SPROUT_VERSION "0.0.1"

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
