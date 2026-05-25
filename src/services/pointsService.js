const { sql } = require("../database");
const { recordNotification } = require("./notifications");

const BET_MULTIPLIER = 1.8;

const POINTS = {
  // Gains win/loss selon le mode du serveur
  win_positive:  30,  // mode victoire → gros bonus sur les wins
  win_both:      20,  // mode équilibré
  win_negative:  10,  // mode défaite → petit gain sur les wins
  loss_negative: 30,  // mode défaite → gros bonus sur les losses
  loss_both:     20,  // mode équilibré
  loss_positive: 10,  // mode victoire → petit gain sur les losses
  // Badges
  badge_bronze:  10,
  badge_silver:  20,
  badge_gold:    35,
  badge_secret:  75,
  // Séries de victoires
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

// Retourne le mode agrégé du joueur parmi tous ses serveurs
async function getPlayerMode(puuid) {
  const rows = await sql`
    SELECT DISTINCT s.mode FROM servers s
    JOIN server_members sm ON sm.server_id = s.id
    WHERE sm.puuid = ${puuid}
  `;
  if (rows.length === 0) return "both";
  if (rows.some((r) => r.mode === "both")) return "both";
  const hasPos = rows.some((r) => r.mode === "positive");
  const hasNeg = rows.some((r) => r.mode === "negative");
  if (hasPos && hasNeg) return "both";
  if (hasPos) return "positive";
  if (hasNeg) return "negative";
  return "both";
}

async function awardWin(puuid, winStreak) {
  const mode = await getPlayerMode(puuid);
  const pts =
    mode === "positive" ? POINTS.win_positive :
    mode === "negative" ? POINTS.win_negative :
    POINTS.win_both;
  await addPoints(puuid, pts, "win");
  if (winStreak >= 5) await addPoints(puuid, POINTS.streak_5, "streak");
  else if (winStreak >= 3) await addPoints(puuid, POINTS.streak_3, "streak");
}

async function awardLoss(puuid) {
  const mode = await getPlayerMode(puuid);
  const pts =
    mode === "negative" ? POINTS.loss_negative :
    mode === "positive" ? POINTS.loss_positive :
    POINTS.loss_both;
  await addPoints(puuid, pts, "loss");
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
      (SELECT a.puuid FROM accounts a WHERE a.user_id::text = b.bettor_user_id ORDER BY a.id LIMIT 1) AS bettor_puuid
    FROM bets b
    LEFT JOIN accounts t ON t.puuid = b.target_puuid
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
      const bettor_puuid = bet.bettor_puuid;
      if (!bettor_puuid) {
        console.error(`[resolveBets] Pas de puuid trouvé pour bettor_user_id=${bet.bettor_user_id}, pari id=${bet.id}`);
      } else {
        await sql`
          INSERT INTO user_points (user_id, points, total_earned)
          VALUES (${bettor_puuid}, ${reward}, ${reward})
          ON CONFLICT (user_id) DO UPDATE SET
            points = user_points.points + ${reward},
            total_earned = user_points.total_earned + ${reward}
        `;
        await sql`
          INSERT INTO point_transactions (user_id, amount, reason)
          VALUES (${bettor_puuid}, ${reward}, 'bet_win')
        `;
      }
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
