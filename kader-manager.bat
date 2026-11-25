@echo off
rem Startet GOALS Scout ohne Overlay: Server in diesem Fenster, Kader-Manager im Browser.
rem Fuer 16:9-Bildschirme, auf denen das Overlay das Spiel verdeckt. Updates erledigt scripts\launch.js.
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js fehlt. Bitte von https://nodejs.org installieren ^(LTS^) und neu starten.
  pause
  exit /b 1
)
node scripts\launch.js --no-overlay
if errorlevel 1 pause
