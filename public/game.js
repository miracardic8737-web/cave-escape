
// ============================================================
//  CAVE ESCAPE - Infinite Runner | Lobby | Chaser | Chain Mode
// ============================================================
'use strict';

// --- Engine globals ---
let socket, scene, camera, renderer, clock;
let myPlayer = null;
let otherPlayers = {};
let gameRunning = false;
let chainMode = false;

// Input
const keys = {};
const joystick = { active: false, dx: 0, startX: 0 };

// Network
let lastNet = 0;
const NET_RATE = 50;
let lastMinimap = 0;

// Tunnel
const TUNNEL_W = 14;
const TUNNEL_H = 9;
const CHUNK_LEN = 40;
const CHUNKS_AHEAD = 4;
let chunks = [];
let worldZ = 0;
let score = 0;

// Chaser
let chaser = null;
const CHASER_START_DIST = 18; // starts 18 units behind
const CHASER_BASE_SPEED = 0.13; // slow start

// Chain
let chainPartner = null;
let chainLine = null;
const CHAIN_MAX_DIST = 9;

// Shared materials
let matWall, matFloor, matRock, matCeil;

// Reusable vectors
const _camPos = new THREE.Vector3();
const _camLook = new THREE.Vector3();

// Lobby state
let myRoomId = null;

// ============================================================
//  LOBBY FUNCTIONS (called from HTML)
// ============================================================
function createRoom() {
  const name = document.getElementById('roomNameInput').value.trim();
  if (!name) { showLobbyMsg('Oda adı gir!'); return; }
  chainMode = document.getElementById('chainToggle').checked;
  connectSocket();
  socket.emit('createRoom', { roomName: name, chainMode });
}

function joinRoomById(roomId, roomName) {
  chainMode = document.getElementById('chainToggle').checked;
  connectSocket();
  socket.emit('joinRoom', { roomId, chainMode });
}

function setReady() {
  if (!socket) return;
  socket.emit('setReady');
  document.getElementById('readyBtn').disabled = true;
  document.getElementById('readyBtn').textContent = '✅ Hazır!';
}

function connectSocket() {
  if (socket) return;
  socket = io();
  setupSocketEvents();
}

function showLobbyMsg(msg) {
  const el = document.getElementById('lobbyMsg');
  if (el) { el.textContent = msg; el.style.opacity = 1; setTimeout(() => el.style.opacity = 0, 3000); }
}

// ============================================================
//  SOCKET EVENTS
// ============================================================
function setupSocketEvents() {
  socket.on('roomList', (rooms) => {
    renderRoomList(rooms);
  });

  socket.on('roomCreated', ({ roomId, roomName }) => {
    myRoomId = roomId;
    showWaitingRoom(roomId, roomName);
  });

  socket.on('joinedRoom', (data) => {
    myRoomId = data.roomId;
    chainMode = data.chainMode;
    showWaitingRoom(data.roomId, data.roomName, data);
    updateWaitingPlayers(data.players);
  });

  socket.on('waitingUpdate', (players) => {
    updateWaitingPlayers(players);
  });

  socket.on('playerJoinedWaiting', (p) => {
    showLobbyMsg(`${p.name} odaya katıldı!`);
  });

  socket.on('gameStart', (data) => {
    startGame(data);
  });

  socket.on('playerMoved', (data) => {
    const op = otherPlayers[data.id];
    if (!op) return;
    op.worldX = data.x;
    op.worldZ = data.z;
    op.mesh.position.set(data.x, 0.5, data.z);
  });

  socket.on('playerDied', ({ id, name }) => {
    if (otherPlayers[id]) otherPlayers[id].mesh.visible = false;
    showNotification(`💀 ${name} yakalandı!`);
  });

  socket.on('playerLeft', ({ id }) => {
    removeOtherPlayer(id);
    if (chainPartner === id) { chainPartner = null; destroyChainLine(); }
  });

  socket.on('gameOver', ({ leaderboard }) => {
    setTimeout(() => showFinishScreen(leaderboard), 1500);
  });

  socket.on('roomFull', () => showLobbyMsg('Oda dolu!'));
  socket.on('roomNotFound', () => showLobbyMsg('Oda bulunamadı!'));
}

