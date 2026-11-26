// GOALS Live Scout – liest das Game.log live mit und zeigt Lobby-/Gegnerdaten im Browser.
// Keine Abhängigkeiten, nur Node >= 18.
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { StringDecoder } = require('string_decoder');
const manager = require('./manager');

const PORT = Number(process.env.PORT) || 7777;
const LOG_PATH = process.env.GOALS_LOG ||
  path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'GOALS', 'Saved', 'Logs', 'Game.log');
const DATA_DIR = process.env.GOALS_DATA_DIR || path.join(__dirname, 'data');
const HISTORY_FILE = path.join(DATA_DIR, 'history.json');
const API = 'https://playgoals.com/api/game-sessions';
const PLAYER_CACHE_MS = 10 * 60 * 1000;

fs.mkdirSync(DATA_DIR, { recursive: true });

// ---------- State ----------
let ownName = process.env.GOALS_NAME || null; // aus "OwningPlayerName: X" im Log
let ownId = null;
let session = null;          // aktuelle Lobby
const playerCache = new Map(); // userId -> { at, data }
const clients = new Set();
let history = loadHistory();

const SQUAD_FILE = path.join(DATA_DIR, 'squad.json');
const MATCH_STATS_FILE = path.join(DATA_DIR, 'matchstats.json');
const POST_HOLD_MS = 3 * 60 * 1000; // so lange bleibt die Nach-dem-Match-Ansicht, danach Startseite
const PENDING_MS = 6 * 3600 * 1000; // ältere Lobbys ohne Ergebnis wurden nie gespielt
let squad = manager.readJson(SQUAD_FILE, null);
let squadDirty = false;
const CARDS5_FILE = path.join(DATA_DIR, 'cards5v5.json');
let cards5 = manager.readJson(CARDS5_FILE, {});
let cards5Dirty = false;
let cards5Version = 0; // zählt Änderungen an cards5 (Cache für Upgrade-Tipps)

function loadHistory() {
  let raw;
  try { raw = fs.readFileSync(HISTORY_FILE, 'utf8'); } catch { return []; }
  try {
    const list = JSON.parse(raw);
    // Ältere Versionen haben Backup-Matches hinten angehängt → chronologisch sortieren
    return Array.isArray(list) ? list.sort((a, b) => String(a.at || '').localeCompare(String(b.at || ''))) : [];
  } catch {
    // Kaputte Datei nicht beim nächsten Speichern überschreiben
    fs.copyFileSync(HISTORY_FILE, `${HISTORY_FILE}.corrupt-${Date.now()}`);
    return [];
  }
}
function saveHistory() {
  return manager.saveJson(HISTORY_FILE, history, 1);
}
// Geänderte Dateien speichern. Scheitert ein Speichern, bleibt das Flag gesetzt → nächster Tick versucht es erneut.
function flushDirty() {
  if (historyDirty) historyDirty = !saveHistory();
  if (seenDirty) seenDirty = !manager.saveJson(SEEN_FILE, seen);
  if (squadDirty) squadDirty = !manager.saveJson(SQUAD_FILE, squad);
  if (cards5Dirty) cards5Dirty = !manager.saveJson(CARDS5_FILE, cards5);
}
// Auswertungen dürfen nie Broadcasts oder Requests abbrechen: Fehler → null, einmal pro Teil loggen.
const failedOnce = new Set();
function safe(name, fn) {
  try { return fn(); } catch (e) {
    if (!failedOnce.has(name)) { failedOnce.add(name); console.warn(`${name} fehlgeschlagen: ${e && e.message}`); }
    return null;
  }
}
const isPending = h => !h.res && h.at && Date.now() - Date.parse(`${String(h.at).slice(0, 19)}Z`) < PENDING_MS;

// ---------- Log parsing ----------
const SESSION_MARKER = 'Processing game session update: ';
const SQUAD_SCREENS = new Set(['WBP_SquadManagementScreen', 'SquadWidget', 'BenchCollectionWidget', 'WBP_CollectionList', 'Collection',
  'CollectionWidget', 'WBP_CharacterUpgradeScreen', 'WBP_PlayerDetials3dScreen', 'WBP_SwapContentScreen', 'WBP_SwapCollectionWidget']);
const NEUTRAL_SCREENS = new Set(['RadialMenu', 'ScrollableList']); // kommen in vielen Menüs vor, ändern nichts
let inSquad = false, screenChanged = false;

