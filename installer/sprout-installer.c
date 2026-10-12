/* sprout-installer.c — a friendly wizard that installs, updates, or removes
 * Sprout. The Sprout interpreter (sprout.exe) is EMBEDDED inside this installer
 * (see sprout.rc), so installing needs no download and the GitHub release ships a
 * single file. "Update" opens GitHub's release selection and checksum guidance.
 *
 * Pure C, only Windows' own libraries — no dependencies.
 *   build.cmd            (copies in sprout.exe, runs windres, then gcc)
 *
 * Installs per-user to %LOCALAPPDATA%\Programs\Sprout (no administrator needed).
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <io.h>
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <shellapi.h>
#include <urlmon.h>

#define RELEASES_PAGE "https://github.com/fizzexual/Sprout/releases"

#define C_RESET "\x1b[0m"
#define C_GREEN "\x1b[32m"
#define C_BOLD  "\x1b[1m"
#define C_DIM   "\x1b[2m"
#define C_RED   "\x1b[31m"
#define C_CYAN  "\x1b[36m"

static void console_setup(void) {
  SetConsoleOutputCP(65001);                                   /* UTF-8 so 🌱 and ▸ render */
  HANDLE h = GetStdHandle(STD_OUTPUT_HANDLE); DWORD m;
  if (GetConsoleMode(h, &m)) SetConsoleMode(h, m | 0x0004);    /* ENABLE_VIRTUAL_TERMINAL_PROCESSING */
}

static int install_dir(char *out, size_t n) {
  const char *base = getenv("LOCALAPPDATA");
  if (!base) base = getenv("APPDATA");
  int written = snprintf(out, n, "%s\\Programs\\Sprout", base ? base : "C:\\Sprout");
  return written >= 0 && (size_t)written < n;
}

static void ensure_dir(const char *dir) {
  char tmp[MAX_PATH]; snprintf(tmp, sizeof tmp, "%s", dir);
  for (char *p = tmp + 3; *p; p++) {                           /* skip the "C:\" */
    if (*p == '\\') { *p = 0; CreateDirectoryA(tmp, NULL); *p = '\\'; }
  }
  CreateDirectoryA(tmp, NULL);
}

/* ---- PATH (HKCU\Environment) ---- */
#define MAX_USER_PATH_BYTES (1024 * 1024)
static LSTATUS path_read(char **out, DWORD *stored_type) {
  HKEY key; *out = NULL;
  LSTATUS error = RegOpenKeyExA(HKEY_CURRENT_USER, "Environment", 0, KEY_READ, &key);
  if (error != ERROR_SUCCESS) return error;
  DWORD type = 0, capacity = 0;
  error = RegQueryValueExA(key, "Path", NULL, &type, NULL, &capacity);
  if (error == ERROR_FILE_NOT_FOUND) {
    LSTATUS closed = RegCloseKey(key);
    if (closed != ERROR_SUCCESS) return closed;
    *out = _strdup(""); *stored_type = REG_EXPAND_SZ;
    return *out ? ERROR_SUCCESS : ERROR_OUTOFMEMORY;
  }
  if (error != ERROR_SUCCESS || (type != REG_SZ && type != REG_EXPAND_SZ) || !capacity || capacity > MAX_USER_PATH_BYTES) {
    RegCloseKey(key);
    return error != ERROR_SUCCESS ? error : ERROR_INVALID_DATA;
  }
  char *buffer = (char *)malloc(capacity);
  if (!buffer) { RegCloseKey(key); return ERROR_OUTOFMEMORY; }
  DWORD actual = capacity, actual_type = 0;
  error = RegQueryValueExA(key, "Path", NULL, &actual_type, (BYTE *)buffer, &actual);
  LSTATUS closed = RegCloseKey(key);
  if (error == ERROR_SUCCESS && (actual_type != type || !actual || actual > capacity ||
      memchr(buffer, 0, actual) != buffer + actual - 1)) error = ERROR_INVALID_DATA;
  if (error == ERROR_SUCCESS) error = closed;
  if (error != ERROR_SUCCESS) { free(buffer); return error; }
  *out = buffer; *stored_type = type;
  return ERROR_SUCCESS;
}

