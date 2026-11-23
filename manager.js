// Kader-Manager: wertet den eigenen 1v1-Kader und die öffentlichen 1v1-Matchstats aus.
// Nur lesend. Keine Abhängigkeiten. 5v5 hat öffentlich keine Einzelstats (siehe CLAUDE.md).
const fs = require('fs');
const path = require('path');

const API = 'https://playgoals.com/api/game-sessions';
const UA = { headers: { 'User-Agent': 'Mozilla/5.0 GoalsLiveScout/1.1' } };
const MAX_PAGES = 6;
const MIN_MINUTES = 270; // darunter gelten Spielstil und Note als unsicher
const LOW_USAGE = .15;   // Anteil der Minuten des meistgenutzten Spielers
const GROUPS = { GK: 'TW', CB: 'ABW', FB: 'ABW', WB: 'ABW', DM: 'MIT', CM: 'MIT', AM: 'MIT', WM: 'MIT', WF: 'ANG', CF: 'ANG', ST: 'ANG' };
const XI_SLOTS = { TW: 1, ABW: 4, MIT: 3, ANG: 3 }; // nur Fallback, wenn die echte Startelf fehlt

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJsonAtomic(file, value, indent) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, indent));
  fs.renameSync(tmp, file);
}

// ---------- Kader aus dem Game.log (nur benötigte Felder, kein Seed, keine Tokens) ----------
const strip = (v, prefix) => String(v || '').replace(prefix, '');
function cardFrom(c) {
  const s = c.stats || {};
  const w = k => s[k] && s[k].weightedValue;
  const next = c.nextUpgradeXpRequirement;
  return {
    id: c.id,
    name: [c.firstName, c.lastName].filter(Boolean).join(' '),
    age: c.currentAge, ovr: c.ovr && c.ovr.overallRating, role: strip(c.ovr && c.ovr.role, 'ROLE_'),
    tier: strip(c.tier, 'TIER_'), foot: strip(c.strongFoot, 'FOOT_'),
    potLo: c.maxPotentialRatingRange && c.maxPotentialRatingRange.lowerBound,
    potHi: c.maxPotentialRatingRange && c.maxPotentialRatingRange.upperBound,
    xp: c.currentXp, nextXp: next && next < 4294967295 ? next : null,
    sell: c.discardValue && c.discardValue.points,
    attrs: { PAC: w('pace'), SHO: w('shooting'), PAS: w('passing'), DRI: w('dribbling'), DEF: w('defending'), PHY: w('physicality'), GK: w('goalkeeping') },
  };
}
function collectIds(value, known, out = new Set()) {
  if (typeof value === 'string') { if (known.has(value)) out.add(value); return out; }
  if (value && typeof value === 'object') for (const v of Object.values(value)) collectIds(v, known, out);
  return out;
}
function squadFrom(oneVsOne) {
  if (!oneVsOne || !oneVsOne.characters) return null;
  const cards = Object.values(oneVsOne.characters).filter(c => c && c.id).map(cardFrom);
  const known = new Set(cards.map(c => c.id));
  const sq = oneVsOne.squad || {};
  return {
    updatedAt: sq.updatedAt || null, formation: typeof sq.formation === 'string' ? sq.formation : null,
    starters: [...collectIds(sq.startingEleven, known)], subs: [...collectIds(sq.substitutes, known)], cards,
  };
}

