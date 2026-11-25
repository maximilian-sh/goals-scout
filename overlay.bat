@echo off
rem Startet das Overlay. Updates und Installation erledigt scripts\launch.js.
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js fehlt. Bitte von https://nodejs.org installieren ^(LTS^) und neu starten.
  pause
  exit /b 1
)
node scripts\launch.js
if errorlevel 1 pause
