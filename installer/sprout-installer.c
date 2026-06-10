/* sprout-installer.c — a friendly wizard that installs, updates, or removes
 * Sprout. The Sprout interpreter (sprout.exe) is EMBEDDED inside this installer
 * (see sprout.rc), so installing needs no download and the GitHub release ships a
 * single file. "Update" fetches the latest installer from GitHub.
 *
 * Pure C, only Windows' own libraries — no dependencies.
 *   build.cmd            (copies in sprout.exe, runs windres, then gcc)
 *
 * Installs per-user to %LOCALAPPDATA%\Programs\Sprout (no administrator needed).
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <shellapi.h>
#include <urlmon.h>

#define LATEST_INSTALLER "https://github.com/fizzexual/Sprout/releases/latest/download/sprout-installer.exe"

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

static void install_dir(char *out, size_t n) {
  const char *base = getenv("LOCALAPPDATA");
  if (!base) base = getenv("APPDATA");
  snprintf(out, n, "%s\\Programs\\Sprout", base ? base : "C:\\Sprout");
}

static void ensure_dir(const char *dir) {
  char tmp[MAX_PATH]; snprintf(tmp, sizeof tmp, "%s", dir);
  for (char *p = tmp + 3; *p; p++) {                           /* skip the "C:\" */
    if (*p == '\\') { *p = 0; CreateDirectoryA(tmp, NULL); *p = '\\'; }
  }
  CreateDirectoryA(tmp, NULL);
}

/* ---- PATH (HKCU\Environment) ---- */
static char *path_read(void) {
  HKEY k;
  if (RegOpenKeyExA(HKEY_CURRENT_USER, "Environment", 0, KEY_READ, &k) != ERROR_SUCCESS) return _strdup("");
  DWORD type = 0, sz = 0;
  if (RegQueryValueExA(k, "Path", NULL, &type, NULL, &sz) != ERROR_SUCCESS || sz == 0) { RegCloseKey(k); return _strdup(""); }
  char *buf = (char *)malloc(sz + 1);
  RegQueryValueExA(k, "Path", NULL, &type, (BYTE *)buf, &sz);
  buf[sz] = 0; RegCloseKey(k);
  return buf;
}

static void path_write(const char *val) {
  HKEY k;
  if (RegOpenKeyExA(HKEY_CURRENT_USER, "Environment", 0, KEY_SET_VALUE, &k) != ERROR_SUCCESS) return;
  RegSetValueExA(k, "Path", 0, REG_EXPAND_SZ, (const BYTE *)val, (DWORD)strlen(val) + 1);
  RegCloseKey(k);
  DWORD_PTR res;                                                /* tell running apps to reload the environment */
  SendMessageTimeoutA(HWND_BROADCAST, WM_SETTINGCHANGE, 0, (LPARAM)"Environment", SMTO_ABORTIFHUNG, 4000, &res);
}

static int path_has(const char *path, const char *dir) {
  char *copy = _strdup(path); int found = 0;
  for (char *t = strtok(copy, ";"); t; t = strtok(NULL, ";")) {
    while (*t == ' ') t++;
    if (_stricmp(t, dir) == 0) { found = 1; break; }
  }
  free(copy); return found;
}

static void path_add(const char *dir) {
  char *cur = path_read();
  if (path_has(cur, dir)) { free(cur); return; }
  size_t n = strlen(dir) + 1 + strlen(cur) + 1;
  char *nv = (char *)malloc(n);
  if (*cur) snprintf(nv, n, "%s;%s", dir, cur);                /* prepend so it survives a long PATH */
  else      snprintf(nv, n, "%s", dir);
  path_write(nv);
  free(nv); free(cur);
}

static void path_remove(const char *dir) {
  char *cur = path_read();
  if (!path_has(cur, dir)) { free(cur); return; }
  char *nv = (char *)malloc(strlen(cur) + 1); nv[0] = 0;
  char *copy = _strdup(cur); int first = 1;
  for (char *t = strtok(copy, ";"); t; t = strtok(NULL, ";")) {
    char *s = t; while (*s == ' ') s++;
    if (_stricmp(s, dir) == 0) continue;                       /* drop our own entry */
    if (!first) strcat(nv, ";");
    strcat(nv, t); first = 0;
  }
  path_write(nv);
  free(copy); free(nv); free(cur);
}

