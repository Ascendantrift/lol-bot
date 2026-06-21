const { sql } = require("../database");
const { recordNotification } = require("./notifications");
const { publish } = require("./realtime");

const BET_MULTIPLIER = 1.8;

// Points fixes par partie terminée (victoire OU défaite). Plus aucun bonus selon le
// mode du serveur — le mode ne sert qu'à décider quels matchs un serveur suit/affiche.
const FLAT_GAME_POINTS = 120;

const POINTS = {
  // Bonus de palier (s'ajoute au bonus de rang du badge)
  badge_first_player: 1000, // 1re fois que CE joueur débloque le badge
  badge_first_server: 2500, // 1er du serveur à le débloquer
  // (re-obtention : aucun bonus de palier, seulement le rang)
  // Séries de victoires
  streak_3: 50,
  streak_5: 100,
  streak_10: 1000,
};

// Bonus selon le rang/rareté du badge, présent dans les 3 cas.
function badgeRankBonus(rank) {
  const r = (rank || "").toLowerCase();
  if (r === "secret") return 100;
  if (r === "or" || r === "gold") return 75;
  if (r === "argent" || r === "silver") return 50;
  return 25; // bronze / défaut
}

// kind : "first_server" | "first_player" | "repeat"
function badgeAmount(kind, rank) {
  const bonus = badgeRankBonus(rank);
  if (kind === "first_server") return POINTS.badge_first_server + bonus;
  if (kind === "first_player") return POINTS.badge_first_player + bonus;
  return bonus; // re-obtention : rang seul
}

// Crédite `amount` et, si l'écriture réussit, pousse la ligne dans `breakdown`.
// En cas d'échec DB on LOG (au lieu d'avaler en silence) et on N'AJOUTE PAS la ligne :
// ainsi le breakdown renvoyé reflète exactement ce qui a été réellement crédité.
async function creditOrSkip(puuid, amount, reason, serverId, label, breakdown, matchId = null) {
  try {
    await addPoints(puuid, amount, reason, serverId, matchId);
    breakdown.push({ label, amount });
  } catch (e) {
    console.error(`[points] échec crédit ${reason} +${amount} (srv ${serverId}, ${puuid}): ${e.message}`);
  }
}

async function resolveUserId(puuid) {
  const [row] =
    await sql`SELECT user_id FROM accounts WHERE puuid = ${puuid} AND user_id IS NOT NULL LIMIT 1`;
  return row?.user_id ?? null;
}