function handleLine(line) {
  // Namen dürfen Leerzeichen enthalten – bis Zeilenende lesen.
  const owner = line.match(/OwningPlayerName:\s*(\S.*?)\s*$/);
  if (owner && !process.env.GOALS_NAME) ownName = owner[1];

  // Aktiver Bildschirm im Spielmenü: Kader, Sammlung oder Upgrade → Upgrade-Tipps im Overlay
  const screen = line.match(/Applying input config for leaf-most node \[(\w+?)_C_\d+\]/);
  if (screen) {
    const name = screen[1];
    const next = SQUAD_SCREENS.has(name) ? true : NEUTRAL_SCREENS.has(name) ? inSquad : false;
    if (next !== inSquad) { inSquad = next; screenChanged = true; }
    return false;
  }

  const i = line.indexOf(SESSION_MARKER);
  if (i === -1) return false;
  let s;
  try { s = JSON.parse(line.slice(i + SESSION_MARKER.length)); } catch { return false; }
  applySessionUpdate(s);
  return true;
}

function applySessionUpdate(s) {
  if (!s || !s.id) return;
  if (!session || session.id !== s.id) {
    session = {
      id: s.id, players: {}, home: [], away: [],
      format: null, mode: null, state: null, location: null, createdAt: null,
    };
  }
  const md = s.metadata || {};
  session.format = md.gameFormat || session.format;
  session.mode = md.gameMode || session.mode;
  session.createdAt = md.createdAt || session.createdAt;
  session.state = s.state || session.state;
  if (s.gameServerLocation) session.location = s.gameServerLocation.displayName;

  const users = s.participants && s.participants.users;
  if (users) {
    for (const [id, u] of Object.entries(users)) {
      const ch = u.fiveVsFive && u.fiveVsFive.character;
      const squad = u.oneVsOne ? squadSummary(u.oneVsOne) : null;
      session.players[id] = {
        ...session.players[id],
        userId: id,
        name: (u.username && (u.username.goals || u.username.steam)) || id.slice(0, 8),
        platform: (u.platform || '').replace('GAMING_PLATFORM_', ''),
        steamId: u.platformExternalId && u.platformExternalId.steam,
        character: ch ? {
          name: [ch.firstName, ch.lastName].filter(Boolean).join(' '),
          ovr: ch.ovr && ch.ovr.overallRating,
          role: ch.ovr && (ch.ovr.role || '').replace('ROLE_', ''),
          tier: (ch.tier || '').replace('TIER_', ''),
          trait: (ch.heroTrait || '').replace('HERO_TRAIT_', ''),
          age: ch.currentAge,
          nationality: ch.nationality,
          foot: (ch.strongFoot || '').replace('FOOT_', ''),
          stats: ch.stats ? {
            PAC: ch.stats.pace && ch.stats.pace.weightedValue,
            SHO: ch.stats.shooting && ch.stats.shooting.weightedValue,
            PAS: ch.stats.passing && ch.stats.passing.weightedValue,
            DRI: ch.stats.dribbling && ch.stats.dribbling.weightedValue,
            DEF: ch.stats.defending && ch.stats.defending.weightedValue,
            PHY: ch.stats.physicality && ch.stats.physicality.weightedValue,
          } : null,
        } : session.players[id] && session.players[id].character,
        squad: squad || (session.players[id] && session.players[id].squad),
      };
    }
  }

  const lobby = s.lobbyState && (s.lobbyState.fiveVsFive || s.lobbyState.oneVsOne);
  if (lobby && lobby.home && lobby.away) {
    const side = (t) => (t.members || (t.userId ? [t] : [])).map(m => {
      session.players[m.userId] = {
        userId: m.userId, name: m.userId.slice(0, 8), ...session.players[m.userId],
        skillRating: m.skillRating, rank: m.rank, captain: !!m.teamCaptain,
      };
      return m.userId;
    });
    session.home = side(lobby.home);
    session.away = side(lobby.away);
  }

  if (ownName && !ownId) {
    const me = Object.values(session.players).find(p => p.name === ownName);
    if (me) ownId = me.userId;
  }

  const own = ownId && users && users[ownId];
  const parsedSquad = own && own.oneVsOne ? manager.squadFrom(own.oneVsOne) : null;
  if (parsedSquad) { parsedSquad.seenAt = session.createdAt; squad = parsedSquad; squadDirty = true; }
  // 5v5: eigene Karte merken (für Bilanz pro Karte und aktuellen OVR)
  const ownChar = own && own.fiveVsFive && own.fiveVsFive.character;
  if (ownChar && ownChar.id) {
    const card = manager.cardFrom(ownChar);
    session.ownCard = { id: card.id, name: card.name, ovr: card.ovr, role: card.role, tier: card.tier };
    const prev = cards5[card.id];
    if (!prev || String(prev.seenAt) <= String(session.createdAt)) {
      const next = { ...card, seenAt: session.createdAt };
      if (JSON.stringify(prev) !== JSON.stringify(next)) { cards5[card.id] = next; cards5Dirty = true; cards5Version++; }
    }
  }
}

