const axios        = require("axios");
const { sql }      = require("../database");
const { RIOT_API_KEY } = require("./riot");
const { handleLoss } = require("./lossHandler");
const { handleWin }  = require("./winHandler");

let _checkRunning = false;

// ─── Stats mensuelles + streaks ────────────────────────────────────────────────

async function updateLossStats(player, isWin, timeSpentDead = 0) {
  const puuid    = player.puuid;
  const monthStr = new Date().toISOString().slice(0, 7);
  const serverIds = await listServerIdsForPuuid(puuid);

  await sql`UPDATE accounts SET total_time_spent_dead = total_time_spent_dead + ${timeSpentDead} WHERE puuid = ${puuid}`;

  if (isWin) {
    if (player.user_id) {
      await sql`UPDATE accounts SET loss_streak = 0 WHERE user_id = ${player.user_id}`;
    } else {
      await sql`UPDATE accounts SET loss_streak = 0 WHERE puuid = ${puuid}`;
    }
    await sql`UPDATE accounts SET win_streak = win_streak + 1, total_wins = total_wins + 1 WHERE puuid = ${puuid}`;
    await sql`UPDATE accounts SET max_win_streak = GREATEST(max_win_streak, win_streak) WHERE puuid = ${puuid}`;
    for (const serverId of serverIds) {
      await sql`
        INSERT INTO monthly_stats (puuid, month, server_id, wins, losses, games, total_time_spent_dead)
        VALUES (${puuid}, ${monthStr}, ${serverId}, 1, 0, 1, ${timeSpentDead})
        ON CONFLICT (puuid, month, server_id) DO UPDATE SET
          wins                  = monthly_stats.wins + 1,
          games                 = monthly_stats.games + 1,
          total_time_spent_dead = monthly_stats.total_time_spent_dead + ${timeSpentDead}
      `;
    }
  } else {
    await sql`UPDATE accounts SET win_streak = 0 WHERE puuid = ${puuid}`;
    await sql`UPDATE accounts SET loss_streak = loss_streak + 1, total_losses = total_losses + 1 WHERE puuid = ${puuid}`;
    await sql`UPDATE accounts SET max_loss_streak = GREATEST(max_loss_streak, loss_streak) WHERE puuid = ${puuid}`;
    for (const serverId of serverIds) {
      await sql`
        INSERT INTO monthly_stats (puuid, month, server_id, wins, losses, games, total_time_spent_dead)
        VALUES (${puuid}, ${monthStr}, ${serverId}, 0, 1, 1, ${timeSpentDead})
        ON CONFLICT (puuid, month, server_id) DO UPDATE SET
          losses                = monthly_stats.losses + 1,
          games                 = monthly_stats.games + 1,
          total_time_spent_dead = monthly_stats.total_time_spent_dead + ${timeSpentDead}
      `;
    }
  }

  if (player.user_id) {
    const [row] = await sql`SELECT SUM(loss_streak)::int AS sum_streak FROM accounts WHERE user_id = ${player.user_id}`;
    return row?.sum_streak || 0;
  }
  const [row] = await sql`SELECT loss_streak FROM accounts WHERE puuid = ${puuid}`;
  return row?.loss_streak || 0;
}

// ─── Historique de match ────────────────────────────────────────────────────────

const TIER_BASE_LP = { IRON: 0, BRONZE: 4, SILVER: 8, GOLD: 12, PLATINUM: 16, EMERALD: 20, DIAMOND: 24, MASTER: 28, GRANDMASTER: 29, CHALLENGER: 30 };
const DIV_LP = { IV: 0, III: 1, II: 2, I: 3 };

function computeNormalizedLp(rankData) {
  if (!rankData || !rankData.tier) return null;
  const tierKey = rankData.tier.toUpperCase();
  const base = TIER_BASE_LP[tierKey];
  if (base === undefined) return null;
  const div = DIV_LP[rankData.rank?.toUpperCase()] ?? 0;
  return (base + div) * 100 + (rankData.lp ?? 0);
}

async function listServerIdsForPuuid(puuid) {
  try {
    const rows = await sql`
      SELECT DISTINCT server_id
      FROM server_members
      WHERE puuid = ${puuid}
      ORDER BY server_id ASC
    `;
    return rows.map((r) => Number(r.server_id)).filter((n) => Number.isFinite(n));
  } catch {
    return [];
  }
}

