const axios = require("axios");
const { db } = require("../database");
const { RIOT_API_KEY, QUEUE_TYPES, fetchPlayerRank } = require("./riot");
const { evaluateTriggeredBadges, evaluateTriggeredWinBadges } = require("../../badges");
const { recordNotification } = require("./notifications");

/** Si `true` ou `1` : pas d’envoi sur Discord (tests locaux / page Live sans spam). Les stats & la BDD restent mises à jour ; les `recordNotification` restent actifs pour la page Logs. */
const SKIP_DISCORD_SEND =
  process.env.SKIP_DISCORD_NOTIFICATIONS === "1" ||
  process.env.SKIP_DISCORD_NOTIFICATIONS === "true";

/** Mutex simple : empêche deux exécutions concurrentes de checkMatches de traiter les mêmes parties en double. */
let _checkRunning = false;

/** Paliers de série de défaites à journaliser (kind = 'streak'). */
const STREAK_MILESTONES = new Set([3, 5, 10, 15]);

/** Colonne `accounts` pour le rang Riot : uniquement SoloQ (420) ou Flex (440). */
function tierColumnForRankedQueue(queueId) {
  if (queueId === 420) return "last_tier_solo";
  if (queueId === 440) return "last_tier_flex";
  return null;
}

function updateLossStats(player, isWin, timeSpentDead = 0) {
  const puuid = player.puuid;
  const monthStr = new Date().toISOString().slice(0, 7);

  // Temps mort (toujours)
  db.prepare("UPDATE accounts SET total_time_spent_dead = total_time_spent_dead + ? WHERE puuid = ?").run(timeSpentDead, puuid);

  if (isWin) {
    // Victoire : reset loss_streak, incrémente win stats
    if (player.discord_user_id) {
      db.prepare("UPDATE accounts SET loss_streak = 0 WHERE discord_user_id = ?").run(player.discord_user_id);
    } else {
      db.prepare("UPDATE accounts SET loss_streak = 0 WHERE puuid = ?").run(puuid);
    }
    db.prepare("UPDATE accounts SET win_streak = win_streak + 1, total_wins = total_wins + 1 WHERE puuid = ?").run(puuid);
    db.prepare("UPDATE accounts SET max_win_streak = MAX(max_win_streak, win_streak) WHERE puuid = ?").run(puuid);

    db.prepare(`
      INSERT INTO monthly_stats (puuid, month, wins, losses, games, total_time_spent_dead)
      VALUES (?, ?, 1, 0, 1, ?)
      ON CONFLICT(puuid, month) DO UPDATE SET
        wins  = wins + 1,
        games = games + 1,
        total_time_spent_dead = total_time_spent_dead + ?
    `).run(puuid, monthStr, timeSpentDead, timeSpentDead);
  } else {
    // Défaite : reset win_streak, incrémente loss stats
    db.prepare("UPDATE accounts SET win_streak = 0 WHERE puuid = ?").run(puuid);
    db.prepare("UPDATE accounts SET loss_streak = loss_streak + 1, total_losses = total_losses + 1 WHERE puuid = ?").run(puuid);
    db.prepare("UPDATE accounts SET max_loss_streak = MAX(max_loss_streak, loss_streak) WHERE puuid = ?").run(puuid);

    db.prepare(`
      INSERT INTO monthly_stats (puuid, month, wins, losses, games, total_time_spent_dead)
      VALUES (?, ?, 0, 1, 1, ?)
      ON CONFLICT(puuid, month) DO UPDATE SET
        losses = losses + 1,
        games  = games + 1,
        total_time_spent_dead = total_time_spent_dead + ?
    `).run(puuid, monthStr, timeSpentDead, timeSpentDead);
  }

  if (player.discord_user_id) {
    const row = db
      .prepare(
        "SELECT SUM(loss_streak) as sum_streak FROM accounts WHERE discord_user_id = ?",
      )
      .get(player.discord_user_id);
    return row ? row.sum_streak : 0;
  } else {
    const row = db
      .prepare("SELECT loss_streak FROM accounts WHERE puuid = ?")
      .get(puuid);
    return row ? row.loss_streak : 0;
  }
}

