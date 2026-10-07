// ====================================================
// UFA — CLIENT ENGINE (Optimized 3-2-1, Phase Ads & Fixed Stage)
// ====================================================

const socket = io(window.UFA_CONFIG.backendUrl, {
  reconnection: true,
  reconnectionAttempts: Infinity,
  reconnectionDelayMax: 5000,
  timeout: 20000,
  transports: ['polling', 'websocket']
});

const SESSION_KEY = 'ufa-session-v1:' + window.UFA_CONFIG.backendUrl;
let session = null;
try { session = JSON.parse(sessionStorage.getItem(SESSION_KEY)); } catch {}
let sessionReady = false;
let authPending = false;
let actionPending = false;
let resumeTimer = null;

function saveSession(value) {
  session = value;
  try {
    if (value) sessionStorage.setItem(SESSION_KEY, JSON.stringify(value));
    else sessionStorage.removeItem(SESSION_KEY);
  } catch { showMessage('Browser storage is blocked. Keep this tab open to retain your club session.'); }
}
function showMessage(message = '') {
  for (const id of ['auth-error', 'network-message']) {
    const el = document.getElementById(id);
    el.textContent = message;
    el.hidden = !message || (id === 'network-message' && !currentRoom);
  }
}
function updateConnection(label) {
  document.getElementById('connection-status').textContent = label;
  document.getElementById('live-dot').style.background = socket.connected && sessionReady ? 'var(--accent-green)' : 'var(--accent-amber)';
  if (!socket.connected || !sessionReady) document.getElementById('phase-indicator').textContent = label;
  updateControls();
}
function updateControls() {
  document.getElementById('auth-submit-btn').disabled = !socket.connected || authPending || Boolean(session && !sessionReady);
  const unavailable = !socket.connected || !sessionReady || actionPending;
  for (const id of ['host-start-btn', 'lobby-start-btn', 'host-pause-btn', 'host-close-btn']) document.getElementById(id).disabled = unavailable;
  for (const id of ['btn-raise-bid', 'btn-pass']) document.getElementById(id).disabled = unavailable || !currentRoom || currentRoom.status !== 'LIVE' || currentRoom.phase !== 'BIDDING' || currentRoom.isPaused;
}
function request(event, payload) {
  return new Promise(resolve => {
    if (!socket.connected) return resolve({ ok: false, error: 'DISCONNECTED', message: 'Reconnecting to the server. Please wait.' });
    socket.timeout(12000).emit(event, payload, (error, response) => resolve(error
      ? { ok: false, error: 'TIMEOUT', message: 'The server did not respond. Your session is saved; reconnecting will recover a completed request.' }
      : response || { ok: false, error: 'SERVER_UNAVAILABLE', message: 'Server unavailable. Please retry.' }));
  });
}
function newSessionToken() {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, '0')).join('');
}
async function resumeSession() {
  if (!socket.connected || !session || authPending) return;
  authPending = true; updateConnection('Restoring your club…');
  const result = await request('resume_session', session);
  authPending = false;
  if (result.ok) acceptSession(result);
  else if (['ROOM_NOT_FOUND', 'SESSION_EXPIRED', 'INVALID_SESSION', 'INVALID_CODE'].includes(result.error)) {
    saveSession(null); currentRoom = null; myTeamId = null; sessionReady = false;
    document.getElementById('room-auth-modal').classList.add('active');
    updateConnection('Connected'); showMessage(result.message);
  } else {
    showMessage(result.message); updateConnection('Reconnecting…');
    clearTimeout(resumeTimer); resumeTimer = setTimeout(resumeSession, result.error === 'RATE_LIMITED' ? 15000 : 5000);
  }
}
async function sendAction(event, extra = {}) {
  if (!currentRoom || actionPending || !sessionReady || !socket.connected) return;
  actionPending = true; updateControls();
  const result = await request(event, { roomCode: currentRoom.code, requestId: crypto.randomUUID(), lotIndex: currentRoom.currentIndex, ...extra });
  actionPending = false;
  if (!result.ok) showMessage(result.message);
  else { if (result.room) acceptRoom(result.room); showMessage(currentRoom?.recoveryNotice || ''); }
  updateControls();
}

let currentRoom = null;
let myTeamId = null;
let currentAuthMode = 'create';

// The server clock controls phase ads as well as bidding.
let isShowingPhaseBreak = false;
let lotResultTimer = null;