// ============================================================
//  LOBBY UI
// ============================================================
function renderRoomList(rooms) {
  const el = document.getElementById('roomList');
  if (!el) return;
  if (rooms.length === 0) {
    el.innerHTML = '<div class="no-rooms">Henüz oda yok. İlk odayı sen oluştur!</div>';
    return;
  }
  el.innerHTML = rooms.map(r => `
    <div class="room-item">
      <div class="room-info">
        <span class="room-name">${r.name}</span>
        <span class="room-players">${r.playerCount}/${r.maxPlayers} oyuncu</span>
        <span class="room-mode">${r.chainMode ? '⛓ Zincirli' : '🚗 Serbest'}</span>
      </div>
      <button class="join-room-btn" onclick="joinRoomById('${r.id}','${r.name}')" ${r.playerCount >= r.maxPlayers ? 'disabled' : ''}>
        ${r.playerCount >= r.maxPlayers ? 'Dolu' : 'Katıl'}
      </button>
    </div>
  `).join('');
}

function showWaitingRoom(roomId, roomName, data) {
  document.getElementById('lobbyMain').style.display = 'none';
  document.getElementById('waitingRoom').style.display = 'flex';
  document.getElementById('waitingRoomName').textContent = `🏠 ${roomName}`;
  document.getElementById('waitingRoomId').textContent = `Kod: ${roomId}`;
  if (data) updateWaitingPlayers(data.players);
}

function updateWaitingPlayers(players) {
  const el = document.getElementById('waitingPlayers');
  if (!el) return;
  el.innerHTML = Object.values(players).map(p => `
    <div class="waiting-player" style="border-color:${p.color}">
      <span class="wp-dot" style="background:${p.color}"></span>
      <span>${p.name}</span>
      <span class="wp-ready">${p.ready ? '✅' : '⏳'}</span>
    </div>
  `).join('');
}

function leaveWaiting() {
  if (socket) socket.emit('leaveRoom');
  document.getElementById('waitingRoom').style.display = 'none';
  document.getElementById('lobbyMain').style.display = 'flex';
  socket.emit('getRoomList');
}

// ============================================================
//  START GAME (called when server fires gameStart)
// ============================================================
function startGame(data) {
  document.getElementById('lobby').style.display = 'none';
  document.getElementById('gameCanvas').style.display = 'block';
  document.getElementById('hud').style.display = 'block';
  if (chainMode) document.getElementById('chainIndicator').style.display = 'block';

  initThree();
  initMaterials();
  generateInitialChunks();
  spawnChaser();
  initMobileControls();

  myPlayer = {
    id: data.playerId,
    index: data.playerIndex,
    color: data.color,
    name: data.name,
    x: (data.playerIndex - 1.5) * 3,
    z: 0,
    alive: true,
    mesh: null
  };

  Object.values(data.players).forEach(p => {
    if (p.id !== data.playerId) addOtherPlayer(p);
  });

  updatePlayerList(data.players);

  // Chain pairing
  if (chainMode) {
    const others = Object.keys(data.players).filter(id => id !== data.playerId);
    if (others.length > 0) {
      chainPartner = others[0];
      createChainLine();
      showNotification(`⛓ ${data.players[chainPartner]?.name} ile zincirlendin!`);
    }
  }

  startCountdown();
  animate();
}

// ============================================================
//  THREE.JS INIT - Better graphics
// ============================================================
function initThree() {
  const isMobile = /Mobi|Android/i.test(navigator.userAgent);

  scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0x0a0400, 20, 70);
  scene.background = new THREE.Color(0x030100);

  camera = new THREE.PerspectiveCamera(68, window.innerWidth / window.innerHeight, 0.1, 90);

  renderer = new THREE.WebGLRenderer({
    canvas: document.getElementById('gameCanvas'),
    antialias: !isMobile,
    powerPreference: 'high-performance'
  });
  renderer.setPixelRatio(isMobile ? Math.min(window.devicePixelRatio, 1.5) : Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = !isMobile;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;

  clock = new THREE.Clock();

  // Better lighting setup
  const ambient = new THREE.AmbientLight(0x110800, 0.5);
  scene.add(ambient);

  const hemi = new THREE.HemisphereLight(0x331500, 0x050200, 0.4);
  scene.add(hemi);

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  window.addEventListener('keydown', e => { keys[e.code] = true; });
  window.addEventListener('keyup',   e => { keys[e.code] = false; });
}

function initMaterials() {
  matWall  = new THREE.MeshStandardMaterial({ color: 0x2a1a0c, roughness: 0.95, metalness: 0.05 });
  matFloor = new THREE.MeshStandardMaterial({ color: 0x1a0e06, roughness: 1.0,  metalness: 0.0  });
  matRock  = new THREE.MeshStandardMaterial({ color: 0x3e2e1e, roughness: 0.9,  metalness: 0.1  });
  matCeil  = new THREE.MeshStandardMaterial({ color: 0x1e1208, roughness: 1.0,  metalness: 0.0  });
}

// ============================================================
//  CHUNK GENERATION
// ============================================================
const CHUNK_TYPES = ['normal','normal','normal','narrow','rocks','zigzag','pillars','gauntlet'];

