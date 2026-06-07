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

# 2) Generate a simple app icon (a green sprout in a dark circle) as icon.ico.
$iconPath = Join-Path $appDir 'icon.ico'
Add-Type -AssemblyName System.Drawing
$size = 256
$bmp = New-Object System.Drawing.Bitmap($size, $size)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.Clear([System.Drawing.Color]::Transparent)
$g.FillEllipse((New-Object System.Drawing.SolidBrush([System.Drawing.ColorTranslator]::FromHtml('#16261b'))), 6, 6, 244, 244)
$green = [System.Drawing.ColorTranslator]::FromHtml('#7bd88f')
$leaf = New-Object System.Drawing.SolidBrush($green)
$pen = New-Object System.Drawing.Pen($green, 18)
$pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
$pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
$g.DrawLine($pen, 128, 198, 128, 120)
$g.FillEllipse($leaf, 60, 86, 76, 50)
$g.FillEllipse($leaf, 120, 78, 76, 50)
$g.Dispose()

$ms = New-Object System.IO.MemoryStream
$bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
$png = $ms.ToArray()
$bmp.Dispose()

$ico = New-Object System.IO.MemoryStream
$bw = New-Object System.IO.BinaryWriter($ico)
$bw.Write([uint16]0)            # reserved
$bw.Write([uint16]1)            # type = icon
$bw.Write([uint16]1)            # image count
$bw.Write([byte]0)              # width  (0 = 256)
$bw.Write([byte]0)              # height (0 = 256)
$bw.Write([byte]0)              # palette
$bw.Write([byte]0)              # reserved
$bw.Write([uint16]1)            # color planes
$bw.Write([uint16]32)           # bits per pixel
$bw.Write([uint32]$png.Length)  # image size
$bw.Write([uint32]22)           # image offset
$bw.Write($png)
$bw.Flush()
[System.IO.File]::WriteAllBytes($iconPath, $ico.ToArray())
$bw.Dispose()

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
