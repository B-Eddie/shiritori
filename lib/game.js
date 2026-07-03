const path = require("path");
const fs = require("fs");

// ---------- Dictionary ----------
const DICT = new Set(
  fs
    .readFileSync(path.join(__dirname, "..", "data", "words_alpha.txt"), "utf8")
    .split(/\r?\n/)
    .map((w) => w.trim().toLowerCase())
    .filter(Boolean)
);
console.log(`Dictionary loaded: ${DICT.size} words`);

// Prefix index for fast "is there an unused word starting with X?" lookups.
const MAX_CHAIN = 6;
const CHAIN_ESCALATE_EVERY = 8; // rounds before the next chain length is allowed
const PREFIX_WORDS = new Map();
for (const word of DICT) {
  for (let len = 1; len <= MAX_CHAIN; len++) {
    if (word.length < len) continue;
    const prefix = word.slice(0, len);
    if (!PREFIX_WORDS.has(prefix)) PREFIX_WORDS.set(prefix, new Set());
    PREFIX_WORDS.get(prefix).add(word);
  }
}

function countAvailableWords(prefix, usedWords, minLength) {
  const words = PREFIX_WORDS.get(prefix);
  if (!words) return 0;
  let n = 0;
  for (const w of words) {
    if (w.length >= minLength && !usedWords.has(w)) n++;
  }
  return n;
}

// A chain is only valid if enough unused, long-enough dictionary words start
// with it. Multi-letter chains need several options so players aren't stuck
// on obscure entries like "ckw".
function hasAvailableWord(prefix, usedWords, minLength, chainLen = 1) {
  const minCount = chainLen > 1 ? 5 : 1;
  return countAvailableWords(prefix, usedWords, minLength) >= minCount;
}

function maxChainForRound(round) {
  return Math.min(MAX_CHAIN, 1 + Math.floor(round / CHAIN_ESCALATE_EVERY));
}

// Pick the longest suffix of `word` (up to the round cap) that still has
// unused dictionary words starting with it; fall back to shorter suffixes.
function computeNextChain(word, usedWords, round, minLength) {
  const cap = Math.min(maxChainForRound(round), word.length);
  for (let len = cap; len >= 1; len--) {
    const chain = word.slice(-len);
    if (hasAvailableWord(chain, usedWords, minLength, len)) return { chain, chainLength: len };
  }
  const last = word.slice(-1);
  if (hasAvailableWord(last, usedWords, minLength, 1)) return { chain: last, chainLength: 1 };
  return randomStartChain(minLength, usedWords);
}

function randomStartChain(minLength = 3, usedWords = new Set()) {
  for (let i = 0; i < 100; i++) {
    const letter = STARTER_LETTERS[(Math.random() * STARTER_LETTERS.length) | 0];
    if (hasAvailableWord(letter, usedWords, minLength, 1)) return { chain: letter, chainLength: 1 };
  }
  return { chain: "a", chainLength: 1 };
}

// Letters that have plenty of words starting with them (avoid starting on x/z etc.)
const STARTER_LETTERS = "abcdefghilmnoprstw";

const AVATARS_LIST = ["🐸","🦊","🐼","🐙","🦄","🐧","🐯","🦖","🐝","🐢","🦉","🐌","🍕","🌮","🍩","🤖","👻","🎃","🌵","🦩","🐳","🧀","🍄","⚡"];

// Grace period before a disconnected player is actually removed/eliminated.
// Covers page refreshes and Vercel's function max-duration socket drops.
const RECONNECT_GRACE_MS = 20000;

// ---------- Rooms ----------
const rooms = new Map(); // code -> room

function makeCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code;
  do {
    code = Array.from({ length: 4 }, () => chars[(Math.random() * chars.length) | 0]).join("");
  } while (rooms.has(code));
  return code;
}

