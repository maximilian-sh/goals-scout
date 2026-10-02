# Entwickler-Setup (z. B. für Leo)

## 1. Einmalig installieren
- **Node.js LTS** (≥ 20): https://nodejs.org → Installer, alles Standard.
- **Git**: https://git-scm.com/download/win → Installer, alles Standard.
- **GitHub CLI**: `winget install GitHub.cli`, danach `gh auth login` (GitHub.com → HTTPS → Browser).
- **Claude Code** (optional, zum Weiterprogrammieren mit Claude): https://claude.com/claude-code

Zugriff aufs private Repo bekommst du von Maxim (Einladung auf GitHub annehmen).

## 2. Projekt holen
```bash
gh repo clone maximilian-sh/goals-scout
cd goals-scout
npm install
```

## 3. Starten
```bash
npm start          # Overlay aus dem Quellcode (startet den Server mit)
npm run server     # nur der Server → Browser: http://localhost:7777/overlay.html
```
Wenn du die installierte Version (Setup.exe) parallel hast: vorher über das Tray-Symbol beenden,
sonst teilen sich beide Port 7777.

Änderungen an `public/overlay.html` siehst du sofort (lädt automatisch neu).
Änderungen an `server.js` oder `overlay/main.js`: `npm start` neu starten.

**Ohne laufendes Spiel testen:** `?phase=lobby`, `?phase=live` oder `?phase=post` an die Overlay-URL hängen.
Für komplett eigene Testdaten ein Fake-`Game.log` verwenden – siehe CLAUDE.md, Abschnitt „Entwickeln“.

## 4. Mit Claude weiterbauen
Im Projektordner `claude` starten. Claude liest `CLAUDE.md` automatisch – da steht drin, wie alles funktioniert,
woher die Daten kommen und welche Design-Regeln gelten. Einfach sagen, was du willst.

## 5. Änderungen teilen
```bash
git checkout -b mein-feature
git add -A && git commit -m "Was ich gemacht habe"
git push -u origin mein-feature
gh pr create          # Pull Request für Maxim
```

## 6. Neue Version an alle verteilen (Release)
Nur auf einem PC mit Upload-Rechten und dem Lese-Token (siehe CLAUDE.md → „Release“):
```bash
npm run release
```
Alle installierten Overlays holen sich die neue Version automatisch innerhalb von ~10 Minuten.