async function insertMatchHistory(matchId, puuid, participant, info, win, badgeKeys, lpNormalized = null) {
  try {
    const playedAt    = new Date(info.gameEndTimestamp).toISOString();
    const badgesJson  = Array.isArray(badgeKeys) && badgeKeys.length > 0 ? JSON.stringify(badgeKeys) : null;
    // team_position est un enum en base (TOP/JUNGLE/MIDDLE/BOTTOM/UTILITY) :
    // toute autre valeur (ex. file sans rôle, valeur inattendue de Riot) → null.
    const VALID_POSITIONS = ["TOP", "JUNGLE", "MIDDLE", "BOTTOM", "UTILITY"];
    const teamPos     = VALID_POSITIONS.includes(participant.teamPosition) ? participant.teamPosition : null;
    const serverIds = await listServerIdsForPuuid(puuid);
    for (const serverId of serverIds) {
      await sql`
        INSERT INTO match_history (
          id, puuid, server_id, champion_name, kills, deaths, assists,
          duration_seconds, queue_id, played_at, win, badges_json, time_spent_dead_seconds, team_position, lp_normalized
        ) VALUES (
          ${matchId}, ${puuid}, ${serverId}, ${participant.championName},
          ${participant.kills}, ${participant.deaths}, ${participant.assists},
          ${info.gameDuration}, ${info.queueId}, ${playedAt}, ${win},
          ${badgesJson},
          ${typeof participant.totalTimeSpentDead === "number" ? participant.totalTimeSpentDead : 0},
          ${teamPos}, ${lpNormalized}
        )
        ON CONFLICT (id, puuid, server_id) DO UPDATE SET
          champion_name           = EXCLUDED.champion_name,
          kills                   = EXCLUDED.kills,
          deaths                  = EXCLUDED.deaths,
          assists                 = EXCLUDED.assists,
          duration_seconds        = EXCLUDED.duration_seconds,
          queue_id                = EXCLUDED.queue_id,
          played_at               = EXCLUDED.played_at,
          win                     = EXCLUDED.win,
          badges_json             = EXCLUDED.badges_json,
          time_spent_dead_seconds = EXCLUDED.time_spent_dead_seconds,
          team_position           = EXCLUDED.team_position,
          lp_normalized           = COALESCE(EXCLUDED.lp_normalized, match_history.lp_normalized)
      `;
    }
  } catch (e) {
    console.error("match_history:", e.message);
  }
}

// ─── Boucle principale ─────────────────────────────────────────────────────────

async function checkMatches(client) {
  if (_checkRunning) {
    console.log("⏭️  checkMatches déjà en cours — passage ignoré.");
    return;
  }
  _checkRunning = true;
  try {
    await _doCheckMatches(client);
  } finally {
    _checkRunning = false;
  }
}

// gameId numérique (suffixe du matchId "EUW1_1234567890") → tri chronologique fiable :
// le gameId est monotone croissant, donc trier dessus = ordre des parties dans le temps.
function gameIdNum(matchId) {
  const n = Number(String(matchId).split("_")[1]);
  return Number.isFinite(n) ? n : 0;
}

// Traite un participant serveur d'un match déjà fetché (streaks + notif + historique).
async function processParticipant(client, matchId, info, player, p) {
  // Pseudo Riot mis à jour si changé (données déjà présentes dans le match)
  if (p.riotIdGameName && p.riotIdGameName !== player.game_name) {
    await sql`UPDATE accounts SET game_name = ${p.riotIdGameName}, tag_line = ${p.riotIdTagline ?? player.tag_line} WHERE puuid = ${player.puuid}`;
    player.game_name = p.riotIdGameName;
  }

  let badgeKeysEarned = [];
  let lpNormalized = null;
  try {
    const previousLossStreak = player.loss_streak || 0;
    const activeStreak       = await updateLossStats(player, p.win, p.totalTimeSpentDead);

    if (!p.win) {
      const result = await handleLoss(client, player, p, info, matchId, activeStreak);
      badgeKeysEarned = result.badgeKeys ?? result;
      lpNormalized = result.lpNormalized ?? null;
    } else {
      const result = await handleWin(client, player, p, info, matchId, previousLossStreak);
      badgeKeysEarned = result.badgeKeys ?? result;
      lpNormalized = result.lpNormalized ?? null;
    }
  } catch (matchErr) {
    console.error(`❌ Traitement match ${matchId} pour ${player.game_name}: ${matchErr.message}`);
  }

  // insertMatchHistory est toujours appelé même si le traitement a planté
  await insertMatchHistory(matchId, player.puuid, p, info, p.win, badgeKeysEarned, lpNormalized);
}

