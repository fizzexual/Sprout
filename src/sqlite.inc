/* Pinned SQLite adapter, compiled with -DSPROUT_SQLITE + vendor/sqlite/sqlite3.c.
   Handles are registry IDs, never addresses. Statements bind values separately. */
#ifdef SPROUT_SQLITE
static void dist_shahex(const unsigned char *data, size_t len, char out[65]);
#define PR_MIGRATION_TABLE "_sprout_migrations"
#define PR_MIGRATION_DEFINITION PR_MIGRATION_TABLE "(version INTEGER PRIMARY KEY NOT NULL CHECK(version>0),checksum TEXT NOT NULL CHECK(length(checksum)=64),name TEXT NOT NULL,statement_count INTEGER NOT NULL CHECK(statement_count>0),applied_at TEXT NOT NULL)"
#define PR_MIGRATION_MAX 128
static sqlite3 *pr_migration_active_db = NULL;
static int pr_migration_authorizer_context;
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
static int pr_sql_reserved(const char *name) {
  return name && !sqlite3_strnicmp(name, PR_MIGRATION_TABLE, (int)strlen(PR_MIGRATION_TABLE));
}
static int pr_sql_reserved_text(const char *sql) {
  for (const char *p = sql; *p; p++) if (pr_sql_reserved(p)) return 1;
  return 0;
}
static int pr_sql_authorize(void *context, int action, const char *a, const char *b, const char *db, const char *trigger) {
  (void)db; (void)trigger;
  /* Explicit transactions belong to sql_transaction; user COMMIT cannot escape
     its rollback guarantee. Other databases require their own checked handle. */
  if (action == SQLITE_TRANSACTION || action == SQLITE_SAVEPOINT || action == SQLITE_ATTACH || action == SQLITE_DETACH ||
      pr_sql_reserved(a) || pr_sql_reserved(b)) return SQLITE_DENY;
  if (context && action == SQLITE_PRAGMA) return SQLITE_DENY;
  if (action == SQLITE_FUNCTION && b && !sqlite3_stricmp(b, "load_extension")) return SQLITE_DENY;
  return SQLITE_OK;
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
static Value pr_sql_statement_body(sqlite3 *db, const char *sql, SList *params, unsigned long long deadline, int max_rows, size_t max_bytes, int internal) {
  if (!internal && pr_sql_reserved_text(sql)) return pr_result(0, "SQL contains the reserved _sprout_migrations namespace; use sql_migrations to read history", SQLITE_AUTH);
  if (pr_clock_ms() >= deadline) { Value r = pr_result(0, "SQL deadline exceeded", SQLITE_INTERRUPT); map_set(r.map, "timed_out", vbool(1)); return r; }
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
        if (!p || !bytes_valid_utf8((const unsigned char *)p, (size_t)len)) { error = "sql_execute: text must be UTF-8 without NUL; use a BLOB for binary data"; rc = SQLITE_MISMATCH; break; }
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
static Value pr_sql_statement_impl(sqlite3 *db, const char *sql, SList *params, unsigned long long deadline, int max_rows, size_t max_bytes, int internal) {
  unsigned long long now = pr_clock_ms();
  sqlite3_busy_timeout(db, deadline > now ? (int)(deadline - now) : 1);
  sqlite3_progress_handler(db, 1000, pr_sql_cancel, &deadline);
  Value r = pr_sql_statement_body(db, sql, params, deadline, max_rows, max_bytes, internal);
  sqlite3_progress_handler(db, 0, NULL, NULL); return r;
}
static Value pr_sql_statement(sqlite3 *db, const char *sql, SList *params, unsigned long long deadline, int max_rows, size_t max_bytes) {
  return pr_sql_statement_impl(db, sql, params, deadline, max_rows, max_bytes, 0);
}
static int pr_sql_rollback(sqlite3 *db) {
  if (sqlite3_get_autocommit(db)) return 1; /* SQLite may have rolled back on an interrupt. */
  return sqlite3_exec(db, "ROLLBACK", NULL, NULL, NULL) == SQLITE_OK && sqlite3_get_autocommit(db);
}
/* fail_full invokes this before longjmp: no allocations or VM callbacks here. */
static void production_error_cleanup(void) {
  if (!pr_migration_active_db) return;
  sqlite3 *db = pr_migration_active_db; pr_migration_active_db = NULL;
  sqlite3_progress_handler(db, 0, NULL, NULL); sqlite3_set_authorizer(db, NULL, NULL);
  sqlite3_stmt *stmt; while ((stmt = sqlite3_next_stmt(db, NULL))) sqlite3_finalize(stmt);
  sqlite3_busy_timeout(db, 1); (void)pr_sql_rollback(db);
  sqlite3_set_authorizer(db, pr_sql_authorize, NULL);
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
  pr_migration_active_db = db;
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
  if (failure.type != V_NONE) { int rolled_back = pr_sql_rollback(db); pr_migration_active_db = NULL; sqlite3_set_authorizer(db, pr_sql_authorize, NULL); map_set(failure.map, "rolled_back", vbool(rolled_back)); return failure; }
  rc = sqlite3_exec(db, "COMMIT", NULL, NULL, NULL);
  if (rc != SQLITE_OK) { Value v = pr_sql_error(db, rc, "commit failed"); int rolled_back = pr_sql_rollback(db); pr_migration_active_db = NULL; sqlite3_set_authorizer(db, pr_sql_authorize, NULL); map_set(v.map, "rolled_back", vbool(rolled_back)); return v; }
  pr_migration_active_db = NULL; sqlite3_set_authorizer(db, pr_sql_authorize, NULL); Value v = pr_result(1, NULL, 0); map_set(v.map, "results", vlist(results)); return v;
}

typedef struct { int64_t version; const char *name; SList *statements; char checksum[65]; } PRMigration;
static size_t pr_migration_parameter_size(Value v, int line) {
  switch (v.type) {
    case V_NONE: case V_BOOL: return 8;
    case V_NUM: if (!isfinite(v.num)) fail(line, "migration params need finite numbers."); return 32;
    case V_INT: case V_DECIMAL: return 128;
    case V_STR: {
      size_t n = strlen(v.str); if (n > PR_MAX_BYTES || !bytes_valid_utf8((const unsigned char *)v.str, n)) fail(line, "migration text params need UTF-8 without NUL, at most 16 MiB.");
      return n * 6 + 2;
    }
    case V_BYTES: if (v.length > PR_MAX_BYTES) fail(line, "migration bytes exceed 16 MiB."); return v.length * 2 + 64;
    case V_LIST: {
      if ((unsigned)v.list->n > PR_MAX_BYTES) fail(line, "migration byte lists exceed 16 MiB.");
      for (int i = 0; i < v.list->n; i++) {
        Value b = v.list->items[i]; double n = b.type == V_INT ? (double)b.exact : b.num;
        if ((b.type != V_NUM && b.type != V_INT) || !isfinite(n) || n != floor(n) || n < 0 || n > 255) fail(line, "migration list params must be byte lists (0..255).");
      }
      return (size_t)v.list->n * 5 + 2;
    }
    default: fail(line, "migration params support text, finite numbers, exact values, booleans, nothing, or bytes."); return 0;
  }
}
static Value pr_migration_timeout(void) { Value r = pr_result(0, "migration deadline exceeded", SQLITE_INTERRUPT); map_set(r.map, "timed_out", vbool(1)); return r; }
static Value pr_sql_internal_statement(sqlite3 *db, const char *sql, SList *params, unsigned long long deadline, int rows, size_t bytes) {
  sqlite3_int64 last_id = sqlite3_last_insert_rowid(db);
  sqlite3_set_authorizer(db, NULL, NULL);
  Value r = pr_sql_statement_impl(db, sql, params, deadline, rows, bytes, 1);
  sqlite3_set_last_insert_rowid(db, last_id);
  sqlite3_set_authorizer(db, pr_sql_authorize, NULL); return r;
}
static int pr_sql_internal_exec(sqlite3 *db, const char *sql, unsigned long long deadline) {
  unsigned long long now = pr_clock_ms(); if (now >= deadline) return SQLITE_INTERRUPT;
  unsigned long long remaining = deadline - now;
  sqlite3_busy_timeout(db, remaining ? (int)remaining : 1);
  sqlite3_set_authorizer(db, NULL, NULL); sqlite3_progress_handler(db, 1000, pr_sql_cancel, &deadline);
  int rc = sqlite3_exec(db, sql, NULL, NULL, NULL);
  sqlite3_progress_handler(db, 0, NULL, NULL); sqlite3_set_authorizer(db, pr_sql_authorize, NULL); return rc;
}
static Value pr_migration_history(sqlite3 *db, unsigned long long deadline, int max_rows, size_t max_bytes) {
  Value schema = pr_sql_internal_statement(db, "SELECT type,sql FROM main.sqlite_schema WHERE name='_sprout_migrations' COLLATE NOCASE", NULL, deadline, 2, max_bytes);
  if (!pr_option(schema.map, "ok").boolean) return schema;
  SList *records = pr_option(schema.map, "rows").list;
  if (records->n && (records->n != 1 || records->items[0].list->items[0].type != V_STR ||
      strcmp(records->items[0].list->items[0].str, "table") || records->items[0].list->items[1].type != V_STR ||
      strcmp(records->items[0].list->items[1].str, "CREATE TABLE " PR_MIGRATION_DEFINITION)))
    return pr_result(0, "incompatible migration ledger schema", SQLITE_CORRUPT);
  SList *entries = list_new(); int64_t last = 0; size_t used = 512;
  if (records->n) {
    Value triggers = pr_sql_internal_statement(db, "SELECT name FROM main.sqlite_schema WHERE type='trigger' AND tbl_name='_sprout_migrations' COLLATE NOCASE", NULL, deadline, 1, max_bytes);
    if (!pr_option(triggers.map, "ok").boolean) return triggers;
    if (pr_option(triggers.map, "rows").list->n) return pr_result(0, "migration ledger has an unexpected trigger", SQLITE_CORRUPT);
    Value history = pr_sql_internal_statement(db, "SELECT version,checksum,name,statement_count,applied_at FROM main._sprout_migrations ORDER BY version", NULL, deadline, max_rows < PR_MIGRATION_MAX ? max_rows : PR_MIGRATION_MAX, max_bytes);
    if (!pr_option(history.map, "ok").boolean) return history;
    SList *rows = pr_option(history.map, "rows").list; used = (size_t)pr_option(history.map, "bytes").num;
    for (int i = 0; i < rows->n; i++) {
      SList *row = rows->items[i].list;
      if (row->items[0].type != V_INT || row->items[0].exact <= last || row->items[1].type != V_STR || strlen(row->items[1].str) != 64 ||
          row->items[2].type != V_STR || strlen(row->items[2].str) > 256 || row->items[3].type != V_INT || row->items[3].exact < 1 || row->items[3].exact > 10000 ||
          row->items[4].type != V_STR || !row->items[4].str[0] || strlen(row->items[4].str) > 64)
        return pr_result(0, "corrupt migration ledger row", SQLITE_CORRUPT);
      for (int k = 0; k < 64; k++) if (!((row->items[1].str[k] >= '0' && row->items[1].str[k] <= '9') || (row->items[1].str[k] >= 'a' && row->items[1].str[k] <= 'f')))
        return pr_result(0, "corrupt migration checksum", SQLITE_CORRUPT);
      SMap *entry = map_new(); const char *keys[] = {"version", "checksum", "name", "statement_count", "applied_at"};
      for (int k = 0; k < 5; k++) map_set(entry, keys[k], row->items[k]);
      list_push(entries, vmap(entry)); last = row->items[0].exact;
    }
  }
  Value r = pr_result(1, NULL, 0); map_set(r.map, "entries", vlist(entries)); map_set(r.map, "current_version", vexact(last, 0, 0)); map_set(r.map, "exists", vbool(records->n != 0));
  map_set(r.map, "bytes", vnum((double)used)); return r;
}
static Value pr_migration_failure(sqlite3 *db, Value failure) {
  sqlite3_progress_handler(db, 0, NULL, NULL); sqlite3_set_authorizer(db, NULL, NULL); sqlite3_busy_timeout(db, 1);
  int rollback = pr_sql_rollback(db); pr_migration_active_db = NULL; sqlite3_set_authorizer(db, pr_sql_authorize, NULL);
  map_set(failure.map, "rolled_back", vbool(rollback)); return failure;
}
static Value pr_sql_migrations(Value handle, SMap *options, int line) {
  const char *const keys[] = {"timeout_ms", "max_rows", "max_bytes", NULL}; pr_options(options, keys, line);
  int timeout = pr_deadline_timeout(pr_int_option(options, "timeout_ms", PR_DEFAULT_TIMEOUT, 1, 3600000, line));
  int max_rows = pr_int_option(options, "max_rows", 10000, 1, 100000, line), max_bytes = pr_int_option(options, "max_bytes", PR_DEFAULT_BYTES, 1, PR_MAX_BYTES, line);
  sqlite3 *db = pr_database(handle, line); if (!db) return pr_result(0, "sql_migrations: database handle is closed or unknown", SQLITE_MISUSE);
  Value r = pr_migration_history(db, pr_clock_ms() + (unsigned)timeout, max_rows, (size_t)max_bytes);
  if (pr_option(r.map, "ok").boolean) {
    char *encoded = value_to_json_internal(r); size_t n = strlen(encoded); free(encoded);
    if (n > (size_t)max_bytes) return pr_result(0, "migration history exceeds max_bytes", SQLITE_TOOBIG);
  }
  return r;
}
static Value pr_sql_migrate(Value handle, SList *migrations, SMap *options, int line) {
  const char *const keys[] = {"timeout_ms", "max_rows", "max_bytes", NULL}; pr_options(options, keys, line);
  int timeout = pr_deadline_timeout(pr_int_option(options, "timeout_ms", PR_DEFAULT_TIMEOUT, 1, 3600000, line));
  int max_rows = pr_int_option(options, "max_rows", 10000, 1, 100000, line), max_bytes = pr_int_option(options, "max_bytes", PR_DEFAULT_BYTES, 1, PR_MAX_BYTES, line);
  unsigned long long deadline = pr_clock_ms() + (unsigned)timeout;
  if (migrations->n > PR_MIGRATION_MAX) fail(line, "sql_migrate supports at most 128 migration versions.");
  PRMigration plan[PR_MIGRATION_MAX]; int64_t previous = 0; int statements = 0; size_t input_bytes = 0;
  for (int i = 0; i < migrations->n; i++) {
    if (migrations->items[i].type != V_MAP) fail(line, "migration entries require version, optional name, and statements.");
    SMap *m = migrations->items[i].map; const char *const allowed[] = {"version", "name", "statements", NULL}; pr_options(m, allowed, line);
    Value version = pr_option(m, "version"), name = pr_option(m, "name"), items = pr_option(m, "statements"); int64_t v = 0;
    if (version.type == V_INT) v = version.exact;
    else if (version.type == V_NUM && isfinite(version.num) && version.num == floor(version.num) && version.num > 0 && version.num <= 9007199254740991.0) v = (int64_t)version.num;
    else fail(line, "migration versions need positive integer values (use integer(text) for large int64 versions).");
    if (v <= previous) fail(line, "migration versions must be positive and strictly increasing.");
    previous = v;
    if (name.type != V_NONE && (name.type != V_STR || strlen(name.str) > 256 || !bytes_valid_utf8((const unsigned char *)name.str, strlen(name.str)))) fail(line, "migration name must be UTF-8 text of at most 256 bytes.");
    if (items.type != V_LIST || items.list->n < 1 || items.list->n > 10000 - statements) fail(line, "each migration needs statements; at most 10,000 statements are allowed in total.");
    statements += items.list->n; SList *canonical = list_new(); size_t size = 512;
    for (int j = 0; j < items.list->n; j++) {
      if (items.list->items[j].type != V_MAP) fail(line, "migration statements require sql and optional params.");
      SMap *s = items.list->items[j].map; const char *const allowed_statement[] = {"sql", "params", NULL}; pr_options(s, allowed_statement, line);
      Value sql = pr_option(s, "sql"), params = pr_option(s, "params");
      if (sql.type != V_STR || !sql.str[0] || strlen(sql.str) > 1048576 || !bytes_valid_utf8((const unsigned char *)sql.str, strlen(sql.str)) || (params.type != V_NONE && params.type != V_LIST)) fail(line, "migration statements need UTF-8 sql (up to 1 MiB) and optional params lists.");
      if (params.type == V_NONE) params = vlist(list_new());
      if (params.list->n > 1000) fail(line, "migration statements support at most 1000 bound parameters.");
      size += strlen(sql.str) * 6 + 128;
      for (int k = 0; k < params.list->n; k++) {
        size += pr_migration_parameter_size(params.list->items[k], line);
        if (size > PR_MAX_BYTES) fail(line, "migration canonical input exceeds 16 MiB.");
      }
      if (size > PR_MAX_BYTES) fail(line, "migration canonical input exceeds 16 MiB.");
      SMap *statement = map_new(); map_set(statement, "sql", sql); map_set(statement, "params", params); list_push(canonical, vmap(statement));
    }
    SMap *content = map_new(); map_set(content, "version", vexact(v, 0, 0)); map_set(content, "name", name.type == V_STR ? name : vstr("")); map_set(content, "statements", vlist(canonical));
    char *encoded = value_to_json_internal(vmap(content)); size_t n = strlen(encoded);
    if (n > PR_MAX_BYTES - input_bytes) { free(encoded); fail(line, "migration canonical input exceeds 16 MiB in total."); }
    input_bytes += n; plan[i].version = v; plan[i].name = pr_option(content, "name").str; plan[i].statements = canonical;
    dist_shahex((const unsigned char *)encoded, n, plan[i].checksum); free(encoded);
    if (pr_clock_ms() >= deadline) return pr_migration_timeout();
  }
  sqlite3 *db = pr_database(handle, line); if (!db) return pr_result(0, "sql_migrate: database handle is closed or unknown", SQLITE_MISUSE);
  int rc = pr_sql_internal_exec(db, "BEGIN IMMEDIATE", deadline);
  if (rc != SQLITE_OK) { Value failure = rc == SQLITE_INTERRUPT ? pr_migration_timeout() : pr_sql_error(db, rc, "could not begin migration transaction"); return failure; }
  pr_migration_active_db = db;
  Value history = pr_migration_history(db, deadline, PR_MIGRATION_MAX, (size_t)max_bytes);
  if (!pr_option(history.map, "ok").boolean) return pr_migration_failure(db, history);
  SList *entries = pr_option(history.map, "entries").list;
  if (entries->n > migrations->n) return pr_migration_failure(db, pr_result(0, "applied migration history was deleted from the supplied list", SQLITE_MISMATCH));
  for (int i = 0; i < entries->n; i++) {
    SMap *entry = entries->items[i].map;
    if (pr_option(entry, "version").exact != plan[i].version || strcmp(pr_option(entry, "checksum").str, plan[i].checksum) ||
        strcmp(pr_option(entry, "name").str, plan[i].name) || pr_option(entry, "statement_count").exact != plan[i].statements->n)
      return pr_migration_failure(db, pr_result(0, "applied migration history was edited, removed, or reordered", SQLITE_MISMATCH));
  }
  SList *applied = list_new(), *results = list_new(); size_t used = 512; int remaining_rows = max_rows;
  if (entries->n < migrations->n && !pr_option(history.map, "exists").boolean) {
    rc = pr_sql_internal_exec(db, "CREATE TABLE main." PR_MIGRATION_DEFINITION, deadline);
    if (rc != SQLITE_OK) return pr_migration_failure(db, pr_sql_error(db, rc, "could not create migration ledger"));
  }
  for (int i = entries->n; i < migrations->n; i++) {
    for (int j = 0; j < plan[i].statements->n; j++) {
      if (used + 512 > (size_t)max_bytes) return pr_migration_failure(db, pr_result(0, "aggregate migration results exceed max_bytes", SQLITE_TOOBIG));
      SMap *s = plan[i].statements->items[j].map; Value sql = pr_option(s, "sql"), params = pr_option(s, "params");
      sqlite3_set_authorizer(db, pr_sql_authorize, &pr_migration_authorizer_context);
      Value r = pr_sql_statement(db, sql.str, params.list, deadline, remaining_rows, (size_t)max_bytes - used);
      map_set(r.map, "migration_version", vexact(plan[i].version, 0, 0)); map_set(r.map, "statement", vnum(j));
      if (!pr_option(r.map, "ok").boolean) return pr_migration_failure(db, r);
      used += (size_t)pr_option(r.map, "bytes").num; remaining_rows -= pr_option(r.map, "rows").list->n; list_push(results, r);
      if (pr_clock_ms() >= deadline) return pr_migration_failure(db, pr_migration_timeout());
    }
    SList *params = list_new(); list_push(params, vexact(plan[i].version, 0, 0)); list_push(params, vstr(plan[i].checksum)); list_push(params, vstr(plan[i].name)); list_push(params, vexact(plan[i].statements->n, 0, 0));
    Value inserted = pr_sql_internal_statement(db, "INSERT INTO main._sprout_migrations(version,checksum,name,statement_count,applied_at) VALUES(?,?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'))", params, deadline, 1, (size_t)max_bytes);
    if (!pr_option(inserted.map, "ok").boolean) return pr_migration_failure(db, inserted);
    list_push(applied, vexact(plan[i].version, 0, 0));
  }
  Value r = pr_result(1, NULL, 0); map_set(r.map, "applied", vlist(applied)); map_set(r.map, "results", vlist(results));
  map_set(r.map, "current_version", vexact(migrations->n ? plan[migrations->n - 1].version : 0, 0, 0)); map_set(r.map, "bytes", vnum((double)used));
  char *encoded = value_to_json_internal(r); size_t output = strlen(encoded); free(encoded);
  if (output > (size_t)max_bytes) return pr_migration_failure(db, pr_result(0, "serialized migration result exceeds max_bytes", SQLITE_TOOBIG));
  if (pr_clock_ms() >= deadline) return pr_migration_failure(db, pr_migration_timeout());
  if (g_runtime_max_steps && g_runtime_steps >= g_runtime_max_steps) fail_hard(line, "limit", "migration commit requires remaining --max-steps budget.");
  rc = pr_sql_internal_exec(db, "COMMIT", deadline);
  if (rc != SQLITE_OK) return pr_migration_failure(db, rc == SQLITE_INTERRUPT ? pr_migration_timeout() : pr_sql_error(db, rc, "migration commit failed"));
  pr_migration_active_db = NULL; sqlite3_set_authorizer(db, pr_sql_authorize, NULL); return r;
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
static void production_error_cleanup(void) {}
static void production_cleanup(void) {}
#endif
