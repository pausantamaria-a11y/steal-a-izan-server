// server.js
import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const server = createServer(app);
const io = new Server(server, {
  cors: { origin: "*" },
});

app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;

// --- Estado global ---
let players = {};
let belt = [];
let spawnCounter = 0;

// ---- Generar brainrots universales ----
function spawnBrainrot() {
  spawnCounter++;
  let price;
  if (spawnCounter % 3 === 0) price = Math.floor(Math.random() * (15000 - 5000) + 5000);
  else if (spawnCounter % 3 === 1) price = Math.floor(Math.random() * 500 + 1);
  else price = Math.floor(Math.random() * (5000 - 500) + 500);
  const special = Math.random() < 0.03;
  const br = {
    id: Date.now() + Math.random(),
    x: -60,
    y: 420 + Math.random() * 20,
    w: 48,
    h: 48,
    vx: 70,
    price,
    special,
  };
  belt.push(br);
  io.emit("beltUpdate", belt);
}

setInterval(() => {
  for (const br of belt) br.x += br.vx * 0.05;
  belt = belt.filter((b) => b.x + b.w < 900);
  io.emit("beltUpdate", belt);
}, 50);

setInterval(() => spawnBrainrot(), 1200);

// --- Socket events ---
io.on("connection", (socket) => {
  console.log("Jugador conectado:", socket.id);

  socket.on("join", (p) => {
    players[socket.id] = { id: socket.id, ...p };
    io.emit("players", players);
    socket.emit("beltUpdate", belt);

    // Regalar $10 a todos los demás
    for (const id in players) {
      if (id !== socket.id) {
        io.to(id).emit("addMoney", 10);
      }
    }

    socket.broadcast.emit("playerJoined", players[socket.id]);
  });

  socket.on("move", (p) => {
    if (players[socket.id]) {
      players[socket.id] = { ...players[socket.id], ...p };
      socket.broadcast.emit("playerMoved", players[socket.id]);
    }
  });

  socket.on("buyBrainrot", (id) => {
    // eliminar el brainrot del servidor
    const index = belt.findIndex((b) => b.id === id);
    if (index >= 0) {
      belt.splice(index, 1);
      io.emit("beltUpdate", belt);
    }
  });

  socket.on("disconnect", () => {
    delete players[socket.id];
    io.emit("playerDisconnected", socket.id);
    console.log("Jugador desconectado:", socket.id);
  });
});

server.listen(PORT, () => console.log("Servidor en puerto", PORT));
