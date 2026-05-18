const { sql } = require("../database");
const { getActiveGameByPuuid, getChampionName } = require("./riot");

const LIVE_TTL_MS = 5 * 60 * 1000;
const SPECTATOR_MIN_INTERVAL_MS = 60 * 1000;

const lastCheckByPuuid = new Map();

async function upsertLiveGame(game, observedAtMs) {
  await sql`
    INSERT INTO live_games (id, queue_id, game_mode, map_id, started_at_ms, observed_at_ms)
    VALUES (${String(game.gameId)}, ${game.gameQueueConfigId || null}, ${game.gameMode || null}, ${game.mapId || null}, ${game.gameStartTime || 0}, ${observedAtMs})
    ON CONFLICT (id) DO UPDATE SET
      queue_id       = EXCLUDED.queue_id,
      game_mode      = EXCLUDED.game_mode,
      map_id         = EXCLUDED.map_id,
      started_at_ms  = EXCLUDED.started_at_ms,
      observed_at_ms = EXCLUDED.observed_at_ms
  `;
}

function pickInt(v) {
  if (typeof v !== "number" || Number.isNaN(v)) return null;
  return Math.round(v);
}

function extractLiveSnapshot(p) {
  let perksJson = null;
  if (p.perks && typeof p.perks === "object") {
    const ids = Array.isArray(p.perks.perkIds) ? p.perks.perkIds : [];
    perksJson = JSON.stringify({
      perkStyle:    typeof p.perks.perkStyle    === "number" ? p.perks.perkStyle    : null,
      perkSubStyle: typeof p.perks.perkSubStyle === "number" ? p.perks.perkSubStyle : null,
      perkIds: ids.slice(0, 9).map(Number),
    });
  }
  return {
    spell1Id: pickInt(p.spell1Id ?? p.spell1id),
    spell2Id: pickInt(p.spell2Id ?? p.spell2id),
    kills: pickInt(p.kills ?? p.championStats?.kills),
    deaths: pickInt(p.deaths ?? p.championStats?.deaths),
    assists: pickInt(p.assists ?? p.championStats?.assists),
    gold: pickInt(p.gold ?? p.championStats?.gold),
    minionsKilled: pickInt(p.minionsKilled ?? p.championStats?.minionsKilled ?? p.totalMinionsKilled),
    championLevel: pickInt(p.championLevel ?? p.championStats?.championLevel),
    riotLane:
      (typeof p.teamPosition === "string" && p.teamPosition) ||
      (typeof p.lane === "string" && p.lane) ||
      (typeof p.assignedPosition === "string" && p.assignedPosition) ||
      null,
    perksJson,
  };
}

async function upsertParticipants(game, serverPuuids) {
  const id = String(game.gameId);

  for (const p of game.participants || []) {
    if (!p) continue;
    const puuid = p.puuid || `streamer_${id}_${p.teamId ?? 0}_${p.championId ?? 0}`;
    const championName = p.championId ? await getChampionName(p.championId) : null;
    const sumName =
      (p.summonerName && String(p.summonerName).trim()) ||
      (p.riotId && String(p.riotId).trim()) ||
      "";
    const snap = extractLiveSnapshot(p);

    await sql`
      INSERT INTO live_participants (
        game_id, puuid, summoner_name, champion_id, champion_name, team_id, is_server,
        spell1_id, spell2_id, kills, deaths, assists, gold, minions_killed, champion_level, riot_lane
      )
      VALUES (
        ${id}, ${puuid}, ${sumName}, ${p.championId ?? null}, ${championName || null},
        ${p.teamId}, ${serverPuuids.has(puuid)},
        ${snap.spell1Id}, ${snap.spell2Id}, ${snap.kills}, ${snap.deaths}, ${snap.assists},
        ${snap.gold}, ${snap.minionsKilled}, ${snap.championLevel}, ${snap.riotLane}
      )
      ON CONFLICT (game_id, puuid) DO UPDATE SET
        summoner_name   = EXCLUDED.summoner_name,
        champion_id     = EXCLUDED.champion_id,
        champion_name   = EXCLUDED.champion_name,
        team_id         = EXCLUDED.team_id,
        is_server       = EXCLUDED.is_server,
        spell1_id       = EXCLUDED.spell1_id,
        spell2_id       = EXCLUDED.spell2_id,
        kills           = EXCLUDED.kills,
        deaths          = EXCLUDED.deaths,
        assists         = EXCLUDED.assists,
        gold            = EXCLUDED.gold,
        minions_killed  = EXCLUDED.minions_killed,
        champion_level  = EXCLUDED.champion_level,
        riot_lane       = EXCLUDED.riot_lane
    `;
  }
}

async function pruneStaleGames(observedAtMs) {
  const cutoff = observedAtMs - LIVE_TTL_MS;
  await sql`DELETE FROM live_participants WHERE game_id IN (SELECT id FROM live_games WHERE observed_at_ms < ${cutoff})`;
  await sql`DELETE FROM live_games WHERE observed_at_ms < ${cutoff}`;
}

async function checkLiveGames() {
  const accounts = await sql`SELECT puuid FROM accounts`;
  if (accounts.length === 0) return;

  const serverPuuids = new Set(accounts.map((a) => a.puuid));
  const now = Date.now();
  const coveredPuuids = new Set();

  for (const acc of accounts) {
    if (coveredPuuids.has(acc.puuid)) continue;
    const last = lastCheckByPuuid.get(acc.puuid) || 0;
    if (now - last < SPECTATOR_MIN_INTERVAL_MS) continue;
    lastCheckByPuuid.set(acc.puuid, now);

    const game = await getActiveGameByPuuid(acc.puuid);
    if (!game) continue;

    try {
      await upsertLiveGame(game, now);
      await upsertParticipants(game, serverPuuids);
    } catch (e) {
      console.error(`live_games upsert (${acc.puuid}): ${e.message}`);
    }

    for (const p of game.participants || []) {
      if (serverPuuids.has(p.puuid)) coveredPuuids.add(p.puuid);
    }

    await new Promise((r) => setTimeout(r, 600));
  }

  await pruneStaleGames(now);
}

module.exports = { checkLiveGames, LIVE_TTL_MS };
