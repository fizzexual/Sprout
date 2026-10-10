"""Compile the standalone C SDK and test real process-isolated workers.

SPROUT_CC can select a native C compiler when cc/gcc is not on PATH.
"""
from concurrent.futures import ThreadPoolExecutor
import ctypes
import _ctypes
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
import unittest

BINARY = Path(sys.argv.pop(1) if len(sys.argv) > 1 else
              Path(__file__).parents[1] / ('sprout.exe' if os.name == 'nt' else 'sprout')).resolve()
REPO = Path(__file__).resolve().parents[2]
HARNESS = r'''
#include "embed.h"
#include <stdio.h>
#include <stdlib.h>
int main(int argc, char **argv) {
    if (argc != 8) return 99;
    FILE *f = fopen(argv[3], "rb"); if (!f) return 98;
    if (fseek(f, 0, SEEK_END)) return 98;
    long n = ftell(f); if (n < 0 || n > 2000000) return 98;
    rewind(f); char *request = malloc((size_t)n + 1); if (!request) return 98;
    if (fread(request, 1, (size_t)n, f) != (size_t)n) return 98;
    request[n] = 0; fclose(f);
    SproutHostOptions options; SproutHostResult result;
    sprout_host_options_init(&options);
    options.executable = argv[1]; options.program = argv[2];
    options.request_json = request; options.request_length = (size_t)n;
    options.timeout_ms = (unsigned)strtoul(argv[4], NULL, 10);
    options.max_output_bytes = (size_t)strtoul(argv[5], NULL, 10);
    options.flags = (unsigned)strtoul(argv[6], NULL, 10);
    options.max_steps = strtoull(argv[7], NULL, 10);
    SproutHostStatus status = sprout_host_run(&options, &result);
    if (result.output_json) fwrite(result.output_json, 1, result.output_length, stdout);
    if (result.diagnostics) fwrite(result.diagnostics, 1, result.diagnostics_length, stderr);
    if (result.error) fprintf(stderr, "\n%s\n", result.error);
    fprintf(stderr, "\n@host status=%d exit=%d timeout=%d truncated=%d abi=%u\n",
            status, result.exit_code, result.timed_out, result.truncated, sprout_host_abi_version());
    sprout_host_result_free(&result); sprout_host_result_free(&result); free(request);
    return status;
}
'''


