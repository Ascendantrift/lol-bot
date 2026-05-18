const { SlashCommandBuilder, EmbedBuilder } = require("discord.js");
const { sql } = require("../database");

module.exports = {
  data: new SlashCommandBuilder().setName("list").setDescription("Voir les joueurs surveillés"),
  async execute(interaction) {
    await interaction.deferReply();
    const rows = await sql`
      SELECT a.game_name, a.tag_line, u.discord_id
      FROM accounts a
      JOIN server_members sm ON sm.puuid = a.puuid
      JOIN servers s ON s.id = sm.server_id
      LEFT JOIN users u ON u.id = a.user_id
      WHERE s.guild_id = ${interaction.guildId}
      GROUP BY a.puuid, a.game_name, a.tag_line, u.discord_id
    `;

    if (rows.length === 0) {
      return interaction.editReply("❌ Aucun joueur n'est surveillé sur ce serveur.");
    }

    const embed = new EmbedBuilder()
      .setTitle("📋 Joueurs sous surveillance")
      .setColor(0x5865f2)
      .setTimestamp();

    const userGroups = {};
    const unlinked   = [];

    for (const row of rows) {
      const accountStr = `\`${row.game_name}#${row.tag_line}\``;
      if (row.discord_id) {
        if (!userGroups[row.discord_id]) userGroups[row.discord_id] = [];
        userGroups[row.discord_id].push(accountStr);
      } else {
        unlinked.push(accountStr);
      }
    }

    for (const [discordId, accounts] of Object.entries(userGroups)) {
      try {
        const user = interaction.client.users.cache.get(discordId) || await interaction.client.users.fetch(discordId);
        embed.addFields({ name: `👤 ${user.globalName || user.username}`, value: accounts.join(" / "), inline: true });
      } catch {
        embed.addFields({ name: `👤 ID: ${discordId}`, value: accounts.join(" / "), inline: true });
      }
    }

    if (unlinked.length > 0) {
      embed.addFields({ name: "🔗 Non liés", value: unlinked.join(" / "), inline: true });
    }

    await interaction.editReply({ embeds: [embed] });
  },
};
