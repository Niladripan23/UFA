'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const path = require('node:path');
const { io } = require('socket.io-client');
const { RoomStore } = require('../roomStore');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

test('independent clients, validation, bids, sessions, process restart and Redis consistency', { timeout: 60000 }, async t => {
  const redisUrl = process.env.TEST_REDIS_URL;
  assert.ok(redisUrl, 'Set TEST_REDIS_URL to an isolated Redis instance for multiplayer tests.');
  const port = Number(process.env.TEST_PORT || 4196);
  const prefix = 'ufa:test:' + crypto.randomUUID() + ':room:';
  const store = new RoomStore(redisUrl, prefix); await store.connect();
  const clients = [];
  let child;
  let stderr = '';
  async function boot() {
    child = spawn(process.execPath, [path.join(__dirname, 'fixture-server.cjs')], {
      env: { ...process.env, TEST_REDIS_URL: redisUrl, TEST_PORT: String(port), TEST_PREFIX: prefix }, windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    child.stderr.on('data', data => { stderr += data; });
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Test server did not start: ' + stderr)), 15000);
      child.stdout.on('data', data => { if (String(data).includes('TEST_READY')) { clearTimeout(timeout); resolve(); } });
      child.once('error', error => { clearTimeout(timeout); reject(error); });
      child.once('exit', code => { clearTimeout(timeout); reject(new Error('Test server exited: ' + code + ' ' + stderr)); });
    });
  }
  async function stop() {
    if (child && child.exitCode === null) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; }
  }
  async function client(transport = 'websocket') {
    const socket = io('http://127.0.0.1:' + port, { transports: [transport], reconnection: false, forceNew: true, timeout: 5000,
      extraHeaders: { Origin: 'http://localhost:' + port } });
    clients.push(socket);
    await Promise.race([once(socket, 'connect'), once(socket, 'connect_error').then(([error]) => { throw error; })]);
    return socket;
  }
  function request(socket, event, payload) {
    return new Promise((resolve, reject) => socket.timeout(5000).emit(event, payload, (err, reply) => err ? reject(err) : resolve(reply)));
  }
  const token = () => crypto.randomBytes(32).toString('hex');
  const auth = (code, name, sessionToken) => ({ roomCode: code, password: 'Test1234', teamName: name, adminTeamName: name, sessionToken,
    maxTeams: 4, startingBudget: 500, categoryFilter: 'mixed' });
  const code = 'ABCDEF123456';
  const action = (socket, event, extra = {}) => request(socket, event, { roomCode: code, requestId: crypto.randomUUID(), ...extra });
  try {
    await boot();
    const a = await client(); let b = await client('polling'); const c = await client(); const outsider = await client();
    const ta = token(), tb = token(), tc = token();
    let created, joinedB, joinedC;
    await t.test('A–D: create/join and live counts across websocket and polling', async () => {
      created = await request(a, 'create_room', auth(code.toLowerCase(), 'Host', ta));
      assert.equal(created.ok, true); assert.equal(created.room.code, code);
      assert.notEqual(created.myTeamId, a.id);
      const updated = once(a, 'room_state_updated');
      joinedB = await request(b, 'join_room', auth(code, '<b>Club B</b>', tb));
      assert.equal(joinedB.ok, true); assert.equal((await updated)[0].teams.length, 2);
      joinedC = await request(c, 'join_room', auth(code, 'Club C', tc));
      assert.equal(joinedC.room.teams.length, 3);
      const repeated = await request(b, 'join_room', auth(code, '<b>Club B</b>', tb));
      assert.equal(repeated.myTeamId, joinedB.myTeamId); assert.equal(repeated.room.teams.length, 3);
      assert.equal(JSON.stringify(repeated.room).includes('sessionHash'), false);
      assert.equal(JSON.stringify(repeated.room).includes('password'), false);
    });
    await t.test('K–L: wrong passwords/codes, malformed payloads and unauthorized actions', async () => {
      assert.equal((await request(outsider, 'join_room', { ...auth(code, 'D', token()), password: 'Wrong123' })).error, 'WRONG_PASSWORD');
      assert.equal((await request(outsider, 'join_room', auth('MISSING12345', 'D', token()))).error, 'ROOM_NOT_FOUND');
      assert.equal((await request(outsider, 'create_room', null)).error, 'INVALID_INPUT');
      assert.equal((await request(outsider, 'create_room', { ...auth('INVALID12345', 'D', token()), startingBudget: -1 })).error, 'INVALID_BUDGET');
      assert.equal((await action(outsider, 'raise_bid', { lotIndex: 0 })).error, 'NOT_A_MEMBER');
      assert.equal((await action(b, 'start_auction')).error, 'HOST_ONLY');
      assert.equal((await request(outsider, 'resume_session', { roomCode: code, teamId: joinedB.myTeamId, sessionToken: token() })).error, 'SESSION_EXPIRED');
    });
    await t.test('E–G: start, bid broadcast, pass, concurrent bids and idempotent retry', async () => {
      const started = await action(a, 'start_auction'); assert.equal(started.room.status, 'LIVE');
      const seenA = once(a, 'bid_placed'); const seenC = once(c, 'bid_placed');
      const bid = await action(b, 'raise_bid', { lotIndex: 0 });
      assert.equal(bid.room.currentBid, 10);
      assert.equal((await seenA)[0].room.highestBidder.id, joinedB.myTeamId);
      assert.equal((await seenC)[0].room.currentBid, 10);
      const passed = await action(c, 'pass_bid', { lotIndex: 0 });
      assert.ok(passed.room.passedTeamIds.includes(joinedC.myTeamId));
      const bids = await Promise.all([action(a, 'raise_bid', { lotIndex: 0 }), action(c, 'raise_bid', { lotIndex: 0 })]);
      assert.ok(bids.every(result => result.ok));
      assert.equal((await store.getRoom(code)).currentBid, 14);
      const requestId = crypto.randomUUID();
      const first = await request(b, 'raise_bid', { roomCode: code, lotIndex: 0, requestId });
      const second = await request(b, 'raise_bid', { roomCode: code, lotIndex: 0, requestId });
      assert.equal(first.room.currentBid, 16); assert.equal(second.room.currentBid, 16);
      assert.equal((await action(a, 'host_kick_player', { targetTeamId: joinedB.myTeamId })).error, 'LOBBY_ONLY');
    });
    await t.test('H–I, M: refresh/drop resume stable club; duplicate session replaces old connection', async () => {
      b.disconnect(); b = await client();
      const restored = await request(b, 'resume_session', { roomCode: code, teamId: joinedB.myTeamId, sessionToken: tb });
      assert.equal(restored.myTeamId, joinedB.myTeamId); assert.equal(restored.room.teams.length, 3);
      const replacement = await client(); const moved = once(b, 'session_replaced');
      const resumed = await request(replacement, 'resume_session', { roomCode: code, teamId: joinedB.myTeamId, sessionToken: tb });
      await moved; assert.equal(resumed.room.teams.length, 3); b = replacement;
    });
    await t.test('J, N: real Node process restart preserves bid, purchase and host authority', async () => {
      await action(a, 'pass_bid', { lotIndex: 0 });
      const sold = await action(c, 'pass_bid', { lotIndex: 0 });
      const buyer = sold.room.teams.find(team => team.id === joinedB.myTeamId);
      assert.ok(buyer.manager); assert.equal(buyer.purse, 484);
      // Let the real server transition to the next lot before creating an active bid.
      for (let i = 0; i < 50 && (await store.getRoom(code)).phase !== 'BIDDING'; i++) await delay(100);
      assert.equal((await action(a, 'raise_bid', { lotIndex: 1 })).ok, true);
      const before = await store.getRoom(code);
      await stop(); await boot();
      const recoveredHost = await client(); const recoveredB = await client('polling');
      const restored = await request(recoveredHost, 'resume_session', { roomCode: code, teamId: created.myTeamId, sessionToken: ta });
      assert.equal(restored.ok, true); assert.equal(restored.room.isPaused, true);
      assert.equal(restored.room.hostTeamId, created.myTeamId); assert.equal(restored.room.currentBid, before.currentBid);
      assert.equal(restored.room.highestBidder.id, created.myTeamId);
      const recoveredBuyer = restored.room.teams.find(team => team.id === joinedB.myTeamId);
      assert.equal(recoveredBuyer.manager, buyer.manager); assert.equal(recoveredBuyer.purse, 484);
      assert.equal(restored.room.teams.length, 3);
      await request(recoveredB, 'resume_session', { roomCode: code, teamId: joinedB.myTeamId, sessionToken: tb });
      assert.equal((await action(recoveredHost, 'host_toggle_pause', { isPaused: false })).ok, true);
      assert.equal((await action(recoveredB, 'host_toggle_pause', { isPaused: true })).error, 'HOST_ONLY');
      assert.equal((await action(recoveredHost, 'host_toggle_pause', { isPaused: true })).ok, true);
      // Storage-level stale copies cannot overwrite a newer bid or checkpoint.
      const old = await store.getRoom(code); const current = await store.getRoom(code);
      current.recoveryNotice = 'Test checkpoint'; await store.saveRoom(current);
      await assert.rejects(store.saveRoom(old), error => error.code === 'ROOM_CONFLICT');
      const ttl = await store.client.pTTL(prefix + code);
      assert.ok(ttl > 14390000 && ttl <= 14400000);
      await action(recoveredHost, 'host_toggle_pause', { isPaused: false });
      recoveredHost.disconnect();
      await delay(2300);
      assert.equal((await store.getRoom(code)).isPaused, true, 'host grace expiry pauses live bidding');
    });
    await t.test('disconnect grace removes lobby guests, retains host; health and private routes', async () => {
      const host = await client(); const guest = await client(); const lobbyCode = 'LOBBY1234567';
      await request(host, 'create_room', auth(lobbyCode, 'Lobby host', token()));
      await request(guest, 'join_room', auth(lobbyCode, 'Lobby guest', token()));
      guest.disconnect(); host.disconnect();
      await delay(2300);
      const lobby = await store.getRoom(lobbyCode); assert.equal(lobby.teams.length, 1); assert.equal(lobby.teams[0].isHost, true);
      const health = await fetch('http://127.0.0.1:' + port + '/health').then(r => r.json());
      assert.equal(health.status, 'ok'); assert.equal(health.commit, 'integration-test');
      for (const resource of ['server.js', '.env', 'data/players.json', 'package.json', 'roomStore.js']) {
        assert.equal((await fetch('http://127.0.0.1:' + port + '/' + resource)).status, 404, resource);
      }
      assert.equal((await fetch('http://127.0.0.1:' + port + '/socket.io/?EIO=4&transport=polling', { headers: { Origin: 'https://not-allowed.example' } })).status, 403);
    });
    await t.test('auth flood limits do not block other clients sharing a proxy address', async () => {
      const noisy = await client();
      const payload = auth('MISSING12345', 'Unknown club', token());
      for (let i = 0; i < 30; i++) assert.equal((await request(noisy, 'join_room', payload)).error, 'ROOM_NOT_FOUND');
      assert.equal((await request(noisy, 'join_room', payload)).error, 'RATE_LIMITED');
      const independent = await client('polling');
      assert.equal((await request(independent, 'join_room', payload)).error, 'ROOM_NOT_FOUND');
    });
    await t.test('expired and explicitly closed rooms release sockets for another lobby', async () => {
      const host = await client(); const expiringCode = 'EXPIRED12345';
      const input = auth(expiringCode, 'Expiry host', token());
      await request(host, 'create_room', input);
      const room = await store.getRoom(expiringCode); room.expiresAt = Date.now() + 100;
      const closed = once(host, 'room_closed'); await store.saveRoom(room); await closed;
      assert.equal(host.connected, true);
      const nextCode = 'ANOTHER12345';
      assert.equal((await request(host, 'create_room', auth(nextCode, 'Next host', token()))).ok, true);
      const reply = await request(host, 'host_close_room', { roomCode: nextCode, requestId: crypto.randomUUID() });
      assert.equal(reply.ok, true); assert.equal(await store.getRoom(nextCode), null);
      assert.equal((await request(host, 'create_room', auth('FINALROOM123', 'Final host', token()))).ok, true);
    });
  } finally {
    clients.forEach(socket => socket.disconnect());
    await stop();
    for (const code of await store.listActiveRooms()) { const room = await store.getRoom(code); if (room) await store.deleteRoom(room); }
    store.close();
  }
});
