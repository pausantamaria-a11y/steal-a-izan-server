// index.js - servidor actualizado para el cliente nuevo
import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const server = createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static(path.join(__dirname, "public")));
const PORT = process.env.PORT || 3000;

/* CONFIG */
const CANVAS_WIDTH = 1100;
const CANVAS_HEIGHT = 600;
const BELT_Y = 420;
const BELT_H = 72;
const SPAWN_INTERVAL_MS = 1200;
const BELT_TICK_MS = 50; // tick para mover belt
const INCOME_TICK_MS = 1000;
const UPGRADE_SECURITY_COST = 100;

/* Estado */
let players = {}; // id -> { id,name,color,x,y,w,h,money, base:{ownedList:[], pending, securityDuration, securityUntil, slot, x,y,w,h} }
let belt = [];
let spawnCounter = 0;
let nextBaseSlot = 0;

const BASE_SLOTS = [
  { x: 720, y: 60 },
  { x: 920, y: 60 },
  { x: 720, y: 260 },
  { x: 920, y: 260 },
  { x: 720, y: 460 },
  { x: 920, y: 460 },
];

function randRange(a,b){ return Math.floor(a + Math.random() * (b - a + 1)); }
function distance(a,b){ const dx=(a.x||0)-(b.x||0); const dy=(a.y||0)-(b.y||0); return Math.hypot(dx,dy); }

/* Spawn global de brainrots (todos ven los mismos), centrados y sin solaparse */
function spawnBrainrot() {
  spawnCounter++;
  let price;
  if (spawnCounter % 3 === 0) price = randRange(5000, 15000);
  else if (spawnCounter % 3 === 1) price = randRange(1, 500);
  else price = randRange(500, 5000);

  const special = Math.random() < 0.03;

  const br = {
    id: Date.now() + Math.random(),
    w: 48,
    h: 48,
    vx: 70 + Math.random() * 10,
    price,
    special,
    // Posición base centrada en la cinta
    x: -60 - Math.random() * 200,
    y: BELT_Y + (BELT_H / 2) - (48 / 2),
  };

  // Evitar solapamiento con brainrots ya existentes
  let tries = 0;
  const maxTries = 20;
  let overlapping;

  do {
    overlapping = false;
    for (const other of belt) {
      if (
        br.x < other.x + other.w &&
        br.x + br.w > other.x &&
        br.y < other.y + other.h &&
        br.y + br.h > other.y
      ) {
        overlapping = true;
        br.x -= 60; // lo desplazamos un poco más atrás
        break;
      }
    }
    tries++;
  } while (overlapping && tries < maxTries);

  belt.push(br);
  io.emit("beltUpdate", belt);
}

setInterval(spawnBrainrot, SPAWN_INTERVAL_MS);

/* Mover belt en ticks: usamos vx * (tickMs/1000) */
setInterval(()=>{
  const dt = BELT_TICK_MS / 1000;
  for(const b of belt) b.x += b.vx * dt;
  // eliminar los que pasan del canvas derecho
  const before = belt.length;
  belt = belt.filter(b => (b.x + b.w) < CANVAS_WIDTH + 40);
  if(belt.length !== before) io.emit('beltUpdate', belt);
  // emitimos regularmente para sincronía visual
  io.emit('beltUpdate', belt);
}, BELT_TICK_MS);

/* Income tick: acumular pending por base */
setInterval(()=>{
  let changed = false;
  for(const id in players){
    const p = players[id];
    if(!p || !p.base) continue;
    let earned = 0;
    for(const item of p.base.ownedList){
      const gain = item.gain || (item.price / 1000 * (item.special ? 2 : 1));
      earned += gain;
    }
    if(earned > 0){
      p.base.pending = (p.base.pending || 0) + earned;
      changed = true;
    }
  }
  if(changed) io.emit('players', players);
}, INCOME_TICK_MS);

