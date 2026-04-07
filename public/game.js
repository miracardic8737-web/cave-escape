
'use strict';
// ── globals ──────────────────────────────────────────────────
let socket, scene, camera, renderer, clock;
let me = null;          // { idx, color, name, x, z, alive }
let others = {};        // id -> { mesh, x, z }
let chaser = null;      // { mesh, x, z }
let chunks = [];
let worldZ = 0;
let score  = 0;
let running = false;
let chainMode = false;
let chainPartner = null;
let chainLine = null;

const K = {};           // pressed keys
const TW = 14, TH = 9, CL = 40;
const BASE_SPD = 0.13, MAX_LAT = 0.16, LAT_ACC = 0.013, LAT_FRI = 0.009;
let latSpd = 0;

// reusable
const _cp = new THREE.Vector3();
const _cl = new THREE.Vector3();

// ── socket ───────────────────────────────────────────────────
function initSocket() {
  socket = io();

  socket.on('roomList',      renderRooms);
  socket.on('joined',        onJoined);
  socket.on('playerJoined',  p => { notify(p.name + ' katıldı'); });
  socket.on('waitingUpdate', updateWaiting);
  socket.on('playerLeft',    id => removeOther(id));
  socket.on('start',         onStart);
  socket.on('playerMoved',   d => { if (others[d.id]) { others[d.id].x = d.x; others[d.id].mesh.position.set(d.x, .5, d.z); } });
  socket.on('playerDied',    d => { if (others[d.id]) others[d.id].mesh.visible = false; notify('💀 ' + d.name + ' yakalandı'); });
  socket.on('gameOver',      showEnd);
  socket.on('err',           m => lobbyMsg(m));
}

// ── lobby ─────────────────────────────────────────────────────
function createRoom() {
  const name = document.getElementById('roomName').value.trim() || 'Oda';
  chainMode = document.getElementById('chainToggle').checked;
  socket.emit('createRoom', { name, chainMode });
}

function joinRoomById(id) {
  chainMode = document.getElementById('chainToggle').checked;
  socket.emit('joinRoom', { roomId: id, chainMode });
}

function setReady() {
  socket.emit('ready');
  document.getElementById('readyBtn').disabled = true;
  document.getElementById('readyBtn').textContent = '✅ Hazır!';
}

function leaveRoom() {
  socket.emit('disconnect');
  location.reload();
}

function lobbyMsg(m) {
  const el = document.getElementById('lobbyMsg');
  el.textContent = m;
  setTimeout(() => el.textContent = '', 3000);
}

function renderRooms(list) {
  const el = document.getElementById('roomList');
  if (!list.length) { el.innerHTML = '<p class="dim">Henüz oda yok</p>'; return; }
  el.innerHTML = list.map(r => `
    <div class="ri">
      <div><b>${r.name}</b> <span style="color:#888;font-size:.75rem">${r.count}/4 ${r.chainMode ? '⛓' : ''}</span></div>
      <button onclick="joinRoomById('${r.id}')" ${r.count >= 4 ? 'disabled' : ''}>${r.count >= 4 ? 'Dolu' : 'Katıl'}</button>
    </div>`).join('');
}

function onJoined(data) {
  document.getElementById('lobbyMain').style.display = 'none';
  document.getElementById('waitingRoom').style.display = 'flex';
  document.getElementById('wRoomName').textContent = '🏠 ' + data.roomName;
  chainMode = data.chainMode;
  updateWaiting(data.players);
}

function updateWaiting(players) {
  document.getElementById('wPlayers').innerHTML = players.map(p =>
    `<div class="wp" style="border-color:${p.color}">
       <span style="width:10px;height:10px;border-radius:50%;background:${p.color};display:inline-block"></span>
       <span>${p.name}</span>
       <span style="margin-left:auto">${p.ready ? '✅' : '⏳'}</span>
     </div>`).join('');
}

