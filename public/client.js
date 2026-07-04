/* global firebase, confetti */

firebase.initializeApp({
  apiKey: "AIzaSyCdKfqwuUqguGtxiT8QxYHe2oSD_pJJEQg",
  authDomain: "shiritori-9e4ba.firebaseapp.com",
  databaseURL: "https://shiritori-9e4ba-default-rtdb.firebaseio.com",
  projectId: "shiritori-9e4ba",
  storageBucket: "shiritori-9e4ba.firebasestorage.app",
  messagingSenderId: "867845060103",
  appId: "1:867845060103:web:13f3608642eff152811ca2",
  measurementId: "G-Y1TFXJNWCE",
});

const db = firebase.database();

const myKey =
  localStorage.getItem("ll-key") ||
  (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2) + Date.now());
localStorage.setItem("ll-key", myKey);

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

let room = null;
let roomCode = null;
let timerRAF = null;
let lastTickSecond = null;
let lastTurnPlayerId = null;
let turnKeyStrokes = 0;
let turnStartTime = 0;
let wpmInterval = null;
let prevValLength = 0;
let typingRef = null;
let typingHandler = null;
let localTimer = null;

// ---------- API helper ----------
async function api(body) {
  const r = await fetch("/api/game", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return r.json();
}

// ---------- Firebase room listener ----------
let roomRef = null;
let roomListener = null;

function listenRoom(code) {
  if (roomRef) { roomRef.off("value", roomListener); }
  roomCode = code;
  roomRef = db.ref("rooms/" + code);
  roomListener = (snap) => {
    const data = snap.val();
    if (!data) return;
    room = data;
    onRoomUpdate(data);
  };
  roomRef.on("value", roomListener);
}

let lastEventNum = 0;
let lastErrorNum = 0;

function onRoomUpdate(r) {
  const me = r.players.find(p => p.id === myKey);
  if (me && me.avatar !== myAvatar) {
    myAvatar = me.avatar;
    document.querySelectorAll(".avatar-option").forEach(el => {
      el.classList.toggle("selected", el.textContent === myAvatar);
    });
  }

  if (r.eventNum && r.eventNum > lastEventNum && r.events) {
    lastEventNum = r.eventNum;
    handleEvents(r.events);
  }

  if (r.lastErrorNum && r.lastErrorNum > lastErrorNum && r.lastError) {
    lastErrorNum = r.lastErrorNum;
    if (r.lastError.playerId === myKey) {
      sfx.reject();
      $("reject-msg").textContent = `❌ ${r.lastError.reason}`;
      clearTimeout($("reject-msg")._timer);
      $("reject-msg")._timer = setTimeout(() => ($("reject-msg").textContent = ""), 2000);
    }
  }

  if (r.state === "lobby") {
    $("overlay-gameover").classList.remove("active");
    if (!screens.lobby.classList.contains("active")) showScreen("lobby");
    renderLobby();
  } else if (r.state === "playing") {
    renderGame();
  } else if (r.state === "over") {
    handleGameOver(r);
  }
}

function handleGameOver(r) {
  cancelAnimationFrame(timerRAF);
  $("bomb").classList.remove("ticking");
  const result = r.lastResult;
  const winner = result ? result.stats.find(s => s.id === result.winnerId) : null;
  $("winner-avatar").textContent = winner ? winner.avatar : "🏁";
  $("winner-title").textContent = winner
    ? winner.id === myKey ? "🎉 YOU WIN! 🎉" : `${winner.name} wins!`
    : "Game over!";

  const statsWrap = $("over-stats");
  statsWrap.innerHTML = "";
  const stats = result ? result.stats : r.players;
  stats
    .sort((a, b) => b.wordsPlayed - a.wordsPlayed)
    .forEach((s) => {
      const row = document.createElement("div");
      row.className = "stat-row";
      row.innerHTML = `<span class="sr-name">${s.avatar} ${escapeHtml(s.name)}</span>
        <span class="sr-detail">${s.wordsPlayed} words${s.longestWord ? ` · longest: ${s.longestWord.toUpperCase()}` : ""}</span>`;
      statsWrap.appendChild(row);
    });

  const isHost = room && room.hostId === myKey;
  $("btn-again").style.display = isHost ? "" : "none";
  $("over-wait").style.display = isHost ? "none" : "";
  $("overlay-gameover").classList.add("active");
  if (winner && winner.id === myKey) {
    sfx.win();
    fireConfetti();
  }
}

// ---------- Firebase typing listener ----------
function listenTyping(code) {
  if (typingRef && typingHandler) {
    typingRef.off("value", typingHandler);
  }
  typingRef = db.ref("typing/" + code);
  typingHandler = (snap) => {
    const data = snap.val() || {};
    for (const pid in data) {
      const bubble = $("typing-" + pid);
      if (!bubble) continue;
      const text = data[pid] || "";
      bubble.textContent = text;
      bubble.classList.toggle("show", text.length > 0);
    }
    for (const el of document.querySelectorAll(".seat-typing.show")) {
      if (!data[el.id.replace("typing-", "")]) {
        el.textContent = "";
        el.classList.remove("show");
      }
    }
  };
  typingRef.on("value", typingHandler);
}

// ---------- Home actions ----------
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

$("btn-create").onclick = async () => {
  const name = getName();
  if (!name) return;
  const res = await api({ action: "createRoom", name, avatar: myAvatar, key: myKey });
  if (res.ok) {
    listenRoom(res.code);
    showScreen("lobby");
  }
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

async function attemptJoin(code, name, triesLeft) {
  const res = await api({ action: "joinRoom", code, name, avatar: myAvatar, key: myKey });
  if (res.ok) {
    $("home-error").textContent = "";
    listenRoom(code);
    showScreen(res.state === "playing" ? "game" : "lobby");
  } else if (res.error === "Room not found" && triesLeft > 0) {
    $("home-error").textContent = "Looking for room…";
    setTimeout(() => attemptJoin(code, name, triesLeft - 1), 1000);
  } else {
    $("home-error").textContent = res.error;
  }
}

// ---------- Lobby ----------
$("btn-copy").onclick = () => {
  navigator.clipboard.writeText(roomCode).then(() => toast("Code copied! 📋"));
};

$("btn-start").onclick = () => {
  api({ action: "startGame", code: roomCode, key: myKey });
};

$("btn-again").onclick = () => {
  api({ action: "playAgain", code: roomCode, key: myKey });
};

document.querySelectorAll(".seg").forEach((seg) => {
  const key = seg.dataset.setting;
  seg.dataset.values.split(",").forEach((v) => {
    const b = document.createElement("button");
    b.textContent = v;
    b.dataset.value = v;
    b.onclick = () => {
      if (!room || room.hostId !== myKey) return;
      api({ action: "updateSettings", code: roomCode, key: myKey, settings: { ...room.settings, [key]: Number(v) } });
    };
    seg.appendChild(b);
  });
});

function renderLobby() {
  $("lobby-code").textContent = roomCode;
  const isHost = room.hostId === myKey;
  const wrap = $("lobby-players");
  wrap.innerHTML = "";
  room.players.forEach((p) => {
    const d = document.createElement("div");
    d.className = "lobby-player";
    d.innerHTML = `<span class="av">${p.avatar}</span> ${escapeHtml(p.name)}${p.id === room.hostId ? ' <span class="crown">👑</span>' : ""}${p.id === myKey ? " (you)" : ""}`;
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

// ---------- Game rendering ----------
function renderGame() {
  if (!room) return;
  const g = room.game;
  if (!g) return;
  showScreen("game");
  $("game-code").textContent = roomCode;
  $("round-label").textContent = `Round ${g.round + 1}`;
  setChainDisplay(g.currentChain, g.chainLength);
  renderSeats();
  renderTurn();
  startTimerAnimation();
  listenTyping(roomCode);
}

const RING_CIRC = 2 * Math.PI * 52;

function setChainDisplay(chain, chainLength) {
  const el = $("current-letter");
  if (!el) return;
  el.textContent = chain.toUpperCase();
  el.classList.remove("chain-2", "chain-3", "chain-4", "chain-5", "chain-6");
  if (chainLength >= 2) el.classList.add("chain-" + Math.min(chainLength, 6));
  const label = $("bomb-label");
  if (label) label.textContent = "";
}

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

function seatPosition(i, n) {
  const angle = orbitAngle(i, n);
  const r = orbitRadius(n);
  return { x: 50 + r * Math.cos(angle), y: 50 + r * Math.sin(angle), angle };
}

function renderTurnRing(ordered, turnPlayerId, nextPlayerId) {
  const svg = $("turn-ring");
  const arena = document.querySelector(".arena");
  const isMulti = ordered.length >= 2;
  arena?.classList.toggle("multiplayer", isMulti);
  if (!svg || !isMulti) { if (svg) svg.innerHTML = ""; return; }
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
    el.title = p.name;
    el.textContent = p.avatar;
    container.appendChild(el);
  });
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
      ${badge}
      <div class="orbit-avatar">
        <span class="orbit-order">${i + 1}</span>
        ${p.avatar}
      </div>
      <div class="orbit-name">${escapeHtml(p.name)}${p.id === myKey ? " ⭐" : ""}</div>
      <div class="orbit-lives">${hearts}</div>
      <div id="typing-${p.id}" class="seat-typing"></div>`;
    orbit.appendChild(el);
  });
}

function renderSeats() {
  const g = room.game;
  const ordered = playersInTurnOrder();
  const nextId = nextTurnPlayerId(g.turnPlayerId);
  const isMulti = ordered.length >= 2;
  renderBombOrbit(ordered, g.turnPlayerId, nextId, isMulti);
  renderPlayerOrbit(ordered, g.turnPlayerId, nextId, isMulti);
  renderTurnRing(ordered, g.turnPlayerId, nextId);
}

function renderTurn() {
  const g = room.game;
  const me = g.turnPlayerId === myKey;
  const turnPlayer = room.players.find((p) => p.id === g.turnPlayerId);
  const input = $("word-input");
  const submitBtn = $("word-form").querySelector("button");
  const wpmEl = $("wpm-display");

  if (me) {
    $("turn-indicator").innerHTML = `<span class="you">🔥 YOUR TURN! 🔥</span>`;
    input.disabled = false;
    submitBtn.disabled = false;
    input.placeholder = "type a word…";
    input.value = "";
    input.focus();
    turnKeyStrokes = 0;
    turnStartTime = 0;
    prevValLength = 0;
    if (wpmEl) wpmEl.textContent = "";
    clearInterval(wpmInterval);
    if (lastTurnPlayerId !== myKey) sfx.yourTurn();
  } else {
    const alive = aliveTurnOrder();
    const myPos = alive.indexOf(myKey);
    const curPos = alive.indexOf(g.turnPlayerId);
    let msg = turnPlayer ? `${turnPlayer.name}'s turn` : "";
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
    if (wpmEl) wpmEl.textContent = "";
    clearInterval(wpmInterval);
  }
  lastTurnPlayerId = g.turnPlayerId;
  $("bomb").classList.add("ticking");
  startLocalTimer(g.turnEndsAt);
}

function updateWpm() {
  const wpmEl = $("wpm-display");
  if (!wpmEl) return;
  if (turnStartTime === 0 || turnKeyStrokes === 0) { wpmEl.textContent = ""; return; }
  const elapsed = (Date.now() - turnStartTime) / 1000 / 60;
  if (elapsed < 0.01) { wpmEl.textContent = "..."; return; }
  const wpm = Math.round((turnKeyStrokes / 5) / elapsed);
  wpmEl.textContent = wpm + " WPM";
}

function startLocalTimer(turnEndsAt) {
  clearTimeout(localTimer);
  const delay = Math.max(0, turnEndsAt - Date.now());
  localTimer = setTimeout(() => {
    api({ action: "timeout", code: roomCode, key: myKey });
  }, delay + 200);
}

function startTimerAnimation() {
  cancelAnimationFrame(timerRAF);
  const g = room.game;
  const ringFg = $("ring-fg");
  const total = g.turnSeconds * 1000;
  function frame() {
    if (!room?.game) return;
    const remaining = Math.max(0, room.game.turnEndsAt - Date.now());
    const frac = remaining / total;
    ringFg.style.strokeDashoffset = RING_CIRC * (1 - frac);
    ringFg.classList.toggle("hot", frac < 0.35);
    const sec = Math.ceil(remaining / 1000);
    if (sec <= 5 && sec !== lastTickSecond && remaining > 0) {
      lastTickSecond = sec;
      sfx.tick();
    }
    timerRAF = requestAnimationFrame(frame);
  }
  frame();
}

// ---------- Word input ----------
$("word-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = $("word-input");
  if (input.disabled || !room?.game || room.game.turnPlayerId !== myKey) return;
  const word = input.value.trim();
  if (!word) return;
  input.value = "";
  $("wpm-display").textContent = "";
  clearInterval(wpmInterval);
  await db.ref("typing/" + roomCode + "/" + myKey).remove();
  const res = await api({ action: "submitWord", code: roomCode, word, key: myKey });
  if (!res.ok && res.errors) {
    for (const err of res.errors) {
      if (err.playerId === myKey) {
        sfx.reject();
        $("reject-msg").textContent = `❌ ${err.reason}`;
        clearTimeout($("reject-msg")._timer);
        $("reject-msg")._timer = setTimeout(() => ($("reject-msg").textContent = ""), 2000);
      }
    }
  }
  // Events will arrive via the Firebase listener
});

$("word-input").addEventListener("input", (e) => {
  if (e.target.disabled || !room?.game || room.game.turnPlayerId !== myKey) return;
  const val = e.target.value;
  db.ref("typing/" + roomCode + "/" + myKey).set(val);
  turnKeyStrokes += val.length - (prevValLength || 0);
  prevValLength = val.length;
  if (turnStartTime === 0 && val.length > 0) {
    turnStartTime = Date.now();
    clearInterval(wpmInterval);
    wpmInterval = setInterval(updateWpm, 500);
  }
  updateWpm();
});

// ---------- Event handling ----------
function handleEvents(events) {
  for (const ev of events) {
    switch (ev.type) {
      case "accepted": {
        const p = room?.players.find((pl) => pl.id === ev.playerId);
        const name = p ? p.name : "???";
        sfx.accept();
        addFeed("good", `<span class="who">${escapeHtml(name)}:</span> <span class="word">${ev.word.toUpperCase()}</span>${ev.bonusLife ? " 💖 +1 life (8+ letters!)" : ""}`);
        $("last-word-banner").innerHTML = highlightWordSuffix(ev.word, ev.chainLength);
        if (ev.chainLength > 1) {
          const prevLen = room?.game?.chainLength || 1;
          if (ev.chainLength > prevLen) {
            toast(`🔗 Chain up! Next word starts with "${ev.nextChain.toUpperCase()}" (${ev.chainLength} letters)`);
          }
        }
        if (ev.bonusLife && ev.playerId === myKey) toast("💖 Long word bonus — +1 life!");
        const typingBubble = $("typing-" + ev.playerId);
        if (typingBubble) typingBubble.textContent = "";
        if (ev.playerId === myKey) {
          const wi = $("word-input");
          if (wi) wi.value = "";
        }
        $("wpm-display").textContent = "";
        clearInterval(wpmInterval);
        break;
      }
      case "boom": {
        sfx.boom();
        const bomb = $("bomb");
        bomb.classList.remove("exploded");
        void bomb.offsetWidth;
        bomb.classList.add("exploded");
        const pl = room?.players.find((pl) => pl.id === ev.playerId);
        if (pl) addFeed("bad", `💥 <span class="who">${escapeHtml(pl.name)}</span> ran out of time! ${ev.livesLeft > 0 ? `${ev.livesLeft} ❤️ left` : ""}`);
        if (ev.playerId === myKey && ev.livesLeft > 0) toast("💥 BOOM! You lost a life!");
        break;
      }
      case "eliminated": {
        addFeed("info", ev.left ? `🚪 ${escapeHtml(ev.name)} left the game` : `💀 ${escapeHtml(ev.name)} is out!`);
        if (ev.playerId === myKey) toast("💀 You're out! Watch the rest of the match.");
        break;
      }
      case "chainSkip": {
        const label = ev.chainLength === 1 ? "letter" : `letters`;
        addFeed("info", `🔄 Chain skipped! New starts with: "${ev.chain.toUpperCase()}" (${ev.chainLength} ${label})`);
        toast(`🔄 Nobody got it — new chain: "${ev.chain.toUpperCase()}"`);
        break;
      }
    }
  }
}

function highlightWordSuffix(word, chainLength) {
  const n = Math.min(chainLength || 1, word.length);
  const base = word.slice(0, -n).toUpperCase();
  const tail = word.slice(-n).toUpperCase();
  return `<span class="w">${base}<span class="hl">${tail}</span></span>`;
}

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
