@echo off
rem Sprout launcher - runs a .sprout file when you double-click it,
rem then keeps the window open so you can read the output.
title Sprout
echo Running %~nx1 ...
echo.
node "%~dp0..\src\cli.ts" run "%~1"
echo.
echo --------------------------------------------------
pause
