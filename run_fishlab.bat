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

echo Serving http://localhost:%PORT%/lab.html?sp=%SP%  ^(Ctrl+C to stop^)
start "" "http://localhost:%PORT%/lab.html?sp=%SP%"
bun tools\serve.ts %PORT%