function generateInitialChunks() {
  worldZ = 0;
  chunks = [];
  for (let i = 0; i < CHUNKS_AHEAD + 2; i++) spawnChunk(i === 0 ? 'normal' : null);
}

function spawnChunk(forceType) {
  const startZ = worldZ;
  worldZ -= CHUNK_LEN;

  const difficulty = Math.min(Math.floor(score / 150), CHUNK_TYPES.length - 1);
  const pool = CHUNK_TYPES.slice(0, 3 + difficulty);
  const type = forceType || pool[Math.floor(Math.random() * pool.length)];

  const group = new THREE.Group();
  const obstacles = [];

  buildTunnelSegment(group, startZ, type);
  buildChunkObstacles(group, obstacles, startZ, type);
  addTorchToChunk(group, startZ);

  scene.add(group);
  chunks.push({ startZ, endZ: worldZ, group, obstacles, type });
}

function buildTunnelSegment(group, startZ, type) {
  const len = CHUNK_LEN;
  const w = type === 'narrow' ? TUNNEL_W * 0.52 : TUNNEL_W;
  const mid = startZ - len / 2;

  // Floor with slight variation
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(w, len, 2, 2), matFloor);
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(0, 0, mid);
  floor.receiveShadow = true;
  group.add(floor);

  // Left wall
  const wallGeo = new THREE.BoxGeometry(1.0, TUNNEL_H, len);
  const lw = new THREE.Mesh(wallGeo, matWall);
  lw.position.set(-w / 2, TUNNEL_H / 2, mid);
  lw.receiveShadow = true; lw.castShadow = true;
  group.add(lw);

  const rw = lw.clone();
  rw.position.x = w / 2;
  group.add(rw);

  // Ceiling
  const ceil = new THREE.Mesh(new THREE.PlaneGeometry(w, len), matCeil);
  ceil.rotation.x = Math.PI / 2;
  ceil.position.set(0, TUNNEL_H, mid);
  group.add(ceil);

  // Ceiling ribs (visual detail)
  for (let i = 0; i < 4; i++) {
    const ribZ = startZ - (i + 1) * (len / 5);
    const ribGeo = new THREE.BoxGeometry(w + 1.5, 0.5, 0.6);
    const rib = new THREE.Mesh(ribGeo, matWall);
    rib.position.set(0, TUNNEL_H - 0.25, ribZ);
    group.add(rib);
    // Side ribs
    const sideRibGeo = new THREE.BoxGeometry(0.6, TUNNEL_H, 0.6);
    [-w / 2 - 0.3, w / 2 + 0.3].forEach(x => {
      const sr = new THREE.Mesh(sideRibGeo, matWall);
      sr.position.set(x, TUNNEL_H / 2, ribZ);
      group.add(sr);
    });
  }

  // Stalactites
  const stalMat = new THREE.MeshStandardMaterial({ color: 0x251508, roughness: 1 });
  for (let i = 0; i < 8; i++) {
    const h = 0.6 + Math.random() * 1.8;
    const r = 0.08 + Math.random() * 0.14;
    const s = new THREE.Mesh(new THREE.ConeGeometry(r, h, 5), stalMat);
    s.position.set((Math.random() - 0.5) * (w - 2), TUNNEL_H - h / 2, startZ - 2 - Math.random() * (len - 4));
    group.add(s);
  }

  // Floor stalagmites (sides only)
  for (let i = 0; i < 4; i++) {
    const h = 0.3 + Math.random() * 0.7;
    const side = Math.random() > 0.5 ? 1 : -1;
    const sm = new THREE.Mesh(new THREE.ConeGeometry(0.1, h, 5), stalMat);
    sm.position.set(side * (w / 2 - 0.3 - Math.random() * 1.2), h / 2, startZ - Math.random() * len);
    group.add(sm);
  }
}

function addTorchToChunk(group, startZ) {
  const side = Math.random() > 0.5 ? -1 : 1;
  const tz = startZ - CHUNK_LEN * 0.4 - Math.random() * CHUNK_LEN * 0.2;
  const tx = side * (TUNNEL_W / 2 - 0.6);

  // Torch bracket
  const bracketMat = new THREE.MeshStandardMaterial({ color: 0x5a3a1a, roughness: 0.8 });
  const bracket = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.6, 0.15), bracketMat);
  bracket.position.set(tx, 3.2, tz);
  group.add(bracket);

  // Flame glow
  const flameMat = new THREE.MeshBasicMaterial({ color: 0xff9900 });
  const flame = new THREE.Mesh(new THREE.SphereGeometry(0.22, 6, 6), flameMat);
  flame.position.set(tx, 3.7, tz);
  flame.userData.flicker = Math.random() * Math.PI * 2;
  group.add(flame);

  // Point light
  const light = new THREE.PointLight(0xff6600, 1.8, 22);
  light.position.set(tx, 3.5, tz);
  light.castShadow = false;
  group.add(light);

  // Second torch on other side sometimes
  if (Math.random() > 0.5) {
    const tz2 = startZ - CHUNK_LEN * 0.7;
    const tx2 = -side * (TUNNEL_W / 2 - 0.6);
    const flame2 = flame.clone();
    flame2.position.set(tx2, 3.7, tz2);
    flame2.userData.flicker = Math.random() * Math.PI * 2;
    group.add(flame2);
    const light2 = new THREE.PointLight(0xff6600, 1.5, 20);
    light2.position.set(tx2, 3.5, tz2);
    group.add(light2);
  }
}

