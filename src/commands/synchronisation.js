const { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder } = require("discord.js");
const { sql } = require("../database");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("synchronisation")
    .setDescription("Vérifier les liaisons Discord ↔ comptes LoL du serveur (Admin)")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const linked = await sql`
      SELECT COUNT(DISTINCT a.puuid)::int AS c
      FROM accounts a
      JOIN server_members sm ON sm.puuid = a.puuid
      JOIN servers s ON s.id = sm.server_id
      WHERE s.guild_id = ${interaction.guildId} AND a.user_id IS NOT NULL
    `;
    const total = await sql`
      SELECT COUNT(DISTINCT a.puuid)::int AS c
      FROM accounts a
      JOIN server_members sm ON sm.puuid = a.puuid
      JOIN servers s ON s.id = sm.server_id
      WHERE s.guild_id = ${interaction.guildId}
    `;

    const embed = new EmbedBuilder()
      .setTitle("🔄 État des liaisons")
      .setColor(0x3498db)
      .addFields(
        { name: "Comptes suivis",      value: `\`${total[0]?.c || 0}\``,  inline: true },
        { name: "Liés à Discord",      value: `\`${linked[0]?.c || 0}\``, inline: true },
        { name: "Non liés",            value: `\`${(total[0]?.c || 0) - (linked[0]?.c || 0)}\``, inline: true },
      )
      .setDescription("Pour lier un compte utilisez `/link`. Les liaisons se créent aussi via OAuth sur le site.")
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
  },
};
