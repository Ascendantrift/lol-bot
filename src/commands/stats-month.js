const { SlashCommandBuilder, EmbedBuilder } = require("discord.js");
const { sql } = require("../database");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("stats-month")
    .setDescription("Afficher le total des défaites du mois pour tous les joueurs"),
  async execute(interaction) {
    const monthStr = new Date().toISOString().slice(0, 7);

    const rows = await sql`
      SELECT
        COALESCE(u.discord_id, a.puuid) AS identifier,
        MAX(u.discord_id)               AS discord_id,
        a.game_name,
        a.tag_line,
        MAX(a.max_loss_streak)::int     AS max_streak,
        SUM(ms.losses)::int             AS total_losses,
        SUM(ms.games)::int              AS total_games,
        SUM(ms.total_time_spent_dead)::int AS total_time_dead
      FROM monthly_stats ms
      JOIN accounts a ON a.puuid = ms.puuid
      JOIN server_members sm ON sm.puuid = a.puuid
      JOIN servers s ON s.id = sm.server_id
      LEFT JOIN users u ON u.id = a.user_id
      WHERE ms.month = ${monthStr} AND s.guild_id = ${interaction.guildId}
      GROUP BY COALESCE(u.discord_id, a.puuid), a.game_name, a.tag_line
      ORDER BY total_losses DESC
    `;

    if (!rows.length) {
      return interaction.reply({ content: "🤷 Aucune défaite enregistrée ce mois-ci sur ce serveur.", ephemeral: true });
    }

    const embed = new EmbedBuilder()
      .setTitle(`📅 Bilan des défaites - ${monthStr}`)
      .setColor(0xe67e22)
      .setTimestamp();

    let description = "";

    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const lossRate = r.total_games > 0 ? Math.round((r.total_losses / r.total_games) * 100) : 0;

      let badgeCount = 0;
      if (r.discord_id) {
        const [bStats] = await sql`
          SELECT SUM(unlock_count)::int AS count FROM badges
          WHERE entity_id IN (SELECT puuid FROM accounts WHERE user_id = (SELECT id FROM users WHERE discord_id = ${r.discord_id}))
        `;
        badgeCount = bStats?.count || 0;
      } else {
        const [bStats] = await sql`SELECT SUM(unlock_count)::int AS count FROM badges WHERE entity_id = ${r.identifier}`;
        badgeCount = bStats?.count || 0;
      }

      let label = `**${r.game_name}#${r.tag_line}**`;
      if (r.discord_id) {
        try {
          const user = await interaction.client.users.fetch(r.discord_id);
          label = `**${user.globalName || user.username}**`;
        } catch { /* fallback */ }
      }

      const h       = Math.floor((r.total_time_dead || 0) / 3600);
      const m       = Math.floor(((r.total_time_dead || 0) % 3600) / 60);
      const deadStr = h > 0 ? `${h}h ${m}m` : `${m}m`;

      description += `${i + 1}. ${label} : \`${r.total_losses}\` défaites\n` +
                     `╰ *${lossRate}% winrate | Streak: ${r.max_streak} | 🎖️ ${badgeCount} | 💀 ${deadStr}*\n\n`;
    }

    embed.setDescription(description || "Aucune donnée.");
    embed.setFooter({ text: "Classement basé sur l'humiliation mensuelle." });

    await interaction.reply({ embeds: [embed] });
  },
};