function buildChunkObstacles(group, obstacles, startZ, type) {
  const halfW = TUNNEL_W / 2 - 1.8;

  if (type === 'rocks') {
    for (let i = 0; i < 5; i++) {
      const r = 0.55 + Math.random() * 0.5;
      const mesh = new THREE.Mesh(new THREE.SphereGeometry(r, 7, 6), matRock);
      mesh.position.set((Math.random() - 0.5) * halfW * 1.6, r * 0.5, startZ - 5 - Math.random() * (CHUNK_LEN - 10));
      mesh.castShadow = true;
      group.add(mesh);
      obstacles.push({ mesh, radius: r + 0.55, type: 'static' });
    }
  } else if (type === 'zigzag') {
    for (let i = 0; i < 3; i++) {
      const side = i % 2 === 0 ? -1 : 1;
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(TUNNEL_W * 0.52, TUNNEL_H * 0.85, 1.4), matRock);
      mesh.position.set(side * (TUNNEL_W * 0.24), TUNNEL_H * 0.42, startZ - 8 - i * 11);
      mesh.castShadow = true;
      group.add(mesh);
      obstacles.push({ mesh, radius: 2.8, type: 'static' });
    }
  } else if (type === 'pillars') {
    for (let i = 0; i < 3; i++) {
      const x = -halfW + i * halfW + Math.random() * 1.5;
      const mesh = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.65, TUNNEL_H, 7), matRock);
      mesh.position.set(x, TUNNEL_H / 2, startZ - 10 - i * 9);
      mesh.castShadow = true;
      group.add(mesh);
      obstacles.push({ mesh, radius: 1.3, type: 'static' });
    }
  } else if (type === 'gauntlet') {
    for (let i = 0; i < 3; i++) {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(TUNNEL_W * 0.68, 0.5, 0.5), matRock);
      mesh.position.set(0, 1.5 + Math.random(), startZ - 8 - i * 12);
      mesh.userData.spin = 0.025 + Math.random() * 0.02;
      mesh.castShadow = true;
      group.add(mesh);
      obstacles.push({ mesh, radius: 3.8, type: 'spinning' });
    }
  } else if (type === 'narrow') {
    // No extra obstacles, just narrow walls
  } else {
    for (let i = 0; i < 2; i++) {
      const r = 0.45 + Math.random() * 0.4;
      const mesh = new THREE.Mesh(new THREE.SphereGeometry(r, 7, 6), matRock);
      mesh.position.set((Math.random() - 0.5) * halfW * 1.7, r * 0.5, startZ - 8 - Math.random() * (CHUNK_LEN - 16));
      group.add(mesh);
      obstacles.push({ mesh, radius: r + 0.45, type: 'static' });
    }
  }
}

