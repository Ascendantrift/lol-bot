const { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder } = require("discord.js");
const { sql } = require("../database");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("clear")
    .setDescription("Supprimer tous les joueurs suivis dans ce serveur (Admin)")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  async execute(interaction) {
    const result = await sql`
      DELETE FROM server_members
      WHERE server_id IN (SELECT id FROM servers WHERE guild_id = ${interaction.guildId})
    `;
    await sql`DELETE FROM accounts WHERE puuid NOT IN (SELECT DISTINCT puuid FROM server_members)`;

    if (result.count > 0) {
      const embed = new EmbedBuilder()
        .setTitle("🗑️ Surveillance réinitialisée")
        .setColor(0xffa500)
        .setDescription(`**${result.count}** joueur(s) ont été retirés de la surveillance sur ce serveur.`)
        .setTimestamp();
      await interaction.reply({ embeds: [embed] });
    } else {
      await interaction.reply({ content: "❌ Aucun joueur n'est suivi sur ce serveur.", ephemeral: true });
    }
  },
};
