'use strict';

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const ROOM_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const SUITS = [
  { id: 'S', symbol: '♠' },
  { id: 'H', symbol: '♥' },
  { id: 'D', symbol: '♦' },
  { id: 'C', symbol: '♣' }
];
const RANKS = ['A','2','3','4','5','6','7','8','9','10','J','Q','K'];
const BOARD_RANKS = RANKS.filter(r => r !== 'J');
const HAND_SIZES = { 2: 7, 3: 6, 4: 6, 5: 5, 6: 5, 7: 4, 8: 4, 9: 4, 10: 3, 11: 3, 12: 3 };
const TEAM_NAMES = ['Green', 'Red', 'Blue'];

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static('public'));
app.get('/health', (req, res) => res.json({ ok: true }));

const rooms = new Map();

function id(len = 8) {
  let out = '';
  for (let i = 0; i < len; i++) out += ROOM_CHARS[Math.floor(Math.random() * ROOM_CHARS.length)];
  return out;
}
function roomCode() {
  let code = id(5);
  while (rooms.has(code)) code = id(5);
  return code;
}
function cardId(rank, suit) { return `${rank}${suit}`; }
function parseCard(card) {
  const suit = SUITS.find(s => card.endsWith(s.id));
  return { rank: card.slice(0, -1), suit: suit.id, symbol: suit.symbol };
}
function label(card) { const c = parseCard(card); return `${c.rank}${c.symbol}`; }
function isJack(card) { return parseCard(card).rank === 'J'; }
function isTwoEyed(card) { const c = parseCard(card); return c.rank === 'J' && (c.suit === 'C' || c.suit === 'D'); }
function isOneEyed(card) { const c = parseCard(card); return c.rank === 'J' && (c.suit === 'S' || c.suit === 'H'); }
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function makeDeck() {
  const deck = [];
  for (let copy = 0; copy < 2; copy++) {
    for (const rank of RANKS) for (const s of SUITS) deck.push(cardId(rank, s.id));
  }
  return shuffle(deck);
}
function makeBoard() {
  const cards = [];
  for (let copy = 0; copy < 2; copy++) {
    for (const rank of BOARD_RANKS) for (const s of SUITS) cards.push(cardId(rank, s.id));
  }
  const mixed = shuffle(cards);
  const board = [];
  let k = 0;
  for (let r = 0; r < 10; r++) {
    const row = [];
    for (let c = 0; c < 10; c++) {
      const free = (r === 0 && c === 0) || (r === 0 && c === 9) || (r === 9 && c === 0) || (r === 9 && c === 9);
      row.push(free ? { free: true, card: 'FREE', team: -1, locked: true } : { free: false, card: mixed[k++], team: null, locked: false });
    }
    board.push(row);
  }
  return board;
}
function playerView(room, player) {
  return {
    code: room.code,
    hostId: room.hostId,
    myId: player.id,
    started: room.started,
    winner: room.winner,
    settings: room.settings,
    players: room.players.map(p => ({ id: p.id, name: p.name, team: p.team, connected: p.connected, handCount: p.hand.length })),
    board: room.board,
    turnPlayerId: room.started && room.players[room.turnIndex] ? room.players[room.turnIndex].id : null,
    myHand: player.hand,
    discardTop: room.discard.at(-1) || null,
    deckCount: room.deck.length,
    log: room.log.slice(-12)
  };
}
function emitRoom(room) {
  for (const p of room.players) {
    const s = io.sockets.sockets.get(p.socketId);
    if (s) s.emit('state', playerView(room, p));
  }
}
function addLog(room, text) { room.log.push(text); }
function findPlayer(room, clientId) { return room.players.find(p => p.clientId === clientId); }
function activePlayer(room) { return room.players[room.turnIndex]; }
function draw(room) {
  if (room.deck.length === 0) {
    room.deck = shuffle(room.discard.splice(0, Math.max(0, room.discard.length - 1)));
  }
  return room.deck.pop() || null;
}
function positionsForCard(board, card) {
  const pos = [];
  for (let r = 0; r < 10; r++) for (let c = 0; c < 10; c++) if (board[r][c].card === card) pos.push([r,c]);
  return pos;
}
function canPlay(room, player, card, r, c) {
  if (!room.started) return 'Game not started.';
  if (room.winner) return 'Game is finished.';
  if (!activePlayer(room) || activePlayer(room).id !== player.id) return 'Not your turn.';
  if (!player.hand.includes(card)) return 'Card is not in your hand.';
  const cell = room.board[r]?.[c];
  if (!cell) return 'Invalid cell.';
  if (cell.free) return 'Free corners are already owned.';
  if (isTwoEyed(card)) {
    if (cell.team !== null) return 'Two-eyed jack needs an empty cell.';
    return null;
  }
  if (isOneEyed(card)) {
    if (cell.team === null) return 'One-eyed jack removes an opponent chip.';
    if (cell.team === player.team) return 'You cannot remove your own chip.';
    if (cell.locked) return 'This chip is locked in a sequence.';
    return null;
  }
  if (cell.card !== card) return 'This card does not match the selected cell.';
  if (cell.team !== null) return 'Cell is already taken.';
  return null;
}
function nextTurn(room) {
  room.turnIndex = (room.turnIndex + 1) % room.players.length;
}
function scanSequences(room) {
  const dirs = [[1,0],[0,1],[1,1],[1,-1]];
  const counts = new Map();
  const lines = [];
  for (let team = 0; team < room.settings.teamCount; team++) {
    for (let r = 0; r < 10; r++) for (let c = 0; c < 10; c++) {
      for (const [dr, dc] of dirs) {
        const cells = [];
        for (let i = 0; i < 5; i++) {
          const rr = r + dr * i, cc = c + dc * i;
          if (rr < 0 || rr >= 10 || cc < 0 || cc >= 10) { cells.length = 0; break; }
          const cell = room.board[rr][cc];
          if (!(cell.free || cell.team === team)) { cells.length = 0; break; }
          cells.push([rr, cc]);
        }
        if (cells.length === 5) {
          const key = cells.map(x => x.join(',')).join('|');
          if (!room.sequenceKeys.has(`${team}:${key}`)) {
            room.sequenceKeys.add(`${team}:${key}`);
            counts.set(team, (counts.get(team) || 0) + 1);
            lines.push({ team, cells });
          }
        }
      }
    }
  }
  for (const line of lines) {
    for (const [r,c] of line.cells) if (!room.board[r][c].free) room.board[r][c].locked = true;
    addLog(room, `${TEAM_NAMES[line.team]} made a sequence.`);
  }
  for (let team = 0; team < room.settings.teamCount; team++) {
    const total = [...room.sequenceKeys].filter(k => k.startsWith(`${team}:`)).length;
    if (total >= room.settings.sequencesToWin) room.winner = team;
  }
}
function createRoomState({ name, clientId }) {
  const code = roomCode();
  const player = { id: id(10), clientId, socketId: null, name: name || 'Host', team: 0, hand: [], connected: true };
  const room = {
    code,
    hostId: player.id,
    started: false,
    settings: { teamCount: 2, sequencesToWin: 2 },
    players: [player],
    board: makeBoard(),
    deck: [],
    discard: [],
    turnIndex: 0,
    winner: null,
    sequenceKeys: new Set(),
    log: ['Room created.']
  };
  rooms.set(code, room);
  return { room, player };
}