// ============================================================
//  CHASER - Better visuals, balanced speed
// ============================================================
function spawnChaser() {
  const group = new THREE.Group();

  // Main body - more detailed
  const bodyMat = new THREE.MeshStandardMaterial({ color: 0xcc0000, roughness: 0.3, metalness: 0.7, emissive: 0x330000 });
  const body = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.7, 4.0), bodyMat);
  body.position.y = 0.55;
  body.castShadow = true;
  group.add(body);

  // Cabin
  const cabinMat = new THREE.MeshStandardMaterial({ color: 0x1a0000, roughness: 0.4, metalness: 0.5 });
  const cabin = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.55, 2.0), cabinMat);
  cabin.position.set(0, 1.15, -0.3);
  group.add(cabin);

  // Bumper spikes
  const spikeMat = new THREE.MeshStandardMaterial({ color: 0x888888, roughness: 0.3, metalness: 0.9 });
  for (let i = -1; i <= 1; i++) {
    const spike = new THREE.Mesh(new THREE.ConeGeometry(0.12, 0.5, 5), spikeMat);
    spike.rotation.x = -Math.PI / 2;
    spike.position.set(i * 0.6, 0.55, 2.3);
    group.add(spike);
  }

  // Wheels
  const wGeo = new THREE.CylinderGeometry(0.36, 0.36, 0.3, 10);
  const wMat = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.9 });
  [[-1.1, 1.3], [1.1, 1.3], [-1.1, -1.3], [1.1, -1.3]].forEach(([x, z]) => {
    const w = new THREE.Mesh(wGeo, wMat);
    w.rotation.z = Math.PI / 2;
    w.position.set(x, 0.36, z);
    group.add(w);
  });

  // Red headlights
  const hlMat = new THREE.MeshBasicMaterial({ color: 0xff2200 });
  [-0.7, 0.7].forEach(x => {
    const hl = new THREE.Mesh(new THREE.SphereGeometry(0.14, 6, 6), hlMat);
    hl.position.set(x, 0.55, 2.1);
    group.add(hl);
  });

  // Menacing red light
  const redLight = new THREE.PointLight(0xff0000, 2.5, 16);
  redLight.position.set(0, 1, 2.5);
  group.add(redLight);

  // Exhaust smoke effect (simple dark spheres)
  const smokeMat = new THREE.MeshBasicMaterial({ color: 0x222222, transparent: true, opacity: 0.4 });
  [-0.5, 0.5].forEach(x => {
    const smoke = new THREE.Mesh(new THREE.SphereGeometry(0.2, 4, 4), smokeMat);
    smoke.position.set(x, 0.6, -2.2);
    smoke.userData.isSmoke = true;
    group.add(smoke);
  });

  group.position.set(0, 0, CHASER_START_DIST);
  scene.add(group);

  chaser = { mesh: group, x: 0, z: CHASER_START_DIST, wobble: 0 };
}

function updateChaser() {
  if (!chaser || !myPlayer || !gameRunning) return;

  // Speed: starts slow, gradually increases with score
  const speed = CHASER_BASE_SPEED + score * 0.00015;

  chaser.z -= speed;
  chaser.wobble += 0.035;
  chaser.x = Math.sin(chaser.wobble) * 2.0;

  chaser.mesh.position.set(chaser.x, 0, chaser.z);
  chaser.mesh.rotation.y = Math.sin(chaser.wobble * 0.5) * 0.12;

  // Flicker exhaust
  chaser.mesh.children.forEach(c => {
    if (c.userData.isSmoke) {
      c.material.opacity = 0.2 + Math.random() * 0.3;
      c.position.z = -2.2 - Math.random() * 0.5;
    }
  });

  const dist = Math.max(0, Math.round(myPlayer.z - chaser.z));
  const distEl = document.getElementById('chaserDist');
  if (distEl) {
    distEl.textContent = `👹 ${dist}m`;
    distEl.style.color = dist < 12 ? '#ff3333' : dist < 25 ? '#ffaa00' : '#44ff88';
  }

  if (dist < 2.5 && myPlayer.alive) playerCaught();
}

function playerCaught() {
  if (!myPlayer.alive) return;
  myPlayer.alive = false;
  gameRunning = false;
  showNotification('💀 Yakalandın!');
  socket.emit('playerDied', { score });
  setTimeout(showDeathScreen, 1500);
}

// ============================================================
//  CAR MESH - Better quality
// ============================================================
function createCarMesh(color) {
  const group = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.35, metalness: 0.65 });
  const darkMat = new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.4, metalness: 0.5 });
  const glassMat = new THREE.MeshStandardMaterial({ color: 0x334455, roughness: 0.1, metalness: 0.3, transparent: true, opacity: 0.7 });

  // Body
  const body = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.62, 3.4), mat);
  body.position.y = 0.5;
  body.castShadow = true;
  group.add(body);

  // Hood slope
  const hood = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.18, 1.0), mat);
  hood.position.set(0, 0.88, 0.9);
  hood.rotation.x = 0.15;
  group.add(hood);

  // Cabin
  const cabin = new THREE.Mesh(new THREE.BoxGeometry(1.25, 0.52, 1.7), darkMat);
  cabin.position.set(0, 1.05, -0.15);
  group.add(cabin);

  // Windshield
  const wind = new THREE.Mesh(new THREE.BoxGeometry(1.15, 0.42, 0.08), glassMat);
  wind.position.set(0, 1.0, 0.7);
  wind.rotation.x = -0.3;
  group.add(wind);

  // Wheels
  const wGeo = new THREE.CylinderGeometry(0.32, 0.32, 0.28, 10);
  const wMat = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.9 });
  const rimMat = new THREE.MeshStandardMaterial({ color: 0x888888, roughness: 0.3, metalness: 0.8 });
  [[-0.92, 1.1], [0.92, 1.1], [-0.92, -1.1], [0.92, -1.1]].forEach(([x, z]) => {
    const w = new THREE.Mesh(wGeo, wMat);
    w.rotation.z = Math.PI / 2;
    w.position.set(x, 0.32, z);
    group.add(w);
    // Rim
    const rim = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.18, 0.3, 6), rimMat);
    rim.rotation.z = Math.PI / 2;
    rim.position.set(x, 0.32, z);
    group.add(rim);
  });

  // Headlights
  const hlMat = new THREE.MeshBasicMaterial({ color: 0xffffcc });
  [-0.55, 0.55].forEach(x => {
    const hl = new THREE.Mesh(new THREE.SphereGeometry(0.1, 6, 6), hlMat);
    hl.position.set(x, 0.52, 1.72);
    group.add(hl);
  });

  // Headlight beam
  const beam = new THREE.PointLight(0xffffaa, 1.2, 18);
  beam.position.set(0, 0.8, 2.2);
  group.add(beam);

  return group;
}

