// ─── Discord embed builders ────────────────────────────────────────────────────

async function resolveDiscordLabel(client, player) {
  if (player.discord_id) {
    try {
      const user = client.users.cache.get(player.discord_id) || (await client.users.fetch(player.discord_id));
      return user.globalName || user.username;
    } catch { /* fallback */ }
  }
  return player.game_name;
}

// ─── Perte ─────────────────────────────────────────────────────────────────────

function buildLossEmbed({ discordLabel, championName, queueName, min, sec, kda, rankData, streak, unlockedBadges }) {
  let description = `🚨 [${queueName}] - **${discordLabel}** a perdu avec **${championName}** (${kda.kills}/${kda.deaths}/${kda.assists}) en **${min}:${sec}** min.`;
  if (rankData) description += ` - ${rankData.tier} ${rankData.rank} — ${rankData.lp} LP`;
  if (streak > 1) description += `\n🔥 Série de défaites : ${streak}`;

  const embed = { color: 0xe74c3c, description, timestamp: new Date().toISOString() };
  const badgeField = buildBadgeField(unlockedBadges);
  if (badgeField) embed.fields = [badgeField];
  return embed;
}

// ─── Victoire ──────────────────────────────────────────────────────────────────

function buildWinEmbed({ discordLabel, championName, queueName, min, sec, kda, rankData, streak, unlockedBadges }) {
  let description = `🏆 [${queueName}] - **${discordLabel}** a gagné avec **${championName}** (${kda.kills}/${kda.deaths}/${kda.assists}) en **${min}:${sec}** min.`;
  if (rankData) description += ` - ${rankData.tier} ${rankData.rank} — ${rankData.lp} LP`;
  if (streak > 1) description += `\n🔥 Série de victoires : ${streak}`;

  const embed = { color: 0x2ecc71, description, timestamp: new Date().toISOString() };
  const badgeField = buildBadgeField(unlockedBadges);
  if (badgeField) embed.fields = [badgeField];
  return embed;
}

// ─── Badge field ───────────────────────────────────────────────────────────────

function buildBadgeField(unlockedBadges) {
  if (!unlockedBadges.length) return null;
  const normalBadges = unlockedBadges.filter((b) => b.rank !== "Secret");
  const secretBadges = unlockedBadges.filter((b) => b.rank === "Secret");
  const lines = [
    ...normalBadges.map((b) => `🎖️ **${b.name}** *(${b.rank})* — ${b.description}`),
    ...secretBadges.map((b) => `🤫 **SECRET** — ${b.description}`),
  ];
  return { name: "Badge débloqué", value: lines.join("\n"), inline: false };
}

// ─── Preview console ───────────────────────────────────────────────────────────

function previewEmbed(embed) {
  const color = embed.color === 0xe74c3c ? "DÉFAITE" : "VICTOIRE";
  const sep = "─".repeat(60);
  const lines = [`┌─ ${color} ${"─".repeat(Math.max(0, 60 - color.length - 3))}`];
  lines.push(`│  ${embed.description.replace(/\*\*/g, "").replace(/\n/g, "\n│  ")}`);
  for (const f of embed.fields ?? []) {
    lines.push(`│  [${f.name}] ${f.value.replace(/\*\*/g, "").replace(/\n/g, " | ")}`);
  }
  lines.push(`└${sep}`);
  return lines.join("\n");
}

module.exports = { resolveDiscordLabel, buildLossEmbed, buildWinEmbed, previewEmbed };
