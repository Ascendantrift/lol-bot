const { SlashCommandBuilder, EmbedBuilder } = require("discord.js");
const { sql } = require("../database");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("stats")
    .setDescription("Afficher les statistiques globales")
    .addSubcommand((sub) =>
      sub.setName("discord").setDescription("Statistiques d'un utilisateur Discord")
        .addUserOption((opt) => opt.setName("utilisateur").setDescription("Utilisateur Discord").setRequired(true)),
    )
    .addSubcommand((sub) =>
      sub.setName("lol").setDescription("Statistiques d'un compte LoL")
        .addStringOption((opt) => opt.setName("joueur").setDescription("Compte LoL").setRequired(true).setAutocomplete(true)),
    ),
  async execute(interaction) {
    const subcommand = interaction.options.getSubcommand();
    const monthStr   = new Date().toISOString().slice(0, 7);

    let title = "", totalLosses = 0, maxStreak = 0, currentStreak = 0;
    let monthlyLosses = 0, monthlyGames = 0, badgesCount = 0, totalTimeDead = 0, thumbnail = null;

    if (subcommand === "discord") {
      const discordUser = interaction.options.getUser("utilisateur");
      title     = `Statistiques de ${discordUser.displayName || discordUser.username}`;
      thumbnail = discordUser.displayAvatarURL();

      const [isTracked] = await sql`
        SELECT 1 FROM accounts a
        JOIN users u ON u.id = a.user_id
        JOIN server_members sm ON sm.puuid = a.puuid
        JOIN servers s ON s.id = sm.server_id
        WHERE u.discord_id = ${discordUser.id} AND s.guild_id = ${interaction.guildId}
      `;
      if (!isTracked) return interaction.reply({ content: "❌ Cet utilisateur n'est lié à aucun compte LoL surveillé sur ce serveur.", ephemeral: true });

      const [stats] = await sql`
        SELECT
          SUM(total_losses)::int         AS t_losses,
          MAX(max_loss_streak)::int      AS m_streak,
          SUM(loss_streak)::int          AS c_streak,
          SUM(total_time_spent_dead)::int AS t_time
        FROM accounts
        WHERE user_id = (SELECT id FROM users WHERE discord_id = ${discordUser.id})
      `;
      const [mStats] = await sql`
        SELECT SUM(ms.losses)::int AS m_losses, SUM(ms.games)::int AS m_games
        FROM monthly_stats ms
        JOIN accounts a ON a.puuid = ms.puuid
        WHERE a.user_id = (SELECT id FROM users WHERE discord_id = ${discordUser.id}) AND ms.month = ${monthStr}
      `;
      const [bStats] = await sql`
        SELECT SUM(unlock_count)::int AS b_count FROM badges
        WHERE entity_id IN (SELECT puuid FROM accounts WHERE user_id = (SELECT id FROM users WHERE discord_id = ${discordUser.id}))
      `;

      totalLosses   = stats?.t_losses    || 0;
      maxStreak     = stats?.m_streak    || 0;
      currentStreak = stats?.c_streak    || 0;
      monthlyLosses = mStats?.m_losses   || 0;
      monthlyGames  = mStats?.m_games    || 0;
      badgesCount   = bStats?.b_count    || 0;
      totalTimeDead = stats?.t_time      || 0;

    } else {
      const lolUser  = interaction.options.getString("joueur");
      const [player] = await sql`
        SELECT a.*
        FROM accounts a
        JOIN server_members sm ON sm.puuid = a.puuid
        JOIN servers s ON s.id = sm.server_id
        WHERE (a.puuid = ${lolUser} OR a.game_name = ${lolUser}) AND s.guild_id = ${interaction.guildId}
      `;
      if (!player) return interaction.reply({ content: "❌ Joueur introuvable ou non surveillé sur ce serveur.", ephemeral: true });

      title = `Statistiques de ${player.game_name}#${player.tag_line}`;

      const [mStats] = await sql`SELECT losses, games FROM monthly_stats WHERE puuid = ${player.puuid} AND month = ${monthStr}`;
      const [bStats] = await sql`SELECT SUM(unlock_count)::int AS b_count FROM badges WHERE entity_id = ${player.puuid}`;

      totalLosses   = player.total_losses        || 0;
      maxStreak     = player.max_loss_streak      || 0;
      currentStreak = player.loss_streak          || 0;
      monthlyLosses = mStats?.losses              || 0;
      monthlyGames  = mStats?.games               || 0;
      badgesCount   = bStats?.b_count             || 0;
      totalTimeDead = player.total_time_spent_dead || 0;
    }

    const lossRate = monthlyGames > 0 ? Math.round((monthlyLosses / monthlyGames) * 100) : 0;
    const hours    = Math.floor(totalTimeDead / 3600);
    const minutes  = Math.floor((totalTimeDead % 3600) / 60);
    const timeStr  = hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;

    const embed = new EmbedBuilder()
      .setTitle(`📊 ${title}`)
      .setColor(0xff0000)
      .setTimestamp();

    if (thumbnail) embed.setThumbnail(thumbnail);
    embed.addFields(
      { name: "📉 Défaites totales",    value: `\`${totalLosses}\``,  inline: true },
      { name: "📅 Défaites ce mois",    value: `\`${monthlyLosses}\``, inline: true },
      { name: "📊 % Défaites (mois)",   value: monthlyGames > 0 ? `\`${lossRate}%\` (${monthlyLosses}/${monthlyGames})` : "`0%`", inline: true },
      { name: "🔥 Série en cours",      value: `\`${currentStreak}\``, inline: true },
      { name: "👑 Pire série",          value: `\`${maxStreak}\``,     inline: true },
      { name: "🎖️ Badges obtenus",     value: `\`${badgesCount}\``,   inline: true },
      { name: "💀 Temps passé mort",    value: `\`${timeStr}\``,       inline: true },
    );

    await interaction.reply({ embeds: [embed] });
  },
};
