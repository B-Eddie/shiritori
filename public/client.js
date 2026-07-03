/* global io, confetti */
// WebSocket-only transport is required on Vercel (no HTTP long-polling fallback).
const socket = io({
  path: "/api/socket-io/socket.io",
  transports: ["websocket"],
  addTrailingSlash: false,
});

// Persistent identity so we can reattach to our seat after a dropped
// connection (page refresh, or Vercel recycling the function instance).
const myKey =
  localStorage.getItem("ll-key") ||
  (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2) + Date.now());
localStorage.setItem("ll-key", myKey);

// ---------- helpers ----------
const $ = (id) => document.getElementById(id);
const screens = { home: $("screen-home"), lobby: $("screen-lobby"), game: $("screen-game") };

function showScreen(name) {
  Object.values(screens).forEach((s) => s.classList.remove("active"));
  screens[name].classList.add("active");
}

function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove("show"), 2200);
}

// ---------- simple sounds (WebAudio) ----------
let audioCtx = null;
function beep(freq, dur = 0.08, type = "square", vol = 0.05) {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.type = type;
    o.frequency.value = freq;
    g.gain.value = vol;
    g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + dur);
    o.connect(g).connect(audioCtx.destination);
    o.start();
    o.stop(audioCtx.currentTime + dur);
  } catch (e) { /* audio not available */ }
}
const sfx = {
  accept: () => { beep(660, 0.09, "sine", 0.08); setTimeout(() => beep(990, 0.12, "sine", 0.08), 70); },
  reject: () => beep(160, 0.18, "sawtooth", 0.07),
  boom: () => { beep(90, 0.35, "sawtooth", 0.12); beep(60, 0.4, "square", 0.1); },
  tick: () => beep(1100, 0.03, "square", 0.025),
  win: () => [523, 659, 784, 1047].forEach((f, i) => setTimeout(() => beep(f, 0.18, "sine", 0.09), i * 130)),
  yourTurn: () => beep(880, 0.12, "triangle", 0.07),
};

// ---------- avatar picker ----------
const AVATARS = ["🐸","🦊","🐼","🐙","🦄","🐧","🐯","🦖","🐝","🐢","🦉","🐌","🍕","🌮","🍩","🤖","👻","🎃","🌵","🦩","🐳","🧀","🍄","⚡"];
let myAvatar = AVATARS[(Math.random() * AVATARS.length) | 0];

const grid = $("avatar-grid");
AVATARS.forEach((a) => {
  const d = document.createElement("div");
  d.className = "avatar-option" + (a === myAvatar ? " selected" : "");
  d.textContent = a;
  d.onclick = () => {
    grid.querySelectorAll(".selected").forEach((el) => el.classList.remove("selected"));
    d.classList.add("selected");
    myAvatar = a;
    beep(740, 0.05, "sine", 0.04);
  };
  grid.appendChild(d);
});

$("name-input").value = localStorage.getItem("ll-name") || "";

// ---------- state ----------
let room = null;
const myId = myKey; // players are identified by persistent key, not socket id
let timerRAF = null;
let lastTickSecond = null;
let lastTurnPlayerId = null;
let wasDisconnected = false;

socket.on("connect", () => {
  // Reattach to our room after a dropped connection (refresh, server recycle)
  if (wasDisconnected && room) {
    wasDisconnected = false;
    socket.emit(
      "joinRoom",
      { code: room.code, name: localStorage.getItem("ll-name") || "Player", avatar: myAvatar, key: myKey },
      (res) => {
        if (res.ok) toast("Reconnected! 🔌");
        else {
          room = null;
          showScreen("home");
          $("home-error").textContent = "Connection lost — the room is gone.";
        }
      }
    );
  }
});

function getName() {
  const n = $("name-input").value.trim();
  if (!n) {
    $("home-error").textContent = "Pick a name first!";
    $("name-input").focus();
    return null;
  }
  localStorage.setItem("ll-name", n);
  $("home-error").textContent = "";
  return n;
}