const DEFAULT_BOT_DP = "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100' fill='%2394a3b8'><circle cx='50' cy='50' r='50' fill='%23f1f5f9'/><path d='M50 46a16 16 0 1 0 0-32 16 16 0 0 0 0 32zm0 8c-18.7 0-35 11.7-35 28v2h70v-2c0-16.3-16.3-28-35-28z'/></svg>";

const ROOM_CODE_REGEX = /^[a-zA-Z0-9]{12}$/;
const PASSWORD_REGEX = /^[a-zA-Z0-9]{8}$/;

// --- 1. AUTH & CONFIG ---
function toggleAuthTab(mode) {
  currentAuthMode = mode;
  const createBtn = document.getElementById('tab-create-btn');
  const joinBtn = document.getElementById('tab-join-btn');
  const hostSettings = document.getElementById('host-settings-section');
  const submitBtn = document.getElementById('auth-submit-btn');
  const genBtn = document.getElementById('btn-gen-code');

  if (mode === 'create') {
    createBtn.classList.add('active');
    joinBtn.classList.remove('active');
    hostSettings.style.display = 'block';
    genBtn.style.display = 'inline-block';
    submitBtn.textContent = 'Create & Host Room';
  } else {
    joinBtn.classList.add('active');
    createBtn.classList.remove('active');
    hostSettings.style.display = 'none';
    genBtn.style.display = 'none';
    submitBtn.textContent = 'Join Room';
  }
}

function updateCharCount(inputId, countId, targetLen) {
  const val = document.getElementById(inputId).value;
  const counter = document.getElementById(countId);
  counter.textContent = `${val.length}/${targetLen}`;
  if (val.length === targetLen) {
    counter.classList.add('valid');
  } else {
    counter.classList.remove('valid');
  }
}

function generateRandomString(length) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

function autoGenerateCredentials() {
  const code = generateRandomString(12);
  const pass = generateRandomString(8);

  document.getElementById('inp-room-code').value = code;
  document.getElementById('inp-room-pass').value = pass;

  updateCharCount('inp-room-code', 'code-count', 12);
  updateCharCount('inp-room-pass', 'pass-count', 8);
}

async function handleAuthSubmit() {
  if (authPending || !socket.connected) return;
  const roomCode = document.getElementById('inp-room-code').value.trim().toUpperCase();
  const password = document.getElementById('inp-room-pass').value;
  const teamName = document.getElementById('inp-team-name').value.trim();
  if (!ROOM_CODE_REGEX.test(roomCode)) return showMessage('Room code must be exactly 12 alphanumeric characters.');
  if (!PASSWORD_REGEX.test(password)) return showMessage('Password must be exactly 8 alphanumeric characters.');
  if (!teamName || teamName.length > 24) return showMessage('Club name must be 1–24 characters.');
  if (!session || session.roomCode !== roomCode) saveSession({ roomCode, teamId: null, sessionToken: newSessionToken() });
  authPending = true; updateControls(); showMessage('');
  const payload = { roomCode, password, teamName, sessionToken: session.sessionToken };
  if (currentAuthMode === 'create') Object.assign(payload, {
    adminTeamName: teamName, maxTeams: Number(document.getElementById('cfg-max-teams').value),
    startingBudget: Number(document.getElementById('cfg-budget').value), categoryFilter: document.getElementById('cfg-category').value
  });
  const result = await request(currentAuthMode === 'create' ? 'create_room' : 'join_room', payload);
  authPending = false;
  if (result.ok) acceptSession(result);
  else {
    showMessage(result.message);
    if (['TIMEOUT', 'DISCONNECTED', 'SERVER_UNAVAILABLE', 'ROOM_CONFLICT'].includes(result.error)) {
      clearTimeout(resumeTimer); resumeTimer = setTimeout(resumeSession, 1500);
    } else saveSession(null);
  }
  updateControls();
}

// --- 2. HOST CONTROLS ---
function handleStartAuction(e) {
  if (e) e.preventDefault();
  if (!currentRoom) return;
  sendAction('start_auction');
}

function handleTogglePause(e) {
  if (e) e.preventDefault();
  if (!currentRoom) return;
  sendAction('host_toggle_pause', { isPaused: !currentRoom.isPaused });
}

function handleCloseRoom(e) {
  if (e) e.preventDefault();
  if (!currentRoom) return;
  if (confirm("Are you sure you want to shut down this auction room? All players will be disconnected.")) {
    sendAction('host_close_room');
  }
}

