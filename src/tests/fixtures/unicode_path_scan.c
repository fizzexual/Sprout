/* Ordinary normalization controls for the real interpreter's bounded path scan.
   No file is created and no old unchecked implementation is executed. */
#define main sprout_program_main
#include "../../sprout.c"
#undef main

int main(void) {
  g_dist_root = canon_path("C:/sprout-control");
  for (char *p = g_dist_root; *p; p++) if (*p == '\\') *p = '/';
  char *relative = dist_project_relative("C:/sprout-control/source.sprout");
  if (!relative || strcmp(relative, "source.sprout")) return 1;
  free(relative); free(g_dist_root);
  char root[2048] = "C:/", full[2080];
  for (int component = 0; component < 4; component++) {
    if (component) strcat(root, "/");
    for (int i = 0; i < 60; i++) strcat(root, "\xe7\x9b\xae\xe5\xbd\x95");
  }
  g_dist_root = canon_path(root);
  for (char *p = g_dist_root; *p; p++) if (*p == '\\') *p = '/';
  size_t length = strlen(g_dist_root);
  if (length < 1024) return 2;
  snprintf(full, sizeof full, "%s/source.sprout", root);
  relative = dist_project_relative(full);
  if (relative) { free(relative); free(g_dist_root); return 3; }
  free(g_dist_root); g_dist_root = NULL;
  printf("{\"short_path_accepted\":true,\"long_path_rejected\":true,\"root_utf8_bytes\":%zu}\n", length);
  return 0;
}