// 1v1: Der Spieler bringt einen ganzen Kader mit. Format im Log ist nicht dokumentiert,
// daher alle Charaktere (Objekte mit ovr.overallRating) im oneVsOne-Teil einsammeln.
function squadSummary(obj) {
  const ovrs = [];
  const walk = o => {
    if (!o || typeof o !== 'object') return;
    if (o.ovr && typeof o.ovr.overallRating === 'number' && o.firstName !== undefined) { ovrs.push(o.ovr.overallRating); return; }
    for (const v of Object.values(o)) walk(v);
  };
  walk(obj);
  if (!ovrs.length) return null;
  ovrs.sort((a, b) => b - a);
  const top = ovrs.slice(0, 11);
  return { size: ovrs.length, avgOvr: top.reduce((a, b) => a + b, 0) / top.length, best: ovrs[0] };
}

// Liest neue Bytes am Dateiende; erkennt Neustart des Spiels (Datei wird kleiner).
let offset = 0;
let partial = '';
// Hält unvollständige UTF-8-Zeichen (z. B. Umlaute) zwischen zwei Lesevorgängen zurück
let decoder = new StringDecoder('utf8');
function readLog(initial) {
  let stat;
  try { stat = fs.statSync(LOG_PATH); } catch { return false; }
  // Neues Log = Spiel neu gestartet → alte Lobby verwerfen
  if (stat.size < offset) { offset = 0; partial = ''; decoder = new StringDecoder('utf8'); session = null; inSquad = false; if (!initial) broadcast(); }
  if (stat.size === offset) return false;
  const fd = fs.openSync(LOG_PATH, 'r');
  const buf = Buffer.alloc(stat.size - offset);
  fs.readSync(fd, buf, 0, buf.length, offset);
  fs.closeSync(fd);
  offset = stat.size;
  const text = partial + decoder.write(buf);
  const lines = text.split(/\r?\n/);
  partial = lines.pop();
  let changed = false;
  for (const l of lines) if (handleLine(l)) { changed = true; recordHistory(); recordSeen(); }
  if (screenChanged) { screenChanged = false; changed = true; }
  return changed && !initial;
}

// ---------- Player lookup via playgoals.com ----------
const UA = { headers: { 'User-Agent': 'Mozilla/5.0 GoalsLiveScout/1.1' } };
const PAGES = 2; // 2 × 50 Matches pro Spieler (API liefert max. 50 pro Seite)

async function getJson(url) {
  const res = await fetch(url, UA);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// Aggregierte Profilwerte stehen nur im HTML der offiziellen Stats-Seite.
// Das JSON ist in Next.js eingebettet und kann verschachtelt sein – daher Klammern zählen
// statt mit einer Regex am ersten "}" abzuschneiden (sonst fehlen bei Formatänderungen alle Werte).
function extractObject(html, key) {
  const at = html.indexOf(`"${key}":`);
  if (at === -1) return null;
  const start = html.indexOf('{', at);
  if (start === -1) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < html.length; i++) {
    const c = html[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) {
      try { return JSON.parse(html.slice(start, i + 1)); } catch { return null; }
    }
  }
  return null;
}

async function fetchProfile(userId) {
  const res = await fetch(`https://playgoals.com/en/user-stats/${userId}/x`, UA);
  if (!res.ok) return null;
  const html = (await res.text()).split('\\"').join('"');
  const stats = extractObject(html, 'stats');
  const cr = html.match(/"created_at":\{"seconds":(\d+)\}/);
  const lo = html.match(/"last_known_gaming_platform_used_at":\{"seconds":(\d+)\}/);
  if (!stats) return null;
  const mp = stats.matches_played;
  return {
    matches: mp ?? null,
    wins: stats.wins, losses: stats.losses,
    winRate: mp ? (stats.wins || 0) / mp : null,
    // Achtung: expected_goals wird von GOALS nur für einen Teil der Matches erfasst.
    // Der Wert ist deshalb NICHT über Spieler hinweg vergleichbar (0,5–3,8 pro Match bei
    // gleicher Torausbeute) und darf nicht in den Tracker Score einfließen.
    xg: stats.expected_goals,
    xgPerMatch: mp ? (stats.expected_goals || 0) / mp : null,
    hours: stats.play_time_seconds != null ? stats.play_time_seconds / 3600 : null,
    profileSR: stats.skill_rating, profileRank: stats.rank,
    createdAt: cr ? Number(cr[1]) : null,
    lastOnline: lo ? Number(lo[1]) : null,
  };
}

