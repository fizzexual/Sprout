"""Offline Windows installer failure controls; never touches the user's install or PATH."""
from __future__ import annotations
import json
import ctypes
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
OLD = b'previous working installation'
WRAPPER = r'''
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <urlmon.h>
static unsigned char *payload;
static DWORD payload_size;
static int failure, path_writes, path_commits, page_opens, close_count, fake_waits;
static DWORD written_type;
static DWORD child_pid;
static BOOL fixture_console(UINT code) { (void)code; return TRUE; }
static HRSRC fixture_find(HMODULE module, LPCSTR name, LPCSTR kind) { (void)module; (void)name; (void)kind; return (HRSRC)1; }
static HGLOBAL fixture_load(HMODULE module, HRSRC resource) { (void)module; (void)resource; return (HGLOBAL)1; }
static LPVOID fixture_lock(HGLOBAL resource) { (void)resource; return payload; }
static DWORD fixture_size(HMODULE module, HRSRC resource) { (void)module; (void)resource; return payload_size; }
static size_t fixture_write(const void *data, size_t size, size_t count, FILE *file) { return fwrite(data, size, failure == 1 ? 3 : count, file); }
static int fixture_fflush(FILE *file) { int result = fflush(file); return failure == 2 ? EOF : result; }
static int fixture_close(FILE *file) { int result = fclose(file); close_count++; return failure == 3 || (failure == 8 && close_count == 2) ? EOF : result; }
static BOOL fixture_flush(HANDLE file) { return failure == 4 ? FALSE : FlushFileBuffers(file); }
static size_t fixture_read(void *data, size_t size, size_t count, FILE *file) { size_t got = fread(data, size, count, file); if (failure == 5 && got) ((char *)data)[0] ^= 1; return got; }
static BOOL fixture_move(LPCSTR source, LPCSTR dest, DWORD flags) { return failure == 6 ? FALSE : MoveFileExA(source, dest, flags); }
static LSTATUS fixture_reg_open(HKEY key, LPCSTR name, DWORD flags, REGSAM access, PHKEY out) {
  (void)key; (void)name; (void)flags;
  if ((failure == 13 && access == KEY_READ) || (failure == 14 && access == KEY_SET_VALUE)) return ERROR_ACCESS_DENIED;
  *out = (HKEY)(UINT_PTR)(access == KEY_READ ? 1 : 2); return ERROR_SUCCESS;
}
static LSTATUS fixture_reg_query(HKEY key, LPCSTR name, LPDWORD reserved, LPDWORD type, LPBYTE data, LPDWORD size) {
  static const char existing[] = "C:\\existing-path"; (void)key; (void)name; (void)reserved;
  if (failure == 27) return ERROR_FILE_NOT_FOUND;
  if (!data && failure == 15) return ERROR_ACCESS_DENIED;
  if (data && (failure == 16 || failure == 19)) { *size += 1000000; return failure == 16 ? ERROR_MORE_DATA : ERROR_SUCCESS; }
  if (data && failure == 23) return ERROR_ACCESS_DENIED;
  if (type) *type = failure == 17 ? REG_BINARY : failure == 28 || (data && failure == 22) ? REG_SZ : REG_EXPAND_SZ;
  if (data) { memcpy(data, existing, sizeof existing); if (failure == 20) data[sizeof existing - 1] = 'x'; }
  *size = failure == 18 ? 1048577 : (failure == 24 || (data && failure == 21)) ? 0 : sizeof existing;
  return ERROR_SUCCESS;
}
static LSTATUS fixture_reg_set(HKEY key, LPCSTR name, DWORD reserved, DWORD type, const BYTE *data, DWORD size) {
  (void)key; (void)name; (void)reserved; (void)data; (void)size; path_writes++;
  if (failure == 25) return ERROR_ACCESS_DENIED;
  path_commits++; written_type = type; return ERROR_SUCCESS;
}
static LSTATUS fixture_reg_close(HKEY key) { return failure == 26 || (failure == 30 && key == (HKEY)2) ? ERROR_ACCESS_DENIED : ERROR_SUCCESS; }
static LRESULT fixture_broadcast(HWND window, UINT message, WPARAM wparam, LPARAM lparam, UINT flags, UINT timeout, PDWORD_PTR result) { (void)window; (void)message; (void)wparam; (void)lparam; (void)flags; (void)timeout; (void)result; return 1; }
static HINSTANCE fixture_shell(HWND window, LPCSTR operation, LPCSTR file, LPCSTR args, LPCSTR directory, INT show) {
  (void)window; (void)operation; (void)args; (void)directory; (void)show;
  if (strcmp(file, "https://github.com/fizzexual/Sprout/releases")) return (HINSTANCE)5;
  page_opens++; return (HINSTANCE)33;
}
static BOOL fixture_create(LPCSTR app, LPSTR command, LPSECURITY_ATTRIBUTES process_attributes, LPSECURITY_ATTRIBUTES thread_attributes, BOOL inherit, DWORD flags, LPVOID environment, LPCSTR directory, LPSTARTUPINFOA startup, LPPROCESS_INFORMATION process) {
  if (failure == 11 || failure == 12) { process->hProcess = (HANDLE)0xabc1; process->hThread = (HANDLE)0xabc2; process->dwProcessId = 424242; return TRUE; }
  BOOL result = CreateProcessA(app, command, process_attributes, thread_attributes, inherit, flags, environment, directory, startup, process);
  if (result) child_pid = process->dwProcessId; return result;
}
static DWORD fixture_wait(HANDLE process, DWORD timeout) {
  if (process == (HANDLE)0xabc1) { (void)timeout; fake_waits++; if (fake_waits == 2 && failure == 12) { SetLastError(ERROR_INVALID_HANDLE); return WAIT_FAILED; } return WAIT_TIMEOUT; }
  return WaitForSingleObject(process, timeout);
}
static BOOL fixture_terminate(HANDLE process, UINT code) {
  if (process == (HANDLE)0xabc1) { if (failure == 11) { SetLastError(ERROR_ACCESS_DENIED); return FALSE; } return TRUE; }
  return TerminateProcess(process, code);
}
static BOOL fixture_handle_close(HANDLE handle) { return handle == (HANDLE)0xabc1 || handle == (HANDLE)0xabc2 ? TRUE : CloseHandle(handle); }
#define FindResourceA fixture_find
#define SetConsoleOutputCP fixture_console
#define LoadResource fixture_load
#define LockResource fixture_lock
#define SizeofResource fixture_size
#define fwrite fixture_write
#define fflush fixture_fflush
#define fclose fixture_close
#define FlushFileBuffers fixture_flush
#define fread fixture_read
#define MoveFileExA fixture_move
#define RegOpenKeyExA fixture_reg_open
#define RegQueryValueExA fixture_reg_query
#define RegSetValueExA fixture_reg_set
#define RegCloseKey fixture_reg_close
#define SendMessageTimeoutA fixture_broadcast
#define ShellExecuteA fixture_shell
#define CreateProcessA fixture_create
#define WaitForSingleObject fixture_wait
#define TerminateProcess fixture_terminate
#define CloseHandle fixture_handle_close
#define main installer_menu_unused
#include "@INSTALLER@"
#undef main
int main(int argc, char **argv) {
  if (argc != 3) return 2;
  int requested_failure = atoi(argv[1]);
  FILE *file = fopen(argv[2], "rb");
  if (!file || fseek(file, 0, SEEK_END) || ftell(file) <= 0) return 3;
  payload_size = (DWORD)ftell(file); rewind(file); payload = malloc(payload_size);
  if (!payload || fread(payload, 1, payload_size, file) != payload_size || fclose(file)) return 4;
  failure = requested_failure == 9 ? 6 : requested_failure;
  close_count = 0;
  int result = requested_failure == 9 ? installer_menu_unused() : requested_failure == 31 ? do_uninstall() : failure == 7 ? do_update() : do_install();
  int alive = 0;
  if (child_pid) {
    HANDLE child = OpenProcess(SYNCHRONIZE, FALSE, child_pid);
    if (child) { alive = WaitForSingleObject(child, 0) != WAIT_OBJECT_0; CloseHandle(child); }
  }
  printf("RESULT {\"result\":%d,\"path_writes\":%d,\"path_commits\":%d,\"written_type\":%lu,\"page_opens\":%d,\"child_alive\":%d}\n", result, path_writes, path_commits, (unsigned long)written_type, page_opens, alive);
  free(payload); return 0;
}
'''


