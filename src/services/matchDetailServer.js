const http = require("http");
const axios = require("axios");
const { RIOT_API_KEY, getDdragonVersion } = require("./riot");

const PORT = parseInt(process.env.MATCH_API_PORT || "3717", 10);
const REGIONAL_HOST = "https://europe.api.riotgames.com";

/**
 * Récupère la timeline Match-V5 et en extrait le tracé (positions par minute)
 * de chaque participant : { [participantId]: [{ x, y, t }, …] }.
 * Un seul appel renvoie tout le parcours de la partie ; null si indispo.
 */
async function fetchMatchPaths(matchId) {
  try {
    const res = await axios.get(`${REGIONAL_HOST}/lol/match/v5/matches/${matchId}/timeline`, {
      headers: { "X-Riot-Token": RIOT_API_KEY },
    });
    const frames = res.data?.info?.frames ?? [];
    const byPid = {};
    for (const frame of frames) {
      for (const [pid, pf] of Object.entries(frame.participantFrames ?? {})) {
        if (!pf.position) continue;
        (byPid[pid] ||= []).push({ x: pf.position.x, y: pf.position.y, t: frame.timestamp });
      }
    }
    return byPid;
  } catch {
    return {};
  }
}

/** Récupère les détails complets d'une partie depuis Riot Match-V5. */
async function fetchMatchDetail(matchId) {
  const res = await axios.get(`${REGIONAL_HOST}/lol/match/v5/matches/${matchId}`, {
    headers: { "X-Riot-Token": RIOT_API_KEY },
  });

  const info = res.data.info;
  const v = await getDdragonVersion();
  const paths = await fetchMatchPaths(matchId);

  const participants = info.participants.map((p) => ({
    puuid: p.puuid,
    summonerName: p.riotIdGameName ?? p.summonerName ?? "Invocateur",
    championName: p.championName,
    championIconUrl: `https://ddragon.leagueoflegends.com/cdn/${v}/img/champion/${p.championName}.png`,
    teamId: p.teamId,
    teamPosition: p.teamPosition,
    kills: p.kills,
    deaths: p.deaths,
    assists: p.assists,
    totalDamageDealtToChampions: p.totalDamageDealtToChampions,
    goldEarned: p.goldEarned,
    totalMinionsKilled: p.totalMinionsKilled + (p.neutralMinionsKilled ?? 0),
    visionScore: p.visionScore,
    champLevel: p.champLevel,
    win: p.win,
    items: [p.item0, p.item1, p.item2, p.item3, p.item4, p.item5, p.item6],
    killParticipation: p.challenges?.killParticipation ?? null,
    teamDamagePercentage: p.challenges?.teamDamagePercentage ?? null,
    pentaKills: p.pentaKills ?? 0,
    // Tracé Strava : positions {x,y,t} par minute (vide si timeline indispo).
    path: paths[String(p.participantId)] ?? [],
  }));

  return {
    matchId,
    gameDuration: info.gameDuration,
    queueId: info.queueId,
    gameEndTimestamp: info.gameEndTimestamp,
    participants,
  };
}

function send(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": process.env.WEB_ORIGIN ?? "http://localhost:3000",
    "Content-Length": Buffer.byteLength(json),
  });
  res.end(json);
}

function startMatchDetailServer(client) {
  if (!RIOT_API_KEY) {
    console.warn("⚠️  RIOT_API_KEY manquante — serveur match-detail non démarré.");
    return;
  }

  const { scanIdlePlayers } = require("./liveChecker");
  const { fetchRankForQueue } = require("./riot");

  const server = http.createServer(async (req, res) => {
    // POST /ranks — retourne le rang actuel pour une liste de puuids
    if (req.method === "POST" && req.url === "/ranks") {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", async () => {
        try {
          const { entries } = JSON.parse(body);
          if (!Array.isArray(entries)) { send(res, 400, { error: "entries[] requis" }); return; }
          const results = {};
          await Promise.all(entries.map(async ({ puuid, queueId }) => {
            results[puuid] = await fetchRankForQueue(puuid, queueId ?? 0).catch(() => null);
          }));
          send(res, 200, results);
        } catch (e) {
          send(res, 500, { error: e.message });
        }
      });
      return;
    }

    // POST /live/scan — détecte les nouvelles parties en cours à la demande
    if (req.method === "POST" && req.url === "/live/scan") {
      try {
        const found = await scanIdlePlayers();
        send(res, 200, { ok: true, found });
      } catch (e) {
        send(res, 500, { error: e.message });
      }
      return;
    }

    // POST /announce — envoie un message texte à tous les salons configurés
    if (req.method === "POST" && req.url === "/announce") {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", async () => {
        try {
          const { message } = JSON.parse(body);
          if (!message) { send(res, 400, { error: "message requis" }); return; }
          const { sql } = require("../database");
          const channels = await sql`SELECT channel_id FROM servers`;
          let sent = 0;
          for (const { channel_id } of channels) {
            try {
              const ch = await client.channels.fetch(channel_id);
              if (ch?.isTextBased()) { await ch.send(message); sent++; }
            } catch { /* salon inaccessible, on continue */ }
          }
          send(res, 200, { ok: true, sent });
        } catch (e) {
          send(res, 500, { error: e.message });
        }
      });
      return;
    }

    if (req.method !== "GET") { send(res, 405, { error: "Method not allowed" }); return; }

    const matchRoute = req.url?.match(/^\/match\/([A-Z0-9]+_\d+)$/);
    if (matchRoute) {
      const matchId = matchRoute[1];
      try {
        const detail = await fetchMatchDetail(matchId);
        send(res, 200, detail);
      } catch (e) {
        const status = e.response?.status ?? 500;
        console.error(`match-detail ${matchId}: ${e.message}`);
        send(res, status, { error: e.message });
      }
      return;
    }

    const accountRoute = req.url?.match(/^\/account\/([^/]+)\/([^/]+)$/);
    if (accountRoute) {
      const gameName = decodeURIComponent(accountRoute[1]);
      const tagLine  = decodeURIComponent(accountRoute[2]);
      try {
        const r = await axios.get(
          `${REGIONAL_HOST}/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(gameName)}/${encodeURIComponent(tagLine)}`,
          { headers: { "X-Riot-Token": RIOT_API_KEY } },
        );
        send(res, 200, { puuid: r.data.puuid, gameName: r.data.gameName, tagLine: r.data.tagLine });
      } catch (e) {
        const status = e.response?.status ?? 500;
        send(res, status, { error: e.response?.data?.status?.message ?? e.message });
      }
      return;
    }

    send(res, 404, { error: "Not found" });
  });

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`🌐 Serveur match-detail sur http://0.0.0.0:${PORT}`);
  });

  return server;
}

module.exports = { startMatchDetailServer };