async function fetchPlayer(userId) {
  const c = playerCache.get(userId);
  if (c && Date.now() - c.at < PLAYER_CACHE_MS) return c.data;
  const sessions = [];
  const sessionIds = new Set(); // Seiten können sich überlappen, wenn zwischen den Abrufen ein Match endet
  const names = {};
  let oneStats = null;
  for (let page = 1; page <= PAGES; page++) {
    const json = await getJson(`${API}?userId=${userId}&page=${page}&pageSize=50`);
    for (const s of json.sessions || []) {
      const id = s.game_session && s.game_session.id;
      if (id && sessionIds.has(id)) continue;
      if (id) sessionIds.add(id);
      sessions.push(s);
    }
    for (const u of Object.values(json.users || {})) if (u && u.id && u.goals_username) names[u.id] = u.goals_username;
    // Offizielle 1v1-Ranked-Statistik steckt in userStats (für alle Spieler der geladenen Matches)
    for (const us of json.userStats || []) {
      const st = us.stats || {};
      if (st.user_id === userId && st.game_format === 'GAME_FORMAT_ONE_VS_ONE' && st.game_mode === 'GAME_MODE_RANKED') {
        oneStats = { sr: st.skill_rating, rank: st.rank, wins: st.wins || 0, losses: st.losses || 0,
          matches: st.matches_played || 0, goals: st.goals_scored || 0, avgOvr: st.avg_ovr_rating };
      }
    }
    if (!json.hasNext) break;
  }
  const profile = await fetchProfile(userId).catch(() => null);
  const data = { ...summarizePlayer(userId, sessions), oneStats, profile };
  // Häufigste Mitspieler mit Bilanz (für die eigene Startseite)
  data.topMates = Object.entries(data.mateRecords)
    .map(([id, r]) => ({ id, name: names[id] || (seen[id] && seen[id].name) || id.slice(0, 8), games: r.n, wins: r.w }))
    .filter(m => m.games >= 3 && m.name !== m.id.slice(0, 8)) // Platzhalternamen nicht als Mitspieler zeigen
    .sort((a, b) => b.games - a.games).slice(0, 4);
  playerCache.set(userId, { at: Date.now(), data });
  return data;
}

// Kennzahlen aus einer Liste von Matches (neuestes zuerst) – für 5v5 und 1v1 gleich.
function aggregate(pool, sampleType) {
  const n = pool.length;
  // Torbasierte Kennzahlen nur über Matches mit bekanntem Ergebnis rechnen:
  // GOALS liefert bei Mercy/Forfeit oft score:null – als 0:0 gezählt verfälscht das
  // Tordifferenz und "Zu Null" massiv (11 von 95 5v5-Matches).
  const scored = pool.filter(m => m.gf != null && m.ga != null);
  const ns = scored.length;
  const count = r => pool.filter(m => m.res === r).length;
  const sum = fn => scored.reduce((a, m) => a + fn(m), 0);
  const streakRes = pool[0] && pool[0].res;
  let streak = 0; while (streak < n && pool[streak].res === streakRes) streak++;
  const now = Date.now() / 1000;
  const last10 = pool.slice(0, 10);
  return {
    sampleType, games: n, scoredGames: ns,
    wins: count('W'), draws: count('D'), losses: count('L'),
    winRate: n ? count('W') / n : null,
    winRate10: last10.length ? last10.filter(m => m.res === 'W').length / last10.length : null,
    goalsFor: ns ? sum(m => m.gf) / ns : null,
    goalsAgainst: ns ? sum(m => m.ga) / ns : null,
    goalDiff: ns ? sum(m => m.gf - m.ga) / ns : null,
    cleanSheets: ns ? scored.filter(m => m.ga === 0).length / ns : null,
    mercyWins: pool.filter(m => m.mercy && m.res === 'W').length,
    mercyLosses: pool.filter(m => m.mercy && m.res === 'L').length,
    forfeits: pool.filter(m => m.forfeit).length,
    streak: streakRes ? streakRes + streak : '',
    form: last10.map(m => m.res).join(''),
    games24h: pool.filter(m => m.at && now - m.at < 86400).length,
    lastPlayed: pool[0] && pool[0].at,
  };
}

function resultFor(matchResult, isHome) {
  return matchResult === 'MATCH_RESULT_DRAW' ? 'D' : (matchResult === 'MATCH_RESULT_HOME_WIN') === isHome ? 'W' : 'L';
}

