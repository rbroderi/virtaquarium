@echo off
rem Preview the Roku version on PC: plays the baked assets in roku\assets\ with no WebGL.
rem Usage: run_baked.bat [nobake] [port]   (default port 8082)
rem   Re-bakes the Roku assets first so the preview matches the current code.
rem   nobake: skip the bake and show the existing assets (still bakes if none exist yet)
setlocal
cd /d "%~dp0"

set "BAKE=1"
if /i "%~1"=="nobake" (
  set "BAKE="
  shift
)
set "PORT=%~1"
if "%PORT%"=="" set "PORT=8082"

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

if not exist roku\assets\manifest.json set "BAKE=1"
if defined BAKE (
  echo Baking Roku assets...
  bun tools\bake.ts || (pause & exit /b 1)
)

echo Serving http://localhost:%PORT%/roku.html  ^(Ctrl+C to stop, F11 in the browser for full screen^)
start "" "http://localhost:%PORT%/roku.html"
bun tools\serve.ts %PORT%