function handleKickTeam(teamId) {
  if (!currentRoom) return;
  if (confirm("Kick this club from the auction floor?")) {
    sendAction('host_kick_player', { targetTeamId: teamId });
  }
}

// --- 3. BIDDING EMISSIONS ---
function emitRaiseBid(e) {
  if (e) e.preventDefault();
  if (!currentRoom || isShowingPhaseBreak) return;
  sendAction('raise_bid');
}

function emitPassBid(e) {
  if (e) e.preventDefault();
  if (!currentRoom || isShowingPhaseBreak) return;
  sendAction('pass_bid');
}

function showLotResult(roomSnapshot) {
  if (!roomSnapshot) return;

  const overlay = document.getElementById('lot-result-overlay');
  const kicker = document.getElementById('lot-result-kicker');
  const player = document.getElementById('lot-result-player');
  const detail = document.getElementById('lot-result-detail');

  if (!overlay || !kicker || !player || !detail) return;

  const item = roomSnapshot.pool && roomSnapshot.pool[roomSnapshot.currentIndex];
  if (!item) return;

  const winner = roomSnapshot.highestBidder;
  const isManager = item.primaryRole === 'manager';

  if (lotResultTimer) {
    clearTimeout(lotResultTimer);
    lotResultTimer = null;
  }

  overlay.classList.remove('active', 'is-sold', 'is-unsold');

  if (winner) {
    kicker.textContent = isManager ? 'APPOINTED' : 'SOLD';
    player.textContent = item.name;
    detail.textContent = `${winner.name} • ${roomSnapshot.currentBid} Coins`;
    overlay.classList.add('is-sold');
  } else {
    kicker.textContent = 'UNSOLD';
    player.textContent = item.name;
    detail.textContent = 'No bids placed';
    overlay.classList.add('is-unsold');
  }

  // Force a fresh visual state even when lots conclude rapidly.
  void overlay.offsetWidth;
  overlay.classList.add('active');

  lotResultTimer = setTimeout(() => {
    overlay.classList.remove('active');
    lotResultTimer = null;
  }, 700);
}

socket.on('connect', () => {
  sessionReady = !session;
  updateConnection('Connected');
  if (session) resumeSession();
});
socket.on('disconnect', reason => {
  sessionReady = false; actionPending = false;
  updateConnection('Reconnecting…');
  if (currentRoom) showMessage('Connection lost. Your club is saved; reconnecting…');
  if (reason === 'io server disconnect' && session) setTimeout(() => socket.connect(), 1500);
});
socket.io.on('reconnect_attempt', () => updateConnection('Reconnecting…'));
socket.on('connect_error', () => updateConnection('Server unavailable — retrying…'));
socket.on('server_restarting', () => showMessage('Server restarting. Your club will resume automatically.'));
socket.on('session_replaced', () => {
  saveSession(null); sessionReady = false; socket.disconnect();
  showMessage('This club is now open in another tab. Reload to join a different club.');
  updateConnection('Session moved to another tab');
});

function copyLobbyRoomCode() {
  const codeEl = document.getElementById('lobby-room-code');
  if (!codeEl) return;

  const code = codeEl.textContent.trim();
  if (!code || code === '------------') return;

  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(code).catch(() => {});
  }
}

function renderLobbySlots(room) {
  const row = document.getElementById('lobby-slot-row');
  if (!row) return;

  row.replaceChildren();
  row.dataset.capacity = room.maxTeams;

  for (let i = 0; i < room.maxTeams; i++) {
    const team = room.teams[i];
    const slot = document.createElement('div');
    slot.className = 'lobby-club-slot' + (team ? ' is-filled' : '');

    const circle = document.createElement('div');
    circle.className = 'lobby-slot-circle';
    circle.textContent = team ? '✓' : '+';
    if (!team) {
      circle.innerHTML = '<span class="desktop-slot-plus">+</span><svg class="mobile-slot-people" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="7" r="3"/><path d="M6 21v-3a6 6 0 0 1 12 0v3M5 6a3 3 0 0 0 0 6m14-6a3 3 0 0 1 0 6M2 20v-3a4 4 0 0 1 3-4m17 7v-3a4 4 0 0 0-3-4"/></svg>';
    }

    const label = document.createElement('span');
    label.textContent = team ? team.name : `Club ${i + 1}`;

    const status = document.createElement('small');
    status.className = 'mobile-slot-status';
    status.textContent = team ? (team.connected ? 'Connected' : 'Reconnecting…') : 'Waiting…';
    slot.append(circle, label, status);
    row.appendChild(slot);
  }
}

