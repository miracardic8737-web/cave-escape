const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { randomUUID } = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  transports: ['websocket', 'polling']
});

app.use(express.static(path.join(__dirname, 'public')));

const MAX_PLAYERS = 4;
const COLORS = ['#ff4444', '#44ff88', '#4488ff', '#ffff44'];
const NAMES  = ['Kırmızı', 'Yeşil', 'Mavi', 'Sarı'];

const rooms = {}; // roomId -> room

function createRoom(name, chainMode) {
  const id = name.toLowerCase().replace(/\s+/g, '-') + '-' + Math.floor(Math.random() * 1000);
  rooms[id] = {
    id, name,
    players: {},
    gameState: 'waiting', // waiting | playing | finished
    chainMode: !!chainMode,
    startTime: null
  };
  return rooms[id];
}

function getRoomList() {
  return Object.values(rooms)
    .filter(r => r.gameState === 'waiting')
    .map(r => ({
      id: r.id,
      name: r.name,
      playerCount: Object.keys(r.players).length,
      maxPlayers: MAX_PLAYERS,
      chainMode: r.chainMode
    }));
}

function broadcastRoomList() {
  io.emit('roomList', getRoomList());
}

io.on('connection', (socket) => {

  socket.on('getRoomList', () => {
    socket.emit('roomList', getRoomList());
  });

  socket.on('createRoom', ({ roomName, chainMode }) => {
    const room = createRoom(roomName || 'Oda', chainMode);
    joinRoom(socket, room.id);
    socket.emit('roomCreated', { roomId: room.id, roomName: room.name });
    broadcastRoomList();
  });

  socket.on('joinRoom', ({ roomId, chainMode }) => {
    const room = rooms[roomId];
    if (!room) { socket.emit('roomNotFound'); return; }
    if (Object.keys(room.players).length >= MAX_PLAYERS) { socket.emit('roomFull'); return; }
    if (room.gameState !== 'waiting') { socket.emit('roomFull'); return; }
    joinRoom(socket, roomId);
  });

  socket.on('setReady', () => {
    const room = rooms[socket.roomId];
    if (!room || !room.players[socket.id]) return;
    room.players[socket.id].ready = true;

    io.to(socket.roomId).emit('waitingUpdate', room.players);

    // Start if all ready (min 1 player)
    const players = Object.values(room.players);
    if (players.length >= 1 && players.every(p => p.ready) && room.gameState === 'waiting') {
      startGame(room);
    }
  });

  socket.on('playerUpdate', (data) => {
    const room = rooms[socket.roomId];
    if (!room || !room.players[socket.id] || room.gameState !== 'playing') return;
    const p = room.players[socket.id];
    p.position = { x: data.x, y: 0.5, z: data.z };
    p.score = Math.floor(Math.abs(data.z));
    socket.to(socket.roomId).emit('playerMoved', { id: socket.id, x: data.x, z: data.z });
  });

  socket.on('playerDied', ({ score }) => {
    const room = rooms[socket.roomId];
    if (!room || !room.players[socket.id]) return;
    const p = room.players[socket.id];
    p.alive = false;
    p.score = score || 0;
    socket.to(socket.roomId).emit('playerDied', { id: socket.id, name: p.name });

    const alive = Object.values(room.players).filter(pl => pl.alive);
    if (alive.length === 0 && room.gameState === 'playing') {
      endGame(room);
    }
  });

  socket.on('leaveRoom', () => {
    leaveRoom(socket);
    broadcastRoomList();
  });

  socket.on('disconnect', () => {
    leaveRoom(socket);
    broadcastRoomList();
  });
});

function joinRoom(socket, roomId) {
  const room = rooms[roomId];
  const idx = Object.keys(room.players).length;

  room.players[socket.id] = {
    id: socket.id,
    index: idx,
    name: NAMES[idx],
    color: COLORS[idx],
    position: { x: (idx - 1.5) * 3, y: 0.5, z: 0 },
    ready: false,
    alive: true,
    score: 0
  };

  socket.join(roomId);
  socket.roomId = roomId;

  socket.emit('joinedRoom', {
    roomId,
    roomName: room.name,
    playerId: socket.id,
    playerIndex: idx,
    color: COLORS[idx],
    name: NAMES[idx],
    players: room.players,
    chainMode: room.chainMode
  });

  socket.to(roomId).emit('playerJoinedWaiting', room.players[socket.id]);
  io.to(roomId).emit('waitingUpdate', room.players);
}

function leaveRoom(socket) {
  const room = rooms[socket.roomId];
  if (!room) return;
  socket.to(socket.roomId).emit('playerLeft', { id: socket.id });
  delete room.players[socket.id];
  socket.leave(socket.roomId);
  if (Object.keys(room.players).length === 0) {
    delete rooms[socket.roomId];
  } else {
    io.to(socket.roomId).emit('waitingUpdate', room.players);
  }
  socket.roomId = null;
}

function startGame(room) {
  room.gameState = 'playing';
  room.startTime = Date.now();
  Object.values(room.players).forEach(p => { p.alive = true; p.score = 0; });

  // Her oyuncuya kendi bilgileriyle tek bir event gönder
  Object.values(room.players).forEach(p => {
    const s = io.sockets.sockets.get(p.id);
    if (s) s.emit('gameStart', {
      playerId: p.id,
      playerIndex: p.index,
      color: p.color,
      name: p.name,
      players: room.players,
      chainMode: room.chainMode
    });
  });
}

function endGame(room) {
  room.gameState = 'finished';
  const lb = Object.values(room.players)
    .sort((a, b) => b.score - a.score)
    .map((p, i) => ({ name: p.name, score: p.score, place: i + 1 }));
  io.to(room.id).emit('gameOver', { leaderboard: lb });
}

const PORT = process.env.PORT || 3004;
server.listen(PORT, () => {
  console.log(`Cave Escape running on http://localhost:${PORT}`);

  // Self-ping every 14 minutes to prevent Render free tier sleep
  // RENDER_EXTERNAL_URL örn: https://cave-escape.onrender.com
  const selfUrl = process.env.RENDER_EXTERNAL_URL
    ? `https://${process.env.RENDER_EXTERNAL_URL}`
    : null;

  if (selfUrl) {
    const https = require('https');
    setInterval(() => {
      https.get(selfUrl, (res) => {
        console.log(`[keep-alive] ping OK ${res.statusCode}`);
      }).on('error', (e) => {
        console.warn('[keep-alive] ping failed:', e.message);
      });
    }, 14 * 60 * 1000);
    console.log(`[keep-alive] Self-ping aktif → ${selfUrl}`);
  }
});
