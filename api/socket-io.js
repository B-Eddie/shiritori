const http = require("http");
const { Server } = require("socket.io");
const { setupGame } = require("../lib/game");

const IO_PATH = "/api/socket-io/socket.io";

const server = http.createServer();

// This function only ever serves Socket.IO traffic, but the rewritten URL may
// arrive as "/api/socket-io", "/api/socket-io/socket.io", or "/socket.io"
// depending on how the platform forwards it. Normalize every request to the
// exact path Socket.IO expects, preserving the query string. These listeners
// are registered before Socket.IO attaches, so they run first on "upgrade".
function normalizeUrl(req) {
  if (!req.url) return;
  const qs = req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
  req.url = IO_PATH + qs;
}
server.on("request", normalizeUrl);
server.on("upgrade", normalizeUrl);

// addTrailingSlash: false → requests go to ".../socket.io" (no trailing
// slash), which is required for Vercel's rewrite rule to match.
const io = new Server(server, { path: IO_PATH, addTrailingSlash: false, serveClient: false });
setupGame(io);

module.exports = server;
