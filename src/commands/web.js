const { SlashCommandBuilder } = require("discord.js");

const SITE_URL = process.env.SITE_URL || "https://lolbot.anetmo.com";

module.exports = {
  data: new SlashCommandBuilder()
    .setName("web")
    .setDescription("Accéder au site de stats"),
  async execute(interaction) {
    await interaction.reply({
      content: `🌐 **Retrouve toutes les stats ici :**\n${SITE_URL}`,
      ephemeral: true,
    });
  },
};
