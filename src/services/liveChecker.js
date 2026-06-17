const { sql } = require("../database");
const { getActiveGameByPuuid, checkActiveGame, getChampionName } = require("./riot");
const { processFinishedMatch } = require("./matchChecker");

// Plateforme Riot pour reconstruire le matchId à partir du gameId (ex: "EUW1_123…").
const RIOT_PLATFORM = process.env.RIOT_PLATFORM || "EUW1";

const LIVE_TTL_MS = 3 * 60 * 1000;        // 3 min de sécurité si l'API plante en continu
const SPECTATOR_MIN_INTERVAL_MS = 60 * 1000; // garde pour rétrocompat éventuelle

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
  const participants = (game.participants || []).filter(Boolean);

  for (const p of participants) {
    const puuid = p.puuid || `streamer_${id}_${p.teamId ?? 0}_${p.championId ?? 0}`;
    const championName = p.championId ? await getChampionName(p.championId) : null;
    const sumName =
      (p.summonerName && String(p.summonerName).trim()) ||
      (p.riotId && String(p.riotId).trim()) ||
      "";
    const snap = extractLiveSnapshot(p);
    const tier = null;

    await sql`
      INSERT INTO live_participants (
        game_id, puuid, summoner_name, champion_id, champion_name, team_id, is_server,
        spell1_id, spell2_id, kills, deaths, assists, gold, minions_killed, champion_level, riot_lane, tier
      )
      VALUES (
        ${id}, ${puuid}, ${sumName}, ${p.championId ?? null}, ${championName || null},
        ${p.teamId}, ${serverPuuids.has(puuid)},
        ${snap.spell1Id}, ${snap.spell2Id}, ${snap.kills}, ${snap.deaths}, ${snap.assists},
        ${snap.gold}, ${snap.minionsKilled}, ${snap.championLevel}, ${snap.riotLane}, ${tier}
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
        riot_lane       = EXCLUDED.riot_lane,
        tier            = COALESCE(live_participants.tier, EXCLUDED.tier)
    `;
  }
}

async function pruneStaleGames(observedAtMs) {
  const cutoff = observedAtMs - LIVE_TTL_MS;
  await sql`DELETE FROM live_participants WHERE game_id IN (SELECT id FROM live_games WHERE observed_at_ms < ${cutoff})`;
  await sql`DELETE FROM live_games WHERE observed_at_ms < ${cutoff}`;
}

// Cache + verrou pour scanIdlePlayers.
// Un scan = 1 appel Spectator par compte idle (≈ tous les comptes suivis), ce qui
// pèse lourd face à la limite Riot de 100 req / 2 min. La page live est ouverte par
// plusieurs visiteurs et poll en boucle → sans garde-fou on déclenche un scan complet
// par requête. Ces deux protections plafonnent le coût côté serveur, quel que soit le
// nombre de clients :
//   - verrou : un seul scan à la fois, les appels concurrents partagent le résultat
//   - cache  : pas de nouveau scan si le précédent a fini il y a moins de SCAN_CACHE_MS
const SCAN_CACHE_MS = Number(process.env.LIVE_SCAN_CACHE_MS) || 30 * 1000;
let _scanInFlight = null;
let _lastScanAt = 0;
let _lastScanFound = 0;

/**
 * Vérifie les joueurs PAS encore en partie et détecte de nouvelles parties.
 * Appelé à la demande (ouverture de page / bouton Actualiser / poll).
 * Dédoublonne les appels concurrents et applique un cache court (SCAN_CACHE_MS).
 */
async function scanIdlePlayers() {
  // Cache : un scan récent suffit, on renvoie son résultat sans retaper Riot.
  if (Date.now() - _lastScanAt < SCAN_CACHE_MS) return _lastScanFound;
  // Verrou : si un scan tourne déjà, on attend le même au lieu d'en lancer un autre.
  if (_scanInFlight) return _scanInFlight;

  _scanInFlight = (async () => {
    try {
      const found = await _doScanIdlePlayers();
      _lastScanFound = found;
      return found;
    } finally {
      _lastScanAt = Date.now();
      _scanInFlight = null;
    }
  })();
  return _scanInFlight;
}