async function addPoints(puuid, amount, reason, serverId, matchId = null) {
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
    INSERT INTO point_transactions (user_id, server_id, amount, reason, match_id)
    VALUES (${userId}, ${serverId}, ${amount}, ${reason}, ${matchId})
  `;
}

async function getUserPoints(puuid, serverId) {
  const userId = await resolveUserId(puuid);
  if (!userId) return { points: 0, total_earned: 0 };
  const [row] =
    await sql`SELECT points, total_earned FROM user_points WHERE user_id = ${userId} AND server_id = ${serverId}`;
  return row ?? { points: 0, total_earned: 0 };
}

// Vrai si ce match a déjà donné lieu à un crédit de partie (win/loss) pour ce
// joueur sur ce serveur → garde-fou anti double-crédit en cas de retraitement.
async function gameAlreadyCredited(userId, serverId, matchId) {
  if (!matchId || !userId) return false;
  const [row] = await sql`
    SELECT 1 FROM point_transactions
    WHERE user_id = ${userId} AND server_id = ${serverId}
      AND match_id = ${matchId} AND reason IN ('win', 'loss')
    LIMIT 1
  `;
  return !!row;
}

// Crédite une victoire (120 fixes + éventuelle série) et RENVOIE le détail
// réellement écrit en DB. Le breakdown sert tel quel à la notif → ce qui est affiché
// = ce qui est gagné. Une ligne qui échoue à s'écrire n'apparaît pas dans le retour.
async function awardWin(puuid, winStreak, serverId, matchId = null) {
  const breakdown = [];
  const userId = await resolveUserId(puuid);
  if (await gameAlreadyCredited(userId, serverId, matchId)) {
    console.log(`[points] match ${matchId} déjà crédité (srv ${serverId}, user ${userId}) — saut.`);
    return breakdown;
  }
  await creditOrSkip(puuid, FLAT_GAME_POINTS, "win", serverId, "Victoire", breakdown, matchId);

  let streakPts = 0;
  if (winStreak >= 10) streakPts = POINTS.streak_10;
  else if (winStreak >= 5) streakPts = POINTS.streak_5;
  else if (winStreak >= 3) streakPts = POINTS.streak_3;
  if (streakPts > 0) {
    await creditOrSkip(puuid, streakPts, "streak", serverId, `Série de ${winStreak} victoires`, breakdown, matchId);
  }
  return breakdown;
}

// Crédite une défaite (120 fixes) et RENVOIE le détail réellement écrit en DB.
async function awardLoss(puuid, serverId, matchId = null) {
  const breakdown = [];
  const userId = await resolveUserId(puuid);
  if (await gameAlreadyCredited(userId, serverId, matchId)) {
    console.log(`[points] match ${matchId} déjà crédité (srv ${serverId}, user ${userId}) — saut.`);
    return breakdown;
  }
  await creditOrSkip(puuid, FLAT_GAME_POINTS, "loss", serverId, "Défaite", breakdown, matchId);
  return breakdown;
}

// Crédite les points d'un badge. RENVOIE le montant réellement crédité, ou null si
// l'écriture a échoué (afin de ne pas l'afficher comme gagné dans la notif).
// L'idempotence des badges est déjà assurée en amont par la table `badges`
// (awardBadge n'est appelé que sur un déblocage neuf) ; on enregistre quand même
// le match_id pour la traçabilité.
async function awardBadge(puuid, kind, rank, serverId, matchId = null) {
  const amount = badgeAmount(kind, rank);
  try {
    await addPoints(puuid, amount, `badge_${kind}`, serverId, matchId);
    return amount;
  } catch (e) {
    console.error(`[points] échec crédit badge ${kind} (srv ${serverId}, ${puuid}): ${e.message}`);
    return null;
  }
}

// Libellés humains des paris (miroir de lib/betProps.ts côté front) pour les notifs.
const BET_LABELS = {
  win: "Victoire", loss: "Défaite",
  kills_5: "≥ 5 kills", kills_10: "≥ 10 kills", kills_15: "≥ 15 kills",
  deaths_u2: "≤ 2 morts", deaths_u5: "≤ 5 morts",
  assists_10: "≥ 10 assists", assists_20: "≥ 20 assists",
  kda_3: "KDA ≥ 3", kda_5: "KDA ≥ 5",
  cs_150: "≥ 150 CS", cs_250: "≥ 250 CS",
  first_blood: "First Blood", multi_2: "Double kill +", penta: "Pentakill",
};
function betLabel(betType) {
  return BET_LABELS[betType] || betType || "pari";
}

// gameId numérique à partir du matchId Riot ("EUW1_123" → "123").
function gameIdFromMatchId(matchId) {
  const s = String(matchId);
  const i = s.indexOf("_");
  return i >= 0 ? s.slice(i + 1) : s;
}

// Évalue la condition générique (stat/comparator/line) d'un pari contre les
// stats finales du joueur. null = condition inconnue (on n'y touche pas).
function betWon(bet, stats) {
  let actual;
  switch (bet.stat) {
    case "win":         actual = stats.win ? 1 : 0; break;
    case "kills":       actual = stats.kills; break;
    case "deaths":      actual = stats.deaths; break;
    case "assists":     actual = stats.assists; break;
    case "kda":         actual = stats.deaths === 0 ? (stats.kills + stats.assists) : (stats.kills + stats.assists) / stats.deaths; break;
    case "cs":          actual = stats.cs; break;
    case "first_blood": actual = stats.firstBlood ? 1 : 0; break;
    case "multikill":   actual = stats.largestMultiKill; break;
    default:            return null;
  }
  const line = Number(bet.line);
  if (bet.comparator === "gte") return actual >= line;
  if (bet.comparator === "lte") return actual <= line;
  if (bet.comparator === "is")  return actual === line;
  return null;
}

// Résout les paris LIVE d'un joueur pour UNE partie précise (match_id = gameId).
async function resolveBets(puuid, matchId, stats) {
  const gid = gameIdFromMatchId(matchId);
  const pending = await sql`
    SELECT
      b.id, b.bettor_user_id, b.bet_type, b.stat, b.comparator, b.line, b.multiplier,
      b.amount, b.server_id, b.target_puuid, b.created_at,
      t.game_name AS target_name,
      (SELECT a.puuid FROM accounts a WHERE a.user_id::text = b.bettor_user_id ORDER BY a.puuid LIMIT 1) AS bettor_puuid
    FROM bets b
    LEFT JOIN accounts t ON t.puuid = b.target_puuid
    WHERE b.target_puuid = ${puuid} AND b.match_id = ${gid} AND b.status = 'pending'
  `;
  if (pending.length === 0) return;

  console.log(`[resolveBets] ${pending.length} pari(s) à résoudre pour puuid=${puuid} match=${gid}`);
  const now = Date.now();

  for (const bet of pending) {
    const outcome = betWon(bet, stats);
    if (outcome === null) continue; // condition inconnue → laissé en attente
    const won = outcome;
    const status = won ? "won" : "lost";
    const mult = Number(bet.multiplier) || BET_MULTIPLIER;
    const reward = won ? Math.floor(bet.amount * mult) : 0;
    const label = betLabel(bet.bet_type);
    const targetName = bet.target_name || "ce joueur";

    await sql`UPDATE bets SET status = ${status}, resolved_at = ${now} WHERE id = ${bet.id}`;

    await publish(`bets:user:${bet.bettor_user_id}`, {
      id: bet.id,
      bettorUserId: bet.bettor_user_id,
      targetPuuid: bet.target_puuid,
      targetName: bet.target_name ?? null,
      betType: bet.bet_type,
      amount: bet.amount,
      multiplier: mult,
      status,
      reward,
      createdAt: bet.created_at,
      resolvedAt: now,
    });

    if (won) {
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
      console.log(`[resolveBets] Pari #${bet.id} (${label}) GAGNÉ — +${reward} pts (server ${bet.server_id})`);
    } else {
      console.log(`[resolveBets] Pari #${bet.id} (${label}) PERDU — ${bet.amount} pts perdus`);
    }

    await recordNotification({
      ts: now,
      kind: won ? "bet_won" : "bet_lost",
      accountPuuid: bet.bettor_puuid ?? null,
      serverId: bet.server_id,
      message: won
        ? `🎲 Pari gagné sur ${targetName} (${label}) — +${reward} pts`
        : `🎲 Pari perdu sur ${targetName} (${label}) — ${bet.amount} pts perdus`,
      details: {
        betId: bet.id,
        targetName,
        betType: bet.bet_type,
        amount: bet.amount,
        ...(won ? { reward } : {}),
      },
    });
  }
}

