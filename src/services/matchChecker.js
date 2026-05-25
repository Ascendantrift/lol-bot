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

  await sql`UPDATE accounts SET total_time_spent_dead = total_time_spent_dead + ${timeSpentDead} WHERE puuid = ${puuid}`;

  if (isWin) {
    if (player.user_id) {
      await sql`UPDATE accounts SET loss_streak = 0 WHERE user_id = ${player.user_id}`;
    } else {
      await sql`UPDATE accounts SET loss_streak = 0 WHERE puuid = ${puuid}`;
    }
    await sql`UPDATE accounts SET win_streak = win_streak + 1, total_wins = total_wins + 1 WHERE puuid = ${puuid}`;
    await sql`UPDATE accounts SET max_win_streak = GREATEST(max_win_streak, win_streak) WHERE puuid = ${puuid}`;
    await sql`
      INSERT INTO monthly_stats (puuid, month, wins, losses, games, total_time_spent_dead)
      VALUES (${puuid}, ${monthStr}, 1, 0, 1, ${timeSpentDead})
      ON CONFLICT (puuid, month) DO UPDATE SET
        wins                  = monthly_stats.wins + 1,
        games                 = monthly_stats.games + 1,
        total_time_spent_dead = monthly_stats.total_time_spent_dead + ${timeSpentDead}
    `;
  } else {
    await sql`UPDATE accounts SET win_streak = 0 WHERE puuid = ${puuid}`;
    await sql`UPDATE accounts SET loss_streak = loss_streak + 1, total_losses = total_losses + 1 WHERE puuid = ${puuid}`;
    await sql`UPDATE accounts SET max_loss_streak = GREATEST(max_loss_streak, loss_streak) WHERE puuid = ${puuid}`;
    await sql`
      INSERT INTO monthly_stats (puuid, month, wins, losses, games, total_time_spent_dead)
      VALUES (${puuid}, ${monthStr}, 0, 1, 1, ${timeSpentDead})
      ON CONFLICT (puuid, month) DO UPDATE SET
        losses                = monthly_stats.losses + 1,
        games                 = monthly_stats.games + 1,
        total_time_spent_dead = monthly_stats.total_time_spent_dead + ${timeSpentDead}
    `;
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

async function insertMatchHistory(matchId, puuid, participant, info, win, badgeKeys, lpNormalized = null) {
  try {
    const playedAt    = new Date(info.gameEndTimestamp).toISOString();
    const badgesJson  = Array.isArray(badgeKeys) && badgeKeys.length > 0 ? JSON.stringify(badgeKeys) : null;
    const teamPos     = typeof participant.teamPosition === "string" && participant.teamPosition ? participant.teamPosition : null;
    await sql`
      INSERT INTO match_history (
        id, puuid, champion_name, kills, deaths, assists,
        duration_seconds, queue_id, played_at, win, badges_json, time_spent_dead_seconds, team_position, lp_normalized
      ) VALUES (
        ${matchId}, ${puuid}, ${participant.championName},
        ${participant.kills}, ${participant.deaths}, ${participant.assists},
        ${info.gameDuration}, ${info.queueId}, ${playedAt}, ${win},
        ${badgesJson},
        ${typeof participant.totalTimeSpentDead === "number" ? participant.totalTimeSpentDead : 0},
        ${teamPos}, ${lpNormalized}
      )
      ON CONFLICT (id, puuid) DO UPDATE SET
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

async function _doCheckMatches(client) {
  const accounts = await sql`
    SELECT a.*, u.discord_id FROM accounts a LEFT JOIN users u ON u.id = a.user_id
  `;
  const now = Date.now();

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

      const axiosConfig = { headers: { "X-Riot-Token": RIOT_API_KEY } };
      // count=10 pour ne pas rater les parties si le joueur en enchaîne plusieurs
      // entre deux checks (intervalle 2 min)
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
        await sql`UPDATE accounts SET last_match_id = ${matchIds[0]}, last_match_at = ${now} WHERE puuid = ${player.puuid}`;
        continue;
      }

      newMatchIds.reverse();

      for (const matchId of newMatchIds) {
        const detRes = await axios.get(
          `https://europe.api.riotgames.com/lol/match/v5/matches/${matchId}`,
          axiosConfig,
        );
        const info = detRes.data.info;
        const p    = info.participants.find((part) => part.puuid === player.puuid);

        // Toujours avancer last_match_id (même remake) pour ne pas reboucler
        await sql`UPDATE accounts SET last_match_id = ${matchId}, last_match_at = ${info.gameEndTimestamp} WHERE puuid = ${player.puuid}`;
        if (!p || info.gameDuration <= 300) continue;
        if (info.queueId === 1700 || info.queueId === 1710 || (info.gameMode || "").toUpperCase() === "CHERRY") continue;

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
    } catch (e) {
      console.error(`❌ Erreur ${player.game_name}: ${e.message}`);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

module.exports = { checkMatches };
