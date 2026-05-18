const { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder } = require("discord.js");
const { sql } = require("../database");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("remove")
    .setDescription("Retirer un joueur (Admin)")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption(opt => opt.setName("nom").setDescription("Pseudo#Tag ou PUUID").setRequired(true).setAutocomplete(true)),
  async execute(interaction) {
    const identifiant = interaction.options.getString("nom");
    const [player] = await sql`SELECT puuid, game_name, tag_line FROM accounts WHERE puuid = ${identifiant} OR game_name = ${identifiant}`;

    if (!player) return interaction.reply({ content: `❌ Le joueur **${identifiant}** n'est pas dans la base de données.`, ephemeral: true });

    const result = await sql`
      DELETE FROM server_members
      WHERE puuid = ${player.puuid}
        AND server_id IN (SELECT id FROM servers WHERE guild_id = ${interaction.guildId})
    `;
    if (result.count === 0) return interaction.reply({ content: `❌ Le joueur **${player.game_name}#${player.tag_line}** n'est pas suivi sur ce serveur.`, ephemeral: true });

    await sql`DELETE FROM accounts WHERE puuid NOT IN (SELECT DISTINCT puuid FROM server_members)`;

    const embed = new EmbedBuilder()
      .setTitle("🗑️ Joueur retiré")
      .setColor(0xe74c3c)
      .setDescription(`**${player.game_name}#${player.tag_line}** ne sera plus surveillé sur ce serveur.`)
      .setTimestamp();

    await interaction.reply({ embeds: [embed] });
  },
};