async function _doScanIdlePlayers() {
  const accounts = await sql`SELECT puuid FROM accounts`;
  if (accounts.length === 0) return 0;

  // Puuids déjà dans une partie en cours
  const activeRows = await sql`
    SELECT DISTINCT p.puuid FROM live_participants p
    JOIN live_games g ON g.id = p.game_id
  `;
  const activePuuids = new Set(activeRows.map((r) => r.puuid));

  const idlePlayers = accounts.filter((a) => !activePuuids.has(a.puuid));
  if (idlePlayers.length === 0) return 0;

  const serverPuuids = new Set(accounts.map((a) => a.puuid));
  const coveredPuuids = new Set();
  const now = Date.now();
  let found = 0;

  for (const acc of idlePlayers) {
    if (coveredPuuids.has(acc.puuid)) continue;

    const game = await getActiveGameByPuuid(acc.puuid);
    if (!game) {
      await new Promise((r) => setTimeout(r, 200));
      continue;
    }

    try {
      await upsertLiveGame(game, now);
      await upsertParticipants(game, serverPuuids);
      found++;
    } catch (e) {
      console.error(`[scanIdlePlayers] upsert (${acc.puuid}): ${e.message}`);
    }

    for (const p of game.participants || []) {
      if (serverPuuids.has(p.puuid)) coveredPuuids.add(p.puuid);
    }

    await new Promise((r) => setTimeout(r, 400));
  }

  return found;
}

/**
 * Vérifie uniquement les joueurs DÉJÀ en partie.
 * Supprime immédiatement une partie quand l'API Spectator répond 404.
 * Tourne en boucle toutes les 30 s.
 */
async function maintainActiveGames(client) {
  const activeRows = await sql`
    SELECT DISTINCT p.puuid, p.game_id
    FROM live_participants p
    JOIN live_games g ON g.id = p.game_id
    WHERE p.is_server = true
  `;

  if (activeRows.length === 0) {
    // Nettoyage de sécurité pour les parties orphelines éventuelles
    await pruneStaleGames(Date.now());
    return;
  }

  const serverPuuids = new Set((await sql`SELECT puuid FROM accounts`).map((a) => a.puuid));
  const checkedGameIds = new Set();
  const now = Date.now();

  for (const { puuid, game_id } of activeRows) {
    if (checkedGameIds.has(game_id)) continue;

    const { game, ended } = await checkActiveGame(puuid);

    if (game) {
      await upsertLiveGame(game, now);
    } else if (ended) {
      // 404 confirmé → la partie est réellement terminée.
      // On récupère les joueurs suivis de cette partie AVANT de purger, puis on déclenche
      // le fetch du résultat (en tâche de fond : il met ~30-90s à être dispo chez Riot).
      const srvRows = await sql`
        SELECT DISTINCT puuid FROM live_participants WHERE game_id = ${game_id} AND is_server = true
      `;
      const puuids = srvRows.map((r) => r.puuid);

      await sql`DELETE FROM live_participants WHERE game_id = ${game_id}`;
      await sql`DELETE FROM live_games WHERE id = ${game_id}`;
      console.log(`[live] Partie ${game_id} terminée — ${puuids.length} joueur(s) serveur → fetch du résultat.`);

      if (client && puuids.length > 0) {
        const matchId = `${RIOT_PLATFORM}_${game_id}`;
        // Fire-and-forget : ne bloque pas la boucle (retries internes ~jusqu'à 2,5 min).
        processFinishedMatch(client, matchId, puuids).catch((e) =>
          console.error(`[live→match] ${matchId}: ${e.message}`),
        );
      }
    }
    // erreur réseau/API → on ne touche pas, le TTL de 3 min sert de filet

    checkedGameIds.add(game_id);
    await new Promise((r) => setTimeout(r, 400));
  }

  await pruneStaleGames(now);
}

module.exports = { scanIdlePlayers, maintainActiveGames, LIVE_TTL_MS };
