# Sprout Installer 🌱

`sprout-installer.exe` is a friendly wizard that **installs, updates, or removes**
Sprout. The Sprout interpreter is **bundled inside it**, so it's a single
self-contained download — no extra files, and install works offline.

## For users

Download **`sprout-installer.exe`** from the
[latest release](https://github.com/fizzexual/Sprout/releases/latest) and run it:

```
  Sprout Installer  🌱

    1  Install Sprout
    2  Update to the latest (from GitHub)
    3  Uninstall
    4  Quit
```

It installs per-user to `%LOCALAPPDATA%\Programs\Sprout` and adds that folder to
your PATH (no admin). Open a **new** terminal afterward and run `sprout`.

## How it works

Pure C, using only Windows' own libraries:

- **Install** — extracts the embedded `sprout.exe` (an `RCDATA` resource baked in
  by `sprout.rc` + windres) to the install folder.
- **Update** — downloads the latest `sprout-installer.exe` from GitHub
  (`URLDownloadToFile`, urlmon) and launches it.
- **PATH** — reads/writes `HKCU\Environment` (advapi32) and broadcasts
  `WM_SETTINGCHANGE` (user32) so new terminals pick it up.

## Build it

Build the interpreter first, then the installer (which embeds it):

```bat
cd ..\src && build.cmd      :: produces src\sprout.exe
cd ..\installer && build.cmd
```

`build.cmd` copies in `sprout.exe`, runs `windres sprout.rc`, then links with
`-lurlmon -ladvapi32 -luser32 -lole32 -lshell32`.
