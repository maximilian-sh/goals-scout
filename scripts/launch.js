// Startet GOALS Scout (aufgerufen von overlay.bat bzw. kader-manager.bat):
// 1. prueft, ob die App schon laeuft (Port belegt) -> dann kein Update, nur Hinweis
// 2. holt die neueste Version per git pull (nur wenn der Ordner geklont wurde)
// 3. Overlay: installiert die Komponenten bei Bedarf (node_modules fehlt oder package-lock.json
//    hat sich seit der letzten erfolgreichen Installation geaendert) und laedt electron.exe nach,
//    falls npm das Installationsskript blockiert hat (neuere npm-Versionen)
// 4. Overlay: startet Electron und beendet sich.
//    --no-overlay: startet nur server.js im selben Fenster und oeffnet den Kader-Manager im Browser.
// Liegt bewusst in einer .js-Datei: Node liest sie vor dem Ausfuehren komplett ein, ein git pull
// kann sie also gefahrlos ersetzen. Bei einer .bat-Datei geht das schief.
const { execSync, spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const path = require('path');

const root = path.join(__dirname, '..');
process.chdir(root);
const noOverlay = process.argv.includes('--no-overlay');
const PORT = Number(process.env.PORT) || 7777;
const managerUrl = `http://127.0.0.1:${PORT}/manager.html`;
const NPM_INSTALL = 'npm install --no-audit --no-fund';

const run = cmd => execSync(cmd, { stdio: 'inherit' });
const read = cmd => { try { return execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { return null; } };
const sleep = ms => new Promise(r => setTimeout(r, ms));

// true, wenn schon etwas auf 127.0.0.1:PORT lauscht (also GOALS Scout laeuft).
function portBusy(timeout = 500) {
  return new Promise(resolve => {
    const sock = net.connect({ host: '127.0.0.1', port: PORT });
    const done = busy => { sock.destroy(); resolve(busy); };
    sock.setTimeout(timeout, () => done(false));
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
}

function openBrowser(url) {
  spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
}

// Grund fuer einen fehlgeschlagenen git pull in einer Zeile.
function pullError(e) {
  if (e.code === 'ETIMEDOUT' || e.signal) return 'keine Antwort nach 30 s (Internet langsam oder offline)';
  const msg = String(e.stderr || '') + String(e.stdout || '');
  if (/would be overwritten|local changes|uncommitted|untracked working tree/i.test(msg)) return 'eigene Aenderungen im Ordner blockieren das Update';
  if (/not possible to fast-forward|diverg|non-fast-forward|refusing to merge|unrelated histories|forced update/i.test(msg)) return 'Versionsverlauf weicht ab (Branch neu geschrieben oder eigene Commits)';
  if (/couldn't find remote ref|no such ref|no tracking information|does not appear to be a git repository/i.test(msg)) return 'Branch auf dem Server nicht gefunden';
  if (/authentication|could not read username|permission denied|terminal prompts disabled|\b40[13]\b/i.test(msg)) return 'keine Berechtigung fuer das Repo (Anmeldung fehlt)';
  if (/could not resolve host|unable to access|failed to connect|connection|timed out|network/i.test(msg)) return 'keine Verbindung (offline?)';
  return msg.split(/\r?\n/).map(s => s.trim()).find(Boolean) || 'unbekannter Fehler';
}

// git pull, der nie haengen bleibt (keine Passwortabfrage, Timeout 30 s).
function gitPull() {
  if (!fs.existsSync(path.join(root, '.git')) || !read('git --version')) return false;
  console.log('Suche Updates...');
  const before = read('git rev-parse HEAD');
  try {
    execSync('git -c credential.interactive=never pull --ff-only --quiet', {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
    });
  } catch (e) {
    console.log(`Update uebersprungen: ${pullError(e)}. Starte vorhandene Version.`);
  }
  const updated = before !== read('git rev-parse HEAD');
  if (updated) console.log('Neue Version geladen.');
  return updated;
}

function lockHash() {
  const file = ['package-lock.json', 'package.json'].map(f => path.join(root, f)).find(f => fs.existsSync(f));
  return file ? crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex') : '';
}

function startOverlay() {
  gitPull();
  const mods = path.join(root, 'node_modules');
  const exe = path.join(mods, 'electron', 'dist', 'electron.exe');
  const hashFile = path.join(mods, '.goals-lock-hash');
  const hash = lockHash();
  let stored = null;
  try { stored = fs.readFileSync(hashFile, 'utf8').trim(); } catch {}
  if (!fs.existsSync(path.join(mods, 'electron')) || stored !== hash) {
    console.log('Installiere Komponenten...');
    try {
      run(NPM_INSTALL);
      // Erst nach erfolgreicher Installation merken, sonst wird beim naechsten Start erneut installiert.
      fs.writeFileSync(hashFile, hash);
    } catch {
      console.log('Installation fehlgeschlagen, wird beim naechsten Start erneut versucht.');
    }
  }
  if (!fs.existsSync(exe) && fs.existsSync(path.join(mods, 'electron', 'install.js'))) {
    console.log('Lade Electron herunter (einmalig)...');
    try { run('node node_modules/electron/install.js'); } catch {}
  }
  if (!fs.existsSync(exe)) {
    console.error('Electron konnte nicht installiert werden. Internetverbindung pruefen und overlay.bat erneut starten.');
    process.exit(1);
  }
  spawn(exe, ['.'], { cwd: root, detached: true, stdio: 'ignore' }).unref();
  console.log('Overlay gestartet.');
}

// Ohne Overlay: server.js hat keine Abhaengigkeiten, also kein npm install und kein Electron noetig.
async function startServerOnly() {
  gitPull();
  console.log(`Starte GOALS Scout ohne Overlay (Port ${PORT})...`);
  console.log('Fenster offen lassen, solange du spielst. Beenden: Fenster schliessen oder Strg+C.');
  const child = spawn(process.execPath, ['server.js'], { cwd: root, stdio: 'inherit' });
  child.on('exit', code => process.exit(code || 0));
  for (let i = 0; i < 60; i++) {
    if (child.exitCode !== null) return;
    if (await portBusy()) {
      console.log(`Kader-Manager: ${managerUrl}`);
      openBrowser(managerUrl);
      return;
    }
    await sleep(250);
  }
  console.log(`Server antwortet noch nicht. Seite spaeter selbst oeffnen: ${managerUrl}`);
}

(async () => {
  if (await portBusy()) {
    console.log(`GOALS Scout laeuft schon (Port ${PORT}), daher kein Update.`);
    if (noOverlay) {
      console.log(`Oeffne den Kader-Manager im Browser: ${managerUrl}`);
      openBrowser(managerUrl);
    } else {
      console.log(`Bedienen ueber das Tray-Symbol unten rechts oder im Browser: ${managerUrl}`);
      console.log('Fuer ein Update zuerst ueber das Tray-Symbol beenden, dann neu starten.');
    }
    await sleep(5000); // Hinweis kurz lesbar lassen, bevor sich das Fenster schliesst
    return;
  }
  if (noOverlay) await startServerOnly();
  else startOverlay();
})();
