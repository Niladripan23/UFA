'use strict';
const crypto = require('node:crypto');

const QUOTAS = { manager: 1, midfielder: 3, forward: 4, goalkeeper: 1, defender: 3 };
const CATEGORIES = ['mixed', 'icons', 'hearts', 'young gen', 'normal'];
function fail(code, message) { throw Object.assign(new Error(message), { code, public: true }); }
function payloadObject(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) fail('INVALID_INPUT', 'Expected a request object.');
  return payload;
}
function roomCode(value) {
  if (typeof value !== 'string' || value.length > 64) fail('INVALID_CODE', 'Room code must be 12 alphanumeric characters.');
  const code = value.trim().toUpperCase();
  if (!/^[A-Z0-9]{12}$/.test(code)) fail('INVALID_CODE', 'Room code must be 12 alphanumeric characters.');
  return code;
}
function password(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9]{8}$/.test(value)) fail('INVALID_PASSWORD', 'Password must be exactly 8 alphanumeric characters (case-sensitive).');
  return value;
}
function teamName(value) {
  if (typeof value !== 'string' || value.length > 100) fail('INVALID_NAME', 'Club name must be 1–24 characters.');
  const name = value.trim();
  if (!name || name.length > 24 || /[\u0000-\u001f\u007f]/.test(name)) fail('INVALID_NAME', 'Club name must be 1–24 printable characters.');
  return name;
}
function tokenHash(token) {
  if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) fail('INVALID_SESSION', 'Session credentials are invalid.');
  return crypto.createHash('sha256').update(token).digest('hex');
}
function passwordHash(value, salt) { return crypto.scryptSync(value, salt, 32).toString('hex'); }
function passwordMatches(value, room) {
  return crypto.timingSafeEqual(Buffer.from(passwordHash(value, room.passwordSalt), 'hex'), Buffer.from(room.passwordHash, 'hex'));
}
function newTeam(name, budget, hash, host = false) {
  return { id: crypto.randomUUID(), name, purse: budget, manager: null, squad: [], isHost: host,
    sessionHash: hash, connected: false, disconnectedAt: null, connectionId: null, receipts: [] };
}
function createRoom(input, config, instanceId, now = Date.now()) {
  const code = roomCode(input.roomCode);
  const pass = password(input.password);
  const name = teamName(input.adminTeamName);
  if (![4, 5, 6].includes(input.maxTeams)) fail('INVALID_CAPACITY', 'Choose 4, 5 or 6 clubs.');
  if (![300, 500, 750, 1000].includes(input.startingBudget)) fail('INVALID_BUDGET', 'Choose a budget of 300, 500, 750 or 1000 coins.');
  if (!CATEGORIES.includes(input.categoryFilter)) fail('INVALID_CATEGORY', 'Choose a supported player category.');
  const host = newTeam(name, input.startingBudget, tokenHash(input.sessionToken), true);
  const salt = crypto.randomBytes(16).toString('hex');
  return { code, passwordSalt: salt, passwordHash: passwordHash(pass, salt), hostTeamId: host.id,
    budget: input.startingBudget, maxTeams: input.maxTeams, categoryFilter: input.categoryFilter,
    instanceId, teams: [host], pool: [], currentIndex: 0, currentBid: 0, highestBidderId: null,
    passedTeamIds: [], status: 'LOBBY', phase: 'LOBBY', isPaused: false, timerEndsAt: null,
    remainingMs: 12000, transitionMs: 0, recoveryNotice: null, lastResult: null,
    expiresAt: now + config.ttlSeconds * 1000 };
}
function shuffle(list) {
  const result = [...list];
  for (let i = result.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}
function startAuction(room, data, now) {
  if (room.status !== 'LOBBY') fail('ALREADY_STARTED', 'The auction has already started.');
  const n = room.teams.length;
  const players = room.categoryFilter === 'mixed' ? data.players : data.players.filter(p => p.category.toLowerCase().trim() === room.categoryFilter);
  const groups = [data.managers, ...['midfielder', 'forward', 'goalkeeper', 'defender'].map(role => players.filter(p => p.primaryRole === role))];
  if (groups.some(group => !group.length)) fail('POOL_INCOMPLETE', 'This category is missing a required player position. Check the real game dataset.');
  const counts = [n + 2, 3 * n + 5, 4 * n + 5, n + 2, 3 * n + 3];
  room.pool = groups.flatMap((group, i) => shuffle(group).slice(0, counts[i]));
  room.status = 'LIVE'; room.currentIndex = 0;
  room.currentBid = room.pool[0].baseprice;
  room.highestBidderId = null; room.passedTeamIds = [];
  setClock(room, 'BIDDING', 12000, now);
}
function setClock(room, phase, ms, now) {
  room.phase = phase; room.remainingMs = ms; room.timerEndsAt = room.isPaused ? null : now + ms;
}
function remaining(room, now = Date.now()) {
  return room.isPaused || !room.timerEndsAt ? room.remainingMs : Math.max(0, room.timerEndsAt - now);
}
function setPaused(room, paused, now) {
  if (room.status !== 'LIVE') fail('NOT_LIVE', 'The auction is not live.');
  if (typeof paused !== 'boolean') fail('INVALID_INPUT', 'Pause state must be true or false.');
  room.remainingMs = remaining(room, now);
  room.isPaused = paused;
  room.timerEndsAt = paused ? null : now + room.remainingMs;
  if (!paused) room.recoveryNotice = null;
}
function concludeLot(room, now) {
  if (room.status !== 'LIVE' || room.phase !== 'BIDDING') return null;
  const item = room.pool[room.currentIndex];
  const winner = room.teams.find(t => t.id === room.highestBidderId);
  const result = { item, winner: winner ? { id: winner.id, name: winner.name } : null, price: room.currentBid, lotIndex: room.currentIndex };
  let log;
  if (winner) {
    winner.purse -= room.currentBid;
    if (item.primaryRole === 'manager') winner.manager = item.name;
    else winner.squad.push({ ...item, boughtFor: room.currentBid });
    log = `${item.primaryRole === 'manager' ? 'APPOINTED' : 'SOLD'}: ${item.name} to ${winner.name} for ${room.currentBid} Coins!`;
  } else log = `UNSOLD: No bids for ${item.name}.`;
  room.lastResult = result;
  room.currentIndex++;
  room.highestBidderId = null; room.passedTeamIds = [];
  if (room.currentIndex >= room.pool.length) {
    room.status = 'FINISHED'; room.phase = 'FINISHED'; room.timerEndsAt = null; room.remainingMs = 0;
    return { event: 'auction_finished', log, result };
  }
  const next = room.pool[room.currentIndex];
  const phaseBreak = (item.primaryRole === 'manager' && next.primaryRole === 'midfielder') || (item.primaryRole === 'midfielder' && next.primaryRole === 'forward');
  room.currentBid = next.baseprice;
  // The existing five-second phase ad and three-second reveal share a transition.
  // Bidding starts only after both finish, equally for every connected client.
  room.transitionMs = phaseBreak ? 5000 : 3000;
  setClock(room, 'INTERSTITIAL', room.transitionMs, now);
  return { event: 'lot_concluded', log, result };
}
function tick(room, now) {
  if (room.status !== 'LIVE' || room.isPaused) return null;
  room.remainingMs = remaining(room, now);
  if (room.remainingMs > 0) return null;
  if (room.phase === 'BIDDING') return concludeLot(room, now);
  setClock(room, 'BIDDING', 12000, now);
  return { event: 'room_state_updated' };
}
function bid(room, team, now) {
  const item = room.pool[room.currentIndex];
  const count = item.primaryRole === 'manager' ? Number(Boolean(team.manager)) : team.squad.filter(p => p.primaryRole === item.primaryRole).length;
  if (count >= QUOTAS[item.primaryRole]) fail('QUOTA_REACHED', `Club limit reached: ${QUOTAS[item.primaryRole]} ${item.primaryRole}(s).`);
  if (room.highestBidderId === team.id) fail('ALREADY_LEADING', 'You already hold the highest bid.');
  const increment = room.currentBid < 50 ? 2 : room.currentBid <= 100 ? 5 : 10;
  const next = room.highestBidderId ? room.currentBid + increment : item.baseprice;
  if (team.purse < next) fail('INSUFFICIENT_COINS', 'Insufficient coins for this bid.');
  room.currentBid = next; room.highestBidderId = team.id; room.passedTeamIds = [];
  setClock(room, 'BIDDING', 12000, now);
  return { event: 'bid_placed', log: `${team.name} bids ${next} Coins!` };
}
function pass(room, team, now) {
  if (room.highestBidderId === team.id) fail('HIGHEST_BIDDER', 'The highest bidder cannot pass.');
  if (room.passedTeamIds.includes(team.id)) return null;
  room.passedTeamIds.push(team.id);
  if (room.passedTeamIds.length >= room.teams.length - Number(Boolean(room.highestBidderId))) return concludeLot(room, now);
  return { event: 'bid_placed', log: `${team.name} passed.` };
}
function publicTeam(team) {
  return { id: team.id, name: team.name, purse: team.purse, manager: team.manager, squad: team.squad,
    isHost: team.isHost, connected: team.connected };
}
function sanitizeRoom(room, now = Date.now()) {
  const ms = remaining(room, now);
  const leader = room.teams.find(t => t.id === room.highestBidderId);
  return { code: room.code, version: room.version, hostTeamId: room.hostTeamId, budget: room.budget,
    maxTeams: room.maxTeams, categoryFilter: room.categoryFilter, teams: room.teams.map(publicTeam),
    pool: room.pool, currentIndex: room.currentIndex, currentBid: room.currentBid,
    highestBidder: leader ? { id: leader.id, name: leader.name } : null, passedTeamIds: room.passedTeamIds,
    status: room.status, phase: room.phase, isPaused: room.isPaused, timerEndsAt: room.timerEndsAt,
    timer: Math.ceil(ms / 1000), interstitialTimer: room.phase === 'INTERSTITIAL' ? Math.max(0, Math.ceil((ms - (room.transitionMs - 3000)) / 1000)) : 0,
    phaseBreakTimer: room.phase === 'INTERSTITIAL' && room.transitionMs === 5000 ? Math.ceil(ms / 1000) : 0,
    recoveryNotice: room.recoveryNotice, lastResult: room.lastResult };
}

module.exports = { fail, payloadObject, roomCode, password, teamName, tokenHash, passwordMatches,
  newTeam, createRoom, startAuction, remaining, setPaused, tick, bid, pass, sanitizeRoom };
