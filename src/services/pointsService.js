const { sql } = require("../database");
const { recordNotification } = require("./notifications");

const BET_MULTIPLIER = 1.8;

const POINTS = {
  // Participation à une partie (win ou loss)
  game_played: 100,
  // Bonus win/loss selon le mode du serveur (en plus des 100 de base)
  win_positive:  30,  // mode victoire → gros bonus sur les wins
  win_both:      20,  // mode équilibré
  win_negative:  10,  // mode défaite → petit gain sur les wins
  loss_negative: 30,  // mode défaite → gros bonus sur les losses
  loss_both:     20,  // mode équilibré
  loss_positive: 10,  // mode victoire → petit gain sur les losses
  // Badges
  badge_bronze: 25,
  badge_silver: 50,
  badge_gold: 75,
  badge_secret: 100,
  // Séries de victoires
  streak_3: 50,
  streak_5: 100,
  streak_10: 1000,
};

async function resolveUserId(puuid) {
  const [row] =
    await sql`SELECT user_id FROM accounts WHERE puuid = ${puuid} AND user_id IS NOT NULL LIMIT 1`;
  return row?.user_id ?? null;
}

async function addPoints(puuid, amount, reason, serverId) {
  const userId = await resolveUserId(puuid);
  if (!userId) return;
  await sql`
    INSERT INTO user_points (user_id, server_id, points, total_earned)
    VALUES (${userId}, ${serverId}, ${amount}, ${Math.max(0, amount)})
    ON CONFLICT (user_id, server_id) DO UPDATE SET
      points       = user_points.points + ${amount},
      total_earned = user_points.total_earned + ${Math.max(0, amount)}
  `;
  await sql`
    INSERT INTO point_transactions (user_id, server_id, amount, reason)
    VALUES (${userId}, ${serverId}, ${amount}, ${reason})
  `;
}

async function getUserPoints(puuid, serverId) {
  const userId = await resolveUserId(puuid);
  if (!userId) return { points: 0, total_earned: 0 };
  const [row] =
    await sql`SELECT points, total_earned FROM user_points WHERE user_id = ${userId} AND server_id = ${serverId}`;
  return row ?? { points: 0, total_earned: 0 };
}

async function getServerMode(puuid, serverId) {
  const [row] = await sql`
    SELECT s.mode FROM servers s
    JOIN server_members sm ON sm.server_id = s.id
    WHERE sm.puuid = ${puuid} AND s.id = ${serverId}
  `;
  return row?.mode ?? "both";
}

async function awardWin(puuid, winStreak, serverId) {
  await addPoints(puuid, POINTS.game_played, "game_played", serverId);
  const mode = await getServerMode(puuid, serverId);
  const pts =
    mode === "positive"
      ? POINTS.win_positive
      : mode === "negative"
        ? POINTS.win_negative
        : POINTS.win_both;
  await addPoints(puuid, pts, "win", serverId);
  if (winStreak >= 10)
    await addPoints(puuid, POINTS.streak_10, "streak", serverId);
  else if (winStreak >= 5)
    await addPoints(puuid, POINTS.streak_5, "streak", serverId);
  else if (winStreak >= 3)
    await addPoints(puuid, POINTS.streak_3, "streak", serverId);
}

// Retourne le détail des jetons gagnés pour une victoire (sans écrire en DB)
async function buildWinBreakdown(
  puuid,
  winStreak,
  serverId,
  badgesUnlocked = [],
) {
  const mode = await getServerMode(puuid, serverId);
  const winBonus =
    mode === "positive"
      ? POINTS.win_positive
      : mode === "negative"
        ? POINTS.win_negative
        : POINTS.win_both;
  const breakdown = [
    { label: "Victoire", amount: POINTS.game_played + winBonus },
  ];

  if (winStreak >= 10)
    breakdown.push({
      label: `Série de ${winStreak} victoires`,
      amount: POINTS.streak_10,
    });
  else if (winStreak >= 5)
    breakdown.push({
      label: `Série de ${winStreak} victoires`,
      amount: POINTS.streak_5,
    });
  else if (winStreak >= 3)
    breakdown.push({
      label: `Série de ${winStreak} victoires`,
      amount: POINTS.streak_3,
    });

  for (const badge of badgesUnlocked) {
    const rank = (badge.rank || "").toLowerCase();
    const amount =
      rank === "secret"
        ? POINTS.badge_secret
        : rank === "or" || rank === "gold"
          ? POINTS.badge_gold
          : rank === "argent" || rank === "silver"
            ? POINTS.badge_silver
            : POINTS.badge_bronze;
    breakdown.push({ label: `${badge.name} (${badge.rank})`, amount });
  }
  return breakdown;
}

