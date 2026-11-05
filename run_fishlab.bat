@echo off
rem Start the Fish lab locally and open it in the default browser.
rem Usage: run_fishlab.bat [species] [port]   (default: all 8081)
rem   species: a species id such as clownfish or bluetang, or "all" for a lineup
setlocal
cd /d "%~dp0"

set "SP=%~1"
if "%SP%"=="" set "SP=all"
set "PORT=%~2"
if "%PORT%"=="" set "PORT=8081"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found on PATH. Install it from https://nodejs.org/ and try again.
  pause
  exit /b 1
)

if not exist node_modules (
  echo Installing dependencies...
  call npm install || (pause & exit /b 1)
)

echo Serving http://localhost:%PORT%/pc/lab.html?sp=%SP%  ^(Ctrl+C to stop^)
start "" "http://localhost:%PORT%/pc/lab.html?sp=%SP%"
node tools\serve.mjs %PORT%
