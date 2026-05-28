const { sql }                                        = require("../database");
const { evaluateTriggeredBadges }                    = require("../../badges");
const { recordNotification }                         = require("./notifications");
const { resolveDiscordIdentity, buildLossEmbed, previewEmbed } = require("./embeds");
const { QUEUE_TYPES, fetchPlayerRank }               = require("./riot");
const { registerBadgeUnlock }                        = require("./badgeService");
const { awardLoss, awardBadge, resolveBets, buildLossBreakdown } = require("./pointsService");


function tierColumnForRankedQueue(queueId) {
  if (queueId === 420) return "last_tier_solo";
  if (queueId === 440) return "last_tier_flex";
  return null;
}

// Renvoie les serveurs Discord en mode 'negative' ou 'both' pour ce joueur
async function getLossSubs(puuid) {
  return sql`
    SELECT s.id AS server_id, s.channel_id FROM servers s
    JOIN server_members sm ON sm.server_id = s.id
    WHERE sm.puuid = ${puuid} AND s.mode IN ('negative', 'both')
  `;
}

async function handleLoss(client, player, p, info, matchId, activeStreak) {
  const queueName = QUEUE_TYPES[info.queueId] || "Partie";
  const min = Math.floor(info.gameDuration / 60);
  const sec = (info.gameDuration % 60).toString().padStart(2, "0");
  const kda = { kills: p.kills, deaths: p.deaths, assists: p.assists };

  const rankData = await fetchPlayerRank(player.puuid, info.queueId);
  const tierCol  = tierColumnForRankedQueue(info.queueId);
  const oldTier  = tierCol && player[tierCol] ? player[tierCol] : null;
  const newTier  = rankData ? rankData.tier : null;

  // ── Badges ────────────────────────────────────────────────────────────────────
  const subs = await getLossSubs(player.puuid);

  // Évaluation des badges une seule fois (clés possédées = toutes parties confondues)
  let triggered = [];
  if (subs.length > 0) {
    let ownedBadgeKeys = [];
    let totalDeadConsolidated = 0;

    if (player.user_id) {
      const rows = await sql`SELECT DISTINCT badge_key FROM badges WHERE entity_id IN (SELECT puuid FROM accounts WHERE user_id = ${player.user_id})`;
      ownedBadgeKeys = rows.map((b) => b.badge_key);
      const [rowDead] = await sql`SELECT SUM(total_time_spent_dead)::int AS sum_dead FROM accounts WHERE user_id = ${player.user_id}`;
      totalDeadConsolidated = rowDead?.sum_dead || 0;
    } else {
      const rows = await sql`SELECT DISTINCT badge_key FROM badges WHERE entity_id = ${player.puuid}`;
      ownedBadgeKeys = rows.map((b) => b.badge_key);
      totalDeadConsolidated = player.total_time_spent_dead || 0;
    }

    triggered = evaluateTriggeredBadges(p, activeStreak, info, ownedBadgeKeys, totalDeadConsolidated, oldTier, newTier);
    if (triggered.length > 0) {
      const updatedKeys = [...ownedBadgeKeys, ...triggered.map((b) => b.key)];
      const secondPass  = evaluateTriggeredBadges(p, activeStreak, info, updatedKeys, totalDeadConsolidated, oldTier, newTier);
      secondPass.forEach((b) => { if (!triggered.find((t) => t.key === b.key)) triggered.push(b); });
    }
  }

  // Enregistrement des badges par serveur
  const unlockedBadges = []; // badges nouveaux sur au moins un serveur (pour embed global)
  const unlockedPerServer = new Map(); // serverId → badge[]
  for (const badge of triggered) {
    for (const sub of subs) {
      const unlock = await registerBadgeUnlock(player.puuid, badge, sub.server_id);
      if (unlock.isNew) {
        if (!unlockedBadges.find((b) => b.key === badge.key)) {
          unlockedBadges.push({ ...badge, isFirstOnServer: unlock.isFirstOnServer });
        }
        if (!unlockedPerServer.has(sub.server_id)) unlockedPerServer.set(sub.server_id, []);
        unlockedPerServer.get(sub.server_id).push(badge);
        await awardBadge(player.puuid, badge.rank, sub.server_id).catch(() => {});
      }
    }
  }

  // ── Mise à jour du rang ───────────────────────────────────────────────────────
  if (newTier && tierCol) {
    const tierFull = rankData?.rank ? `${newTier} ${rankData.rank}` : newTier;
    const wCol = info.queueId === 420 ? "wins_solo" : "wins_flex";
    const lCol = info.queueId === 420 ? "losses_solo" : "losses_flex";
    const lpCol = info.queueId === 420 ? "lp_solo" : "lp_flex";
    await sql`UPDATE accounts SET ${sql(tierCol)} = ${tierFull}, ${sql(wCol)} = ${rankData?.wins ?? 0}, ${sql(lCol)} = ${rankData?.losses ?? 0}, ${sql(lpCol)} = ${rankData?.lp ?? 0} WHERE puuid = ${player.puuid}`;
    player[tierCol] = tierFull;
  }

  // ── Envoi Discord ─────────────────────────────────────────────────────────────
  const discordIdentity = await resolveDiscordIdentity(client, player);
  const embed = buildLossEmbed({ player, discordIdentity, championName: p.championName, queueName, min, sec, kda, rankData, streak: activeStreak, unlockedBadges });

  console.log(`[PREVIEW] ${player.game_name}:\n${previewEmbed(embed)}`);

  const SKIP = process.env.SKIP_DISCORD_NOTIFICATIONS === "1" || process.env.SKIP_DISCORD_NOTIFICATIONS === "true";
  if (!SKIP) {
    for (const sub of subs) {
      const chan = await client.channels.fetch(sub.channel_id).catch(() => null);
      if (chan) await chan.send({ embeds: [embed] });
    }
  }

  // ── Notifications web (une par serveur, avec breakdown des jetons) ─────────────
  const ts = info.gameEndTimestamp || Date.now();
  const baseDetails = { queueLabel: queueName, accountName: player.game_name, champion: p.championName, ...kda, durationSeconds: info.gameDuration, tier: rankData ? `${rankData.tier} ${rankData.rank}` : null, lp: rankData?.lp ?? null };

  for (const sub of subs) {
    const serverBadges = unlockedPerServer.get(sub.server_id) ?? [];
    const breakdown = await buildLossBreakdown(player.puuid, sub.server_id, serverBadges);
    const pointsTotal = breakdown.reduce((s, b) => s + b.amount, 0);

    await recordNotification({
      ts, kind: "loss", accountPuuid: player.puuid, serverId: sub.server_id, matchId,
      message: `🚨 [${queueName}] - ${player.game_name} a perdu avec ${p.championName} (${kda.kills}/${kda.deaths}/${kda.assists}) en ${min}:${sec} min.${rankData ? ` - ${rankData.tier} ${rankData.rank} — ${rankData.lp} LP` : ""}`,
      details: { ...baseDetails, pointsBreakdown: breakdown, pointsTotal },
    });

    if (activeStreak >= 2) {
      await recordNotification({
        ts, kind: "streak", accountPuuid: player.puuid, serverId: sub.server_id, matchId,
        message: `🔥 ${player.game_name} enchaîne ${activeStreak} défaites d'affilée.`,
        details: { ...baseDetails, streakCount: activeStreak },
      });
    }

    for (const badge of unlockedBadges) {
      await recordNotification({
        ts, kind: "badge", accountPuuid: player.puuid, serverId: sub.server_id, matchId,
        message: `✨ ${player.game_name} vient de débloquer le badge « ${badge.name} ».`,
        details: { ...baseDetails, badgeKey: badge.key, badgeName: badge.name, badgeRank: badge.rank, isServerFirst: badge.isFirstOnServer },
      });
    }
  }

  // ── Points & bets (une fois par serveur) ─────────────────────────────────────
  for (const sub of subs) {
    await awardLoss(player.puuid, sub.server_id).catch(() => {});
  }
  await resolveBets(player.puuid, "loss").catch((e) => console.error(`[resolveBets] loss ${player.game_name}: ${e.message}`));

  const lpNormalized = (() => {
    if (!rankData) return null;
    const TIER_BASE = { IRON: 0, BRONZE: 4, SILVER: 8, GOLD: 12, PLATINUM: 16, EMERALD: 20, DIAMOND: 24, MASTER: 28, GRANDMASTER: 29, CHALLENGER: 30 };
    const DIV = { IV: 0, III: 1, II: 2, I: 3 };
    const base = TIER_BASE[rankData.tier?.toUpperCase()];
    if (base === undefined) return null;
    const div = DIV[rankData.rank?.toUpperCase()] ?? 0;
    return (base + div) * 100 + (rankData.lp ?? 0);
  })();
  return { badgeKeys: unlockedBadges.map((b) => b.key), lpNormalized };
}

module.exports = { handleLoss };
