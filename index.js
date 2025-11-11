// index.js (servidor, actualizado: cinta completa, pending por base, collect/reset security)
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

/* Config */
const CANVAS_WIDTH = 1100; // ancho del canvas (coincide con public/index.html)
const CANVAS_HEIGHT = 600;
const BELT_Y = 420;
const BELT_HEIGHT = 72;
const RESET_SECURITY_COST = 50; // coste para reiniciar seguridad (ajusta si quieres)
const INCOME_TICK_MS = 1000; // cada segundo se acumula ingreso

/* Estado global */
let players = {}; // id -> { id, name, color, x,y,w,h, money, base:{ ownedList:[], pending:0, securityDuration(ms), securityUntil(ms), slot, x,y,w,h } }
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

/* Generador global de brainrots (todos ven los mismos) */
function spawnBrainrot(){
  spawnCounter++;
  let price;
  if(spawnCounter % 3 === 0) price = randRange(5000,15000);
  else if(spawnCounter % 3 === 1) price = randRange(1,500);
  else price = randRange(500,5000);
  const special = Math.random() < 0.03;
  const br = {
    id: Date.now() + Math.random(),
    x: -60,
    y: BELT_Y + 8 + Math.random() * (BELT_HEIGHT - 16), // dentro de la cinta
    w: 48, h: 48,
    vx: 70,
    price, special
  };
  belt.push(br);
  io.emit('beltUpdate', belt);
}

/* Mover belt, eliminar items que pasan al otro lado (CANVAS_WIDTH) */
setInterval(()=>{
  for(const b of belt) b.x += b.vx * 0.05;
  // eliminamos brainrots que salgan del canvas derecho
  const before = belt.length;
  belt = belt.filter(b => (b.x + b.w) < CANVAS_WIDTH);
  if(belt.length !== before) io.emit('beltUpdate', belt);
  // emitimos belt de todos modos para sincronía visual
  io.emit('beltUpdate', belt);
}, 50);

setInterval(()=>spawnBrainrot(), 1200);

/* Income tick: calcular ganancias pasivas y sumar a pending por jugador */
setInterval(()=>{
  let changed = false;
  for(const id in players){
    const p = players[id];
    if(!p || !p.base) continue;
    let earned = 0;
    for(const item of p.base.ownedList){
      // cada segundo gano item.gain (si no existe, calc)
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

/* util distancia */
function distance(a,b){
  const dx = (a.x||0) - (b.x||0);
  const dy = (a.y||0) - (b.y||0);
  return Math.hypot(dx,dy);
}

/* Socket handlers */
io.on('connection', (socket) => {
  console.log('Jugador conectado:', socket.id);

  // enviar estado inicial
  socket.emit('beltUpdate', belt);
  socket.emit('players', players);

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
        securityDuration: 60 * 1000, // 60s
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

    // opcional: regalar 10$ a los demás
    for(const id in players){
      if(id !== socket.id){
        players[id].money += 10;
        io.to(id).emit('actionResult', { ok:true, msg: 'Recibiste 10$ por un nuevo jugador.' });
      }
    }
    io.emit('players', players);
  });

  socket.on('move', (p) => {
    if(players[socket.id]){
      players[socket.id] = { ...players[socket.id], ...p };
      socket.broadcast.emit('playerMoved', players[socket.id]);
    }
  });

  socket.on('setInfo', (info) => {
    if(players[socket.id]){
      players[socket.id].name = info.name || players[socket.id].name;
      players[socket.id].color = info.color || players[socket.id].color;
      io.emit('players', players);
    }
  });

  /* Compra: servidor valida existencia y dinero */
  socket.on('buyBrainrot', (brId) => {
    const me = players[socket.id];
    if(!me) return socket.emit('actionResult', { ok:false, msg: 'No estás registrado en el servidor.' });
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

  /* Vender desde la base */
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

  /* Mejorar seguridad (ya existía) */
  socket.on('upgradeSecurity', () => {
    const me = players[socket.id];
    if(!me) return;
    const cost = 100;
    if(me.money < cost) return socket.emit('actionResult', { ok:false, msg: 'No tienes suficiente dinero para mejorar seguridad.' });
    me.money -= cost;
    me.base.securityDuration += 30 * 1000; // +30s
    me.base.securityUntil = Date.now() + me.base.securityDuration;
    io.emit('players', players);
    socket.emit('actionResult', { ok:true, msg: 'Seguridad mejorada.' });
  });

  /* Reiniciar seguridad (botón en la base) */
  socket.on('resetSecurity', () => {
    const me = players[socket.id];
    if(!me) return;
    // si quieres que sea gratuito, pon cost = 0
    const cost = RESET_SECURITY_COST;
    if(me.money < cost) return socket.emit('actionResult', { ok:false, msg: `Necesitas ${cost}$ para reiniciar seguridad.` });
    me.money -= cost;
    me.base.securityUntil = Date.now() + me.base.securityDuration;
    io.emit('players', players);
    socket.emit('actionResult', { ok:true, msg: `Seguridad reiniciada (${me.base.securityDuration/1000}s).` });
  });

  /* Recoger ingresos acumulados en base (pending -> money) */
  socket.on('collectIncome', () => {
    const me = players[socket.id];
    if(!me) return;
    const pending = Number(me.base.pending || 0);
    if(pending <= 0) return socket.emit('actionResult', { ok:false, msg: 'No tienes ingresos pendientes.' });
    // traspasar
    me.money += pending;
    me.base.pending = 0;
    io.emit('players', players);
    socket.emit('actionResult', { ok:true, msg: `Has recogido ${pending.toFixed(2)}$` });
  });

  /* Intento de robo */
  socket.on('stealRequest', (targetId) => {
    const thief = players[socket.id];
    const victim = players[targetId];
    if(!thief) return socket.emit('actionResult', { ok:false, msg: 'No estás activo.' });
    if(!victim) return socket.emit('actionResult', { ok:false, msg: 'Objetivo no encontrado.' });

    // comprobación distancia entre posiciones (evita spoofing)
    const dist = distance(thief, victim);
    if(dist > 220) return socket.emit('actionResult', { ok:false, msg: 'Estás demasiado lejos de la base para robar.' });

    if(Date.now() < (victim.base.securityUntil || 0)){
      return socket.emit('actionResult', { ok:false, msg: 'La base está protegida por seguridad.' });
    }

    const avail = victim.base.ownedList.length;
    if(avail === 0) return socket.emit('actionResult', { ok:false, msg: 'No hay nada que robar.' });

    const take = Math.min(avail, (Math.random() < 0.5 ? 1 : 2));
    // robar los primeros take (podemos hacerlo aleatorio si quieres)
    const stolen = victim.base.ownedList.splice(0, take);
    for(const s of stolen) thief.base.ownedList.push(s);

    victim.base.securityUntil = Date.now() + Math.max(30*1000, victim.base.securityDuration);
    io.emit('players', players);

    socket.emit('actionResult', { ok:true, msg: `Robaste ${stolen.length} brainrot(s)!` });
    io.to(targetId).emit('actionResult', { ok:false, msg: `Te han robado ${stolen.length} brainrot(s)!` });
  });

  socket.on('disconnect', () => {
    delete players[socket.id];
    io.emit('playerDisconnected', socket.id);
    io.emit('players', players);
    console.log('Jugador desconectado:', socket.id);
  });
});

/* arrancar */
server.listen(PORT, () => console.log('Servidor en puerto', PORT));
