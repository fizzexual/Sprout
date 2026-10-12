/* Test-only stdio controls, prepended to the real interpreter by -include.
   Ordinary valid files remain unchanged; no production fault hook is needed. */
#ifndef SPROUT_TEST_STORE_READ_FAULT_H
#define SPROUT_TEST_STORE_READ_FAULT_H
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>
#ifdef _WIN32
#include <wchar.h>
#endif

static FILE *sprout_test_store_file;
static int sprout_test_store_mode(const char *mode) {
  const char *selected = getenv("SPROUT_TEST_STORE_READ_FAULT");
  return selected && (!strcmp(selected, mode) || (!strcmp(mode, "read") && !strcmp(selected, "1")));
}
static FILE *sprout_test_store_fopen(const char *path, const char *mode) {
  FILE *file = fopen(path, mode);
  if (file && !strcmp(path, "sprout.data.json") && strchr(mode, 'r')) sprout_test_store_file = file;
  return file;
}
#ifdef _WIN32
static FILE *sprout_test_store_wfopen(const wchar_t *path, const wchar_t *mode) {
  FILE *file = _wfopen(path, mode);
  if (file && !wcscmp(path, L"sprout.data.json") && wcschr(mode, L'r')) sprout_test_store_file = file;
  return file;
}
#endif
static size_t sprout_test_store_fread(void *buffer, size_t size, size_t count, FILE *file) {
  if (file == sprout_test_store_file && sprout_test_store_mode("read")) { errno = ENOENT; return 0; }
  return fread(buffer, size, count, file);
}
static int sprout_test_store_fseek(FILE *file, long offset, int origin) {
  if (file == sprout_test_store_file && sprout_test_store_mode("seek")) { errno = ENOENT; return -1; }
  return fseek(file, offset, origin);
}
static int sprout_test_store_fclose(FILE *file) {
  int failed = file == sprout_test_store_file && sprout_test_store_mode("close");
  if (file == sprout_test_store_file) sprout_test_store_file = NULL;
  int result = fclose(file);
  if (failed) { errno = ENOENT; return EOF; }
  return result;
}

/* Real declarations and wrapper bodies precede these macros to avoid recursion. */
#define fopen sprout_test_store_fopen
#ifdef _WIN32
#define _wfopen sprout_test_store_wfopen
#endif
#define fread sprout_test_store_fread
#define fseek sprout_test_store_fseek
#define fclose sprout_test_store_fclose
#endif
