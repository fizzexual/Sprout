@echo off
rem Botanica launcher. Used by "Open with -> Botanica" and double-clicking .bloom.
rem Calls electron.exe directly (not npm's batch shim, which breaks on folder
rem names with parentheses). Installs dependencies once on first run.
setlocal
cd /d "%~dp0"

if not exist "node_modules\electron\dist\electron.exe" (
  echo Setting up Botanica for the first time. This downloads the editor once...
  call npm install
)

start "Botanica" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0." %*
