@echo off
rem Botanica launcher. Used by "Open with -> Botanica" and double-clicking .bloom.
rem On first run it installs Botanica's dependencies (Electron + Monaco), once.
cd /d "%~dp0"

if not exist "node_modules\electron\" (
  echo Setting up Botanica for the first time. This downloads the editor once...
  call npm install
)

start "" "%~dp0node_modules\.bin\electron.cmd" "%~dp0." %*