// ============================================================
//  PLAYER MANAGEMENT
// ============================================================
function addOtherPlayer(p) {
  if (otherPlayers[p.id]) return;
  const mesh = createCarMesh(p.color);
  mesh.position.set(p.position?.x || 0, 0.5, p.position?.z || 0);
  scene.add(mesh);
  otherPlayers[p.id] = { mesh, data: p, worldX: 0, worldZ: 0 };
}

function removeOtherPlayer(id) {
  if (otherPlayers[id]) { scene.remove(otherPlayers[id].mesh); delete otherPlayers[id]; }
}

// ============================================================
//  CHAIN SYSTEM
// ============================================================
function createChainLine() {
  if (chainLine) scene.remove(chainLine);
  const pts = [new THREE.Vector3(), new THREE.Vector3()];
  const geo = new THREE.BufferGeometry().setFromPoints(pts);
  const mat = new THREE.LineBasicMaterial({ color: 0xffaa00 });
  chainLine = new THREE.Line(geo, mat);
  scene.add(chainLine);
}

function destroyChainLine() {
  if (chainLine) { scene.remove(chainLine); chainLine = null; }
}

function updateChain() {
  if (!chainMode || !chainPartner || !myPlayer?.mesh) return;
  const op = otherPlayers[chainPartner];
  if (!op) return;

  const mp = myPlayer.mesh.position;
  const op2 = op.mesh.position;

  if (chainLine) {
    const pos = chainLine.geometry.attributes.position;
    pos.setXYZ(0, mp.x, mp.y + 0.5, mp.z);
    pos.setXYZ(1, op2.x, op2.y + 0.5, op2.z);
    pos.needsUpdate = true;
  }

  const dist = Math.sqrt((mp.x - op2.x) ** 2 + (mp.z - op2.z) ** 2);
  if (dist > CHAIN_MAX_DIST) {
    const pull = (dist - CHAIN_MAX_DIST) * 0.04;
    myPlayer.x += (op2.x - mp.x) / dist * pull;
    myPlayer.z += (op2.z - mp.z) / dist * pull;
    showNotification('⛓ Zincir geriliyor! Takımını bekle!');
  }
}

// ============================================================
//  PHYSICS - Balanced speed
// ============================================================
const BASE_SPEED = 0.14;      // comfortable starting speed
const MAX_LATERAL = 0.16;
const LATERAL_ACCEL = 0.014;
const LATERAL_FRICTION = 0.009;

let lateralSpeed = 0;
let wheelRotation = 0;

