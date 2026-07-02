// Serveur temps réel Socket.IO (hébergé dans le bot, port REALTIME_PORT, défaut 3718).
// nginx route /socket.io/ → bot:3718. Remplace l'ancien service lol-realtime.
//
// - Auth par le cookie de session (HMAC USER_JWT_SECRET, identique au web).
// - Rooms server:{id} et user:{id} (depuis les cookies user_session + sv).
// - S'abonne à Redis et relaie vers les rooms :
//     pedanrift:server:{id} → emit "pedanrift:refresh"  (room server)
//     announce:server:{id}  → emit "notif:announce"     (room server)
//     bets:user:{id}        → emit "bet:resolved"        (room user)
//     notif:user:{id}       → emit "notif:personal"      (room user)
//   (noms conservés tels quels ; le renommage Ascentix se fera côté web+bot ensemble.)
const http = require("http");
const { createHmac, timingSafeEqual } = require("crypto");
const { Server } = require("socket.io");
const { createAdapter } = require("@socket.io/redis-adapter");
const Redis = require("ioredis");

const PORT = parseInt(process.env.REALTIME_PORT || "3718", 10);

function verifyToken(token, secret) {
  const dot = token.lastIndexOf(".");
  if (dot === -1) return null;
  const data = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  const expected = createHmac("sha256", secret).update(data).digest("hex");
  try {
    if (!timingSafeEqual(Buffer.from(mac, "hex"), Buffer.from(expected, "hex"))) return null;
  } catch { return null; }
  try {
    const p = JSON.parse(Buffer.from(data, "base64url").toString());
    if (p.exp < Date.now()) return null;
    return p;
  } catch { return null; }
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i === -1) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

function startRealtimeServer() {
  const redisUrl = process.env.REDIS_URL;
  const secret = process.env.USER_JWT_SECRET;
  if (!redisUrl || !secret) {
    console.warn("⚠️  REDIS_URL ou USER_JWT_SECRET manquant — serveur temps réel non démarré.");
    return;
  }

  const httpServer = http.createServer((req, res) => {
    if (req.url === "/health") { res.writeHead(200); res.end("ok"); return; }
    res.writeHead(404); res.end();
  });

  const io = new Server(httpServer, { path: "/socket.io" });

  // Adapter Redis (scaling multi-instances)
  const pub = new Redis(redisUrl);
  const sub = pub.duplicate();
  pub.on("error", (e) => console.error("[realtime] redis pub:", e.message));
  sub.on("error", (e) => console.error("[realtime] redis sub:", e.message));
  io.adapter(createAdapter(pub, sub));

  // Auth + join des rooms
  io.use((socket, next) => {
    const cookies = parseCookies(socket.handshake.headers.cookie);
    const payload = cookies.user_session ? verifyToken(cookies.user_session, secret) : null;
    socket.data.userId = payload && payload.userId ? Number(payload.userId) : null;
    socket.data.serverId = Number(cookies.sv) || null;
    next(); // toujours autorisé ; rooms jointes seulement si autorisé
  });

  io.on("connection", (socket) => {
    if (socket.data.serverId) socket.join("server:" + socket.data.serverId);
    if (socket.data.userId) socket.join("user:" + socket.data.userId);
  });

  // Abonné applicatif : relaie les canaux Redis vers les rooms Socket.IO
  const appSub = pub.duplicate();
  appSub.on("error", (e) => console.error("[realtime] redis appSub:", e.message));
  appSub.psubscribe("ascentix:server:*", "announce:server:*", "bets:user:*", "notif:user:*");
  appSub.on("pmessage", (_pattern, channel, message) => {
    const id = channel.slice(channel.lastIndexOf(":") + 1);
    try {
      if (channel.startsWith("ascentix:server:")) {
        io.to("server:" + id).emit("ascentix:refresh");
      } else if (channel.startsWith("announce:server:")) {
        io.to("server:" + id).emit("notif:announce", JSON.parse(message));
      } else if (channel.startsWith("bets:user:")) {
        io.to("user:" + id).emit("bet:resolved", JSON.parse(message));
      } else if (channel.startsWith("notif:user:")) {
        io.to("user:" + id).emit("notif:personal", JSON.parse(message));
      }
    } catch (e) {
      console.error("[realtime] relais:", e.message);
    }
  });

  httpServer.listen(PORT, "0.0.0.0", () => {
    console.log(`🔌 Serveur temps réel (Socket.IO) sur :${PORT}`);
  });
}

module.exports = { startRealtimeServer };
