const fs   = require("fs");
const path = require("path");
const envPath = process.env.NODE_ENV === "test" ? ".env.test" : ".env";
require("dotenv").config({ path: envPath });

const { Client, Collection, GatewayIntentBits } = require("discord.js");
const { sql, ensureReady }       = require("./src/database");
const { checkMatches }           = require("./src/services/matchChecker");
const { checkLiveGames }         = require("./src/services/liveChecker");
const { announceMonthlyStats }   = require("./src/services/cron");
const { startMatchDetailServer } = require("./src/services/matchDetailServer");
const { setupWallListener }      = require("./src/services/wallListener");
const { startMockTimer }         = require("./src/services/mockTimer");

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.commands = new Collection();
const commandsPath  = path.join(__dirname, "src", "commands");
const commandFiles  = fs.readdirSync(commandsPath).filter((f) => f.endsWith(".js"));

for (const file of commandFiles) {
  const filePath = path.join(commandsPath, file);
  const command  = require(filePath);
  if ("data" in command && "execute" in command) {
    client.commands.set(command.data.name, command);
  } else {
    console.log(`[WARNING] ${filePath} : propriétés "data" ou "execute" manquantes.`);
  }
}

startMatchDetailServer();

client.once("clientReady", async () => {
  await ensureReady();

  // Nettoyage des comptes orphelins
  await sql`DELETE FROM accounts WHERE puuid NOT IN (SELECT DISTINCT puuid FROM server_members)`;

  const commandsData = client.commands.map((c) => c.data.toJSON());
  await client.application.commands.set(commandsData);

  console.log("✅ Bot prêt et base de données synchronisée !");

  setInterval(() => checkMatches(client), 60_000);

  checkLiveGames().catch((e) => console.error("live tick:", e?.message || e));
  setInterval(() => checkLiveGames().catch((e) => console.error("live tick:", e?.message || e)), 60_000);

  setInterval(async () => {
    const now = new Date();
    if (now.getDate() === 1 && now.getHours() === 12 && now.getMinutes() < 60) {
      const currentMonthStr = now.toISOString().slice(0, 7);
      if (global.lastAnnouncedMonth !== currentMonthStr) {
        global.lastAnnouncedMonth = currentMonthStr;
        await announceMonthlyStats(client);
      }
    }
  }, 60 * 60 * 1000);
});

client.on("interactionCreate", async (interaction) => {
  if (interaction.isAutocomplete()) {
    const focusedOption = interaction.options.getFocused(true);

    if (["nom", "joueur", "lol"].includes(focusedOption.name)) {
      const val     = focusedOption.value;
      const players = await sql`
        SELECT DISTINCT a.game_name, a.tag_line, a.puuid
        FROM accounts a
        JOIN server_members sm ON sm.puuid = a.puuid
        JOIN servers s ON s.id = sm.server_id
        WHERE (a.game_name ILIKE ${val + "%"} OR (a.game_name || '#' || a.tag_line) ILIKE ${"%" + val + "%"})
          AND s.guild_id = ${interaction.guildId}
        LIMIT 25
      `;
      await interaction.respond(
        players.map((p) => ({ name: `${p.game_name}#${p.tag_line}`, value: p.puuid })),
      );
    }

    if (focusedOption.name === "badge") {
      const { BADGES } = require("./badges");
      let availableBadges = BADGES;

      if (interaction.commandName === "badge-remove") {
        const lolUser = interaction.options.getString("joueur");
        if (lolUser) {
          const [player] = await sql`SELECT puuid FROM accounts WHERE puuid = ${lolUser} OR game_name = ${lolUser}`;
          if (player) {
            const owned = await sql`SELECT badge_key FROM badges WHERE entity_id = ${player.puuid}`;
            const keys  = owned.map((r) => r.badge_key);
            availableBadges = BADGES.filter((b) => keys.includes(b.key));
          } else {
            availableBadges = [];
          }
        }
      }

      const val      = focusedOption.value.toLowerCase();
      const filtered = availableBadges
        .filter((b) => b.key.toLowerCase().includes(val) || b.name.toLowerCase().includes(val))
        .slice(0, 25);
      await interaction.respond(filtered.map((b) => ({ name: `${b.name} (${b.key})`, value: b.key })));
    }
    return;
  }

  if (!interaction.isChatInputCommand()) return;

  const command = client.commands.get(interaction.commandName);
  if (!command) return;

  try {
    await command.execute(interaction);
  } catch (error) {
    console.error(error);
    const msg = { content: "Une erreur est survenue lors de l'exécution de cette commande.", ephemeral: true };
    if (interaction.replied || interaction.deferred) await interaction.followUp(msg);
    else                                              await interaction.reply(msg);
  }
});

setupWallListener(client);
startMockTimer(client);

client.login(process.env.DISCORD_TOKEN);