static LSTATUS path_write(const char *val, DWORD type) {
  size_t length = strlen(val) + 1;
  if (length > MAX_USER_PATH_BYTES) return ERROR_BUFFER_OVERFLOW;
  HKEY key;
  LSTATUS error = RegOpenKeyExA(HKEY_CURRENT_USER, "Environment", 0, KEY_SET_VALUE, &key);
  if (error != ERROR_SUCCESS) return error;
  error = RegSetValueExA(key, "Path", 0, type, (const BYTE *)val, (DWORD)length);
  LSTATUS closed = RegCloseKey(key);
  if (error != ERROR_SUCCESS) return error;
  if (closed != ERROR_SUCCESS) return closed;
  DWORD_PTR res;                                                /* tell running apps to reload the environment */
  SendMessageTimeoutA(HWND_BROADCAST, WM_SETTINGCHANGE, 0, (LPARAM)"Environment", SMTO_ABORTIFHUNG, 4000, &res);
  return ERROR_SUCCESS;
}

static int path_has(const char *path, const char *dir) {
  size_t length = strlen(dir);
  while (*path) {
    const char *end = strchr(path, ';');
    if (!end) end = path + strlen(path);
    const char *next = *end ? end + 1 : end;
    while (path < end && *path == ' ') path++;
    while (end > path && end[-1] == ' ') end--;
    if ((size_t)(end - path) == length && !_strnicmp(path, dir, length)) return 1;
    path = next;
  }
  return 0;
}

static LSTATUS path_add(const char *dir) {
  char *cur; DWORD type;
  LSTATUS error = path_read(&cur, &type);
  if (error != ERROR_SUCCESS) return error;
  if (path_has(cur, dir)) { free(cur); return ERROR_SUCCESS; }
  size_t directory_length = strlen(dir), current_length = strlen(cur);
  size_t n = directory_length + 1 + current_length + 1;
  if (n > MAX_USER_PATH_BYTES) { free(cur); return ERROR_BUFFER_OVERFLOW; }
  char *nv = (char *)malloc(n);
  if (!nv) { free(cur); return ERROR_OUTOFMEMORY; }
  memcpy(nv, dir, directory_length);
  if (*cur) { nv[directory_length] = ';'; memcpy(nv + directory_length + 1, cur, current_length + 1); }
  else nv[directory_length] = 0;
  error = path_write(nv, type);
  free(nv); free(cur);
  return error;
}

static LSTATUS path_remove(const char *dir) {
  char *cur; DWORD type;
  LSTATUS error = path_read(&cur, &type);
  if (error != ERROR_SUCCESS) return error;
  if (!path_has(cur, dir)) { free(cur); return ERROR_SUCCESS; }
  char *nv = (char *)malloc(strlen(cur) + 1), *copy = _strdup(cur);
  if (!nv || !copy) { free(nv); free(copy); free(cur); return ERROR_OUTOFMEMORY; }
  nv[0] = 0;
  int first = 1;
  for (char *t = strtok(copy, ";"); t; t = strtok(NULL, ";")) {
    char *s = t; while (*s == ' ') s++;
    char *end = s + strlen(s); while (end > s && end[-1] == ' ') end--;
    *end = 0;
    if (_stricmp(s, dir) == 0) continue;                       /* drop our own entry */
    if (!first) strcat(nv, ";");
    strcat(nv, t); first = 0;
  }
  error = path_write(nv, type);
  free(copy); free(nv); free(cur);
  return error;
}

/* Only publish an exact, closed, runnable copy of the embedded interpreter. */
static int candidate_runs(const char *path, int *cleanup_confirmed) {
  *cleanup_confirmed = 1;
  char command[MAX_PATH + 32];
  int written = snprintf(command, sizeof command, "\"%s\" version", path);
  if (written < 0 || (size_t)written >= sizeof command) return 0;
  STARTUPINFOA startup; PROCESS_INFORMATION process;
  memset(&startup, 0, sizeof startup); startup.cb = sizeof startup;
  memset(&process, 0, sizeof process);
  if (!CreateProcessA(path, command, NULL, NULL, FALSE, CREATE_NO_WINDOW,
                      NULL, NULL, &startup, &process)) return 0;
  DWORD waited = WaitForSingleObject(process.hProcess, 5000), code = 1;
  *cleanup_confirmed = waited == WAIT_OBJECT_0;
  int ok = waited == WAIT_OBJECT_0 && GetExitCodeProcess(process.hProcess, &code) && code == 0;
  if (waited != WAIT_OBJECT_0) {
    printf("  Version probe did not finish successfully within its wait budget.\n");
    BOOL terminated = TerminateProcess(process.hProcess, 1);
    DWORD terminate_error = terminated ? 0 : GetLastError();
    DWORD final_wait = WaitForSingleObject(process.hProcess, 5000);
    *cleanup_confirmed = final_wait == WAIT_OBJECT_0;
    if (!*cleanup_confirmed) {
      printf("  Version probe cleanup could not be confirmed (termination error %lu, wait result %lu); candidate retained at %s.\n",
             (unsigned long)terminate_error, (unsigned long)final_wait, path);
    }
  }
  CloseHandle(process.hThread); CloseHandle(process.hProcess);
  return ok;
}

