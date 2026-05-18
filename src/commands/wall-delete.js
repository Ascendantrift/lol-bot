const { SlashCommandBuilder, PermissionFlagsBits } = require("discord.js");
const { sql } = require("../database");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("wall-delete")
    .setDescription("Supprimer un message du mur par son ID Discord (Admin)")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption((opt) =>
      opt.setName("id").setDescription("ID Discord du message").setRequired(true),
    ),
  async execute(interaction) {
    const msgId  = interaction.options.getString("id").replace(/^#/, "").trim();
    const result = await sql`DELETE FROM wall_messages WHERE id = ${msgId}`;

    if (result.count > 0) {
      await interaction.reply({ content: `✅ Message \`${msgId}\` supprimé du mur.`, ephemeral: true });
    } else {
      await interaction.reply({ content: `❌ Aucun message avec l'ID \`${msgId}\` trouvé dans le mur.`, ephemeral: true });
    }
  },
};
