const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  transports: ['websocket', 'polling']
});

app.use(express.static(path.join(__dirname, 'public')));

const COLORS = ['#ff4444', '#44ff88', '#4488ff', '#ffff44'];
const NAMES  = ['Kırmızı', 'Yeşil', 'Mavi', 'Sarı'];
const rooms  = {};

function getRoomList() {
  return Object.values(rooms)
    .filter(r => r.state === 'waiting')
    .map(r => ({ id: r.id, name: r.name, count: Object.keys(r.players).length, chainMode: r.chainMode }));
}

io.on('connection', socket => {
  socket.emit('roomList', getRoomList());

  socket.on('getRoomList', () => socket.emit('roomList', getRoomList()));

  socket.on('createRoom', ({ name, chainMode }) => {
    const id = 'r' + Date.now();
    rooms[id] = { id, name: name || 'Oda', state: 'waiting', players: {}, chainMode: !!chainMode };
    addToRoom(socket, id);
    io.emit('roomList', getRoomList());
  });

  socket.on('joinRoom', ({ roomId, chainMode }) => {
    const room = rooms[roomId];
    if (!room || room.state !== 'waiting' || Object.keys(room.players).length >= 4) {
      socket.emit('err', 'Odaya girilemiyor'); return;
    }
    addToRoom(socket, roomId);
  });

  socket.on('ready', () => {
    const room = rooms[socket.roomId];
    if (!room) return;
    room.players[socket.id].ready = true;
    io.to(socket.roomId).emit('waitingUpdate', Object.values(room.players));
    const all = Object.values(room.players);
    if (all.length >= 1 && all.every(p => p.ready)) startGame(room);
  });

  socket.on('move', data => {
    const room = rooms[socket.roomId];
    if (!room || room.state !== 'playing') return;
    socket.to(socket.roomId).emit('playerMoved', { id: socket.id, x: data.x, z: data.z });
    if (room.players[socket.id]) {
      room.players[socket.id].x = data.x;
      room.players[socket.id].z = data.z;
    }
  });

  socket.on('died', score => {
    const room = rooms[socket.roomId];
    if (!room) return;
    if (room.players[socket.id]) room.players[socket.id].score = score;
    socket.to(socket.roomId).emit('playerDied', { id: socket.id, name: room.players[socket.id]?.name });
    const alive = Object.values(room.players).filter(p => !p.score);
    if (alive.length === 0) endGame(room);
  });

  socket.on('disconnect', () => {
    const room = rooms[socket.roomId];
    if (!room) return;
    delete room.players[socket.id];
    socket.to(socket.roomId).emit('playerLeft', socket.id);
    io.to(socket.roomId).emit('waitingUpdate', Object.values(room.players));
    if (Object.keys(room.players).length === 0) delete rooms[socket.roomId];
    io.emit('roomList', getRoomList());
  });
});

function addToRoom(socket, roomId) {
  const room = rooms[roomId];
  const idx  = Object.keys(room.players).length;
  room.players[socket.id] = { id: socket.id, idx, name: NAMES[idx], color: COLORS[idx], ready: false, score: 0 };
  socket.join(roomId);
  socket.roomId = roomId;
  socket.emit('joined', { roomId, roomName: room.name, chainMode: room.chainMode, me: room.players[socket.id], players: Object.values(room.players) });
  socket.to(roomId).emit('playerJoined', room.players[socket.id]);
  io.to(roomId).emit('waitingUpdate', Object.values(room.players));
}

function startGame(room) {
  room.state = 'playing';
  Object.values(room.players).forEach(p => {
    const s = io.sockets.sockets.get(p.id);
    if (s) s.emit('start', { me: p, players: Object.values(room.players), chainMode: room.chainMode });
  });
}

function endGame(room) {
  room.state = 'finished';
  const lb = Object.values(room.players).sort((a, b) => b.score - a.score);
  io.to(room.id).emit('gameOver', lb);
}

const PORT = process.env.PORT || 3004;
server.listen(PORT, () => {
  console.log('Cave Escape on port', PORT);
  if (process.env.RENDER_EXTERNAL_URL) {
    const https = require('https');
    setInterval(() => {
      https.get('https://' + process.env.RENDER_EXTERNAL_URL, () => {}).on('error', () => {});
    }, 14 * 60 * 1000);
  }
});
