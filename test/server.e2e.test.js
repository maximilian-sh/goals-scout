// End-to-End: server.js gegen ein Fake-Game.log in einem Temp-Ordner (Port 7798, nie 7777)
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const PORT = 7798;

test('server liest Fake-Log und liefert /api/state', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'goals-scout-e2e-'));
  const log = path.join(dir, 'Game.log');
  const member = (userId, sr) => ({ userId, skillRating: sr, rank: 100 });
  const update = {
    id: 'sess-1', state: 'GAME_SESSION_STATE_LOBBY',
    metadata: { gameFormat: 'GAME_FORMAT_FIVE_VS_FIVE', gameMode: 'GAME_MODE_RANKED', createdAt: '2026-11-26T12:00:00.000Z' },
    lobbyState: { fiveVsFive: { home: { members: [member('u-me', 1500), member('u-2', 1400)] }, away: { members: [member('u-3', 1450)] } } },
    participants: { users: { 'u-me': { username: { goals: 'testuser' } }, 'u-2': { username: { goals: 'Jürgen' } }, 'u-3': { username: { goals: 'other' } } } },
  };
  fs.writeFileSync(log, [
    '[2026.11.26-12.00.00:000][  0]LogInit: OwningPlayerName: testuser',
    `[2026.11.26-12.00.01:000][  0]LogGoalsShared: Display: Processing game session update: ${JSON.stringify(update)}`,
    '',
  ].join('\r\n'));

  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, GOALS_LOG: log, GOALS_DATA_DIR: path.join(dir, 'data'), PORT: String(PORT), GOALS_NAME: '' },
    stdio: 'ignore',
  });
  t.after(() => { child.kill(); try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });

  let state = null;
  for (let i = 0; i < 50 && !state; i++) {
    try { state = await (await fetch(`http://127.0.0.1:${PORT}/api/state`)).json(); }
    catch { await new Promise(r => setTimeout(r, 200)); }
  }
  assert.ok(state, 'Server antwortet nicht');
  assert.strictEqual(state.logFound, true);
  assert.ok(state.session, 'session fehlt');
  assert.deepStrictEqual(state.session.home, ['u-me', 'u-2']);
  assert.strictEqual(state.session.players['u-2'].name, 'Jürgen');
  assert.strictEqual(state.ownName, 'testuser');
});