function summarizePlayer(userId, sessions) {
  const ranked5 = [], quick5 = [], ranked1 = [], other1 = [];
  const mates = {};      // userId -> gemeinsame 5v5-Matches im selben Team
  const mateRecords = {}; // userId -> { n, w } nur Ranked 5v5
  const h2h = { withW: 0, withL: 0, withD: 0, vsW: 0, vsL: 0, vsD: 0 }; // 5v5, aus Sicht dieses Spielers
  const h2h1 = { W: 0, L: 0, D: 0 };                                   // 1v1 gegen dich, aus seiner Sicht
  for (const s of sessions) {
    if (!s || !s.match_ended) continue;
    const md = s.game_session.metadata || {};
    const end = s.match_ended;
    const base = { at: md.created_at && md.created_at.seconds,
      mercy: end.match_end_reason === 'MATCH_END_REASON_MERCY_FORFEIT',
      forfeit: end.match_end_reason === 'MATCH_END_REASON_FORFEIT' };

    if (md.game_format === 'GAME_FORMAT_ONE_VS_ONE' && end.one_vs_one) {
      const f = end.one_vs_one;
      if (!f.match_result) continue;
      const isHome = f.home_team.user_id === userId;
      if (!isHome && f.away_team.user_id !== userId) continue;
      const me = isHome ? f.home_team : f.away_team, opp = isHome ? f.away_team : f.home_team;
      const m = { ...base, res: resultFor(f.match_result, isHome),
        gf: me.score ?? null, ga: opp.score ?? null, sr: me.skill_rating, mode: md.game_mode };
      (md.game_mode === 'GAME_MODE_RANKED' ? ranked1 : other1).push(m);
      if (ownId && userId !== ownId && opp.user_id === ownId) h2h1[m.res]++;
      continue;
    }

    if (md.game_format !== 'GAME_FORMAT_FIVE_VS_FIVE' || !end.five_vs_five) continue;
    const f = end.five_vs_five;
    if (!f.match_result) continue;
    const homeIds = (f.home_team.users || []).map(u => u.user_id);
    const awayIds = (f.away_team.users || []).map(u => u.user_id);
    const isHome = homeIds.includes(userId);
    if (!isHome && !awayIds.includes(userId)) continue;
    const myIds = isHome ? homeIds : awayIds, oppIds = isHome ? awayIds : homeIds;
    const m = { ...base, res: resultFor(f.match_result, isHome),
      gf: (isHome ? f.home_team.score : f.away_team.score) ?? null,
      ga: (isHome ? f.away_team.score : f.home_team.score) ?? null };
    (md.game_mode === 'GAME_MODE_RANKED' ? ranked5 : quick5).push(m);
    for (const id of myIds) if (id !== userId) {
      mates[id] = (mates[id] || 0) + 1;
      if (md.game_mode === 'GAME_MODE_RANKED') {
        const r = mateRecords[id] ||= { n: 0, w: 0 };
        r.n++; if (m.res === 'W') r.w++;
      }
    }
    if (ownId && userId !== ownId) {
      if (myIds.includes(ownId)) h2h['with' + m.res]++;
      if (oppIds.includes(ownId)) h2h['vs' + m.res]++;
    }
  }
  const five = aggregate(ranked5.length ? ranked5 : quick5, ranked5.length ? 'ranked' : 'all5v5');
  const one = aggregate(ranked1.length ? ranked1 : other1, ranked1.length ? 'ranked' : 'all1v1');
  one.knockout = other1.filter(m => m.mode === 'GAME_MODE_KNOCKOUT').length;
  one.otherGames = other1.length;
  one.h2h = h2h1;
  one.srSeries = ranked1.filter(m => m.sr != null).map(m => m.sr).reverse().slice(-20);
  return {
    ...five, ranked5: ranked5.length, quick5: quick5.length,
    withMe: h2h.withW + h2h.withL + h2h.withD, againstMe: h2h.vsW + h2h.vsL + h2h.vsD,
    h2h, mates, mateRecords, one,
  };
}

// Premades erkennen: Spieler im selben Lobby-Team, die in ihrer Historie oft zusammen gespielt haben.
// Schwelle bewusst streng: 3 gemeinsame Matches sind im kleinen GOALS-Pool schnell Zufall
// (gleiche Rangregion, gleiche Uhrzeit) und führen zu falschen Party-Markierungen.
const PARTY_MIN_SHARED = 4;
const PARTY_MIN_RATIO = 0.2; // zusätzlich: mind. 20 % der Spiele des Spielers mit der kleineren Stichprobe

