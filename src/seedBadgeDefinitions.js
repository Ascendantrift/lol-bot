const path = require("path");

const GLYPH_POOL = Array.from(
  "✷✺🜂⚜♥⚒❂✦❋⚱☥♆✧◐◆❖⛧♫✒◎⊕◉⌘⌖✚✶⊛✵✸⚔♜⊕◈◐☽⚗ᛟ●♜⛧✒♫",
);

async function seedBadgeDefinitions(sql) {
  const badgesPath = path.join(__dirname, "..", "badges.js");
  const mod = require(badgesPath);
  const BADGES     = Array.isArray(mod.BADGES)    ? mod.BADGES    : [];
  const WIN_BADGES = Array.isArray(mod.WIN_BADGES) ? mod.WIN_BADGES : [];
  const ALL_BADGES = [...BADGES, ...WIN_BADGES];

  if (ALL_BADGES.length === 0) return;

  let inserted = 0;
  for (let i = 0; i < ALL_BADGES.length; i++) {
    const b = ALL_BADGES[i];
    const queuesJson =
      Array.isArray(b.allowed_queues) && b.allowed_queues.length > 0
        ? JSON.stringify(b.allowed_queues)
        : null;
    const valence = b.valence === "positive" ? "positive" : "negative";
    const glyph   = GLYPH_POOL[i % GLYPH_POOL.length] ?? "◆";

    const result = await sql`
      INSERT INTO badge_definitions (id, name, description, rank, version, repeatable, queues_json, glyph, valence)
      VALUES (${b.key}, ${b.name}, ${b.description}, ${b.rank}, ${b.version ?? 1}, ${b.repeatable !== false}, ${queuesJson}, ${glyph}, ${valence}::valence)
      ON CONFLICT (id) DO UPDATE SET valence = EXCLUDED.valence
      RETURNING (xmax = 0) AS is_insert
    `;
    if (result[0]?.is_insert) inserted++;
  }

  if (inserted > 0) {
    console.log(`✅ badge_definitions : ${inserted} badge(s) ajouté(s) sur ${ALL_BADGES.length} total.`);
  }
}

module.exports = { seedBadgeDefinitions };
