const { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder } = require("discord.js");
const { sql } = require("../database");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("badge-remove")
    .setDescription("Retirer un badge manuellement à un compte LoL (Admin)")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption((opt) =>
      opt.setName("joueur").setDescription("Compte LoL (Pseudo#Tag ou PUUID)").setRequired(true).setAutocomplete(true),
    )
    .addStringOption((opt) =>
      opt.setName("badge").setDescription("Clé du badge").setRequired(true).setAutocomplete(true),
    ),
  async execute(interaction) {
    const lolUser  = interaction.options.getString("joueur");
    const badgeKey = interaction.options.getString("badge");

    const [player] = await sql`SELECT puuid, game_name, tag_line FROM accounts WHERE puuid = ${lolUser} OR game_name = ${lolUser}`;
    if (!player) return interaction.reply({ content: "❌ Compte LoL introuvable dans la base du bot.", ephemeral: true });

    const result = await sql`DELETE FROM badges WHERE entity_id = ${player.puuid} AND badge_key = ${badgeKey}`;
    if (result.count === 0) {
      return interaction.reply({
        content: `❌ **${player.game_name}#${player.tag_line}** n'a pas le badge \`${badgeKey}\`.`,
        ephemeral: true,
      });
    }

    const embed = new EmbedBuilder()
      .setTitle("🗑️ Badge retiré")
      .setColor(0xe67e22)
      .setDescription(`Le badge \`${badgeKey}\` a été retiré de **${player.game_name}#${player.tag_line}**.`)
      .setTimestamp();

    await interaction.reply({ embeds: [embed] });
  },
};