function setupGame(io) {
  // Players are identified by a client-generated persistent key (player.id),
  // not by socket.id, so a reconnecting socket can reattach to its player.

  function createRoom(socket, { name, avatar, key }) {
    const code = makeCode();
    const room = {
      code,
      hostId: key,
      state: "lobby", // lobby | playing | over
      players: [],
      settings: { lives: 3, turnSeconds: 15, minLength: 3 },
      game: null,
    };
    rooms.set(code, room);
    addPlayer(room, socket, { name, avatar, key });
    return room;
  }

  function addPlayer(room, socket, { name, avatar, key }) {
    const taken = new Set(room.players.map(p => p.avatar));
    if (taken.has(avatar)) {
      const free = AVATARS_LIST.find(a => !taken.has(a));
      if (free) avatar = free;
    }
    room.players.push({
      id: key,
      socketId: socket.id,
      name: String(name).slice(0, 16) || "Player",
      avatar: avatar || "🙂",
      lives: room.settings.lives,
      alive: true,
      connected: true,
      disconnectTimer: null,
      wordsPlayed: 0,
      longestWord: "",
    });
    attachSocket(room, socket, key);
  }

  function attachSocket(room, socket, key) {
    socket.join(room.code);
    socket.data.roomCode = room.code;
    socket.data.playerKey = key;
  }

  function publicRoom(room) {
    return {
      code: room.code,
      hostId: room.hostId,
      state: room.state,
      settings: room.settings,
      players: room.players.map((p) => ({
        id: p.id,
        name: p.name,
        avatar: p.avatar,
        lives: p.lives,
        alive: p.alive,
        connected: p.connected,
        wordsPlayed: p.wordsPlayed,
        longestWord: p.longestWord,
      })),
      game: room.game
        ? {
            currentChain: room.game.currentChain,
            chainLength: room.game.chainLength,
            turnOrder: room.game.order,
            turnPlayerId: room.game.order[room.game.turnIndex],
            turnSeconds: room.game.turnSeconds,
            turnEndsAt: room.game.turnEndsAt,
            round: room.game.round,
            lastWord: room.game.lastWord,
          }
        : null,
    };
  }

  function broadcast(room) {
    io.to(room.code).emit("room", publicRoom(room));
  }

  // ---------- Game logic ----------
  function startGame(room) {
    room.state = "playing";
    for (const p of room.players) {
      p.lives = room.settings.lives;
      p.alive = true;
      p.wordsPlayed = 0;
      p.longestWord = "";
    }
    const start = randomStartChain(room.settings.minLength);
    room.game = {
      usedWords: new Set(),
      currentChain: start.chain,
      chainLength: start.chainLength,
      order: room.players.map((p) => p.id),
      turnIndex: (Math.random() * room.players.length) | 0,
      round: 0,
      turnSeconds: room.settings.turnSeconds,
      turnEndsAt: 0,
      lastWord: null,
      timer: null,
    };
    io.to(room.code).emit("gameStarted");
    beginTurn(room);
  }

  function alivePlayers(room) {
    // A player in reconnect grace still counts as in the game; the turn timer
    // will cost them lives if they stay gone.
    return room.players.filter((p) => p.alive);
  }

  function beginTurn(room) {
    const g = room.game;
    if (!g) return;

    let safety = 0;
    while (safety++ < room.players.length + 2) {
      const p = room.players.find((pl) => pl.id === g.order[g.turnIndex]);
      if (p && p.alive) break;
      g.turnIndex = (g.turnIndex + 1) % g.order.length;
    }

    // Speed up slightly as the game goes on (min 6s)
    g.turnSeconds = Math.max(6, room.settings.turnSeconds - Math.floor(g.round / 4));
    g.turnEndsAt = Date.now() + g.turnSeconds * 1000;

    clearTimeout(g.timer);
    g.timer = setTimeout(() => onTimeout(room), g.turnSeconds * 1000 + 150);
    broadcast(room);
  }

  function onTimeout(room) {
    const g = room.game;
    if (!g || room.state !== "playing") return;
    const p = room.players.find((pl) => pl.id === g.order[g.turnIndex]);
    if (p) {
      p.lives -= 1;
      io.to(room.code).emit("boom", { playerId: p.id, livesLeft: p.lives });
      if (p.lives <= 0) {
        p.alive = false;
        io.to(room.code).emit("eliminated", { playerId: p.id, name: p.name });
      }
    }
    if (checkGameOver(room)) return;
    g.turnIndex = (g.turnIndex + 1) % g.order.length;
    g.round++;
    beginTurn(room);
  }

  function checkGameOver(room) {
    const alive = alivePlayers(room);
    const multi = room.players.length > 1;
    if ((multi && alive.length <= 1) || alive.length === 0) {
      room.state = "over";
      clearTimeout(room.game.timer);
      const winner = alive[0] || null;
      io.to(room.code).emit("gameOver", {
        winnerId: winner ? winner.id : null,
        winnerName: winner ? winner.name : null,
        stats: room.players.map((p) => ({
          id: p.id,
          name: p.name,
          avatar: p.avatar,
          wordsPlayed: p.wordsPlayed,
          longestWord: p.longestWord,
        })),
      });
      room.game = null;
      broadcast(room);
      return true;
    }
    return false;
  }

  function submitWord(room, socket, raw) {
    const g = room.game;
    if (!g || room.state !== "playing") return;
    const key = socket.data.playerKey;
    if (g.order[g.turnIndex] !== key) {
      return io.to(room.code).emit("wordRejected", {
        playerId: key,
        word: String(raw).trim(),
        reason: "Not your turn — wait for the circle!",
      });
    }

    const word = String(raw).trim().toLowerCase().replace(/[^a-z]/g, "");
    const reject = (reason) => io.to(room.code).emit("wordRejected", { playerId: key, word, reason });

    if (word.length < room.settings.minLength) return reject(`Too short — needs ${room.settings.minLength}+ letters`);
    if (!word.startsWith(g.currentChain)) {
      const label = g.currentChain.length === 1 ? "letter" : "letters";
      return reject(`Must start with "${g.currentChain.toUpperCase()}" (${g.chainLength} ${label})`);
    }
    if (g.usedWords.has(word)) return reject("Already used!");
    if (!DICT.has(word)) return reject("Not in the dictionary");

    // Accepted!
    g.usedWords.add(word);
    g.lastWord = { word, playerId: key };
    g.round++;
    const next = computeNextChain(word, g.usedWords, g.round, room.settings.minLength);
    g.currentChain = next.chain;
    g.chainLength = next.chainLength;

    const p = room.players.find((pl) => pl.id === key);
    let bonusLife = false;
    if (p) {
      p.wordsPlayed++;
      if (word.length > p.longestWord.length) p.longestWord = word;
      // Long-word bonus: 8+ letters regains a life (up to starting amount)
      if (word.length >= 8 && p.lives < room.settings.lives) {
        p.lives++;
        bonusLife = true;
      }
    }

    io.to(room.code).emit("wordAccepted", {
      playerId: key,
      word,
      bonusLife,
      nextChain: next.chain,
      chainLength: next.chainLength,
    });

    g.turnIndex = (g.turnIndex + 1) % g.order.length;
    beginTurn(room);
  }

  // ---------- leave / reconnect ----------
  function finalizeLeave(room, p) {
    if (p.connected) return; // reconnected in the meantime

    if (room.state === "playing") {
      p.alive = false;
      io.to(room.code).emit("eliminated", { playerId: p.id, name: p.name, left: true });
      if (!checkGameOver(room)) {
        if (room.game.order[room.game.turnIndex] === p.id) {
          room.game.turnIndex = (room.game.turnIndex + 1) % room.game.order.length;
          beginTurn(room);
        } else {
          broadcast(room);
        }
      }
    } else {
      room.players = room.players.filter((pl) => pl.id !== p.id);
      if (room.players.length === 0) {
        if (room.game) clearTimeout(room.game.timer);
        rooms.delete(room.code);
        return;
      }
      if (room.hostId === p.id) room.hostId = room.players[0].id;
      broadcast(room);
    }
  }

  // ---------- Socket handlers ----------
  io.on("connection", (socket) => {
    socket.on("createRoom", ({ name, avatar, key }, cb) => {
      if (!key) return cb({ ok: false, error: "Missing player key" });
      const room = createRoom(socket, { name, avatar, key });
      cb({ ok: true, code: room.code, state: room.state });
      broadcast(room);
    });

    socket.on("joinRoom", ({ code, name, avatar, key }, cb) => {
      if (!key) return cb({ ok: false, error: "Missing player key" });
      const room = rooms.get(String(code).toUpperCase().trim());
      if (!room) return cb({ ok: false, error: "Room not found" });

      // Reconnect: same player key rejoins (page refresh / dropped socket)
      const existing = room.players.find((p) => p.id === key);
      if (existing) {
        existing.connected = true;
        existing.socketId = socket.id;
        clearTimeout(existing.disconnectTimer);
        attachSocket(room, socket, key);
        cb({ ok: true, code: room.code, state: room.state, rejoined: true });
        broadcast(room);
        return;
      }

      if (room.state === "playing") return cb({ ok: false, error: "Game already in progress" });
      if (room.players.length >= 12) return cb({ ok: false, error: "Room is full (12 max)" });
      addPlayer(room, socket, { name, avatar, key });
      cb({ ok: true, code: room.code, state: room.state });
      broadcast(room);
    });

    socket.on("updateSettings", (settings) => {
      const room = rooms.get(socket.data.roomCode);
      if (!room || room.hostId !== socket.data.playerKey || room.state === "playing") return;
      const s = room.settings;
      if ([1, 2, 3, 4, 5].includes(settings.lives)) s.lives = settings.lives;
      if ([10, 15, 20, 30].includes(settings.turnSeconds)) s.turnSeconds = settings.turnSeconds;
      if ([2, 3, 4, 5].includes(settings.minLength)) s.minLength = settings.minLength;
      broadcast(room);
    });

    socket.on("startGame", () => {
      const room = rooms.get(socket.data.roomCode);
      if (!room || room.hostId !== socket.data.playerKey || room.state === "playing") return;
      if (room.players.filter((p) => p.connected).length < 1) return;
      startGame(room);
    });

    socket.on("submitWord", (word) => {
      const room = rooms.get(socket.data.roomCode);
      if (room) submitWord(room, socket, word);
    });

    // Live typing preview, like jklm.fun
    socket.on("typing", (text) => {
      const room = rooms.get(socket.data.roomCode);
      if (!room || !room.game) return;
      if (room.game.order[room.game.turnIndex] !== socket.data.playerKey) return;
      socket.to(room.code).emit("typing", {
        playerId: socket.data.playerKey,
        text: String(text).slice(0, 30),
      });
    });

    socket.on("playAgain", () => {
      const room = rooms.get(socket.data.roomCode);
      if (!room || room.hostId !== socket.data.playerKey || room.state === "playing") return;
      room.state = "lobby";
      broadcast(room);
    });

    socket.on("disconnect", () => {
      const room = rooms.get(socket.data.roomCode);
      if (!room) return;
      const p = room.players.find((pl) => pl.id === socket.data.playerKey);
      if (!p) return;
      if (p.socketId !== socket.id) return; // a newer socket already took over

      p.connected = false;
      clearTimeout(p.disconnectTimer);
      p.disconnectTimer = setTimeout(() => finalizeLeave(room, p), RECONNECT_GRACE_MS);
      broadcast(room);
    });
  });
}

module.exports = { setupGame, DICT };