// ── Anti-doublon partagé entre le filet `checkMatches` et le chemin "fin de game live" ──
const _processingMatches = new Set(); // verrou par matchId (intra-process, anti-concurrence)

// Vrai si ce (match, joueur) a déjà été traité (match_history écrit en fin de traitement).
async function alreadyProcessed(matchId, puuid) {
  const [row] = await sql`
    SELECT 1 FROM match_history WHERE id = ${matchId} AND puuid = ${puuid} LIMIT 1
  `;
  return !!row;
}

// Traite un match TERMINÉ pour des comptes suivis, déclenché par la fin de game détectée
// en live. Fetch le détail UNE seule fois (avec retries : le résultat Riot met ~30-90s à
// être dispo après la fin), traite tous les joueurs serveur ensemble, et saute ceux déjà
// traités par le filet `checkMatches`. Le verrou + le check match_history garantissent
// qu'aucun match n'est traité ni fetché deux fois.
async function processFinishedMatch(client, matchId, puuids, { retries = 5, delayMs = 30000 } = {}) {
  if (_processingMatches.has(matchId)) return;

  // Pré-filtre : si tous les comptes sont déjà traités, on ne fetch RIEN (zéro appel).
  const pending = [];
  for (const puuid of puuids) {
    if (!(await alreadyProcessed(matchId, puuid))) pending.push(puuid);
  }
  if (pending.length === 0) return;

  _processingMatches.add(matchId);
  try {
    const axiosConfig = { headers: { "X-Riot-Token": RIOT_API_KEY } };
    let info = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const detRes = await axios.get(`https://europe.api.riotgames.com/lol/match/v5/matches/${matchId}`, axiosConfig);
        info = detRes.data.info;
        break;
      } catch (e) {
        const status = e.response?.status;
        if (status === 404 && attempt < retries) {
          await new Promise((r) => setTimeout(r, delayMs)); // résultat pas encore dispo
          continue;
        }
        console.error(`[live→match] ${matchId} indisponible (${status || e.message})`);
        return;
      }
    }
    if (!info) return;

    const isArena = info.queueId === 1700 || info.queueId === 1710 || (info.gameMode || "").toUpperCase() === "CHERRY";
    // Parties contre des bots (Co-op vs AI / Tutoriel) : les IA ont puuid "BOT".
    // On les ignore (pas de badges, pas de notif, pas d'historique).
    const isBotGame = info.participants.some((part) => part.puuid === "BOT");

    for (const puuid of pending) {
      if (await alreadyProcessed(matchId, puuid)) continue; // course éventuelle avec le filet
      const p = info.participants.find((part) => part.puuid === puuid);
      if (!p || info.gameDuration <= 300 || isArena || isBotGame) continue;

      const [player] = await sql`
        SELECT a.*, u.discord_id FROM accounts a LEFT JOIN users u ON u.id = a.user_id WHERE a.puuid = ${puuid}
      `;
      if (!player) continue;

      await processParticipant(client, matchId, info, player, p);
      // Avance le pointeur pour que `checkMatches` ne re-découvre/re-traite pas ce match.
      await sql`UPDATE accounts SET last_match_id = ${matchId}, last_match_at = ${info.gameEndTimestamp} WHERE puuid = ${puuid}`;
    }
  } finally {
    _processingMatches.delete(matchId);
  }
}

