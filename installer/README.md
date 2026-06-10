# The Sprout installer

**[Download `SproutSetup.exe`](https://github.com/fizzexual/Sprout/releases/latest/download/SproutSetup.exe)**
from the [latest release](https://github.com/fizzexual/Sprout/releases/latest) and run it —
that's how you get a *working* Sprout on Windows.

> This GitHub repo is the **source** — clone it to read or change how Sprout
> works. It is **not registered on your PC** until the installer sets it up. Run
> `SproutSetup.exe` to get the real, working `sprout` command.

## What the wizard does

- Lets you **choose where** to install Sprout.
- Lets you **choose which libraries** to install — and a library brings its
  extensions with it (e.g. picking **discord-bot** also installs the **Music**
  extension).
- **Downloads the latest Sprout** straight from this repo.
- Registers the **`sprout`** command (on your PATH), the **`.sprout` / `.bloom`**
  file types + icons, and **Start-menu** shortcuts.
- Adds Sprout to **Apps & features**, so you can remove it cleanly.

## Run it again = Update / Repair / Uninstall

If Sprout is already installed, the wizard greets you with three choices:

- **Update** — shown when this repo has a newer version than you have installed
  (it compares the [`VERSION`](../VERSION) file).
- **Repair** — re-download and re-register everything.
- **Uninstall** — remove Sprout.

So the flow is: we improve the source here → bump [`VERSION`](../VERSION) → next
time you open the installer it offers to **update**.

## Building & publishing (for maintainers)

`SproutSetup.exe` is **not committed** — it's built and published to
[GitHub Releases](https://github.com/fizzexual/Sprout/releases) automatically by
[`.github/workflows/release.yml`](../.github/workflows/release.yml). Bump
[`VERSION`](../VERSION) (or change anything under `installer/`) and push: the CI
compiles [`sprout-setup.iss`](sprout-setup.iss) with Inno Setup on a Windows
runner and attaches the new `SproutSetup.exe` to a `vX.Y.Z` release.

To build one locally (e.g. to test):

```powershell
powershell -ExecutionPolicy Bypass -File tools\build-installer.ps1
```

The installer only needs rebuilding when the **installer itself** changes — it
always downloads the latest **source** at install time, so normal Sprout changes
don't need a new `.exe`.

| File | Purpose |
| --- | --- |
| `sprout-setup.iss` | the Inno Setup wizard (UI, components, download, update logic) |
| `sprout-extract.ps1` | downloads + unpacks the source, keeping the chosen libraries |
| `sprout.cmd` | the global `sprout` command installed onto your PATH |
| `dist/SproutSetup.exe` | the built installer (git-ignored; published to Releases) |
