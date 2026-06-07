# build-installer.ps1 - compile installer\sprout-setup.iss into SproutSetup.exe.
# Installs Inno Setup 6 (via winget) if it isn't already present.
#
#   powershell -ExecutionPolicy Bypass -File tools\build-installer.ps1

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
$iss = Join-Path $repo "installer\sprout-setup.iss"

function Find-ISCC {
    $candidates = @(
        "C:\Program Files (x86)\Inno Setup 6\ISCC.exe",
        "C:\Program Files\Inno Setup 6\ISCC.exe",
        (Join-Path $env:LOCALAPPDATA "Programs\Inno Setup 6\ISCC.exe")
    )
    foreach ($c in $candidates) { if (Test-Path $c) { return $c } }
    $cmd = Get-Command ISCC.exe -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    return $null
}

$iscc = Find-ISCC
if (-not $iscc) {
    Write-Host "Inno Setup not found. Installing it via winget..." -ForegroundColor Cyan
    if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
        throw "winget is not available. Install Inno Setup 6 from https://jrsoftware.org/isdl.php and re-run."
    }
    winget install --id JRSoftware.InnoSetup --source winget --accept-source-agreements --accept-package-agreements
    $iscc = Find-ISCC
    if (-not $iscc) { throw "Inno Setup still not found. Open a NEW terminal and re-run, or install it manually." }
}

Write-Host "Compiling with $iscc" -ForegroundColor Cyan
& $iscc $iss
if ($LASTEXITCODE -ne 0) { throw "Inno Setup compile failed (exit $LASTEXITCODE)." }

$exe = Join-Path $repo "installer\dist\SproutSetup.exe"
if (Test-Path $exe) {
    Write-Host ""
    Write-Host ("Built: {0}  ({1:N0} bytes)" -f $exe, (Get-Item $exe).Length) -ForegroundColor Green
    Write-Host "Share that SproutSetup.exe - running it downloads + installs the working Sprout."
} else {
    Write-Host "Compile finished but SproutSetup.exe was not found where expected." -ForegroundColor Yellow
}
