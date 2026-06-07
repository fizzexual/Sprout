# Registers the .sprout and .bloom file types and their icons.
# Per-user only (HKCU) - no administrator rights needed. Reversible with
# uninstall-file-association.ps1.
#
#   powershell -ExecutionPolicy Bypass -File tools\install-file-association.ps1

$ErrorActionPreference = 'Stop'

$launcher = Join-Path $PSScriptRoot 'sprout-run.cmd'
if (-not (Test-Path $launcher)) { throw "Can't find the launcher at: $launcher" }

$repoRoot = Split-Path -Parent $PSScriptRoot
$imagesDir = Join-Path $repoRoot 'images'
$sproutIcon = Join-Path $imagesDir 'sprout.ico'
$bloomIcon = Join-Path $imagesDir 'bloom.ico'

# --- .sprout -> Sprout.Program (runs on double-click; shows the Sprout icon) ---
New-Item -Path 'HKCU:\Software\Classes\.sprout' -Force | Out-Null
Set-ItemProperty -Path 'HKCU:\Software\Classes\.sprout' -Name '(default)' -Value 'Sprout.Program'
New-Item -Path 'HKCU:\Software\Classes\Sprout.Program' -Force | Out-Null
Set-ItemProperty -Path 'HKCU:\Software\Classes\Sprout.Program' -Name '(default)' -Value 'Sprout Program'
New-Item -Path 'HKCU:\Software\Classes\Sprout.Program\DefaultIcon' -Force | Out-Null
Set-ItemProperty -Path 'HKCU:\Software\Classes\Sprout.Program\DefaultIcon' -Name '(default)' -Value $sproutIcon
New-Item -Path 'HKCU:\Software\Classes\Sprout.Program\shell\open\command' -Force | Out-Null
Set-ItemProperty -Path 'HKCU:\Software\Classes\Sprout.Program\shell\open\command' -Name '(default)' -Value ("`"$launcher`" `"%1`"")

# --- .bloom -> Bloom.File (shows as type "Bloom" with the flower icon) ---
Remove-Item -Path 'HKCU:\Software\Classes\Bloom.File' -Recurse -Force -ErrorAction SilentlyContinue
New-Item -Path 'HKCU:\Software\Classes\Bloom.File' -Force | Out-Null
Set-ItemProperty -Path 'HKCU:\Software\Classes\Bloom.File' -Name '(default)' -Value 'Bloom'
New-Item -Path 'HKCU:\Software\Classes\Bloom.File\DefaultIcon' -Force | Out-Null
Set-ItemProperty -Path 'HKCU:\Software\Classes\Bloom.File\DefaultIcon' -Name '(default)' -Value $bloomIcon
New-Item -Path 'HKCU:\Software\Classes\.bloom' -Force | Out-Null
Set-ItemProperty -Path 'HKCU:\Software\Classes\.bloom' -Name '(default)' -Value 'Bloom.File'

# --- Clean up any leftover Botanica registrations from older installs ---
Remove-Item -Path 'HKCU:\Software\Classes\Botanica.Editor' -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath 'HKCU:\Software\Classes\*\shell\Botanica' -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -Path 'HKCU:\Software\Classes\Directory\shell\Botanica' -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -Path 'HKCU:\Software\Classes\Directory\Background\shell\Botanica' -Recurse -Force -ErrorAction SilentlyContinue
Remove-ItemProperty -Path 'HKCU:\Software\Classes\.sprout\OpenWithProgids' -Name 'Botanica.Editor' -ErrorAction SilentlyContinue
Remove-ItemProperty -Path 'HKCU:\Software\Classes\.bloom\OpenWithProgids' -Name 'Botanica.Editor' -ErrorAction SilentlyContinue

# Tell Explorer the associations changed.
Add-Type -Namespace Win32 -Name Shell -MemberDefinition `
  '[DllImport("shell32.dll")] public static extern void SHChangeNotify(int eventId, int flags, IntPtr item1, IntPtr item2);'
[Win32.Shell]::SHChangeNotify(0x08000000, 0, [IntPtr]::Zero, [IntPtr]::Zero)

Write-Host "Done!" -ForegroundColor Green
Write-Host "  - .sprout files show the Sprout icon and run on double-click."
Write-Host "  - .bloom files show as 'Bloom' with the flower icon."
