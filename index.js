import express from "express";
import http from "http";
import { Server } from "socket.io";

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// Servir estáticos si lo deseas (opcional si usas /public)
// import path from "path";
// app.use(express.static(path.join(process.cwd(), "public")));

const players = {};

io.on("connection", (socket) => {
  console.log("🟢 Jugador conectado:", socket.id);

  // Cuando alguien entra al juego
  socket.on("join", (data) => {
    players[socket.id] = { ...data, id: socket.id };
    console.log(`👤 ${data.name} se unió`);
    io.emit("players", players);

    // 🎁 Regalar $10 a todos
    io.emit("gift", { amount: 10, from: data.name });
  });

  // Cuando un jugador se mueve
  socket.on("move", (data) => {
    if (players[socket.id]) {
      players[socket.id] = { ...players[socket.id], ...data };
      io.emit("playerMoved", { ...players[socket.id], id: socket.id });
    }
  });

  // 🟢 NUEVO: cuando cambia color o nombre en tiempo real
  socket.on("setInfo", (data) => {
    if (players[socket.id]) {
      players[socket.id].color = data.color || players[socket.id].color;
      players[socket.id].name = data.name || players[socket.id].name;
      console.log(`🎨 ${socket.id} actualizó su info:`, data);
      // reenviar a todos la actualización
      io.emit("playerMoved", { ...players[socket.id], id: socket.id });
    }
  });

  // Cuando alguien se desconecta
  socket.on("disconnect", () => {
    console.log("🔴 Jugador desconectado:", socket.id);
    delete players[socket.id];
    io.emit("playerDisconnected", socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Servidor escuchando en puerto ${PORT}`));