// --- 4. SOCKET EVENT LISTENERS ---
function acceptSession({ room, myTeamId: id }) {
  myTeamId = id;
  saveSession({ roomCode: room.code, teamId: id, sessionToken: session.sessionToken });
  sessionReady = true;
  currentRoom = null;
  document.getElementById('room-auth-modal').classList.remove('active');
  acceptRoom(room);
  updateConnection('Connected');
  showMessage(room.recoveryNotice || '');
  const team = room.teams.find(t => t.id === id);
  logEvent('Joined Room ' + room.code + ' as ' + (team ? team.name : 'Manager'), 'system');
}
function acceptRoom(room) {
  if (!myTeamId || (currentRoom && room.version < currentRoom.version)) return;
  currentRoom = room;
  renderRoomState(room);
  renderClock(room);
  updateControls();
  if (room.recoveryNotice) showMessage(room.recoveryNotice);
  const modal = document.getElementById('ai-modal');
  if (modal.classList.contains('active')) openAnalysisModal();
}
socket.on('room_state_updated', acceptRoom);
socket.on('bid_placed', ({ room, log }) => { acceptRoom(room); if (log) logEvent(log, 'bid'); });
socket.on('lot_concluded', ({ room, log, result }) => {
  if (result) showLotResult({ pool: [result.item], currentIndex: 0, highestBidder: result.winner, currentBid: result.price });
  acceptRoom(room); if (log) logEvent(log, 'sold');
});
socket.on('clock_state', state => {
  if (!currentRoom || state.version < currentRoom.version) return;
  Object.assign(currentRoom, state);
  renderClock(currentRoom); updateControls();
});
function renderClock(room) {
  renderHammerClock(room.timer);
  renderInterstitial(room.phase === 'INTERSTITIAL' ? room.interstitialTimer : 0);
  const phaseOverlay = document.getElementById('phase-break-overlay');
  isShowingPhaseBreak = room.phaseBreakTimer > 0;
  phaseOverlay.classList.toggle('active', isShowingPhaseBreak);
  if (isShowingPhaseBreak) {
    document.getElementById('phase-ad-countdown').textContent = room.phaseBreakTimer;
    const previousRole = room.lastResult?.item.primaryRole;
    document.getElementById('phase-break-title').textContent = previousRole === 'manager' ? 'MANAGERS DRAFT COMPLETE' : 'MIDFIELDERS DRAFT COMPLETE';
  }
  document.getElementById('timer-box').classList.toggle('paused', room.isPaused);
  document.getElementById('host-pause-btn').textContent = room.isPaused ? '▶ Resume' : '⏸ Pause';
}

// 12s Hammer countdown tick
function renderHammerClock(timeLeft) {
  const timerEl = document.getElementById('timer');
  const timerBox = document.getElementById('timer-box');
  const timerLabel = document.getElementById('timer-label');
  
  if (timerEl) timerEl.textContent = timeLeft;
  if (timerLabel) timerLabel.textContent = "HAMMER IN";

  if (timerBox) {
    if (timeLeft <= 4) timerBox.classList.add('urgent');
    else timerBox.classList.remove('urgent');
  }
}

// 35% FASTER CLEAN 3-2-1 TRANSITION (NO VIOLET, NO BOOM WORD)
function renderInterstitial(secondsLeft) {
  const overlay = document.getElementById('interstitial-overlay');
  const textEl = document.getElementById('countdown-boom-text');
  const subEl = document.getElementById('boom-sub-text');
  const timerLabel = document.getElementById('timer-label');
  const timerEl = document.getElementById('timer');

  if (secondsLeft > 0) {
    if (timerLabel) timerLabel.textContent = "NEXT LOT";
    if (timerEl) timerEl.textContent = secondsLeft;
  }

  if (overlay) overlay.classList.add('active');

  // Remove existing color classes
  textEl.classList.remove('digit-3', 'digit-2', 'digit-1');

  if (secondsLeft === 3) {
    textEl.textContent = "3";
    textEl.classList.add('digit-3'); // Red
    if (subEl) subEl.textContent = "STAND BY...";
  } else if (secondsLeft === 2) {
    textEl.textContent = "2";
    textEl.classList.add('digit-2'); // Yellow
    if (subEl) subEl.textContent = "PREPARING CARD...";
  } else if (secondsLeft === 1) {
    textEl.textContent = "1";
    textEl.classList.add('digit-1'); // Green
    if (subEl) subEl.textContent = "LAUNCHING LOT";
  } else {
    // 0s: Dismiss immediately, no BOOM display
    if (overlay) overlay.classList.remove('active');
  }
}