// ── game start ────────────────────────────────────────────────
function onStart(data) {
  // hide lobby, show game
  document.getElementById('lobby').style.display = 'none';
  document.getElementById('hud').style.display = 'block';
  document.getElementById('c').style.display = 'block';

  // show mobile controls
  document.getElementById('mctrl').style.display = 'flex';

  me = { idx: data.me.idx, color: data.me.color, name: data.me.name,
         x: (data.me.idx - 1.5) * 3, z: 0, alive: true };

  chainMode = data.chainMode;

  initThree();
  buildMaterials();
  genChunks();
  spawnChaser();
  bindMobile();

  // other players
  data.players.forEach(p => { if (p.id !== socket.id) addOther(p); });
  renderPlist(data.players);

  // chain partner
  if (chainMode) {
    const op = data.players.find(p => p.id !== socket.id);
    if (op) { chainPartner = op.id; makeChainLine(); notify('⛓ ' + op.name + ' ile zincirlendin!'); }
  }

  countdown();
  loop();
}

// ── three.js ─────────────────────────────────────────────────
let matW, matF, matR;

function initThree() {
  const mob = /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent);
  scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0x0a0400, 18, 65);
  scene.background = new THREE.Color(0x030100);

  camera = new THREE.PerspectiveCamera(68, innerWidth / innerHeight, .1, 80);

  renderer = new THREE.WebGLRenderer({ canvas: document.getElementById('c'), antialias: !mob, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(devicePixelRatio, mob ? 1.5 : 2));
  renderer.setSize(innerWidth, innerHeight);
  renderer.shadowMap.enabled = false;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;

  clock = new THREE.Clock();

  scene.add(new THREE.AmbientLight(0x110800, .6));
  scene.add(new THREE.HemisphereLight(0x331500, 0x050200, .45));

  window.addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
  });

  window.addEventListener('keydown', e => K[e.code] = true);
  window.addEventListener('keyup',   e => K[e.code] = false);
}

function buildMaterials() {
  matW = new THREE.MeshStandardMaterial({ color: 0x2a1a0c, roughness: .95 });
  matF = new THREE.MeshStandardMaterial({ color: 0x1a0e06, roughness: 1 });
  matR = new THREE.MeshStandardMaterial({ color: 0x3e2e1e, roughness: .9 });
}

// ── chunks ────────────────────────────────────────────────────
const TYPES = ['normal','normal','normal','narrow','rocks','zigzag','pillars','gauntlet'];

function genChunks() { worldZ = 0; chunks = []; for (let i = 0; i < 6; i++) addChunk(i === 0 ? 'normal' : null); }

function addChunk(force) {
  const z0 = worldZ; worldZ -= CL;
  const diff = Math.min(Math.floor(score / 150), TYPES.length - 1);
  const pool = TYPES.slice(0, 3 + diff);
  const type = force || pool[Math.floor(Math.random() * pool.length)];
  const g = new THREE.Group();
  const obs = [];
  buildTunnel(g, z0, type);
  buildObs(g, obs, z0, type);
  addTorch(g, z0);
  scene.add(g);
  chunks.push({ z0, z1: worldZ, g, obs, type });
}

function buildTunnel(g, z0, type) {
  const w = type === 'narrow' ? TW * .52 : TW;
  const mid = z0 - CL / 2;
  const fl = new THREE.Mesh(new THREE.PlaneGeometry(w, CL), matF);
  fl.rotation.x = -Math.PI / 2; fl.position.set(0, 0, mid); g.add(fl);
  const wg = new THREE.BoxGeometry(1, TH, CL);
  const lw = new THREE.Mesh(wg, matW); lw.position.set(-w/2, TH/2, mid); g.add(lw);
  const rw = lw.clone(); rw.position.x = w/2; g.add(rw);
  const cl = new THREE.Mesh(new THREE.PlaneGeometry(w, CL), matW);
  cl.rotation.x = Math.PI/2; cl.position.set(0, TH, mid); g.add(cl);
  // ribs
  for (let i = 1; i <= 3; i++) {
    const rz = z0 - i * (CL/4);
    const rib = new THREE.Mesh(new THREE.BoxGeometry(w+1.2, .4, .5), matW);
    rib.position.set(0, TH-.2, rz); g.add(rib);
  }
  // stalactites
  const sm = new THREE.MeshStandardMaterial({ color: 0x251508, roughness: 1 });
  for (let i = 0; i < 7; i++) {
    const h = .5 + Math.random() * 1.6;
    const s = new THREE.Mesh(new THREE.ConeGeometry(.1 + Math.random()*.12, h, 5), sm);
    s.position.set((Math.random()-.5)*(w-2), TH-h/2, z0-2-Math.random()*(CL-4)); g.add(s);
  }
}

