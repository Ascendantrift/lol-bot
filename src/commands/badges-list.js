const { SlashCommandBuilder, EmbedBuilder } = require("discord.js");
const { BADGES } = require("../../badges");
const { sql } = require("../database");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("badges-list")
    .setDescription("Voir la liste des badges disponibles"),
  async execute(interaction) {
    await interaction.deferReply();

    const ranks      = ["Bronze", "Argent", "Or", "Platine"];
    const rankEmojis = { Bronze: "🥉", Argent: "🥈", Or: "🥇", Platine: "💎" };
    const rankColors = { Bronze: 0xcd7f32, Argent: 0xc0c0c0, Or: 0xffd700, Platine: 0x00ffff };

    const unlockedRows = await sql`SELECT DISTINCT badge_key FROM badges`;
    // kept for potential future use (highlight unlocked badges)
    void unlockedRows;

    const embeds = [];

    ranks.forEach((rank) => {
      const rankBadges = BADGES.filter((b) => b.rank === rank);
      if (!rankBadges.length) return;

      const emoji = rankEmojis[rank] || "🌟";
      let currentEmbed = new EmbedBuilder()
        .setTitle(`${emoji} Rang ${rank} ${emoji}`)
        .setColor(rankColors[rank] || 0xffffff);

      rankBadges.forEach((badge, index) => {
        if (index > 0 && index % 25 === 0) {
          embeds.push(currentEmbed);
          currentEmbed = new EmbedBuilder()
            .setTitle(`${emoji} Rang ${rank} (Suite) ${emoji}`)
            .setColor(rankColors[rank] || 0xffffff);
        }
        currentEmbed.addFields({
          name: badge.name,
          value: `*${badge.description}*\n${badge.repeatable ? "🔄 Répétable" : "🔒 Unique"}`,
          inline: true,
        });
      });

      embeds.push(currentEmbed);
    });

    for (let i = 0; i < embeds.length; i += 10) {
      const chunk = embeds.slice(i, i + 10);
      if (i === 0) await interaction.editReply({ embeds: chunk });
      else         await interaction.followUp({ embeds: chunk });
    }
  },
};
