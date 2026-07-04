const path = require("path");
const fs = require("fs");

const DICT = new Set(
  fs
    .readFileSync(path.join(__dirname, "..", "data", "words_alpha.txt"), "utf8")
    .split(/\r?\n/)
    .map((w) => w.trim().toLowerCase())
    .filter(Boolean)
);

const MAX_CHAIN = 6;
const CHAIN_ESCALATE_EVERY = 8;
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

function hasAvailableWord(prefix, usedWords, minLength, chainLen = 1) {
  const minCount = chainLen > 1 ? 5 : 1;
  return countAvailableWords(prefix, usedWords, minLength) >= minCount;
}

function maxChainForRound(round) {
  return Math.min(MAX_CHAIN, 1 + Math.floor(round / CHAIN_ESCALATE_EVERY));
}

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
  const STARTER_LETTERS = "abcdefghilmnoprstw";
  for (let i = 0; i < 100; i++) {
    const letter = STARTER_LETTERS[(Math.random() * STARTER_LETTERS.length) | 0];
    if (hasAvailableWord(letter, usedWords, minLength, 1)) return { chain: letter, chainLength: 1 };
  }
  return { chain: "a", chainLength: 1 };
}

const AVATARS_LIST = ["🐸","🦊","🐼","🐙","🦄","🐧","🐯","🦖","🐝","🐢","🦉","🐌","🍕","🌮","🍩","🤖","👻","🎃","🌵","🦩","🐳","🧀","🍄","⚡"];

const CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function makeCode(existingCodes = new Set()) {
  let code;
  do {
    code = Array.from({ length: 4 }, () => CHARS[(Math.random() * CHARS.length) | 0]).join("");
  } while (existingCodes.has(code));
  return code;
}

function createRoom({ name, avatar, key }) {
  const settings = { lives: 3, turnSeconds: 15, minLength: 3, maxSkips: 0 };
  const room = {
    hostId: key,
    state: "lobby",
    players: [],
    settings,
    game: null,
  };
  addPlayer(room, { name, avatar, key });
  return room;
}

function addPlayer(room, { name, avatar, key }) {
  const taken = new Set(room.players.map(p => p.avatar));
  if (taken.has(avatar)) {
    const free = AVATARS_LIST.find(a => !taken.has(a));
    if (free) avatar = free;
  }
  room.players.push({
    id: key,
    name: String(name).slice(0, 16) || "Player",
    avatar: avatar || "🙂",
    lives: room.settings.lives,
    alive: true,
    connected: true,
    wordsPlayed: 0,
    longestWord: "",
  });
}

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
    usedWords: [],
    currentChain: start.chain,
    chainLength: start.chainLength,
    order: room.players.map((p) => p.id),
    turnIndex: (Math.random() * room.players.length) | 0,
    round: 0,
    turnSeconds: room.settings.turnSeconds,
    turnEndsAt: 0,
    lastWord: null,
    consecutiveFails: 0,
  };
}

function alivePlayers(room) {
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

  g.turnSeconds = Math.max(6, room.settings.turnSeconds - Math.floor(g.round / 4));
  g.turnEndsAt = Date.now() + g.turnSeconds * 1000;
  g.turnPlayerId = g.order[g.turnIndex];
}

function checkGameOver(room) {
  const alive = alivePlayers(room);
  const multi = room.players.length > 1;
  if ((multi && alive.length <= 1) || alive.length === 0) {
    room.state = "over";
    const winner = alive[0] || null;
    room.lastResult = {
      winnerId: winner ? winner.id : null,
      winnerName: winner ? winner.name : null,
      stats: room.players.map((p) => ({
        id: p.id,
        name: p.name,
        avatar: p.avatar,
        wordsPlayed: p.wordsPlayed,
        longestWord: p.longestWord,
      })),
    };
    room.game = null;
    return true;
  }
  return false;
}

