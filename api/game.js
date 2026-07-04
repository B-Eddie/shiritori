const { initializeApp, getApps, cert } = require("firebase-admin/app");
const { getDatabase } = require("firebase-admin/database");
const {
  makeCode,
  createRoom,
  addPlayer,
  startGame,
  processTimeout,
  submitWordRaw,
  getPublicRoom,
  beginTurn,
} = require("../lib/game");

function initFirebase() {
  if (!getApps().length) {
    const sa = process.env.FIREBASE_SERVICE_ACCOUNT;
    const url = process.env.FIREBASE_DATABASE_URL;
    if (!sa || !url) return false;
    initializeApp({ credential: cert(JSON.parse(sa)), databaseURL: url });
  }
  return true;
}

function ref(path) {
  return getDatabase().ref(path);
}

async function fetchRoomCodes() {
  const snap = await ref("roomCodes").get();
  return new Set(snap.val() || []);
}

async function addRoomCode(code) {
  const snap = await ref("roomCodes").get();
  const codes = snap.val() || [];
  codes.push(code);
  await ref("roomCodes").set(codes);
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  if (!initFirebase()) {
    return res.status(500).json({ error: "Firebase not configured" });
  }

  try {
    if (req.method === "GET") {
      const { code } = req.query;
      if (!code) return res.status(400).json({ error: "Missing code" });
      const snap = await ref(`rooms/${code}`).get();
      if (!snap.exists()) return res.status(404).json({ error: "Room not found" });
      return res.json(snap.val());
    }

    const body = req.body || {};
    const { action } = body;

    switch (action) {

      case "createRoom": {
        const { name, avatar, key } = body;
        if (!key) return res.json({ ok: false, error: "Missing player key" });
        const codes = await fetchRoomCodes();
        const code = makeCode(codes);
        const room = createRoom({ name, avatar, key });
        room.code = code;
        await ref(`rooms/${code}`).set(room);
        await addRoomCode(code);
        return res.json({ ok: true, code, state: "lobby" });
      }

      case "joinRoom": {
        const { code, name, avatar, key } = body;
        if (!key) return res.json({ ok: false, error: "Missing player key" });
        const snap = await ref(`rooms/${code}`).get();
        if (!snap.exists()) return res.json({ ok: false, error: "Room not found" });
        const room = snap.val();

        const existing = room.players.find((p) => p.id === key);
        if (existing) {
          existing.connected = true;
          await ref(`rooms/${code}`).update({ players: room.players });
          return res.json({ ok: true, code, state: room.state, rejoined: true });
        }

        if (room.state === "playing") return res.json({ ok: false, error: "Game already in progress" });
        if (room.players.length >= 12) return res.json({ ok: false, error: "Room is full (12 max)" });
        addPlayer(room, { name, avatar, key });
        await ref(`rooms/${code}`).update({ players: room.players });
        return res.json({ ok: true, code, state: room.state });
      }

      case "updateSettings": {
        const { code, settings } = body;
        const snap = await ref(`rooms/${code}`).get();
        if (!snap.exists()) return res.json({ ok: false });
        const room = snap.val();
        if (room.hostId !== body.key || room.state === "playing") return res.json({ ok: false });
        const s = room.settings;
        if ([1, 2, 3, 4, 5].includes(settings.lives)) s.lives = settings.lives;
        if ([10, 15, 20, 30].includes(settings.turnSeconds)) s.turnSeconds = settings.turnSeconds;
        if ([2, 3, 4, 5].includes(settings.minLength)) s.minLength = settings.minLength;
        if ([0, 1, 2, 3, 4, 5].includes(settings.maxSkips)) s.maxSkips = settings.maxSkips;
        await ref(`rooms/${code}`).update({ settings: s });
        return res.json({ ok: true });
      }

      case "startGame": {
        const { code, key } = body;
        const snap = await ref(`rooms/${code}`).get();
        if (!snap.exists()) return res.json({ ok: false });
        const room = snap.val();
        if (room.hostId !== key || room.state === "playing") return res.json({ ok: false });
        startGame(room);
        beginTurn(room);
        const evNum = (room.eventNum || 0) + 1;
        room.events = [{ type: "gameStarted" }];
        room.eventNum = evNum;
        await ref(`rooms/${code}`).set(room);
        return res.json({ ok: true });
      }

      case "submitWord": {
        const { code, word, key } = body;
        const snap = await ref(`rooms/${code}`).get();
        if (!snap.exists()) return res.json({ ok: false });
        const room = snap.val();
        const result = submitWordRaw(room, word, key);
        const newEvNum = (room.eventNum || 0) + 1;
        if (result.ok) {
          room.events = result.events;
          room.eventNum = newEvNum;
        } else {
          room.lastError = result.errors?.[0] || null;
          room.lastErrorNum = newEvNum;
        }
        await ref(`rooms/${code}`).set(room);
        return res.json({ ok: result.ok, errors: result.errors || [] });
      }

      case "timeout": {
        const { code } = body;
        const snap = await ref(`rooms/${code}`).get();
        if (!snap.exists()) return res.json({ ok: false });
        const room = snap.val();
        const g = room.game;
        if (!g || room.state !== "playing") return res.json({ ok: false });
        if (Date.now() < g.turnEndsAt) return res.json({ ok: false, error: "Too early" });
        const result = processTimeout(room);
        const evNum = (room.eventNum || 0) + 1;
        room.events = result.events;
        room.eventNum = evNum;
        await ref(`rooms/${code}`).set(room);
        return res.json({ ok: true });
      }

      case "playAgain": {
        const { code, key } = body;
        const snap = await ref(`rooms/${code}`).get();
        if (!snap.exists()) return res.json({ ok: false });
        const room = snap.val();
        if (room.hostId !== key || room.state === "playing") return res.json({ ok: false });
        room.state = "lobby";
        delete room.events;
        delete room.eventNum;
        delete room.lastResult;
        delete room.lastError;
        delete room.lastErrorNum;
        await ref(`rooms/${code}`).set(room);
        return res.json({ ok: true });
      }

      default:
        return res.status(400).json({ error: "Unknown action" });
    }
  } catch (err) {
    console.error("api/game error:", err);
    return res.status(500).json({ error: err.message });
  }
};