function leaveRoom(message) {
  saveSession(null); currentRoom = null; myTeamId = null; sessionReady = false;
  document.getElementById('room-auth-modal').classList.add('active');
  showMessage(message); updateControls();
}
socket.on('room_closed', () => leaveRoom('The room was closed or expired.'));
socket.on('you_were_kicked', () => leaveRoom('The host removed your club from the lobby.'));
socket.on('auction_finished', ({ room, log, result }) => {
  if (result) showLotResult({ pool: [result.item], currentIndex: 0, highestBidder: result.winner, currentBid: result.price });
  acceptRoom(room); if (log) logEvent(log, 'sold');
  setTimeout(openAnalysisModal, 750);
});
socket.on('error_msg', error => showMessage(typeof error === 'string' ? error : error.message));

// --- 5. RENDER CURRENT ROOM STATE ---
function renderRoomState(room) {
  const isHost = room.hostTeamId === myTeamId;
  const hostStartBtn = document.getElementById('host-start-btn');
  const hostLiveControls = document.getElementById('host-live-controls');

  const lobbyView = document.getElementById('lobby-stage-view');
  const liveView = document.getElementById('live-stage-view');
  const countEl = document.getElementById('connected-count');

  if (countEl) {
    countEl.textContent = `${room.teams.length}/${room.maxTeams} Joined`;
  }

  // Keep the local club identity and available purse visible as room state changes.
  const myTeam = room.teams.find(t => t.id === myTeamId);
  const clubDisplay = document.getElementById('my-club-display');
  if (clubDisplay && myTeam) {
    clubDisplay.textContent = `${myTeam.name} • ${myTeam.purse} 🪙`;
  }

  // 1. Toggle between Lobby Stage (With 2 Ads) & Live Auction Floor
  if (room.status === 'LOBBY') {
    document.body.classList.add('lobby-mode');

    if (lobbyView) lobbyView.style.display = 'flex';
    if (liveView) liveView.style.display = 'none';

    if (hostStartBtn) hostStartBtn.style.display = isHost ? 'inline-block' : 'none';
    if (hostLiveControls) hostLiveControls.style.display = 'none';

    const phaseEl = document.getElementById('phase-indicator');
    if (phaseEl) {
      phaseEl.textContent = `AUCTION LOBBY • ${room.teams.filter(t => t.connected).length}/${room.maxTeams} CLUBS CONNECTED`;
    }

    const activityTitle = document.getElementById('activity-panel-title');
    if (activityTitle) activityTitle.textContent = 'Room Activity';

    const lobbyTitle = document.getElementById('lobby-wait-title');
    const lobbySubtitle = document.getElementById('lobby-wait-subtitle');
    const roomCodeEl = document.getElementById('lobby-room-code');
    const budgetEl = document.getElementById('lobby-budget');
    const categoryEl = document.getElementById('lobby-category');
    const maxTeamsEl = document.getElementById('lobby-max-teams');
    const progressEl = document.getElementById('lobby-progress-text');
    const waitNote = document.getElementById('lobby-wait-note');
    const lobbyStartBtn = document.getElementById('lobby-start-btn');

    if (lobbyTitle) lobbyTitle.textContent = isHost ? 'You are Host' : 'Auction Lobby';
    const cardTitle = document.getElementById('lobby-card-title');
    const cardSubtitle = document.getElementById('lobby-card-subtitle');
    if (cardTitle) cardTitle.textContent = isHost ? 'You are Host' : 'Auction Lobby';
    if (cardSubtitle) cardSubtitle.textContent = isHost
      ? 'Invite your friends and launch the auction when ready.'
      : 'Waiting for the host to launch the auction.';
    if (lobbySubtitle) {
      lobbySubtitle.textContent = isHost
        ? 'Invite your friends and launch the auction when ready.'
        : 'Waiting for the host to launch the auction.';
    }

    if (roomCodeEl) roomCodeEl.textContent = room.code;
    if (budgetEl) budgetEl.textContent = `${room.budget} 🪙`;
    if (categoryEl) {
      categoryEl.textContent = room.categoryFilter === 'mixed'
        ? 'Mixed'
        : room.categoryFilter.replace(/\b\w/g, ch => ch.toUpperCase());
    }
    if (maxTeamsEl) maxTeamsEl.textContent = room.maxTeams;
    if (progressEl) progressEl.textContent = `${room.teams.filter(t => t.connected).length} / ${room.maxTeams} clubs connected`;
    if (waitNote) {
      waitNote.textContent = room.teams.length >= room.maxTeams
        ? 'All clubs connected. Ready for kickoff.'
        : 'Waiting for more clubs to join...';
    }
    if (lobbyStartBtn) {
      lobbyStartBtn.style.display = isHost ? 'block' : 'none';
    }

    renderLobbySlots(room);
    renderTeams(room, isHost);
    return;
  }

  document.body.classList.remove('lobby-mode');

  const activityTitle = document.getElementById('activity-panel-title');
  if (activityTitle) activityTitle.textContent = 'Live Auction Stream';

  // 2. Status is LIVE: Hide Lobby Ads, Show Player Auction Card & Controls
  if (lobbyView) lobbyView.style.display = 'none';
  if (liveView) liveView.style.display = 'flex';

  if (hostStartBtn) hostStartBtn.style.display = 'none';
  if (hostLiveControls) hostLiveControls.style.display = isHost ? 'flex' : 'none';

  const item = room.pool[room.currentIndex];
  if (!item) {
    renderTeams(room, isHost);
    if (room.status === 'FINISHED') document.getElementById('phase-indicator').textContent = 'AUCTION COMPLETE';
    return;
  }

  // 3. 5-Second Static Ad Check across Phase Transitions (After Managers, After Midfielders)
  // Phase transitions are synchronized by the server clock.

  const isManager = item.category === 'manager';
  const phaseIndicator = document.getElementById('phase-indicator');
  if (phaseIndicator) {
    phaseIndicator.textContent = `PHASE: ${item.primaryRole.toUpperCase()} DRAFT`;
    phaseIndicator.style.color = isManager ? '#7e22ce' : '#0284c7';
  }

  // Card updates
  document.getElementById('lot-index').textContent = `LOT ${room.currentIndex + 1} OF ${room.pool.length}`;
  document.getElementById('card-ovr').textContent = item.overall;
  document.getElementById('card-pos').textContent = isManager ? 'MGR' : item.position;
  document.getElementById('card-name').textContent = item.name;
  document.getElementById('card-nat').textContent = item.nationality;
  document.getElementById('card-pri').textContent = isManager ? (item.preferredFormation || 'TAC') : item.primary;
  document.getElementById('base-price').textContent = item.baseprice;
  document.getElementById('current-bid').textContent = room.currentBid;
  document.getElementById('bid-leader').textContent = room.highestBidder ? room.highestBidder.name : 'None';
  document.getElementById('card-image').src = DEFAULT_BOT_DP;

  // Category Tag
  const catBadge = document.getElementById('card-category');
  catBadge.textContent = item.category;
  catBadge.className = 'category-tag';
  const c = item.category.toLowerCase().trim();
  if (c === 'icons') catBadge.classList.add('tag-icons');
  else if (c === 'hearts') catBadge.classList.add('tag-hearts');
  else if (c === 'young gen') catBadge.classList.add('tag-young-gen');
  else if (c === 'manager') catBadge.classList.add('tag-manager');
  else catBadge.classList.add('tag-normal');

  // Stats Grid
  const statsGrid = document.getElementById('stats-grid');
  const isGK = item.primary === 'GK' || item.position === 'GK';

  if (isManager) {
    statsGrid.innerHTML = `
      <div class="stat-item"><span class="stat-label">ATTACKING</span><span class="stat-val">${item.attributes.attacking}</span></div>
      <div class="stat-item"><span class="stat-label">TACTICS</span><span class="stat-val">${item.attributes.tactics}</span></div>
      <div class="stat-item"><span class="stat-label">DISCIPLINE</span><span class="stat-val">${item.attributes.discipline}</span></div>
      <div class="stat-item"><span class="stat-label">ADAPTABILITY</span><span class="stat-val">${item.attributes.adaptability}</span></div>
      <div class="stat-item"><span class="stat-label">MOTIVATION</span><span class="stat-val">${item.attributes.motivation}</span></div>
      <div class="stat-item"><span class="stat-label">DEFENSE</span><span class="stat-val">${item.attributes.defense}</span></div>
    `;
  } else if (isGK) {
    statsGrid.innerHTML = `
      <div class="stat-item"><span class="stat-label">DIVING</span><span class="stat-val">${item.attributes.diving}</span></div>
      <div class="stat-item"><span class="stat-label">HANDLING</span><span class="stat-val">${item.attributes.handling}</span></div>
      <div class="stat-item"><span class="stat-label">KICKING</span><span class="stat-val">${item.attributes.kicking}</span></div>
      <div class="stat-item"><span class="stat-label">REFLEXES</span><span class="stat-val">${item.attributes.reflexes}</span></div>
      <div class="stat-item"><span class="stat-label">SPEED</span><span class="stat-val">${item.attributes.speed}</span></div>
      <div class="stat-item"><span class="stat-label">POSITIONING</span><span class="stat-val">${item.attributes.positioning}</span></div>
    `;
  } else {
    statsGrid.innerHTML = `
      <div class="stat-item"><span class="stat-label">PACE</span><span class="stat-val">${item.attributes.pace}</span></div>
      <div class="stat-item"><span class="stat-label">SHOOTING</span><span class="stat-val">${item.attributes.shooting}</span></div>
      <div class="stat-item"><span class="stat-label">PASSING</span><span class="stat-val">${item.attributes.passing}</span></div>
      <div class="stat-item"><span class="stat-label">DRIBBLING</span><span class="stat-val">${item.attributes.dribbling}</span></div>
      <div class="stat-item"><span class="stat-label">DEFENDING</span><span class="stat-val">${item.attributes.defending}</span></div>
      <div class="stat-item"><span class="stat-label">PHYSICAL</span><span class="stat-val">${item.attributes.physical}</span></div>
    `;
  }

  // Slab & bidding presentation.
  // This changes only what the player sees; the server remains the authority for bids.
  const slabInc = room.currentBid < 50 ? 2 : (room.currentBid <= 100 ? 5 : 10);
  const nextBid = !room.highestBidder ? item.baseprice : room.currentBid + slabInc;
  const bidButton = document.getElementById('btn-raise-bid');

  document.getElementById('next-bid-val').textContent = nextBid;

  if (bidButton) {
    bidButton.innerHTML = `BID <span id="btn-bid-amount">${nextBid} 🪙</span>`;

    if (myTeam) {
      const purseAfterBid = myTeam.purse - nextBid;
      bidButton.title = purseAfterBid >= 0
        ? `Purse after bid: ${purseAfterBid} coins`
        : 'Insufficient coins for this bid';
      bidButton.setAttribute(
        'aria-label',
        purseAfterBid >= 0
          ? `Bid ${nextBid} coins. ${purseAfterBid} coins would remain.`
          : `Bid ${nextBid} coins. Insufficient coins.`
      );
    }
  }

  document.getElementById('pass-counter').textContent = `${room.passedTeamIds.length}/${room.teams.length}`;

  renderTeams(room, isHost);
}

