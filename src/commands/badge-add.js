const { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder } = require("discord.js");
const { sql } = require("../database");
const { registerBadgeUnlock } = require("../services/matchChecker");
const { BADGES } = require("../../badges");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("badge-add")
    .setDescription("Donner un badge manuellement à un compte LoL (Admin)")
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

    const badge = BADGES.find((b) => b.key === badgeKey);
    if (!badge) return interaction.reply({ content: `❌ Le badge **${badgeKey}** n'existe pas.`, ephemeral: true });

    const [player] = await sql`SELECT puuid, game_name, tag_line FROM accounts WHERE puuid = ${lolUser} OR game_name = ${lolUser}`;
    if (!player) return interaction.reply({ content: "❌ Compte LoL introuvable dans la base du bot.", ephemeral: true });

    const unlock = await registerBadgeUnlock(player.puuid, badge);

    const embed = new EmbedBuilder()
      .setTitle("🎖️ Badge attribué")
      .setColor(0x2ecc71)
      .setDescription(`Le badge **${badge.name}** a été ajouté avec succès à **${player.game_name}#${player.tag_line}**.`)
      .addFields({ name: "Total possédé par ce compte", value: `\`x${unlock.unlockCount}\``, inline: true })
      .setTimestamp();

    await interaction.reply({ embeds: [embed] });
  },
};
