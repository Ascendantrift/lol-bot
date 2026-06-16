// ─── Discord embed builders ────────────────────────────────────────────────────

const { sql } = require("../database");

// Rafraîchit le hash d'avatar / pseudo Discord stocké dans `users` (utilisé par le
// site pour afficher la PP). Le site ne le mettait à jour qu'à la connexion : la PP
// devenait obsolète (404) si le joueur changeait son avatar Discord. On la resynchronise
// ici à chaque partie, sans bloquer l'envoi de l'embed si l'écriture échoue.
async function syncStoredAvatar(discordId, user) {
  try {
    await sql`
      UPDATE users
      SET avatar = ${user.avatar ?? null}, username = ${user.username ?? user.globalName ?? "user"}
      WHERE discord_id = ${discordId}
    `;
  } catch (e) {
    console.error(`[avatar] sync échoué (${discordId}): ${e.message}`);
  }
}

async function resolveDiscordIdentity(client, player) {
  if (player.discord_id) {
    try {
      const user =
        client.users.cache.get(player.discord_id) ||
        (await client.users.fetch(player.discord_id));
      await syncStoredAvatar(player.discord_id, user);
      return {
        label: user.globalName || user.username || player.game_name,
        avatarUrl: user.displayAvatarURL({ extension: "png", size: 128 }),
      };
    } catch {
      /* fallback */
    }
  }
  return { label: player.game_name, avatarUrl: null };
}

function formatMainSentence({
  discordLabel,
  verb,
  championName,
  kda,
  min,
  sec,
}) {
  return `**${discordLabel}** a ${verb} avec **${championName}** (${kda.kills}/${kda.deaths}/${kda.assists}) en **${min}:${sec}** min.`;
}

function linkedAccountLabel(player) {
  if (player.tag_line) return `${player.game_name}#${player.tag_line}`;
  return player.game_name;
}

function summonerNameOnly(player) {
  return player.game_name || linkedAccountLabel(player);
}

// Construit les fields d'un embed :
//   header : author.name = "Nom ㅤㅤ Queue • Résultat"  +  icon_url = PP
//   corps   : phrase principale + badges en pleine largeur
//   footer  : [Rank LP]  [streak]
function championThumbnail(championName) {
  return `https://cdn.communitydragon.org/latest/champion/${championName}/square`;
}

// "GOLD II — 50 LP", "MASTER — 320 LP", ou "Non classé" si pas de données.
function formatRankLine(rankData) {
  if (!rankData) return "Non classé";
  const tier = [rankData.tier, rankData.rank].filter(Boolean).join(" ");
  return rankData.lp != null ? `${tier} — ${rankData.lp} LP` : tier;
}

function buildBadgesText(unlockedBadges) {
  const lines = [];

  // 1er du serveur → ★ (priorité d'affichage la plus haute)
  const firstServer = unlockedBadges.filter((b) => b.kind === "first_server");
  if (firstServer.length > 0) {
    const labels = firstServer.map((b) => `${b.name} (${b.rank})`);
    const joined = labels.length === 1
      ? labels[0]
      : labels.slice(0, -1).join(", ") + " et " + labels.at(-1);
    lines.push(`★ **1er du serveur** — ${joined}`);
  }

  // Autres badges (1re fois / re-obtention), non-secrets → ✨
  const otherNames = unlockedBadges
    .filter((b) => b.kind !== "first_server" && b.rank !== "Secret")
    .map((b) => b.name);
  if (otherNames.length > 0) lines.push(`✨ ${otherNames.join(" · ")}`);

  // Secrets (hors 1er du serveur, déjà listés) → une ligne 🤫 par badge
  for (const b of unlockedBadges.filter((b) => b.kind !== "first_server" && b.rank === "Secret")) {
    lines.push(`🤫 ${b.name}`);
  }

  return lines.join("\n");
}

// Message de notif web pour un déblocage de badge. Le cas (1er du serveur / 1re fois /
// re-obtention) est porté par la pastille affichée par le front ; ici seul le verbe change.
function badgeUnlockMessage(playerName, badgeName, kind) {
  const verb = kind === "repeat" ? "a obtenu" : "vient de débloquer";
  return `✨ ${playerName} ${verb} le badge « ${badgeName} ».`;
}

function buildEmbedFields({ main, unlockedBadges, rankLine, streakLine }) {
  const badgesText = buildBadgesText(unlockedBadges);
  const body = badgesText ? `${main}\n${badgesText}` : main;
  const footer = streakLine ? `${rankLine} • ${streakLine}` : rankLine;

  return [
    { name: "​", value: body,   inline: false },
    { name: "​", value: footer, inline: false },
  ];
}

// ─── Perte ─────────────────────────────────────────────────────────────────────

function buildLossEmbed({
  player,
  discordIdentity,
  championName,
  queueName,
  min,
  sec,
  kda,
  rankData,
  streak,
  unlockedBadges,
}) {
  const nameOnly = summonerNameOnly(player);
  const main = formatMainSentence({
    discordLabel: nameOnly,
    verb: "perdu",
    championName,
    kda,
    min,
    sec,
  });
  const rankLine   = formatRankLine(rankData);
  const streakLine = streak >= 2 ? `${streak}❄️` : "";

  return {
    color: 0xe74c3c,
    author: { name: `${queueName}  •  Défaite🚨`, ...(discordIdentity.avatarUrl ? { icon_url: discordIdentity.avatarUrl } : {}) },
    thumbnail: { url: championThumbnail(championName) },
    fields: buildEmbedFields({ main, unlockedBadges, rankLine, streakLine }),
  };
}

// ─── Victoire ──────────────────────────────────────────────────────────────────

function buildWinEmbed({
  player,
  discordIdentity,
  championName,
  queueName,
  min,
  sec,
  kda,
  rankData,
  streak,
  unlockedBadges,
}) {
  const nameOnly = summonerNameOnly(player);
  const main = formatMainSentence({
    discordLabel: nameOnly,
    verb: "gagné",
    championName,
    kda,
    min,
    sec,
  });
  const rankLine   = formatRankLine(rankData);
  const streakLine = streak >= 2 ? `${streak}🔥` : "";

  return {
    color: 0x2ecc71,
    author: { name: `${queueName}  •  Victoire🏆`, ...(discordIdentity.avatarUrl ? { icon_url: discordIdentity.avatarUrl } : {}) },
    thumbnail: { url: championThumbnail(championName) },
    fields: buildEmbedFields({ main, unlockedBadges, rankLine, streakLine }),
  };
}

// ─── Preview console ───────────────────────────────────────────────────────────

function previewEmbed(embed) {
  const color = embed.color === 0xe74c3c ? "DÉFAITE" : "VICTOIRE";
  const sep = "─".repeat(60);
  const lines = [
    `┌─ ${color} ${"─".repeat(Math.max(0, 60 - color.length - 3))}`,
  ];
  if (embed.description) {
    lines.push(
      `│  ${embed.description.replace(/\*\*/g, "").replace(/\n/g, "\n│  ")}`,
    );
  }
  for (const f of embed.fields ?? []) {
    const val = f.value.replace(/\*\*/g, "").replace(/\n/g, " | ");
    if (val !== "​") lines.push(`│  ${val}`);
  }
  lines.push(`└${sep}`);
  return lines.join("\n");
}

module.exports = {
  resolveDiscordIdentity,
  buildLossEmbed,
  buildWinEmbed,
  previewEmbed,
  badgeUnlockMessage,
};
