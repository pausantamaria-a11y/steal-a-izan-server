import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, { cors: { origin: "*" } });

// Aquí guardaremos a los jugadores
const players = {};

io.on("connection", (socket) => {
  console.log("Jugador conectado:", socket.id);

  // Crear un jugador nuevo
  players[socket.id] = { 
    x: Math.random() * 800, 
    y: Math.random() * 500, 
    color: "#" + Math.floor(Math.random() * 16777215).toString(16),
    name: "Jugador"
  };

  // Enviar la lista actual a este jugador
  socket.emit("init", players);
  // Avisar a todos los demás que llegó un nuevo jugador
  socket.broadcast.emit("playerJoined", { id: socket.id, data: players[socket.id] });

  // Cuando se mueva
  socket.on("move", (pos) => {
    if (players[socket.id]) {
      players[socket.id].x = pos.x;
      players[socket.id].y = pos.y;
      io.emit("update", { id: socket.id, data: players[socket.id] });
    }
  });

  // Si cambia su nombre o color
  socket.on("setInfo", (data) => {
    if (players[socket.id]) {
      players[socket.id].name = data.name;
      players[socket.id].color = data.color;
      io.emit("update", { id: socket.id, data: players[socket.id] });
    }
  });

  // Si se desconecta
  socket.on("disconnect", () => {
    console.log("Jugador desconectado:", socket.id);
    delete players[socket.id];
    io.emit("playerLeft", socket.id);
  });
});

// Render asigna el puerto automáticamente
const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => console.log(`Servidor corriendo en puerto ${PORT}`));