function insertMatchHistory(matchId, puuid, participant, info, win, badgeKeys) {
  try {
    const playedAt = new Date(info.gameEndTimestamp).toISOString();
    const badgesJson =
      Array.isArray(badgeKeys) && badgeKeys.length > 0
        ? JSON.stringify(badgeKeys)
        : null;
    const teamPosition = typeof participant.teamPosition === "string" && participant.teamPosition
      ? participant.teamPosition
      : null;
    db.prepare(
      `
      INSERT OR REPLACE INTO match_history (
        id, puuid, champion_name, kills, deaths, assists,
        duration_seconds, queue_id, played_at, win, badges_json, time_spent_dead_seconds,
        team_position
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    ).run(
      matchId,
      puuid,
      participant.championName,
      participant.kills,
      participant.deaths,
      participant.assists,
      info.gameDuration,
      info.queueId,
      playedAt,
      win ? 1 : 0,
      badgesJson,
      typeof participant.totalTimeSpentDead === "number" ? participant.totalTimeSpentDead : 0,
      teamPosition,
    );
  } catch (e) {
    console.error("match_history:", e.message);
  }
}

function registerBadgeUnlock(puuid, badge) {
  const nowIso = new Date().toISOString();
  // On stocke toujours sur le PUUID du compte LoL
  const exists = db
    .prepare(
      "SELECT unlock_count FROM badges WHERE entity_id = ? AND badge_key = ?",
    )
    .get(puuid, badge.key);

  if (exists && !badge.repeatable) {
    return { isNew: false, unlockCount: exists.unlock_count };
  }

  if (!exists) {
    db.prepare(
      "INSERT INTO badges (entity_id, is_discord, badge_key, first_unlocked_at, last_unlocked_at, unlock_count) VALUES (?, 0, ?, ?, ?, 1)",
    ).run(puuid, badge.key, nowIso, nowIso);
    return { isNew: true, unlockCount: 1 };
  }

  db.prepare(
    "UPDATE badges SET unlock_count = unlock_count + 1, last_unlocked_at = ? WHERE entity_id = ? AND badge_key = ?",
  ).run(nowIso, puuid, badge.key);
  return { isNew: true, unlockCount: exists.unlock_count + 1 };
}

async function formatBadgeAnnouncement(client, player, unlockedBadges) {
  if (!unlockedBadges.length) return "";

  let discordLabel = `**${player.game_name}**`;
  if (player.discord_user_id) {
    try {
      const user =
        client.users.cache.get(player.discord_user_id) ||
        (await client.users.fetch(player.discord_user_id));
      discordLabel = `**${user.globalName || user.username}**`;
    } catch {
      // fallback
    }
  }

  let announcement = "";

  const normalBadges = unlockedBadges.filter((b) => b.rank !== "Secret");
  const secretBadges = unlockedBadges.filter((b) => b.rank === "Secret");

  if (normalBadges.length > 0) {
    const badgesText = normalBadges
      .map(
        (badge) =>
          `le badge **${badge.name}** (${badge.rank}) : ${badge.description}`,
      )
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
  const accounts = db.prepare("SELECT * FROM accounts").all();
  const now = Date.now();

  for (const player of accounts) {
    try {
      // --- LOGIQUE D'INTERVALLE ADAPTATIF ---
      const lastMatchAt = player.last_match_at || 0;
      const lastCheckedAt = player.last_checked_at || 0;
      const timeSinceLastMatch = now - lastMatchAt;
      const timeSinceLastCheck = now - lastCheckedAt;

      let interval = 2 * 60 * 1000; // Par défaut 2 min
      if (lastMatchAt > 0) {
        if (timeSinceLastMatch > 24 * 60 * 60 * 1000) {
          interval = 30 * 60 * 1000; // > 24h : 30 min
        } else if (timeSinceLastMatch > 2 * 60 * 60 * 1000) {
          interval = 15 * 60 * 1000; // > 2h : 15 min
        }
      }

      if (timeSinceLastCheck < interval) continue;

      // Mise à jour du timestamp de vérification
      db.prepare("UPDATE accounts SET last_checked_at = ? WHERE puuid = ?").run(
        now,
        player.puuid,
      );

      console.log(`⏳ Vérification : ${player.game_name}`);
      const axiosConfig = { headers: { "X-Riot-Token": RIOT_API_KEY } };

      // On récupère les 2 derniers matchs
      const lolMatchUrl = `https://europe.api.riotgames.com/lol/match/v5/matches/by-puuid/${player.puuid}/ids?count=2`;
      const lolRes = await axios.get(lolMatchUrl, axiosConfig);
      const matchIds = lolRes.data || [];

      // Identifier les nouveaux matchs
      let newMatchIds = [];
      if (player.last_match_id) {
        const lastIndex = matchIds.indexOf(player.last_match_id);
        if (lastIndex === -1) {
          newMatchIds = matchIds;
        } else {
          newMatchIds = matchIds.slice(0, lastIndex);
        }
      } else if (matchIds.length > 0) {
        // Premier lancement
        db.prepare(
          "UPDATE accounts SET last_match_id = ?, last_match_at = ? WHERE puuid = ?",
        ).run(
          matchIds[0],
          now,
          player.puuid,
        );
        continue;
      }

      // On traite du plus VIEUX au plus RÉCENT
      newMatchIds.reverse();

      for (const matchId of newMatchIds) {
        const detailUrl = `https://europe.api.riotgames.com/lol/match/v5/matches/${matchId}`;
        const detRes = await axios.get(detailUrl, axiosConfig);
        const info = detRes.data.info;
        const p = info.participants.find((part) => part.puuid === player.puuid);

        // Mise à jour immédiate du dernier match traité
        db.prepare(
          "UPDATE accounts SET last_match_id = ?, last_match_at = ? WHERE puuid = ?",
        ).run(matchId, info.gameEndTimestamp, player.puuid);

        if (!p || info.gameDuration <= 300) continue;

        // Capture la série de défaites AVANT de la réinitialiser (pour le badge COMEBACK)
        const previousLossStreak = player.loss_streak || 0;

        const activeStreak = updateLossStats(player, p.win, p.totalTimeSpentDead);

        let badgeKeysEarned = [];

        if (!p.win) {
          const queueName = QUEUE_TYPES[info.queueId] || "Partie";
          const min = Math.floor(info.gameDuration / 60);
          const sec = (info.gameDuration % 60).toString().padStart(2, "0");

          const rankData = await fetchPlayerRank(player.puuid, info.queueId);

          // On garde toujours le pseudo LoL pour le message principal
          let message = `🚨 [${queueName}] - **${player.game_name}** a perdu avec **${p.championName}** (${p.kills}/${p.deaths}/${p.assists}) en **${min}:${sec}** min.`;

          if (rankData) {
            message += ` - ${rankData.tier} ${rankData.rank} — ${rankData.lp} LP`;
          }

          if (activeStreak > 1) {
            message += `\n🔥 Série de défaites : ${activeStreak}`;
          }

          // Filtre par mode : les serveurs en mode 'positive' ne reçoivent pas les défaites
          const subs = db
            .prepare(`SELECT s.channel_id FROM servers s JOIN server_members sm ON sm.server_id = s.id WHERE sm.puuid = ? AND (s.mode = 'negative' OR s.mode = 'both')`)
            .all(player.puuid);

          // Palier stocké par file (Solo / Flex) — jamais la même colonne pour deux files différentes
          const tierCol = tierColumnForRankedQueue(info.queueId);
          const oldTier =
            tierCol && player[tierCol] != null && String(player[tierCol]).trim() !== ""
              ? player[tierCol]
              : null;

          const newTier = rankData ? rankData.tier : null;

          // Badges négatifs uniquement si le joueur est dans un serveur mode 'negative' ou 'both'
          if (subs.length > 0) {
            let ownedBadgeKeys = [];
            let totalDeadConsolidated = 0;

            if (player.discord_user_id) {
              ownedBadgeKeys = db.prepare(`
                SELECT DISTINCT badge_key
                FROM badges
                WHERE entity_id IN (SELECT puuid FROM accounts WHERE discord_user_id = ?)
              `).all(player.discord_user_id).map(b => b.badge_key);

              const rowDead = db.prepare("SELECT SUM(total_time_spent_dead) as sum_dead FROM accounts WHERE discord_user_id = ?").get(player.discord_user_id);
              totalDeadConsolidated = rowDead?.sum_dead || 0;
            } else {
              ownedBadgeKeys = db.prepare("SELECT badge_key FROM badges WHERE entity_id = ?").all(player.puuid).map(b => b.badge_key);
              totalDeadConsolidated = player.total_time_spent_dead || 0;
            }

            // --- BADGE EVALUATION ---
            let triggeredBadges = evaluateTriggeredBadges(p, activeStreak, info, ownedBadgeKeys, totalDeadConsolidated, oldTier, newTier);

            if (triggeredBadges.length > 0) {
              const updatedBadges = [...ownedBadgeKeys, ...triggeredBadges.map(b => b.key)];
              const secondPass = evaluateTriggeredBadges(p, activeStreak, info, updatedBadges, totalDeadConsolidated, oldTier, newTier);
              secondPass.forEach(b => {
                if (!triggeredBadges.find(tb => tb.key === b.key)) {
                  triggeredBadges.push(b);
                }
              });
            }

            const unlockedBadges = [];
            for (const badge of triggeredBadges) {
              const unlock = registerBadgeUnlock(player.puuid, badge);
              if (unlock.isNew) {
                unlockedBadges.push(badge);
              }
            }
            if (unlockedBadges.length > 0) {
              message += `\n${await formatBadgeAnnouncement(client, player, unlockedBadges)}`;
            }

            badgeKeysEarned = unlockedBadges.map((b) => b.key);
          }

          // Mise à jour du palier pour la file de cette partie uniquement
          if (newTier && tierCol) {
            db.prepare(`UPDATE accounts SET ${tierCol} = ? WHERE puuid = ?`).run(
              newTier,
              player.puuid,
            );
            player[tierCol] = newTier;
          }

          if (SKIP_DISCORD_SEND) {
            console.log(
              `[SKIP_DISCORD_NOTIFICATIONS] Message non envoyé (${subs.length} salon(s)) :`,
              String(message).slice(0, 160).replace(/\n/g, " ") + "…",
            );
          } else {
            for (const sub of subs) {
              const chan = await client.channels
                .fetch(sub.channel_id)
                .catch(() => null);
              if (chan) await chan.send(message);
            }
          }

          // Journal : on duplique l'événement en notifications distinctes pour
          // que la page Logs puisse les filtrer par type. La défaite garde le
          // message complet ; chaque badge et chaque palier de streak vit en
          // entrée séparée pour rester lisible côté UI.
          const ts = info.gameEndTimestamp || Date.now();
          recordNotification({
            ts,
            kind: "loss",
            accountPuuid: player.puuid,
            matchId,
            message: `🚨 [${queueName}] - ${player.game_name} a perdu avec ${p.championName} (${p.kills}/${p.deaths}/${p.assists}) en ${min}:${sec} min.${rankData ? ` - ${rankData.tier} ${rankData.rank} — ${rankData.lp} LP` : ""}`,
            details: {
              queueLabel: queueName,
              accountName: player.game_name,
              champion: p.championName,
              kills: p.kills,
              deaths: p.deaths,
              assists: p.assists,
              durationSeconds: info.gameDuration,
              tier: rankData ? `${rankData.tier} ${rankData.rank}` : null,
              lp: rankData ? rankData.lp : null,
              streak: activeStreak,
            },
          });

          for (const badge of unlockedBadges) {
            recordNotification({
              ts: ts + 1,
              kind: "badge",
              accountPuuid: player.puuid,
              matchId,
              message: `✨ ${player.game_name} vient de débloquer le badge « ${badge.name} ».`,
              details: {
                accountName: player.game_name,
                badgeKey: badge.key,
                badgeName: badge.name,
                badgeRank: badge.rank,
              },
            });
          }

          if (STREAK_MILESTONES.has(activeStreak)) {
            recordNotification({
              ts: ts + 2,
              kind: "streak",
              accountPuuid: player.puuid,
              matchId,
              message: `🔥 ${player.game_name} enchaîne ${activeStreak} défaites d'affilée.`,
              details: { accountName: player.game_name, streak: activeStreak },
            });
          }
        } else {
          // Victoire — mise à jour du tier
          const rankData = await fetchPlayerRank(player.puuid, info.queueId);
          const winTierCol = tierColumnForRankedQueue(info.queueId);
          const oldTierWin = winTierCol && player[winTierCol] ? player[winTierCol] : null;
          if (rankData && winTierCol) {
            db.prepare(`UPDATE accounts SET ${winTierCol} = ? WHERE puuid = ?`).run(rankData.tier, player.puuid);
            player[winTierCol] = rankData.tier;
          }

          // Récupération du win_streak actuel (après updateLossStats l'a incrémenté)
          const winStreakRow = db.prepare("SELECT win_streak FROM accounts WHERE puuid = ?").get(player.puuid);
          const currentWinStreak = winStreakRow?.win_streak || 0;

          const queueName = QUEUE_TYPES[info.queueId] || "Partie";
          const min = Math.floor(info.gameDuration / 60);
          const sec = (info.gameDuration % 60).toString().padStart(2, "0");

          let winMessage = `✅ [${queueName}] - **${player.game_name}** a gagné avec **${p.championName}** (${p.kills}/${p.deaths}/${p.assists}) en **${min}:${sec}** min.`;
          if (rankData) winMessage += ` - ${rankData.tier} ${rankData.rank} — ${rankData.lp} LP`;
          if (currentWinStreak > 1) winMessage += `\n🔥 Série de victoires : ${currentWinStreak}`;

          // Filtre par mode : les serveurs en mode 'negative' ne reçoivent pas les victoires
          const winSubs = db
            .prepare(`SELECT s.channel_id FROM servers s JOIN server_members sm ON sm.server_id = s.id WHERE sm.puuid = ? AND (s.mode = 'positive' OR s.mode = 'both')`)
            .all(player.puuid);

          // Badges positifs uniquement si le joueur est dans un serveur mode 'positive' ou 'both'
          if (winSubs.length > 0) {
            let ownedBadgeKeysWin = [];
            if (player.discord_user_id) {
              ownedBadgeKeysWin = db.prepare(`SELECT DISTINCT badge_key FROM badges WHERE entity_id IN (SELECT puuid FROM accounts WHERE discord_user_id = ?)`).all(player.discord_user_id).map(b => b.badge_key);
            } else {
              ownedBadgeKeysWin = db.prepare("SELECT badge_key FROM badges WHERE entity_id = ?").all(player.puuid).map(b => b.badge_key);
            }

            let triggeredWinBadges = evaluateTriggeredWinBadges(p, currentWinStreak, info, previousLossStreak, ownedBadgeKeysWin, oldTierWin, rankData?.tier ?? null);
            if (triggeredWinBadges.length > 0) {
              const updatedKeys = [...ownedBadgeKeysWin, ...triggeredWinBadges.map(b => b.key)];
              const secondPass = evaluateTriggeredWinBadges(p, currentWinStreak, info, previousLossStreak, updatedKeys, oldTierWin, rankData?.tier ?? null);
              secondPass.forEach(b => { if (!triggeredWinBadges.find(tb => tb.key === b.key)) triggeredWinBadges.push(b); });
            }

            const unlockedWinBadges = [];
            for (const badge of triggeredWinBadges) {
              const unlock = registerBadgeUnlock(player.puuid, badge);
              if (unlock.isNew) unlockedWinBadges.push(badge);
            }
            if (unlockedWinBadges.length > 0) {
              winMessage += `\n${await formatBadgeAnnouncement(client, player, unlockedWinBadges)}`;
            }

            badgeKeysEarned = unlockedWinBadges.map(b => b.key);
          }

          if (SKIP_DISCORD_SEND) {
            console.log(`[SKIP_DISCORD_NOTIFICATIONS] Victoire non envoyée (${winSubs.length} salon(s)) :`, String(winMessage).slice(0, 160).replace(/\n/g, " ") + "…");
          } else {
            for (const sub of winSubs) {
              const chan = await client.channels.fetch(sub.channel_id).catch(() => null);
              if (chan) await chan.send(winMessage);
            }
          }

          const tsWin = info.gameEndTimestamp || Date.now();
          recordNotification({
            ts: tsWin,
            kind: "win",
            accountPuuid: player.puuid,
            matchId,
            message: `✅ [${queueName}] - ${player.game_name} a gagné avec ${p.championName} (${p.kills}/${p.deaths}/${p.assists}) en ${min}:${sec} min.${rankData ? ` - ${rankData.tier} ${rankData.rank} — ${rankData.lp} LP` : ""}`,
            details: {
              queueLabel: queueName,
              accountName: player.game_name,
              champion: p.championName,
              kills: p.kills,
              deaths: p.deaths,
              assists: p.assists,
              durationSeconds: info.gameDuration,
              tier: rankData ? `${rankData.tier} ${rankData.rank}` : null,
              streakCount: currentWinStreak,
            },
          });

          for (const badge of unlockedWinBadges) {
            recordNotification({
              ts: tsWin + 1,
              kind: "badge",
              accountPuuid: player.puuid,
              matchId,
              message: `✨ ${player.game_name} vient de débloquer le badge « ${badge.name} ».`,
              details: { accountName: player.game_name, badgeKey: badge.key, badgeName: badge.name, badgeRank: badge.rank },
            });
          }

          const WIN_STREAK_MILESTONES = new Set([5, 10, 15]);
          if (WIN_STREAK_MILESTONES.has(currentWinStreak)) {
            recordNotification({
              ts: tsWin + 2,
              kind: "streak",
              accountPuuid: player.puuid,
              matchId,
              message: `🏆 ${player.game_name} enchaîne ${currentWinStreak} victoires d'affilée !`,
              details: { accountName: player.game_name, streakCount: currentWinStreak },
            });
          }
        }

        insertMatchHistory(matchId, player.puuid, p, info, p.win, badgeKeysEarned);
      }
    } catch (e) {
      console.error(`❌ Erreur ${player.game_name}: ${e.message}`);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

module.exports = {
  checkMatches,
  registerBadgeUnlock,
};
