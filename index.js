// index.js (servidor, reemplaza el anterior)
import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const server = createServer(app);

// permitir conexiones desde el cliente (en Render normalmente same origin, pero dejamos * para pruebas)
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static(path.join(__dirname, "public")));
const PORT = process.env.PORT || 3000;

/* -------------------------
   Estado global (autoridad)
   ------------------------- */
let players = {}; // id -> { id, name, color, x,y,w,h, money, base: { ownedList:[], securityDuration, securityUntil, slot, x,y, w,h } }
let belt = [];    // items compartidos en la cinta
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

/* spawn brainrot determinístico globalmente */
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
    y: 430 + Math.random() * 20,
    w: 48,
    h: 48,
    vx: 70,
    price,
    special
  };
  belt.push(br);
  io.emit("beltUpdate", belt);
}

/* mover la cinta y emitir su estado */
setInterval(()=>{
  for(const b of belt) b.x += b.vx * 0.05; // similar velocidad cliente
  // eliminar brainrots que ya llegaron demasiado a la derecha (900 es zona base)
  belt = belt.filter(b => b.x + b.w < 1100); 
  io.emit("beltUpdate", belt);
}, 50);

setInterval(()=>spawnBrainrot(), 1200);

/* util para distancia euclidiana */
function distance(a,b){
  const dx = (a.x||0) - (b.x||0);
  const dy = (a.y||0) - (b.y||0);
  return Math.hypot(dx,dy);
}

/* -------------------------
   Socket events
   ------------------------- */
