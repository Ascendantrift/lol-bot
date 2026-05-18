const { SlashCommandBuilder, PermissionFlagsBits } = require("discord.js");
const { sql } = require("../database");
const { containsBotInsult } = require("../services/wallListener");

const BATCH_SIZE = 100;

module.exports = {
  data: new SlashCommandBuilder()
    .setName("wall-backfill")
    .setDescription("Importer les anciens messages du salon dans le mur (Admin)")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addIntegerOption((opt) =>
      opt.setName("limite").setDescription("Nombre max de messages à analyser (défaut 500, max 2000)")
        .setRequired(false).setMinValue(100).setMaxValue(2000),
    ),

  async execute(interaction) {
    const maxMessages = interaction.options.getInteger("limite") ?? 500;

    const [tracked] = await sql`SELECT 1 FROM servers WHERE channel_id = ${interaction.channelId} LIMIT 1`;
    if (!tracked) {
      return interaction.reply({ content: "❌ Ce salon n'est pas un salon suivi par le bot.", ephemeral: true });
    }

    await interaction.deferReply({ ephemeral: true });

    let lastId       = null;
    let totalScanned = 0;
    let totalAdded   = 0;

    while (totalScanned < maxMessages) {
      const fetchLimit = Math.min(BATCH_SIZE, maxMessages - totalScanned);
      const options    = { limit: fetchLimit };
      if (lastId) options.before = lastId;

      const batch = await interaction.channel.messages.fetch(options);
      if (batch.size === 0) break;

      for (const message of batch.values()) {
        if (message.author.bot) continue;
        if (!message.content?.trim()) continue;
        if (!containsBotInsult(message.content)) continue;

        const avatarUrl = message.author.avatar
          ? `https://cdn.discordapp.com/avatars/${message.author.id}/${message.author.avatar}.png?size=128`
          : `https://cdn.discordapp.com/embed/avatars/${Number(BigInt(message.author.id) % 5n)}.png`;

        try {
          const result = await sql`
            INSERT INTO wall_messages (id, channel_id, author_id, author_name, author_avatar, content, created_at_ms)
            VALUES (${message.id}, ${message.channelId}, ${message.author.id},
              ${message.member?.displayName || message.author.globalName || message.author.username},
              ${avatarUrl}, ${message.content.trim()}, ${message.createdTimestamp})
            ON CONFLICT (id) DO NOTHING
          `;
          if (result.count > 0) totalAdded++;
        } catch { /* doublon ou erreur ignorée */ }
      }

      totalScanned += batch.size;
      lastId        = batch.last()?.id;
      if (batch.size < fetchLimit) break;
    }

    await interaction.editReply({
      content: `✅ **${totalScanned}** messages analysés — **${totalAdded}** ajouté${totalAdded > 1 ? "s" : ""} au mur.`,
    });
  },
};
