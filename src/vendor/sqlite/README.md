# Pinned SQLite source

Sprout vendors SQLite **3.54.0**, in its original amalgamation form. These files
are compiled as a separate translation unit when `SPROUT_SQLITE` is enabled.
Minimal and WebAssembly builds may leave that feature disabled; database calls
then return an explicit unavailable result. No database library is downloaded
at runtime.

Source: <https://www.sqlite.org/2026/sqlite-amalgamation-3540000.zip>

The downloaded archive was verified against the SHA3-256 published by the
[official download page](https://www.sqlite.org/download.html):

```text
SHA3-256 7b670a62fdfbd672b75fef004cb703c8a3e87d3a5cc7d675b4a08337004a2d93
SHA256   68e913b0fe8ec6b4e5f391c594a28872884e80d6cd042a1e50c957be46b5aa4d
```

`sqlite3.c` and `sqlite3.h` are unmodified upstream source. SQLite is in the
[public domain](https://www.sqlite.org/copyright.html); its source headers carry
the upstream dedication. Review upstream release notes, security fixes, and
the published archive digest when changing this pin, then rerun the native
database integration tests.

Typical native POSIX build:

```sh
cc -O2 -DSPROUT_SQLITE src/sprout.c src/vendor/sqlite/sqlite3.c -o sprout -lm -pthread
```

Windows also links `-lurlmon` for the existing legacy `get` implementation. The
new HTTP client loads system WinHTTP dynamically; it adds no third-party DLL.