// Anzahl gemeinsamer Matches – nur wenn beide Spieler geladen sind und beide die Zahl bestätigen.
function partyShared(a, b) {
  const sa = session.players[a] && session.players[a].scout;
  const sb = session.players[b] && session.players[b].scout;
  if (!sa || !sb || !sa.games || !sb.games) return 0;
  const shared = Math.min(sa.mates[b] || 0, sb.mates[a] || 0);
  if (!shared) return 0;
  const smaller = Math.min(sa.games, sb.games);
  return shared >= PARTY_MIN_SHARED && shared / smaller >= PARTY_MIN_RATIO ? shared : 0;
}

function detectParties() {
  if (!session) return;
  let label = 0;
  for (const team of [session.home, session.away]) {
    const parent = Object.fromEntries(team.map(id => [id, id]));
    const find = x => parent[x] === x ? x : (parent[x] = find(parent[x]));
    for (const a of team) for (const b of team) {
      if (a >= b) continue;
      if (partyShared(a, b)) parent[find(a)] = find(b);
    }
    const groups = {};
    for (const id of team) (groups[find(id)] ||= []).push(id);
    for (const id of team) delete session.players[id].party;
    for (const g of Object.values(groups)) {
      if (g.length < 2) continue;
      const tag = String.fromCharCode(65 + label++);
      for (const id of g) {
        const shared = Math.max(...g.filter(x => x !== id).map(o => partyShared(id, o)));
        session.players[id].party = { tag, size: g.length, shared };
      }
    }
  }
}

// Spieler aus früheren Lobbys merken (SR-Verlauf auch für Gegner/Mitspieler).
const SEEN_FILE = path.join(DATA_DIR, 'players.json');
let seen = {};
{
  let raw = null;
  try { raw = fs.readFileSync(SEEN_FILE, 'utf8'); } catch { /* noch keine Datei */ }
  if (raw != null) {
    try { seen = JSON.parse(raw) || {}; } catch {
      // Kaputte Datei nicht beim nächsten Speichern überschreiben (wie loadHistory)
      try { fs.copyFileSync(SEEN_FILE, `${SEEN_FILE}.corrupt-${Date.now()}`); } catch {}
      seen = {};
    }
  }
}
let seenDirty = false;
function recordSeen() {
  if (!session || !session.home.length) return;
  for (const id of [...session.home, ...session.away]) {
    const p = session.players[id];
    if (p.skillRating == null) continue;
    // Solange der Anzeigename im Log fehlt, steht dort die ID-Kurzform – die soll einen
    // bereits bekannten echten Namen nicht überschreiben.
    const placeholder = !p.name || p.name === id.slice(0, 8);
    const e = seen[id] ||= { name: placeholder ? null : p.name, lobbies: {} };
    if (!placeholder) e.name = p.name;
    if (!e.lobbies[session.id]) {
      e.lobbies[session.id] = { at: session.createdAt, sr: p.skillRating, mode: session.mode, format: session.format };
      seenDirty = true;
    }
  }
}
function annotateSeen() {
  if (!session) return;
  for (const id of [...session.home, ...session.away]) {
    const p = session.players[id], e = seen[id];
    if (!e) continue;
    const prev = Object.entries(e.lobbies)
      .filter(([sid, l]) => sid !== session.id && l.format === session.format && l.mode === session.mode)
      .sort((a, b) => String(b[1].at).localeCompare(String(a[1].at)));
    p.seenBefore = prev.length;
    p.srDelta = prev.length && p.skillRating != null ? p.skillRating - prev[0][1].sr : null;
  }
}

const inflight = new Set();
const RETRY_AFTER_MS = 60 * 1000;
function enrichSession() {
  if (!session) return;
  annotateSeen();
  for (const id of [...session.home, ...session.away]) {
    const p = session.players[id];
    if (!p || p.scout || inflight.has(id)) continue;
    // Fehlgeschlagene Abrufe nicht im Sekundentakt wiederholen (sonst API-Hammer bei 404/Offline).
    if (p.scoutError && Date.now() - (p.scoutErrorAt || 0) < RETRY_AFTER_MS) continue;
    inflight.add(id);
    fetchPlayer(id)
      .then(d => { if (session && session.players[id]) { session.players[id].scout = d; delete session.players[id].scoutError; } })
      .catch(e => {
        if (session && session.players[id]) {
          session.players[id].scoutError = e.message;
          session.players[id].scoutErrorAt = Date.now();
        }
      })
      .finally(() => { inflight.delete(id); detectParties(); broadcast(); });
  }
}

