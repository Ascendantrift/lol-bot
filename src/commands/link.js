const { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder } = require("discord.js");
const { sql } = require("../database");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("link")
    .setDescription("Lier un joueur LoL à un compte Discord (Admin)")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption(opt => opt.setName("joueur").setDescription("Joueur à lier").setRequired(true).setAutocomplete(true))
    .addUserOption(opt => opt.setName("discord").setDescription("Utilisateur Discord").setRequired(true)),
  async execute(interaction) {
    const identifiant = interaction.options.getString("joueur");
    const discordUser = interaction.options.getUser("discord");
    const [player] = await sql`SELECT puuid, game_name, tag_line FROM accounts WHERE puuid = ${identifiant} OR game_name = ${identifiant}`;

    if (!player) return interaction.reply({ content: `❌ Joueur introuvable dans le suivi : **${identifiant}**`, ephemeral: true });

    const [user] = await sql`SELECT id FROM users WHERE discord_id = ${discordUser.id}`;
    if (user) {
      await sql`UPDATE accounts SET user_id = ${user.id} WHERE puuid = ${player.puuid}`;
    } else {
      await sql`UPDATE accounts SET user_id = NULL WHERE puuid = ${player.puuid}`;
    }

    const embed = new EmbedBuilder()
      .setTitle("🔗 Liaison effectuée")
      .setColor(0x3498db)
      .setDescription(`Le compte **${player.game_name}#${player.tag_line}** est maintenant lié.`)
      .addFields({ name: "Compte Discord", value: discordUser.toString() })
      .setTimestamp();

    await interaction.reply({ embeds: [embed] });
  },
};
