param(
    [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'Programs\Sprout'),
    [switch]$NoPath
)

$ErrorActionPreference = 'Stop'
$sourceBinary = Join-Path $PSScriptRoot 'src\sprout.exe'
if (-not (Test-Path -LiteralPath $sourceBinary -PathType Leaf)) {
    throw 'Build Sprout first: run src\build.cmd with GCC on PATH.'
}
$resolvedInstallDir = [System.IO.Path]::GetFullPath($InstallDir)
New-Item -ItemType Directory -Path $resolvedInstallDir -Force | Out-Null
$installedBinary = Join-Path $resolvedInstallDir 'sprout.exe'
Copy-Item -LiteralPath $sourceBinary -Destination $installedBinary -Force
& $installedBinary version
if ($LASTEXITCODE -ne 0) { throw 'The installed Sprout executable failed its version check.' }

if (-not $NoPath) {
    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    $alreadyAdded = @($userPath -split ';' | ForEach-Object { $_.Trim().TrimEnd('\') }) -contains $resolvedInstallDir.TrimEnd('\')
    if (-not $alreadyAdded) {
        $updatedPath = if ([string]::IsNullOrWhiteSpace($userPath)) { $resolvedInstallDir } else { "$resolvedInstallDir;$userPath" }
        [Environment]::SetEnvironmentVariable('Path', $updatedPath, 'User')
    }
    $env:PATH = "$resolvedInstallDir;$env:PATH"
}
Write-Output "Installed Sprout to $installedBinary"
if (-not $NoPath) { Write-Output 'Open a new terminal to use sprout from anywhere.' }