/* Socket handlers */
io.on('connection', (socket) => {
  console.log('Jugador conectado:', socket.id);

  // enviar estado inicial
  socket.emit('beltUpdate', belt);
  socket.emit('players', players);

  /* JOIN */
  socket.on('join', (p) => {
    const slot = nextBaseSlot % BASE_SLOTS.length;
    const basePos = BASE_SLOTS[slot];
    nextBaseSlot++;

    players[socket.id] = {
      id: socket.id,
      name: (p.name && p.name.trim()) ? p.name : `Jugador_${socket.id.slice(0,4)}`,
      color: p.color || '#2b6cff',
      x: p.x || 120, y: p.y || 420, w: p.w || 36, h: p.h || 48,
      money: 50,
      base: {
        ownedList: [],
        pending: 0,
        securityDuration: 60 * 1000,
        securityUntil: Date.now() + 60*1000,
        slot,
        x: basePos.x,
        y: basePos.y,
        w: 180,
        h: 120
      }
    };

    io.emit('players', players);
    socket.broadcast.emit('playerJoined', players[socket.id]);

    // opcional: dar 10$ a los demás
    for(const id in players){
      if(id !== socket.id){
        players[id].money += 10;
        io.to(id).emit('actionResult', { ok:true, msg: 'Recibiste 10$ por un nuevo jugador.' });
      }
    }
    io.emit('players', players);
  });

  /* MOVE: validar movimiento (prohibir entrar en bases protegidas de otros) */
  socket.on('move', (p) => {
    const me = players[socket.id];
    if(!me) return;
    // cliente envía x,y,w,h
    const nx = typeof p.x === 'number' ? p.x : me.x;
    const ny = typeof p.y === 'number' ? p.y : me.y;
    const nw = p.w || me.w, nh = p.h || me.h;
    // crear rect hipotético
    const rect = { x: nx, y: ny, w: nw, h: nh };
    // comprobar si se interseca con una base ajena protegida
    let blocked = false;
    for(const id in players){
      if(id === socket.id) continue;
      const other = players[id];
      if(!other || !other.base) continue;
      const b = other.base;
      const baseRect = { x: b.x, y: b.y, w: b.w || 180, h: b.h || 120 };
      if(Date.now() < (b.securityUntil || 0)){
        // si se solapan: bloquear
        if(rect.x < baseRect.x + baseRect.w && rect.x + rect.w > baseRect.x &&
           rect.y < baseRect.y + baseRect.h && rect.y + rect.h > baseRect.y){
          blocked = true;
          break;
        }
      }
    }
    if(blocked){
      // no aceptar la posición; re-enviar estado completo para corregir cliente
      socket.emit('actionResult', { ok:false, msg: 'Movimiento bloqueado: base protegida.' });
      socket.emit('players', players);
      return;
    }
    // aceptar y propagar
    players[socket.id] = { ...players[socket.id], x: nx, y: ny, w: nw, h: nh, color: p.color || players[socket.id].color, name: p.name || players[socket.id].name };
    socket.broadcast.emit('playerMoved', players[socket.id]);
    // también emitimos full players ocasionalmente (mantenemos sincronía)
    // io.emit('players', players);
  });

  /* setInfo */
  socket.on('setInfo', (info) => {
    if(players[socket.id]){
      players[socket.id].name = info.name || players[socket.id].name;
      players[socket.id].color = info.color || players[socket.id].color;
      io.emit('players', players);
    }
  });

  /* buyBrainrot */
  socket.on('buyBrainrot', (brId) => {
    const me = players[socket.id];
    if(!me) return socket.emit('actionResult', { ok:false, msg: 'No registrado.' });
    const idx = belt.findIndex(b => b.id === brId);
    if(idx < 0) return socket.emit('actionResult', { ok:false, msg: 'Ese brainrot ya no existe.' });
    const br = belt[idx];
    if(me.money < br.price) return socket.emit('actionResult', { ok:false, msg: 'No tienes suficiente dinero.' });

    me.money -= br.price;
    const gain = (br.price / 1000) * (br.special ? 2 : 1);
    me.base.ownedList.push({ price: br.price, special: br.special, gain });
    belt.splice(idx, 1);

    io.emit('beltUpdate', belt);
    io.emit('players', players);
    socket.emit('actionResult', { ok:true, msg: `Compraste un brainrot por ${br.price}$` });
  });

  /* sellFromBase */
  socket.on('sellFromBase', (index) => {
    const me = players[socket.id];
    if(!me) return;
    const i = Number(index);
    if(isNaN(i) || i < 0 || i >= me.base.ownedList.length) return socket.emit('actionResult', { ok:false, msg: 'Ítem inválido.' });
    const item = me.base.ownedList.splice(i,1)[0];
    me.money += item.price;
    io.emit('players', players);
    socket.emit('actionResult', { ok:true, msg: `Vendiste un brainrot por ${item.price}$` });
  });

  /* upgradeSecurity */
  socket.on('upgradeSecurity', () => {
    const me = players[socket.id];
    if(!me) return;
    if(me.money < UPGRADE_SECURITY_COST) return socket.emit('actionResult', { ok:false, msg: 'No tienes suficiente dinero.' });
    me.money -= UPGRADE_SECURITY_COST;
    me.base.securityDuration += 30*1000;
    me.base.securityUntil = Date.now() + me.base.securityDuration;
    io.emit('players', players);
    socket.emit('actionResult', { ok:true, msg: 'Seguridad mejorada.' });
  });

  /* resetSecurity (gratuito solo si expiró) */
  socket.on('resetSecurity', () => {
    const me = players[socket.id];
    if(!me) return;
    const now = Date.now();
    if(now < (me.base.securityUntil || 0)){
      return socket.emit('actionResult', { ok:false, msg: 'La seguridad aún está activa.' });
    }
    me.base.securityUntil = Date.now() + me.base.securityDuration;
    io.emit('players', players);
    socket.emit('actionResult', { ok:true, msg: `Seguridad reiniciada (${me.base.securityDuration/1000}s).` });
  });

  /* collectIncome */
  socket.on('collectIncome', () => {
    const me = players[socket.id];
    if(!me) return;
    const pending = Number(me.base.pending || 0);
    if(pending <= 0) return socket.emit('actionResult', { ok:false, msg: 'No tienes ingresos pendientes.' });
    me.money += pending;
    me.base.pending = 0;
    io.emit('players', players);
    socket.emit('actionResult', { ok:true, msg: `Has recogido ${pending.toFixed(2)}$` });
  });

  /* stealRequest */
  socket.on('stealRequest', (targetId) => {
    const thief = players[socket.id];
    const victim = players[targetId];
    if(!thief) return socket.emit('actionResult', { ok:false, msg: 'No estás activo.' });
    if(!victim) return socket.emit('actionResult', { ok:false, msg: 'Objetivo no encontrado.' });

    const dist = distance(thief, victim);
    if(dist > 220) return socket.emit('actionResult', { ok:false, msg: 'Estás demasiado lejos de la base.' });

    if(Date.now() < (victim.base.securityUntil || 0)){
      return socket.emit('actionResult', { ok:false, msg: 'La base está protegida por seguridad.' });
    }

    const avail = victim.base.ownedList.length;
    if(avail === 0) return socket.emit('actionResult', { ok:false, msg: 'No hay nada que robar.' });

    const take = Math.min(avail, (Math.random() < 0.5 ? 1 : 2));
    const stolen = victim.base.ownedList.splice(0, take);
    for(const s of stolen) thief.base.ownedList.push(s);

    victim.base.securityUntil = Date.now() + Math.max(30*1000, victim.base.securityDuration);
    io.emit('players', players);

    socket.emit('actionResult', { ok:true, msg: `Robaste ${stolen.length} brainrot(s)!` });
    io.to(targetId).emit('actionResult', { ok:false, msg: `Te han robado ${stolen.length} brainrot(s)!` });
  });

  /* disconnect */
  socket.on('disconnect', () => {
    delete players[socket.id];
    io.emit('playerDisconnected', socket.id);
    io.emit('players', players);
    console.log('Jugador desconectado:', socket.id);
  });
});

/* arrancar */
server.listen(PORT, () => console.log('Servidor en puerto', PORT));
