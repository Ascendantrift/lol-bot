const { sql } = require("../database");

// Escalade par utilisateur : Map<userId, { count, lastTs }>
const tracker  = new Map();
const WINDOW_MS = 10 * 60 * 1000;

function escalate(userId) {
  const now   = Date.now();
  const entry = tracker.get(userId);
  if (!entry || now - entry.lastTs > WINDOW_MS) {
    tracker.set(userId, { count: 1, lastTs: now });
    return 1;
  }
  const count = Math.min(entry.count + 1, 3);
  tracker.set(userId, { count, lastTs: now });
  return count;
}

async function getStats(discordUserId, guildId) {
  const [account] = await sql`
    SELECT a.puuid, a.game_name, a.total_losses, a.loss_streak, a.max_loss_streak, a.last_tier_solo
    FROM accounts a
    JOIN users u ON u.id = a.user_id
    JOIN server_members sm ON sm.puuid = a.puuid
    JOIN servers sv ON sv.id = sm.server_id
    WHERE sv.guild_id = ${guildId} AND u.discord_id = ${discordUserId}
    LIMIT 1
  `;
  if (!account) return null;

  const [worstGame] = await sql`
    SELECT champion_name, kills, deaths, assists, played_at
    FROM match_history
    WHERE puuid = ${account.puuid} AND win = false AND deaths > 0
    ORDER BY deaths DESC
    LIMIT 1
  `;
  const [worstChamp] = await sql`
    SELECT champion_name, COUNT(*)::int AS cnt
    FROM match_history
    WHERE puuid = ${account.puuid} AND win = false
    GROUP BY champion_name
    ORDER BY cnt DESC
    LIMIT 1
  `;
  const [firstMatch] = await sql`
    SELECT played_at FROM match_history WHERE puuid = ${account.puuid} ORDER BY played_at ASC LIMIT 1
  `;

  const monthsTracked = firstMatch
    ? Math.max(1, Math.round((Date.now() - new Date(firstMatch.played_at).getTime()) / (30 * 24 * 3_600_000)))
    : null;

  return {
    name: account.game_name,
    totalLosses:   account.total_losses    || 0,
    lossStreak:    account.loss_streak     || 0,
    maxLossStreak: account.max_loss_streak || 0,
    tier:          account.last_tier_solo,
    worstGame,
    worstChamp,
    monthsTracked,
  };
}

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function kda(g)     { return `${g.kills}/${g.deaths}/${g.assists}`; }

function timeSince(dateStr) {
  const days = Math.floor((Date.now() - new Date(dateStr).getTime()) / 86_400_000);
  if (days === 0) return "aujourd'hui";
  if (days === 1) return "hier";
  if (days < 7)  return `il y a ${days} jours`;
  if (days < 30) return `il y a ${Math.floor(days / 7)} semaine${days >= 14 ? "s" : ""}`;
  return `il y a ${Math.floor(days / 30)} mois`;
}

const TIER = {
  IRON: "Fer", BRONZE: "Bronze", SILVER: "Argent", GOLD: "Or",
  PLATINUM: "Platine", EMERALD: "Émeraude", DIAMOND: "Diamant",
  MASTER: "Master", GRANDMASTER: "Grandmaster", CHALLENGER: "Challenger",
};
function tierLabel(raw) {
  if (!raw) return null;
  const key = raw.split(" ")[0]?.toUpperCase();
  return TIER[key] ?? raw;
}

function buildResponse(level, stats) {
  if (!stats) {
    return pick([
      "T'as même pas de compte lié. Insulte anonyme c'est courageux.",
      "Je te connais pas. `/link` ton compte et on en reparle.",
      "Sans compte lié t'es juste un fantôme qui crie dans le vide.",
    ]);
  }

  const { name, totalLosses, lossStreak, maxLossStreak, worstGame, worstChamp, monthsTracked } = stats;
  const tier = tierLabel(stats.tier);

  if (level === 1) {
    return pick([
      monthsTracked
        ? `J'ai des données sur toi depuis ${monthsTracked} mois, ${name}. Tu veux vraiment que je commence ?`
        : `J'ai tes données ${name}. Tu veux vraiment que je commence ?`,
      worstGame
        ? `T'insultes le bot qui track tes ${kda(worstGame)} sur ${worstGame.champion_name}. Logique.`
        : `T'insultes le bot qui compte tes ${totalLosses} défaites. Logique.`,
      tier
        ? `${name} ${tier} qui insulte le bot. J'ai vu plus glorieux.`
        : `Intéressant comme stratégie d'insulter quelqu'un qui a accès à tes stats.`,
    ]);
  }

  if (level === 2) {
    const pool = [];
    if (lossStreak >= 3)       pool.push(`${name} t'es en série de ${lossStreak} défaites là. Peut-être rage-quit le bot en priorité ?`);
    if (maxLossStreak >= 5)    pool.push(`Ta pire série : ${maxLossStreak} défaites d'affilée. La mémoire collective ne pardonne pas.`);
    if (worstGame)             pool.push(`${kda(worstGame)} sur ${worstGame.champion_name} ${timeSince(worstGame.played_at)}. C'est dans la base. Pour toujours.`);
    if (worstChamp?.cnt >= 3)  pool.push(`${worstChamp.cnt} défaites sur ${worstChamp.champion_name}. Là où tu te sens visiblement à l'aise.`);
    pool.push(`${totalLosses} défaites trackées et t'insultes encore le bot. Respect de la constance au moins.`);
    return pick(pool);
  }

  const parts = [];
  if (worstGame)        parts.push(`${kda(worstGame)} sur ${worstGame.champion_name}`);
  if (lossStreak >= 2)  parts.push(`${lossStreak} défaites de suite`);
  if (tier)             parts.push(`${tier} en ranked`);

  if (parts.length >= 2) return `Ok ${name} : ${parts.join(", ")}. T'as fini ? Parce que moi j'ai encore des pages.`;
  return `${name}, à un moment faut accepter que le bot en sache plus sur toi que toi-même.`;
}

async function getInsultResponse(discordUserId, guildId) {
  const level = escalate(discordUserId);
  const stats = await getStats(discordUserId, guildId);
  return buildResponse(level, stats);
}

module.exports = { getInsultResponse };
