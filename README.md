# GOALS Scout

Live-Overlay für **GOALS** (Steam) – wie Valorant Tracker / Blitz, aber für 5v5 und 1v1.
Sobald ein Match gefunden ist, siehst du rechts am Bildschirm alle Spieler: Tracker Score, SR, Winrate, Form,
Premade-Parties, Bilanz gegen/mit dir. Nach dem Match: Ergebnis, Tagesbilanz, SR-Verlauf.

## Installieren (Spieler)
1. `GOALS-Scout-Setup-x.y.z.exe` ausführen (von Maxim bekommen oder aus den Releases).
   Windows-SmartScreen warnt evtl. („unbekannter Herausgeber“) → **Weitere Informationen → Trotzdem ausführen**.
2. Fertig. Das Overlay startet, sitzt rechts am Bildschirmrand und aktualisiert sich ab jetzt **automatisch**
   (nie während eines Matches).

**Steuerung:** `Strg+Umschalt+O` ein/aus · `Strg+Umschalt+Q` beenden · grünes „G“ im Tray (Rechtsklick):
Version, Updates suchen, „Mit Windows starten“.

## Entwickeln
Siehe [DEVELOPMENT.md](DEVELOPMENT.md). Projektwissen für Claude Code steht in [CLAUDE.md](CLAUDE.md).

## Datenschutz / Fairness
Liest nur die lokale Log-Datei des Spiels und öffentliche Profil-/Matchdaten von playgoals.com.
Kein Eingriff ins Spiel, kein Speicherzugriff, keine Manipulation.