function processTimeout(room) {
  const g = room.game;
  if (!g || room.state !== "playing") return { events: [] };
  const events = [];
  const p = room.players.find((pl) => pl.id === g.order[g.turnIndex]);
  if (p) {
    p.lives -= 1;
    events.push({ type: "boom", playerId: p.id, livesLeft: p.lives });
    if (p.lives <= 0) {
      p.alive = false;
      events.push({ type: "eliminated", playerId: p.id, name: p.name });
    }
  }
  if (checkGameOver(room)) {
    events.push({ type: "gameOver", winner: alivePlayers(room)[0] || null, players: room.players });
    return { events, gameOver: true };
  }

  const maxSkips = room.settings.maxSkips;
  if (maxSkips > 0) {
    g.consecutiveFails = (g.consecutiveFails || 0) + 1;
    if (g.consecutiveFails >= maxSkips) {
      g.consecutiveFails = 0;
      const skip = randomStartChain(room.settings.minLength, new Set(g.usedWords));
      g.currentChain = skip.chain;
      g.chainLength = skip.chainLength;
      events.push({ type: "chainSkip", chain: skip.chain, chainLength: skip.chainLength });
    }
  }

  g.turnIndex = (g.turnIndex + 1) % g.order.length;
  g.round++;
  beginTurn(room);
  return { events, gameOver: false };
}

function usedWordsSet(room) {
  return new Set(room.game?.usedWords || []);
}

function submitWordRaw(room, raw, key) {
  const g = room.game;
  const errors = [];
  if (!g || room.state !== "playing") {
    errors.push({ type: "rejected", playerId: key, word: String(raw).trim(), reason: "Game not active" });
    return { ok: false, errors };
  }
  if (g.order[g.turnIndex] !== key) {
    errors.push({ type: "rejected", playerId: key, word: String(raw).trim(), reason: "Not your turn — wait for the circle!" });
    return { ok: false, errors };
  }

  const word = String(raw).trim().toLowerCase().replace(/[^a-z]/g, "");
  if (word.length < room.settings.minLength) {
    errors.push({ type: "rejected", playerId: key, word, reason: `Too short — needs ${room.settings.minLength}+ letters` });
    return { ok: false, errors };
  }
  if (!word.startsWith(g.currentChain)) {
    const label = g.currentChain.length === 1 ? "letter" : "letters";
    errors.push({ type: "rejected", playerId: key, word, reason: `Must start with "${g.currentChain.toUpperCase()}" (${g.chainLength} ${label})` });
    return { ok: false, errors };
  }
  const used = usedWordsSet(room);
  if (used.has(word)) {
    errors.push({ type: "rejected", playerId: key, word, reason: "Already used!" });
    return { ok: false, errors };
  }
  if (!DICT.has(word)) {
    errors.push({ type: "rejected", playerId: key, word, reason: "Not in the dictionary" });
    return { ok: false, errors };
  }

  used.add(word);
  g.usedWords = [...used];
  g.lastWord = { word, playerId: key };
  g.consecutiveFails = 0;
  g.round++;
  const next = computeNextChain(word, used, g.round, room.settings.minLength);
  g.currentChain = next.chain;
  g.chainLength = next.chainLength;

  const p = room.players.find((pl) => pl.id === key);
  let bonusLife = false;
  if (p) {
    p.wordsPlayed++;
    if (word.length > p.longestWord.length) p.longestWord = word;
    if (word.length >= 8 && p.lives < room.settings.lives) {
      p.lives++;
      bonusLife = true;
    }
  }

  g.turnIndex = (g.turnIndex + 1) % g.order.length;
  beginTurn(room);

  return {
    ok: true,
    events: [{
      type: "accepted",
      word,
      playerId: key,
      bonusLife,
      nextChain: next.chain,
      chainLength: next.chainLength,
    }],
  };
}

function getPublicRoom(room) {
  return {
    hostId: room.hostId,
    state: room.state,
    settings: { ...room.settings },
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

module.exports = {
  DICT,
  makeCode,
  createRoom,
  addPlayer,
  startGame,
  beginTurn,
  processTimeout,
  submitWordRaw,
  checkGameOver,
  getPublicRoom,
  usedWordsSet,
  alivePlayers,
  AVATARS_LIST,
};
