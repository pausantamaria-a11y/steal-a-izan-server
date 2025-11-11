import express from "express";
import http from "http";
import { Server } from "socket.io";

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const players = {};
const bases = {}; // 🏠 guardará las bases por jugador

function generateBasePosition() {
  // Genera posiciones diferentes para cada base
  const x = Math.floor(Math.random() * 800) + 100;
  const y = Math.floor(Math.random() * 400) + 100;
  return { x, y };
}

io.on("connection", (socket) => {
  console.log("🟢 Jugador conectado:", socket.id);

  socket.on("join", (data) => {
    // crea jugador
    players[socket.id] = { ...data, id: socket.id, money: 0 };

    // crea base del jugador
    bases[socket.id] = {
      ownerId: socket.id,
      ownerName: data.name,
      color: data.color,
      position: generateBasePosition(),
      brainrots: Math.floor(Math.random() * 5) + 3 // cantidad aleatoria
    };

    console.log(`👤 ${data.name} entró y se creó su base`);

    // actualizar a todos los jugadores
    io.emit("players", players);
    io.emit("bases", bases);

    // 🎁 regalo de bienvenida
    io.emit("gift", { amount: 10, from: data.name });
  });

  // 🧍 movimiento
  socket.on("move", (data) => {
    if (players[socket.id]) {
      players[socket.id] = { ...players[socket.id], ...data };
      io.emit("playerMoved", { ...players[socket.id], id: socket.id });
    }
  });

  // 🎨 actualizar nombre o color
  socket.on("setInfo", (data) => {
    if (players[socket.id]) {
      players[socket.id].name = data.name || players[socket.id].name;
      players[socket.id].color = data.color || players[socket.id].color;
      if (bases[socket.id]) bases[socket.id].color = data.color || bases[socket.id].color;
      io.emit("players", players);
      io.emit("bases", bases);
    }
  });

  // 💸 quitar dinero
  socket.on("removeMoney", ({ targetId, amount }) => {
    if (players[targetId]) {
      players[targetId].money = Math.max(0, (players[targetId].money || 0) - amount);
      io.emit("moneyUpdated", { id: targetId, money: players[targetId].money });
    }
  });

  // ❌ desconexión
  socket.on("disconnect", () => {
    delete players[socket.id];
    delete bases[socket.id];
    io.emit("playerDisconnected", socket.id);
    io.emit("bases", bases);
    console.log("🔴 Jugador desconectado:", socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Servidor escuchando en ${PORT}`));