// ---------- Öffentliche 1v1-Matchseite ----------
function balancedObject(text, start) {
  let depth = 0, inString = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) { if (c === '\\') i++; else if (c === '"') inString = false; continue; }
    if (c === '"') inString = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return text.slice(start, i + 1);
  }
  return null;
}
function embedded(text, key) {
  const at = text.indexOf(`"${key}":{`);
  if (at === -1) return null;
  const raw = balancedObject(text, at + key.length + 3);
  try { return raw ? JSON.parse(raw) : null; } catch { return null; }
}
function pick(obj, key) {
  if (!obj || typeof obj !== 'object') return undefined;
  if (typeof obj[key] === 'number') return obj[key];
  for (const v of Object.values(obj)) { const r = v && typeof v === 'object' ? pick(v, key) : undefined; if (r !== undefined) return r; }
  return undefined;
}
function linesFor(metrics, ratings, ids) {
  const out = {};
  for (const id of ids) {
    const m = metrics && metrics[id];
    if (!m) continue;
    const n = k => pick(m, k) || 0;
    const min = n('minutes_played');
    if (!min) continue; // Bank ohne Einsatz zählt nicht als gespielt
    const r = ratings && ratings[id];
    out[id] = {
      min, goals: n('goals'), shots: n('shots_total'), xg: n('expected_goals'), keyPasses: n('key_passes'),
      finalThird: n('final_third_touches'), touches: n('touches_total'), tackles: n('tackles'), interceptions: n('interceptions'),
      defRecoveries: n('defensive_third_recoveries'), passes: n('passes_attempted'), passesOk: n('passes_completed'),
      rating: r && typeof r.value === 'number' ? r.value : null,
    };
  }
  return out;
}

async function syncMatchStats({ ownId, squad, file }) {
  const store = readJson(file, { matches: {} });
  if (!ownId || !squad) return store;
  const ids = squad.cards.map(c => c.id);
  const sessions = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const res = await fetch(`${API}?userId=${ownId}&page=${page}&pageSize=50`, UA);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    sessions.push(...(json.sessions || []));
    if (!json.hasNext) break;
  }
  const todo = sessions.filter(s => s.match_ended && s.match_ended.one_vs_one && !store.matches[s.game_session.id]);
  let changed = false, unsaved = 0;
  for (const s of todo) {
    const id = s.game_session.id;
    const res = await fetch(`https://playgoals.com/en/match-stat/${id}`, UA);
    if (res.ok) {
      const text = (await res.text()).split('\\"').join('"').split('\\\\').join('\\');
      const lines = linesFor(embedded(text, 'playerMetrics'), embedded(text, 'playerRatings'), ids);
      if (Object.keys(lines).length) {
        store.matches[id] = { at: s.game_session.metadata && s.game_session.metadata.created_at && s.game_session.metadata.created_at.seconds, lines };
        changed = true;
        if (++unsaved >= 10) { writeJsonAtomic(file, store); unsaved = 0; } // Fortschritt beim ersten großen Import sichern
      }
    }
    await new Promise(r => setTimeout(r, 400));
  }
  if (changed) writeJsonAtomic(file, store);
  return store;
}