// Retourne le détail des jetons gagnés pour une défaite (sans écrire en DB)
async function buildLossBreakdown(puuid, serverId, badgesUnlocked = []) {
  const mode = await getServerMode(puuid, serverId);
  const lossBonus =
    mode === "negative"
      ? POINTS.loss_negative
      : mode === "positive"
        ? POINTS.loss_positive
        : POINTS.loss_both;
  const breakdown = [
    { label: "Défaite", amount: POINTS.game_played + lossBonus },
  ];

  for (const badge of badgesUnlocked) {
    const rank = (badge.rank || "").toLowerCase();
    const amount =
      rank === "secret"
        ? POINTS.badge_secret
        : rank === "or" || rank === "gold"
          ? POINTS.badge_gold
          : rank === "argent" || rank === "silver"
            ? POINTS.badge_silver
            : POINTS.badge_bronze;
    breakdown.push({ label: `${badge.name} (${badge.rank})`, amount });
  }
  return breakdown;
}

async function awardLoss(puuid, serverId) {
  await addPoints(puuid, POINTS.game_played, "game_played", serverId);
  const mode = await getServerMode(puuid, serverId);
  const pts =
    mode === "negative"
      ? POINTS.loss_negative
      : mode === "positive"
        ? POINTS.loss_positive
        : POINTS.loss_both;
  await addPoints(puuid, pts, "loss", serverId);
}

async function awardBadge(puuid, badgeRank, serverId) {
  const rank = (badgeRank || "").toLowerCase();
  const amount =
    rank === "secret"
      ? POINTS.badge_secret
      : rank === "or" || rank === "gold"
        ? POINTS.badge_gold
        : rank === "argent" || rank === "silver"
          ? POINTS.badge_silver
          : POINTS.badge_bronze;
  await addPoints(puuid, amount, `badge_unlock_${rank}`, serverId);
}

async function resolveBets(puuid, outcome) {
  const pending = await sql`
    SELECT
      b.id, b.bettor_user_id, b.prediction, b.amount, b.server_id,
      t.game_name AS target_name,
      (SELECT a.puuid FROM accounts a WHERE a.user_id::text = b.bettor_user_id ORDER BY a.id LIMIT 1) AS bettor_puuid
    FROM bets b
    LEFT JOIN accounts t ON t.puuid = b.target_puuid
    WHERE b.target_puuid = ${puuid} AND b.status = 'pending'
  `;
  if (pending.length === 0) return;

  console.log(
    `[resolveBets] ${pending.length} pari(s) à résoudre pour puuid=${puuid} outcome=${outcome}`,
  );

  const now = Date.now();
  for (const bet of pending) {
    const won = bet.prediction === outcome;
    const status = won ? "won" : "lost";
    await sql`UPDATE bets SET status = ${status}, resolved_at = ${now} WHERE id = ${bet.id}`;

    const targetName = bet.target_name || "ce joueur";
    const predLabel = bet.prediction === "win" ? "victoire" : "défaite";

    if (won) {
      const reward = Math.floor(bet.amount * BET_MULTIPLIER);
      const userId = parseInt(bet.bettor_user_id, 10);
      if (userId) {
        await sql`
          INSERT INTO user_points (user_id, server_id, points, total_earned)
          VALUES (${userId}, ${bet.server_id}, ${reward}, ${reward})
          ON CONFLICT (user_id, server_id) DO UPDATE SET
            points       = user_points.points + ${reward},
            total_earned = user_points.total_earned + ${reward}
        `;
        await sql`
          INSERT INTO point_transactions (user_id, server_id, amount, reason)
          VALUES (${userId}, ${bet.server_id}, ${reward}, 'bet_win')
        `;
      }
      console.log(
        `[resolveBets] Pari #${bet.id} GAGNÉ — +${reward} pts (server ${bet.server_id})`,
      );
    } else {
      console.log(
        `[resolveBets] Pari #${bet.id} PERDU — ${bet.amount} pts perdus`,
      );
    }

    await recordNotification({
      ts: now,
      kind: won ? "bet_won" : "bet_lost",
      accountPuuid: bet.bettor_puuid ?? null,
      serverId: bet.server_id,
      message: won
        ? `🎲 Pari gagné sur ${targetName} (${predLabel}) — +${Math.floor(bet.amount * BET_MULTIPLIER)} pts`
        : `🎲 Pari perdu sur ${targetName} (${predLabel}) — ${bet.amount} pts perdus`,
      details: {
        betId: bet.id,
        targetName,
        prediction: bet.prediction,
        amount: bet.amount,
        ...(won ? { reward: Math.floor(bet.amount * BET_MULTIPLIER) } : {}),
      },
    });
  }
}

module.exports = {
  addPoints,
  getUserPoints,
  awardWin,
  awardLoss,
  awardBadge,
  resolveBets,
  buildWinBreakdown,
  buildLossBreakdown,
};