function addTorch(g, z0) {
  const side = Math.random() > .5 ? -1 : 1;
  const tz = z0 - CL*.45 - Math.random()*CL*.1;
  const tx = side*(TW/2-.6);
  const fm = new THREE.MeshBasicMaterial({ color: 0xff9900 });
  const fl = new THREE.Mesh(new THREE.SphereGeometry(.2, 5, 5), fm);
  fl.position.set(tx, 3.7, tz); fl.userData.flicker = Math.random()*Math.PI*2; g.add(fl);
  const pl = new THREE.PointLight(0xff6600, 1.6, 22);
  pl.position.set(tx, 3.4, tz); g.add(pl);
}

function buildObs(g, obs, z0, type) {
  const hw = TW/2-1.8;
  if (type === 'rocks') {
    for (let i = 0; i < 5; i++) {
      const r = .55+Math.random()*.45;
      const m = new THREE.Mesh(new THREE.SphereGeometry(r,6,5), matR);
      m.position.set((Math.random()-.5)*hw*1.6, r*.5, z0-5-Math.random()*(CL-10)); g.add(m);
      obs.push({ m, r: r+.55 });
    }
  } else if (type === 'zigzag') {
    for (let i = 0; i < 3; i++) {
      const s = i%2===0?-1:1;
      const m = new THREE.Mesh(new THREE.BoxGeometry(TW*.52,TH*.85,1.3), matR);
      m.position.set(s*TW*.24, TH*.42, z0-8-i*11); g.add(m); obs.push({ m, r: 2.8 });
    }
  } else if (type === 'pillars') {
    for (let i = 0; i < 3; i++) {
      const x = -hw+i*hw+Math.random()*1.5;
      const m = new THREE.Mesh(new THREE.CylinderGeometry(.55,.65,TH,7), matR);
      m.position.set(x, TH/2, z0-10-i*9); g.add(m); obs.push({ m, r: 1.3 });
    }
  } else if (type === 'gauntlet') {
    for (let i = 0; i < 3; i++) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(TW*.68,.5,.5), matR);
      m.position.set(0, 1.5+Math.random(), z0-8-i*12);
      m.userData.spin = .025+Math.random()*.02; g.add(m); obs.push({ m, r: 3.8, spin: true });
    }
  } else if (type !== 'narrow') {
    for (let i = 0; i < 2; i++) {
      const r = .45+Math.random()*.4;
      const m = new THREE.Mesh(new THREE.SphereGeometry(r,6,5), matR);
      m.position.set((Math.random()-.5)*hw*1.7, r*.5, z0-8-Math.random()*(CL-16)); g.add(m);
      obs.push({ m, r: r+.45 });
    }
  }
}

// ── chaser ────────────────────────────────────────────────────
function spawnChaser() {
  const g = new THREE.Group();
  const bm = new THREE.MeshStandardMaterial({ color: 0xcc0000, roughness: .3, metalness: .7, emissive: 0x330000 });
  const body = new THREE.Mesh(new THREE.BoxGeometry(2, .7, 4), bm);
  body.position.y = .55; g.add(body);
  const cm = new THREE.MeshStandardMaterial({ color: 0x1a0000, roughness: .4 });
  const cab = new THREE.Mesh(new THREE.BoxGeometry(1.5, .55, 2), cm);
  cab.position.set(0, 1.15, -.3); g.add(cab);
  const wm = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: .9 });
  const wg = new THREE.CylinderGeometry(.36,.36,.3,8);
  [[-1.1,1.3],[1.1,1.3],[-1.1,-1.3],[1.1,-1.3]].forEach(([x,z]) => {
    const w = new THREE.Mesh(wg, wm); w.rotation.z = Math.PI/2; w.position.set(x,.36,z); g.add(w);
  });
  const hl = new THREE.MeshBasicMaterial({ color: 0xff2200 });
  [-0.7,0.7].forEach(x => { const h = new THREE.Mesh(new THREE.SphereGeometry(.13,5,5),hl); h.position.set(x,.55,2.1); g.add(h); });
  const rl = new THREE.PointLight(0xff0000, 2.5, 16); rl.position.set(0,1,2.5); g.add(rl);
  g.position.set(0, 0, 18);
  scene.add(g);
  chaser = { mesh: g, x: 0, z: 18, w: 0 };
}

