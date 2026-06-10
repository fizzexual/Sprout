@echo off
REM Build the native Sprout interpreter into sprout.exe.
REM Needs a C compiler (gcc/MinGW) on PATH. The resulting sprout.exe needs nothing.
REM   Get a compiler:  winget install --id BrechtSanders.WinLibs.POSIX.UCRT

where gcc >nul 2>nul
if errorlevel 1 (
  echo gcc not found on PATH.
  echo Install a C compiler, e.g.:  winget install --id BrechtSanders.WinLibs.POSIX.UCRT
  exit /b 1
)

gcc -O2 -Wall -s -o sprout.exe sprout.c -lm
if errorlevel 1 (
  echo Build failed.
  exit /b 1
)
echo Built sprout.exe
