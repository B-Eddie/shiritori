// Local development server. On Vercel, the Socket.IO server runs as a
// function instead (api/socket-io.js) and public/ is served statically.
const path = require("path");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { setupGame } = require("./lib/game");

const app = express();
const server = http.createServer(app);

// Same path as production so the client works unchanged in both environments.
const io = new Server(server, { path: "/api/socket-io/socket.io", addTrailingSlash: false, serveClient: false });
setupGame(io);

app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Shiritori server running → http://localhost:${PORT}`));
