# GOALS Scout – Projektkontext für Claude

Live-Tracker/Overlay für das Steam-Spiel **GOALS** (Free-to-Play-Fußball, Goals AB), ähnlich Valorant Tracker / Blitz.
Zeigt in Lobby und Match alle Spieler mit SR, Form, Tracker Score, Party-Erkennung usw. Unterstützt **5v5** und **1v1**.
Zwei Nutzer: Maxim (`Maxim9586`, Repo-Owner) und Leo (`blumleo3`). UI-Sprache ist **Deutsch**.

## Architektur

```
Game.log (lokal, live)  ──►  server.js (Node, keine Deps)  ──SSE──►  public/overlay.html  (Electron-Overlay)
playgoals.com API/HTML  ──►        │ Port 7777               └──►  public/index.html   (Browser-Dashboard)
                                   └─ data/  (history.json, players.json)
overlay/main.js (Electron): transparentes Fenster, startet server.js im selben Prozess, Auto-Update, Tray
```

| Datei | Zweck |
|---|---|
| `server.js` | Liest `Game.log` (Tail, 1 s), parst Lobbys, holt Spielerdaten von playgoals.com, berechnet Stats, SSE an `/events`, JSON an `/api/state`, statische Dateien aus `public/` |
| `public/overlay.html` | Das Overlay (eine Datei, Vanilla JS/CSS). Phasen: Lobby → Match läuft → Nach dem Match; eigene 1v1-Ansicht |
| `public/index.html` | Älteres großes Browser-Dashboard (`start.bat`), weniger gepflegt |
| `overlay/main.js` | Electron-Hauptprozess: Fenster rechts am Bildschirmrand, klick-durchlässig, immer oben, Tray, Hotkeys, Auto-Updater. Läuft unsichtbar im Tray (Autostart mit Windows) und zeigt das Overlay nur, solange `Goals.exe` läuft (`checkGame()`, alle 3 s) |
| `scripts/release.js` | Version bumpen, Installer bauen, als Release ins private GitHub-Repo laden |
| `build/` | App-Icons für den Installer |

## Datenquellen (wichtigstes Wissen – war Reverse Engineering)

1. **`%LOCALAPPDATA%\GOALS\Saved\Logs\Game.log`** (Unreal-Log, wird bei jedem Spielstart neu angelegt).
   - Zeilen `LogGoalsShared: Display: Processing game session update: {json}` enthalten die Lobby:
     - `state`: `GAME_SESSION_STATE_LOBBY` → `WAITING_FOR_GAME_SERVER` → `READY_TO_JOIN_GAME_SERVER` (Match läuft) → `POST_GAME_SERVER` (vorbei)
     - `metadata.gameFormat` (`GAME_FORMAT_FIVE_VS_FIVE` / `GAME_FORMAT_ONE_VS_ONE`), `metadata.gameMode` (`GAME_MODE_RANKED`, `GAME_MODE_QUICK_PLAY`, `GAME_MODE_KNOCKOUT`, `GAME_MODE_TOURNAMENT`)
     - `lobbyState.fiveVsFive.home/away.members[]` → `userId`, `skillRating`, `rank` (kleiner = besser), `teamCaptain`
     - `lobbyState.oneVsOne.home/away` → einzelner Spieler (Format aus API abgeleitet, im Log noch nicht live gesehen!)
     - `participants.users[id]` → `username.goals`, Steam-ID, `fiveVsFive.character` (OVR, Rolle, Tier, Attribute); bei 1v1 vermutlich `oneVsOne` mit Kader
   - `OwningPlayerName: <name>` → eigener Spielername.
   - ⚠️ Enthält `gameServerConnection.userToken` – **niemals anzeigen, loggen oder speichern.**
   - Kein Live-Spielstand pro Team im Log (nur `GoalScoredActivated`-Audio-Events ohne Seite).
2. **`https://playgoals.com/api/game-sessions?userId=<uuid>&page=N&pageSize=50`** (max. 50/Seite, nur beendete Matches, kein CORS → nur serverseitig).
   - `sessions[].match_ended.five_vs_five|one_vs_one` mit Teams, Score, `match_result`, `match_end_reason` (`FULL_TIME`, `MERCY_FORFEIT`, `FORFEIT`)
   - 1v1 enthält `skill_rating` pro Seite; 5v5 nicht (null).
   - `userStats[]`: offizielle Aggregat-Stats (v. a. 1v1 Ranked) für Spieler in den geladenen Matches.
3. **`https://playgoals.com/en/user-stats/<uuid>/x`** (HTML, Next.js) → eingebettetes `"stats":{skill_rating, rank, wins, losses, matches_played, expected_goals, play_time_seconds}` und `created_at`. Wird per Regex aus dem HTML gelesen (`fetchProfile`).
4. **Spielerfarben** im 5v5 (Punkt vor dem Namen): aus Spieldatei `MPC_5v5_PlayerIndicatorColors` (Player 1–5 = grün, blau, lila, rot, gelb). Zuordnung per Slot-Reihenfolge in der Lobby – **noch nicht im Spiel verifiziert.**

