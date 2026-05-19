const { sql }                                       = require("../database");
const { evaluateTriggeredWinBadges }                = require("../../badges");
const { recordNotification }                        = require("./notifications");
const { resolveDiscordLabel, buildWinEmbed, previewEmbed } = require("./embeds");
const { QUEUE_TYPES, fetchPlayerRank }              = require("./riot");
const { registerBadgeUnlock }                       = require("./badgeService");


function tierColumnForRankedQueue(queueId) {
  if (queueId === 420) return "last_tier_solo";
  if (queueId === 440) return "last_tier_flex";
  return null;
}

// Renvoie les channels Discord des serveurs en mode 'positive' ou 'both' pour ce joueur
async function getWinSubs(puuid) {
  return sql`
    SELECT s.channel_id FROM servers s
    JOIN server_members sm ON sm.server_id = s.id
    WHERE sm.puuid = ${puuid} AND s.mode IN ('positive', 'both')
  `;
}

async function handleWin(client, player, p, info, matchId, previousLossStreak) {
  const queueName = QUEUE_TYPES[info.queueId] || "Partie";
  const min = Math.floor(info.gameDuration / 60);
  const sec = (info.gameDuration % 60).toString().padStart(2, "0");
  const kda = { kills: p.kills, deaths: p.deaths, assists: p.assists };

  const rankData   = await fetchPlayerRank(player.puuid, info.queueId);
  const winTierCol = tierColumnForRankedQueue(info.queueId);
  const oldTierWin = winTierCol && player[winTierCol] ? player[winTierCol] : null;

  if (rankData && winTierCol) {
    await sql`UPDATE accounts SET ${sql(winTierCol)} = ${rankData.tier} WHERE puuid = ${player.puuid}`;
    player[winTierCol] = rankData.tier;
  }

  const [winStreakRow] = await sql`SELECT win_streak FROM accounts WHERE puuid = ${player.puuid}`;
  const currentWinStreak = winStreakRow?.win_streak || 0;

  // ── Badges ────────────────────────────────────────────────────────────────────
  const subs = await getWinSubs(player.puuid);
  let unlockedBadges = [];

  if (subs.length > 0) {
    let ownedBadgeKeys = [];
    if (player.user_id) {
      const rows = await sql`SELECT DISTINCT badge_key FROM badges WHERE entity_id IN (SELECT puuid FROM accounts WHERE user_id = ${player.user_id})`;
      ownedBadgeKeys = rows.map((b) => b.badge_key);
    } else {
      const rows = await sql`SELECT badge_key FROM badges WHERE entity_id = ${player.puuid}`;
      ownedBadgeKeys = rows.map((b) => b.badge_key);
    }

    let triggered = evaluateTriggeredWinBadges(p, currentWinStreak, info, previousLossStreak, ownedBadgeKeys, oldTierWin, rankData?.tier ?? null);
    if (triggered.length > 0) {
      const updatedKeys = [...ownedBadgeKeys, ...triggered.map((b) => b.key)];
      const secondPass  = evaluateTriggeredWinBadges(p, currentWinStreak, info, previousLossStreak, updatedKeys, oldTierWin, rankData?.tier ?? null);
      secondPass.forEach((b) => { if (!triggered.find((t) => t.key === b.key)) triggered.push(b); });
    }

    for (const badge of triggered) {
      const unlock = await registerBadgeUnlock(player.puuid, badge);
      if (unlock.isNew) unlockedBadges.push(badge);
    }
  }

  // ── Envoi Discord ─────────────────────────────────────────────────────────────
  const discordLabel = await resolveDiscordLabel(client, player);
  const embed = buildWinEmbed({ discordLabel, championName: p.championName, queueName, min, sec, kda, rankData, streak: currentWinStreak, unlockedBadges });

  console.log(`[PREVIEW] ${player.game_name}:\n${previewEmbed(embed)}`);

  const SKIP = process.env.SKIP_DISCORD_NOTIFICATIONS === "1" || process.env.SKIP_DISCORD_NOTIFICATIONS === "true";
  if (!SKIP) {
    for (const sub of subs) {
      const chan = await client.channels.fetch(sub.channel_id).catch(() => null);
      if (chan) await chan.send({ embeds: [embed] });
    }
  }

  // ── Notifications web ─────────────────────────────────────────────────────────
  const ts = info.gameEndTimestamp || Date.now();
  await recordNotification({
    ts, kind: "win", accountPuuid: player.puuid, matchId,
    message: `✅ [${queueName}] - ${player.game_name} a gagné avec ${p.championName} (${kda.kills}/${kda.deaths}/${kda.assists}) en ${min}:${sec} min.${rankData ? ` - ${rankData.tier} ${rankData.rank} — ${rankData.lp} LP` : ""}`,
    details: { queueLabel: queueName, accountName: player.game_name, champion: p.championName, ...kda, durationSeconds: info.gameDuration, tier: rankData ? `${rankData.tier} ${rankData.rank}` : null, lp: rankData?.lp ?? null, streakCount: currentWinStreak },
  });

  for (const badge of unlockedBadges) {
    await recordNotification({
      ts: ts + 1, kind: "badge", accountPuuid: player.puuid, matchId,
      message: `✨ ${player.game_name} vient de débloquer le badge « ${badge.name} ».`,
      details: { accountName: player.game_name, badgeKey: badge.key, badgeName: badge.name, badgeRank: badge.rank },
    });
  }

  if (currentWinStreak >= 2) {
    await recordNotification({
      ts: ts + 2, kind: "streak", accountPuuid: player.puuid, matchId,
      message: `🏆 ${player.game_name} enchaîne ${currentWinStreak} victoires d'affilée !`,
      details: { accountName: player.game_name, streakCount: currentWinStreak },
    });
  }

  return unlockedBadges.map((b) => b.key);
}

module.exports = { handleWin };
