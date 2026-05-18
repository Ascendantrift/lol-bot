const { SlashCommandBuilder, EmbedBuilder } = require("discord.js");
const { sql } = require("../database");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("stats-server")
    .setDescription("Afficher les statistiques globales du serveur"),
  async execute(interaction) {
    const monthStr = new Date().toISOString().slice(0, 7);

    const [globalStats] = await sql`
      SELECT
        SUM(a.total_losses)::int          AS total_all_time,
        SUM(ms.losses)::int               AS total_month,
        SUM(ms.games)::int                AS games_month,
        SUM(a.total_time_spent_dead)::int AS total_dead_all_time
      FROM accounts a
      LEFT JOIN monthly_stats ms ON a.puuid = ms.puuid AND ms.month = ${monthStr}
      JOIN server_members sm ON sm.puuid = a.puuid
      JOIN servers s ON s.id = sm.server_id
      WHERE s.guild_id = ${interaction.guildId}
    `;

    const [kingOfLoss] = await sql`
      SELECT a.game_name, a.tag_line, a.max_loss_streak, u.discord_id
      FROM accounts a
      JOIN server_members sm ON sm.puuid = a.puuid
      JOIN servers s ON s.id = sm.server_id
      LEFT JOIN users u ON u.id = a.user_id
      WHERE s.guild_id = ${interaction.guildId}
      ORDER BY a.max_loss_streak DESC
      LIMIT 1
    `;

    const [totalBadges] = await sql`
      SELECT SUM(unlock_count)::int AS count FROM badges
      WHERE entity_id IN (
        SELECT DISTINCT sm.puuid FROM server_members sm
        JOIN servers s ON s.id = sm.server_id
        WHERE s.guild_id = ${interaction.guildId}
      )
    `;

    const totalAllTime   = globalStats?.total_all_time       || 0;
    const totalMonth     = globalStats?.total_month           || 0;
    const gamesMonth     = globalStats?.games_month           || 0;
    const lossRateMonth  = gamesMonth > 0 ? Math.round((totalMonth / gamesMonth) * 100) : 0;

    let kingLabel = "Personne encore...";
    if (kingOfLoss) {
      kingLabel = `${kingOfLoss.game_name}#${kingOfLoss.tag_line} (${kingOfLoss.max_loss_streak})`;
      if (kingOfLoss.discord_id) {
        try {
          const user = await interaction.client.users.fetch(kingOfLoss.discord_id);
          kingLabel = `${user.globalName || user.username} (${kingOfLoss.max_loss_streak})`;
        } catch { /* fallback */ }
      }
    }

    const totalDead = globalStats?.total_dead_all_time || 0;
    const h = Math.floor(totalDead / 3600);
    const m = Math.floor((totalDead % 3600) / 60);
    const deadStr = h > 0 ? `${h}h ${m}m` : `${m}m`;

    const embed = new EmbedBuilder()
      .setTitle("📊 Statistiques du serveur")
      .setColor(0x5865f2)
      .setThumbnail(interaction.guild.iconURL())
      .addFields(
        { name: "📉 Défaites totales",         value: `\`${totalAllTime}\``,  inline: true },
        { name: "📅 Défaites ce mois",          value: `\`${totalMonth}\``,   inline: true },
        { name: "📊 % Défaites (mois)",         value: `\`${lossRateMonth}%\` (${totalMonth}/${gamesMonth})`, inline: true },
        { name: "👑 Pire série historique",     value: kingLabel,              inline: true },
        { name: "🎖️ Badges obtenus",           value: `\`${totalBadges?.count || 0}\``, inline: true },
        { name: "💀 Temps d'écran gris",        value: `\`${deadStr}\``,       inline: true },
      )
      .setFooter({ text: "L'union fait la défaite." })
      .setTimestamp();

    await interaction.reply({ embeds: [embed] });
  },
};
