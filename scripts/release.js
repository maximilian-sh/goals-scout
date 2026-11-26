// Neue Version veröffentlichen. Gebaut wird auf GitHub (.github/workflows/release.yml):
// Dieses Skript bumpt nur die Version und pusht Commit + Tag, der Tag startet den Build.
// Danach holen sich alle installierten Overlays das Update automatisch.
//
//   npm run release            → Patch-Version (1.0.0 → 1.0.1)
//   npm run release minor      → 1.0.x → 1.1.0
//   npm run release -- --local → wie früher lokal bauen und hochladen (Notfall, wenn Actions nicht gehen)
//
// Für --local nötig: `gh auth login` und %USERPROFILE%\.goals-scout-token (read-only Token, wird in die App gepackt).
const { execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..');
const run = cmd => execSync(cmd, { cwd: root, stdio: 'inherit' });
const out = cmd => execSync(cmd, { cwd: root }).toString().trim();
const fail = msg => { console.error(msg); process.exit(1); };

const args = process.argv.slice(2);
const local = args.includes('--local');
const bump = args.find(a => !a.startsWith('--')) || 'patch';

if (out('git status --porcelain')) fail('Es gibt noch nicht committete Änderungen – bitte erst committen.');
if (out('git rev-parse --abbrev-ref HEAD') !== 'main') fail('Releases nur von main.');
run('git fetch origin main');
if (out('git rev-list --count HEAD..origin/main') !== '0') fail('main ist nicht aktuell – erst `git pull`.');

run('npm test');

let tokenFile;
if (local) {
  tokenFile = path.join(os.homedir(), '.goals-scout-token');
  if (!fs.existsSync(tokenFile)) fail(`Lese-Token fehlt: ${tokenFile}`);
}

run(`npm version ${bump} -m "Release %s"`);
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
run('git push --follow-tags');

if (!local) {
  console.log(`\n✔ v${version} getaggt – GitHub baut jetzt den Installer (Actions → Release, ca. 5 min).`);
  console.log('  Danach aktualisieren sich die installierten Overlays von selbst.');
  process.exit(0);
}

fs.writeFileSync(path.join(root, 'overlay', 'update-token.json'), JSON.stringify({ token: fs.readFileSync(tokenFile, 'utf8').trim() }));
run('npx electron-builder --win --publish never');
const exe = `dist/GOALS-Scout-Setup-${version}.exe`;
run(`gh release create v${version} "${exe}" "${exe}.blockmap" dist/latest.yml --title "v${version}" --generate-notes`);
console.log(`\n✔ Version ${version} lokal gebaut und veröffentlicht.`);