function updateCar() {
  if (!myPlayer || !gameRunning || !myPlayer.alive) return;

  const left  = keys['ArrowLeft']  || keys['KeyA'] || joystick.dx < -0.2;
  const right = keys['ArrowRight'] || keys['KeyD'] || joystick.dx > 0.2;
  const gasHeld   = keys['mobile_gas'];
  const brakeHeld = keys['mobile_brake'];

  // Forward speed: gentle ramp-up, gas boosts, brake slows
  let forwardSpeed = BASE_SPEED + Math.min(score * 0.00012, 0.18);
  if (gasHeld)   forwardSpeed = Math.min(forwardSpeed * 1.5, BASE_SPEED * 2.2);
  if (brakeHeld) forwardSpeed = Math.max(forwardSpeed * 0.3, 0.02);
  // Lateral
  if (left)       lateralSpeed = Math.max(lateralSpeed - LATERAL_ACCEL, -MAX_LATERAL);
  else if (right) lateralSpeed = Math.min(lateralSpeed + LATERAL_ACCEL,  MAX_LATERAL);
  else {
    if (Math.abs(lateralSpeed) < LATERAL_FRICTION) lateralSpeed = 0;
    else lateralSpeed -= Math.sign(lateralSpeed) * LATERAL_FRICTION;
  }

  myPlayer.z -= forwardSpeed;
  myPlayer.x += lateralSpeed;

  // Wall clamp
  const halfW = TUNNEL_W / 2 - 1.3;
  if (myPlayer.x < -halfW) { myPlayer.x = -halfW; lateralSpeed *= -0.4; }
  if (myPlayer.x >  halfW) { myPlayer.x =  halfW; lateralSpeed *= -0.4; }

  // Obstacle collision
  const chunk = chunks.find(c => myPlayer.z <= c.startZ && myPlayer.z > c.endZ);
  if (chunk) {
    for (const obs of chunk.obstacles) {
      const ox = obs.mesh.position.x;
      const oz = obs.mesh.position.z;
      const d = Math.sqrt((myPlayer.x - ox) ** 2 + (myPlayer.z - oz) ** 2);
      if (d < obs.radius) {
        lateralSpeed = -lateralSpeed * 0.7;
        myPlayer.x += lateralSpeed * 2;
        break;
      }
    }
  }

  score = Math.floor(Math.abs(myPlayer.z));
  document.getElementById('scoreVal').textContent = score + 'm';

  if (myPlayer.mesh) {
    myPlayer.mesh.position.set(myPlayer.x, 0.5, myPlayer.z);
    myPlayer.mesh.rotation.z = -lateralSpeed * 2.5;
    myPlayer.mesh.rotation.y = 0;

    // Animate wheels
    wheelRotation += forwardSpeed * 3;
    myPlayer.mesh.children.forEach(c => {
      if (c.geometry?.type === 'CylinderGeometry' && c.rotation.z !== 0) {
        c.rotation.x = wheelRotation;
      }
    });
  }

  updateChain();
  manageChunks();
  animateFlames();

  const now = Date.now();
  if (now - lastNet > NET_RATE) {
    lastNet = now;
    socket.emit('playerUpdate', { x: myPlayer.x, z: myPlayer.z, ry: 0 });
  }

  document.getElementById('speedValue').textContent = Math.round(forwardSpeed * 280);
}

function manageChunks() {
  const pz = myPlayer.z;
  while (worldZ > pz - CHUNKS_AHEAD * CHUNK_LEN) spawnChunk(null);
  chunks = chunks.filter(c => {
    if (c.startZ > pz + CHUNK_LEN * 2) { scene.remove(c.group); return false; }
    return true;
  });
}

function animateFlames() {
  const t = Date.now() * 0.004;
  chunks.forEach(chunk => {
    chunk.group.children.forEach(c => {
      if (c.userData.flicker !== undefined) {
        const s = 0.85 + Math.sin(t + c.userData.flicker) * 0.15;
        c.scale.set(s, s + Math.random() * 0.1, s);
      }
    });
  });
}

function animateObstacles() {
  chunks.forEach(chunk => {
    chunk.obstacles.forEach(obs => {
      if (obs.type === 'spinning') obs.mesh.rotation.y += obs.mesh.userData.spin || 0.025;
    });
  });
}

// ============================================================
//  CAMERA
// ============================================================
function updateCamera() {
  if (!myPlayer?.mesh) return;
  const pos = myPlayer.mesh.position;
  _camPos.set(pos.x * 0.4, pos.y + 4.5, pos.z + 9);
  camera.position.lerp(_camPos, 0.1);
  _camLook.set(pos.x * 0.6, pos.y + 0.8, pos.z - 6);
  camera.lookAt(_camLook);
}

