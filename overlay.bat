@echo off
cd /d "%~dp0"
if not exist node_modules\electron\dist\electron.exe (
  echo Installiere Overlay-Komponenten ^(einmalig^)...
  call npm install
)
start "" node_modules\electron\dist\electron.exe .