io.on('connection', socket => {
  socket.on('createRoom', ({ name, clientId }, cb) => {
    const { room, player } = createRoomState({ name, clientId: clientId || id(12) });
    player.socketId = socket.id;
    socket.join(room.code);
    cb?.({ ok: true, code: room.code, playerId: player.id });
    emitRoom(room);
  });

  socket.on('joinRoom', ({ code, name, clientId }, cb) => {
    code = String(code || '').trim().toUpperCase();
    const room = rooms.get(code);
    if (!room) return cb?.({ ok: false, error: 'Room not found.' });
    if (room.started && !findPlayer(room, clientId)) return cb?.({ ok: false, error: 'Game already started.' });
    let player = findPlayer(room, clientId);
    if (!player) {
      if (room.players.length >= 12) return cb?.({ ok: false, error: 'Room is full.' });
      player = { id: id(10), clientId: clientId || id(12), socketId: socket.id, name: name || 'Player', team: room.players.length % room.settings.teamCount, hand: [], connected: true };
      room.players.push(player);
      addLog(room, `${player.name} joined.`);
    }
    player.socketId = socket.id;
    player.connected = true;
    socket.join(room.code);
    cb?.({ ok: true, code: room.code, playerId: player.id });
    emitRoom(room);
  });

  socket.on('setSettings', ({ code, clientId, teamCount, sequencesToWin }, cb) => {
    const room = rooms.get(String(code || '').toUpperCase());
    const player = room && findPlayer(room, clientId);
    if (!room || !player || player.id !== room.hostId) return cb?.({ ok: false, error: 'Only host can change settings.' });
    if (room.started) return cb?.({ ok: false, error: 'Game already started.' });
    room.settings.teamCount = Number(teamCount) === 3 ? 3 : 2;
    room.settings.sequencesToWin = Number(sequencesToWin) === 1 ? 1 : 2;
    room.players.forEach((p, i) => { p.team = i % room.settings.teamCount; });
    cb?.({ ok: true });
    emitRoom(room);
  });

  socket.on('startGame', ({ code, clientId }, cb) => {
    const room = rooms.get(String(code || '').toUpperCase());
    const player = room && findPlayer(room, clientId);
    if (!room || !player || player.id !== room.hostId) return cb?.({ ok: false, error: 'Only host can start.' });
    if (room.players.length < 2) return cb?.({ ok: false, error: 'Need at least 2 players.' });
    room.started = true;
    room.winner = null;
    room.board = makeBoard();
    room.deck = makeDeck();
    room.discard = [];
    room.sequenceKeys = new Set();
    room.turnIndex = 0;
    const handSize = HAND_SIZES[room.players.length] || 3;
    room.players.forEach((p, i) => {
      p.team = i % room.settings.teamCount;
      p.hand = [];
      for (let h = 0; h < handSize; h++) p.hand.push(draw(room));
    });
    room.log = ['Game started.'];
    cb?.({ ok: true });
    emitRoom(room);
  });

  socket.on('playCard', ({ code, clientId, card, row, col }, cb) => {
    const room = rooms.get(String(code || '').toUpperCase());
    const player = room && findPlayer(room, clientId);
    if (!room || !player) return cb?.({ ok: false, error: 'Player not found.' });
    row = Number(row); col = Number(col);
    const error = canPlay(room, player, card, row, col);
    if (error) return cb?.({ ok: false, error });
    const cell = room.board[row][col];
    if (isOneEyed(card)) cell.team = null;
    else cell.team = player.team;
    const handIndex = player.hand.indexOf(card);
    player.hand.splice(handIndex, 1);
    room.discard.push(card);
    const next = draw(room);
    if (next) player.hand.push(next);
    addLog(room, `${player.name} played ${label(card)}.`);
    scanSequences(room);
    if (!room.winner && room.players.every(p => p.hand.length === 0)) room.winner = -2;
    if (!room.winner) nextTurn(room);
    cb?.({ ok: true });
    emitRoom(room);
  });

  socket.on('disconnect', () => {
    for (const room of rooms.values()) {
      const p = room.players.find(x => x.socketId === socket.id);
      if (p) { p.connected = false; emitRoom(room); }
    }
  });
});

setInterval(() => {
  for (const [code, room] of rooms) {
    if (room.players.every(p => !p.connected)) rooms.delete(code);
  }
}, 1000 * 60 * 30);

server.listen(PORT, () => console.log(`Server running on ${PORT}`));