// ---------- Auswertung ----------
function aggregateLines(store) {
  const all = {};
  for (const match of Object.values((store && store.matches) || {})) {
    for (const [id, l] of Object.entries(match.lines)) {
      const a = all[id] ||= { matches: 0, min: 0, goals: 0, shots: 0, xg: 0, keyPasses: 0, finalThird: 0, touches: 0, tackles: 0, interceptions: 0, defRecoveries: 0, ratingSum: 0, ratingMin: 0 };
      a.matches++;
      for (const k of ['min', 'goals', 'shots', 'xg', 'keyPasses', 'finalThird', 'touches', 'tackles', 'interceptions', 'defRecoveries']) a[k] += l[k] || 0;
      if (l.rating != null && l.min) { a.ratingSum += l.rating * l.min; a.ratingMin += l.min; }
    }
  }
  return all;
}
function styleOf(card, a) {
  if (GROUPS[card.role] === 'TW') return { label: 'Torwart', index: null, source: 'Karte', sure: true };
  if (a && a.min > 0) {
    const attack = a.shots + a.keyPasses + a.finalThird * .2 + a.xg * 2;
    const defense = a.tackles + a.interceptions + a.defRecoveries;
    if (attack + defense > 0) {
      const index = (attack - defense) / (attack + defense);
      return { label: index > .2 ? 'Spielt vorne' : index < -.2 ? 'Spielt hinten' : 'Ausgewogen', index, source: 'Matches', sure: a.min >= MIN_MINUTES };
    }
  }
  const t = card.attrs || {};
  const attack = ((t.SHO || 0) + (t.DRI || 0)) / 2, defense = ((t.DEF || 0) + (t.PHY || 0)) / 2;
  const index = attack + defense ? (attack - defense) / (attack + defense) : 0;
  return { label: index > .08 ? 'Karte: offensiv' : index < -.08 ? 'Karte: defensiv' : 'Karte: ausgewogen', index, source: 'Karte', sure: false };
}
function analyze(squad, store) {
  if (!squad || !squad.cards.length) return null;
  const totals = aggregateLines(store);
  const rated = Object.values(totals).filter(a => a.ratingMin >= MIN_MINUTES).map(a => a.ratingSum / a.ratingMin);
  const meanRating = rated.length ? rated.reduce((x, y) => x + y, 0) / rated.length : null;
  const players = squad.cards.map(card => {
    const a = totals[card.id] || null;
    const rating = a && a.ratingMin ? a.ratingSum / a.ratingMin : null;
    const form = rating != null && meanRating != null && a.ratingMin >= MIN_MINUTES ? Math.max(-2, Math.min(2, (rating - meanRating) * 2)) : 0;
    const growth = Math.max(0, ((card.potLo ?? card.ovr) + (card.potHi ?? card.ovr)) / 2 - card.ovr);
    const per90 = k => a && a.min ? a[k] / a.min * 90 : null;
    return { ...card, group: GROUPS[card.role] || 'MIT', growth, power: card.ovr + form, rating, style: styleOf(card, a),
      perf: a ? { matches: a.matches, min: Math.round(a.min), goals: a.goals, xg: a.xg, shots90: per90('shots'), tackles90: per90('tackles'), interceptions90: per90('interceptions') } : null,
      starter: squad.starters.includes(card.id) };
  });
  // Die echte Startelf hat Vorrang. Die Positionsraster gelten nur, wenn sie im Log fehlt.
  const xi = new Set(squad.starters.length === 11 ? squad.starters : []);
  if (!xi.size) {
    for (const [group, n] of Object.entries(XI_SLOTS)) {
      players.filter(p => p.group === group).sort((a, b) => b.power - a.power || a.age - b.age).slice(0, n).forEach(p => xi.add(p.id));
    }
  }
  const maxMin = Math.max(1, ...players.map(p => (p.perf ? p.perf.min : 0)));
  const minSquad = 11 + (squad.subs.length || 0);
  const canRelease = Math.max(0, players.length - minSquad);
  for (const p of players) {
    p.inXi = xi.has(p.id);
    p.usage = (p.perf ? p.perf.min : 0) / maxMin;
    p.develop = p.age <= 23 && p.growth >= 1.5;
    p.action = p.inXi ? 'Stammelf' : p.develop ? 'Entwickeln' : 'Kader';
    p.reason = p.inXi ? 'In deiner Startelf' : p.develop ? `Kann noch auf ${p.potLo}–${p.potHi} wachsen` : 'Rotation und Tiefe';
  }
  const starters = players.filter(p => p.inXi);
  for (const p of players.filter(x => !x.inXi && !x.develop)) {
    const weakerStarter = starters.filter(s => s.group === p.group && s.group !== 'TW').sort((a, b) => a.ovr - b.ovr)[0];
    if (weakerStarter && p.ovr >= weakerStarter.ovr + 2) p.reason = `${p.ovr - weakerStarter.ovr} OVR über ${weakerStarter.name}, in der Startelf testen`;
    // Echte Leistung schlägt OVR: Bankspieler mit klar besserer Note als ein Starter der gleichen Gruppe
    if (p.rating == null || p.perf.min < MIN_MINUTES) continue;
    const worst = starters.filter(s => s.group === p.group && s.group !== 'TW' && s.rating != null && s.perf.min >= MIN_MINUTES).sort((a, b) => a.rating - b.rating)[0];
    if (worst && p.rating >= worst.rating + .5) {
      p.action = 'Einsetzen';
      p.reason = `Note ${p.rating.toFixed(1)} statt ${worst.rating.toFixed(1)} von ${worst.name}`;
    }
  }
  // Abgeben nur, wer kaum spielt, nicht wächst und nicht der beste Ersatz seiner Gruppe ist.
  const surplus = [];
  for (const group of Object.keys(XI_SLOTS)) {
    const bench = players.filter(p => p.group === group && !p.inXi).sort((a, b) => b.power - a.power);
    surplus.push(...bench.slice(1).filter(p => !p.develop && p.usage < LOW_USAGE));
  }
  surplus.sort((a, b) => a.usage - b.usage || a.power - b.power || b.age - a.age);
  surplus.forEach((p, i) => {
    p.action = 'Abgeben';
    p.releaseNow = i < canRelease;
    p.reason = p.releaseNow ? `Spielt kaum, bringt ${p.sell ?? '?'} Punkte` : 'Spielt kaum, vorher Ersatz holen';
  });
  // Nächster Ersatz: schwächster Stammspieler, ältere Spieler zählen etwas schlechter.
  const replace = [...starters].sort((a, b) => (a.ovr - Math.max(0, a.age - 29) * .5) - (b.ovr - Math.max(0, b.age - 29) * .5))[0];
  const order = { Einsetzen: 0, Stammelf: 1, Entwickeln: 2, Kader: 3, Abgeben: 4 };
  players.sort((a, b) => order[a.action] - order[b.action] || b.power - a.power);
  return {
    updatedAt: squad.updatedAt, players, minSquad, canRelease,
    matches: Object.keys((store && store.matches) || {}).length,
    totalSell: players.reduce((x, p) => x + (p.sell || 0), 0),
    releaseValue: surplus.filter(p => p.releaseNow).reduce((x, p) => x + (p.sell || 0), 0),
    buy: replace ? { group: replace.group, role: replace.role, replaces: replace.name, replacesAge: replace.age, minOvr: replace.ovr + 1, maxAge: 24 } : null,
  };
}