static int candidate_matches(const char *path, const unsigned char *data, size_t size) {
  FILE *file = fopen(path, "rb");
  if (!file) return 0;
  unsigned char buffer[8192]; size_t at = 0;
  int ok = 1;
  while (at < size) {
    size_t amount = size - at < sizeof buffer ? size - at : sizeof buffer;
    if (fread(buffer, 1, amount, file) != amount || memcmp(buffer, data + at, amount)) { ok = 0; break; }
    at += amount;
  }
  if (ok && (fgetc(file) != EOF || ferror(file))) ok = 0;
  if (fclose(file) != 0) ok = 0;
  return ok;
}

/* Same-directory staging keeps the existing destination intact on failure. */
static int write_embedded(const char *dest) {
  HRSRC r = FindResourceA(NULL, "SPROUT_EXE", RT_RCDATA);
  if (!r) return 0;
  HGLOBAL g = LoadResource(NULL, r);
  void *data = LockResource(g);
  DWORD size = SizeofResource(NULL, r);
  if (!data || !size) return 0;
  char directory[MAX_PATH], staged[MAX_PATH];
  int length = snprintf(directory, sizeof directory, "%s", dest);
  if (length < 0 || (size_t)length >= sizeof directory) return 0;
  char *slash = strrchr(directory, '\\');
  if (!slash) return 0;
  *slash = 0;
  if (!GetTempFileNameA(directory, "spr", 0, staged)) return 0;
  FILE *f = fopen(staged, "wb");
  int ok = 0;
  if (f) {
    ok = fwrite(data, 1, size, f) == (size_t)size && fflush(f) == 0;
    if (ok) {
      intptr_t handle = _get_osfhandle(_fileno(f));
      ok = handle != -1 && FlushFileBuffers((HANDLE)handle);
    }
    if (fclose(f) != 0) ok = 0;
  }
  int cleanup_confirmed = 1;
  if (ok) ok = candidate_matches(staged, data, size) && candidate_runs(staged, &cleanup_confirmed);
  if (ok) ok = MoveFileExA(staged, dest, MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH);
  if (!ok && cleanup_confirmed && !DeleteFileA(staged))
    printf("  Failed candidate cleanup (error %lu); staged file retained at %s.\n", (unsigned long)GetLastError(), staged);
  return ok;
}

static int do_install(void) {
  char dir[MAX_PATH];
  if (!install_dir(dir, sizeof dir)) { printf("  %sinstall failed%s - installation path is too long.\n", C_RED, C_RESET); return 1; }
  char *prior_path; DWORD prior_type;
  LSTATUS path_error = path_read(&prior_path, &prior_type);
  if (path_error != ERROR_SUCCESS) { printf("  %sinstall failed%s - existing PATH could not be read safely (error %ld); the installation was preserved.\n", C_RED, C_RESET, (long)path_error); return 1; }
  free(prior_path);
  char exe[MAX_PATH + 16]; snprintf(exe, sizeof exe, "%s\\sprout.exe", dir);
  printf("\n  Installing Sprout into %s%s%s ...\n", C_CYAN, dir, C_RESET);
  ensure_dir(dir);
  if (!write_embedded(exe)) { printf("  %sinstall failed%s - the candidate could not be written, verified, or published; an existing sprout.exe was preserved.\n", C_RED, C_RESET); return 1; }
  path_error = path_add(dir);
  if (path_error != ERROR_SUCCESS) {
    printf("  %sPATH update failed%s (error %ld). The executable was published at %s; this is not a runtime rollback.\n", C_RED, C_RESET, (long)path_error, exe);
    printf("  Use that executable directly or repair your user PATH before retrying.\n");
    return 1;
  }
  printf("\n  %sInstalled!%s Open a %snew%s terminal and run:  %ssprout%s\n", C_GREEN, C_RESET, C_BOLD, C_RESET, C_GREEN, C_RESET);
  return 0;
}