// ---------- Own match history (SR-Verlauf) ----------
function recordHistory() {
  if (!session || !ownId || !session.home.length) return;
  const me = session.players[ownId];
  if (!me || me.skillRating == null) return;
  const myTeam = session.home.includes(ownId) ? session.home : session.away;
  const opp = myTeam === session.home ? session.away : session.home;
  const avg = ids => Math.round(ids.reduce((a, id) => a + (session.players[id].skillRating || 0), 0) / (ids.length || 1));
  let h = history.find(x => x.id === session.id);
  if (!h) {
    // Beim Einlesen alter Backup-Logs: schon herausgekürzte Matches nicht wieder anhängen
    if (history.length >= HISTORY_MAX && byAt(session.createdAt) < byAt(history[0].at)) return;
    h = { id: session.id }; history.push(h);
  }
  Object.assign(h, {
    at: session.createdAt, mode: session.mode, format: session.format,
    sr: me.skillRating, rank: me.rank, teamAvg: avg(myTeam), oppAvg: avg(opp),
    isHome: myTeam === session.home,
  });
  if (session.ownCard) h.card = session.ownCard;
  const others = [...session.home, ...session.away].filter(id => id !== ownId)
    .map(id => session.players[id].character && session.players[id].character.ovr).filter(o => typeof o === 'number');
  if (others.length) h.lobbyOvrs = others;
  // Chronologisch halten, dann die ältesten Einträge kürzen
  history.sort((a, b) => byAt(a.at).localeCompare(byAt(b.at)));
  history = history.slice(-HISTORY_MAX);
  historyDirty = true;
}
let historyDirty = false;
const HISTORY_MAX = 500;
const byAt = at => String(at || '');

let lastResultsFetch = 0;
async function fillResults(force) {
  if (!ownId) return;
  // Direkt nach Matchende öfter nachsehen, sonst jede Minute.
  const justEnded = session && session.state === 'GAME_SESSION_STATE_POST_GAME_SERVER';
  if (!force && Date.now() - lastResultsFetch < (justEnded ? 15 : 60) * 1000) return;
  if (!(force ? history.some(h => !h.res) : history.some(isPending))) return;
  lastResultsFetch = Date.now();
  try {
    const res = await fetch(`${API}?userId=${ownId}&page=1&pageSize=50`);
    const json = await res.json();
    let changed = false;
    for (const s of json.sessions || []) {
      const h = history.find(x => x.id === s.game_session.id && !x.res);
      const end = s.match_ended;
      if (!h || !end) continue;
      const f = end.five_vs_five || end.one_vs_one;
      if (!f || !f.match_result) continue;
      const home = f.home_team, away = f.away_team;
      const gf = h.isHome ? home.score : away.score;
      const ga = h.isHome ? away.score : home.score;
      // Bei Mercy/Forfeit fehlt oft der Score – dann lieber keinen Score anzeigen als 0:0.
      if (gf != null && ga != null) { h.gf = gf; h.ga = ga; } else { delete h.gf; delete h.ga; }
      h.res = f.match_result === 'MATCH_RESULT_DRAW' ? 'D' : (f.match_result === 'MATCH_RESULT_HOME_WIN') === h.isHome ? 'W' : 'L';
      changed = true;
    }
    if (changed) { historyDirty = !saveHistory(); broadcast(); }
  } catch { /* offline – später nochmal */ }
}

// ---------- HTTP + SSE ----------
// ---------- Eigenes Profil (Startseite im Overlay, wenn gerade keine Lobby offen ist) ----------
let me = null;
function resolveOwnId() {
  if (ownId || !ownName) return;
  // Nach einem Spielstart ist noch keine Lobby im Log – dann aus früheren Lobbys (players.json) ermitteln
  const hit = Object.entries(seen).find(([, e]) => e.name === ownName);
  if (hit) ownId = hit[0];
}
async function refreshMe() {
  resolveOwnId();
  if (!ownId) return;
  try {
    const data = await fetchPlayer(ownId); // 10 min Cache
    if (!me || me.scout !== data) { me = { id: ownId, name: ownName, scout: data }; broadcast(); }
  } catch { /* offline */ }
}

// Siegchance-Modell nur neu rechnen, wenn neue Ergebnisse da sind.
let modelKey = null, model = null;
function currentWinModel() {
  // Schlüssel: Anzahl Ergebnisse + letztes Ergebnis (ändert sich auch beim Kürzen auf 500)
  const done = history.filter(h => h.res);
  const key = `${done.length}:${done.length ? done[done.length - 1].id : ''}`;
  if (key !== modelKey) { modelKey = key; model = safe('winModel', () => manager.winModel(history)); }
  return model;
}

// Kader-Manager: Matchstats im Hintergrund nachladen, nie während eines laufenden Matches.
let managerBusy = false;
async function refreshManager() {
  resolveOwnId();
  if (managerBusy || !ownId || !squad) return;
  if (session && session.state === 'GAME_SESSION_STATE_READY_TO_JOIN_GAME_SERVER') return;
  managerBusy = true;
  try { await manager.syncMatchStats({ ownId, squad, file: MATCH_STATS_FILE }); }
  catch { /* offline – später nochmal */ }
  finally { managerBusy = false; }
}