// ---------- home actions ----------
$("btn-create").onclick = () => {
  const name = getName();
  if (!name) return;
  socket.emit("createRoom", { name, avatar: myAvatar, key: myKey }, (res) => {
    if (res.ok) showScreen("lobby");
  });
};

$("btn-join").onclick = joinRoom;
$("code-input").addEventListener("keydown", (e) => { if (e.key === "Enter") joinRoom(); });

function joinRoom() {
  const name = getName();
  if (!name) return;
  const code = $("code-input").value.trim().toUpperCase();
  if (code.length !== 4) {
    $("home-error").textContent = "Room codes are 4 characters";
    return;
  }
  attemptJoin(code, name, 3);
}

// The room lives in the server instance the host is connected to. If our
// connection landed on a different (fresh) instance, reconnect and retry —
// subsequent connections are routed to the warm instance holding the room.
function attemptJoin(code, name, triesLeft) {
  socket.emit("joinRoom", { code, name, avatar: myAvatar, key: myKey }, (res) => {
    if (res.ok) {
      $("home-error").textContent = "";
      showScreen(res.state === "playing" ? "game" : "lobby");
    } else if (res.error === "Room not found" && triesLeft > 0) {
      $("home-error").textContent = "Looking for room…";
      socket.disconnect();
      setTimeout(() => {
        socket.connect();
        socket.once("connect", () => attemptJoin(code, name, triesLeft - 1));
      }, 700);
    } else {
      $("home-error").textContent = res.error;
    }
  });
}

// ---------- lobby ----------
$("btn-copy").onclick = () => {
  navigator.clipboard.writeText(room.code).then(() => toast("Code copied! 📋"));
};

$("btn-start").onclick = () => socket.emit("startGame");
$("btn-again").onclick = () => socket.emit("playAgain");

document.querySelectorAll(".seg").forEach((seg) => {
  const key = seg.dataset.setting;
  seg.dataset.values.split(",").forEach((v) => {
    const b = document.createElement("button");
    b.textContent = v;
    b.dataset.value = v;
    b.onclick = () => {
      if (!room || room.hostId !== myId) return;
      socket.emit("updateSettings", { ...room.settings, [key]: Number(v) });
    };
    seg.appendChild(b);
  });
});

function renderLobby() {
  $("lobby-code").textContent = room.code;
  const isHost = room.hostId === myId;

  const wrap = $("lobby-players");
  wrap.innerHTML = "";
  room.players.forEach((p) => {
    const d = document.createElement("div");
    d.className = "lobby-player";
    d.innerHTML = `<span class="av">${p.avatar}</span> ${escapeHtml(p.name)}${p.id === room.hostId ? ' <span class="crown">👑</span>' : ""}${p.id === myId ? " (you)" : ""}`;
    wrap.appendChild(d);
  });

  document.querySelectorAll(".seg").forEach((seg) => {
    const key = seg.dataset.setting;
    seg.querySelectorAll("button").forEach((b) => {
      b.classList.toggle("on", Number(b.dataset.value) === room.settings[key]);
      b.disabled = !isHost;
    });
  });

  $("btn-start").style.display = isHost ? "" : "none";
  $("lobby-wait").style.display = isHost ? "none" : "";
}

// ---------- room updates ----------
socket.on("room", (r) => {
  room = r;
  const me = r.players.find(p => p.id === myId);
  if (me && me.avatar !== myAvatar) {
    myAvatar = me.avatar;
    document.querySelectorAll(".avatar-option").forEach(el => {
      el.classList.toggle("selected", el.textContent === myAvatar);
    });
  }
  if (r.state === "lobby") {
    $("overlay-gameover").classList.remove("active");
    if (!screens.lobby.classList.contains("active")) showScreen("lobby");
    renderLobby();
  } else if (r.state === "playing") {
    renderGame();
  }
});

socket.on("gameStarted", () => {
  $("word-feed").innerHTML = "";
  $("last-word-banner").innerHTML = "";
  $("overlay-gameover").classList.remove("active");
  showScreen("game");
  addFeed("info", "🎮 Game on! One player at a time — turns go clockwise around the circle.");
  renderGame();
});

