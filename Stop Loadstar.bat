@echo off
REM Stop Loadstar. UNTESTED ON WINDOWS as of 2026-08-18 - see Start Loadstar.bat.
REM
REM Separate from the browser on purpose: closing a tab sends no signal to
REM anything, and a user who closes one of two tabs should not lose a fifteen
REM minute load test. It WARNS about work in flight rather than refusing.
setlocal EnableDelayedExpansion

set "STATE_FILE=%USERPROFILE%\.loadstar\install-path"

echo.
echo   Loadstar - stop
echo   ---------------

set "INSTALL="
if exist "%~dp0docker-compose.yml" set "INSTALL=%~dp0"
if not defined INSTALL if exist "%~dp0..\docker-compose.yml" set "INSTALL=%~dp0..\"
if not defined INSTALL if exist "%STATE_FILE%" set /p INSTALL=<"%STATE_FILE%"
if not defined INSTALL (
  echo.
  echo   X Cannot find Loadstar. Run "Start Loadstar" once from inside the
  echo     Loadstar folder first.
  echo.
  pause
  exit /b 1
)
cd /d "!INSTALL!" || (echo   X Could not enter !INSTALL! & pause & exit /b 1)

where docker >nul 2>&1 || (echo. & echo   Docker is not installed - nothing to stop. & echo. & timeout /t 5 >nul & exit /b 0)
docker info >nul 2>&1 || (echo. & echo   Docker is not running - Loadstar is already stopped. & echo. & timeout /t 5 >nul & exit /b 0)

docker compose ps --status running 2>nul | findstr /c:"loadstar" >nul
if errorlevel 1 (
  echo.
  echo   Loadstar is not running.
  echo.
  timeout /t 5 /nobreak >nul
  exit /b 0
)

REM ---- Anything in flight? ----------------------------------------------------
set "ACTIVE=0"
for /f %%A in ('docker compose exec -T db psql -U loadstar -d loadstar -A -t -c "select count(*) from runs where status in ('running','queued','coordinating','analyzing');" 2^>nul') do set "ACTIVE=%%A"
echo !ACTIVE!| findstr /r "^[0-9][0-9]*$" >nul || set "ACTIVE=0"

if !ACTIVE! GTR 0 (
  echo.
  echo   !! !ACTIVE! test^(s^) still running.
  echo      Stopping now loses them - a run cannot be resumed.
  echo.
  set /p "ANSWER=  Stop anyway? [y/N] "
  if /i not "!ANSWER!"=="y" (
    echo.
    echo   Left running. Loadstar is still at http://localhost:8080
    echo.
    timeout /t 5 /nobreak >nul
    exit /b 0
  )
  REM Mark them cancelled BEFORE the stack goes down, or the rows sit at
  REM 'running' with nobody left to change them and the report counts elapsed
  REM time forever.
  docker compose exec -T db psql -U loadstar -d loadstar -q -c "update runs set status='cancelled', finished_at=now(), error=coalesce(error,'Stopped when Loadstar was shut down.') where status in ('running','queued','coordinating','analyzing');" >nul 2>&1 && echo   Marked !ACTIVE! interrupted run^(s^) as cancelled.
)

echo.
echo   Stopping Loadstar...
docker compose down
if errorlevel 1 (
  echo   X Docker could not stop Loadstar - the output above says why.
  pause
  exit /b 1
)
echo.
echo   Stopped. Your tests, runs and reports are kept.
echo.
timeout /t 8 /nobreak >nul
endlocal
