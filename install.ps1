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
$sourceHash = (Get-FileHash -LiteralPath $sourceBinary -Algorithm SHA256).Hash
$stagedBinary = Join-Path $resolvedInstallDir ('.sprout-' + [Guid]::NewGuid().ToString('N') + '.exe')
try {
    $sourceStream = $null
    $candidateStream = $null
    try {
        $sourceStream = [System.IO.File]::OpenRead($sourceBinary)
        $candidateStream = [System.IO.FileStream]::new($stagedBinary, [System.IO.FileMode]::CreateNew,
            [System.IO.FileAccess]::Write, [System.IO.FileShare]::None, 65536, [System.IO.FileOptions]::WriteThrough)
        $sourceStream.CopyTo($candidateStream)
        $candidateStream.Flush($true)
    } finally {
        try {
            if ($candidateStream) { $candidateStream.Dispose() }
        } finally {
            if ($sourceStream) { $sourceStream.Dispose() }
        }
    }
    if ((Get-FileHash -LiteralPath $stagedBinary -Algorithm SHA256).Hash -ne $sourceHash) {
        throw 'The staged Sprout executable differs from the source binary.'
    }
    $versionProcess = [System.Diagnostics.Process]::new()
    try {
        $versionProcess.StartInfo.FileName = $stagedBinary
        $versionProcess.StartInfo.Arguments = 'version'
        $versionProcess.StartInfo.UseShellExecute = $false
        $versionProcess.StartInfo.CreateNoWindow = $true
        if (-not $versionProcess.Start()) { throw 'The staged Sprout version check could not start.' }
        if (-not $versionProcess.WaitForExit(5000)) {
            $versionProcess.Kill()
            if (-not $versionProcess.WaitForExit(5000)) { throw 'The staged Sprout version process did not exit after cancellation.' }
            throw 'The staged Sprout version check timed out; the existing installation was preserved.'
        }
        if ($versionProcess.ExitCode -ne 0) { throw 'The staged Sprout executable failed its version check; the existing installation was preserved.' }
    } finally {
        $versionProcess.Dispose()
    }
    if (-not ('SproutInstaller.AtomicFile' -as [type])) {
        Add-Type -TypeDefinition @'
using System.Runtime.InteropServices;
namespace SproutInstaller {
    public static class AtomicFile {
        [DllImport("kernel32.dll", EntryPoint="MoveFileExW", CharSet=CharSet.Unicode, SetLastError=true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool Move(string source, string destination, uint flags);
    }
}
'@
    }
    # Same-directory rename only, with replacement and write-through; no copy/
    # delete fallback and no ReplaceFile multi-step failure semantics.
    if (-not [SproutInstaller.AtomicFile]::Move($stagedBinary, $installedBinary, 9)) {
        $publicationError = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
        throw [System.ComponentModel.Win32Exception]::new($publicationError,
            'Atomic Sprout publication failed; the existing installation was preserved.')
    }
} finally {
    if ([System.IO.File]::Exists($stagedBinary)) { Remove-Item -LiteralPath $stagedBinary -Force }
}

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