function playersInTurnOrder() {
  const g = room.game;
  const byId = new Map(room.players.map((p) => [p.id, p]));
  const order = g?.turnOrder || room.players.map((p) => p.id);
  const ordered = order.map((id) => byId.get(id)).filter(Boolean);
  for (const p of room.players) {
    if (!ordered.includes(p)) ordered.push(p);
  }
  return ordered;
}

function aliveTurnOrder() {
  const g = room.game;
  const order = g?.turnOrder || room.players.map((p) => p.id);
  return order.filter((id) => {
    const p = room.players.find((pl) => pl.id === id);
    return p && p.alive;
  });
}

function nextTurnPlayerId(currentId) {
  const alive = aliveTurnOrder();
  if (!alive.length) return null;
  const idx = alive.indexOf(currentId);
  if (idx === -1) return alive[0];
  return alive[(idx + 1) % alive.length];
}

function orbitAngle(i, n) {
  return (i / n) * Math.PI * 2 - Math.PI / 2;
}

function orbitRadius(n) {
  if (n <= 2) return 38;
  if (n <= 4) return 42;
  if (n <= 6) return 44;
  return 46;
}

// Percentage coords for the turn-order SVG (viewBox 0 0 100 100).
function seatPosition(i, n) {
  const angle = orbitAngle(i, n);
  const r = orbitRadius(n);
  return {
    x: 50 + r * Math.cos(angle),
    y: 50 + r * Math.sin(angle),
    angle,
  };
}

function renderTurnRing(ordered, turnPlayerId, nextPlayerId) {
  const svg = $("turn-ring");
  const arena = document.querySelector(".arena");
  const isMulti = ordered.length >= 2;
  arena?.classList.toggle("multiplayer", isMulti);
  if (!svg || !isMulti) {
    if (svg) svg.innerHTML = "";
    return;
  }
  const n = ordered.length;
  const parts = [];
  for (let i = 0; i < n; i++) {
    const a = seatPosition(i, n);
    const b = seatPosition((i + 1) % n, n);
    const from = ordered[i];
    const to = ordered[(i + 1) % n];
    const active = from.id === turnPlayerId && to.id === nextPlayerId;
    parts.push(
      `<line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" class="turn-arrow${active ? " active" : ""}"/>`
    );
  }
  svg.innerHTML = parts.join("");
}

function formatChain(chain, chainLength) {
  return chain.toUpperCase();
}

function highlightWordSuffix(word, chainLength) {
  const n = Math.min(chainLength || 1, word.length);
  const base = word.slice(0, -n).toUpperCase();
  const tail = word.slice(-n).toUpperCase();
  return `<span class="w">${base}<span class="hl">${tail}</span></span>`;
}

function renderBombOrbit(ordered, turnPlayerId, nextId, isMulti) {
  const container = $("bomb-orbit");
  if (!container) return;
  container.innerHTML = "";
  if (!isMulti) return;
  const n = ordered.length;
  const r = 55;
  ordered.forEach((p, i) => {
    const angle = orbitAngle(i, n);
    const el = document.createElement("div");
    el.className = "bomb-orbit-player";
    if (!p.alive || !p.connected) el.classList.add("dead");
    if (turnPlayerId === p.id) el.classList.add("turn");
    if (nextId === p.id) el.classList.add("next");
    el.style.left = `calc(50% + ${Math.cos(angle) * r}%)`;
    el.style.top = `calc(50% + ${Math.sin(angle) * r}%)`;
    el.textContent = p.avatar;
    el.title = p.name;
    container.appendChild(el);
  });
}

function setChainDisplay(chain, chainLength) {
  const el = $("current-letter");
  if (!el) return;
  el.textContent = formatChain(chain, chainLength);
  el.classList.remove("chain-2", "chain-3", "chain-4", "chain-5", "chain-6");
  if (chainLength >= 2) el.classList.add("chain-" + Math.min(chainLength, 6));
  const label = $("bomb-label");
  if (label) label.textContent = chainLength === 1 ? "starts with" : `starts with (${chainLength} letters)`;
}

