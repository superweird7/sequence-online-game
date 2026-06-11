const socket = io();

const els = {
  nameInput: document.getElementById('nameInput'),
  codeInput: document.getElementById('codeInput'),
  createBtn: document.getElementById('createBtn'),
  joinBtn: document.getElementById('joinBtn'),
  status: document.getElementById('status'),
  game: document.getElementById('game'),
  roomCode: document.getElementById('roomCode'),
  copyBtn: document.getElementById('copyBtn'),
  turnName: document.getElementById('turnName'),
  winnerName: document.getElementById('winnerName'),
  hostPanel: document.getElementById('hostPanel'),
  teamCount: document.getElementById('teamCount'),
  seqWin: document.getElementById('seqWin'),
  startBtn: document.getElementById('startBtn'),
  players: document.getElementById('players'),
  log: document.getElementById('log'),
  board: document.getElementById('board'),
  hand: document.getElementById('hand')
};

let state = null;
let selectedCard = null;
let clientId = localStorage.getItem('seq_client_id');
if (!clientId) {
  clientId = crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random();
  localStorage.setItem('seq_client_id', clientId);
}

const teamClass = ['team0', 'team1', 'team2'];
const teamNames = ['Green', 'Red', 'Blue'];

function setStatus(text) { els.status.textContent = text || ''; }
function myName() { return (els.nameInput.value || localStorage.getItem('seq_name') || 'Player').trim(); }
function saveName() { localStorage.setItem('seq_name', myName()); }
function cardText(card) { return card || ''; }
function currentPlayer() { return state?.players.find(p => p.id === state.turnPlayerId); }
function me() { return state?.players.find(p => p.id === state.myId); }
function isMyTurn() { return state && state.turnPlayerId === state.myId && !state.winner; }
function isRed(card) { return card.includes('♥') || card.includes('♦') || card.endsWith('H') || card.endsWith('D'); }
function displayCard(card) {
  return card.replace('S', '♠').replace('H', '♥').replace('D', '♦').replace('C', '♣');
}
function isJack(card) { return card && card.startsWith('J'); }
function isTwoEyed(card) { return card === 'JC' || card === 'JD'; }
function isOneEyed(card) { return card === 'JS' || card === 'JH'; }

function callback(res) {
  if (!res?.ok) setStatus(res?.error || 'صار خطأ.');
  else setStatus('');
}

els.createBtn.addEventListener('click', () => {
  saveName();
  socket.emit('createRoom', { name: myName(), clientId }, callback);
});

els.joinBtn.addEventListener('click', () => {
  saveName();
  const code = els.codeInput.value.trim().toUpperCase();
  if (!code) return setStatus('اكتب كود الغرفة.');
  socket.emit('joinRoom', { code, name: myName(), clientId }, callback);
});

els.startBtn.addEventListener('click', () => {
  if (!state) return;
  socket.emit('setSettings', {
    code: state.code,
    clientId,
    teamCount: Number(els.teamCount.value),
    sequencesToWin: Number(els.seqWin.value)
  }, () => {
    socket.emit('startGame', { code: state.code, clientId }, callback);
  });
});

els.copyBtn.addEventListener('click', async () => {
  if (!state) return;
  const url = `${location.origin}?room=${state.code}`;
  try {
    await navigator.clipboard.writeText(url);
    setStatus('تم نسخ الرابط.');
  } catch {
    setStatus(url);
  }
});

socket.on('connect', () => {
  const params = new URLSearchParams(location.search);
  const room = params.get('room');
  if (room && !state) {
    els.codeInput.value = room.toUpperCase();
    socket.emit('joinRoom', { code: room, name: myName(), clientId }, callback);
  }
});

socket.on('state', next => {
  state = next;
  selectedCard = state.myHand?.includes(selectedCard) ? selectedCard : null;
  render();
});

function render() {
  if (!state) return;
  els.game.classList.remove('hidden');
  els.roomCode.textContent = state.code;
  const turn = currentPlayer();
  els.turnName.textContent = turn ? `${turn.name} / ${teamNames[turn.team]}` : '-';
  els.winnerName.textContent = state.winner === null ? '-' : state.winner === -2 ? 'تعادل' : teamNames[state.winner];
  const mine = me();
  els.hostPanel.classList.toggle('hidden', !mine || mine.id !== state.hostId || state.started);
  els.teamCount.value = state.settings.teamCount;
  els.seqWin.value = state.settings.sequencesToWin;
  renderPlayers();
  renderLog();
  renderBoard();
  renderHand();
}

function renderPlayers() {
  els.players.innerHTML = '';
  for (const p of state.players) {
    const div = document.createElement('div');
    div.className = `player ${teamClass[p.team]}`;
    div.innerHTML = `<span>${escapeHtml(p.name)}${p.id === state.hostId ? ' 👑' : ''}</span><small>${teamNames[p.team]} · ${p.handCount} cards · ${p.connected ? 'online' : 'offline'}</small>`;
    els.players.appendChild(div);
  }
}

function renderLog() {
  els.log.innerHTML = '';
  for (const item of state.log.slice().reverse()) {
    const div = document.createElement('div');
    div.className = 'logItem';
    div.textContent = item;
    els.log.appendChild(div);
  }
}

function renderBoard() {
  els.board.innerHTML = '';
  state.board.forEach((row, r) => row.forEach((cell, c) => {
    const btn = document.createElement('button');
    btn.className = 'cell';
    if (cell.free) btn.classList.add('free');
    if (cell.team !== null && cell.team !== undefined) btn.classList.add(teamClass[cell.team]);
    if (cell.locked) btn.classList.add('locked');
    btn.innerHTML = `<span>${cell.free ? '★' : displayCard(cell.card)}</span>${cell.team !== null && cell.team !== undefined ? '<b></b>' : ''}`;
    btn.disabled = !isMyTurn() || !selectedCard || state.winner !== null;
    btn.addEventListener('click', () => playAt(r, c));
    els.board.appendChild(btn);
  }));
}

function renderHand() {
  els.hand.innerHTML = '';
  if (!state.started) {
    els.hand.innerHTML = '<p class="hint">انتظر المضيف يبدأ اللعبة.</p>';
    return;
  }
  for (const card of state.myHand) {
    const btn = document.createElement('button');
    btn.className = `card ${selectedCard === card ? 'selected' : ''}`;
    if (card.endsWith('H') || card.endsWith('D')) btn.classList.add('redCard');
    btn.innerHTML = `<strong>${displayCard(card)}</strong><small>${jackHelp(card)}</small>`;
    btn.addEventListener('click', () => {
      selectedCard = selectedCard === card ? null : card;
      renderHand();
      renderBoard();
    });
    els.hand.appendChild(btn);
  }
}

function jackHelp(card) {
  if (isTwoEyed(card)) return 'wild';
  if (isOneEyed(card)) return 'remove';
  return 'place';
}

function playAt(row, col) {
  if (!selectedCard) return setStatus('اختار كارت أولاً.');
  socket.emit('playCard', { code: state.code, clientId, card: selectedCard, row, col }, res => {
    if (!res?.ok) return setStatus(res?.error || 'حركة غير مقبولة.');
    selectedCard = null;
    setStatus('');
  });
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
}

els.nameInput.value = localStorage.getItem('seq_name') || '';
