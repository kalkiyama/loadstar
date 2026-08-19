@echo off
REM Loadstar launcher for Windows.
REM
REM UNTESTED ON WINDOWS as of 2026-08-18 - written from knowledge, not verified by
REM running it. The macOS/Linux equivalents were each debugged by execution and
REM every one had a real bug that only running them exposed. Treat this as a first
REM draft: the first Windows user's bug report is expected, not a surprise.
REM
REM It will NOT install Docker. A script that silently downloads a multi-gigabyte
REM system tool needing admin rights is one nobody should trust. It detects, and
REM says what to do. Starting an already-installed Docker Desktop is automatic.
setlocal EnableDelayedExpansion

set "URL=http://localhost:8080"
set "STATE_DIR=%USERPROFILE%\.loadstar"
set "STATE_FILE=%STATE_DIR%\install-path"

echo.
echo   Loadstar
echo   --------

REM ---- Where is Loadstar? Beside this file, or the remembered path. -----------
set "INSTALL="
set "FIRST_RUN=0"
if exist "%~dp0docker-compose.yml" set "INSTALL=%~dp0"
if not defined INSTALL if exist "%~dp0..\docker-compose.yml" set "INSTALL=%~dp0..\"
if defined INSTALL (
  if not exist "%STATE_FILE%" set "FIRST_RUN=1"
  if not exist "%STATE_DIR%" mkdir "%STATE_DIR%" >nul 2>&1
  >"%STATE_FILE%" echo !INSTALL!
) else (
  if exist "%STATE_FILE%" (
    set /p INSTALL=<"%STATE_FILE%"
  ) else (
    echo.
    echo   X This copy does not know where Loadstar is installed yet.
    echo.
    echo     Run it ONCE from inside the Loadstar folder you cloned. After that
    echo     you can copy this file anywhere - Desktop, taskbar, wherever.
    echo.
    pause
    exit /b 1
  )
)
if not exist "!INSTALL!\docker-compose.yml" (
  echo.
  echo   X Loadstar is not at: !INSTALL!
  echo     Run this file once from inside the Loadstar folder to update it.
  echo.
  pause
  exit /b 1
)
cd /d "!INSTALL!" || (echo   X Could not enter !INSTALL! & pause & exit /b 1)

REM ---- Docker present? --------------------------------------------------------
where docker >nul 2>&1
if errorlevel 1 (
  echo.
  echo   X Docker is not installed.
  echo.
  echo     Get Docker Desktop: https://www.docker.com/products/docker-desktop/
  echo     Windows 10/11 also needs WSL 2 - the installer sets it up.
  echo.
  echo     Install it, then run this again.
  echo.
  pause
  exit /b 1
)

REM ---- Docker running? Start it if installed but asleep. ---------------------
docker info >nul 2>&1
if errorlevel 1 (
  echo.
  echo   Docker is installed but not running - starting it...
  start "" "%ProgramFiles%\Docker\Docker\Docker Desktop.exe" >nul 2>&1
  set /a _n=0
  :waitdocker
  timeout /t 2 /nobreak >nul
  set /a _n+=2
  docker info >nul 2>&1
  if not errorlevel 1 goto dockerup
  if !_n! GEQ 120 (
    echo.
    echo   X Docker did not start within 2 minutes. Start Docker Desktop yourself,
    echo     then run this again.
    echo.
    pause
    exit /b 1
  )
  goto waitdocker
  :dockerup
  echo   Docker is up.
)

REM ---- Compose v2? ------------------------------------------------------------
docker compose version >nul 2>&1
if errorlevel 1 (
  echo.
  echo   X This needs Docker Compose v2 - the "docker compose" subcommand.
  echo     Your Docker is too old. Update Docker Desktop, then run this again.
  echo.
  pause
  exit /b 1
)

REM ---- .env -------------------------------------------------------------------
if not exist ".env" if exist ".env.example" (
  copy ".env.example" ".env" >nul
  echo.
  echo   Created .env - add ANTHROPIC_API_KEY there if you want AI analysis ^(optional^).
)

REM ---- How many load generators? ---------------------------------------------
set "WORKERS=1"
if exist ".env" (
  for /f "tokens=2 delims==" %%A in ('findstr /b /c:"LOADSTAR_WORKERS=" ".env" 2^>nul') do set "WORKERS=%%A"
)
echo !WORKERS!| findstr /r "^[0-9][0-9]*$" >nul || set "WORKERS=1"
if !WORKERS! LSS 1 set "WORKERS=1"

REM ---- Up. A first run BUILDS, and silence for minutes looks like a hang. -----
docker image inspect loadstar-v01-api >nul 2>&1
if errorlevel 1 (
  echo.
  echo   First run: building images. About 5-10 minutes.
  echo   Every run after this starts in seconds.
)
echo.
if !WORKERS! GTR 1 (
  echo   Starting with !WORKERS! load generators ^(LOADSTAR_WORKERS in .env^).
  docker compose up -d --scale worker=!WORKERS!
) else (
  echo   Starting...
  docker compose up -d
)
if errorlevel 1 (
  echo.
  echo   X Docker could not start Loadstar - the output above says why.
  echo.
  pause
  exit /b 1
)

REM ---- Wait for the API to ANSWER, not merely for containers to exist. --------
echo.
echo   Waiting for Loadstar...
set /a _t=0
:waitapi
curl -fsS "%URL%/api/config" >nul 2>&1
if not errorlevel 1 goto ready
timeout /t 2 /nobreak >nul
set /a _t+=2
if !_t! GEQ 120 (
  echo.
  echo   X Loadstar started but did not answer within 2 minutes.
  echo     See what happened:  docker compose logs --tail=40 api
  echo.
  pause
  exit /b 1
)
goto waitapi

:ready
start "" "%URL%"
echo.
echo   Ready - Loadstar is at %URL%
if "!FIRST_RUN!"=="1" (
  echo.
  echo   ------------------------------------------------------------
  echo   Loadstar is installed at:
  echo     !INSTALL!
  echo   This file now works from anywhere - it remembers that path.
  echo   ------------------------------------------------------------
  echo.
  set /p "ANSWER=  Put shortcuts on your Desktop? [Y/n] "
  if /i not "!ANSWER!"=="n" (
    copy "!INSTALL!\Start Loadstar.bat" "%USERPROFILE%\Desktop\" >nul 2>&1 && echo   Added: Start Loadstar.bat
    copy "!INSTALL!\Stop Loadstar.bat"  "%USERPROFILE%\Desktop\" >nul 2>&1 && echo   Added: Stop Loadstar.bat
    echo   Windows SmartScreen may warn the first time ^(unsigned^): More info, then Run anyway.
    echo   Move them anywhere you prefer - they will still work.
  )
) else (
  echo   Tip: this file works from anywhere - copy it to your Desktop if you like.
)
echo.
echo   To stop Loadstar, use "Stop Loadstar".
echo.
timeout /t 10 /nobreak >nul
endlocal