class NativeSDK(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.build = tempfile.TemporaryDirectory(prefix='sprout-sdk-build-')
        cls.addClassCleanup(cls.build.cleanup)
        root = Path(cls.build.name)
        source = root / 'host.c'; source.write_text(HARNESS)
        cls.host = root / ('host.exe' if os.name == 'nt' else 'host')
        cc = os.environ.get('SPROUT_CC') or shutil.which('cc') or shutil.which('gcc')
        if not cc:
            raise RuntimeError('C host SDK verification requires a C compiler; set SPROUT_CC')
        result = subprocess.run([cc, '-std=c11', '-O1', '-Wall', '-Wextra', '-I' + str(REPO / 'src'),
                                 str(source), str(REPO / 'src/embed.c'), '-o', str(cls.host)],
                                capture_output=True, text=True, timeout=60)
        if result.returncode:
            raise RuntimeError(result.stderr)
        library = root / ('sprout_host.dll' if os.name == 'nt' else 'libsprout_host.dylib' if sys.platform == 'darwin' else 'libsprout_host.so')
        shared_flags = ['-shared'] + ([] if os.name == 'nt' else ['-fPIC'])
        compiled = subprocess.run([cc, '-std=c11', '-O1', *shared_flags, str(REPO / 'src/embed.c'), '-o', str(library)], capture_output=True, text=True, timeout=60)
        if compiled.returncode: raise RuntimeError(compiled.stderr)
        cls.library = ctypes.CDLL(str(library))
        cls.addClassCleanup(_ctypes.FreeLibrary if os.name == 'nt' else _ctypes.dlclose, cls.library._handle)
        class Options(ctypes.Structure):
            _fields_ = [('size', ctypes.c_size_t), ('executable', ctypes.c_char_p), ('program', ctypes.c_char_p), ('cwd', ctypes.c_char_p), ('request', ctypes.c_char_p), ('request_length', ctypes.c_size_t), ('timeout', ctypes.c_uint), ('steps', ctypes.c_uint64), ('output', ctypes.c_size_t), ('flags', ctypes.c_uint), ('memory', ctypes.c_uint64)]
        class Result(ctypes.Structure):
            _fields_ = [('size', ctypes.c_size_t), ('status', ctypes.c_int), ('exit', ctypes.c_int), ('code', ctypes.c_int), ('timeout', ctypes.c_int), ('truncated', ctypes.c_int), ('output', ctypes.c_void_p), ('output_length', ctypes.c_size_t), ('stderr', ctypes.c_void_p), ('stderr_length', ctypes.c_size_t), ('error', ctypes.c_void_p)]
        cls.Options, cls.Result = Options, Result
        cls.library.sprout_host_options_init_sized.argtypes = [ctypes.POINTER(Options), ctypes.c_size_t]
        cls.library.sprout_host_options_init.argtypes = [ctypes.POINTER(Options)]
        cls.library.sprout_host_run_cancellable.argtypes = [ctypes.POINTER(Options), ctypes.POINTER(Result), ctypes.c_void_p]
        cls.library.sprout_host_cancel_new.restype = ctypes.c_void_p
        cls.library.sprout_host_cancel_request.argtypes = [ctypes.c_void_p]
        cls.library.sprout_host_cancel_free.argtypes = [ctypes.c_void_p]
        cls.library.sprout_host_result_free.argtypes = [ctypes.POINTER(Result)]
        memory_source = root / 'memory.c'
        memory_source.write_text('#include <stdio.h>\n#include <stdlib.h>\n#ifdef _WIN32\n#include <windows.h>\n#define ALLOC() VirtualAlloc(NULL,128u*1024u*1024u,MEM_RESERVE|MEM_COMMIT,PAGE_READWRITE)\n#define FREE(p) VirtualFree(p,0,MEM_RELEASE)\n#else\n#define ALLOC() malloc(128u*1024u*1024u)\n#define FREE(p) free(p)\n#endif\nint main(void) { void *p=ALLOC(); if(!p) { fputs("memory allocation denied\\n",stderr); return 42; } FREE(p); puts("{\\"allocated\\":true}"); return 0; }\n')
        cls.memory_probe = root / ('memory.exe' if os.name == 'nt' else 'memory')
        subprocess.run([cc, '-O1', str(memory_source), '-o', str(cls.memory_probe)], check=True, capture_output=True, timeout=30)

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='sprout-sdk-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def run_worker(self, source, request=None, timeout=2000, output=1048576, flags=0, steps=10000000, name="worker's source.sprout", binary=None):
        program = self.root / name; program.write_text(source, encoding='utf-8')
        data = self.root / (name + '.json')
        if isinstance(request, bytes):
            data.write_bytes(request)
        else:
            data.write_text(json.dumps({} if request is None else request, ensure_ascii=False), encoding='utf-8')
        return subprocess.run([str(self.host), str(binary or BINARY), str(program), str(data),
                               str(timeout), str(output), str(flags), str(steps)],
                              capture_output=True, text=True, encoding='utf-8', timeout=10)

    def test_json_roundtrip_exact_tags_and_unicode(self):
        request = {'name': '🌱 Привіт', 'id': {'$sprout.integer': '9223372036854775807'},
                   'money': {'$sprout.decimal': '0.10'}, 'blob': {'$sprout.bytes': '00ff'}}
        result = self.run_worker('make input = json_decode(read_input())\nshow json_encode(input)\n', request)
        self.assertEqual(result.returncode, 0, result.stderr)
        parsed = json.loads(result.stdout)
        self.assertEqual(parsed['name'], request['name'])
        self.assertEqual(parsed['id'], request['id'])
        self.assertEqual(parsed['blob'], request['blob'])
        self.assertIn('abi=1', result.stderr)

    def test_sandbox_default_and_explicit_io_opt_in(self):
        marker = self.root / 'effect'
        code = f'make saved = file_write({json.dumps(str(marker))}, "allowed")\nshow json_encode(saved)\n'
        result = self.run_worker(code)
        self.assertEqual(result.returncode, 5)
        self.assertIn('sandbox', result.stderr)
        self.assertFalse(marker.exists())
        result = self.run_worker(code, flags=1)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(json.loads(result.stdout)['ok'])
        self.assertEqual(marker.read_text(), 'allowed')

    def test_timeout_output_limit_and_readiness_after_failure(self):
        result = self.run_worker('repeat while yes:\n    make n = 1\n', timeout=50, steps=1000000000000)
        self.assertIn(result.returncode, [3, 5], result.stderr)  # runtime deadline may report first
        result = self.run_worker('show "' + 'x' * 100000 + '"\n', output=30)
        self.assertEqual(result.returncode, 4, result.stderr)
        self.assertIn('truncated=1', result.stderr)
        result = self.run_worker('show json_encode({ready: yes})\n')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), {'ready': True})

    def test_bad_framing_launch_failures_and_invalid_utf8(self):
        for code in ['show "first"\nshow "second"\n', 'make no_output = 1\n']:
            result = self.run_worker(code)
            self.assertEqual(result.returncode, 6, result.stderr)
        result = self.run_worker('show json_encode(42)\n', binary=self.root / 'missing-executable')
        self.assertEqual(result.returncode, 2, result.stderr)
        for request in [b'{"x":"\x00"}', b'{"x":"\xff"}', b'x' * 1048577]:
            result = self.run_worker('show json_encode(42)\n', request=request)
            self.assertEqual(result.returncode, 1, result.stderr)

    def test_independent_concurrent_hosts(self):
        def invoke(i):
            return self.run_worker('show json_encode(json_decode(read_input()))\n', {'n': i}, name=f'worker-{i}.sprout')
        with ThreadPoolExecutor(max_workers=4) as pool:
            results = list(pool.map(invoke, range(8)))
        for i, result in enumerate(results):
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(json.loads(result.stdout), {'n': i})

    def native_options(self, source='show json_encode({ready:yes})\n', executable=None):
        path = self.root / 'native.sprout'; path.write_text(source)
        options = self.Options(); self.library.sprout_host_options_init_sized(ctypes.byref(options), ctypes.sizeof(options))
        options.executable = str(executable or BINARY).encode(); options.program = str(path).encode(); options.request = b'{}'
        return options

    def test_native_cancellation_and_recovery(self):
        options = self.native_options('repeat while yes:\n    make n = 1\n')
        options.timeout = 3000; options.steps = 1000000000000
        result = self.Result(); cancel = self.library.sprout_host_cancel_new(); self.assertTrue(cancel)
        try:
            with ThreadPoolExecutor(max_workers=1) as pool:
                pending = pool.submit(self.library.sprout_host_run_cancellable, ctypes.byref(options), ctypes.byref(result), cancel)
                time.sleep(.05); self.library.sprout_host_cancel_request(cancel)
                self.assertEqual(pending.result(timeout=2), 8)
        finally:
            self.library.sprout_host_result_free(ctypes.byref(result)); self.library.sprout_host_cancel_free(cancel)
        ready = self.native_options(); self.assertEqual(self.library.sprout_host_run_cancellable(ctypes.byref(ready), ctypes.byref(result), None), 0)
        self.library.sprout_host_result_free(ctypes.byref(result))

    def test_os_memory_refusal_and_abi_prefix_compatibility(self):
        options = self.native_options(executable=self.memory_probe); options.memory = 64 * 1024 * 1024
        result = self.Result()
        try:
            self.assertEqual(self.library.sprout_host_run_cancellable(ctypes.byref(options), ctypes.byref(result), None), 5)
            self.assertEqual(result.exit, 42)
            self.assertIn(b'memory allocation denied', ctypes.string_at(result.stderr, result.stderr_length))
        finally: self.library.sprout_host_result_free(ctypes.byref(result))
        options.memory = 0
        self.assertEqual(self.library.sprout_host_run_cancellable(ctypes.byref(options), ctypes.byref(result), None), 0)
        self.library.sprout_host_result_free(ctypes.byref(result))
        options = self.native_options(); options.memory = 0xABCDEF
        self.library.sprout_host_options_init(ctypes.byref(options))
        self.assertEqual(options.memory, 0xABCDEF)  # original initializer never writes beyond ABI1 prefix
        self.assertEqual(options.size, self.Options.memory.offset)
        options.executable = str(BINARY).encode(); options.program = str(self.root / 'native.sprout').encode()
        self.assertEqual(self.library.sprout_host_run_cancellable(ctypes.byref(options), ctypes.byref(result), None), 0)
        self.library.sprout_host_result_free(ctypes.byref(result))


if __name__ == '__main__':
    unittest.main()