function escapeHTML(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

function renderTeams(room, isHost) {
  const container = document.getElementById('teams-list');
  container.innerHTML = room.teams.map(t => {
    const isLeader = room.highestBidder && room.highestBidder.id === t.id;
    const hasPassed = room.passedTeamIds.includes(t.id);
    const isMe = t.id === myTeamId;
    const canKick = isHost && !t.isHost && room.status === 'LOBBY';

    const m = t.manager ? 1 : 0;
    const fwd = t.squad.filter(p => p.primaryRole === 'forward').length;
    const mid = t.squad.filter(p => p.primaryRole === 'midfielder').length;
    const def = t.squad.filter(p => p.primaryRole === 'defender').length;
    const gk = t.squad.filter(p => p.primaryRole === 'goalkeeper').length;

    const statusBadge = isLeader
      ? '<span class="team-state team-state-leading">LEADING</span>'
      : hasPassed
        ? '<span class="team-state team-state-passed">PASSED</span>'
        : '<span class="team-state team-state-active">ACTIVE</span>';

    return `
      <div class="team-card ${isLeader ? 'is-leader' : ''} ${hasPassed ? 'has-passed' : ''} ${isMe ? 'is-me' : ''}">
        <div class="team-meta">
          <div class="team-name-wrap">
            <div class="team-name-line">
              <span class="team-name">${escapeHTML(t.name)}</span>
              ${isMe ? '<span class="you-badge">YOU</span>' : ''}
              ${room.status === 'LOBBY' && t.isHost ? '<span class="host-badge">HOST</span>' : ''}
            </div>
            ${canKick ? `<button type="button" class="btn-kick" onclick="handleKickTeam('${t.id}')">Kick</button>` : ''}
          </div>

          <div class="team-finance">
            <span class="team-purse">${t.purse} 🪙</span>
            ${statusBadge}
          </div>
        </div>

        <div class="team-quota-grid" aria-label="Squad progress">
          <div class="quota-item ${m >= 1 ? 'is-complete' : ''}">
            <span class="quota-icon">👔</span>
            <span class="quota-label">MGR</span>
            <strong>${m}/1</strong>
          </div>
          <div class="quota-item ${fwd >= 4 ? 'is-complete' : ''}">
            <span class="quota-icon">⚡</span>
            <span class="quota-label">FWD</span>
            <strong>${fwd}/4</strong>
          </div>
          <div class="quota-item ${mid >= 3 ? 'is-complete' : ''}">
            <span class="quota-icon">🎯</span>
            <span class="quota-label">MID</span>
            <strong>${mid}/3</strong>
          </div>
          <div class="quota-item ${def >= 3 ? 'is-complete' : ''}">
            <span class="quota-icon">🛡️</span>
            <span class="quota-label">DEF</span>
            <strong>${def}/3</strong>
          </div>
          <div class="quota-item ${gk >= 1 ? 'is-complete' : ''}">
            <span class="quota-icon">🧤</span>
            <span class="quota-label">GK</span>
            <strong>${gk}/1</strong>
          </div>
        </div>
      </div>
    `;
  }).join('');

  if (room.status === 'LOBBY' && room.teams.length < room.maxTeams) {
    const waitingCount = room.maxTeams - room.teams.length;
    const waitingSlots = Array.from({ length: waitingCount }, (_, index) => `
      <div class="team-card waiting-team-card">
        <div class="waiting-team-index">${room.teams.length + index + 1}</div>
        <div class="waiting-team-copy">
          <strong>Waiting for Club</strong>
          <span>Share the room code to join</span>
        </div>
      </div>
    `).join('');

    container.insertAdjacentHTML('beforeend', waitingSlots);
  }
}

function logEvent(msg, type) {
  const stream = document.getElementById('log-stream');
  if (!stream) return;
  const item = document.createElement('div');
  item.className = `log-item ${type}`;
  item.textContent = msg;
  stream.prepend(item);
  while (stream.children.length > 100) stream.lastElementChild.remove();
  const count = document.getElementById('lobby-activity-count');
  if (count) count.textContent = stream.children.length + (stream.children.length === 1 ? ' activity' : ' activities');
}

// --- 6. SQUAD MODAL OVERVIEW ---
function openAnalysisModal() {
  if (!currentRoom) return;
  const modal = document.getElementById('ai-modal');
  const container = document.getElementById('modal-body-content');
  modal.classList.add('active');

  container.innerHTML = currentRoom.teams.map(team => `
    <div class="ai-team-card">
      <div class="ai-team-head">
        <div>
          <h3 style="font-family: var(--font-display);">${escapeHTML(team.name)}</h3>
          <span class="hint">${team.manager ? 'Manager: ' + escapeHTML(team.manager) : 'No Manager'} • Purse: ${team.purse} Coins</span>
        </div>
        <div class="ai-score-badge">Total Squad: ${team.squad.length + (team.manager ? 1 : 0)}/12</div>
      </div>
      <div class="ai-roster-tags">
        ${team.manager ? `<span class="player-chip" style="border-color: #d8b4fe; color: #7e22ce;">👔 ${escapeHTML(team.manager)} (MGR)</span>` : ''}
        ${team.squad.length > 0 
          ? team.squad.map(p => `<span class="player-chip">${escapeHTML(p.name)} (${escapeHTML(p.position)}) - ${p.boughtFor}🪙</span>`).join('') 
          : '<span class="hint">No outfield players drafted yet.</span>'}
      </div>
    </div>
  `).join('');
}

function closeAnalysisModal() {
  document.getElementById('ai-modal').classList.remove('active');
}

// Mobile lobby artwork: one choice per page load, never a slideshow.
(function initMobileLounge() {
  const mobile = window.matchMedia('(max-width: 768px)');
  const choice = 1 + Math.floor(Math.random() * 4);
  const apply = () => {
    if (mobile.matches) {
      document.body.style.setProperty('--mobile-lounge-image', 'url("./assets/mobile-lounge-' + choice + '.webp")');
    }
  };
  apply();
  mobile.addEventListener('change', apply);
})();

function toggleLobbyActivity(button) {
  const expanded = button.getAttribute('aria-expanded') !== 'true';
  button.setAttribute('aria-expanded', String(expanded));
  document.querySelector('.log-panel').classList.toggle('activity-expanded', expanded);
}