// Récupère un puuid du parieur (pour la notif). Null si aucun compte.
async function bettorPuuid(bettorUserId) {
  const [row] = await sql`SELECT a.puuid FROM accounts a WHERE a.user_id::text = ${bettorUserId} ORDER BY a.puuid LIMIT 1`;
  return row?.puuid ?? null;
}

// Résout les JAMBES de combinés portant sur cette partie, puis liquide les
// combinés impactés : perdu dès qu'une jambe perd, gagné quand toutes gagnent.
async function resolveCombos(puuid, matchId, stats) {
  const gid = gameIdFromMatchId(matchId);
  const legs = await sql`
    SELECT id, combo_id, stat, comparator, line FROM bet_combo_legs
    WHERE target_puuid = ${puuid} AND match_id = ${gid} AND status = 'pending'
  `;
  if (legs.length === 0) return;

  const affected = new Set();
  for (const leg of legs) {
    const won = betWon({ stat: leg.stat, comparator: leg.comparator, line: leg.line }, stats);
    if (won === null) continue;
    await sql`UPDATE bet_combo_legs SET status = ${won ? "won" : "lost"} WHERE id = ${leg.id}`;
    affected.add(leg.combo_id);
  }

  const now = Date.now();
  for (const comboId of affected) {
    const [combo] = await sql`SELECT id, bettor_user_id, server_id, amount, multiplier, status FROM bet_combos WHERE id = ${comboId}`;
    if (!combo || combo.status !== "pending") continue;
    const legRows = await sql`SELECT status FROM bet_combo_legs WHERE combo_id = ${comboId}`;
    const anyLost = legRows.some((l) => l.status === "lost");
    const anyPending = legRows.some((l) => l.status === "pending");
    const bp = await bettorPuuid(combo.bettor_user_id);

    if (anyLost) {
      await sql`UPDATE bet_combos SET status = 'lost', resolved_at = ${now} WHERE id = ${comboId}`;
      await publish(`bets:user:${combo.bettor_user_id}`, { comboId, status: "lost", amount: combo.amount, resolvedAt: now });
      await recordNotification({ ts: now, kind: "bet_lost", accountPuuid: bp, serverId: combo.server_id, message: `🎲 Combiné perdu — ${combo.amount} pts perdus`, details: { comboId, amount: combo.amount } });
      console.log(`[resolveCombos] Combiné #${comboId} PERDU — ${combo.amount} pts`);
    } else if (!anyPending) {
      const reward = Math.floor(combo.amount * Number(combo.multiplier));
      const userId = parseInt(combo.bettor_user_id, 10);
      if (userId) {
        await sql`
          INSERT INTO user_points (user_id, server_id, points, total_earned)
          VALUES (${userId}, ${combo.server_id}, ${reward}, ${reward})
          ON CONFLICT (user_id, server_id) DO UPDATE SET
            points = user_points.points + ${reward}, total_earned = user_points.total_earned + ${reward}
        `;
        await sql`INSERT INTO point_transactions (user_id, server_id, amount, reason) VALUES (${userId}, ${combo.server_id}, ${reward}, 'bet_win')`;
      }
      await sql`UPDATE bet_combos SET status = 'won', resolved_at = ${now} WHERE id = ${comboId}`;
      await publish(`bets:user:${combo.bettor_user_id}`, { comboId, status: "won", amount: combo.amount, reward, resolvedAt: now });
      await recordNotification({ ts: now, kind: "bet_won", accountPuuid: bp, serverId: combo.server_id, message: `🎲 Combiné GAGNÉ ×${combo.multiplier} — +${reward} pts`, details: { comboId, amount: combo.amount, reward } });
      console.log(`[resolveCombos] Combiné #${comboId} GAGNÉ — +${reward} pts`);
    }
  }
}

