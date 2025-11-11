// server.js
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

app.use(express.static("."));

const PORT = process.env.PORT || 3000;

// ======= Estado del servidor =======
let players = {};
let brainrots = [];
let nextBrainrotId = 0;

// Genera un brainrot nuevo
function spawnBrainrot() {
  const price = Math.floor(Math.random() * 5000) + 100;
  const special = Math.random() < 0.03;
  const brainrot = {
    id: nextBrainrotId++,
    x: -60,
    y: 420, // altura fija del cinturón
    w: 48,
    h: 48,
    vx: 70,
    price,
    special
  };
  brainrots.push(brainrot);
  io.emit("spawnBrainrot", brainrot);
}

// Genera brainrots cada 1.2s
setInterval(spawnBrainrot, 1200);

// ======= SOCKET.IO =======
io.on("connection", (socket) => {
  console.log("Jugador conectado:", socket.id);

  // Enviar estado actual
  socket.emit("initState", { players, brainrots });

  // Cuando un jugador entra
  socket.on("join", (data) => {
    players[socket.id] = {
      id: socket.id,
      name: data.name,
      color: data.color,
      x: data.x,
      y: data.y,
      w: data.w,
      h: data.h,
      money: 50,
      baseX: Math.floor(Math.random() * 700 + 200),
      baseY: Math.floor(Math.random() * 300 + 100)
    };

    // Regala $10 a todos los jugadores
    for (const id in players) {
      if (id !== socket.id) players[id].money += 10;
    }

    io.emit("players", players);
  });

  // Movimiento
  socket.on("move", (data) => {
    if (players[socket.id]) {
      players[socket.id].x = data.x;
      players[socket.id].y = data.y;
      players[socket.id].color = data.color;
      players[socket.id].name = data.name;
      io.emit("players", players);
    }
  });

  // Cambio de color/nombre
  socket.on("setInfo", (data) => {
    if (players[socket.id]) {
      players[socket.id].name = data.name;
      players[socket.id].color = data.color;
      io.emit("players", players);
    }
  });

  // Compra de brainrot (lo borra globalmente)
  socket.on("buyBrainrot", (id) => {
    brainrots = brainrots.filter((b) => b.id !== id);
    io.emit("removeBrainrot", id);
  });

  socket.on("disconnect", () => {
    console.log("Jugador desconectado:", socket.id);
    delete players[socket.id];
    io.emit("players", players);
  });
});

server.listen(PORT, () => {
  console.log("Servidor activo en puerto", PORT);
});