// ============================================================
//  MINIMAP
// ============================================================
function updateMinimap() {
  const now = Date.now();
  if (now - lastMinimap < 120) return;
  lastMinimap = now;

  const canvas = document.getElementById('minimapCanvas');
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#0a0500'; ctx.fillRect(0, 0, W, H);

  const tx = W * 0.2, tw = W * 0.6;
  ctx.fillStyle = '#1a0e06'; ctx.fillRect(tx, 0, tw, H);
  ctx.strokeStyle = '#3a2010'; ctx.lineWidth = 1;
  ctx.strokeRect(tx, 0, tw, H);

  // Chaser
  if (chaser && myPlayer) {
    const relZ = chaser.z - myPlayer.z;
    const cy = H * 0.75 + relZ * 0.4;
    if (cy > 0 && cy < H) {
      ctx.fillStyle = '#ff2200';
      ctx.beginPath(); ctx.arc(W / 2, cy, 6, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#ff6600';
      ctx.beginPath(); ctx.arc(W / 2, cy, 3, 0, Math.PI * 2); ctx.fill();
    }
  }

  // Other players
  Object.values(otherPlayers).forEach(op => {
    if (!myPlayer) return;
    const relZ = op.worldZ - myPlayer.z;
    const py = H * 0.5 + relZ * 0.3;
    const px = tx + ((op.worldX + TUNNEL_W / 2) / TUNNEL_W) * tw;
    if (py > 0 && py < H) {
      ctx.fillStyle = op.data.color;
      ctx.beginPath(); ctx.arc(px, py, 4, 0, Math.PI * 2); ctx.fill();
    }
  });

  // My player
  if (myPlayer) {
    const px = tx + ((myPlayer.x + TUNNEL_W / 2) / TUNNEL_W) * tw;
    ctx.fillStyle = myPlayer.color || '#fff';
    ctx.beginPath(); ctx.arc(px, H * 0.5, 5, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.stroke();
  }
}

// ============================================================
//  COUNTDOWN
// ============================================================
function startCountdown() {
  const el = document.getElementById('countdown');
  el.style.display = 'flex';
  let count = 3;
  const tick = () => {
    el.textContent = count > 0 ? count : 'KAÇIŞA BAŞLA!';
    el.style.animation = 'none'; void el.offsetWidth; el.style.animation = 'pulse 0.5s ease-in-out';
    if (count === 0) { gameRunning = true; setTimeout(() => { el.style.display = 'none'; }, 900); }
    else { count--; setTimeout(tick, 1000); }
  };
  tick();
}

// ============================================================
//  MOBILE CONTROLS - Pedals + Steer buttons
// ============================================================
function initMobileControls() {
  const el = document.getElementById('mobileControls');
  if (!el) return;
  // Her zaman göster — CSS media query masaüstünde gizler
  el.style.display = 'flex';

  function bindBtn(id, keyOn, keyOff) {
    const el = document.getElementById(id);
    if (!el) return;
    const on  = e => { e.preventDefault(); keys[keyOn] = true;  if (keyOff) keys[keyOff] = false; };
    const off = e => { e.preventDefault(); keys[keyOn] = false; };
    el.addEventListener('touchstart',  on,  { passive: false });
    el.addEventListener('touchend',    off, { passive: false });
    el.addEventListener('touchcancel', off, { passive: false });
  }

  bindBtn('btnLeft',  'ArrowLeft',  'ArrowRight');
  bindBtn('btnRight', 'ArrowRight', 'ArrowLeft');
  bindBtn('btnGas',   'mobile_gas',   null);
  bindBtn('btnBrake', 'mobile_brake', null);
}

// ============================================================
//  HUD
// ============================================================
function updatePlayerList(players) {
  const el = document.getElementById('playerList');
  if (!el) return;
  el.innerHTML = '';
  Object.values(players).forEach(p => {
    const div = document.createElement('div');
    div.className = 'player-entry';
    div.style.borderColor = p.color;
    div.textContent = p.name;
    el.appendChild(div);
  });
}

let notifTimeout;
function showNotification(msg) {
  const el = document.getElementById('notification');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(notifTimeout);
  notifTimeout = setTimeout(() => el.classList.remove('show'), 2500);
}

function showDeathScreen() {
  document.getElementById('deathScore').textContent = score + 'm';
  document.getElementById('deathScreen').style.display = 'flex';
}

function showFinishScreen(leaderboard) {
  const medals = ['🥇', '🥈', '🥉', '4️⃣'];
  const lb = document.getElementById('leaderboard');
  lb.innerHTML = '';
  leaderboard.forEach((entry, i) => {
    const div = document.createElement('div');
    div.className = 'lb-entry';
    div.innerHTML = `<span class="lb-place">${medals[i] || i + 1}</span><span class="lb-name">${entry.name}</span><span class="lb-time">${entry.score}m</span>`;
    lb.appendChild(div);
  });
  document.getElementById('finishScreen').style.display = 'flex';
}

// ============================================================
//  MAIN LOOP
// ============================================================
let frameCount = 0;

function animate() {
  requestAnimationFrame(animate);
  frameCount++;

  if (myPlayer && !myPlayer.mesh) {
    myPlayer.mesh = createCarMesh(myPlayer.color || '#ff4444');
    myPlayer.mesh.position.set(myPlayer.x, 0.5, myPlayer.z);
    scene.add(myPlayer.mesh);
  }

  updateCar();
  updateChaser();
  updateCamera();
  animateObstacles();

  if (frameCount % 6 === 0) updateMinimap();

  renderer.render(scene, camera);
}

// ============================================================
//  INIT: Request room list on page load
// ============================================================
window.addEventListener('load', () => {
  // Connect socket early to get room list
  connectSocket();
  socket.on('connect', () => socket.emit('getRoomList'));
});
