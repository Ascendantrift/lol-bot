// Ce fichier n'est plus nécessaire : le schéma PostgreSQL est géré par
// drizzle-kit (Lol_Bot_Dev). `ensureReady()` dans database.js s'occupe
// uniquement du seed des badge_definitions au démarrage du bot.
require("dotenv").config();
const { ensureReady } = require("./src/database");

ensureReady()
  .then(() => { console.log("✅ Base de données prête."); process.exit(0); })
  .catch((e) => { console.error("❌", e.message); process.exit(1); });
