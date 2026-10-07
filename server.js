'use strict';
const express = require('express');
const http = require('node:http');
const path = require('node:path');
const crypto = require('node:crypto');
const { Server } = require('socket.io');
const { RoomStore, MemoryRoomStore } = require('./roomStore');
const { loadConfig } = require('./config');
const { loadGameData } = require('./gameData');
const game = require('./auctionEngine');

async function createApplication({ config = loadConfig(), data = loadGameData(undefined, { allowMissing: true }), store = (config.redisUrl ? new RoomStore(config.redisUrl) : new MemoryRoomStore()) } = {}) {
  await store.connect();
  const instanceId = crypto.randomUUID();
  const app = express();
  app.disable('x-powered-by');
  const server = http.createServer(app);
  const originAllowed = origin => !origin || config.allowedOrigins.includes(origin);
  const io = new Server(server, {
    cors: { origin: (origin, callback) => callback(null, originAllowed(origin)), methods: ['GET', 'POST'] },
    allowRequest: (req, callback) => callback(null, originAllowed(req.headers.origin)),
    transports: ['polling', 'websocket'], maxHttpBufferSize: 8192
  });
  const activeCodes = new Set();
  const queues = new Map();
  const attempts = new Map();
  let stopping = false;
  let recovering = false;
  let storageInterrupted = false;

  function serial(code, operation) {
    const previous = queues.get(code) || Promise.resolve();
    const next = previous.catch(() => {}).then(operation);
    queues.set(code, next);
    return next.finally(() => { if (queues.get(code) === next) queues.delete(code); });
  }
  function broadcast(room, effect) {
    const snapshot = game.sanitizeRoom(room);
    if (effect && effect.event !== 'room_state_updated') io.to(room.code).emit(effect.event, { room: snapshot, log: effect.log, result: effect.result });
    else io.to(room.code).emit('room_state_updated', snapshot);
    return snapshot;
  }
  async function ownedRoom(code) {
    const room = await store.getRoom(code);
    if (!room) { activeCodes.delete(code); game.fail('ROOM_NOT_FOUND', 'Room not found or expired. Check the code or create a new room.'); }
    if (room.instanceId !== instanceId) {
      activeCodes.delete(code);
      io.to(code).emit('server_restarting');
      io.in(code).disconnectSockets(true);
      game.fail('SERVER_RESTARTING', 'The server is restarting. Reconnecting…');
    }
    return room;
  }
  function touch(room) { room.expiresAt = Date.now() + config.ttlSeconds * 1000; }
  function member(socket, room) {
    const team = room.teams.find(t => t.id === socket.data.teamId);
    if (socket.data.roomCode !== room.code || !team || team.connectionId !== socket.id || !team.connected) game.fail('NOT_A_MEMBER', 'Reconnect to your club before taking an action.');
    return team;
  }
  function host(room, team) {
    if (room.hostTeamId !== team.id) game.fail('HOST_ONLY', 'Only the host can do that.');
  }
  function takeRateLimit(socket, auth = false) {
    const now = Date.now();
    // Render proxies share remote addresses. Bound each connection's auth traffic
    // and each club's actions without trusting arbitrary forwarded-IP headers.
    const key = auth ? 'auth:' + socket.id : 'action:' + (socket.data.teamId || socket.id);
    const windowMs = auth ? 60000 : 1000;
    const limit = auth ? 30 : 40;
    let entry = attempts.get(key);
    if (!entry || entry.until <= now) { entry = { count: 0, until: now + windowMs }; attempts.set(key, entry); }
    if (++entry.count > limit) game.fail('RATE_LIMITED', 'Too many requests. Please wait a moment and retry.');
  }
  async function bind(socket, room, team, isNew = false) {
    const previousId = team.connectionId;
    team.connected = true; team.disconnectedAt = null; team.connectionId = socket.id;
    touch(room);
    if (isNew) {
      if (!await store.createRoom(room)) game.fail('ROOM_EXISTS', 'A room already uses that code.');
    } else await store.saveRoom(room);
    activeCodes.add(room.code);
    socket.data.roomCode = room.code; socket.data.teamId = team.id;
    if (previousId && previousId !== socket.id) {
      const old = io.sockets.sockets.get(previousId);
      if (old) { old.emit('session_replaced'); old.leave(room.code); old.disconnect(true); }
    }
    await socket.join(room.code);
    if (!socket.connected) {
      team.connected = false; team.disconnectedAt = Date.now(); team.connectionId = null;
      await store.saveRoom(room);
    }
    return { room: broadcast(room), myTeamId: team.id };
  }
  async function recoverRooms() {
    recovering = true;
    try {
      for (const code of await store.listActiveRooms()) {
        await serial(code, async () => {
          const room = await store.getRoom(code);
          if (!room) return;
          room.instanceId = instanceId;
          for (const team of room.teams) {
            team.connected = false; team.connectionId = null; team.disconnectedAt = Date.now();
          }
          if (room.status === 'LIVE') {
            // Freeze at the last durable checkpoint; never fast-forward sales during downtime.
            room.isPaused = true; room.timerEndsAt = null;
            room.remainingMs = Math.max(1000, room.remainingMs);
            room.recoveryNotice = 'Auction recovered after a server interruption. The host can resume when clubs are ready.';
          }
          await store.saveRoom(room);
          activeCodes.add(code);
        });
      }
      storageInterrupted = false;
    } finally { recovering = false; }
  }
  try { await recoverRooms(); } catch (error) { store.close(); throw error; }
  store.client.on('error', () => { storageInterrupted = true; });

  app.get('/health', async (_req, res) => {
    let timeout;
    let healthy = store.isReady() && !recovering && !storageInterrupted && !stopping;
    if (healthy) {
      try { await Promise.race([store.ping(), new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('timeout')), 2000); })]); }
      catch { healthy = false; }
      finally { clearTimeout(timeout); }
    }
    res.set('Cache-Control', 'no-store').status(healthy ? 200 : 503).json({ status: healthy ? 'ok' : 'unavailable', service: 'UFA',
      playersLoaded: data.players.length > 0, managersLoaded: data.managers.length > 0,
      playersCount: data.players.length, managersCount: data.managers.length, persistence: healthy ? 'ready' : 'unavailable', commit: config.commit });
  });
  // Never expose backend source, datasets, dependencies or environment files as static content.
  const publicFiles = ['index.html', 'auction.html', 'style.css', 'landing.css', 'script.js', 'client-config.js',
    'ads.txt', 'robots.txt', 'sitemap.xml', 'googledc6736ad8657eb49.html', '4af66e87-0e4c-42ad-8195-5af103e2c8ac.png'];
  app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));
  app.get('/auction', (_req, res) => res.sendFile(path.join(__dirname, 'auction.html')));
  for (const file of publicFiles) app.get('/' + file, (_req, res) => {
    if (file.endsWith('.js') || file.endsWith('.html')) res.set('Cache-Control', 'no-cache');
    res.sendFile(path.join(__dirname, file));
  });
  app.use('/assets', express.static(path.join(__dirname, 'assets'), { dotfiles: 'deny', index: false }));

  io.on('connection', socket => {
    let socketQueue = Promise.resolve();
    function request(event, operation, auth = false) {
      socket.on(event, (payload, ack) => {
        const work = async () => {
          try {
            if (stopping || recovering || storageInterrupted || !store.isReady()) game.fail('SERVER_UNAVAILABLE', 'Server storage is unavailable. Please retry shortly.');
            game.payloadObject(payload);
            takeRateLimit(socket, auth);
            const value = await operation(payload);
            if (typeof ack === 'function') ack({ ok: true, ...value });
          } catch (error) {
            const code = error.public || error.code === 'ROOM_CONFLICT' ? error.code : 'SERVER_UNAVAILABLE';
            const message = error.public || error.code === 'ROOM_CONFLICT' ? error.message : 'The server could not save this action. Please retry shortly.';
            if (!error.public && error.code !== 'ROOM_CONFLICT') console.error(`Socket ${event} failed (${error.code || 'storage error'}).`);
            const response = { ok: false, error: code, message };
            if (typeof ack === 'function') ack(response); else socket.emit('error_msg', response);
          }
        };
        socketQueue = socketQueue.then(work, work);
      });
    }
    async function enroll(input, create) {
      const code = game.roomCode(input.roomCode);
      game.password(input.password);
      const hash = game.tokenHash(input.sessionToken);
      return serial(code, async () => {
        if (socket.data.roomCode && socket.data.roomCode !== code) game.fail('ALREADY_JOINED', 'This connection already belongs to another room.');
        let room = await store.getRoom(code);
        if (!room) {
          if (!create) game.fail('ROOM_NOT_FOUND', 'Room not found. Check the room code.');
          room = game.createRoom(input, config, instanceId);
          return bind(socket, room, room.teams[0], true);
        }
        room = await ownedRoom(code);
        if (!game.passwordMatches(input.password, room)) game.fail('WRONG_PASSWORD', 'Incorrect room password.');
        const existing = room.teams.find(t => t.sessionHash === hash);
        if (existing) return bind(socket, room, existing);
        if (socket.data.teamId) game.fail('ALREADY_JOINED', 'This connection already has a club.');
        if (create) game.fail('ROOM_EXISTS', 'A room already uses that code.');
        if (room.status !== 'LOBBY') game.fail('AUCTION_STARTED', 'The auction has already started. Resume your existing club to return.');
        if (room.teams.length >= room.maxTeams) game.fail('ROOM_FULL', `Room full (maximum ${room.maxTeams} clubs).`);
        const name = game.teamName(input.teamName);
        if (room.teams.some(t => t.name.toLowerCase() === name.toLowerCase())) game.fail('CLUB_EXISTS', 'That club is already in this room. Resume its original browser session or choose another name.');
        const team = game.newTeam(name, room.budget, hash);
        room.teams.push(team);
        return bind(socket, room, team);
      });
    }
    request('create_room', input => enroll(input, true), true);
    request('join_room', input => enroll(input, false), true);
    request('resume_session', input => {
      const code = game.roomCode(input.roomCode);
      const hash = game.tokenHash(input.sessionToken);
      return serial(code, async () => {
        const room = await ownedRoom(code);
        const team = room.teams.find(t => t.sessionHash === hash && (!input.teamId || t.id === input.teamId));
        if (!team) game.fail('SESSION_EXPIRED', 'This club session expired or was removed. Join the lobby again.');
        if (socket.data.roomCode && socket.data.roomCode !== code) game.fail('ALREADY_JOINED', 'This connection already belongs to another room.');
        return bind(socket, room, team);
      });
    }, true);

    for (const event of ['start_auction', 'raise_bid', 'pass_bid', 'host_toggle_pause', 'host_kick_player', 'host_close_room']) {
      request(event, input => serial(game.roomCode(input.roomCode), async () => {
        const room = await ownedRoom(game.roomCode(input.roomCode));
        const team = member(socket, room);
        if (typeof input.requestId !== 'string' || !/^[a-f0-9-]{36}$/.test(input.requestId)) game.fail('INVALID_REQUEST', 'A valid request ID is required.');
        if (team.receipts.includes(input.requestId)) return { room: game.sanitizeRoom(room) };
        const now = Date.now();
        let effect;
        let kicked;
        if (event === 'raise_bid' || event === 'pass_bid') {
          if (room.status !== 'LIVE' || room.phase !== 'BIDDING' || room.isPaused) game.fail('BIDDING_CLOSED', 'Bidding is paused or the next lot is being revealed.');
          if (input.lotIndex !== room.currentIndex || game.remaining(room, now) <= 0) game.fail('LOT_CHANGED', 'That lot has ended. Wait for the next card.');
          effect = event === 'raise_bid' ? game.bid(room, team, now) : game.pass(room, team, now);
        } else {
          host(room, team);
          if (event === 'start_auction') {
            if (!data.players.length || !data.managers.length) game.fail('DATA_UNAVAILABLE', 'Auction player data is not installed yet. Create/Join works, but the auction cannot start until the real datasets are restored.');
            game.startAuction(room, data, now);
          }
          if (event === 'host_toggle_pause') game.setPaused(room, input.isPaused, now);
          if (event === 'host_close_room') {
            await store.deleteRoom(room);
            activeCodes.delete(room.code);
            io.to(room.code).emit('room_closed');
            for (const peer of io.sockets.sockets.values()) if (peer.data.roomCode === room.code) peer.data = {};
            io.in(room.code).socketsLeave(room.code);
            return {};
          }
          if (event === 'host_kick_player') {
            if (room.status !== 'LOBBY') game.fail('LOBBY_ONLY', 'Clubs can only be removed before the auction starts, to protect bids and squads.');
            if (typeof input.targetTeamId !== 'string' || input.targetTeamId.length > 36) game.fail('INVALID_INPUT', 'Invalid club ID.');
            kicked = room.teams.find(t => t.id === input.targetTeamId);
            if (!kicked || kicked.isHost) game.fail('INVALID_TARGET', 'Choose a non-host club in this lobby.');
            room.teams = room.teams.filter(t => t.id !== kicked.id);
          }
        }
        team.receipts = [...team.receipts.slice(-31), input.requestId];
        touch(room);
        await store.saveRoom(room);
        if (kicked && kicked.connectionId) {
          const target = io.sockets.sockets.get(kicked.connectionId);
          if (target) { target.emit('you_were_kicked'); target.leave(room.code); target.data = {}; }
        }
        return { room: broadcast(room, effect) };
      }));
    }
    socket.on('disconnect', () => {
      const code = socket.data.roomCode;
      if (!code || stopping) return;
      serial(code, async () => {
        const room = await store.getRoom(code);
        if (!room || room.instanceId !== instanceId) return;
        const team = room.teams.find(t => t.connectionId === socket.id);
        if (!team) return;
        team.connected = false; team.disconnectedAt = Date.now(); team.connectionId = null;
        if (room.status === 'LIVE' && !room.teams.some(t => t.connected)) game.setPaused(room, true, Date.now());
        await store.saveRoom(room);
        broadcast(room);
      }).catch(() => { storageInterrupted = true; });
    });
  });

  let ticking = false;
  const ticker = setInterval(async () => {
    if (ticking || stopping || recovering || !store.isReady()) return;
    ticking = true;
    try {
      if (storageInterrupted) {
        io.emit('server_restarting'); io.disconnectSockets(true);
        await recoverRooms();
      }
      for (const code of activeCodes) await serial(code, async () => {
        const room = await store.getRoom(code);
        if (!room || room.instanceId !== instanceId) {
          activeCodes.delete(code);
          io.to(code).emit(room ? 'server_restarting' : 'room_closed');
          if (room) io.in(code).disconnectSockets(true);
          else {
            for (const peer of io.sockets.sockets.values()) if (peer.data.roomCode === code) peer.data = {};
            io.in(code).socketsLeave(code);
          }
          return;
        }
        const now = Date.now();
        let changed = false;
        if (room.status === 'LOBBY') {
          const before = room.teams.length;
          room.teams = room.teams.filter(t => t.isHost || t.connected || !t.disconnectedAt || now - t.disconnectedAt < config.graceMs);
          changed = before !== room.teams.length;
        }
        const hostTeam = room.teams.find(t => t.id === room.hostTeamId);
        if (room.status === 'LIVE' && !room.isPaused && hostTeam && !hostTeam.connected && hostTeam.disconnectedAt && now - hostTeam.disconnectedAt >= config.graceMs) {
          game.setPaused(room, true, now);
          room.recoveryNotice = 'Host disconnected. The host can resume after reconnecting.';
          changed = true;
        }
        const effect = game.tick(room, now);
        if (changed || (room.status === 'LIVE' && !room.isPaused) || effect) {
          await store.saveRoom(room);
          if (changed || effect) broadcast(room, effect);
          const publicRoom = game.sanitizeRoom(room);
          io.to(code).emit('clock_state', { version: room.version, phase: room.phase, isPaused: room.isPaused,
            timer: publicRoom.timer, interstitialTimer: publicRoom.interstitialTimer, phaseBreakTimer: publicRoom.phaseBreakTimer });
        }
      });
      for (const [key, value] of attempts) if (value.until < Date.now()) attempts.delete(key);
    } catch (error) {
      if (error.code !== 'ROOM_CONFLICT') { storageInterrupted = true; console.error('Auction clock could not save state; recovery will pause affected rooms.'); }
    } finally { ticking = false; }
  }, 1000);
  ticker.unref();
  async function close() {
    stopping = true; clearInterval(ticker);
    await Promise.allSettled([...queues.values()]);
    await new Promise(resolve => io.close(resolve));
    store.close();
  }
  return { app, server, io, close, store };
}

async function main() {
  const data = loadGameData(undefined, { allowMissing: true });
  const config = loadConfig();
  const application = await createApplication({ config, data });
  application.server.listen(config.port, '0.0.0.0', () => {
    console.log(`UFA listening on ${config.port}; room store ${config.redisUrl ? 'Redis' : 'memory fallback'}; room TTL ${config.ttlSeconds}s; commit ${config.commit}`);
    console.log(`Allowed origins: ${config.allowedOrigins.join(', ')}`);
  });
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => {
    application.close().then(() => process.exit(0));
    setTimeout(() => process.exit(1), 10000).unref();
  });
}
if (require.main === module) main().catch(error => { console.error(`UFA startup failed: ${error.message}`); process.exitCode = 1; });
module.exports = { createApplication };
