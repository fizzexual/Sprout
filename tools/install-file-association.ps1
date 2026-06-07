# Registers the .sprout file type so double-clicking a .sprout file runs it.
#
# Per-user only (writes to HKCU) - no administrator rights needed, and fully
# reversible with uninstall-file-association.ps1.
#
# Run it once:   powershell -ExecutionPolicy Bypass -File tools\install-file-association.ps1

$ErrorActionPreference = 'Stop'

$launcher = Join-Path $PSScriptRoot 'sprout-run.cmd'
if (-not (Test-Path $launcher)) { throw "Can't find the launcher at: $launcher" }

# .sprout  ->  Sprout.Program
New-Item -Path 'HKCU:\Software\Classes\.sprout' -Force | Out-Null
Set-ItemProperty -Path 'HKCU:\Software\Classes\.sprout' -Name '(default)' -Value 'Sprout.Program'

# Sprout.Program  ->  friendly name + open command
New-Item -Path 'HKCU:\Software\Classes\Sprout.Program' -Force | Out-Null
Set-ItemProperty -Path 'HKCU:\Software\Classes\Sprout.Program' -Name '(default)' -Value 'Sprout Program'

New-Item -Path 'HKCU:\Software\Classes\Sprout.Program\shell\open\command' -Force | Out-Null
Set-ItemProperty -Path 'HKCU:\Software\Classes\Sprout.Program\shell\open\command' `
  -Name '(default)' -Value ("`"$launcher`" `"%1`"")

# --- Botanica (the Sprout code editor — an Electron app in ../botanica) ---
$botanicaLauncher = Join-Path (Split-Path -Parent $PSScriptRoot) 'botanica\launch.cmd'
$botanicaCmd = "`"$botanicaLauncher`" `"%1`""

New-Item -Path 'HKCU:\Software\Classes\Botanica.Editor' -Force | Out-Null
Set-ItemProperty -Path 'HKCU:\Software\Classes\Botanica.Editor' -Name '(default)' -Value 'Botanica'
New-Item -Path 'HKCU:\Software\Classes\Botanica.Editor\shell\open\command' -Force | Out-Null
Set-ItemProperty -Path 'HKCU:\Software\Classes\Botanica.Editor\shell\open\command' -Name '(default)' -Value $botanicaCmd

# Offer Botanica under right-click "Open with" for .sprout and .bloom files.
New-Item -Path 'HKCU:\Software\Classes\.sprout\OpenWithProgids' -Force | Out-Null
Set-ItemProperty -Path 'HKCU:\Software\Classes\.sprout\OpenWithProgids' -Name 'Botanica.Editor' -Value ''

# .bloom is a stylesheet: double-clicking it opens Botanica (there's nothing to "run").
New-Item -Path 'HKCU:\Software\Classes\.bloom' -Force | Out-Null
Set-ItemProperty -Path 'HKCU:\Software\Classes\.bloom' -Name '(default)' -Value 'Botanica.Editor'
New-Item -Path 'HKCU:\Software\Classes\.bloom\OpenWithProgids' -Force | Out-Null
Set-ItemProperty -Path 'HKCU:\Software\Classes\.bloom\OpenWithProgids' -Name 'Botanica.Editor' -Value ''

# Tell Explorer the associations changed (so it takes effect right away).
Add-Type -Namespace Win32 -Name Shell -MemberDefinition `
  '[DllImport("shell32.dll")] public static extern void SHChangeNotify(int eventId, int flags, IntPtr item1, IntPtr item2);'
[Win32.Shell]::SHChangeNotify(0x08000000, 0, [IntPtr]::Zero, [IntPtr]::Zero)

Write-Host "Done!" -ForegroundColor Green
Write-Host "  - Double-click a .sprout file to run it."
Write-Host "  - Right-click a .sprout/.bloom -> Open with -> Botanica to edit it."
Write-Host "Launcher: $launcher"
