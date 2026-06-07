# Removes the .sprout file association created by install-file-association.ps1.
#
# Run it:   powershell -ExecutionPolicy Bypass -File tools\uninstall-file-association.ps1

$ErrorActionPreference = 'SilentlyContinue'

Remove-Item -Path 'HKCU:\Software\Classes\.sprout' -Recurse -Force
Remove-Item -Path 'HKCU:\Software\Classes\Sprout.Program' -Recurse -Force
Remove-Item -Path 'HKCU:\Software\Classes\.bloom' -Recurse -Force
Remove-Item -Path 'HKCU:\Software\Classes\Botanica.Editor' -Recurse -Force
Remove-Item -LiteralPath 'HKCU:\Software\Classes\*\shell\Botanica' -Recurse -Force
Remove-Item -LiteralPath 'HKCU:\Software\Classes\Directory\shell\Botanica' -Recurse -Force
Remove-Item -LiteralPath 'HKCU:\Software\Classes\Directory\Background\shell\Botanica' -Recurse -Force

Add-Type -Namespace Win32 -Name Shell -MemberDefinition `
  '[DllImport("shell32.dll")] public static extern void SHChangeNotify(int eventId, int flags, IntPtr item1, IntPtr item2);'
[Win32.Shell]::SHChangeNotify(0x08000000, 0, [IntPtr]::Zero, [IntPtr]::Zero)

Write-Host "Removed the .sprout file association." -ForegroundColor Yellow