io.on("connection", (socket) => {
  console.log("Jugador conectado:", socket.id);

  // enviar estado inicial
  socket.emit("beltUpdate", belt);
  socket.emit("players", players);

  socket.on("join", (p) => {
    // asignar slot para base
    const slot = nextBaseSlot % BASE_SLOTS.length;
    const basePos = BASE_SLOTS[slot];
    nextBaseSlot++;

    players[socket.id] = {
      id: socket.id,
      name: (p.name && p.name.trim()) ? p.name : `Jugador_${socket.id.slice(0,4)}`,
      color: p.color || "#2b6cff",
      x: p.x || 120, y: p.y || 420, w: p.w || 36, h: p.h || 48,
      money: 50,
      base: {
        ownedList: [],
        securityDuration: 60 * 1000, // 60s por defecto
        securityUntil: Date.now() + 60*1000,
        slot,
        x: basePos.x,
        y: basePos.y,
        w: 180,
        h: 120
      }
    };

    // emitir nuevo estado a todos
    io.emit("players", players);
    socket.broadcast.emit("playerJoined", players[socket.id]);

    // dar $10 a los demás (opcional, mantenemos la idea previa)
    for(const id in players){
      if(id !== socket.id){
        players[id].money += 10;
        io.to(id).emit("actionResult", { ok: true, msg: "Recibiste 10$ por un nuevo jugador."});
      }
    }
    io.emit("players", players);
  });

  socket.on("move", (p) => {
    if(players[socket.id]){
      players[socket.id] = { ...players[socket.id], ...p };
      socket.broadcast.emit("playerMoved", players[socket.id]);
      // enviar players completo de vez en cuando (no necesario en cada move, pero útil)
      // io.emit("players", players);
    }
  });

  socket.on("setInfo", (info) => {
    if(players[socket.id]){
      players[socket.id].name = info.name || players[socket.id].name;
      players[socket.id].color = info.color || players[socket.id].color;
      io.emit("players", players);
    }
  });

  /* Compra: validar existencia y dinero en servidor */
  socket.on("buyBrainrot", (brId) => {
    const me = players[socket.id];
    if(!me) return socket.emit("actionResult", { ok:false, msg: "No estás registrado en el servidor." });

    const idx = belt.findIndex(b => b.id === brId);
    if(idx < 0) return socket.emit("actionResult", { ok:false, msg: "Ese brainrot ya no existe." });

    const br = belt[idx];
    if(me.money < br.price) return socket.emit("actionResult", { ok:false, msg: "No tienes suficiente dinero." });

    // todo correcto: cobrar y mover a la base del comprador
    me.money -= br.price;
    const gain = (br.price / 1000) * (br.special ? 2 : 1);
    me.base.ownedList.push({ price: br.price, special: br.special, gain });
    belt.splice(idx, 1);

    io.emit("beltUpdate", belt);
    io.emit("players", players);
    socket.emit("actionResult", { ok:true, msg: `Compraste un brainrot por ${br.price}$` });
  });

  /* Vender desde la base: índice del ownedList */
  socket.on("sellFromBase", (index) => {
    const me = players[socket.id];
    if(!me) return;
    const i = Number(index);
    if(isNaN(i) || i < 0 || i >= me.base.ownedList.length) return socket.emit("actionResult", { ok:false, msg: "Ítem inválido."});
    const item = me.base.ownedList.splice(i,1)[0];
    me.money += item.price; // devuelve precio completo (puedes ajustar)
    io.emit("players", players);
    socket.emit("actionResult", { ok:true, msg: `Vendiste un brainrot por ${item.price}$` });
  });

  /* Mejorar seguridad */
  socket.on("upgradeSecurity", () => {
    const me = players[socket.id];
    if(!me) return;
    const cost = 100;
    if(me.money < cost) return socket.emit("actionResult", { ok:false, msg: "No tienes suficiente dinero para mejorar seguridad." });
    me.money -= cost;
    me.base.securityDuration += 30 * 1000; // +30s por mejora
    me.base.securityUntil = Date.now() + me.base.securityDuration;
    io.emit("players", players);
    socket.emit("actionResult", { ok:true, msg: "Seguridad mejorada." });
  });

  /* Intento de robo: targetId viene del cliente; servidor valida distancia y seguridad */
  socket.on("stealRequest", (targetId) => {
    const thief = players[socket.id];
    const victim = players[targetId];
    if(!thief) return socket.emit("actionResult", { ok:false, msg: "No estás activo." });
    if(!victim) return socket.emit("actionResult", { ok:false, msg: "Objetivo no encontrado." });

    // check distancia mínima (evita spoofing): 180 px aproximadamente (ajustable)
    const dist = distance(thief, victim);
    if(dist > 220) return socket.emit("actionResult", { ok:false, msg: "Estás demasiado lejos de la base para robar." });

    // seguridad
    if(Date.now() < (victim.base.securityUntil || 0)){
      return socket.emit("actionResult", { ok:false, msg: "La base está protegida por seguridad." });
    }

    // no hay nada que robar?
    const avail = victim.base.ownedList.length;
    if(avail === 0) return socket.emit("actionResult", { ok:false, msg: "No hay nada que robar." });

    // cuántos robar: 1 o 2 (pero no más de lo que tiene)
    const take = Math.min(avail, (Math.random() < 0.5 ? 1 : 2));
    const stolen = victim.base.ownedList.splice(0, take);
    // añadir a la base del ladrón
    for(const s of stolen) thief.base.ownedList.push(s);

    // activar seguridad en víctima (cooldown mínimo 30s)
    victim.base.securityUntil = Date.now() + Math.max(30*1000, victim.base.securityDuration);
    io.emit("players", players);

    socket.emit("actionResult", { ok:true, msg: `Robaste ${stolen.length} brainrot(s)!` });
    // avisar a la víctima (si sigue conectado)
    io.to(targetId).emit("actionResult", { ok:false, msg: `Te han robado ${stolen.length} brainrot(s)!` });
  });

  socket.on("disconnect", () => {
    delete players[socket.id];
    io.emit("playerDisconnected", socket.id);
    io.emit("players", players);
    console.log("Jugador desconectado:", socket.id);
  });
});

/* arrancar servidor */
server.listen(PORT, () => console.log("Servidor en puerto", PORT));
