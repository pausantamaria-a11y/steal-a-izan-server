import express from "express";
import http from "http";
import { Server } from "socket.io";
import path from "path";
import { fileURLToPath } from "url";

// Configurar rutas para servir tu HTML
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" } // Permitir conexiones desde cualquier origen
});

// Servir los archivos estáticos (por ejemplo, index.html)
app.use(express.static(__dirname + "/public"));

// Guardar todos los jugadores conectados
const players = {};

// Cuando alguien se conecta
io.on("connection", (socket) => {
  console.log("🟢 Jugador conectado:", socket.id);

  // Cuando el jugador envía sus datos iniciales (nombre, color, posición)
  socket.on("join", (data) => {
    players[socket.id] = { ...data, id: socket.id };
    console.log(`👤 ${data.name} se ha unido`);
    
    // Enviar a todos la lista actualizada de jugadores
    io.emit("players", players);

    // 🎁 Dar un regalo de $10 a todos los jugadores
    io.emit("gift", { amount: 10, from: data.name });
  });

  // Cuando el jugador se mueve
  socket.on("move", (data) => {
    if (players[socket.id]) {
      players[socket.id].x = data.x;
      players[socket.id].y = data.y;
      io.emit("playerMoved", { ...players[socket.id], id: socket.id });
    }
  });

  // Cuando un jugador se desconecta
  socket.on("disconnect", () => {
    console.log("🔴 Jugador desconectado:", socket.id);
    delete players[socket.id];
    io.emit("playerDisconnected", socket.id);
  });
});

// Iniciar el servidor
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Servidor escuchando en puerto ${PORT}`));
