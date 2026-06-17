const fs   = require("fs");
const path = require("path");
const envPath = process.env.NODE_ENV === "test" ? ".env.test" : ".env";
require("dotenv").config({ path: envPath });

const { Client, Collection, GatewayIntentBits } = require("discord.js");
const { sql, ensureReady }       = require("./src/database");
const { checkMatches }           = require("./src/services/matchChecker");
const { maintainActiveGames, scanIdlePlayers } = require("./src/services/liveChecker");
const { announceMonthlyStats }   = require("./src/services/cron");
const { startMatchDetailServer } = require("./src/services/matchDetailServer");
const { setupWallListener }      = require("./src/services/wallListener");

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

client.once("clientReady", async () => {
  await ensureReady();
  startMatchDetailServer(client);

  // Nettoyage des comptes orphelins
  await sql`DELETE FROM accounts WHERE puuid NOT IN (SELECT DISTINCT puuid FROM server_members)`;

  const commandsData = client.commands.map((c) => c.data.toJSON());
  await client.application.commands.set(commandsData);

  console.log("✅ Bot prêt et base de données synchronisée !");

  // Filet de sécurité (rattrape les games non détectées en live). Reste utile mais n'est
  // plus le chemin principal de réactivité → on peut l'espacer pour économiser des appels.
  const CHECK_MATCHES_MS = Number(process.env.CHECK_MATCHES_MS) || 60_000;
  setInterval(() => checkMatches(client), CHECK_MATCHES_MS);

  // Détection de FIN de partie (Spectator) + déclenche le fetch groupé du résultat.
  maintainActiveGames(client).catch((e) => console.error("live tick:", e?.message || e));
  setInterval(() => maintainActiveGames(client).catch((e) => console.error("live tick:", e?.message || e)), 30_000);

  // Détection de DÉBUT de partie (Spectator) sur les comptes idle. Capture aussi, gratuitement,
  // les coéquipiers suivis présents dans une game détectée (coveredPuuids).
  const LIVE_SCAN_MS = Number(process.env.LIVE_SCAN_MS) || 120_000;
  scanIdlePlayers().catch((e) => console.error("scan idle:", e?.message || e));
  setInterval(() => scanIdlePlayers().catch((e) => console.error("scan idle:", e?.message || e)), LIVE_SCAN_MS);

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

client.login(process.env.DISCORD_TOKEN);
