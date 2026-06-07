# install-music.ps1 - set up everything the Sprout "music" extension needs.
#
# Discord now REQUIRES end-to-end voice encryption (the DAVE protocol) to join a
# voice channel, which needs real packages. This installs them so `!play` works.
# Sprout's core language stays dependency-free; only the music extension uses these.
#
# Run it:  powershell -ExecutionPolicy Bypass -File tools\install-music.ps1

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot

Write-Host ""
Write-Host "Sprout music setup" -ForegroundColor Green
Write-Host "------------------"
Write-Host ""

# --- 1. Node packages (voice + DAVE end-to-end encryption) ---
Write-Host "[1/3] Installing voice packages (npm)..." -ForegroundColor Cyan
$npm = Get-Command npm -ErrorAction SilentlyContinue
if (-not $npm) {
    Write-Host "  ! npm was not found. Install Node.js (which includes npm) from https://nodejs.org and re-run." -ForegroundColor Yellow
} else {
    Push-Location $repo
    try {
        & npm install --save-optional "@discordjs/voice@latest" "@snazzah/davey@latest" "libsodium-wrappers@latest" "prism-media@latest"
        if ($LASTEXITCODE -eq 0) {
            Write-Host "  OK - voice packages installed." -ForegroundColor Green
        } else {
            Write-Host "  ! npm install reported a problem (exit $LASTEXITCODE)." -ForegroundColor Yellow
            Write-Host "    If @snazzah/davey failed to build, you may need Visual Studio Build Tools; tell the Sprout author." -ForegroundColor Yellow
        }
    } finally {
        Pop-Location
    }
}
Write-Host ""

# --- 2. ffmpeg (decodes the audio) ---
Write-Host "[2/3] Checking ffmpeg..." -ForegroundColor Cyan
if (Get-Command ffmpeg -ErrorAction SilentlyContinue) {
    Write-Host "  OK - ffmpeg is already installed." -ForegroundColor Green
} elseif (Get-Command winget -ErrorAction SilentlyContinue) {
    Write-Host "  Installing ffmpeg via winget..."
    winget install --id Gyan.FFmpeg --source winget --accept-source-agreements --accept-package-agreements
    Write-Host "  (If it installed, open a NEW terminal so ffmpeg is on your PATH.)" -ForegroundColor Yellow
} else {
    Write-Host "  ! Install ffmpeg yourself from https://ffmpeg.org/download.html and put it on your PATH." -ForegroundColor Yellow
}
Write-Host ""

# --- 3. yt-dlp (grabs the audio from YouTube) ---
Write-Host "[3/3] Checking yt-dlp..." -ForegroundColor Cyan
if (Get-Command yt-dlp -ErrorAction SilentlyContinue) {
    Write-Host "  OK - yt-dlp is already installed." -ForegroundColor Green
} elseif (Get-Command winget -ErrorAction SilentlyContinue) {
    Write-Host "  Installing yt-dlp via winget..."
    winget install --id yt-dlp.yt-dlp --source winget --accept-source-agreements --accept-package-agreements
    Write-Host "  (If it installed, open a NEW terminal so yt-dlp is on your PATH.)" -ForegroundColor Yellow
} else {
    Write-Host "  ! Install yt-dlp yourself from https://github.com/yt-dlp/yt-dlp and put it on your PATH." -ForegroundColor Yellow
}

Write-Host ""
Write-Host "Done. Open a NEW terminal, then run your bot and try  !play <song>  in a voice channel." -ForegroundColor Green
Write-Host ""