// ---------- Siegchance: Elo, per Logit an die eigenen Ranked-5v5-Matches angepasst ----------
const logistic = x => 1 / (1 + Math.exp(-x));
function fit(rows, prior = 8) {
  let a = 0, b = 1;
  for (let it = 0; it < 25; it++) {
    let ga = -prior * a, gb = -prior * (b - 1), haa = prior, hab = 0, hbb = prior;
    for (const { d, y } of rows) {
      const p = logistic(a + b * d), w = Math.max(p * (1 - p), 1e-6);
      ga += y - p; gb += (y - p) * d; haa += w; hab += w * d; hbb += w * d * d;
    }
    const det = haa * hbb - hab * hab;
    if (Math.abs(det) < 1e-9) break;
    const da = (hbb * ga - hab * gb) / det, db = (haa * gb - hab * ga) / det;
    a += da; b += db;
    if (Math.abs(da) + Math.abs(db) < 1e-6) break;
  }
  return { a, b };
}
function winModel(history) {
  const rows = (history || [])
    .filter(h => h.format === 'GAME_FORMAT_FIVE_VS_FIVE' && h.mode === 'GAME_MODE_RANKED' && (h.res === 'W' || h.res === 'L') && h.teamAvg && h.oppAvg)
    .map(h => ({ d: (h.teamAvg - h.oppAvg) / 400 * Math.LN10, y: h.res === 'W' ? 1 : 0 }));
  if (rows.length < 30) return { use: false, n: rows.length, a: 0, b: 1 };
  let model = 0, elo = 0;
  rows.forEach((r, i) => {
    const m = fit(rows.filter((_, j) => j !== i));
    model += (logistic(m.a + m.b * r.d) - r.y) ** 2;
    elo += (logistic(r.d) - r.y) ** 2;
  });
  const { a, b } = fit(rows);
  return { use: model < elo, n: rows.length, a, b, brierModel: model / rows.length, brierElo: elo / rows.length };
}

module.exports = { readJson, writeJsonAtomic, squadFrom, syncMatchStats, analyze, winModel };