function tickChaser() {
  if (!chaser || !me || !running) return;
  const spd = .13 + score * .00015;
  chaser.z -= spd;
  chaser.w += .035;
  chaser.x = Math.sin(chaser.w) * 2;
  chaser.mesh.position.set(chaser.x, 0, chaser.z);
  chaser.mesh.rotation.y = Math.sin(chaser.w*.5)*.12;
  const dist = Math.max(0, Math.round(me.z - chaser.z));
  const el = document.getElementById('chaser');
  el.textContent = '👹 ' + dist + 'm';
  el.style.color = dist < 12 ? '#ff3333' : dist < 25 ? '#ffaa00' : '#44ff88';
  if (dist < 2.5 && me.alive) die();
}

// ── car mesh ──────────────────────────────────────────────────
function makeCar(color) {
  const g = new THREE.Group();
  const bm = new THREE.MeshStandardMaterial({ color, roughness: .35, metalness: .65 });
  const dm = new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: .4 });
  const body = new THREE.Mesh(new THREE.BoxGeometry(1.6,.62,3.4), bm); body.position.y = .5; g.add(body);
  const cab  = new THREE.Mesh(new THREE.BoxGeometry(1.25,.52,1.7), dm); cab.position.set(0,1.05,-.15); g.add(cab);
  const wg = new THREE.CylinderGeometry(.32,.32,.28,10);
  const wm = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: .9 });
  [[-0.92,1.1],[0.92,1.1],[-0.92,-1.1],[0.92,-1.1]].forEach(([x,z]) => {
    const w = new THREE.Mesh(wg,wm); w.rotation.z = Math.PI/2; w.position.set(x,.32,z); g.add(w);
  });
  const hlm = new THREE.MeshBasicMaterial({ color: 0xffffcc });
  [-0.55,0.55].forEach(x => { const h = new THREE.Mesh(new THREE.SphereGeometry(.1,5,5),hlm); h.position.set(x,.52,1.72); g.add(h); });
  const bl = new THREE.PointLight(0xffffaa, 1.1, 16); bl.position.set(0,.8,2.2); g.add(bl);
  return g;
}

function addOther(p) {
  if (others[p.id]) return;
  const mesh = makeCar(p.color);
  mesh.position.set((p.idx-1.5)*3, .5, 0);
  scene.add(mesh);
  others[p.id] = { mesh, x: 0, z: 0 };
}

function removeOther(id) {
  if (others[id]) { scene.remove(others[id].mesh); delete others[id]; }
}

// ── chain ─────────────────────────────────────────────────────
function makeChainLine() {
  const g = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
  chainLine = new THREE.Line(g, new THREE.LineBasicMaterial({ color: 0xffaa00 }));
  scene.add(chainLine);
}

function tickChain() {
  if (!chainMode || !chainPartner || !me) return;
  const op = others[chainPartner]; if (!op) return;
  if (chainLine) {
    const p = chainLine.geometry.attributes.position;
    p.setXYZ(0, me.x, .5, me.z); p.setXYZ(1, op.mesh.position.x, .5, op.mesh.position.z); p.needsUpdate = true;
  }
  const dx = me.x - op.mesh.position.x, dz = me.z - op.mesh.position.z;
  const d = Math.sqrt(dx*dx+dz*dz);
  if (d > 9) { const pull = (d-9)*.04; me.x += (op.mesh.position.x-me.x)/d*pull; me.z += (op.mesh.position.z-me.z)/d*pull; notify('⛓ Zincir geriliyor!'); }
}