// Filet de sécurité : un pari dont la partie n'a jamais été traitée (mode non
// suivi, match manqué…) resterait "pending" à l'infini, mise bloquée. Au-delà de
// 3h (bien plus que la durée max d'une game), on annule et on REMBOURSE la mise.
const STALE_BET_MS = 3 * 60 * 60 * 1000;

async function refundPoints(userId, serverId, amount) {
  if (!userId) return;
  await sql`
    INSERT INTO user_points (user_id, server_id, points, total_earned)
    VALUES (${userId}, ${serverId}, ${amount}, 0)
    ON CONFLICT (user_id, server_id) DO UPDATE SET points = user_points.points + ${amount}
  `;
  await sql`INSERT INTO point_transactions (user_id, server_id, amount, reason) VALUES (${userId}, ${serverId}, ${amount}, 'bet_refund')`;
}

async function expireStaleBets() {
  const cutoff = Date.now() - STALE_BET_MS;
  const now = Date.now();

  const stale = await sql`SELECT id, bettor_user_id, server_id, amount FROM bets WHERE status = 'pending' AND created_at < ${cutoff}`;
  for (const bet of stale) {
    await sql`UPDATE bets SET status = 'cancelled', resolved_at = ${now} WHERE id = ${bet.id}`;
    await refundPoints(parseInt(bet.bettor_user_id, 10), bet.server_id, bet.amount);
    await publish(`bets:user:${bet.bettor_user_id}`, { id: bet.id, bettorUserId: bet.bettor_user_id, status: "cancelled", amount: bet.amount, reward: bet.amount, resolvedAt: now });
    console.log(`[expireBets] Pari #${bet.id} non résolu (>3h) → remboursé ${bet.amount} pts`);
  }
  if (stale.length) console.log(`[expireBets] ${stale.length} pari(s) simple(s) remboursé(s).`);

  const staleCombos = await sql`SELECT id, bettor_user_id, server_id, amount FROM bet_combos WHERE status = 'pending' AND created_at < ${cutoff}`;
  for (const c of staleCombos) {
    await sql`UPDATE bet_combos SET status = 'cancelled', resolved_at = ${now} WHERE id = ${c.id}`;
    await refundPoints(parseInt(c.bettor_user_id, 10), c.server_id, c.amount);
    await publish(`bets:user:${c.bettor_user_id}`, { comboId: c.id, status: "cancelled", amount: c.amount, reward: c.amount, resolvedAt: now });
    console.log(`[expireBets] Combiné #${c.id} non résolu (>3h) → remboursé ${c.amount} pts`);
  }
  if (staleCombos.length) console.log(`[expireBets] ${staleCombos.length} combiné(s) remboursé(s).`);
}

module.exports = {
  addPoints,
  getUserPoints,
  awardWin,
  awardLoss,
  awardBadge,
  resolveBets,
  resolveCombos,
  expireStaleBets,
};
