# Sprout Installer 🌱

`sprout-installer.exe` is a friendly wizard that **installs, updates, or removes**
Sprout. The Sprout interpreter is **bundled inside it**, so it's a single
self-contained download — no extra files, and install works offline.

## For users

Release builds now include **`sprout-installer.exe`**. For older releases that only
contain `sprout-windows-x86_64.exe`, use that binary directly, or build from this
checkout and run `install.ps1` in PowerShell. The C installer can also be built
locally and run:

```
  Sprout Installer  🌱

    1  Install Sprout
    2  Choose a verified release (on GitHub)
    3  Uninstall
    4  Quit
```

It installs per-user to `%LOCALAPPDATA%\Programs\Sprout` and adds that folder to
your PATH (no admin). Open a **new** terminal afterward and run `sprout`.

Before running a downloaded installer, select an exact release tag and compare
its SHA-256 digest with that release's trusted `SHA256SUMS`. Keep the manifest
and full source revision beside your runtime. Development prereleases are
listed on the releases page; GitHub's **Latest** designation excludes them.
See [release integrity](../docs/releases.md) for the verification contract.

## How it works

Pure C, using only Windows' own libraries:

- **Install** — stages the embedded `sprout.exe` (`RCDATA`, baked in by
  `sprout.rc` + windres) in the destination directory, checks write/flush/close
  results, compares the staged bytes with the resource and runs its `version`
  command with a five-second timeout. Only then does it atomically replace the
  destination and update PATH. A failed pre-publication step preserves an
  existing executable and leaves PATH unchanged. Windows can refuse replacement
  while another process holds the destination; stop that process and retry.
  Probe cancellation has a separate bounded exit check. If cleanup cannot be
  confirmed, installation fails and reports the retained candidate path; it
  does not claim that the candidate process exited or discard that evidence.
- **Update** — opens the releases page and displays pinned-version/checksum
  instructions. It neither downloads nor executes a replacement installer.
- **PATH** — reads/writes `HKCU\Environment` (advapi32) and broadcasts
  `WM_SETTINGCHANGE` (user32) so new terminals pick it up. Read/query errors,
  unsupported registry types, malformed strings and values above 1 MiB fail
  before executable publication. A missing PATH value is handled as empty;
  existing `REG_SZ`/`REG_EXPAND_SZ` types are preserved. If the later PATH write
  cannot be confirmed, the wizard returns failure and states that the executable
  was already published. This does not restore the prior runtime.
- **Uninstall** — checks executable deletion before changing PATH. A sharing or
  permission refusal leaves the executable and PATH in place. A nonempty or
  inaccessible installation directory is retained and reported.

The checkout's `install.ps1` follows the same publication order: stage and
flush a copy in the destination directory, check its SHA-256 against the source
binary, run the bounded `version` probe, then replace/move it before editing
PATH. Publication uses the Unicode `MoveFileExW` same-directory rename through
Windows' built-in API; it does not use a copy/delete fallback or
[ReplaceFile's multiple-step failure behavior](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-replacefilew).
Use `-NoPath` when PATH changes are unwanted. This source-copy check
detects copy corruption; it does not authenticate a release or replace its
manifest verification.
PowerShell cancellation or cleanup refusal can leave a staged executable and
its direct probe process; the final cleanup error can supersede the earlier
probe error. A pre-publication failure preserves the existing installation.
Neither installer guarantees cleanup of descendants created by the probe.

Back up application data and workflow checkpoints before upgrading. To restore
a prior runtime, select its saved, verified installer or check out and build the
pinned prior revision, then install it again. Runtime restoration does not
downgrade stored data; test the old runtime against backups as described in the
[compatibility policy](../docs/compatibility.md). Staging is a single executable
publication safeguard, not a whole-machine transaction or power-loss guarantee.

The C wizard retains Windows ANSI/MAX_PATH path handling. `install.ps1` is the
alternative for Unicode install paths; neither tool grants language stability.

## Build it

Build the interpreter first, then the installer (which embeds it):

```bat
cd ..\src && build.cmd      :: produces src\sprout.exe
cd ..\installer && build.cmd
```

`build.cmd` copies in `sprout.exe`, runs `windres sprout.rc`, then links with
`-lurlmon -ladvapi32 -luser32 -lole32 -lshell32`.

Offline failure controls (Windows with GCC and PowerShell):

```text
python src/tests/installer_publication_test.py -v
```

These use synthetic executables in fresh temporary directories, mock the
wizard's registry and browser APIs, and run PowerShell with `-NoPath` and a
process-local script policy. They cover failures and successful first install,
upgrade and runtime restoration without touching the user's installation.
