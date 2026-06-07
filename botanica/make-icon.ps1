# make-icon.ps1 — generates Botanica's app icon (a green sprout in a dark
# circle) as a .ico file. Used by the installer and the .exe build.
#   powershell -File make-icon.ps1 -Out build\icon.ico

param([string]$Out = "build\icon.ico")

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$dir = Split-Path -Parent $Out
if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }

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
[System.IO.File]::WriteAllBytes($Out, $ico.ToArray())
$bw.Dispose()

Write-Host ("icon written: " + $Out)
