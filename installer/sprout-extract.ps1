# sprout-extract.ps1 - download the Sprout source and unpack it into the install
# folder, keeping only the libraries the user chose. Writes a log to
# <Dest>\sprout-install.log so problems are visible. Used by the Inno installer;
# can be run by hand for testing.
#
#   powershell -File installer\sprout-extract.ps1 -Url <zip-url> -Dest C:\Sprout -Keep "discord-bot"
#
# -Keep is a comma-separated list of library FOLDER names to keep. Use the literal
# "__none__" to keep no libraries, or omit it to keep them all.

param(
    [Parameter(Mandatory = $true)][string]$Url,
    [Parameter(Mandatory = $true)][string]$Dest,
    [string]$Keep = ""
)

$ErrorActionPreference = "Stop"
New-Item -ItemType Directory -Path $Dest -Force | Out-Null
$log = Join-Path $Dest "sprout-install.log"
function Log($m) { "$([DateTime]::Now.ToString('HH:mm:ss'))  $m" | Out-File -FilePath $log -Append -Encoding utf8 }

try {
    Log "start  url=$Url  dest=$Dest  keep=$Keep"
    $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("sprout_x_" + [System.IO.Path]::GetRandomFileName())
    New-Item -ItemType Directory -Path $tmp -Force | Out-Null
    $zip = Join-Path $tmp "src.zip"

    Log "downloading"
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -Uri $Url -OutFile $zip -UseBasicParsing
    Log "downloaded $((Get-Item $zip).Length) bytes"

    Log "expanding"
    $exDir = Join-Path $tmp "x"
    Expand-Archive -LiteralPath $zip -DestinationPath $exDir -Force
    $inner = Get-ChildItem -LiteralPath $exDir -Directory | Select-Object -First 1
    if (-not $inner) { throw "the downloaded archive had no Sprout folder" }

    # robocopy merges/overwrites into an existing install reliably (exit < 8 = ok).
    Log "copying to $Dest"
    & robocopy $inner.FullName $Dest /E /NFL /NDL /NJH /NJS /NP /R:1 /W:1 | Out-Null
    $rc = $LASTEXITCODE
    Log "robocopy exit $rc"
    if ($rc -ge 8) { throw "copy failed (robocopy code $rc)" }

    if ($Keep -ne "") {
        if ($Keep -eq "__none__") { $keepList = @() }
        else { $keepList = @($Keep.Split(",") | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne "" }) }
        $libDir = Join-Path $Dest "libraries"
        if (Test-Path $libDir) {
            foreach ($lib in (Get-ChildItem -LiteralPath $libDir -Directory)) {
                if ($keepList -notcontains $lib.Name) {
                    Log "pruning library $($lib.Name)"
                    Remove-Item -LiteralPath $lib.FullName -Recurse -Force
                    $ext = Join-Path (Join-Path $Dest "extensions") $lib.Name
                    if (Test-Path $ext) { Remove-Item -LiteralPath $ext -Recurse -Force }
                }
            }
        }
    }

    Log "done ok"
    exit 0
}
catch {
    Log "ERROR: $($_.Exception.Message)"
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
}
