// GOALS Live Scout – liest das Game.log live mit und zeigt Lobby-/Gegnerdaten im Browser.
// Keine Abhängigkeiten, nur Node >= 18.
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

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

function loadHistory() {
  try { return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')); } catch { return []; }
}
function saveHistory() {
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 1));
}

// ---------- Log parsing ----------
const SESSION_MARKER = 'Processing game session update: ';

function handleLine(line) {
  const owner = line.match(/OwningPlayerName: (\S+)/);
  if (owner && !process.env.GOALS_NAME) ownName = owner[1];

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
function readLog(initial) {
  let stat;
  try { stat = fs.statSync(LOG_PATH); } catch { return false; }
  if (stat.size < offset) { offset = 0; partial = ''; }
  if (stat.size === offset) return false;
  const fd = fs.openSync(LOG_PATH, 'r');
  const buf = Buffer.alloc(stat.size - offset);
  fs.readSync(fd, buf, 0, buf.length, offset);
  fs.closeSync(fd);
  offset = stat.size;
  const text = partial + buf.toString('utf8');
  const lines = text.split(/\r?\n/);
  partial = lines.pop();
  let changed = false;
  for (const l of lines) if (handleLine(l)) { changed = true; recordHistory(); recordSeen(); }
  if (historyDirty) { historyDirty = false; saveHistory(); }
  if (seenDirty) { seenDirty = false; fs.writeFileSync(SEEN_FILE, JSON.stringify(seen)); }
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
async function fetchProfile(userId) {
  const res = await fetch(`https://playgoals.com/en/user-stats/${userId}/x`, UA);
  if (!res.ok) return null;
  const html = (await res.text()).split('\\"').join('"');
  const st = html.match(/"stats":(\{"skill_rating"[^}]*\})/);
  const cr = html.match(/"created_at":\{"seconds":(\d+)\}/);
  const lo = html.match(/"last_known_gaming_platform_used_at":\{"seconds":(\d+)\}/);
  let stats = null;
  try { stats = st && JSON.parse(st[1]); } catch {}
  if (!stats) return null;
  const mp = stats.matches_played;
  return {
    matches: mp ?? null,
    wins: stats.wins, losses: stats.losses,
    winRate: mp ? (stats.wins || 0) / mp : null,
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
  let oneStats = null;
  for (let page = 1; page <= PAGES; page++) {
    const json = await getJson(`${API}?userId=${userId}&page=${page}&pageSize=50`);
    sessions.push(...(json.sessions || []));
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
  playerCache.set(userId, { at: Date.now(), data });
  return data;
}

// Kennzahlen aus einer Liste von Matches (neuestes zuerst) – für 5v5 und 1v1 gleich.
function aggregate(pool, sampleType) {
  const n = pool.length;
  const count = r => pool.filter(m => m.res === r).length;
  const sum = fn => pool.reduce((a, m) => a + fn(m), 0);
  const streakRes = pool[0] && pool[0].res;
  let streak = 0; while (streak < n && pool[streak].res === streakRes) streak++;
  const now = Date.now() / 1000;
  const last10 = pool.slice(0, 10);
  return {
    sampleType, games: n,
    wins: count('W'), draws: count('D'), losses: count('L'),
    winRate: n ? count('W') / n : null,
    winRate10: last10.length ? last10.filter(m => m.res === 'W').length / last10.length : null,
    goalsFor: n ? sum(m => m.gf) / n : null,
    goalsAgainst: n ? sum(m => m.ga) / n : null,
    goalDiff: n ? sum(m => m.gf - m.ga) / n : null,
    cleanSheets: n ? pool.filter(m => m.ga === 0).length / n : null,
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
      const isHome = f.home_team.user_id === userId;
      if (!isHome && f.away_team.user_id !== userId) continue;
      const me = isHome ? f.home_team : f.away_team, opp = isHome ? f.away_team : f.home_team;
      const m = { ...base, res: resultFor(f.match_result, isHome), gf: me.score || 0, ga: opp.score || 0, sr: me.skill_rating, mode: md.game_mode };
      (md.game_mode === 'GAME_MODE_RANKED' ? ranked1 : other1).push(m);
      if (ownId && userId !== ownId && opp.user_id === ownId) h2h1[m.res]++;
      continue;
    }

    if (md.game_format !== 'GAME_FORMAT_FIVE_VS_FIVE' || !end.five_vs_five) continue;
    const f = end.five_vs_five;
    const homeIds = (f.home_team.users || []).map(u => u.user_id);
    const awayIds = (f.away_team.users || []).map(u => u.user_id);
    const isHome = homeIds.includes(userId);
    if (!isHome && !awayIds.includes(userId)) continue;
    const myIds = isHome ? homeIds : awayIds, oppIds = isHome ? awayIds : homeIds;
    const m = { ...base, res: resultFor(f.match_result, isHome),
      gf: (isHome ? f.home_team.score : f.away_team.score) || 0,
      ga: (isHome ? f.away_team.score : f.home_team.score) || 0 };
    (md.game_mode === 'GAME_MODE_RANKED' ? ranked5 : quick5).push(m);
    for (const id of myIds) if (id !== userId) mates[id] = (mates[id] || 0) + 1;
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
    h2h, mates, one,
  };
}

// Premades erkennen: Spieler im selben Lobby-Team, die in ihrer Historie oft zusammen gespielt haben.
const PARTY_MIN_SHARED = 3;
function detectParties() {
  if (!session) return;
  let label = 0;
  for (const team of [session.home, session.away]) {
    const parent = Object.fromEntries(team.map(id => [id, id]));
    const find = x => parent[x] === x ? x : (parent[x] = find(parent[x]));
    for (const a of team) for (const b of team) {
      if (a >= b) continue;
      const sa = session.players[a].scout, sb = session.players[b].scout;
      const shared = Math.max((sa && sa.mates[b]) || 0, (sb && sb.mates[a]) || 0);
      if (shared >= PARTY_MIN_SHARED) parent[find(a)] = find(b);
    }
    const groups = {};
    for (const id of team) (groups[find(id)] ||= []).push(id);
    for (const id of team) delete session.players[id].party;
    for (const g of Object.values(groups)) {
      if (g.length < 2) continue;
      const tag = String.fromCharCode(65 + label++);
      for (const id of g) {
        const sc = session.players[id].scout;
        const shared = Math.max(...g.filter(x => x !== id).map(o => (sc && sc.mates[o]) || 0));
        session.players[id].party = { tag, size: g.length, shared };
      }
    }
  }
}

// Spieler aus früheren Lobbys merken (SR-Verlauf auch für Gegner/Mitspieler).
const SEEN_FILE = path.join(DATA_DIR, 'players.json');
let seen = {};
try { seen = JSON.parse(fs.readFileSync(SEEN_FILE, 'utf8')); } catch {}
let seenDirty = false;
function recordSeen() {
  if (!session || !session.home.length) return;
  for (const id of [...session.home, ...session.away]) {
    const p = session.players[id];
    if (p.skillRating == null) continue;
    const e = seen[id] ||= { name: p.name, lobbies: {} };
    e.name = p.name;
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
function enrichSession() {
  if (!session) return;
  annotateSeen();
  for (const id of [...session.home, ...session.away]) {
    const p = session.players[id];
    if (!p || p.scout || inflight.has(id)) continue;
    inflight.add(id);
    fetchPlayer(id)
      .then(d => { if (session && session.players[id]) session.players[id].scout = d; })
      .catch(e => { if (session && session.players[id]) session.players[id].scoutError = e.message; })
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
  if (!h) { h = { id: session.id }; history.push(h); }
  Object.assign(h, {
    at: session.createdAt, mode: session.mode, format: session.format,
    sr: me.skillRating, rank: me.rank, teamAvg: avg(myTeam), oppAvg: avg(opp),
    isHome: myTeam === session.home,
  });
  history = history.slice(-500);
  historyDirty = true;
}
let historyDirty = false;

let lastResultsFetch = 0;
async function fillResults(force) {
  if (!ownId) return;
  // Direkt nach Matchende öfter nachsehen, sonst jede Minute.
  const justEnded = session && session.state === 'GAME_SESSION_STATE_POST_GAME_SERVER';
  if (!force && Date.now() - lastResultsFetch < (justEnded ? 15 : 60) * 1000) return;
  if (!history.some(h => !h.res)) return;
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
      if (!f) continue;
      const home = f.home_team, away = f.away_team;
      h.gf = (h.isHome ? home.score : away.score) || 0;
      h.ga = (h.isHome ? away.score : home.score) || 0;
      h.res = f.match_result === 'MATCH_RESULT_DRAW' ? 'D' : (f.match_result === 'MATCH_RESULT_HOME_WIN') === h.isHome ? 'W' : 'L';
      changed = true;
    }
    if (changed) { saveHistory(); broadcast(); }
  } catch { /* offline – später nochmal */ }
}

// ---------- HTTP + SSE ----------
function snapshot() {
  return {
    logPath: LOG_PATH, logFound: fs.existsSync(LOG_PATH),
    ownName, ownId, session, history: history.slice(-100), uiVersion: uiVersion(),
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
  const urlPath = decodeURIComponent(req.url.split('?')[0]);
  const file = urlPath === '/' ? 'index.html' : urlPath.slice(1);
  const full = path.join(__dirname, 'public', path.normalize(file));
  if (!full.startsWith(path.join(__dirname, 'public'))) { res.writeHead(403); return res.end(); }
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
readLog(true);
enrichSession();
fillResults(true);

setInterval(() => {
  if (readLog(false)) {
    recordHistory();
    enrichSession();
    broadcast();
  }
  fillResults(false);
}, 1000);

server.listen(PORT, () => {
  console.log(`GOALS Live Scout läuft: http://localhost:${PORT}`);
  console.log(`Log: ${LOG_PATH}${fs.existsSync(LOG_PATH) ? '' : '  (noch nicht gefunden – starte GOALS)'}`);
  if (ownName) console.log(`Spieler: ${ownName}`);
});
