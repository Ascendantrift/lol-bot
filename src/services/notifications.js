const { sql } = require("../database");

async function recordNotification({ ts, kind, accountPuuid = null, message, details = null, matchId = null }) {
  try {
    await sql`
      INSERT INTO notifications (ts, kind, account_puuid, message, details_json, match_id)
      VALUES (${ts ?? Date.now()}, ${kind}, ${accountPuuid}, ${message}, ${details ? JSON.stringify(details) : null}, ${matchId})
    `;
  } catch (e) {
    console.error(`notifications insert (${kind}):`, e.message);
  }
}

module.exports = { recordNotification };