// ---------- game rendering ----------
const RING_CIRC = 2 * Math.PI * 52; // matches SVG r=52

function renderGame() {
  if (!room.game) return;
  showScreen("game");
  const g = room.game;

  $("game-code").textContent = room.code;
  $("round-label").textContent = `Round ${g.round + 1}`;
  setChainDisplay(g.currentChain, g.chainLength);

  renderSeats();
  renderTurn();
  startTimerAnimation();
}

function renderSeats() {
  const g = room.game;
  const ordered = playersInTurnOrder();
  const n = ordered.length;
  const nextId = nextTurnPlayerId(g.turnPlayerId);
  const isMulti = n >= 2;

  renderBombOrbit(ordered, g.turnPlayerId, nextId, isMulti);
  renderPlayerOrbit(ordered, g.turnPlayerId, nextId, isMulti);
  renderOuterSeats(ordered, g.turnPlayerId, nextId, isMulti);
  renderTurnRing(ordered, g.turnPlayerId, nextId);
}

function renderPlayerOrbit(ordered, turnPlayerId, nextId, isMulti) {
  const orbit = $("player-orbit");
  orbit.innerHTML = "";
  orbit.classList.toggle("active", isMulti);
  if (!isMulti) return;

  const n = ordered.length;
  ordered.forEach((p, i) => {
    const pos = seatPosition(i, n);
    const el = document.createElement("div");
    el.className = "orbit-player";
    el.id = "seat-" + p.id;
    el.style.left = pos.x + "%";
    el.style.top = pos.y + "%";
    if (!p.alive || !p.connected) el.classList.add("dead");
    else if (turnPlayerId === p.id) el.classList.add("turn");
    else if (nextId === p.id) el.classList.add("next");
    else el.classList.add("waiting");

    const badge =
      turnPlayerId === p.id ? '<span class="orbit-badge now">NOW</span>' :
      nextId === p.id ? '<span class="orbit-badge next">NEXT</span>' : "";

    const hearts = p.alive ? "❤️".repeat(Math.max(0, p.lives)) : "";
    el.innerHTML = `
      <div class="seat-typing" id="typing-${p.id}"></div>
      ${badge}
      <div class="orbit-avatar">
        <span class="orbit-order">${i + 1}</span>
        ${p.avatar}
      </div>
      <div class="orbit-name">${escapeHtml(p.name)}${p.id === myId ? " ⭐" : ""}</div>
      <div class="orbit-lives">${hearts}</div>`;
    orbit.appendChild(el);
  });
}

// Solo labels for 1-player edge case; multiplayer uses the orbit around the letter.
function renderOuterSeats(ordered, turnPlayerId, nextId, isMulti) {
  const ring = $("players-ring");
  ring.innerHTML = "";
  ring.classList.toggle("hidden", isMulti);
  if (isMulti) return;

  ordered.forEach((p, i) => {
    const seat = document.createElement("div");
    seat.className = "seat";
    seat.id = "seat-" + p.id;
    seat.style.left = "50%";
    seat.style.top = "18%";
    if (!p.alive || !p.connected) seat.classList.add("dead");
    else if (turnPlayerId === p.id) seat.classList.add("turn");

    const hearts = p.alive ? "❤️".repeat(Math.max(0, p.lives)) : "";
    seat.innerHTML = `
      <div class="seat-typing" id="typing-${p.id}"></div>
      <div class="seat-avatar">
        <span class="seat-order">${i + 1}</span>
        ${p.avatar}
      </div>
      <div class="seat-name">${escapeHtml(p.name)}${p.id === myId ? " ⭐" : ""}</div>
      <div class="seat-lives">${hearts}</div>`;
    ring.appendChild(seat);
  });
}

