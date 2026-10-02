// GOALS Overlay: transparentes, randloses Fenster rechts neben dem 16:9-Spielbild.
// Klicks gehen durch (keine Interaktion nötig), immer im Vordergrund.
// Steuerung: Strg+Umschalt+O = ein/aus, Strg+Umschalt+Q = beenden, oder über das Tray-Symbol.
const { app, BrowserWindow, screen, globalShortcut, Tray, Menu, nativeImage } = require('electron');
const net = require('net');
const path = require('path');
const fs = require('fs');
const { autoUpdater } = require('electron-updater');

const PORT = Number(process.env.PORT) || 7777;
const WIDTH = Number(process.env.OVERLAY_WIDTH) || 420; // Breite in px
const MARGIN = 10;                                        // Abstand zum rechten Rand
const TOP = Number(process.env.OVERLAY_TOP) || 64;        // Platz oben (z. B. für FPS-Anzeige)

let win, tray;

function portInUse(port) {
  return new Promise(resolve => {
    const s = net.connect(port, '127.0.0.1');
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('error', () => resolve(false));
  });
}

function placeWindow() {
  // Am rechten Bildschirmrand, im schwarzen Bereich neben dem Spielbild.
  const wa = screen.getPrimaryDisplay().workArea;
  return { x: wa.x + wa.width - WIDTH - MARGIN, y: wa.y + TOP, width: WIDTH, height: wa.height - TOP - MARGIN };
}

function createWindow() {
  win = new BrowserWindow({
    ...placeWindow(),
    transparent: true,
    backgroundColor: '#00000000',
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    focusable: false,
    hasShadow: false,
    alwaysOnTop: true,
    show: false,
    webPreferences: { backgroundThrottling: false },
  });
  win.setAlwaysOnTop(true, 'screen-saver'); // auch über randlosem Vollbild
  win.setIgnoreMouseEvents(true);           // Klicks gehen ans Spiel
  win.setVisibleOnAllWorkspaces(true);
  win.loadURL(`http://localhost:${PORT}/overlay.html?overlay=1`);
  win.once('ready-to-show', () => win.showInactive());
  // Server neu gestartet o. Ä. → nach kurzer Zeit erneut laden
  win.webContents.on('did-fail-load', () => setTimeout(() => win && win.loadURL(`http://localhost:${PORT}/overlay.html?overlay=1`), 1500));
}

function toggle() {
  if (!win) return;
  win.isVisible() ? win.hide() : win.showInactive();
}

function createTray() {
  tray = new Tray(nativeImage.createFromPath(path.join(__dirname, 'tray.png')));
  tray.on('click', toggle);
  updateTray();
}

function updateTray(status) {
  if (!tray) return;
  tray.setToolTip(`GOALS Overlay ${app.getVersion()}${status ? ' – ' + status : ''}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `GOALS Overlay ${app.getVersion()}`, enabled: false },
    ...(status ? [{ label: status, enabled: false }] : []),
    { type: 'separator' },
    { label: 'Ein-/Ausblenden (Strg+Umschalt+O)', click: toggle },
    { label: 'Nach Updates suchen', click: checkForUpdates, visible: app.isPackaged },
    { label: 'Mit Windows starten', type: 'checkbox', checked: app.getLoginItemSettings().openAtLogin,
      click: item => app.setLoginItemSettings({ openAtLogin: item.checked }), visible: app.isPackaged },
    { type: 'separator' },
    { label: 'Beenden (Strg+Umschalt+Q)', click: () => app.quit() },
  ]));
}

// ---------- Auto-Update (private GitHub-Releases) ----------
// Das Token (nur Lesezugriff auf das eine Repo) wird beim Bauen in update-token.json gelegt.
let pendingUpdate = false;
function setupUpdater() {
  if (!app.isPackaged) return;
  let token = null;
  try { token = JSON.parse(fs.readFileSync(path.join(__dirname, 'update-token.json'), 'utf8')).token; } catch {}
  if (!token) return updateTray('Updates nicht eingerichtet');
  autoUpdater.setFeedURL({ provider: 'github', owner: 'maximilian-sh', repo: 'goals-scout', private: true, token });
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('update-available', i => updateTray(`Lade Update ${i.version}…`));
  autoUpdater.on('update-not-available', () => updateTray('Aktuell'));
  autoUpdater.on('error', e => updateTray('Update-Fehler: ' + (e && e.message || e).toString().slice(0, 60)));
  autoUpdater.on('update-downloaded', i => { pendingUpdate = true; updateTray(`Update ${i.version} bereit`); installWhenIdle(); });
  checkForUpdates();
  setInterval(checkForUpdates, 10 * 60 * 1000);
  setInterval(installWhenIdle, 30 * 1000);
}
function checkForUpdates() { if (app.isPackaged) autoUpdater.checkForUpdates().catch(() => {}); }

// Nie mitten im Match neu starten – nur in Menü/Lobby/nach dem Spiel.
async function installWhenIdle() {
  if (!pendingUpdate) return;
  try {
    const st = await (await fetch(`http://localhost:${PORT}/api/state`)).json();
    if (st.session && st.session.state === 'GAME_SESSION_STATE_READY_TO_JOIN_GAME_SERVER') return;
  } catch {}
  pendingUpdate = false;
  autoUpdater.quitAndInstall(true, true); // still installieren und danach wieder starten
}

if (!app.requestSingleInstanceLock()) app.quit();

app.whenReady().then(async () => {
  // Scout-Server im selben Prozess starten, falls noch keiner läuft
  if (!(await portInUse(PORT))) {
    process.env.PORT = String(PORT);
    // Installierte App: Daten im Benutzerordner statt im (schreibgeschützten) Programmordner
    if (app.isPackaged) process.env.GOALS_DATA_DIR = path.join(app.getPath('userData'), 'data');
    require(path.join(__dirname, '..', 'server.js'));
  }
  createWindow();
  createTray();
  setupUpdater();
  globalShortcut.register('CommandOrControl+Shift+O', toggle);
  globalShortcut.register('CommandOrControl+Shift+Q', () => app.quit());
  screen.on('display-metrics-changed', () => win && win.setBounds(placeWindow()));
});

app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => app.quit());