// Upgrade-Tipps nur neu rechnen, wenn sich Kader oder 5v5-Karten ändern.
let adviceSquad, adviceVersion = -1, advice = null;
function currentAdvice() {
  if (squad !== adviceSquad || cards5Version !== adviceVersion) {
    adviceSquad = squad; adviceVersion = cards5Version;
    advice = safe('upgradeAdvice', () => manager.upgradeAdvice(squad, cards5));
  }
  return advice;
}
function snapshot() {
  return {
    logPath: LOG_PATH, logFound: fs.existsSync(LOG_PATH),
    ownName, ownId, me, session, history: history.slice(-100), winModel: currentWinModel(), uiVersion: uiVersion(),
    inSquad, upgrades: currentAdvice(),
  };
}
function uiVersion() {
  const dir = path.join(__dirname, 'public');
  return Math.max(...fs.readdirSync(dir).map(f => fs.statSync(path.join(dir, f)).mtimeMs));
}
// Overlay neu laden, wenn sich die UI-Dateien ändern.
let lastUi = uiVersion();
setInterval(() => { const v = uiVersion(); if (v !== lastUi) { lastUi = v; broadcast(); } }, 2000);

function broadcast() {
  const msg = `data: ${JSON.stringify(snapshot())}\n\n`;
  for (const res of clients) res.write(msg);
}

const server = http.createServer((req, res) => {
  if (req.url === '/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(`data: ${JSON.stringify(snapshot())}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }
  if (req.url === '/api/state') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(snapshot()));
  }
  if (req.url === '/api/manager') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    const one = safe('analyze', () => manager.analyze(squad, manager.readJson(MATCH_STATS_FILE, { matches: {} })));
    return res.end(JSON.stringify({ five: safe('analyze5', () => manager.analyze5(history, cards5, squad, one)), one }));
  }
  let urlPath;
  try { urlPath = decodeURIComponent(req.url.split('?')[0]); }
  catch { res.writeHead(400); return res.end('bad request'); }
  const file = urlPath === '/' ? 'index.html' : urlPath.slice(1);
  const root = path.join(__dirname, 'public');
  const full = path.join(root, path.normalize(file));
  if (!full.startsWith(root + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(full, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    const type = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }[path.extname(full)] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type + '; charset=utf-8' });
    res.end(buf);
  });
});

// Initial komplettes Log lesen (letzte Lobby wird sofort angezeigt), danach jede Sekunde neue Zeilen.
// Ältere Logs (Game-backup-*.log von früheren Spielstarts) nur für den SR-Verlauf einlesen.
const LOG_DIR = path.dirname(LOG_PATH);
const backups = fs.existsSync(LOG_DIR) ? fs.readdirSync(LOG_DIR).filter(f => /^Game-backup.*\.log$/.test(f)).sort() : [];
for (const f of backups) {
  for (const l of fs.readFileSync(path.join(LOG_DIR, f), 'utf8').split(/\r?\n/)) if (handleLine(l)) { recordHistory(); recordSeen(); }
}
session = null;
inSquad = false;
readLog(true);
flushDirty();
// Beim Start ist ein beendetes Match aus dem Log schon vorbei → direkt Startseite
if (session && session.state === 'GAME_SESSION_STATE_POST_GAME_SERVER') session = null;
enrichSession();
fillResults(true);
refreshMe();
refreshManager();
setInterval(refreshMe, 60 * 1000);
setInterval(refreshManager, 10 * 60 * 1000);

// Das Log meldet keine Rückkehr ins Menü, deshalb endet die Nach-dem-Match-Ansicht per Timeout.
function expirePostGame() {
  if (!session || session.state !== 'GAME_SESSION_STATE_POST_GAME_SERVER') return;
  session.postAt ||= Date.now();
  if (Date.now() - session.postAt > POST_HOLD_MS) { session = null; broadcast(); }
}

setInterval(() => {
  if (readLog(false)) {
    recordHistory();
    enrichSession();
    broadcast();
  }
  flushDirty();
  expirePostGame();
  fillResults(false);
}, 1000);

server.listen(PORT, '127.0.0.1', () => {
  console.log(`GOALS Live Scout läuft: http://localhost:${PORT}`);
  console.log(`Log: ${LOG_PATH}${fs.existsSync(LOG_PATH) ? '' : '  (noch nicht gefunden – starte GOALS)'}`);
  if (ownName) console.log(`Spieler: ${ownName}`);
});
