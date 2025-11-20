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
let movingBrainrots = []; // brainrots que están en tránsito hacia una base

// --- utilidades faltantes añadidas ---
function randRange(a, b) {
  return Math.floor(a + Math.random() * (b - a + 1));
}
function distance(a, b) {
  const dx = (a.x || 0) - (b.x || 0);
  const dy = (a.y || 0) - (b.y || 0);
  return Math.hypot(dx, dy);
}
// --- fin utilidades ---

// layout de bases en servidor: asigna x/y/w/h a cada base en cuadrícula
function serverLayoutBases() {
  const bw = 180, bh = 120;
  const marginX = 16, marginY = 16;
  const gapX = 20, gapY = 24;

  const ids = Object.keys(players).filter(id => players[id] && players[id].base);
  // ordenar por slot (orden de llegada) → garantiza top-left → right → siguiente fila según orden de join.
  // fallback por nombre/ID si no hay slot.
  ids.sort((a,b) => {
    const pa = players[a], pb = players[b];
    const sa = (pa.base && typeof pa.base.slot === 'number') ? pa.base.slot : Number.MAX_SAFE_INTEGER;
    const sb = (pb.base && typeof pb.base.slot === 'number') ? pb.base.slot : Number.MAX_SAFE_INTEGER;
    if(sa !== sb) return sa - sb;
    const na = (pa.name || '').toString().toLowerCase();
    const nb = (pb.name || '').toString().toLowerCase();
    if(na !== nb) return na < nb ? -1 : 1;
    return a < b ? -1 : 1;
  });

  const cols = Math.max(1, Math.floor((CANVAS_WIDTH - marginX*2 + gapX) / (bw + gapX)));
  for (let i = 0; i < ids.length; i++) {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const x = marginX + col * (bw + gapX);
    const y = marginY + row * (bh + gapY);
    const p = players[ids[i]];
    if (p && p.base) {
      p.base.x = x;
      p.base.y = y;
      p.base.w = p.base.w || bw;
      p.base.h = p.base.h || bh;
    }
  }
}

function emitPlayersUpdated() {
  serverLayoutBases();
  io.emit('players', players);
}

