// ─── Discord embed builders ────────────────────────────────────────────────────

async function resolveDiscordIdentity(client, player) {
  if (player.discord_id) {
    try {
      const user =
        client.users.cache.get(player.discord_id) ||
        (await client.users.fetch(player.discord_id));
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

function buildBadgesText(unlockedBadges) {
  const lines = [];

  // Badges en 1er sur le serveur → une seule ligne ✨ avec "et"
  const firstServer = unlockedBadges.filter((b) => b.isFirstOnServer);
  if (firstServer.length > 0) {
    const labels = firstServer.map((b) => `${b.name} (${b.rank})`);
    const joined = labels.length === 1
      ? labels[0]
      : labels.slice(0, -1).join(", ") + " et " + labels.at(-1);
    lines.push(`✨ **1er** à débloquer — ${joined}`);
  }

  // Badges réguliers non-secrets → ligne 🎖️
  const regularNames = unlockedBadges
    .filter((b) => !b.isFirstOnServer && b.rank !== "Secret")
    .map((b) => b.name);
  if (regularNames.length > 0) lines.push(`🎖️ ${regularNames.join(" · ")}`);

  // Badges réguliers secrets → une ligne 🤫 par badge
  for (const b of unlockedBadges.filter((b) => !b.isFirstOnServer && b.rank === "Secret")) {
    lines.push(`🤫 ${b.name}`);
  }

  return lines.join("\n");
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
  const rankLine   = rankData ? `${rankData.tier} ${rankData.rank} — ${rankData.lp} LP` : "Non classé";
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
  const rankLine   = rankData ? `${rankData.tier} ${rankData.rank} — ${rankData.lp} LP` : "Non classé";
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
};
