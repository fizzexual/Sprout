/* Compile-time-only invariants; no shipping runtime switch or language builtin. */
#include <stdlib.h>
static void *review_realloc(void *pointer, size_t bytes);
static void review_event(const char *event, void *env);
#define realloc review_realloc
#define SPROUT_GC_ENV_ROOT_EVENT(event, env) review_event(event, env)
#define main sprout_review_main
#include "../sprout.c"
#undef main
#undef realloc
#include <assert.h>

static int review_fail_root_growth;
static void *review_realloc(void *pointer, size_t bytes) {
  if (review_fail_root_growth && pointer == gc_env_roots && bytes == 64 * sizeof(Env *)) {
    review_fail_root_growth = 0; return NULL;
  }
  return realloc(pointer, bytes);
}
static size_t review_highwater, review_marks, review_statements, review_prepared;
static size_t review_callers, review_values, review_modules, review_tasks;
static size_t review_last_count;
static size_t review_peak_envs, review_peak_maps;
static void review_event(const char *event, void *opaque) {
  if (gc_env_root_count > review_highwater) review_highwater = gc_env_root_count;
  if (opaque) {
    int found = 0;
    for (size_t i = 0; i < gc_env_root_count; i++) if (gc_env_roots[i] == opaque) found = 1;
    assert(found && "an active/prepared environment must already be a precise root");
    if (gc_env_root_count <= review_last_count || gc_env_roots[gc_env_root_count - 1] != opaque) {
      fprintf(stderr, "REVIEW_REQUIRED_SCOPE_PUSH: %s\n", event); exit(91);
    }
  }
  if (!strcmp(event, "marked")) {
    review_marks++;
    for (size_t i = 0; i < gc_env_root_count; i++) {
      GCObj *object = gc_lookup(gc_env_roots[i]);
      assert(object && object->kind == GC_ENV && object->mark);
    }
  } else if (!strcmp(event, "restore")) {
    for (size_t i = gc_env_root_count; i < review_highwater; i++) assert(gc_env_roots[i] == NULL);
  } else if (!strcmp(event, "statement")) review_statements++;
  else if (!strcmp(event, "prepared-expression")) review_prepared++;
  else if (!strcmp(event, "caller")) review_callers++;
  else if (!strcmp(event, "prepared-value")) review_values++;
  else if (!strcmp(event, "module")) review_modules++;
  else if (!strcmp(event, "task")) review_tasks++;
  review_last_count = gc_env_root_count;
}

static void review_stack(void) {
  char marker; gc_stack_bottom = &marker;
  for (int cycle = 0; cycle < 20; cycle++) {
    for (int i = 0; i < 256; i++) {
      Env *env = env_new(NULL); env_define(env, "payload", vmap(map_new())); gc_env_root_push(env);
    }
    assert(gc_env_root_count == 256 && gc_env_root_capacity == 256);
    gc_collect();
    size_t environments = 0, maps = 0;
    for (GCObj *object = gc_all; object; object = object->next) {
      if (object->kind == GC_ENV) environments++;
      if (object->kind == GC_MAP) maps++;
    }
    /* Registered256 Env+map graphs plus a small fixed conservative stale-root
       margin; this measures collectable graphs, not RSS or permanent ASTs. */
    assert(environments >= 256 && environments <= 272 && maps >= 256 && maps <= 272);
    if (environments > review_peak_envs) review_peak_envs = environments;
    if (maps > review_peak_maps) review_peak_maps = maps;
    for (size_t i = 0; i < gc_env_root_count; i++) assert(env_find(gc_env_roots[i], "payload")->type == V_MAP);
    review_highwater = gc_env_root_count;
    gc_env_root_restore(0);
    assert(gc_env_root_count == 0);
  }
  assert(gc_env_root_capacity == 256);
}
int main(int argc, char **argv) {
  int code;
  if (argc == 2 && !strcmp(argv[1], "--root-stack-invariants")) { review_stack(); code = 0; }
  else if (argc == 3 && !strcmp(argv[1], "--root-missing-scope-control")) {
    Env *env = env_new(NULL); gc_env_root_push(env); review_event("setup", env);
    /* Even an already registered/conservatively visible Env cannot substitute
       for the new reservation required by an entering suspended scope. */
    review_event(argv[2], env); return 92;
  }
  else if (argc == 2 && !strcmp(argv[1], "--root-prompt-growth-failure")) {
    global_env = env_new(NULL); cur_file_env = env_new(global_env); cur_fileid = 1;
    Env *session = cur_file_env;
    review_fail_root_growth = 1; run_file_prompt();
    assert(!review_fail_root_growth && cur_file_env == session && cur_fileid == 1);
    assert(call_depth == 0 && !returning && !g_loopctl); code = 0;
  }
  else code = sprout_review_main(argc, argv);
  assert(gc_env_root_count == 0 && "normal/top-level error exit must restore the entry root depth");
  fprintf(stderr, "@gc-env-roots {\"depth\":%zu,\"capacity\":%zu,\"highwater\":%zu,\"marks\":%zu,\"statements\":%zu,\"prepared\":%zu,\"callers\":%zu,\"values\":%zu,\"modules\":%zu,\"tasks\":%zu,\"peak_envs\":%zu,\"peak_maps\":%zu}\n",
          gc_env_root_count, gc_env_root_capacity, review_highwater, review_marks, review_statements,
          review_prepared, review_callers, review_values, review_modules, review_tasks, review_peak_envs, review_peak_maps);
  return code;
}
