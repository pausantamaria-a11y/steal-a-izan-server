// index.js (Servidor completo y actualizado)
// Reemplaza tu index.js con este para mantener la lógica online y las nuevas acciones:
// - cinta continua (left->right) que elimina brainrots al salir del canvas
// - pending por base (income tick cada 1s)
// - collectIncome, resetSecurity (gratuito pero solo si expiró), upgradeSecurity, stealRequest
// - compra/venta validadas en servidor

import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const server = createServer(app);

// permitir CORS amplio para pruebas; en producción restringe al dominio de tu cliente
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static(path.join(__dirname, "public")));
const PORT = process.env.PORT || 3000;

/* ---------------- CONFIG ---------------- */
const CANVAS_WIDTH = 1100;
const CANVAS_HEIGHT = 600;
const BELT_Y = 420;
const BELT_H = 72;
const SPAWN_INTERVAL_MS = 1200;
const BELT_STEP_MS = 50;
const INCOME_TICK_MS = 1000;
const RESET_SECURITY_COST = 0; // gratuito (según petición)
const UPGRADE_SECURITY_COST = 100; // si quieres cambiarlo
/* ---------------------------------------- */

/* Estado */
let players = {}; // id -> { id,name,color,x,y,w,h,money, base:{ ownedList:[], pending, securityDuration(ms), securityUntil(ms), slot,x,y,w,h } }
let belt = [];    // lista de brainrots sincronizados a todos
let spawnCounter = 0;
let nextBaseSlot = 0;

/* Posiciones de base (slots) */
const BASE_SLOTS = [
  { x: 720, y: 60 },
  { x: 920, y: 60 },
  { x: 720, y: 260 },
  { x: 920, y: 260 },
  { x: 720, y: 460 },
  { x: 920, y: 460 },
];

/* Util */
function randRange(a,b){ return Math.floor(a + Math.random() * (b - a + 1)); }
function distance(a,b){
  const dx = (a.x||0) - (b.x||0);
  const dy = (a.y||0) - (b.y||0);
  return Math.hypot(dx,dy);
}

/* ---------------- Spawn brainrots (global) ---------------- */
function spawnBrainrot(){
  spawnCounter++;
  let price;
  if(spawnCounter % 3 === 0) price = randRange(5000,15000);
  else if(spawnCounter % 3 === 1) price = randRange(1,500);
  else price = randRange(500,5000);
  const special = Math.random() < 0.03;
  const br = {
    id: Date.now() + Math.random(),
    x: -Math.random() * 300,
    y: BELT_Y + 8 + Math.random() * (BELT_H - 16),
    w: 48, h: 48,
    vx: 2.5 + Math.random()*1.2, // px per tick (will be moved each BELT_STEP_MS)
    price, special
  };
  belt.push(br);
}

/* Empezar spawn periódicamente */
setInterval(()=>spawnBrainrot(), SPAWN_INTERVAL_MS);

/* ---------------- Mover cinta y eliminar al salir ---------------- */
setInterval(()=>{
  for(const b of belt) b.x += b.vx;
  // eliminar los que pasan del canvas derecho
  const before = belt.length;
  belt = belt.filter(b => (b.x + b.w) < CANVAS_WIDTH + 20);
  if(belt.length !== before) io.emit('beltUpdate', belt);
  // emitir de todas formas para mantener sincronía visual
  io.emit('beltUpdate', belt);
}, BELT_STEP_MS);

