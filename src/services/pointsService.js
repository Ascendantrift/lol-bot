const { sql } = require("../database");
const { recordNotification } = require("./notifications");

const BET_MULTIPLIER = 1.8;

const POINTS = {
  win:           15,
  loss:           5,
  badge_bronze:  10,
  badge_silver:  20,
  badge_gold:    35,
  badge_secret:  75,
  streak_3:      20,
  streak_5:      50,
};

async function addPoints(puuid, amount, reason) {
  await sql`
    INSERT INTO user_points (user_id, points, total_earned)
    VALUES (${puuid}, ${amount}, ${amount})
    ON CONFLICT (user_id) DO UPDATE SET
      points      = user_points.points + ${amount},
      total_earned = user_points.total_earned + ${Math.max(0, amount)}
  `;
  await sql`
    INSERT INTO point_transactions (user_id, amount, reason)
    VALUES (${puuid}, ${amount}, ${reason})
  `;
}

async function getUserPoints(puuid) {
  const [row] = await sql`SELECT points, total_earned FROM user_points WHERE user_id = ${puuid}`;
  return row ?? { points: 0, total_earned: 0 };
}

async function awardWin(puuid, winStreak) {
  await addPoints(puuid, POINTS.win, "win");
  if (winStreak >= 5) await addPoints(puuid, POINTS.streak_5, "streak");
  else if (winStreak >= 3) await addPoints(puuid, POINTS.streak_3, "streak");
}

async function awardLoss(puuid) {
  await addPoints(puuid, POINTS.loss, "loss");
}

async function awardBadge(puuid, badgeRank) {
  const rank = (badgeRank || "").toLowerCase();
  const amount =
    rank === "secret" ? POINTS.badge_secret :
    rank === "gold"   ? POINTS.badge_gold :
    rank === "silver" ? POINTS.badge_silver :
    POINTS.badge_bronze;
  await addPoints(puuid, amount, `badge_unlock_${rank}`);
}

async function resolveBets(puuid, outcome) {
  const pending = await sql`
    SELECT
      b.id, b.bettor_user_id, b.prediction, b.amount,
      t.game_name AS target_name,
      (SELECT a.puuid FROM accounts a WHERE a.user_id = b.bettor_user_id::int ORDER BY a.id LIMIT 1) AS bettor_puuid
    FROM bets b
    JOIN accounts t ON t.puuid = b.target_puuid
    WHERE b.target_puuid = ${puuid} AND b.status = 'pending'
  `;
  if (pending.length === 0) return;

  const now = Date.now();
  for (const bet of pending) {
    const won = bet.prediction === outcome;
    const status = won ? "won" : "lost";
    await sql`UPDATE bets SET status = ${status}, resolved_at = ${now} WHERE id = ${bet.id}`;

    const targetName = bet.target_name || "ce joueur";
    const predLabel = bet.prediction === "win" ? "victoire" : "défaite";

    if (won) {
      const reward = Math.floor(bet.amount * BET_MULTIPLIER);
      await sql`
        INSERT INTO user_points (user_id, points, total_earned)
        VALUES (
          (SELECT puuid FROM accounts WHERE user_id = ${bet.bettor_user_id}::int ORDER BY id LIMIT 1),
          ${reward}, ${reward}
        )
        ON CONFLICT (user_id) DO UPDATE SET
          points = user_points.points + ${reward},
          total_earned = user_points.total_earned + ${reward}
      `;
      await sql`
        INSERT INTO point_transactions (user_id, amount, reason)
        VALUES (
          (SELECT puuid FROM accounts WHERE user_id = ${bet.bettor_user_id}::int ORDER BY id LIMIT 1),
          ${reward}, 'bet_win'
        )
      `;
      await recordNotification({
        ts: now,
        kind: "bet_won",
        accountPuuid: bet.bettor_puuid,
        message: `🎲 Pari gagné sur ${targetName} (${predLabel}) — +${reward} pts`,
        details: { betId: bet.id, targetName, prediction: bet.prediction, amount: bet.amount, reward },
      });
    } else {
      await recordNotification({
        ts: now,
        kind: "bet_lost",
        accountPuuid: bet.bettor_puuid,
        message: `🎲 Pari perdu sur ${targetName} (${predLabel}) — ${bet.amount} pts perdus`,
        details: { betId: bet.id, targetName, prediction: bet.prediction, amount: bet.amount },
      });
    }
  }
}

module.exports = { addPoints, getUserPoints, awardWin, awardLoss, awardBadge, resolveBets };
