# Sprout Installer 🌱

`sprout-installer.exe` is a friendly wizard that **installs, updates, or removes**
Sprout for you. It downloads the latest `sprout.exe` from
[GitHub Releases](https://github.com/fizzexual/Sprout/releases/latest) and puts it
on your PATH — no admin rights, no dependencies.

## For users

Download **`sprout-installer.exe`** from the
[latest release](https://github.com/fizzexual/Sprout/releases/latest), run it, and
choose:

```
  Sprout Installer  🌱

    1  Install Sprout (latest)
    2  Update to the latest
    3  Uninstall
    4  Quit
```

It installs per-user to `%LOCALAPPDATA%\Programs\Sprout` and adds that folder to
your PATH. Open a **new** terminal afterward and run `sprout`.

## How it works

Pure C, using only Windows' own libraries:

- **Download** — `URLDownloadToFileA` (urlmon) fetches the latest release asset.
- **PATH** — reads/writes `HKCU\Environment` (advapi32) and broadcasts
  `WM_SETTINGCHANGE` (user32) so new terminals pick it up.

## Build it

```bat
build.cmd        :: needs gcc; or:
gcc -O2 -Wall -s -o sprout-installer.exe sprout-installer.c -lurlmon -ladvapi32 -luser32 -lole32
```