function renderTurn() {
  const g = room.game;
  const me = g.turnPlayerId === myId;
  const turnPlayer = room.players.find((p) => p.id === g.turnPlayerId);
  const input = $("word-input");
  const submitBtn = $("word-form").querySelector("button");

  if (me) {
    $("turn-indicator").innerHTML = `<span class="you">🔥 YOUR TURN! 🔥</span>`;
    input.disabled = false;
    submitBtn.disabled = false;
    input.placeholder = "type a word…";
    input.focus();
    if (lastTurnPlayerId !== myId) sfx.yourTurn();
  } else {
    const alive = aliveTurnOrder();
    const myPos = alive.indexOf(myId);
    const curPos = alive.indexOf(g.turnPlayerId);
    let msg = turnPlayer ? `${turnPlayer.avatar} ${turnPlayer.name}'s turn` : "";
    if (myPos >= 0 && curPos >= 0 && myPos !== curPos) {
      const ahead = (myPos - curPos + alive.length) % alive.length;
      if (ahead === 1) msg += " — you're up next!";
      else if (ahead > 1) msg += ` — you're #${ahead + 1} in the circle`;
    } else if (myPos < 0) {
      msg = "You're out — watch the circle!";
    }
    $("turn-indicator").textContent = msg;
    input.disabled = true;
    submitBtn.disabled = true;
    input.placeholder = "wait for your turn…";
    input.value = "";
  }
  lastTurnPlayerId = g.turnPlayerId;
  $("bomb").classList.add("ticking");
}

function startTimerAnimation() {
  cancelAnimationFrame(timerRAF);
  const g = room.game;
  const ringFg = $("ring-fg");
  const total = g.turnSeconds * 1000;

  function frame() {
    if (!room.game) return;
    const remaining = Math.max(0, room.game.turnEndsAt - Date.now());
    const frac = remaining / total;
    ringFg.style.strokeDashoffset = RING_CIRC * (1 - frac);
    ringFg.classList.toggle("hot", frac < 0.35);

    // tick sound in the final 5 seconds
    const sec = Math.ceil(remaining / 1000);
    if (sec <= 5 && sec !== lastTickSecond && remaining > 0) {
      lastTickSecond = sec;
      sfx.tick();
    }
    timerRAF = requestAnimationFrame(frame);
  }
  frame();
}

// ---------- word input ----------
$("word-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const input = $("word-input");
  if (input.disabled || !room?.game || room.game.turnPlayerId !== myId) return;
  const word = input.value.trim();
  if (!word) return;
  socket.emit("submitWord", word);
  input.value = "";
  socket.emit("typing", "");
});

$("word-input").addEventListener("input", (e) => {
  if (e.target.disabled || !room?.game || room.game.turnPlayerId !== myId) return;
  socket.emit("typing", e.target.value);
});

// ---------- game events ----------
socket.on("typing", ({ playerId, text }) => {
  const bubble = $("typing-" + playerId);
  if (!bubble) return;
  bubble.textContent = text;
  bubble.classList.toggle("show", text.length > 0);
});

socket.on("wordAccepted", ({ playerId, word, bonusLife, nextChain, chainLength }) => {
  const p = room?.players.find((pl) => pl.id === playerId);
  const name = p ? p.name : "???";
  sfx.accept();
  addFeed("good", `<span class="who">${escapeHtml(name)}:</span> <span class="word">${word.toUpperCase()}</span>${bonusLife ? " 💖 +1 life (8+ letters!)" : ""}`);
  $("last-word-banner").innerHTML = highlightWordSuffix(word, chainLength);
  if (chainLength > 1) {
    const prevLen = room?.game?.chainLength || 1;
    if (chainLength > prevLen) {
      toast(`🔗 Chain up! Next word starts with "${nextChain.toUpperCase()}" (${chainLength} letters)`);
    }
  }
  if (bonusLife && playerId === myId) toast("💖 Long word bonus — +1 life!");
});

