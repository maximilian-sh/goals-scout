// Startet das Overlay (aufgerufen von overlay.bat):
// 1. holt die neueste Version per git pull (nur wenn der Ordner geklont wurde)
// 2. installiert die Komponenten bei Bedarf
// 3. lädt electron.exe nach, falls npm das Installationsskript blockiert hat (neuere npm-Versionen)
// 4. startet Electron und beendet sich.
// Liegt bewusst in einer .js-Datei: Node liest sie vor dem Ausführen komplett ein, ein git pull
// kann sie also gefahrlos ersetzen. Bei einer .bat-Datei geht das schief.
const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
process.chdir(root);
const run = cmd => execSync(cmd, { stdio: 'inherit' });
const read = cmd => { try { return execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { return null; } };

let updated = false;
if (fs.existsSync(path.join(root, '.git')) && read('git --version')) {
  console.log('Suche Updates...');
  const before = read('git rev-parse HEAD');
  try { run('git pull --ff-only --quiet'); }
  catch { console.log('Update uebersprungen (offline oder eigene Aenderungen), starte vorhandene Version.'); }
  updated = before !== read('git rev-parse HEAD');
  if (updated) console.log('Neue Version geladen.');
}

const exe = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe');
if (!fs.existsSync(path.join(root, 'node_modules', 'electron')) || updated) {
  console.log('Installiere Komponenten...');
  run('npm install --no-audit --no-fund');
}
if (!fs.existsSync(exe)) {
  console.log('Lade Electron herunter (einmalig)...');
  run('node node_modules/electron/install.js');
}
if (!fs.existsSync(exe)) {
  console.error('Electron konnte nicht installiert werden. Internetverbindung pruefen und overlay.bat erneut starten.');
  process.exit(1);
}

spawn(exe, ['.'], { cwd: root, detached: true, stdio: 'ignore' }).unref();
console.log('Overlay gestartet.');
