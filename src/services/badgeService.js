const { sql } = require("../database");

/**
 * Enregistre un déblocage de badge et détermine le cas, en raisonnant AU NIVEAU
 * UTILISATEUR (tous les comptes Riot liés), pas du seul compte courant :
 *
 *   • first_server : personne sur le serveur n'avait ce badge.
 *   • first_player : le joueur (aucun de ses comptes) ne l'avait, mais un autre
 *                    joueur du serveur l'avait déjà.
 *   • repeat       : le joueur l'avait déjà sur l'un de ses comptes (même si c'est
 *                    la 1re fois sur CE compte Riot précis).
 *
 * La table `badges` reste indexée par compte Riot (entity_id = puuid) : on crée/
 * incrémente toujours la ligne du puuid courant, mais le CAS se juge par user.
 */
async function registerBadgeUnlock(puuid, badge, serverId, userId = null) {
  const nowIso = new Date().toISOString();

  // Comptes Riot du joueur (consolidés par utilisateur si lié, sinon ce seul compte).
  let ownPuuids = [puuid];
  if (userId) {
    const rows = await sql`SELECT puuid FROM accounts WHERE user_id = ${userId}`;
    ownPuuids = rows.map((r) => r.puuid);
    if (!ownPuuids.includes(puuid)) ownPuuids.push(puuid);
  }

  // Le joueur (un de ses comptes) possède-t-il déjà ce badge sur ce serveur ?
  const [userHas] = await sql`
    SELECT 1 FROM badges
    WHERE badge_key = ${badge.key} AND server_id = ${serverId} AND entity_id = ANY(${ownPuuids})
    LIMIT 1
  `;

  // Non répétable + déjà possédé → rien (normalement déjà filtré en amont).
  if (userHas && !badge.repeatable) {
    return { isNew: false, kind: "repeat", isFirstOnServer: false };
  }

  // Le badge existe-t-il déjà sur le serveur (tous joueurs confondus) ?
  const [{ cnt: serverCnt }] = await sql`
    SELECT COUNT(*)::int AS cnt FROM badges
    WHERE badge_key = ${badge.key} AND server_id = ${serverId}
  `;

  // Ligne propre à CE compte Riot (pour décider insert vs incrément).
  const [rowForThisPuuid] = await sql`
    SELECT 1 FROM badges
    WHERE entity_id = ${puuid} AND badge_key = ${badge.key} AND server_id = ${serverId}
    LIMIT 1
  `;

  if (rowForThisPuuid) {
    await sql`
      UPDATE badges SET unlock_count = unlock_count + 1, last_unlocked_at = ${nowIso}
      WHERE entity_id = ${puuid} AND badge_key = ${badge.key} AND server_id = ${serverId}
    `;
  } else {
    await sql`
      INSERT INTO badges (entity_id, badge_key, server_id, first_unlocked_at, last_unlocked_at, unlock_count)
      VALUES (${puuid}, ${badge.key}, ${serverId}, ${nowIso}, ${nowIso}, 1)
    `;
  }

  if (userHas) {
    // Le joueur l'avait déjà ailleurs → ré-obtention (même si 1re fois sur ce puuid).
    return { isNew: true, kind: "repeat", isFirstOnServer: false };
  }

  // 1re fois pour le joueur : 1er du serveur si personne ne l'avait avant lui.
  const isFirstOnServer = serverCnt === 0;
  return { isNew: true, kind: isFirstOnServer ? "first_server" : "first_player", isFirstOnServer };
}

module.exports = { registerBadgeUnlock };
