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
| `manager.js` / `public/manager.html` | Kader-Manager (Tray → „Kader-Manager öffnen“). **5v5 zuerst** (`analyze5`): eigene Karte pro Match (`history[].card`, aus `participants.users[ownId].fiveVsFive.character`), Karten-OVR der Lobby (`history[].lobbyOvrs`), aktueller Kartenstand in `data/cards5v5.json`; zeigt Bilanz/SR pro Karte, Lobby-Niveau, nächste lohnende Karte, Talente. Darunter 1v1 (`analyze`): Kader aus dem Log, öffentliche 1v1-Matchstats (`playerMetrics`, `playerRatings`), Stammelf/Entwickeln/Abgeben. Nur lesend |
| `overlay/main.js` | Electron-Hauptprozess: Fenster rechts am Bildschirmrand, klick-durchlässig, immer oben, Tray, Hotkeys, Auto-Updater. Läuft unsichtbar im Tray (Autostart mit Windows) und zeigt das Overlay nur, solange `Goals.exe` läuft (`checkGame()`, alle 3 s) |
| `scripts/release.js` | Version bumpen + Tag pushen; der Tag startet den Build auf GitHub |
| `.github/workflows/` | `test.yml` (Tests bei Push/PR), `release.yml` (Installer bauen + Release bei Tag `v*`) |
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
   - `LogUIActionRouter: ... Applying input config for leaf-most node [WBP_X_C_123]` → aktiver Menü-Bildschirm. Kader/Sammlung/Upgrade (`SQUAD_SCREENS` in `server.js`) → Overlay zeigt Upgrade-Tipps (`viewUpgrades`, Test: `?phase=squad`). Die ganze Sammlung steht **nicht** im Log, nur der 1v1-Kader und die 5v5-Karte.
   - ⚠️ Enthält `gameServerConnection.userToken` – **niemals anzeigen, loggen oder speichern.**
   - Kein Live-Spielstand pro Team im Log (nur `GoalScoredActivated`-Audio-Events ohne Seite).
2. **`https://playgoals.com/api/game-sessions?userId=<uuid>&page=N&pageSize=50`** (max. 50/Seite, nur beendete Matches, kein CORS → nur serverseitig).
   - `sessions[].match_ended.five_vs_five|one_vs_one` mit Teams, Score, `match_result`, `match_end_reason` (`FULL_TIME`, `MERCY_FORFEIT`, `FORFEIT`)
   - ⚠️ `score` ist bei ~12 % der 5v5-Matches `null` (meist Mercy/Forfeit, teils auch FULL_TIME) – niemals als `0` behandeln.
   - `metadata` nutzt `created_at` (snake_case, `{seconds}`); das Game.log nutzt `createdAt` (ISO-String).
   - 1v1 enthält `skill_rating` pro Seite; 5v5 nicht (null).
   - `userStats[]`: offizielle Aggregat-Stats (v. a. 1v1 Ranked) für Spieler in den geladenen Matches.
3. **`https://playgoals.com/en/user-stats/<uuid>/x`** (HTML, Next.js) → eingebettetes `"stats":{skill_rating, rank, wins, losses, matches_played, expected_goals, play_time_seconds}` und `created_at`. Wird per Regex aus dem HTML gelesen (`fetchProfile`).
4. **Spielerfarben** im 5v5 (Punkt vor dem Namen): aus Spieldatei `MPC_5v5_PlayerIndicatorColors` (Player 1–5 = grün, blau, lila, rot, gelb). Zuordnung per Slot-Reihenfolge in der Lobby – **noch nicht im Spiel verifiziert.**

Was es **nicht** gibt: individuelle 5v5-Matchstats (Tore/Pässe pro Spieler). `playgoals.com/en/match-stat/<id>` hat Event-Daten nur für 1v1 (5v5 → 404). Replays (`Saved/Replays/*.replay`) sind proprietäres Binärformat.