/* Spawn global de brainrots (todos ven los mismos). vx en px/s (coincide con cliente que usa 70) */
function spawnBrainrot(){
  spawnCounter++;
  let price;
  if (spawnCounter % 3 === 0) price = randRange(5000,15000);
  else if (spawnCounter % 3 === 1) price = randRange(1,500);
  else price = randRange(500,5000);
  const special = Math.random() < 0.03;
  const br = {
    id: Date.now() + Math.random(),
    x: -60 - Math.random()*200, // empieza detrás del borde izquierdo
    y: BELT_Y + 8 + Math.random() * (BELT_H - 16), // siempre dentro de la cinta
    w: 48, h: 48,
    vx: 70 + Math.random()*10, // px/s, similar a cliente original
    price,
    special
  };
  belt.push(br);
  io.emit('beltUpdate', belt);
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

  // actualizar brainrots en movimiento
  if(movingBrainrots.length > 0){
    let changed = false;
    for(let i = movingBrainrots.length - 1; i >= 0; i--){
      const m = movingBrainrots[i];
      const dtSeg = dt;
      // avanzar según velocidad
      m.x += m.vx * dtSeg;
      m.y += m.vy * dtSeg;
      // comprobar llegada (si existe base destino)
      const target = players[m.targetPlayerId];
      if(!target || !target.base){
        // refund: devolver dinero al jugador y eliminar movimiento
        if(players[m.initiatorId]) players[m.initiatorId].money += m.price;
        movingBrainrots.splice(i,1);
        changed = true;
        continue;
      }
      const tx = target.base.x + (target.base.w||180)/2 - m.w/2;
      const ty = target.base.y + (target.base.h||120)/2 - m.h/2;
      const dist = Math.hypot(tx - m.x, ty - m.y);
      if(dist < 6){
        // llegó: añadir a la base del targetPlayerId
        const gain = (m.price / 1000) * (m.special ? 2 : 1);
        players[m.targetPlayerId].base.ownedList.push({ price: m.price, special: m.special, gain });
        // notificar llegada
        io.to(m.targetPlayerId).emit('actionResult', { ok:true, msg: `Brainrot llegado (${m.price}$)` });
        movingBrainrots.splice(i,1);
        changed = true;
      }
    }
    if(changed) {
      io.emit('movingBrainrots', movingBrainrots);
      emitPlayersUpdated();
    } else {
      // si solo han cambiado posiciones, emitimos la lista para que clientes animen
      io.emit('movingBrainrots', movingBrainrots);
    }
  }
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
    // asignar slot incremental (orden de llegada). No hacer wrap: slot 0 será siempre la primera base (arriba-izquierda)
    const slot = nextBaseSlot++;
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
         // x/y/w/h se asignan desde serverLayoutBases() al emitir players
         w: 180,
         h: 120
       }
     };
    // emitir usando helper que asigna layout de bases (coloca por slot: 0 -> top-left, luego a la derecha, etc.)
    emitPlayersUpdated();
    socket.broadcast.emit('playerJoined', players[socket.id]);

    // opcional: dar 10$ a los demás
    for(const id in players){
      if(id !== socket.id){
        players[id].money += 10;
        io.to(id).emit('actionResult', { ok:true, msg: 'Recibiste 10$ por un nuevo jugador.' });
      }
    }
    emitPlayersUpdated();
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

    // reservar: descontar dinero ya para evitar race conditions
    me.money -= br.price;
    // crear objeto de movimiento con destino la base del comprador
    const targetBase = me.base;
    if(!targetBase){
      // si por alguna razón no hay base, refund
      me.money += br.price;
      return socket.emit('actionResult', { ok:false, msg: 'No tienes base válida.' });
    }
    const tx = targetBase.x + (targetBase.w||180)/2 - br.w/2;
    const ty = targetBase.y + (targetBase.h||120)/2 - br.h/2;
    const dx = tx - br.x;
    const dy = ty - br.y;
    const distance_ = Math.hypot(dx, dy);
    const speed = 140; // px/s server-side
    const vx = (distance_ > 0) ? (dx / distance_) * speed : 0;
    const vy = (distance_ > 0) ? (dy / distance_) * speed : 0;

    const moving = {
      id: br.id,
      x: br.x, y: br.y, w: br.w, h: br.h,
      price: br.price, special: br.special,
      vx, vy,
      targetPlayerId: socket.id,
      initiatorId: socket.id
    };
    movingBrainrots.push(moving);
    // quitar de la cinta
    belt.splice(idx, 1);

    io.emit('beltUpdate', belt);
    io.emit('movingBrainrots', movingBrainrots);
    emitPlayersUpdated(); // aplica layout y emite players
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
    emitPlayersUpdated();
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
    emitPlayersUpdated();
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
    emitPlayersUpdated();
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
    emitPlayersUpdated();
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
    const stolenItems = victim.base.ownedList.splice(0, take);

    for (let i = 0; i < stolenItems.length; i++) {
      const item = stolenItems[i];
      const col = i % 6;
      const row = Math.floor(i / 6);
      const iconX = (victim.base.x || 0) + 12 + col * 24;
      const iconY = (victim.base.y || 0) + 18 + row * 26;
      const startX = iconX + 8 - 24;
      const startY = iconY + 8 - 24;

      const targetX = (thief.base.x || 0) + ((thief.base.w || 180) / 2) - 8;
      const targetY = (thief.base.y || 0) + ((thief.base.h || 120) / 2) - 8;

      const dx = targetX - startX;
      const dy = targetY - startY;
      const distToTarget = Math.hypot(dx, dy);
      const speed = 140;
      const vx = distToTarget > 0 ? (dx / distToTarget) * speed : 0;
      const vy = distToTarget > 0 ? (dy / distToTarget) * speed : 0;

      movingBrainrots.push({
        id: `${Date.now()}_${Math.random()}`,
        x: startX,
        y: startY,
        w: 48,
        h: 48,
        price: item.price,
        special: !!item.special,
        vx, vy,
        targetPlayerId: socket.id,
        initiatorId: socket.id,
        gain: item.gain
      });
    }

    io.emit('movingBrainrots', movingBrainrots);
    emitPlayersUpdated();

    socket.emit('actionResult', { ok:true, msg: `Robaste ${stolenItems.length} brainrot(s)!` });
    io.to(targetId).emit('actionResult', { ok:false, msg: `Te han robado ${stolenItems.length} brainrot(s)!` });
  });

  /* disconnect */
  socket.on('disconnect', () => {
    delete players[socket.id];
    io.emit('playerDisconnected', socket.id);
    emitPlayersUpdated();
    console.log('Jugador desconectado:', socket.id);
  });
});

/* arrancar */
server.listen(PORT, () => console.log('Servidor en puerto', PORT));