async function _doCheckMatches(client) {
  const accounts = await sql`
    SELECT a.*, u.discord_id FROM accounts a LEFT JOIN users u ON u.id = a.user_id
  `;
  const now = Date.now();
  const axiosConfig = { headers: { "X-Riot-Token": RIOT_API_KEY } };

  // ── Passe 1 : découverte des nouveaux matchs, par compte ─────────────────────
  // On ne fait QUE lister les ids ici (1 appel /ids par compte dû), puis on regroupe
  // par matchId. Le détail du match sera fetché une seule fois en passe 2, même si
  // plusieurs joueurs du serveur sont dans la même partie.
  const byMatch     = new Map(); // matchId → [puuid, ...] (joueurs serveur ayant ce match neuf)
  const playerByPuuid = new Map(); // puuid → objet compte

  for (const player of accounts) {
    try {
      const lastMatchAt   = Number(player.last_match_at) || 0;
      const lastCheckedAt = Number(player.last_checked_at) || 0;
      const sinceMatch    = now - lastMatchAt;
      const sinceCheck    = now - lastCheckedAt;

      let interval = 2 * 60 * 1000;
      if (lastMatchAt > 0) {
        if (sinceMatch > 24 * 60 * 60 * 1000)     interval = 30 * 60 * 1000;
        else if (sinceMatch > 2 * 60 * 60 * 1000) interval = 15 * 60 * 1000;
      }
      if (sinceCheck < interval) continue;

      await sql`UPDATE accounts SET last_checked_at = ${now} WHERE puuid = ${player.puuid}`;
      console.log(`⏳ Vérification : ${player.game_name}`);

      // count=10 pour ne pas rater les parties si le joueur en enchaîne plusieurs
      const lolRes = await axios.get(
        `https://europe.api.riotgames.com/lol/match/v5/matches/by-puuid/${player.puuid}/ids?count=10`,
        axiosConfig,
      );
      const matchIds = lolRes.data || [];

      let newMatchIds = [];
      if (player.last_match_id) {
        const lastIndex = matchIds.indexOf(player.last_match_id);
        newMatchIds = lastIndex === -1 ? matchIds : matchIds.slice(0, lastIndex);
      } else if (matchIds.length > 0) {
        // Première synchro : on mémorise sans rejouer l'historique
        await sql`UPDATE accounts SET last_match_id = ${matchIds[0]}, last_match_at = ${now} WHERE puuid = ${player.puuid}`;
        continue;
      }
      if (newMatchIds.length === 0) continue;

      // Avance last_match_id vers le match le plus récent (newMatchIds[0]) pour ne pas reboucler.
      await sql`UPDATE accounts SET last_match_id = ${newMatchIds[0]} WHERE puuid = ${player.puuid}`;

      playerByPuuid.set(player.puuid, player);
      for (const matchId of newMatchIds) {
        if (!byMatch.has(matchId)) byMatch.set(matchId, []);
        byMatch.get(matchId).push(player.puuid);
      }
    } catch (e) {
      console.error(`❌ Découverte ${player.game_name}: ${e.message}`);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }

  if (byMatch.size === 0) return;

  // ── Passe 2 : traitement groupé par match ────────────────────────────────────
  // Ordre chronologique (gameId croissant) → les parties d'un même joueur sont traitées
  // dans l'ordre, donc les streaks restent corrects. 1 fetch de détail par match, et
  // tous les joueurs serveur de cette partie sont notifiés à la suite (notifs groupées).
  const matchIdsSorted = [...byMatch.keys()].sort((a, b) => gameIdNum(a) - gameIdNum(b));

  for (const matchId of matchIdsSorted) {
    // Si le chemin "fin de game live" traite déjà ce match, on le laisse faire (anti-doublon).
    if (_processingMatches.has(matchId)) continue;
    _processingMatches.add(matchId);
    try {
      let info;
      try {
        const detRes = await axios.get(`https://europe.api.riotgames.com/lol/match/v5/matches/${matchId}`, axiosConfig);
        info = detRes.data.info;
      } catch (e) {
        console.error(`❌ Fetch match ${matchId}: ${e.message}`);
        continue;
      }

      const isArena = info.queueId === 1700 || info.queueId === 1710 || (info.gameMode || "").toUpperCase() === "CHERRY";
      // Parties contre des bots (Co-op vs AI / Tutoriel) : les IA ont puuid "BOT".
      const isBotGame = info.participants.some((part) => part.puuid === "BOT");

      for (const puuid of byMatch.get(matchId)) {
        const player = playerByPuuid.get(puuid);
        const p = info.participants.find((part) => part.puuid === puuid);

        // last_match_at = fin réelle de la partie (utilisé par l'intervalle adaptatif)
        await sql`UPDATE accounts SET last_match_at = ${info.gameEndTimestamp} WHERE puuid = ${puuid}`;

        // Remake / participant introuvable / Arena / vs bots → pas de notif ni d'historique
        if (!p || info.gameDuration <= 300 || isArena || isBotGame) continue;
        // Déjà traité par le chemin live → on saute (anti-doublon)
        if (await alreadyProcessed(matchId, puuid)) continue;

        await processParticipant(client, matchId, info, player, p);
      }
    } finally {
      _processingMatches.delete(matchId);
    }

    await new Promise((r) => setTimeout(r, 1000));
  }
}

module.exports = { checkMatches, processFinishedMatch };
