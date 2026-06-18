require("dotenv").config();
const postgres = require("postgres");

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set");

// bigint (last_match_at, last_checked_at) → retourné comme nombre JS
const sql = postgres(process.env.DATABASE_URL, {
  max: 5,
  // prepare:false → requis avec pgbouncer en POOL_MODE=transaction.
  prepare: false,
  types: {
    bigint: {
      to: 20,
      from: [20],
      serialize: (x) => String(x),
      parse: (x) => Number(x),
    },
  },
});

async function ensureReady() {
  const { seedBadgeDefinitions } = require("./seedBadgeDefinitions");
  await seedBadgeDefinitions(sql);
  console.log("✅ Base de données prête.");
}

module.exports = { sql, ensureReady };
