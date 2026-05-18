const { SlashCommandBuilder, EmbedBuilder } = require("discord.js");
const axios = require("axios");
const { sql } = require("../database");
const { RIOT_API_KEY, QUEUE_TYPES, getChampionName } = require("../services/riot");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("live")
    .setDescription("Voir quels joueurs surveillés sont actuellement en partie"),
  async execute(interaction) {
    await interaction.deferReply();

    const players = await sql`
      SELECT DISTINCT a.puuid, a.game_name, a.tag_line, a.loss_streak, a.user_id
      FROM accounts a
      JOIN server_members sm ON sm.puuid = a.puuid
      JOIN servers s ON s.id = sm.server_id
      WHERE s.guild_id = ${interaction.guildId}
    `;

    if (players.length === 0) {
      return interaction.editReply("❌ Aucun joueur n'est surveillé sur ce serveur.");
    }

    const livePlayers = [];
    const axiosConfig = { headers: { "X-Riot-Token": RIOT_API_KEY } };

    for (const player of players) {
      try {
        const url = `https://euw1.api.riotgames.com/lol/spectator/v5/active-games/by-summoner/${player.puuid}`;
        const res = await axios.get(url, axiosConfig);

        if (res.status === 200) {
          const game        = res.data;
          const participant = game.participants.find((p) => p.puuid === player.puuid);
          const championName = participant ? await getChampionName(participant.championId) : "Inconnu";
          const queueName    = QUEUE_TYPES[game.gameQueueConfigId] || "Partie Custom";

          let durationStr = "En chargement";
          if (game.gameStartTime > 0) {
            const elapsedMs = Date.now() - game.gameStartTime;
            const min = Math.floor(elapsedMs / 60_000);
            const sec = Math.floor((elapsedMs % 60_000) / 1000).toString().padStart(2, "0");
            durationStr = `${min}:${sec}`;
          }

          let activeStreak = player.loss_streak || 0;
          if (player.user_id) {
            const [row] = await sql`SELECT SUM(loss_streak)::int AS sum_streak FROM accounts WHERE user_id = ${player.user_id}`;
            if (row?.sum_streak != null) activeStreak = row.sum_streak;
          }

          let badgeWarning = "";
          if (activeStreak === 4)  badgeWarning = "\n🚨 *Balle de match (**Jamais 4 sans 5**)*";
          else if (activeStreak === 9)  badgeWarning = "\n🚨 *Balle de match (**La chute libre**)*";
          else if (activeStreak === 14) badgeWarning = "\n🚨 *Balle de match (**Le fond du gouffre**)*";

          livePlayers.push({
            name: player.game_name,
            tag:  player.tag_line,
            champion: championName,
            queue:    queueName,
            duration: durationStr,
            badgeWarning,
          });
        }
      } catch (e) {
        if (!e.response || e.response.status !== 404) {
          console.error(`Erreur Spectator API pour ${player.game_name}: ${e.message}`);
        }
      }
      await new Promise((r) => setTimeout(r, 50));
    }

    if (livePlayers.length === 0) {
      return interaction.editReply("😴 Aucun joueur surveillé n'est actuellement en partie.");
    }

    const embed = new EmbedBuilder()
      .setTitle("🔴 Joueurs actuellement en jeu")
      .setColor(0xff0000)
      .setTimestamp();

    livePlayers.forEach((p) => {
      embed.addFields({
        name:  `👤 ${p.name}#${p.tag}`,
        value: `🕹️ **${p.champion}**\n⌛ Durée : \`${p.duration}\`\n🗺️ Mode : \`${p.queue}\`${p.badgeWarning}`,
        inline: true,
      });
    });

    await interaction.editReply({ embeds: [embed] });
  },
};
