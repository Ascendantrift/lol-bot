/**
 * Remplit `badge_definitions` à partir de `badges.js` (source de vérité métier).
 * Utilise INSERT OR IGNORE pour être idempotent : peut être relancé sans dupliquer.
 */
const path = require("path");

const GLYPH_POOL = Array.from(
  "✷✺🜂⚜♥⚒❂✦❋⚱☥♆✧◐◆❖⛧♫✒◎⊕◉⌘⌖✚✶⊛✵✸⚔♜⊕◈◐☽⚗ᛟ●♜⛧✒♫",
);

function seedBadgeDefinitions(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS badge_definitions (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      description TEXT NOT NULL,
      rank        TEXT NOT NULL,
      version     INTEGER NOT NULL DEFAULT 1,
      repeatable  INTEGER NOT NULL DEFAULT 1,
      queues_json TEXT,
      glyph       TEXT NOT NULL DEFAULT '◆',
      valence     TEXT NOT NULL DEFAULT 'negative'
    );
  `);

  // Migration : ajoute valence si absent (DBs créées avant cette version)
  try {
    const cols = db.prepare("PRAGMA table_info(badge_definitions)").all().map((c) => c.name);
    if (!cols.includes("valence")) {
      db.exec("ALTER TABLE badge_definitions ADD COLUMN valence TEXT NOT NULL DEFAULT 'negative'");
    }
  } catch { /* ignoré */ }

  const badgesPath = path.join(__dirname, "..", "badges.js");
  const mod = require(badgesPath);
  const BADGES     = Array.isArray(mod.BADGES)     ? mod.BADGES     : [];
  const WIN_BADGES = Array.isArray(mod.WIN_BADGES)  ? mod.WIN_BADGES : [];
  const ALL_BADGES = [...BADGES, ...WIN_BADGES];

  if (ALL_BADGES.length === 0) return false;

  // INSERT OR IGNORE : idempotent, n'écrase pas les lignes existantes
  const insert = db.prepare(`
    INSERT OR IGNORE INTO badge_definitions
      (id, name, description, rank, version, repeatable, queues_json, glyph, valence)
    VALUES
      (@id, @name, @description, @rank, @version, @repeatable, @queues_json, @glyph, @valence)
  `);

  // UPDATE valence pour les badges déjà insérés (migration rétroactive)
  const updateValence = db.prepare(
    `UPDATE badge_definitions SET valence = @valence WHERE id = @id AND valence != @valence`
  );

  let inserted = 0;
  const run = db.transaction((list) => {
    list.forEach((b, i) => {
      const queuesJson =
        Array.isArray(b.allowed_queues) && b.allowed_queues.length > 0
          ? JSON.stringify(b.allowed_queues)
          : null;
      const valence = b.valence === "positive" ? "positive" : "negative";
      const result = insert.run({
        id: b.key,
        name: b.name,
        description: b.description,
        rank: b.rank,
        version: b.version ?? 1,
        repeatable: b.repeatable ? 1 : 0,
        queues_json: queuesJson,
        glyph: GLYPH_POOL[i % GLYPH_POOL.length] ?? "◆",
        valence,
      });
      if (result.changes > 0) inserted++;
      else updateValence.run({ id: b.key, valence });
    });
  });

  run(ALL_BADGES);
  if (inserted > 0) {
    console.log(`✅ badge_definitions : ${inserted} badge(s) ajouté(s) sur ${ALL_BADGES.length} total.`);
  }
  return inserted > 0;
}

module.exports = { seedBadgeDefinitions };
