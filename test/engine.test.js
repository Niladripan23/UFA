'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const game = require('../auctionEngine');
const { loadConfig } = require('../config');
const { loadGameData, validateData } = require('../gameData');
const { testData, lot } = require('./fixtures');
const token = () => crypto.randomBytes(32).toString('hex');
function room() { return game.createRoom({ roomCode: 'abcdef123456', password: 'Test1234', adminTeamName: '<b>Host</b>', maxTeams: 4, startingBudget: 500, categoryFilter: 'mixed', sessionToken: token() }, { ttlSeconds: 14400 }, 'test', 0); }

test('strict input, code normalization, password case and config validation', () => {
  assert.equal(game.roomCode(' abcdef123456 '), 'ABCDEF123456');
  for (const code of [null, {}, 'short', 'x'.repeat(100), '!!!!!!!!!!!!']) assert.throws(() => game.roomCode(code));
  assert.throws(() => game.password(' Test1234'));
  assert.throws(() => game.teamName('x'.repeat(25)));
  assert.throws(() => game.tokenHash('guess'));
  const r = room();
  assert.equal(game.passwordMatches('Test1234', r), true);
  assert.equal(game.passwordMatches('test1234', r), false);
  assert.throws(() => loadConfig({}), /REDIS_URL/);
  assert.throws(() => loadConfig({ REDIS_URL: 'redis://localhost', ALLOWED_ORIGINS: '*' }), /ALLOWED_ORIGINS/);
  assert.equal(loadConfig({ REDIS_URL: 'redis://localhost' }).graceMs, 45000);
});
test('required datasets fail on missing, invalid, empty or malformed files', () => {
  const dir = fs.mkdtempSync(path.join(__dirname, '.tmp-data-'));
  try {
    assert.throws(() => loadGameData(dir), /Cannot load required/);
    fs.writeFileSync(path.join(dir, 'players.json'), '{bad');
    assert.throws(() => loadGameData(dir), /invalid JSON/);
    assert.throws(() => validateData([], 'players'), /non-empty/);
    assert.throws(() => validateData([{ name: 'x' }], 'players'), /category/);
    assert.throws(() => validateData([{ ...lot('test', 'ST'), baseprice: '10' }], 'players'), /baseprice/);
  } finally {
    fs.rmSync(path.join(dir, 'players.json'), { force: true });
    fs.rmdirSync(dir);
  }
});
test('public snapshots exclude all private room and team fields', () => {
  const r = room();
  r.secret = 'private'; r.teams[0].connectionId = 'socket-secret'; r.highestBidderId = r.teams[0].id;
  const json = JSON.stringify(game.sanitizeRoom(r));
  for (const key of ['password', 'sessionHash', 'sessionToken', 'connectionId', 'receipts', 'instanceId', 'secret']) assert.equal(json.includes(key), false, key);
  assert.deepEqual(game.sanitizeRoom(r).highestBidder, { id: r.teams[0].id, name: r.teams[0].name });
});
test('draft order, slabs, purse, quotas, pass and exactly-once conclusion', () => {
  const r = room(); const a = r.teams[0]; const b = game.newTeam('B', 500, game.tokenHash(token())); r.teams.push(b);
  game.startAuction(r, testData(), 0);
  assert.deepEqual(r.pool.map(p => p.primaryRole), ['manager', 'manager', 'midfielder', 'forward', 'goalkeeper', 'defender']);
  game.bid(r, b, 100);
  assert.equal(r.currentBid, 10); assert.equal(r.timerEndsAt, 12100);
  assert.throws(() => game.bid(r, b, 100), /highest bid/);
  assert.throws(() => game.pass(r, b, 100), /highest bidder/);
  const result = game.pass(r, a, 100);
  assert.equal(result.event, 'lot_concluded'); assert.equal(b.purse, 490); assert.ok(b.manager);
  game.tick(r, 200); assert.equal(b.purse, 490);
  game.tick(r, 3100); assert.equal(r.phase, 'BIDDING');
  assert.throws(() => game.bid(r, b, 3200), /limit reached/);
  r.currentIndex = 3; r.currentBid = 48; r.highestBidderId = b.id;
  game.bid(r, a, 4000); assert.equal(r.currentBid, 50);
  game.bid(r, b, 4100); assert.equal(r.currentBid, 55);
  r.currentBid = 100; game.bid(r, a, 4200); assert.equal(r.currentBid, 105);
  game.bid(r, b, 4300); assert.equal(r.currentBid, 115);
  a.purse = 1; assert.throws(() => game.bid(r, a, 4400), /Insufficient/);
  for (const [role, max] of [['forward', 4], ['midfielder', 3], ['defender', 3], ['goalkeeper', 1]]) {
    r.pool[r.currentIndex] = { ...r.pool[r.currentIndex], primaryRole: role }; a.purse = 1000;
    a.squad = Array.from({ length: max }, () => ({ primaryRole: role }));
    assert.throws(() => game.bid(r, a, 4500), /limit reached/);
  }
});
test('pause freezes clocks, five-second phase break precedes a full twelve-second lot', () => {
  const r = room(); game.startAuction(r, testData(), 0);
  game.setPaused(r, true, 2000); assert.equal(r.remainingMs, 10000);
  game.tick(r, 100000); assert.equal(r.currentIndex, 0);
  game.setPaused(r, false, 100000); assert.equal(r.timerEndsAt, 110000);
  r.currentIndex = 1;
  game.tick(r, 110000);
  assert.equal(r.phase, 'INTERSTITIAL'); assert.equal(r.transitionMs, 5000);
  assert.equal(game.sanitizeRoom(r, 110000).interstitialTimer, 3);
  assert.equal(game.sanitizeRoom(r, 113000).phaseBreakTimer, 2);
  game.tick(r, 115000); assert.equal(r.timerEndsAt, 127000);
});
