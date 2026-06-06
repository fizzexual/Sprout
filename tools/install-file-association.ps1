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

# Tell Explorer the associations changed (so it takes effect right away).
Add-Type -Namespace Win32 -Name Shell -MemberDefinition `
  '[DllImport("shell32.dll")] public static extern void SHChangeNotify(int eventId, int flags, IntPtr item1, IntPtr item2);'
[Win32.Shell]::SHChangeNotify(0x08000000, 0, [IntPtr]::Zero, [IntPtr]::Zero)

Write-Host "Done! Double-click any .sprout file to run it." -ForegroundColor Green
Write-Host "Launcher: $launcher"
