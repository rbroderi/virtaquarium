@echo off
rem Start the PC aquarium locally and open it in the default browser.
rem Usage: run.bat [port]   (default 8080)
setlocal
cd /d "%~dp0"

set "PORT=%~1"
if "%PORT%"=="" set "PORT=8080"

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

echo Serving http://localhost:%PORT%/pc/  ^(Ctrl+C to stop, F11 in the browser for full screen^)
start "" "http://localhost:%PORT%/pc/"
node tools\serve.mjs %PORT%
pause