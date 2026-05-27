const { sql } = require("../database");

async function registerBadgeUnlock(puuid, badge) {
  const nowIso = new Date().toISOString();
  const [exists] = await sql`SELECT unlock_count FROM badges WHERE entity_id = ${puuid} AND badge_key = ${badge.key}`;

  if (exists && !badge.repeatable) {
    return { isNew: false, unlockCount: exists.unlock_count, isFirstOnServer: false };
  }

  if (!exists) {
    await sql`
      INSERT INTO badges (entity_id, badge_key, first_unlocked_at, last_unlocked_at, unlock_count)
      VALUES (${puuid}, ${badge.key}, ${nowIso}, ${nowIso}, 1)
    `;
    const [{ cnt }] = await sql`SELECT COUNT(*)::int AS cnt FROM badges WHERE badge_key = ${badge.key}`;
    return { isNew: true, unlockCount: 1, isFirstOnServer: cnt === 1 };
  }

  await sql`
    UPDATE badges SET unlock_count = unlock_count + 1, last_unlocked_at = ${nowIso}
    WHERE entity_id = ${puuid} AND badge_key = ${badge.key}
  `;
  return { isNew: true, unlockCount: exists.unlock_count + 1, isFirstOnServer: false };
}

module.exports = { registerBadgeUnlock };
