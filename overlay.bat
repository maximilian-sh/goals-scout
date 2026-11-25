@echo off
cd /d "%~dp0"

rem Auto-Update: neueste Version von GitHub holen (nur wenn der Ordner per git clone angelegt wurde)
set "OLD="
set "NEW="
where git >nul 2>nul
if not errorlevel 1 if exist .git (
  echo Suche Updates...
  for /f %%i in ('git rev-parse HEAD') do set "OLD=%%i"
  git pull --ff-only --quiet
  if errorlevel 1 echo Update uebersprungen ^(offline oder eigene Aenderungen^), starte vorhandene Version.
  for /f %%i in ('git rev-parse HEAD') do set "NEW=%%i"
)

if not exist node_modules\electron\dist\electron.exe (
  echo Installiere Overlay-Komponenten ^(einmalig^)...
  call npm install --no-audit --no-fund
) else if not "%OLD%"=="%NEW%" (
  echo Update installiert, aktualisiere Komponenten...
  call npm install --no-audit --no-fund
)
start "" node_modules\electron\dist\electron.exe .