socket.on("wordRejected", ({ playerId, word, reason }) => {
  const seat = $("seat-" + playerId);
  if (seat) {
    seat.classList.remove("shake");
    void seat.offsetWidth;
    seat.classList.add("shake");
  }
  if (playerId === myId) {
    sfx.reject();
    const input = $("word-input");
    input.classList.remove("wrong");
    void input.offsetWidth;
    input.classList.add("wrong");
    $("reject-msg").textContent = `❌ ${reason}`;
    clearTimeout($("reject-msg")._timer);
    $("reject-msg")._timer = setTimeout(() => ($("reject-msg").textContent = ""), 2000);
  }
  const p = room?.players.find((pl) => pl.id === playerId);
  if (p && word) addFeed("bad", `<span class="who">${escapeHtml(p.name)}:</span> ${word.toUpperCase()} — ${reason}`);
});

socket.on("boom", ({ playerId, livesLeft }) => {
  sfx.boom();
  const bomb = $("bomb");
  bomb.classList.remove("exploded");
  void bomb.offsetWidth;
  bomb.classList.add("exploded");
  const p = room?.players.find((pl) => pl.id === playerId);
  if (p) addFeed("bad", `💥 <span class="who">${escapeHtml(p.name)}</span> ran out of time! ${livesLeft > 0 ? `${livesLeft} ❤️ left` : ""}`);
  if (playerId === myId && livesLeft > 0) toast("💥 BOOM! You lost a life!");
});

socket.on("eliminated", ({ playerId, name, left }) => {
  addFeed("info", left ? `🚪 ${escapeHtml(name)} left the game` : `💀 ${escapeHtml(name)} is out!`);
  if (playerId === myId) toast("💀 You're out! Watch the rest of the match.");
});

socket.on("chainSkip", ({ chain, chainLength }) => {
  const label = chainLength === 1 ? "letter" : `letters`;
  addFeed("info", `🔄 Chain skipped! New starts with: "${chain.toUpperCase()}" (${chainLength} ${label})`);
  toast(`🔄 Nobody got it — new chain: "${chain.toUpperCase()}"`);
});

socket.on("gameOver", ({ winnerId, winnerName, stats }) => {
  cancelAnimationFrame(timerRAF);
  $("bomb").classList.remove("ticking");

  const winner = stats.find((s) => s.id === winnerId);
  $("winner-avatar").textContent = winner ? winner.avatar : "🏁";
  $("winner-title").textContent = winnerId
    ? winnerId === myId ? "🎉 YOU WIN! 🎉" : `${winnerName} wins!`
    : "Game over!";

  const statsWrap = $("over-stats");
  statsWrap.innerHTML = "";
  stats
    .sort((a, b) => b.wordsPlayed - a.wordsPlayed)
    .forEach((s) => {
      const row = document.createElement("div");
      row.className = "stat-row";
      row.innerHTML = `<span class="sr-name">${s.avatar} ${escapeHtml(s.name)}</span>
        <span class="sr-detail">${s.wordsPlayed} words${s.longestWord ? ` · longest: ${s.longestWord.toUpperCase()}` : ""}</span>`;
      statsWrap.appendChild(row);
    });

  const isHost = room && room.hostId === myId;
  $("btn-again").style.display = isHost ? "" : "none";
  $("over-wait").style.display = isHost ? "none" : "";
  $("overlay-gameover").classList.add("active");

  if (winnerId === myId) {
    sfx.win();
    fireConfetti();
  }
});

socket.on("disconnect", () => {
  if (room) {
    wasDisconnected = true;
    toast("Connection lost — reconnecting… 🔌");
  }
});

// ---------- misc ----------
function addFeed(kind, html) {
  const feed = $("word-feed");
  const d = document.createElement("div");
  d.className = "feed-item " + kind;
  d.innerHTML = html;
  feed.prepend(d);
  while (feed.children.length > 40) feed.lastChild.remove();
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function fireConfetti() {
  if (typeof confetti !== "function") return;
  const end = Date.now() + 1600;
  (function frame() {
    confetti({ particleCount: 5, angle: 60, spread: 60, origin: { x: 0 } });
    confetti({ particleCount: 5, angle: 120, spread: 60, origin: { x: 1 } });
    if (Date.now() < end) requestAnimationFrame(frame);
  })();
}