// ── physics ───────────────────────────────────────────────────
let wr = 0;
function tickCar() {
  if (!me || !running || !me.alive) return;
  const L = K['ArrowLeft']  || K['KeyA'] || K['mL'];
  const R = K['ArrowRight'] || K['KeyD'] || K['mR'];
  const G = K['mG'];
  const B = K['mB'];

  let fspd = BASE_SPD + Math.min(score*.00012, .18);
  if (G) fspd = Math.min(fspd*1.5, BASE_SPD*2.2);
  if (B) fspd = Math.max(fspd*.3, .02);

  if (L)      latSpd = Math.max(latSpd-LAT_ACC, -MAX_LAT);
  else if (R) latSpd = Math.min(latSpd+LAT_ACC,  MAX_LAT);
  else { if (Math.abs(latSpd) < LAT_FRI) latSpd = 0; else latSpd -= Math.sign(latSpd)*LAT_FRI; }

  me.z -= fspd;
  me.x += latSpd;

  const hw = TW/2-1.3;
  if (me.x < -hw) { me.x = -hw; latSpd *= -.4; }
  if (me.x >  hw) { me.x =  hw; latSpd *= -.4; }

  // obstacle collision
  const chunk = chunks.find(c => me.z <= c.z0 && me.z > c.z1);
  if (chunk) {
    for (const o of chunk.obs) {
      const d = Math.sqrt((me.x-o.m.position.x)**2+(me.z-o.m.position.z)**2);
      if (d < o.r) { latSpd *= -.7; me.x += latSpd*2; break; }
    }
  }

  score = Math.floor(Math.abs(me.z));
  document.getElementById('score').textContent = score + 'm';
  document.getElementById('spdVal').textContent = Math.round(fspd*280);

  if (me.mesh) {
    me.mesh.position.set(me.x, .5, me.z);
    me.mesh.rotation.z = -latSpd*2.5;
    wr += fspd*3;
    me.mesh.children.forEach(c => { if (c.geometry?.type === 'CylinderGeometry' && c.rotation.z !== 0) c.rotation.x = wr; });
  }

  tickChain();
  manageChunks();

  socket.emit('move', { x: me.x, z: me.z });
}

function manageChunks() {
  while (worldZ > me.z - 4*CL) addChunk(null);
  chunks = chunks.filter(c => { if (c.z0 > me.z + 2*CL) { scene.remove(c.g); return false; } return true; });
}

// ── camera ────────────────────────────────────────────────────
function tickCam() {
  if (!me?.mesh) return;
  const p = me.mesh.position;
  _cp.set(p.x*.4, p.y+4.5, p.z+9); camera.position.lerp(_cp, .1);
  _cl.set(p.x*.6, p.y+.8, p.z-6); camera.lookAt(_cl);
}

// ── minimap ───────────────────────────────────────────────────
let lastMM = 0;
function tickMM() {
  const now = Date.now(); if (now-lastMM < 120) return; lastMM = now;
  const cv = document.getElementById('mm'), ctx = cv.getContext('2d');
  const W = cv.width, H = cv.height;
  ctx.clearRect(0,0,W,H);
  ctx.fillStyle='#0a0500'; ctx.fillRect(0,0,W,H);
  const tx=W*.2, tw=W*.6;
  ctx.fillStyle='#1a0e06'; ctx.fillRect(tx,0,tw,H);
  if (chaser && me) {
    const cy = H*.75+(chaser.z-me.z)*.4;
    if (cy>0&&cy<H) { ctx.fillStyle='#ff2200'; ctx.beginPath(); ctx.arc(W/2,cy,5,0,Math.PI*2); ctx.fill(); }
  }
  Object.values(others).forEach(op => {
    if (!me) return;
    const py = H*.5+(op.mesh.position.z-me.z)*.3;
    const px = tx+((op.mesh.position.x+TW/2)/TW)*tw;
    if (py>0&&py<H) { ctx.fillStyle='#aaa'; ctx.beginPath(); ctx.arc(px,py,4,0,Math.PI*2); ctx.fill(); }
  });
  if (me) {
    const px = tx+((me.x+TW/2)/TW)*tw;
    ctx.fillStyle = me.color||'#fff';
    ctx.beginPath(); ctx.arc(px,H*.5,5,0,Math.PI*2); ctx.fill();
    ctx.strokeStyle='#fff'; ctx.lineWidth=1.5; ctx.stroke();
  }
}

