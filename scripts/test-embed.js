require("dotenv").config();
const { Client, GatewayIntentBits } = require("discord.js");
const { buildLossEmbed, previewEmbed } = require("../src/services/embeds");

const CHANNEL_ID = "1494323223297527828";

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });

client.once("ready", async () => {
  const chan = await client.channels.fetch(CHANNEL_ID).catch(() => null);
  if (!chan) { console.error("Channel introuvable"); process.exit(1); }

  // Chercher Zoorva dans la guild
  await chan.guild.members.fetch();
  const member = chan.guild.members.cache.find(
    (m) => m.user.username.toLowerCase() === "zoorva" || m.user.globalName?.toLowerCase() === "zoorva"
  );

  const discordIdentity = member
    ? { label: member.user.globalName || member.user.username, avatarUrl: member.user.displayAvatarURL({ extension: "png", size: 64 }) }
    : { label: "Zoorva", avatarUrl: null };

  console.log("Discord identity:", discordIdentity.label, discordIdentity.avatarUrl ? "✅ PP trouvée" : "❌ pas de PP");

  const player = { game_name: "Zoorva", tag_line: "EUW", puuid: "test-zoorva", discord_id: null };

  const embed = buildLossEmbed({
    player, discordIdentity,
    championName: "Leblanc", queueName: "Ranked Solo",
    min: 23, sec: "45",
    kda: { kills: 0, deaths: 10, assists: 0 },
    rankData: { tier: "PLATINUM", rank: "II", lp: 15 },
    streak: 3,
    unlockedBadges: [
      // Badges que d'autres avaient déjà → affichage normal
      { name: "Tilteur Certifié", rank: "Bronze",  isFirstOnServer: false },
      { name: "Le Fantôme",       rank: "Silver",  isFirstOnServer: false },
      { name: "L'Ombre",          rank: "Secret",  isFirstOnServer: false }, // 🤫 discret
      // Badges en 1er sur le serveur → annonce ✨
      { name: "Roi de la Lose",   rank: "Or",      isFirstOnServer: true  },
      { name: "Le Maudit",        rank: "Secret",  isFirstOnServer: true  }, // 🤫 + annonce
    ],
  });

  console.log(previewEmbed(embed));
  await chan.send({ embeds: [embed] });
  console.log("✅ Embed envoyé !");
  process.exit(0);
});

client.login(process.env.DISCORD_TOKEN);
