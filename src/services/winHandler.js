const { sql }                                       = require("../database");
const { evaluateTriggeredWinBadges }                = require("../../badges");
const { recordNotification }                        = require("./notifications");
const { resolveDiscordIdentity, buildWinEmbed, previewEmbed, badgeUnlockMessage } = require("./embeds");
const { QUEUE_TYPES, fetchPlayerRank, rankFromStored } = require("./riot");
const { registerBadgeUnlock }                       = require("./badgeService");
const { awardWin, awardBadge, resolveBets } = require("./pointsService");


function tierColumnForRankedQueue(queueId) {
  if (queueId === 420) return "last_tier_solo";
  if (queueId === 440) return "last_tier_flex";
  return null;
}

// Renvoie les serveurs Discord en mode 'positive' ou 'both' pour ce joueur
async function getWinSubs(puuid) {
  return sql`
    SELECT s.id AS server_id, s.channel_id FROM servers s
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
    const tierFull = rankData.rank ? `${rankData.tier} ${rankData.rank}` : rankData.tier;
    const wCol = info.queueId === 420 ? "wins_solo" : "wins_flex";
    const lCol = info.queueId === 420 ? "losses_solo" : "losses_flex";
    const lpCol = info.queueId === 420 ? "lp_solo" : "lp_flex";
    await sql`UPDATE accounts SET ${sql(winTierCol)} = ${tierFull}, ${sql(wCol)} = ${rankData.wins ?? 0}, ${sql(lCol)} = ${rankData.losses ?? 0}, ${sql(lpCol)} = ${rankData.lp ?? 0} WHERE puuid = ${player.puuid}`;
    player[winTierCol] = tierFull;
  }

  // Pour l'affichage (embed + notifs) : si l'appel live a échoué, on retombe
  // sur le rang déjà stocké au lieu d'afficher "Non classé".
  const rankDisplay = rankData || rankFromStored(player, info.queueId);

  const [winStreakRow] = await sql`SELECT win_streak FROM accounts WHERE puuid = ${player.puuid}`;
  const currentWinStreak = winStreakRow?.win_streak || 0;

  // ── Badges ────────────────────────────────────────────────────────────────────
  const subs = await getWinSubs(player.puuid);

  // Évaluation des badges une seule fois (clés possédées = toutes parties confondues)
  let triggered = [];
  if (subs.length > 0) {
    let ownedBadgeKeys = [];
    if (player.user_id) {
      const rows = await sql`SELECT DISTINCT badge_key FROM badges WHERE entity_id IN (SELECT puuid FROM accounts WHERE user_id = ${player.user_id})`;
      ownedBadgeKeys = rows.map((b) => b.badge_key);
    } else {
      const rows = await sql`SELECT DISTINCT badge_key FROM badges WHERE entity_id = ${player.puuid}`;
      ownedBadgeKeys = rows.map((b) => b.badge_key);
    }

    triggered = evaluateTriggeredWinBadges(p, currentWinStreak, info, previousLossStreak, ownedBadgeKeys, oldTierWin, rankData?.tier ?? null);
    if (triggered.length > 0) {
      const updatedKeys = [...ownedBadgeKeys, ...triggered.map((b) => b.key)];
      const secondPass  = evaluateTriggeredWinBadges(p, currentWinStreak, info, previousLossStreak, updatedKeys, oldTierWin, rankData?.tier ?? null);
      secondPass.forEach((b) => { if (!triggered.find((t) => t.key === b.key)) triggered.push(b); });
    }
  }

  // Enregistrement des badges par serveur
  const unlockedBadges = []; // badges nouveaux sur au moins un serveur (pour embed global)
  const unlockedPerServer = new Map(); // serverId → [{ badge, amount, kind, isFirstOnServer }]
  for (const badge of triggered) {
    for (const sub of subs) {
      const unlock = await registerBadgeUnlock(player.puuid, badge, sub.server_id, player.user_id);
      if (!unlock.isNew) continue;
      // Cas calculé par utilisateur : 1er du serveur / 1re fois / ré-obtention.
      const kind = unlock.kind;
      if (!unlockedBadges.find((b) => b.key === badge.key)) {
        unlockedBadges.push({ ...badge, isFirstOnServer: unlock.isFirstOnServer, kind });
      }
      if (!unlockedPerServer.has(sub.server_id)) unlockedPerServer.set(sub.server_id, []);
      // Crédite les points du badge ; on ne le mémorise pour la notif QUE s'il est crédité.
      const credited = await awardBadge(player.puuid, kind, badge.rank, sub.server_id, matchId);
      if (credited != null) {
        unlockedPerServer.get(sub.server_id).push({ badge, amount: credited, kind, isFirstOnServer: unlock.isFirstOnServer });
      }
    }
  }

  // ── Envoi Discord ─────────────────────────────────────────────────────────────
  const discordIdentity = await resolveDiscordIdentity(client, player);
  const embed = buildWinEmbed({ player, discordIdentity, championName: p.championName, queueName, min, sec, kda, rankData: rankDisplay, streak: currentWinStreak, unlockedBadges });

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
  const baseDetails = { queueLabel: queueName, accountName: player.game_name, champion: p.championName, ...kda, durationSeconds: info.gameDuration, tier: rankDisplay ? [rankDisplay.tier, rankDisplay.rank].filter(Boolean).join(" ") : null, lp: rankDisplay?.lp ?? null };

  for (const sub of subs) {
    // Crédite les points de la partie AVANT d'enregistrer la notif, puis construit la
    // notif à partir du détail RÉELLEMENT crédité (awardWin ne renvoie que ce qui a été
    // écrit en DB). Les badges ont déjà été crédités plus haut (montants mémorisés).
    const gameBreakdown = await awardWin(player.puuid, currentWinStreak, sub.server_id, matchId);
    const serverBadges = unlockedPerServer.get(sub.server_id) ?? [];
    const badgeBreakdown = serverBadges.map(({ badge, amount }) => ({ label: `${badge.name} (${badge.rank})`, amount }));
    const breakdown = [...gameBreakdown, ...badgeBreakdown];
    const pointsTotal = breakdown.reduce((s, b) => s + b.amount, 0);

    await recordNotification({
      ts, kind: "win", accountPuuid: player.puuid, serverId: sub.server_id, matchId,
      message: `🏆 [${queueName}] - ${player.game_name} a gagné avec ${p.championName} (${kda.kills}/${kda.deaths}/${kda.assists}) en ${min}:${sec} min.${rankDisplay ? ` - ${[rankDisplay.tier, rankDisplay.rank].filter(Boolean).join(" ")}${rankDisplay.lp != null ? ` — ${rankDisplay.lp} LP` : ""}` : ""}`,
      details: { ...baseDetails, pointsBreakdown: breakdown, pointsTotal },
    });

    if (currentWinStreak >= 2) {
      await recordNotification({
        ts, kind: "streak", accountPuuid: player.puuid, serverId: sub.server_id, matchId,
        message: `🏆 ${player.game_name} enchaîne ${currentWinStreak} victoires d'affilée.`,
        details: { ...baseDetails, streakCount: currentWinStreak },
      });
    }

    // Notif badge par serveur (le cas — 1er serveur / 1re fois / re-obtention — est propre au serveur)
    for (const { badge, amount, kind, isFirstOnServer } of serverBadges) {
      await recordNotification({
        ts, kind: "badge", accountPuuid: player.puuid, serverId: sub.server_id, matchId,
        message: badgeUnlockMessage(player.game_name, badge.name, kind),
        details: { ...baseDetails, badgeKey: badge.key, badgeName: badge.name, badgeRank: badge.rank, isServerFirst, badgeUnlockKind: kind, badgePoints: amount },
      });
    }
  }

  // ── Bets (les points de partie ont déjà été crédités dans la boucle notif) ────
  await resolveBets(player.puuid, "win").catch((e) => console.error(`[resolveBets] win ${player.game_name}: ${e.message}`));

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

module.exports = { handleWin };
