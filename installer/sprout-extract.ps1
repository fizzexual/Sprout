# sprout-extract.ps1 - unpack a downloaded Sprout source zip into the install
# folder, keeping only the libraries the user chose. Called by the Inno Setup
# installer; can also be run by hand for testing.
#
#   powershell -File installer\sprout-extract.ps1 -Zip src.zip -Dest C:\Sprout -Keep "discord-bot"
#
# -Keep is a comma-separated list of library FOLDER names to keep. Use the literal
# "__none__" to keep no libraries, or omit it to keep them all.

param(
    [Parameter(Mandatory = $true)][string]$Zip,
    [Parameter(Mandatory = $true)][string]$Dest,
    [string]$Keep = ""
)

$ErrorActionPreference = "Stop"

$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("sprout_extract_" + [System.IO.Path]::GetRandomFileName())
New-Item -ItemType Directory -Path $tmp -Force | Out-Null
try {
    Expand-Archive -LiteralPath $Zip -DestinationPath $tmp -Force

    # GitHub zips wrap everything in one folder (e.g. "Sprout--main"); find it.
    $inner = Get-ChildItem -LiteralPath $tmp -Directory | Select-Object -First 1
    if (-not $inner) { throw "The downloaded archive didn't contain a Sprout folder." }

    New-Item -ItemType Directory -Path $Dest -Force | Out-Null
    Copy-Item -Path (Join-Path $inner.FullName "*") -Destination $Dest -Recurse -Force

    # Prune libraries (and their matching extensions) the user didn't pick.
    if ($Keep -ne "") {
        if ($Keep -eq "__none__") { $keepList = @() }
        else { $keepList = @($Keep.Split(",") | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne "" }) }

        $libDir = Join-Path $Dest "libraries"
        if (Test-Path $libDir) {
            foreach ($lib in (Get-ChildItem -LiteralPath $libDir -Directory)) {
                if ($keepList -notcontains $lib.Name) {
                    Remove-Item -LiteralPath $lib.FullName -Recurse -Force
                    $ext = Join-Path (Join-Path $Dest "extensions") $lib.Name
                    if (Test-Path $ext) { Remove-Item -LiteralPath $ext -Recurse -Force }
                }
            }
        }
    }

    Write-Host "Sprout source unpacked to $Dest"
}
finally {
    Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
}
