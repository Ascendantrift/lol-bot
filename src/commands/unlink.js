const { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder } = require("discord.js");
const { sql } = require("../database");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("unlink")
    .setDescription("Délier un joueur LoL de son compte Discord (Admin)")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption(opt => opt.setName("joueur").setDescription("Joueur à délier").setRequired(true).setAutocomplete(true)),
  async execute(interaction) {
    const identifiant = interaction.options.getString("joueur");
    const [player] = await sql`
      SELECT a.puuid, a.game_name, a.tag_line, u.discord_id
      FROM accounts a
      LEFT JOIN users u ON u.id = a.user_id
      WHERE a.puuid = ${identifiant} OR a.game_name = ${identifiant}
    `;

    if (!player) return interaction.reply({ content: `❌ Joueur introuvable dans le suivi : **${identifiant}**`, ephemeral: true });
    if (!player.discord_id) return interaction.reply({ content: `❌ Le joueur **${player.game_name}#${player.tag_line}** n'est lié à aucun compte Discord.`, ephemeral: true });

    const oldDiscordId = player.discord_id;
    await sql`UPDATE accounts SET user_id = NULL WHERE puuid = ${player.puuid}`;

    const embed = new EmbedBuilder()
      .setTitle("🔓 Liaison rompue")
      .setColor(0xe67e22)
      .setDescription(`Le compte **${player.game_name}#${player.tag_line}** a été délié.`)
      .addFields({ name: "Ancien lien", value: `<@${oldDiscordId}>` })
      .setTimestamp();

    await interaction.reply({ embeds: [embed] });
  },
};