## Kennzahlen
- **Tracker Score 0–1000** (`trackerScore()` in `overlay.html`): bewertet den **Menschen**, nicht die Spielerkarte. **5v5** (an 20.442 Ranked-Matches gefittet, Nov 2026): SR 30 % (`lin` 1400–2100), Winrate 38 % (stark geschrumpft: `(wins+80)/(games+160)`, `lin` .477–.560), Mercy-Bilanz 32 % (`(mercyW−mercyL)/(games+5)`, `lin` −.25–.34). Tordifferenz, Form und Erfahrung sagten zusätzlich nichts voraus und zählen nicht mehr (nur Anzeige). Team-Schnitt neu: Log-Loss 0,652 statt 0,671. Der Rohwert wird per Perzentil-Tabelle auf die alte Skala abgebildet (Mitte ≈ 500), damit die Farbstufen gleich bleiben. **1v1** nutzt noch die alten Gewichte. < 10 Spiele = blass/„unsicher".
- ⚠️ **Kein xG im Score.** `expected_goals` auf der Profilseite wird von GOALS nur für einen Teil der Matches erfasst (pro Spieler 13–68 % seiner Tore). `expected_goals / matches_played` streut dadurch 0,5–3,8 pro Match, obwohl alle Spieler 4–5,6 Team-Tore pro Spiel haben – als Kennzahl wertlos. Wird nicht mehr angezeigt (Spalte ist jetzt „Tore / Gegentore").
- **Torbasierte Werte nur mit Ergebnis:** Mercy-/Forfeit-Matches liefern oft `score: null` (ca. 12 % der 5v5-Matches). Diese Matches zählen für Winrate/Form mit, aber **nicht** für Tore, Tordifferenz, „Zu Null". `scoredGames` = Stichprobe mit bekanntem Ergebnis; bei < 3 gewerteten Spielen ist die Tordifferenz im Score neutral.
- **Party-Erkennung** (`detectParties()` in `server.js`): Spieler im selben Lobby-Team mit **≥ 4** gemeinsamen Matches **und** ≥ 20 % der Spiele des Spielers mit der kleineren Stichprobe. Beide Spielerdatensätze müssen geladen sein (sonst kein Urteil). 3 gemeinsame Matches waren im kleinen GOALS-Pool zu oft Zufall.
- **Worauf achten** (`opponentCard()` in `overlay.html`, nur Lobby): gefährlichster Gegner (Score + Karten-OVR) mit max. 2 Tipps aus Karte/Eigenschaft (Tempo, Distanzschuss, Kopfball+Größe, Dribbling, Strafraumstürmer), schwächster Verteidiger (DEF < 75) und Spielstil des Gegner-Teams (Ø Tore, Mercy-Siege). Abgeleitet aus Kartenwerten, nicht gemessen: 5v5 hat keine öffentlichen Einzelstats, Replays sind ein eigenes Binärformat, das Log nennt keinen Schützen.
- **5v5-Matchstats-Check** (`checkFiveStats()` in `server.js`): prüft alle 6 h, ob `/en/match-stat/<5v5-id>` nicht mehr 404 liefert; dann Hinweis auf der Startseite. Für 1v1 gibt es dort u. a. `scoring_attempt_location`, Schussarten, Tackles – das wäre die Quelle für Gegner-Analysen.
- **Siegchance** (`teamWinChance()` in `overlay.html`): Elo auf den Ø-SR der Teams (fehlende SR werden ignoriert, nicht als 0 gezählt – das war bis Nov 2026 ein Bug in `recordHistory`, deshalb nutzt `winModel` nur Einträge mit `srOk`). Fehlt bei 2+ Spielern eines Teams die SR: Logit `12.2·ΔWR160 + 2.47·ΔMercy + 0.067·ΔParty-Spieler`. Mit korrekten Schnitten ist Elo gut kalibriert (b≈1), `winModel` greift nur, wenn es im Backtest besser ist.
- **Verkaufswert** = Stufe der unteren Potenzial-Grenze (<60: 100, 60: 250, 70: 650, 80: 3.000, 85: 25.000, 90: 250.000, 95: 2.000.000). **Upgrade-Kosten** nach OVR vor dem Upgrade (`upgradeCost()` in `manager.js`, im Spiel gemessen, ab 90 unbekannt). XP pro Schritt je Stufe: 0,5 / 1,5 / 2,5 / 4 / 5,5 / 7,5 Mio. `upgradeAdvice()` empfiehlt Upgrades, die den erwarteten Verkaufswert stärker erhöhen als sie kosten.

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

## Start aus dem Git-Klon (Freunde, ohne Installer)
- `overlay.bat` → `scripts/launch.js`: prüft, ob die App schon läuft (Port belegt → kein Update), `git pull --ff-only` ohne Passwortabfrage mit 30 s Timeout, `npm install` wenn `package-lock.json` sich seit der letzten erfolgreichen Installation geändert hat (Hash in `node_modules/.goals-lock-hash`), lädt `electron.exe` nach, falls npm Installationsskripte blockiert, startet Electron.
- `kader-manager.bat` → `launch.js --no-overlay`: nur Update + `node server.js` im Fenster + Kader-Manager im Browser (für 16:9-Bildschirme, auf denen das Overlay stört). `public/manager.html` zeigt dafür auch die Upgrade-Tipps und lädt alle 30 s neu.
- Was auf dem verfolgten Branch landet, läuft beim Freund beim nächsten Start. Vorher `npm test` (node:test, keine Abhängigkeiten: `test/manager.test.js`, `test/server.e2e.test.js` auf Port 7798).

## Gemeinsam entwickeln (Maxim + Leo)
- Ein Repo: **maximilian-sh/goals-scout** (privat), Hauptbranch `main`. Beide haben Schreibrechte.
- **Vor dem Arbeiten immer `git pull`** – der andere hat evtl. gepusht. Lokale, nicht committete Änderungen vorher committen oder `git stash` → `git pull` → `git stash pop`.
- Kleine Sachen (Fix, Textänderung) direkt auf `main` committen und pushen. Größere Features auf einem Branch `feature/<name>` und per Pull Request mergen (Beispiel: PR #1 `feature/manager-scout`), damit der andere drüberschauen kann.
- `main` muss immer laufen: Freunde mit Git-Klon (`overlay.bat`) bekommen jeden Push auf `main` beim nächsten Start. Vor dem Push `npm test`.
- **CI:** `.github/workflows/test.yml` lässt `npm test` bei jedem Push auf `main` und bei jedem PR laufen (Windows-Runner). Roter Haken → erst fixen.
- Merge-Konflikte entstehen fast immer in `public/overlay.html` und `server.js` (große Einzeldateien) – beide Seiten behalten, dann `npm test` und das Overlay kurz mit `?phase=lobby` anschauen.
- Wer neue Erkenntnisse über Datenquellen, Kennzahlen oder Stolperfallen gewinnt, trägt sie hier in `CLAUDE.md` ein (gilt auch für Claude-Sessions).
- Commit-Messages auf Deutsch, kurz, im Präsens („Overlay zeigt …“, „Party-Erkennung strenger“).

## Release (Auto-Update)
- **Ablauf:** auf `main`, alles committet und gepusht → `npm run release` (Patch) oder `npm run release minor`.
  `scripts/release.js` prüft sauberen Working Tree, Branch `main` und Stand von `origin/main`, lässt `npm test` laufen, bumpt die Version (`npm version` → Commit „Release x.y.z“ + Tag `vx.y.z`) und pusht.
- **Gebaut wird auf GitHub:** `.github/workflows/release.yml` startet bei jedem Tag `v*` (Windows-Runner): prüft Tag = `package.json`-Version, `npm ci`, `npm test`, packt das Secret `UPDATE_TOKEN` als `overlay/update-token.json` ein, baut den NSIS-Installer (`--publish never`) und legt mit `gh release create` das Release mit `.exe`, `.blockmap` und `latest.yml` an. Dauer ca. 5 min, Status unter Actions bzw. `gh run list`.
- Also **nur Tag pushen = Release**. Keine Tags `v*` von Hand anlegen, die nicht von `npm version` kommen (Workflow bricht ab, wenn Tag und `package.json` nicht passen).
- Schlägt der Build fehl: Fehler fixen, Tag löschen (`git push --delete origin vX.Y.Z`, `git tag -d vX.Y.Z`) und neu releasen – oder einfach die nächste Patch-Version releasen.
- Notfall ohne Actions: `npm run release -- --local` baut lokal und lädt per `gh` hoch (braucht `gh auth login` und `%USERPROFILE%\.goals-scout-token`).
- **Repo-Secret `UPDATE_TOKEN`:** **read-only** Fine-grained-Token (Contents: Read) für das Repo. Landet in jeder ausgelieferten App → nie ein Token mit Schreibrechten nehmen. Erneuern: neues Token erstellen, `gh secret set UPDATE_TOKEN` und neues Release – ältere installierte Apps behalten ihr altes Token (bis es abläuft, bekommen sie Updates).
- electron-builders eigener Upload (`--publish always`) erzeugte doppelte Releases → nicht verwenden.
- Installierte Apps prüfen beim Start und alle 10 min, laden im Hintergrund und installieren **nie während eines laufenden Matches** (`installWhenIdle`). Differenzielle Updates sind aus (Blockmaps privater Releases nicht lesbar).
- Version steht nur in `package.json` – nicht von Hand ändern, das macht `npm version`.

## Konventionen & Stolperfallen
- `server.js` bleibt **ohne npm-Abhängigkeiten** (nur Node-Builtins + globales `fetch`).
- Overlay ist eine einzige HTML-Datei ohne Build-Schritt – so lassen.
- Windows PowerShell 5.1 liest `.ps1` ohne BOM als ANSI → keine Umlaute in PowerShell-Skripten.
- Beim Testen mit Headless-Edge **nie alle `msedge.exe` beenden** (schließt den Browser des Nutzers) – eigenes `--user-data-dir` nutzen.
- `body.ov .row { border: … }` hat höhere Spezifität als `.row[data-party="A"]` – Party-Farben müssen im `body.ov`-Block erneut gesetzt werden, sonst sind sie im Overlay unsichtbar (nur im Browser-Dashboard).
- Headless-Edge hat eine Mindestbreite (~500 px): schmale Layouts in einem `<iframe width=420>` testen.
- Daten (`data/`) sind lokal und gitignored – keine Nutzerdaten committen.

## Offene Punkte / Ideen
- 1v1-Lobby-Format im Log live verifizieren (Kader-Parsing `squadSummary()` ist generisch geraten).
- Spielerfarben-Zuordnung im Spiel prüfen.
- Individuelle 1v1-Matchstats von `/en/match-stat/<id>` (Pässe, Schüsse, xG pro Match) einbauen.
- Falls GOALS 5v5-Matchstats freischaltet (`fiveVsFiveMatchStats`-Flag auf der Website): individuelle 5v5-Stats + echter Match-Score.
