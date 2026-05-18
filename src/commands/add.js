const { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder } = require("discord.js");
const axios = require("axios");
const { sql } = require("../database");
const { RIOT_API_KEY } = require("../services/riot");
const { glyphForPuuid } = require("../accountGlyph");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("add")
    .setDescription("Ajouter un joueur (Admin)")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption(opt => opt.setName("nom").setDescription("Pseudo").setRequired(true))
    .addStringOption(opt => opt.setName("tag").setDescription("Tag").setRequired(true))
    .addUserOption(opt => opt.setName("discord").setDescription("Compte Discord à lier (optionnel)").setRequired(false)),
  async execute(interaction) {
    await interaction.deferReply();
    const nom         = interaction.options.getString("nom");
    const tag         = interaction.options.getString("tag");
    const discordUser = interaction.options.getUser("discord");

    try {
      const accRes = await axios.get(
        `https://europe.api.riotgames.com/riot/account/v1/accounts/by-riot-id/${nom}/${tag}`,
        { headers: { "X-Riot-Token": RIOT_API_KEY } },
      );
      const { puuid, gameName, tagLine } = accRes.data;

      const g = glyphForPuuid(puuid);
      await sql`
        INSERT INTO accounts (puuid, game_name, tag_line, glyph)
        VALUES (${puuid}, ${gameName}, ${tagLine}, ${g})
        ON CONFLICT (puuid) DO UPDATE SET glyph = COALESCE(NULLIF(TRIM(accounts.glyph), ''), ${g})
      `;

      if (discordUser) {
        const [user] = await sql`SELECT id FROM users WHERE discord_id = ${discordUser.id}`;
        if (user) await sql`UPDATE accounts SET user_id = ${user.id} WHERE puuid = ${puuid}`;
      }

      // Upsert du serveur (guild + salon courant)
      await sql`
        INSERT INTO servers (name, guild_id, channel_id, created_at)
        VALUES (${`Serveur ${interaction.guildId}`}, ${interaction.guildId}, ${interaction.channelId}, ${Date.now()})
        ON CONFLICT (guild_id, channel_id) DO UPDATE SET name = EXCLUDED.name
      `;
      const [server] = await sql`SELECT id FROM servers WHERE guild_id = ${interaction.guildId} AND channel_id = ${interaction.channelId}`;
      await sql`INSERT INTO server_members (server_id, puuid) VALUES (${server.id}, ${puuid}) ON CONFLICT DO NOTHING`;

      const embed = new EmbedBuilder()
        .setTitle("✅ Joueur ajouté")
        .setColor(0x00ff00)
        .setDescription(`Le compte **${gameName}#${tagLine}** est maintenant sous surveillance.`)
        .addFields({ name: "Lien Discord", value: discordUser ? `${discordUser}` : "Aucun", inline: true })
        .setTimestamp();

      await interaction.editReply({ embeds: [embed] });
    } catch (e) {
      await interaction.editReply({ content: "❌ Impossible de trouver ce compte Riot. Vérifiez le pseudo et le tag.", ephemeral: true });
    }
  },
};