static int do_update(void) {
  printf("\n  Select an exact version tag at %s\n", RELEASES_PAGE);
  printf("  Verify sprout-installer.exe against that release's SHA256SUMS before running it.\n");
  printf("  Keep the release manifest and source revision. Back up data before upgrading.\n");
  printf("  Development prereleases are listed separately and are never GitHub's Latest release.\n");
  if ((INT_PTR)ShellExecuteA(NULL, "open", RELEASES_PAGE, NULL, NULL, SW_SHOWNORMAL) <= 32) {
    printf("  The releases page could not be opened; use the URL above in your browser.\n");
    return 1;
  }
  return 0;
}

static int do_uninstall(void) {
  char dir[MAX_PATH];
  if (!install_dir(dir, sizeof dir)) { printf("  %suninstall failed%s - installation path is too long.\n", C_RED, C_RESET); return 1; }
  char exe[MAX_PATH + 16]; snprintf(exe, sizeof exe, "%s\\sprout.exe", dir);
  printf("\n  Removing Sprout from %s%s%s ...\n", C_CYAN, dir, C_RESET);
  if (!DeleteFileA(exe)) {
    DWORD error = GetLastError();
    if (error != ERROR_FILE_NOT_FOUND && error != ERROR_PATH_NOT_FOUND) {
      printf("  %suninstall failed%s - executable removal failed (error %lu); PATH was not changed.\n", C_RED, C_RESET, (unsigned long)error);
      return 1;
    }
  }
  if (!RemoveDirectoryA(dir)) {
    DWORD error = GetLastError();
    if (error != ERROR_FILE_NOT_FOUND && error != ERROR_PATH_NOT_FOUND)
      printf("  Executable removed; installation directory retained (error %lu).\n", (unsigned long)error);
  }
  LSTATUS error = path_remove(dir);
  if (error != ERROR_SUCCESS) { printf("  %sPATH cleanup failed%s (error %ld); the executable removal and PATH edit are separate operations.\n", C_RED, C_RESET, (long)error); return 1; }
  printf("  %sUninstalled.%s Sprout is off your PATH (open a new terminal).\n", C_GREEN, C_RESET);
  return 0;
}

static void banner(void) {
  printf("\n  %s%sSprout Installer%s  \xF0\x9F\x8C\xB1\n", C_GREEN, C_BOLD, C_RESET);
  printf("  %sinstall, update, or remove Sprout - a tiny language written in C%s\n\n", C_DIM, C_RESET);
}

int main(void) {
  console_setup();
  int last_result = 0;
  for (;;) {
    banner();
    printf("    %s1%s  Install Sprout\n", C_GREEN, C_RESET);
    printf("    %s2%s  Choose a verified release " C_DIM "(on GitHub)" C_RESET "\n", C_GREEN, C_RESET);
    printf("    %s3%s  Uninstall\n", C_GREEN, C_RESET);
    printf("    %s4%s  Quit\n\n", C_GREEN, C_RESET);
    printf("  %schoose \xE2\x96\xB8 %s", C_CYAN, C_RESET); fflush(stdout);
    char line[64];
    if (!fgets(line, sizeof line, stdin)) break;
    char c = line[0];
    if      (c == '1') last_result = do_install();
    else if (c == '2') last_result = do_update();
    else if (c == '3') last_result = do_uninstall();
    else if (c == '4' || c == 'q' || c == 'Q') break;
    else { printf("\n  %splease pick 1-4.%s\n", C_DIM, C_RESET); continue; }
    printf("\n  %spress Enter to return to the menu ...%s", C_DIM, C_RESET); fflush(stdout);
    char t[16]; if (!fgets(t, sizeof t, stdin)) break;
  }
  printf("\n  %sbye! \xF0\x9F\x8C\xB1%s\n\n", C_GREEN, C_RESET);
  return last_result;
}