/* write the embedded sprout.exe (RCDATA resource) to dest */
static int write_embedded(const char *dest) {
  HRSRC r = FindResourceA(NULL, "SPROUT_EXE", RT_RCDATA);
  if (!r) return 0;
  HGLOBAL g = LoadResource(NULL, r);
  void *data = LockResource(g);
  DWORD size = SizeofResource(NULL, r);
  if (!data || !size) return 0;
  FILE *f = fopen(dest, "wb");
  if (!f) return 0;
  size_t w = fwrite(data, 1, size, f);
  fclose(f);
  return w == (size_t)size;
}

static int do_install(void) {
  char dir[MAX_PATH]; install_dir(dir, sizeof dir);
  char exe[MAX_PATH + 16]; snprintf(exe, sizeof exe, "%s\\sprout.exe", dir);
  printf("\n  Installing Sprout into %s%s%s ...\n", C_CYAN, dir, C_RESET);
  ensure_dir(dir);
  if (!write_embedded(exe)) { printf("  %sinstall failed%s - could not write sprout.exe (is it already running?)\n", C_RED, C_RESET); return 1; }
  path_add(dir);
  printf("\n  %sInstalled!%s Open a %snew%s terminal and run:  %ssprout%s\n", C_GREEN, C_RESET, C_BOLD, C_RESET, C_GREEN, C_RESET);
  return 0;
}

static int do_update(void) {
  char tmp[MAX_PATH]; GetTempPathA(MAX_PATH, tmp);
  strcat(tmp, "sprout-installer-latest.exe");
  printf("\n  Fetching the latest installer from GitHub ...\n");
  if (URLDownloadToFileA(NULL, LATEST_INSTALLER, tmp, 0, NULL) != S_OK) {
    printf("  %sdownload failed%s - check your internet connection.\n", C_RED, C_RESET);
    return 1;
  }
  printf("  %sStarting the latest installer%s - choose Install in the new window.\n", C_GREEN, C_RESET);
  ShellExecuteA(NULL, "open", tmp, NULL, NULL, SW_SHOWNORMAL);
  exit(0);
}

static int do_uninstall(void) {
  char dir[MAX_PATH]; install_dir(dir, sizeof dir);
  char exe[MAX_PATH + 16]; snprintf(exe, sizeof exe, "%s\\sprout.exe", dir);
  printf("\n  Removing Sprout from %s%s%s ...\n", C_CYAN, dir, C_RESET);
  DeleteFileA(exe);
  RemoveDirectoryA(dir);
  path_remove(dir);
  printf("  %sUninstalled.%s Sprout is off your PATH (open a new terminal).\n", C_GREEN, C_RESET);
  return 0;
}

static void banner(void) {
  printf("\n  %s%sSprout Installer%s  \xF0\x9F\x8C\xB1\n", C_GREEN, C_BOLD, C_RESET);
  printf("  %sinstall, update, or remove Sprout - a tiny language written in C%s\n\n", C_DIM, C_RESET);
}

int main(void) {
  console_setup();
  for (;;) {
    banner();
    printf("    %s1%s  Install Sprout\n", C_GREEN, C_RESET);
    printf("    %s2%s  Update to the latest " C_DIM "(from GitHub)" C_RESET "\n", C_GREEN, C_RESET);
    printf("    %s3%s  Uninstall\n", C_GREEN, C_RESET);
    printf("    %s4%s  Quit\n\n", C_GREEN, C_RESET);
    printf("  %schoose \xE2\x96\xB8 %s", C_CYAN, C_RESET); fflush(stdout);
    char line[64];
    if (!fgets(line, sizeof line, stdin)) break;
    char c = line[0];
    if      (c == '1') do_install();
    else if (c == '2') do_update();
    else if (c == '3') do_uninstall();
    else if (c == '4' || c == 'q' || c == 'Q') break;
    else { printf("\n  %splease pick 1-4.%s\n", C_DIM, C_RESET); continue; }
    printf("\n  %spress Enter to return to the menu ...%s", C_DIM, C_RESET); fflush(stdout);
    char t[16]; if (!fgets(t, sizeof t, stdin)) break;
  }
  printf("\n  %sbye! \xF0\x9F\x8C\xB1%s\n\n", C_GREEN, C_RESET);
  return 0;
}
