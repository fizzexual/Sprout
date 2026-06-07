# uninstall-botanica.ps1 — removes Botanica's Start menu + Desktop shortcuts.
#   powershell -ExecutionPolicy Bypass -File botanica\uninstall-botanica.ps1

$ErrorActionPreference = 'SilentlyContinue'

$startMenu = [System.Environment]::GetFolderPath('Programs')
Remove-Item (Join-Path $startMenu 'Botanica.lnk') -Force
Remove-Item (Join-Path ([System.Environment]::GetFolderPath('Desktop')) 'Botanica.lnk') -Force

Write-Host "Removed Botanica's shortcuts." -ForegroundColor Yellow