@unittest.skipUnless(os.name == 'nt', 'Windows installer and PowerShell controls')
class InstallerPublication(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.compiler = shutil.which(os.environ.get('SPROUT_INSTALLER_CC', 'gcc'))
        if not cls.compiler:
            raise RuntimeError('A Windows GCC compiler is required for offline installer controls')
        requested_shell = os.environ.get('SPROUT_INSTALLER_POWERSHELL')
        cls.shell = shutil.which(requested_shell) if requested_shell else shutil.which('pwsh') or shutil.which('powershell')
        if not cls.shell:
            raise RuntimeError('PowerShell is required for the source installation controls')
        cls.temp = tempfile.TemporaryDirectory(prefix='sprout-installer-publication-')
        cls.root = Path(cls.temp.name)
        try:
            wrapper = cls.root / 'wrapper.c'
            wrapper.write_text(WRAPPER.replace('@INSTALLER@', (ROOT / 'installer/sprout-installer.c').as_posix()), encoding='utf-8')
            cls.wizard_exe = cls.root / 'wizard-fixture.exe'
            cls.compile(wrapper, cls.wizard_exe, '-lurlmon', '-ladvapi32', '-luser32', '-lole32', '-lshell32')
            candidate = cls.root / 'candidate.c'
            candidate.write_text('#include <windows.h>\n#include <stdio.h>\n#include <string.h>\nint main(int argc,char **argv){if(argc!=2 || strcmp(argv[1],"version")) return 8; puts("Sprout v0.0.0-fixture");\n#ifdef TIMEOUT\nSleep(60000);\n#endif\n#ifdef FAIL\nreturn 7;\n#else\nreturn 0;\n#endif\n}\n', encoding='ascii')
            cls.good = cls.root / 'good.exe'; cls.bad = cls.root / 'bad.exe'; cls.hung = cls.root / 'hung.exe'
            cls.compile(candidate, cls.good); cls.compile(candidate, cls.bad, '-DFAIL'); cls.compile(candidate, cls.hung, '-DTIMEOUT')
            cls.checkout = cls.root / 'checkout'; (cls.checkout / 'src').mkdir(parents=True)
            shutil.copy2(ROOT / 'install.ps1', cls.checkout / 'install.ps1')
        except BaseException:
            cls.temp.cleanup()
            raise

    @classmethod
    def tearDownClass(cls):
        cls.temp.cleanup()

    @classmethod
    def compile(cls, source, output, *options):
        subprocess.run([cls.compiler, '-O0', str(source), '-o', str(output), *options], check=True, capture_output=True, timeout=30)

    def setUp(self):
        self.base = Path(tempfile.mkdtemp(prefix='case-', dir=self.root))
        self.destination = self.base / 'Programs/Sprout/sprout.exe'
        self.destination.parent.mkdir(parents=True)
        self.destination.write_bytes(OLD)
        self.previous_stat = self.destination.stat()

    def wizard(self, mode=0, candidate=None):
        env = dict(os.environ, LOCALAPPDATA=str(self.base), APPDATA=str(self.base))
        result = subprocess.run([str(self.wizard_exe), str(mode), str(candidate or self.good)], env=env,
                                input='1\n\n4\n' if mode == 9 else None,
                                capture_output=True, text=True, encoding='utf-8', timeout=15)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.last_stdout = result.stdout
        return json.loads(next(line[7:] for line in result.stdout.splitlines() if line.startswith('RESULT ')))

    def assert_preserved(self, result):
        self.assertEqual(result['result'], 1)
        self.assertEqual(result['path_writes'], 0)
        self.assertEqual(result['path_commits'], 0)
        self.assertEqual(result['child_alive'], 0)
        self.assertEqual(self.destination.read_bytes(), OLD)
        self.assertEqual(self.destination.stat().st_mtime_ns, self.previous_stat.st_mtime_ns)
        self.assertEqual(list(self.destination.parent.iterdir()), [self.destination])

    def test_short_flush_close_verify_and_replace_failures_preserve_binary_and_path(self):
        for mode in (*range(1, 7), 8):
            with self.subTest(mode=mode):
                self.assert_preserved(self.wizard(mode))

    def test_failed_and_timed_out_version_probes_preserve_installation_and_reap_child(self):
        for candidate in (self.bad, self.hung):
            with self.subTest(candidate=candidate.name):
                self.assert_preserved(self.wizard(candidate=candidate))

    def test_wizard_real_sharing_violation_preserves_existing_binary_and_path(self):
        kernel = ctypes.WinDLL('kernel32', use_last_error=True)
        kernel.CreateFileW.argtypes = [ctypes.c_wchar_p, ctypes.c_uint32, ctypes.c_uint32, ctypes.c_void_p,
                                       ctypes.c_uint32, ctypes.c_uint32, ctypes.c_void_p]
        kernel.CreateFileW.restype = ctypes.c_void_p
        kernel.CloseHandle.argtypes = [ctypes.c_void_p]
        held = kernel.CreateFileW(str(self.destination), 0x80000000, 3, None, 3, 0x80, None)
        self.assertNotEqual(held, ctypes.c_void_p(-1).value)
        try:
            self.assert_preserved(self.wizard())
        finally:
            kernel.CloseHandle(held)

    def test_menu_returns_failure_after_rejected_publication(self):
        self.assert_preserved(self.wizard(mode=9))

    def test_uninstall_sharing_refusal_preserves_executable_and_path(self):
        kernel = ctypes.WinDLL('kernel32', use_last_error=True)
        kernel.CreateFileW.argtypes = [ctypes.c_wchar_p, ctypes.c_uint32, ctypes.c_uint32, ctypes.c_void_p,
                                       ctypes.c_uint32, ctypes.c_uint32, ctypes.c_void_p]
        kernel.CreateFileW.restype = ctypes.c_void_p
        kernel.CloseHandle.argtypes = [ctypes.c_void_p]
        held = kernel.CreateFileW(str(self.destination), 0x80000000, 3, None, 3, 0x80, None)
        self.assertNotEqual(held, ctypes.c_void_p(-1).value)
        try:
            self.assert_preserved(self.wizard(mode=31))
            self.assertIn('executable removal failed', self.last_stdout)
            self.assertNotIn('Uninstalled.', self.last_stdout)
        finally:
            kernel.CloseHandle(held)

    def test_healthy_wizard_update_and_first_install_publish_exact_payload(self):
        for existing in (True, False):
            with self.subTest(existing=existing):
                if not existing: self.destination.unlink()
                result = self.wizard()
                self.assertEqual(result, dict(result=0, path_writes=1, path_commits=1, written_type=2, page_opens=0, child_alive=0))
                self.assertEqual(self.destination.read_bytes(), self.good.read_bytes())
                self.assertEqual(list(self.destination.parent.iterdir()), [self.destination])

    def test_update_selects_releases_page_without_executing_or_installing_downloads(self):
        result = self.wizard(mode=7)
        self.assertEqual(result, dict(result=0, path_writes=0, path_commits=0, written_type=0, page_opens=1, child_alive=0))
        self.assertEqual(self.destination.read_bytes(), OLD)

    def test_registry_read_size_type_and_close_failures_preserve_installation_and_path(self):
        for mode in (13, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 26):
            with self.subTest(mode=mode):
                self.assert_preserved(self.wizard(mode))
                self.assertIn('PATH could not be read safely', self.last_stdout)

    def test_path_write_failure_reports_published_binary_without_false_rollback(self):
        for mode, attempts, commits in ((14, 0, 0), (25, 1, 0), (30, 1, 1)):
            with self.subTest(mode=mode):
                result = self.wizard(mode)
                self.assertEqual(result['result'], 1)
                self.assertEqual(result['path_writes'], attempts)
                self.assertEqual(result['path_commits'], commits)
                self.assertEqual(self.destination.read_bytes(), self.good.read_bytes())
                self.assertNotIn('Installed!', self.last_stdout)
                self.assertIn('executable was published', self.last_stdout)
                self.assertIn('not a runtime rollback', self.last_stdout)

    def test_missing_path_and_existing_plain_string_type_are_handled_explicitly(self):
        for mode, expected_type in ((27, 2), (28, 1)):
            with self.subTest(mode=mode):
                result = self.wizard(mode)
                self.assertEqual(result['result'], 0)
                self.assertEqual(result['path_commits'], 1)
                self.assertEqual(result['written_type'], expected_type)

    def test_unconfirmed_probe_cleanup_keeps_candidate_and_reports_failure(self):
        for mode in (11, 12):
            with self.subTest(mode=mode):
                result = self.wizard(mode)
                self.assertEqual(result['result'], 1)
                self.assertEqual(result['path_writes'], 0)
                self.assertEqual(self.destination.read_bytes(), OLD)
                self.assertIn('cleanup could not be confirmed', self.last_stdout)
                self.assertIn('candidate retained', self.last_stdout)
                candidates = list(self.destination.parent.glob('*.tmp'))
                self.assertEqual(len(candidates), 1)
                self.assertEqual(candidates[0].read_bytes(), self.good.read_bytes())
                candidates[0].unlink()

    def powershell(self, candidate, *, locked=False):
        shutil.copy2(candidate, self.checkout / 'src/sprout.exe')
        script = '& "' + str(self.checkout / 'install.ps1') + '" -InstallDir "' + str(self.destination.parent) + '" -NoPath'
        # Hold a real target without delete sharing to force publication refusal.
        if locked:
            script = '$held=[IO.File]::Open("' + str(self.destination) + '",[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read); try { ' + script + ' } finally { $held.Dispose() }'
        # Process-local execution policy only; no machine/user policy is changed.
        env = dict(os.environ)
        # Prefer this host's standard modules, since a runner launched from
        # PowerShell 7 can otherwise shadow Windows PowerShell 5.1's modules.
        env['PSModulePath'] = str(Path(self.shell).parent / 'Modules')
        return subprocess.run([self.shell, '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
                              env=env, capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=15)

    def test_powershell_failed_and_timed_out_version_checks_preserve_existing_binary(self):
        for candidate in (self.bad, self.hung):
            with self.subTest(candidate=candidate.name):
                result = self.powershell(candidate)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('staged Sprout', result.stderr)
                self.assertNotIn('Installed Sprout to', result.stdout)
                self.assertEqual(self.destination.read_bytes(), OLD)
                self.assertEqual(list(self.destination.parent.iterdir()), [self.destination])

    def test_powershell_locked_destination_refuses_atomic_publication(self):
        result = self.powershell(self.good, locked=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Atomic Sprout publication failed', result.stderr)
        self.assertNotIn('Installed Sprout to', result.stdout)
        self.assertEqual(self.destination.read_bytes(), OLD)
        self.assertEqual(list(self.destination.parent.iterdir()), [self.destination])

    def test_powershell_first_install_upgrade_and_explicit_runtime_rollback(self):
        for existing in (True, False):
            with self.subTest(existing=existing):
                if not existing: self.destination.unlink()
                result = self.powershell(self.good)
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                self.assertEqual(self.destination.read_bytes(), self.good.read_bytes())
                self.assertEqual(list(self.destination.parent.iterdir()), [self.destination])
        # Runtime restoration is a byte-for-byte republish, not a data downgrade.
        shutil.copy2(self.good, self.destination)
        second = self.root / 'second.exe'; second.write_bytes(self.good.read_bytes() + b'fixture second version')
        result = self.powershell(second)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(self.destination.read_bytes(), second.read_bytes())
        result = self.powershell(self.good)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(self.destination.read_bytes(), self.good.read_bytes())

    def test_powershell_supports_unicode_destination(self):
        self.destination = self.base / '日本語-🌱/sprout.exe'
        self.destination.parent.mkdir()
        self.destination.write_bytes(OLD)
        result = self.powershell(self.good)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(self.destination.read_bytes(), self.good.read_bytes())
        self.assertEqual(list(self.destination.parent.iterdir()), [self.destination])


if __name__ == '__main__': unittest.main()
