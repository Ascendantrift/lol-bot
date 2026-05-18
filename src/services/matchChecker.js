const axios = require("axios");
const { sql } = require("../database");
const { RIOT_API_KEY, QUEUE_TYPES, fetchPlayerRank } = require("./riot");
const { evaluateTriggeredBadges, evaluateTriggeredWinBadges } = require("../../badges");
const { recordNotification } = require("./notifications");

const SKIP_DISCORD_SEND =
  process.env.SKIP_DISCORD_NOTIFICATIONS === "1" ||
  process.env.SKIP_DISCORD_NOTIFICATIONS === "true";

let _checkRunning = false;

const STREAK_MILESTONES = new Set([3, 5, 10, 15]);

function tierColumnForRankedQueue(queueId) {
  if (queueId === 420) return "last_tier_solo";
  if (queueId === 440) return "last_tier_flex";
  return null;
}

async function updateLossStats(player, isWin, timeSpentDead = 0) {
  const puuid = player.puuid;
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
        wins                = monthly_stats.wins + 1,
        games               = monthly_stats.games + 1,
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
        losses              = monthly_stats.losses + 1,
        games               = monthly_stats.games + 1,
        total_time_spent_dead = monthly_stats.total_time_spent_dead + ${timeSpentDead}
    `;
  }

  if (player.user_id) {
    const [row] = await sql`SELECT SUM(loss_streak)::int AS sum_streak FROM accounts WHERE user_id = ${player.user_id}`;
    return row?.sum_streak || 0;
  } else {
    const [row] = await sql`SELECT loss_streak FROM accounts WHERE puuid = ${puuid}`;
    return row?.loss_streak || 0;
  }
}

async function insertMatchHistory(matchId, puuid, participant, info, win, badgeKeys) {
  try {
    const playedAt = new Date(info.gameEndTimestamp).toISOString();
    const badgesJson =
      Array.isArray(badgeKeys) && badgeKeys.length > 0
        ? JSON.stringify(badgeKeys)
        : null;
    const teamPosition =
      typeof participant.teamPosition === "string" && participant.teamPosition
        ? participant.teamPosition
        : null;

    await sql`
      INSERT INTO match_history (
        id, puuid, champion_name, kills, deaths, assists,
        duration_seconds, queue_id, played_at, win, badges_json, time_spent_dead_seconds,
        team_position
      ) VALUES (
        ${matchId}, ${puuid}, ${participant.championName},
        ${participant.kills}, ${participant.deaths}, ${participant.assists},
        ${info.gameDuration}, ${info.queueId}, ${playedAt}, ${win},
        ${badgesJson},
        ${typeof participant.totalTimeSpentDead === "number" ? participant.totalTimeSpentDead : 0},
        ${teamPosition}
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
        team_position           = EXCLUDED.team_position
    `;
  } catch (e) {
    console.error("match_history:", e.message);
  }
}

async function registerBadgeUnlock(puuid, badge) {
  const nowIso = new Date().toISOString();
  const [exists] = await sql`SELECT unlock_count FROM badges WHERE entity_id = ${puuid} AND badge_key = ${badge.key}`;

  if (exists && !badge.repeatable) {
    return { isNew: false, unlockCount: exists.unlock_count };
  }

  if (!exists) {
    await sql`
      INSERT INTO badges (entity_id, badge_key, first_unlocked_at, last_unlocked_at, unlock_count)
      VALUES (${puuid}, ${badge.key}, ${nowIso}, ${nowIso}, 1)
    `;
    return { isNew: true, unlockCount: 1 };
  }

  await sql`
    UPDATE badges SET unlock_count = unlock_count + 1, last_unlocked_at = ${nowIso}
    WHERE entity_id = ${puuid} AND badge_key = ${badge.key}
  `;
  return { isNew: true, unlockCount: exists.unlock_count + 1 };
}

async function formatBadgeAnnouncement(client, player, unlockedBadges) {
  if (!unlockedBadges.length) return "";

  let discordLabel = `**${player.game_name}**`;
  if (player.discord_id) {
    try {
      const user =
        client.users.cache.get(player.discord_id) ||
        (await client.users.fetch(player.discord_id));
      discordLabel = `**${user.globalName || user.username}**`;
    } catch { /* fallback au pseudo LoL */ }
  }

  let announcement = "";
  const normalBadges = unlockedBadges.filter((b) => b.rank !== "Secret");
  const secretBadges = unlockedBadges.filter((b) => b.rank === "Secret");

  if (normalBadges.length > 0) {
    const badgesText = normalBadges
      .map((badge) => `le badge **${badge.name}** (${badge.rank}) : ${badge.description}`)
      .join(", et ");
    announcement += `🎖️ Grâce à sa performance, ${discordLabel} gagne ${badgesText}.\n`;
  }
  if (secretBadges.length > 0) {
    const secretText = secretBadges
      .map((badge) => `**${badge.name}** : *${badge.description}*`)
      .join(", et ");
    announcement += `🚨 ${discordLabel} vient de gagner le badge **SECRET** 🤫 : ${secretText} !!\n`;
  }

  return announcement.trim();
}

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
  // JOIN users pour récupérer discord_id (snowflake) en plus de user_id (int FK)
  const accounts = await sql`
    SELECT a.*, u.discord_id FROM accounts a LEFT JOIN users u ON u.id = a.user_id
  `;
  const now = Date.now();

  for (const player of accounts) {
    try {
      const lastMatchAt    = Number(player.last_match_at) || 0;
      const lastCheckedAt  = Number(player.last_checked_at) || 0;
      const timeSinceLastMatch = now - lastMatchAt;
      const timeSinceLastCheck = now - lastCheckedAt;

      let interval = 2 * 60 * 1000;
      if (lastMatchAt > 0) {
        if (timeSinceLastMatch > 24 * 60 * 60 * 1000)      interval = 30 * 60 * 1000;
        else if (timeSinceLastMatch > 2 * 60 * 60 * 1000)  interval = 15 * 60 * 1000;
      }
      if (timeSinceLastCheck < interval) continue;

      await sql`UPDATE accounts SET last_checked_at = ${now} WHERE puuid = ${player.puuid}`;

      console.log(`⏳ Vérification : ${player.game_name}`);
      const axiosConfig = { headers: { "X-Riot-Token": RIOT_API_KEY } };

      const lolRes = await axios.get(
        `https://europe.api.riotgames.com/lol/match/v5/matches/by-puuid/${player.puuid}/ids?count=2`,
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

        await sql`UPDATE accounts SET last_match_id = ${matchId}, last_match_at = ${info.gameEndTimestamp} WHERE puuid = ${player.puuid}`;

        if (!p || info.gameDuration <= 300) continue;

        const previousLossStreak = player.loss_streak || 0;
        const activeStreak = await updateLossStats(player, p.win, p.totalTimeSpentDead);

        let badgeKeysEarned = [];

        if (!p.win) {
          const queueName = QUEUE_TYPES[info.queueId] || "Partie";
          const min = Math.floor(info.gameDuration / 60);
          const sec = (info.gameDuration % 60).toString().padStart(2, "0");

          const rankData = await fetchPlayerRank(player.puuid, info.queueId);

          let message = `🚨 [${queueName}] - **${player.game_name}** a perdu avec **${p.championName}** (${p.kills}/${p.deaths}/${p.assists}) en **${min}:${sec}** min.`;
          if (rankData) message += ` - ${rankData.tier} ${rankData.rank} — ${rankData.lp} LP`;
          if (activeStreak > 1) message += `\n🔥 Série de défaites : ${activeStreak}`;

          const subs = await sql`
            SELECT s.channel_id FROM servers s
            JOIN server_members sm ON sm.server_id = s.id
            WHERE sm.puuid = ${player.puuid} AND s.mode IN ('negative', 'both')
          `;

          const tierCol  = tierColumnForRankedQueue(info.queueId);
          const oldTier  = tierCol && player[tierCol] ? player[tierCol] : null;
          const newTier  = rankData ? rankData.tier : null;

          if (subs.length > 0) {
            let ownedBadgeKeys = [];
            let totalDeadConsolidated = 0;

            if (player.user_id) {
              const rows = await sql`SELECT DISTINCT badge_key FROM badges WHERE entity_id IN (SELECT puuid FROM accounts WHERE user_id = ${player.user_id})`;
              ownedBadgeKeys = rows.map((b) => b.badge_key);
              const [rowDead] = await sql`SELECT SUM(total_time_spent_dead)::int AS sum_dead FROM accounts WHERE user_id = ${player.user_id}`;
              totalDeadConsolidated = rowDead?.sum_dead || 0;
            } else {
              const rows = await sql`SELECT badge_key FROM badges WHERE entity_id = ${player.puuid}`;
              ownedBadgeKeys = rows.map((b) => b.badge_key);
              totalDeadConsolidated = player.total_time_spent_dead || 0;
            }

            let triggeredBadges = evaluateTriggeredBadges(p, activeStreak, info, ownedBadgeKeys, totalDeadConsolidated, oldTier, newTier);
            if (triggeredBadges.length > 0) {
              const updatedBadges = [...ownedBadgeKeys, ...triggeredBadges.map((b) => b.key)];
              const secondPass    = evaluateTriggeredBadges(p, activeStreak, info, updatedBadges, totalDeadConsolidated, oldTier, newTier);
              secondPass.forEach((b) => { if (!triggeredBadges.find((tb) => tb.key === b.key)) triggeredBadges.push(b); });
            }

            const unlockedBadges = [];
            for (const badge of triggeredBadges) {
              const unlock = await registerBadgeUnlock(player.puuid, badge);
              if (unlock.isNew) unlockedBadges.push(badge);
            }
            if (unlockedBadges.length > 0) {
              message += `\n${await formatBadgeAnnouncement(client, player, unlockedBadges)}`;
            }
            badgeKeysEarned = unlockedBadges.map((b) => b.key);
          }

          if (newTier && tierCol) {
            await sql`UPDATE accounts SET ${sql(tierCol)} = ${newTier} WHERE puuid = ${player.puuid}`;
            player[tierCol] = newTier;
          }

          if (SKIP_DISCORD_SEND) {
            console.log(`[SKIP] Défaite non envoyée (${subs.length} salon(s)) :`, String(message).slice(0, 160).replace(/\n/g, " ") + "…");
          } else {
            for (const sub of subs) {
              const chan = await client.channels.fetch(sub.channel_id).catch(() => null);
              if (chan) await chan.send(message);
            }
          }

          const ts = info.gameEndTimestamp || Date.now();
          await recordNotification({
            ts, kind: "loss", accountPuuid: player.puuid, matchId,
            message: `🚨 [${queueName}] - ${player.game_name} a perdu avec ${p.championName} (${p.kills}/${p.deaths}/${p.assists}) en ${min}:${sec} min.${rankData ? ` - ${rankData.tier} ${rankData.rank} — ${rankData.lp} LP` : ""}`,
            details: { queueLabel: queueName, accountName: player.game_name, champion: p.championName, kills: p.kills, deaths: p.deaths, assists: p.assists, durationSeconds: info.gameDuration, tier: rankData ? `${rankData.tier} ${rankData.rank}` : null, lp: rankData?.lp ?? null, streak: activeStreak },
          });

          const unlockedBadges = badgeKeysEarned.length > 0
            ? await sql`SELECT badge_key, badge_key AS key FROM badges WHERE entity_id = ${player.puuid} AND badge_key = ANY(${badgeKeysEarned})`
            : [];

          for (const badge of unlockedBadges) {
            await recordNotification({
              ts: ts + 1, kind: "badge", accountPuuid: player.puuid, matchId,
              message: `✨ ${player.game_name} vient de débloquer le badge « ${badge.badge_key} ».`,
              details: { accountName: player.game_name, badgeKey: badge.badge_key },
            });
          }

          if (STREAK_MILESTONES.has(activeStreak)) {
            await recordNotification({
              ts: ts + 2, kind: "streak", accountPuuid: player.puuid, matchId,
              message: `🔥 ${player.game_name} enchaîne ${activeStreak} défaites d'affilée.`,
              details: { accountName: player.game_name, streak: activeStreak },
            });
          }
        } else {
          const rankData    = await fetchPlayerRank(player.puuid, info.queueId);
          const winTierCol  = tierColumnForRankedQueue(info.queueId);
          const oldTierWin  = winTierCol && player[winTierCol] ? player[winTierCol] : null;
          if (rankData && winTierCol) {
            await sql`UPDATE accounts SET ${sql(winTierCol)} = ${rankData.tier} WHERE puuid = ${player.puuid}`;
            player[winTierCol] = rankData.tier;
          }

          const [winStreakRow] = await sql`SELECT win_streak FROM accounts WHERE puuid = ${player.puuid}`;
          const currentWinStreak = winStreakRow?.win_streak || 0;

          const queueName = QUEUE_TYPES[info.queueId] || "Partie";
          const min = Math.floor(info.gameDuration / 60);
          const sec = (info.gameDuration % 60).toString().padStart(2, "0");

          let winMessage = `✅ [${queueName}] - **${player.game_name}** a gagné avec **${p.championName}** (${p.kills}/${p.deaths}/${p.assists}) en **${min}:${sec}** min.`;
          if (rankData) winMessage += ` - ${rankData.tier} ${rankData.rank} — ${rankData.lp} LP`;
          if (currentWinStreak > 1) winMessage += `\n🔥 Série de victoires : ${currentWinStreak}`;

          const winSubs = await sql`
            SELECT s.channel_id FROM servers s
            JOIN server_members sm ON sm.server_id = s.id
            WHERE sm.puuid = ${player.puuid} AND s.mode IN ('positive', 'both')
          `;

          const unlockedWinBadges = [];
          if (winSubs.length > 0) {
            let ownedBadgeKeysWin = [];
            if (player.user_id) {
              const rows = await sql`SELECT DISTINCT badge_key FROM badges WHERE entity_id IN (SELECT puuid FROM accounts WHERE user_id = ${player.user_id})`;
              ownedBadgeKeysWin = rows.map((b) => b.badge_key);
            } else {
              const rows = await sql`SELECT badge_key FROM badges WHERE entity_id = ${player.puuid}`;
              ownedBadgeKeysWin = rows.map((b) => b.badge_key);
            }

            let triggeredWinBadges = evaluateTriggeredWinBadges(p, currentWinStreak, info, previousLossStreak, ownedBadgeKeysWin, oldTierWin, rankData?.tier ?? null);
            if (triggeredWinBadges.length > 0) {
              const updatedKeys  = [...ownedBadgeKeysWin, ...triggeredWinBadges.map((b) => b.key)];
              const secondPass   = evaluateTriggeredWinBadges(p, currentWinStreak, info, previousLossStreak, updatedKeys, oldTierWin, rankData?.tier ?? null);
              secondPass.forEach((b) => { if (!triggeredWinBadges.find((tb) => tb.key === b.key)) triggeredWinBadges.push(b); });
            }

            for (const badge of triggeredWinBadges) {
              const unlock = await registerBadgeUnlock(player.puuid, badge);
              if (unlock.isNew) unlockedWinBadges.push(badge);
            }
            if (unlockedWinBadges.length > 0) {
              winMessage += `\n${await formatBadgeAnnouncement(client, player, unlockedWinBadges)}`;
            }
            badgeKeysEarned = unlockedWinBadges.map((b) => b.key);
          }

          if (SKIP_DISCORD_SEND) {
            console.log(`[SKIP] Victoire non envoyée (${winSubs.length} salon(s)) :`, String(winMessage).slice(0, 160).replace(/\n/g, " ") + "…");
          } else {
            for (const sub of winSubs) {
              const chan = await client.channels.fetch(sub.channel_id).catch(() => null);
              if (chan) await chan.send(winMessage);
            }
          }

          const tsWin = info.gameEndTimestamp || Date.now();
          await recordNotification({
            ts: tsWin, kind: "win", accountPuuid: player.puuid, matchId,
            message: `✅ [${queueName}] - ${player.game_name} a gagné avec ${p.championName} (${p.kills}/${p.deaths}/${p.assists}) en ${min}:${sec} min.${rankData ? ` - ${rankData.tier} ${rankData.rank} — ${rankData.lp} LP` : ""}`,
            details: { queueLabel: queueName, accountName: player.game_name, champion: p.championName, kills: p.kills, deaths: p.deaths, assists: p.assists, durationSeconds: info.gameDuration, tier: rankData ? `${rankData.tier} ${rankData.rank}` : null, streakCount: currentWinStreak },
          });

          for (const badge of unlockedWinBadges) {
            await recordNotification({
              ts: tsWin + 1, kind: "badge", accountPuuid: player.puuid, matchId,
              message: `✨ ${player.game_name} vient de débloquer le badge « ${badge.name} ».`,
              details: { accountName: player.game_name, badgeKey: badge.key, badgeName: badge.name, badgeRank: badge.rank },
            });
          }

          const WIN_STREAK_MILESTONES = new Set([5, 10, 15]);
          if (WIN_STREAK_MILESTONES.has(currentWinStreak)) {
            await recordNotification({
              ts: tsWin + 2, kind: "streak", accountPuuid: player.puuid, matchId,
              message: `🏆 ${player.game_name} enchaîne ${currentWinStreak} victoires d'affilée !`,
              details: { accountName: player.game_name, streakCount: currentWinStreak },
            });
          }
        }

        await insertMatchHistory(matchId, player.puuid, p, info, p.win, badgeKeysEarned);
      }
    } catch (e) {
      console.error(`❌ Erreur ${player.game_name}: ${e.message}`);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

module.exports = { checkMatches, registerBadgeUnlock };
