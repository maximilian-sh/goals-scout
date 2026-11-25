// Unit-Tests für manager.js (node:test, keine Abhängigkeiten)
const test = require('node:test');
const assert = require('node:assert');
const m = require('../manager');

test('upgradeCost: Stufengrenzen', () => {
  const cases = { 59: 290, 60: 300, 69: 800, 70: 1000, 79: 5500, 80: 7500, 84: 17500, 85: 25000, 89: 55000, 90: null };
  for (const [ovr, cost] of Object.entries(cases)) assert.strictEqual(m.upgradeCost(Number(ovr)), cost, `OVR ${ovr}`);
  assert.strictEqual(m.upgradeCost(null), null);
});

test('sellValue: Stufengrenzen', () => {
  const cases = { 59: 100, 60: 250, 69: 250, 70: 650, 79: 650, 80: 3000, 84: 3000, 85: 25000, 89: 25000, 90: 250000, 94: 250000, 95: 2000000 };
  for (const [lo, v] of Object.entries(cases)) assert.strictEqual(m.sellValue(Number(lo)), v, `potLo ${lo}`);
});

const card = (id, extra) => ({ id, name: id, role: 'CM', ovr: 80, potLo: 80, potHi: 85, ...extra });

test('upgradeAdvice: fertige Karte wird übersprungen', () => {
  const r = m.upgradeAdvice({ cards: [card('a', { steps: 3, stepsDone: 3 })] }, {});
  assert.strictEqual(r.cards.length, 0);
  assert.strictEqual(r.finished, 1);
});

test('upgradeAdvice: letztes Upgrade 87 mit 89–91 lohnt sich (+110.000)', () => {
  const r = m.upgradeAdvice({ cards: [card('b', { ovr: 87, potLo: 89, potHi: 91, steps: 5, stepsDone: 4 })] }, {});
  const c = r.cards[0];
  assert.strictEqual(c.action, 'Upgraden');
  assert.strictEqual(c.left, 1);
  assert.ok(Math.abs(c.profit - 110000) < 1, `profit ${c.profit}`);
});

test('upgradeAdvice: potLo > potHi wirft nicht', () => {
  assert.doesNotThrow(() => m.upgradeAdvice({ cards: [card('c', { potLo: 88, potHi: 86, steps: 5, stepsDone: 4 })] }, {}));
});

test('upgradeAdvice: Karte bis 90 ohne Gewinn → 90+', () => {
  const r = m.upgradeAdvice(null, { d: card('d', { ovr: 85, potLo: 86, potHi: 90 }) });
  assert.strictEqual(r.cards[0].action, '90+');
});

test('analyze5: leere Historie', () => {
  assert.strictEqual(m.analyze5([], {}, null, null), null);
});

test('winModel: unter 30 Matches nicht verwenden', () => {
  const h = Array.from({ length: 10 }, (_, i) => ({ format: 'GAME_FORMAT_FIVE_VS_FIVE', mode: 'GAME_MODE_RANKED', res: i % 2 ? 'W' : 'L', teamAvg: 1500, oppAvg: 1480 }));
  const r = m.winModel(h);
  assert.strictEqual(r.use, false);
  assert.strictEqual(r.n, 10);
});

test('saveJson: Fehler werfen nicht, sondern liefern false', () => {
  const path = require('path'), os = require('os');
  const bad = path.join(os.tmpdir(), 'goals-scout-gibt-es-nicht', 'x', 'y.json');
  const warn = console.warn; console.warn = () => {};
  try { assert.strictEqual(m.saveJson(bad, { a: 1 }), false); } finally { console.warn = warn; }
});
