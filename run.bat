@echo off
rem Start the aquarium locally and open it in the default browser.
rem Usage: run.bat [port]   (default 8080)
setlocal
cd /d "%~dp0"

set "PORT=%~1"
if "%PORT%"=="" set "PORT=8080"

where bun >nul 2>nul
if errorlevel 1 (
  echo Bun was not found on PATH. Install it with "winget install Oven-sh.Bun" or from https://bun.sh/ and try again.
  pause
  exit /b 1
)

if not exist node_modules (
  echo Installing dependencies...
  call bun install || (pause & exit /b 1)
)

echo Building...
call bun run build || (pause & exit /b 1)

echo Serving http://localhost:%PORT%/  ^(Ctrl+C to stop, F11 in the browser for full screen^)
start "" "http://localhost:%PORT%/"
bun tools\serve.ts %PORT%
pause
