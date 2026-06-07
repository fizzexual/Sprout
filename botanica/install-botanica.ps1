# install-botanica.ps1 — installs Botanica so you can find it in the Windows
# search bar / Start menu and launch it like a normal app.
#
# It (1) makes sure dependencies are installed, (2) creates an app icon, and
# (3) adds Start menu + Desktop shortcuts. Per-user, no admin needed.
#
# Run it once:
#   powershell -ExecutionPolicy Bypass -File botanica\install-botanica.ps1

$ErrorActionPreference = 'Stop'
$appDir = $PSScriptRoot

# 1) Make sure Electron + Monaco are installed.
if (-not (Test-Path (Join-Path $appDir 'node_modules\electron'))) {
  Write-Host "Installing Botanica's dependencies (one-time)..." -ForegroundColor Cyan
  Push-Location $appDir
  cmd /c "npm install"
  Pop-Location
}

$electronExe = Join-Path $appDir 'node_modules\electron\dist\electron.exe'
if (-not (Test-Path $electronExe)) { throw "Electron wasn't found at $electronExe. Run 'npm install' in the botanica folder." }

# 2) Use the Botanica logo as the app icon.
$iconPath = Join-Path (Split-Path -Parent $appDir) 'images\botanica.ico'

# 3) Create the shortcuts.
function New-Shortcut($linkPath) {
  $wsh = New-Object -ComObject WScript.Shell
  $sc = $wsh.CreateShortcut($linkPath)
  $sc.TargetPath = $electronExe
  $sc.Arguments = '"' + $appDir + '"'
  $sc.WorkingDirectory = $appDir
  $sc.IconLocation = $iconPath
  $sc.Description = 'Botanica - the Sprout code editor'
  $sc.Save()
}

$startMenu = [System.Environment]::GetFolderPath('Programs')
New-Shortcut (Join-Path $startMenu 'Botanica.lnk')
New-Shortcut (Join-Path ([System.Environment]::GetFolderPath('Desktop')) 'Botanica.lnk')

Write-Host "Botanica installed!" -ForegroundColor Green
Write-Host "  - Type 'Botanica' in the Windows search bar and press Enter."
Write-Host "  - Or use the new Botanica icon on your Desktop."
