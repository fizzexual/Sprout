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

REM -Wl,--stack,N reserves a 64 MB call stack so deep (but finite) recursion
REM works; the interpreter's own MAX_DEPTH guard catches truly endless recursion.
gcc -O2 -Wall -s -Wl,--stack,67108864 -o sprout.exe sprout.c -lm -lurlmon -lws2_32
if errorlevel 1 (
  echo Build failed.
  exit /b 1
)
echo Built sprout.exe