// ── flames ────────────────────────────────────────────────────
function tickFlames() {
  const t = Date.now()*.004;
  chunks.forEach(c => c.g.children.forEach(ch => {
    if (ch.userData.flicker !== undefined) { const s=.85+Math.sin(t+ch.userData.flicker)*.15; ch.scale.set(s,s+Math.random()*.1,s); }
  }));
  chunks.forEach(c => c.obs.forEach(o => { if (o.spin) o.m.rotation.y += o.m.userData.spin||.025; }));
}

// ── die / end ─────────────────────────────────────────────────
function die() {
  if (!me.alive) return;
  me.alive = false; running = false;
  notify('💀 Yakalandın!');
  socket.emit('died', score);
  setTimeout(() => { document.getElementById('deathDist').textContent = score+'m'; document.getElementById('deathScreen').style.display='flex'; }, 1500);
}

function showEnd(lb) {
  const medals = ['🥇','🥈','🥉','4️⃣'];
  document.getElementById('lb').innerHTML = lb.map((p,i) =>
    `<div class="lbe"><span>${medals[i]||i+1}</span><span style="flex:1;text-align:left">${p.name}</span><span style="color:#ff9900">${p.score}m</span></div>`).join('');
  setTimeout(() => document.getElementById('endScreen').style.display='flex', 1500);
}

// ── hud ───────────────────────────────────────────────────────
function renderPlist(players) {
  document.getElementById('plist').innerHTML = players.map(p =>
    `<div class="pe" style="border-color:${p.color}">${p.name}</div>`).join('');
}

let ntimer;
function notify(msg) {
  const el = document.getElementById('notif');
  el.textContent = msg; el.classList.add('on');
  clearTimeout(ntimer); ntimer = setTimeout(() => el.classList.remove('on'), 2500);
}

// ── countdown ─────────────────────────────────────────────────
function countdown() {
  const el = document.getElementById('countdown');
  el.style.display = 'flex';
  let n = 3;
  const tick = () => {
    el.textContent = n > 0 ? n : 'KAÇIŞA BAŞLA!';
    el.style.animation = 'none'; void el.offsetWidth; el.style.animation = 'pop .5s ease-in-out';
    if (n === 0) { running = true; setTimeout(() => el.style.display='none', 900); }
    else { n--; setTimeout(tick, 1000); }
  };
  tick();
}

// ── mobile controls ───────────────────────────────────────────
function bindMobile() {
  function bind(id, down, up) {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('touchstart',  e => { e.preventDefault(); K[down]=true;  if(up)K[up]=false; }, { passive:false });
    el.addEventListener('touchend',    e => { e.preventDefault(); K[down]=false; }, { passive:false });
    el.addEventListener('touchcancel', e => { e.preventDefault(); K[down]=false; }, { passive:false });
    el.addEventListener('mousedown',   e => { K[down]=true;  if(up)K[up]=false; });
    el.addEventListener('mouseup',     e => { K[down]=false; });
    el.addEventListener('mouseleave',  e => { K[down]=false; });
  }
  bind('bL', 'mL', 'mR');
  bind('bR', 'mR', 'mL');
  bind('bG', 'mG', null);
  bind('bB', 'mB', null);
}

// ── main loop ─────────────────────────────────────────────────
let fc = 0;
function loop() {
  requestAnimationFrame(loop);
  fc++;
  if (me && !me.mesh) { me.mesh = makeCar(me.color||'#ff4444'); me.mesh.position.set(me.x,.5,me.z); scene.add(me.mesh); }
  tickCar(); tickChaser(); tickCam(); tickFlames();
  if (fc%6===0) tickMM();
  renderer.render(scene, camera);
}

// ── init ──────────────────────────────────────────────────────
window.addEventListener('load', initSocket);