Was es **nicht** gibt: individuelle 5v5-Matchstats (Tore/Pässe pro Spieler). `playgoals.com/en/match-stat/<id>` hat Event-Daten nur für 1v1 (5v5 → 404). Replays (`Saved/Replays/*.replay`) sind proprietäres Binärformat.

## Kennzahlen
- **Tracker Score 0–1000** (`trackerScore()` in `overlay.html`): bewertet den **Menschen**, nicht die Spielerkarte. Gewichte: SR 25 %, Winrate 25 %, Tordifferenz 15 %, xG/Match 15 %, Form L10 10 %, Erfahrung 5 %, Mercy-Bilanz 5 %. Kleine Stichproben werden Richtung Durchschnitt gezogen (Bayes-Shrinkage); < 10 Spiele = blass/„unsicher“.
- **Party-Erkennung** (`detectParties()` in `server.js`): Spieler im selben Lobby-Team mit ≥ 3 gemeinsamen Matches in ihrer Historie.
- **Siegchance**: Elo-Formel aus Ø-SR der Teams.

## Design-Regeln fürs Overlay (vom Nutzer so gewollt)
- **Keine Interaktion nötig** – kein Aufklappen, keine Buttons, keine Tooltips als einzige Infoquelle. Fenster ist klick-durchlässig.
- Sauber und auf einen Blick lesbar: feste Spalten, Farbe nur mit Bedeutung (grün = gut, rot = schlecht), keine Badge-Flut.
- Parties nur über farbigen linken Rand markieren (keine Badges).
- Schmal: 420 px Breite (21:9-Monitor, Spiel belegt bis x≈3000 von 3440). Oben 64 px frei für FPS-Anzeige.
- Transparenter Hintergrund (`body.ov`), Karten halbtransparent dunkel.

## Entwickeln

```bash
npm install              # einmalig
npm start                # Electron-Overlay aus dem Quellcode (startet Server mit)
npm run server           # nur Server; Dashboard unter http://localhost:7777, Overlay unter /overlay.html
```

- Änderungen an `public/*` werden **live** übernommen (Server meldet neue `uiVersion`, Overlay lädt neu). Änderungen an `server.js`/`overlay/main.js` brauchen einen Neustart.
- **Testen ohne laufendes Spiel:** eigenes Fake-Log schreiben und Server darauf zeigen lassen:
  `GOALS_LOG=<pfad>\Game.log GOALS_DATA_DIR=<tmp>\data PORT=7790 node server.js`
  Fake-Log braucht eine Zeile `OwningPlayerName: <name>` und eine `Processing game session update: {...}`-Zeile (siehe Format oben).
- **Phase erzwingen:** `http://localhost:7777/overlay.html?phase=lobby|live|post` (plus `&overlay=1` für transparenten Modus).
- Umgebungsvariablen: `PORT`, `GOALS_LOG`, `GOALS_NAME`, `GOALS_DATA_DIR`, `OVERLAY_WIDTH`, `OVERLAY_TOP`.

## Release (Auto-Update)
- `npm run release` (oder `npm run release minor`) → bumpt Version, pusht Commit + Tag, baut NSIS-Installer (`--publish never`) und legt mit `gh release create` ein Release in **maximilian-sh/goals-scout** (privat) an. (electron-builders eigener Upload erzeugte doppelte Releases → nicht verwenden.)
- Installierte Apps prüfen beim Start und alle 10 min, laden im Hintergrund und installieren **nie während eines laufenden Matches** (`installWhenIdle`).
- Voraussetzungen auf dem Release-PC: `gh auth login` (Upload) und Datei `%USERPROFILE%\.goals-scout-token` mit einem **read-only** Fine-grained-Token (Contents: Read) für das Repo – wird als `overlay/update-token.json` in die App gepackt (gitignored). Ohne Token gibt es keine Updates.
- Release nur von sauberem Working Tree (Skript bricht sonst ab).

## Konventionen & Stolperfallen
- `server.js` bleibt **ohne npm-Abhängigkeiten** (nur Node-Builtins + globales `fetch`).
- Overlay ist eine einzige HTML-Datei ohne Build-Schritt – so lassen.
- Windows PowerShell 5.1 liest `.ps1` ohne BOM als ANSI → keine Umlaute in PowerShell-Skripten.
- Beim Testen mit Headless-Edge **nie alle `msedge.exe` beenden** (schließt den Browser des Nutzers) – eigenes `--user-data-dir` nutzen.
- Headless-Edge hat eine Mindestbreite (~500 px): schmale Layouts in einem `<iframe width=420>` testen.
- Daten (`data/`) sind lokal und gitignored – keine Nutzerdaten committen.

## Offene Punkte / Ideen
- 1v1-Lobby-Format im Log live verifizieren (Kader-Parsing `squadSummary()` ist generisch geraten).
- Spielerfarben-Zuordnung im Spiel prüfen.
- Individuelle 1v1-Matchstats von `/en/match-stat/<id>` (Pässe, Schüsse, xG pro Match) einbauen.
- Falls GOALS 5v5-Matchstats freischaltet (`fiveVsFiveMatchStats`-Flag auf der Website): individuelle 5v5-Stats + echter Match-Score.
