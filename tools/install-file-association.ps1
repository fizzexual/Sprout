# Registers the .sprout and .bloom file types and their icons, so that
# DOUBLE-CLICK opens the file in your editor (VS Code by default), with a
# right-click "Run with Sprout" still available for .sprout files.
#
# Per-user only (HKCU) - no administrator rights needed. Reversible with
# uninstall-file-association.ps1.
#
#   powershell -ExecutionPolicy Bypass -File tools\install-file-association.ps1
#   powershell -ExecutionPolicy Bypass -File tools\install-file-association.ps1 -Editor "C:\Path\To\editor.exe"
#   powershell -ExecutionPolicy Bypass -File tools\install-file-association.ps1 -Editor notepad++

param([string]$Editor = 'auto')

$ErrorActionPreference = 'Stop'

$launcher = Join-Path $PSScriptRoot 'sprout-run.cmd'
if (-not (Test-Path $launcher)) { throw "Can't find the launcher at: $launcher" }

$repoRoot = Split-Path -Parent $PSScriptRoot
$imagesDir = Join-Path $repoRoot 'images'
$sproutIcon = Join-Path $imagesDir 'sprout.ico'
$bloomIcon = Join-Path $imagesDir 'bloom.ico'

# --- Work out which editor to open files in -----------------------------------
function Find-Editor([string]$choice) {
  $localApp = $env:LOCALAPPDATA
  $vscode = @(
    (Join-Path $localApp 'Programs\Microsoft VS Code\Code.exe'),
    'C:\Program Files\Microsoft VS Code\Code.exe',
    'C:\Program Files (x86)\Microsoft VS Code\Code.exe'
  )
  $cursor = @(
    (Join-Path $localApp 'Programs\cursor\Cursor.exe'),
    (Join-Path $localApp 'Programs\Cursor\Cursor.exe')
  )
  $nopp = @('C:\Program Files\Notepad++\notepad++.exe', 'C:\Program Files (x86)\Notepad++\notepad++.exe')
  $subl = @('C:\Program Files\Sublime Text\sublime_text.exe', 'C:\Program Files\Sublime Text 3\sublime_text.exe')

  # A full path to an .exe was given - use it as-is.
  if ($choice -match '\.exe$' -and (Test-Path $choice)) { return $choice }

  $c = $choice.ToLower()
  if ($c -match 'code|vscode') { foreach ($p in $vscode) { if (Test-Path $p) { return $p } } }
  elseif ($c -eq 'cursor') { foreach ($p in $cursor) { if (Test-Path $p) { return $p } } }
  elseif ($c -match 'notepad\+\+|npp|nopp') { foreach ($p in $nopp) { if (Test-Path $p) { return $p } } }
  elseif ($c -match 'sublime|subl') { foreach ($p in $subl) { if (Test-Path $p) { return $p } } }
  elseif ($c -eq 'notepad') { return 'notepad.exe' }

  # 'auto', or a named editor that wasn't found: prefer VS Code, then the rest.
  foreach ($p in ($vscode + $cursor + $nopp + $subl)) { if (Test-Path $p) { return $p } }
  return 'notepad.exe'
}

$editorExe = Find-Editor $Editor
$openCmd = "`"$editorExe`" `"%1`""
$runCmd = "`"$launcher`" `"%1`""

function Set-Default([string]$path, [string]$value) {
  New-Item -Path $path -Force | Out-Null
  Set-ItemProperty -Path $path -Name '(default)' -Value $value
}

# --- .sprout -> Sprout.Program (double-click OPENS in editor; right-click RUN) -
Remove-Item -Path 'HKCU:\Software\Classes\Sprout.Program\shell' -Recurse -Force -ErrorAction SilentlyContinue
Set-Default 'HKCU:\Software\Classes\.sprout' 'Sprout.Program'
Set-Default 'HKCU:\Software\Classes\Sprout.Program' 'Sprout Program'
Set-Default 'HKCU:\Software\Classes\Sprout.Program\DefaultIcon' $sproutIcon
# Default action (double-click) = open in the editor.
Set-Default 'HKCU:\Software\Classes\Sprout.Program\shell' 'open'
Set-Default 'HKCU:\Software\Classes\Sprout.Program\shell\open\command' $openCmd
# Secondary action (right-click) = run the program with Sprout.
Set-Default 'HKCU:\Software\Classes\Sprout.Program\shell\run' 'Run with Sprout'
Set-ItemProperty -Path 'HKCU:\Software\Classes\Sprout.Program\shell\run' -Name 'Icon' -Value $sproutIcon
Set-Default 'HKCU:\Software\Classes\Sprout.Program\shell\run\command' $runCmd

# --- .bloom -> Bloom.File (double-click OPENS in editor; flower icon) ----------
Remove-Item -Path 'HKCU:\Software\Classes\Bloom.File' -Recurse -Force -ErrorAction SilentlyContinue
Set-Default 'HKCU:\Software\Classes\.bloom' 'Bloom.File'
Set-Default 'HKCU:\Software\Classes\Bloom.File' 'Bloom'
Set-Default 'HKCU:\Software\Classes\Bloom.File\DefaultIcon' $bloomIcon
Set-Default 'HKCU:\Software\Classes\Bloom.File\shell' 'open'
Set-Default 'HKCU:\Software\Classes\Bloom.File\shell\open\command' $openCmd

# --- Clean up any leftover Botanica registrations from older installs ---------
Remove-Item -Path 'HKCU:\Software\Classes\Botanica.Editor' -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath 'HKCU:\Software\Classes\*\shell\Botanica' -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -Path 'HKCU:\Software\Classes\Directory\shell\Botanica' -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -Path 'HKCU:\Software\Classes\Directory\Background\shell\Botanica' -Recurse -Force -ErrorAction SilentlyContinue

# Tell Explorer the associations changed.
Add-Type -Namespace Win32 -Name Shell -MemberDefinition `
  '[DllImport("shell32.dll")] public static extern void SHChangeNotify(int eventId, int flags, IntPtr item1, IntPtr item2);'
[Win32.Shell]::SHChangeNotify(0x08000000, 0, [IntPtr]::Zero, [IntPtr]::Zero)

Write-Host "Done!" -ForegroundColor Green
Write-Host "  Editor: $editorExe"
Write-Host "  - Double-click a .sprout or .bloom file -> opens in your editor."
Write-Host "  - Right-click a .sprout file -> 'Run with Sprout' to run it."
