# Last Letter! 💣 (English Shiritori)

A fast-paced multiplayer word game inspired by **jklm.fun** and the Roblox game **Last Letter**.
Say a word that starts with the last letter of the previous word — before the bomb goes off!

## How to run

```bash
npm install
npm start
```

Then open http://localhost:3000 in your browser.

## How to play

1. Enter a name, pick an emoji avatar, and **Create Room** (or **Join** with a 4-letter code).
2. Share the room code with friends — works 1v1 or with a group (up to 12 players).
3. The host picks the settings (lives, seconds per turn, minimum word length) and starts the game.
4. On your turn, type an English word that:
   - starts with the shown letter,
   - hasn't been used yet this game,
   - is a real dictionary word.
5. Run out of time and 💥 you lose a life. Lose all your lives and you're out.
6. Last player standing wins! 🏆

### Extras

- ⏩ Turns get faster as the game goes on.
- 💖 Play a word with **8+ letters** to regain a lost life.
- 👀 Everyone can see what the current player is typing, live (just like jklm.fun).

## Tech

- Node.js + Express + Socket.IO for real-time rooms
- ~370k word English dictionary (`dwyl/english-words`)
- Vanilla JS/CSS front end, no build step

## Deployment (Vercel)

Live at: https://shiritori-three.vercel.app

- `public/` is served as static files; the Socket.IO server runs as a Vercel
  Function (`api/socket-io.js`) using Vercel's WebSocket support (requires
  Fluid compute, on by default for new projects).
- `vercel.json` rewrites `/api/socket-io/*` to the function, and the client
  connects with `transports: ["websocket"]` and `addTrailingSlash: false`
  (Vercel's rewrite does not match the trailing-slash URL Socket.IO uses by
  default).
- Room state lives in the function instance's memory. Connections are pinned
  to an instance, and if a joiner lands on a different instance the client
  reconnects and retries until it finds the room. Players also carry a
  persistent key in `localStorage` so they reattach to their seat after a
  refresh or dropped connection (20s grace period).

Deploy with:

```bash
vercel deploy --prod
```
