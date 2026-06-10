@echo off
REM Build the Sprout installer wizard. Needs gcc/MinGW on PATH to build;
REM the resulting sprout-installer.exe needs nothing (uses only Windows libraries).

where gcc >nul 2>nul
if errorlevel 1 (
  echo gcc not found. Install one: winget install --id BrechtSanders.WinLibs.POSIX.UCRT
  exit /b 1
)

gcc -O2 -Wall -s -o sprout-installer.exe sprout-installer.c -lurlmon -ladvapi32 -luser32 -lole32
if errorlevel 1 (
  echo Build failed.
  exit /b 1
)
echo Built sprout-installer.exe
