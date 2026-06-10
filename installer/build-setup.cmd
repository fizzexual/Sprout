@echo off
REM Build the GUI installer SproutSetup.exe with Inno Setup 6.
REM Build the interpreter first:  cd ..\src && build.cmd

if not exist "..\src\sprout.exe" (
  echo Build ..\src\sprout.exe first ^(cd ..\src ^&^& build.cmd^).
  exit /b 1
)
set "ISCC=%LOCALAPPDATA%\Programs\Inno Setup 6\ISCC.exe"
if not exist "%ISCC%" (
  echo Inno Setup not found. Install it: winget install JRSoftware.InnoSetup
  exit /b 1
)
"%ISCC%" sprout-setup.iss
if errorlevel 1 ( echo Build failed. & exit /b 1 )
echo Built dist\SproutSetup.exe
