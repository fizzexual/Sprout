@echo off
REM Build the Sprout installer wizard, with sprout.exe embedded inside it.
REM Needs gcc + windres (MinGW) on PATH. The resulting sprout-installer.exe needs nothing.
REM Build the interpreter first:  cd ..\src && build.cmd

where gcc >nul 2>nul
if errorlevel 1 (
  echo gcc not found. Install one: winget install --id BrechtSanders.WinLibs.POSIX.UCRT
  exit /b 1
)
if not exist "..\src\sprout.exe" (
  echo ..\src\sprout.exe not found - build it first ^(cd ..\src ^&^& build.cmd^).
  exit /b 1
)

copy /Y "..\src\sprout.exe" "sprout.exe" >nul
windres sprout.rc -o sprout_rc.o
if errorlevel 1 ( echo windres failed. & exit /b 1 )
gcc -O2 -Wall -s -o sprout-installer.exe sprout-installer.c sprout_rc.o -lurlmon -ladvapi32 -luser32 -lole32 -lshell32
if errorlevel 1 ( echo Build failed. & exit /b 1 )
echo Built sprout-installer.exe