/* ---------------- Income tick: acumular pending por base ---------------- */
setInterval(()=>{
  let changed = false;
  for(const id in players){
    const p = players[id];
    if(!p || !p.base) continue;
    let earned = 0;
    for(const item of p.base.ownedList){
      // gain formula = price/1000, special *2
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

/* ---------------- Socket.IO ---------------- */
io.on('connection', (socket) => {
  console.log('Jugador conectado:', socket.id);

  // enviar estado inicial
  socket.emit('beltUpdate', belt);
  socket.emit('players', players);

  /* JOIN: crear jugador y su base */
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
        securityDuration: 60 * 1000, // 60s por defecto
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

    // opcional: dar 10$ a los demás (como premisa previa)
    for(const id in players){
      if(id !== socket.id){
        players[id].money += 10;
        io.to(id).emit('actionResult', { ok:true, msg: 'Recibiste 10$ por un nuevo jugador.' });
      }
    }
    io.emit('players', players);
  });

  /* MOVE: actualizar posición del jugador */
  socket.on('move', (p) => {
    if(players[socket.id]){
      players[socket.id] = { ...players[socket.id], ...p };
      socket.broadcast.emit('playerMoved', players[socket.id]);
    }
  });

  /* setInfo: nombre/color */
  socket.on('setInfo', (info) => {
    if(players[socket.id]){
      players[socket.id].name = info.name || players[socket.id].name;
      players[socket.id].color = info.color || players[socket.id].color;
      io.emit('players', players);
    }
  });

  /* BUY: comprar brainrot de la cinta */
  socket.on('buyBrainrot', (brId) => {
    const me = players[socket.id];
    if(!me) return socket.emit('actionResult', { ok:false, msg: 'No estás registrado.' });

    const idx = belt.findIndex(b => b.id === brId);
    if(idx < 0) return socket.emit('actionResult', { ok:false, msg: 'Ese brainrot ya no existe.' });

    const br = belt[idx];
    if(me.money < br.price) return socket.emit('actionResult', { ok:false, msg: 'No tienes suficiente dinero.' });

    // realizar compra: descontar, añadir a base, quitar de cinta
    me.money -= br.price;
    const gain = (br.price / 1000) * (br.special ? 2 : 1);
    me.base.ownedList.push({ price: br.price, special: br.special, gain });
    belt.splice(idx, 1);

    io.emit('beltUpdate', belt);
    io.emit('players', players);
    socket.emit('actionResult', { ok:true, msg: `Compraste un brainrot por ${br.price}$` });
  });

  /* SELL: vender desde la base (índice) */
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

  /* UPGRADE security (paga) */
  socket.on('upgradeSecurity', () => {
    const me = players[socket.id];
    if(!me) return;
    const cost = UPGRADE_SECURITY_COST;
    if(me.money < cost) return socket.emit('actionResult', { ok:false, msg: `No tienes ${cost}$ para mejorar seguridad.` });
    me.money -= cost;
    me.base.securityDuration += 30*1000; // +30s
    me.base.securityUntil = Date.now() + me.base.securityDuration;
    io.emit('players', players);
    socket.emit('actionResult', { ok:true, msg: 'Seguridad mejorada.' });
  });

  /* RESET security (gratuito pero solo si ya expiró) */
  socket.on('resetSecurity', () => {
    const me = players[socket.id];
    if(!me) return;
    const now = Date.now();
    if(now < (me.base.securityUntil || 0)){
      return socket.emit('actionResult', { ok:false, msg: 'La seguridad aún está activa; no puedes reiniciarla todavía.' });
    }
    // reiniciamos al duration actual (gratuito)
    me.base.securityUntil = Date.now() + me.base.securityDuration;
    io.emit('players', players);
    socket.emit('actionResult', { ok:true, msg: `Seguridad reiniciada por ${ (me.base.securityDuration/1000) }s.` });
  });

  /* COLLECT income (pending -> money) */
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

  /* STEAL: solicitar robar la base de targetId */
  socket.on('stealRequest', (targetId) => {
    const thief = players[socket.id];
    const victim = players[targetId];
    if(!thief) return socket.emit('actionResult', { ok:false, msg: 'No estás activo.' });
    if(!victim) return socket.emit('actionResult', { ok:false, msg: 'Objetivo no encontrado.' });

    // comprobación de distancia (usa posiciones que el cliente envía con move)
    const dist = distance(thief, victim);
    if(dist > 220) return socket.emit('actionResult', { ok:false, msg: 'Estás demasiado lejos de la base para robar.' });

    // seguridad
    if(Date.now() < (victim.base.securityUntil || 0)){
      return socket.emit('actionResult', { ok:false, msg: 'La base está protegida por seguridad.' });
    }

    const avail = victim.base.ownedList.length;
    if(avail === 0) return socket.emit('actionResult', { ok:false, msg: 'No hay nada que robar.' });

    // cuántos robar — 1 o 2 (puedes ajustar)
    const take = Math.min(avail, (Math.random() < 0.5 ? 1 : 2));
    // coger primeros take (si prefieres aleatorio, mezclar array)
    const stolen = victim.base.ownedList.splice(0, take);
    for(const s of stolen) thief.base.ownedList.push(s);

    // reactivar seguridad en víctima (cooldown mínimo 30s)
    victim.base.securityUntil = Date.now() + Math.max(30*1000, victim.base.securityDuration);
    io.emit('players', players);

    socket.emit('actionResult', { ok:true, msg: `Robaste ${stolen.length} brainrot(s)!` });
    io.to(targetId).emit('actionResult', { ok:false, msg: `Te han robado ${stolen.length} brainrot(s)!` });
  });

  /* Disconnect */
  socket.on('disconnect', () => {
    delete players[socket.id];
    io.emit('playerDisconnected', socket.id);
    io.emit('players', players);
    console.log('Jugador desconectado:', socket.id);
  });
});

/* arrancar servidor */
server.listen(PORT, () => console.log('Servidor en puerto', PORT));
