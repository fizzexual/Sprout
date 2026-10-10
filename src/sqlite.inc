/* Pinned SQLite adapter, compiled with -DSPROUT_SQLITE + vendor/sqlite/sqlite3.c.
   Handles are registry IDs, never addresses. Statements bind values separately. */
#ifdef SPROUT_SQLITE
typedef struct { unsigned id; sqlite3 *db; } PRDatabase;
static PRDatabase pr_databases[64];
static unsigned pr_next_database = 1;
static sqlite3 *pr_database(Value handle, int line) {
  double id = pr_number(handle, line, "database handle");
  if (!isfinite(id) || id != floor(id) || id < 1 || id > UINT_MAX) fail(line, "database handle must be the handle returned by sql_open.");
  for (int i = 0; i < 64; i++) if (pr_databases[i].id == (unsigned)id) return pr_databases[i].db;
  return NULL;
}
static int pr_sql_cancel(void *p) { return pr_clock_ms() >= *(unsigned long long *)p; }
static int pr_sql_authorize(void *context, int action, const char *a, const char *b, const char *db, const char *trigger) {
  (void)context; (void)a; (void)b; (void)db; (void)trigger;
  /* Explicit transactions belong to sql_transaction; user COMMIT cannot escape
     its rollback guarantee. Other databases require their own checked handle. */
  return action == SQLITE_TRANSACTION || action == SQLITE_SAVEPOINT || action == SQLITE_ATTACH || action == SQLITE_DETACH ? SQLITE_DENY : SQLITE_OK;
}
static Value pr_sql_error(sqlite3 *db, int code, const char *fallback) {
  return pr_result(0, db ? sqlite3_errmsg(db) : fallback, code);
}
static Value pr_sql_open(const char *path, SMap *options, int line) {
  const char *const allowed[] = {"read_only", "timeout_ms", NULL}; pr_options(options, allowed, line);
  Value ro = pr_option(options, "read_only"); if (ro.type != V_NONE && ro.type != V_BOOL) fail(line, "read_only must be yes or no.");
  int timeout = pr_int_option(options, "timeout_ms", PR_DEFAULT_TIMEOUT, 1, 3600000, line); timeout = pr_deadline_timeout(timeout);
  int slot = -1; for (int i = 0; i < 64; i++) if (!pr_databases[i].db) { slot = i; break; }
  if (slot < 0 || !pr_next_database) return pr_result(0, "sql_open: close a database before opening another (64 handle limit)", SQLITE_BUSY);
  sqlite3 *db = NULL; int flags = ro.type == V_BOOL && ro.boolean ? SQLITE_OPEN_READONLY : SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE;
  int rc = sqlite3_open_v2(path, &db, flags | SQLITE_OPEN_FULLMUTEX, NULL);
  if (rc != SQLITE_OK) { Value v = pr_sql_error(db, rc, "sql_open failed"); if (db) sqlite3_close(db); return v; }
  sqlite3_extended_result_codes(db, 1); sqlite3_busy_timeout(db, timeout);
  sqlite3_limit(db, SQLITE_LIMIT_LENGTH, PR_MAX_BYTES); sqlite3_limit(db, SQLITE_LIMIT_SQL_LENGTH, 1024 * 1024);
  sqlite3_limit(db, SQLITE_LIMIT_COLUMN, 1000); sqlite3_limit(db, SQLITE_LIMIT_VARIABLE_NUMBER, 1000); sqlite3_limit(db, SQLITE_LIMIT_EXPR_DEPTH, 100);
  sqlite3_db_config(db, SQLITE_DBCONFIG_DEFENSIVE, 1, NULL);
  rc = sqlite3_exec(db, "PRAGMA foreign_keys=ON", NULL, NULL, NULL);
  if (rc != SQLITE_OK) { Value v = pr_sql_error(db, rc, "sql_open configuration failed"); sqlite3_close(db); return v; }
  sqlite3_set_authorizer(db, pr_sql_authorize, NULL);
  unsigned id = pr_next_database++; pr_databases[slot].db = db; pr_databases[slot].id = id;
  Value v = pr_result(1, NULL, 0); map_set(v.map, "handle", vnum(id)); map_set(v.map, "version", vstr(sqlite3_libversion())); return v;
}
static int pr_sql_bind(sqlite3_stmt *stmt, int index, Value v) {
  switch (v.type) {
    case V_NONE: return sqlite3_bind_null(stmt, index);
    case V_BOOL: return sqlite3_bind_int(stmt, index, v.boolean);
    case V_NUM: if (!isfinite(v.num)) return SQLITE_MISMATCH; return sqlite3_bind_double(stmt, index, v.num);
    case V_INT: return sqlite3_bind_int64(stmt, index, v.exact);
    case V_DECIMAL: {
      char *s = exact_to_str(v); int rc = sqlite3_bind_text(stmt, index, s, -1, SQLITE_TRANSIENT); free(s); return rc;
    }
    case V_STR: return sqlite3_bind_text(stmt, index, v.str, -1, SQLITE_TRANSIENT);
    case V_BYTES: return v.length <= PR_MAX_BYTES ? sqlite3_bind_blob(stmt, index, v.str, (int)v.length, SQLITE_TRANSIENT) : SQLITE_TOOBIG;
    case V_LIST: {
      SList *list = v.list; if ((unsigned)list->n > PR_MAX_BYTES) return SQLITE_TOOBIG;
      unsigned char *bytes = (unsigned char *)malloc((size_t)list->n + 1); if (!bytes) return SQLITE_NOMEM;
      for (int i = 0; i < list->n; i++) {
        double n = list->items[i].type == V_NUM ? list->items[i].num : list->items[i].type == V_INT ? (double)list->items[i].exact : -1;
        if (!isfinite(n) || n != floor(n) || n < 0 || n > 255) { free(bytes); return SQLITE_MISMATCH; }
        bytes[i] = (unsigned char)n;
      }
      int rc = sqlite3_bind_blob(stmt, index, bytes, list->n, SQLITE_TRANSIENT); free(bytes); return rc;
    }
    default: return SQLITE_MISMATCH;
  }
}
static Value pr_sql_statement(sqlite3 *db, const char *sql, SList *params, unsigned long long deadline, int max_rows, size_t max_bytes) {
  sqlite3_stmt *stmt = NULL, *extra = NULL; const char *tail = NULL;
  int rc = sqlite3_prepare_v2(db, sql, -1, &stmt, &tail);
  if (rc != SQLITE_OK) return pr_sql_error(db, rc, "SQL prepare failed");
  if (!stmt) return pr_result(0, "sql_execute: expected one SQL statement", SQLITE_MISUSE);
  if (tail && *tail) {
    rc = sqlite3_prepare_v2(db, tail, -1, &extra, NULL);
    if (rc != SQLITE_OK || extra) { sqlite3_finalize(extra); sqlite3_finalize(stmt); return pr_result(0, "sql_execute: only one statement is allowed per call", SQLITE_MISUSE); }
  }
  int count = sqlite3_bind_parameter_count(stmt);
  if (count != (params ? params->n : 0)) { sqlite3_finalize(stmt); return pr_result(0, "sql_execute: parameter count does not match the supplied list", SQLITE_RANGE); }
  for (int i = 0; i < count; i++) {
    rc = pr_sql_bind(stmt, i + 1, params->items[i]);
    if (rc != SQLITE_OK) { sqlite3_finalize(stmt); return pr_result(0, "sql_execute: unsupported parameter or binding failure (use text, a finite number, yes/no, nothing, or byte list)", rc); }
  }
  SList *columns = list_new(), *rows = list_new(); int cols = sqlite3_column_count(stmt); size_t bytes = 512;
  for (int i = 0; i < cols; i++) {
    const char *name = sqlite3_column_name(stmt, i); bytes += strlen(name) + sizeof(Value);
    if (bytes > max_bytes) { sqlite3_finalize(stmt); return pr_result(0, "sql_execute: columns exceed max_bytes", SQLITE_TOOBIG); }
    list_push(columns, vstr(name));
  }
  sqlite3_progress_handler(db, 1000, pr_sql_cancel, &deadline);
  unsigned long long now = pr_clock_ms(); int remaining = deadline > now ? (int)(deadline - now) : 1; sqlite3_busy_timeout(db, remaining);
  const char *error = NULL; sqlite3_int64 before_changes = sqlite3_total_changes64(db);
  while ((rc = sqlite3_step(stmt)) == SQLITE_ROW) {
    if (rows->n >= max_rows) { error = "sql_execute: result exceeds max_rows"; rc = SQLITE_TOOBIG; break; }
    SList *row = list_new();
    for (int i = 0; i < cols; i++) {
      int type = sqlite3_column_type(stmt, i); Value v = vnone();
      if (type == SQLITE_INTEGER) v = vexact((int64_t)sqlite3_column_int64(stmt, i), 0, 0);
      else if (type == SQLITE_FLOAT) v = vnum(sqlite3_column_double(stmt, i));
      else if (type == SQLITE_TEXT) {
        int len = sqlite3_column_bytes(stmt, i); const char *p = (const char *)sqlite3_column_text(stmt, i);
        bytes += (size_t)len;
        if (!p || memchr(p, 0, (size_t)len)) { error = "sql_execute: text contains NUL bytes; use a BLOB for binary data"; rc = SQLITE_MISMATCH; break; }
        v = vstr(p);
      } else if (type == SQLITE_BLOB) {
        int len = sqlite3_column_bytes(stmt, i); const unsigned char *p = (const unsigned char *)sqlite3_column_blob(stmt, i); bytes += (size_t)len;
        if (bytes > max_bytes) { error = "sql_execute: result exceeds max_bytes"; rc = SQLITE_TOOBIG; break; }
        v = vbytes(p, (size_t)len);
      }
      bytes += sizeof(Value);
      if (bytes > max_bytes) { error = "sql_execute: result exceeds max_bytes"; rc = SQLITE_TOOBIG; break; }
      list_push(row, v);
    }
    if (error) break;
    list_push(rows, vlist(row));
    if (pr_clock_ms() >= deadline) { error = "sql_execute: timeout"; rc = SQLITE_INTERRUPT; break; }
  }
  sqlite3_progress_handler(db, 0, NULL, NULL);
  if (rc != SQLITE_DONE) {
    Value v = error ? pr_result(0, error, rc) : pr_sql_error(db, rc, "SQL execution failed");
    if (rc == SQLITE_INTERRUPT) map_set(v.map, "timed_out", vbool(1));
    sqlite3_finalize(stmt); return v;
  }
  sqlite3_int64 changed = sqlite3_total_changes64(db) - before_changes, last = sqlite3_last_insert_rowid(db);
  rc = sqlite3_finalize(stmt); if (rc != SQLITE_OK) return pr_sql_error(db, rc, "SQL finalize failed");
  Value v = pr_result(1, NULL, 0); map_set(v.map, "columns", vlist(columns)); map_set(v.map, "rows", vlist(rows));
  map_set(v.map, "changed", vexact((int64_t)changed, 0, 0)); map_set(v.map, "last_id", vexact((int64_t)last, 0, 0)); map_set(v.map, "bytes", vnum((double)bytes)); return v;
}
static int pr_sql_rollback(sqlite3 *db) {
  if (sqlite3_get_autocommit(db)) return 1; /* SQLite may have rolled back on an interrupt. */
  return sqlite3_exec(db, "ROLLBACK", NULL, NULL, NULL) == SQLITE_OK && sqlite3_get_autocommit(db);
}
static Value pr_sql_execute(Value handle, const char *sql, SList *params, SMap *options, int line) {
  const char *const allowed[] = {"timeout_ms", "max_rows", "max_bytes", NULL}; pr_options(options, allowed, line);
  int timeout = pr_deadline_timeout(pr_int_option(options, "timeout_ms", PR_DEFAULT_TIMEOUT, 1, 3600000, line));
  int rows = pr_int_option(options, "max_rows", 10000, 1, 100000, line); int bytes = pr_int_option(options, "max_bytes", PR_DEFAULT_BYTES, 1, PR_MAX_BYTES, line);
  sqlite3 *db = pr_database(handle, line); if (!db) return pr_result(0, "sql_execute: database handle is closed or unknown", SQLITE_MISUSE);
  return pr_sql_statement(db, sql, params, pr_clock_ms() + (unsigned)timeout, rows, (size_t)bytes);
}
static Value pr_sql_transaction(Value handle, SList *statements, SMap *options, int line) {
  const char *const allowed[] = {"timeout_ms", "max_rows", "max_bytes", NULL}; pr_options(options, allowed, line);
  int timeout = pr_deadline_timeout(pr_int_option(options, "timeout_ms", PR_DEFAULT_TIMEOUT, 1, 3600000, line));
  int max_rows = pr_int_option(options, "max_rows", 10000, 1, 100000, line), max_bytes = pr_int_option(options, "max_bytes", PR_DEFAULT_BYTES, 1, PR_MAX_BYTES, line);
  if (statements->n > 10000) fail(line, "sql_transaction supports at most 10,000 statements.");
  /* Validate the complete request before BEGIN: argument errors cannot strand a transaction. */
  for (int i = 0; i < statements->n; i++) {
    if (statements->items[i].type != V_MAP) fail(line, "sql_transaction expects a list of maps with sql and optional params.");
    SMap *m = statements->items[i].map; Value sql = pr_option(m, "sql"), p = pr_option(m, "params");
    const char *const keys[] = {"sql", "params", NULL}; pr_options(m, keys, line);
    if (sql.type != V_STR || (p.type != V_NONE && p.type != V_LIST)) fail(line, "transaction entries require sql text and a params list.");
  }
  sqlite3 *db = pr_database(handle, line); if (!db) return pr_result(0, "sql_transaction: database handle is closed or unknown", SQLITE_MISUSE);
  unsigned long long deadline = pr_clock_ms() + (unsigned)timeout; sqlite3_busy_timeout(db, timeout);
  sqlite3_set_authorizer(db, NULL, NULL); int rc = sqlite3_exec(db, "BEGIN IMMEDIATE", NULL, NULL, NULL); sqlite3_set_authorizer(db, pr_sql_authorize, NULL);
  if (rc != SQLITE_OK) return pr_sql_error(db, rc, "could not begin transaction");
  SList *results = list_new(); Value failure = vnone(); size_t used = 0; int remaining_rows = max_rows;
  for (int i = 0; i < statements->n; i++) {
    SMap *m = statements->items[i].map; Value sql = pr_option(m, "sql"), params = pr_option(m, "params");
    if (used + 512 > (size_t)max_bytes) { failure = pr_result(0, "sql_transaction: aggregate result exceeds max_bytes", SQLITE_TOOBIG); break; }
    Value r = pr_sql_statement(db, sql.str, params.type == V_LIST ? params.list : NULL, deadline, remaining_rows, (size_t)max_bytes - used);
    if (!pr_option(r.map, "ok").boolean) { failure = r; map_set(failure.map, "statement", vnum(i)); break; }
    used += (size_t)pr_option(r.map, "bytes").num;
    remaining_rows -= pr_option(r.map, "rows").list->n;
    list_push(results, r);
    if (pr_clock_ms() >= deadline) { failure = pr_result(0, "sql_transaction: timeout", SQLITE_INTERRUPT); break; }
  }
  sqlite3_set_authorizer(db, NULL, NULL);
  if (failure.type != V_NONE) { int rolled_back = pr_sql_rollback(db); sqlite3_set_authorizer(db, pr_sql_authorize, NULL); map_set(failure.map, "rolled_back", vbool(rolled_back)); return failure; }
  rc = sqlite3_exec(db, "COMMIT", NULL, NULL, NULL);
  if (rc != SQLITE_OK) { Value v = pr_sql_error(db, rc, "commit failed"); int rolled_back = pr_sql_rollback(db); sqlite3_set_authorizer(db, pr_sql_authorize, NULL); map_set(v.map, "rolled_back", vbool(rolled_back)); return v; }
  sqlite3_set_authorizer(db, pr_sql_authorize, NULL); Value v = pr_result(1, NULL, 0); map_set(v.map, "results", vlist(results)); return v;
}
static Value pr_sql_close(Value handle, int line) {
  sqlite3 *db = pr_database(handle, line); if (!db) return pr_result(0, "sql_close: database handle is closed or unknown", SQLITE_MISUSE);
  int rc = sqlite3_close(db); if (rc != SQLITE_OK) return pr_sql_error(db, rc, "database close failed");
  for (int i = 0; i < 64; i++) if (pr_databases[i].db == db) { pr_databases[i].db = NULL; pr_databases[i].id = 0; }
  return pr_result(1, NULL, 0);
}
static void production_cleanup(void) {
  for (int i = 0; i < 64; i++) if (pr_databases[i].db) { sqlite3_close(pr_databases[i].db); pr_databases[i].db = NULL; pr_databases[i].id = 0; }
}
#else
static void production_cleanup(void) {}
#endif
