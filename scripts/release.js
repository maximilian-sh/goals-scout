// Neue Version bauen und als Release ins private Repo hochladen.
// Danach holen sich alle installierten Overlays (z. B. Leo) das Update automatisch.
//
//   npm run release          → Patch-Version (1.0.0 → 1.0.1)
//   npm run release minor    → 1.0.x → 1.1.0
//
// Einmalig nötig: Datei %USERPROFILE%\.goals-scout-token mit einem GitHub-Token,
// das NUR Lesezugriff (Contents: read) auf maximilian-sh/goals-scout hat. Es wird in die App gepackt.
const { execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..');
const run = (cmd, env) => execSync(cmd, { cwd: root, stdio: 'inherit', env: { ...process.env, ...env } });
const out = cmd => execSync(cmd, { cwd: root }).toString().trim();

if (out('git status --porcelain')) {
  console.error('Es gibt noch nicht committete Änderungen – bitte erst committen.');
  process.exit(1);
}

const tokenFile = path.join(os.homedir(), '.goals-scout-token');
if (!fs.existsSync(tokenFile)) {
  console.error(`Lese-Token fehlt: ${tokenFile}`);
  process.exit(1);
}
fs.writeFileSync(path.join(root, 'overlay', 'update-token.json'), JSON.stringify({ token: fs.readFileSync(tokenFile, 'utf8').trim() }));

const bump = process.argv[2] || 'patch';
run(`npm version ${bump} -m "Release %s"`);
const version = require(path.join(root, 'package.json')).version;

// Erst Commit + Tag pushen, damit das GitHub-Release auf den richtigen Commit zeigt
run('git push --follow-tags');
// Bauen ohne electron-builders eigenen Upload (der legt gelegentlich doppelte Releases an),
// dann mit der GitHub CLI genau ein Release mit allen Dateien erstellen.
run('npx electron-builder --win --publish never');
const exe = `dist/GOALS-Scout-Setup-${version}.exe`;
run(`gh release create v${version} "${exe}" "${exe}.blockmap" dist/latest.yml --title "v${version}" --generate-notes`);
console.log(`\n✔ Version ${version} veröffentlicht – Overlays aktualisieren sich in den nächsten Minuten.`);
