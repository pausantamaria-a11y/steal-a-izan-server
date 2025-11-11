const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

const players = {};

io.on("connection", (socket) => {
  console.log("Jugador conectado:", socket.id);

  socket.on("join", (playerData) => {
    players[socket.id] = { id: socket.id, ...playerData };
    io.emit("players", players);
    io.emit("playerJoined", players[socket.id]);
  });

  socket.on("move", (playerData) => {
    if (players[socket.id]) {
      players[socket.id] = { id: socket.id, ...playerData };
      socket.broadcast.emit("playerMoved", players[socket.id]);
    }
  });

  socket.on("disconnect", () => {
    console.log("Jugador desconectado:", socket.id);
    delete players[socket.id];
    io.emit("playerDisconnected", socket.id);
  });
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log(`Servidor corriendo en puerto ${PORT}`));
