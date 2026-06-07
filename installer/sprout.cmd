@echo off
rem The global "sprout" command. Installed to the Sprout folder and put on PATH by
rem the Sprout installer, so you can run  sprout run file.sprout  from any terminal.
node "%~dp0src\cli.ts" %*
