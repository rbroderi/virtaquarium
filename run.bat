@echo off
rem Start the aquarium locally and open it in a Chrome/Edge app window on the high-performance GPU.
rem Usage: run.bat [port]   (default 8080)
setlocal
cd /d "%~dp0"

rem Internal: run.bat :open is the delayed window launcher started below.
if "%~1"==":open" goto open

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

set "URL=http://localhost:%PORT%/"
echo Serving %URL%  ^(Ctrl+C to stop, F11 in the window for full screen^)
start "" /min "%~f0" :open
bun tools\serve.ts %PORT%
pause
exit /b

:open
rem Opens the tank in its own Chrome/Edge app window once the server has had a moment to start.
rem --force_high_performance_gpu puts WebGL on the discrete GPU on dual-GPU laptops (Chrome ignores
rem WebGL's powerPreference on Windows). The flag only applies to a fresh browser process, so the
rem window uses its own profile in out\ instead of joining a browser that is already open.
rem Falls back to the default browser.
ping -n 3 127.0.0.1 >nul
set "BROWSER="
for %%B in (
  "%ProgramFiles%\Google\Chrome\Application\chrome.exe"
  "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
  "%LocalAppData%\Google\Chrome\Application\chrome.exe"
  "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
  "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
) do if not defined BROWSER if exist %%B set "BROWSER=%%~B"
if not defined BROWSER goto fallback
start "" "%BROWSER%" --app=%URL% --user-data-dir="%~dp0out\.browser-profile" --force_high_performance_gpu --no-first-run --no-default-browser-check
exit
:fallback
start "" "%URL%"
exit
