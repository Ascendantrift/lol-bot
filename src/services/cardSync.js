// Synchronisation hebdomadaire des NOUVEAUX skins/chromas Data Dragon → card_definitions.
//
// RÈGLE ABSOLUE (demande explicite) : ce job ne fait QUE des INSERT ... ON
// CONFLICT (slug) DO NOTHING. Il ne touche JAMAIS une carte déjà présente en
// base (pas de mise à jour de rareté, nom, image…) — contrairement au script
// manuel `scripts/seedCards.ts` (front) qui, lui, fait des UPSERT complets et
// reste un outil volontairement manuel pour corriger des données existantes.
//
// Si Community Dragon (source de la rareté) est injoignable, on ABANDONNE tout
// le run plutôt que d'ajouter des skins avec une rareté par défaut fausse.
const { sql } = require("../database");

const CDRAGON_BASE = "https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/global/default";

function cdragonAssetUrl(assetPath) {
  let p = assetPath.trim().replace(/^\//, "").toLowerCase();
  if (p.startsWith("lol-game-data/assets/")) p = p.slice("lol-game-data/assets/".length);
  return `${CDRAGON_BASE}/${p}`;
}

// Miroir de cdQualityToRarity (lol-bot-front/scripts/seedCards.ts) — à garder synchro.
function cdQualityToRarity(rarity) {
  switch ((rarity ?? "").trim()) {
    case "kTranscendent": return "transcendant";
    case "kUltimate": return "ultime";
    case "kExalted": return "exalte";
    case "kMythic": return "mythique";
    case "kLegendary": return "legendaire";
    case "kEpic": return "epique";
    case "kRare": return "commun"; // pas de tier "rare" côté site
    case "kNoRarity":
    default: return "commun";
  }
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Fetch failed: ${url} (${res.status})`);
  return res.json();
}

/**
 * Ajoute UNIQUEMENT les champions/skins/chromas qui n'existent pas encore
 * (par slug). Ne modifie jamais une ligne existante. Renvoie un résumé.
 */
async function syncNewSkins() {
  const versions = await fetchJson("https://ddragon.leagueoflegends.com/api/versions.json");
  const version = versions[0];

  const champsData = await fetchJson(`https://ddragon.leagueoflegends.com/cdn/${version}/data/fr_FR/champion.json`);
  const champions = Object.values(champsData.data);

  // Source de la rareté — si indisponible, on abandonne TOUT le run (pas de
  // fallback "commun" en masse qui pourrait fausser de nouvelles entrées).
  let cdSkins;
  try {
    cdSkins = await fetchJson("https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/global/default/v1/skins.json");
  } catch (e) {
    console.error(`[cardSync] Community Dragon injoignable, run annulé : ${e.message}`);
    return null;
  }

  const skinQualityMap = new Map();
  const chromaKeySet = new Set();
  const tierChildKeySet = new Set();
  for (const [skinIdStr, skin] of Object.entries(cdSkins)) {
    const skinIdNum = parseInt(skinIdStr, 10);
    if (Number.isNaN(skinIdNum)) continue;
    const champIdStr = String(Math.floor(skinIdNum / 1000));
    const skinNum = skinIdNum % 1000;
    if (!skinQualityMap.has(champIdStr)) skinQualityMap.set(champIdStr, new Map());
    skinQualityMap.get(champIdStr).set(skinNum, skin.rarity ?? "");
    for (const chroma of skin.chromas ?? []) chromaKeySet.add(`${champIdStr}:${chroma.id % 1000}`);
    const tiers = skin.questSkinInfo?.tiers;
    if (Array.isArray(tiers)) {
      for (const tier of tiers) {
        if (String(tier.id) === skinIdStr) continue;
        tierChildKeySet.add(`${champIdStr}:${tier.id % 1000}`);
      }
    }
  }

  let championsAdded = 0;
  let skinsAdded = 0;
  let chromasAdded = 0;

  // ── Champions (nouveau champion sorti) ────────────────────────────────────
  for (const champ of champions) {
    const slug = `champion_${champ.id.toLowerCase()}`;
    const imageUrl = `https://ddragon.leagueoflegends.com/cdn/img/champion/splash/${champ.id}_0.jpg`;
    const metadata = JSON.stringify({ championId: champ.id });
    const rows = await sql`
      INSERT INTO card_definitions (slug, name, category, rarity, image_url, metadata_json, sort_order)
      VALUES (${slug}, ${champ.name}, 'champion', 'commun'::card_rarity, ${imageUrl}, ${metadata}, 0)
      ON CONFLICT (slug) DO NOTHING
      RETURNING id
    `;
    if (rows.length > 0) championsAdded++;
  }

  const keyToChamp = new Map(champions.map((c) => [c.key, c]));

  // ── Skins (par champion, comparé à Data Dragon = source de vérité du roster) ──
  for (const champ of champions) {
    let fullChampData;
    try {
      const resp = await fetchJson(`https://ddragon.leagueoflegends.com/cdn/${version}/data/fr_FR/champion/${champ.id}.json`);
      fullChampData = resp.data[champ.id];
    } catch {
      continue; // ce champion sera retenté la semaine suivante
    }
    if (!fullChampData?.skins) continue;

    const champKeyStr = champ.key;
    const qualMap = skinQualityMap.get(champKeyStr);

    for (const skin of fullChampData.skins) {
      const isBaseSkin = skin.num === 0;
      if (isBaseSkin) {
        const baseSkinId = parseInt(champKeyStr, 10) * 1000;
        if (!cdSkins[String(baseSkinId)]?.chromas?.length) continue; // skin de base sans chroma = pas une carte
      } else if (skin.name === "default") {
        continue;
      } else if (chromaKeySet.has(`${champKeyStr}:${skin.num}`) || tierChildKeySet.has(`${champKeyStr}:${skin.num}`)) {
        continue;
      }

      const skinKey = parseInt(champKeyStr, 10) * 1000 + skin.num;
      const cdSkin = cdSkins[String(skinKey)];
      const rawQuality = qualMap?.get(skin.num) ?? cdSkin?.rarity ?? "";
      const rarity = isBaseSkin ? "commun" : cdQualityToRarity(rawQuality);
      const slug = `skin_${champ.id.toLowerCase()}_${skin.num}`;
      let imageUrl = `https://ddragon.leagueoflegends.com/cdn/img/champion/loading/${champ.id}_${skin.num}.jpg`;
      if (cdSkin?.splashPath) imageUrl = cdragonAssetUrl(cdSkin.splashPath);
      else if (cdSkin?.loadScreenPath) imageUrl = cdragonAssetUrl(cdSkin.loadScreenPath);
      const skinName = isBaseSkin ? champ.name : skin.name;
      const metadata = JSON.stringify({
        championId: champ.id,
        skinNum: skin.num,
        ...(cdSkin?.splashPath ? { splashPath: cdSkin.splashPath } : {}),
        ...(cdSkin?.loadScreenPath ? { loadScreenPath: cdSkin.loadScreenPath } : {}),
      });

      const rows = await sql`
        INSERT INTO card_definitions (slug, name, category, rarity, image_url, metadata_json, sort_order)
        VALUES (${slug}, ${skinName}, 'skin', ${rarity}::card_rarity, ${imageUrl}, ${metadata}, 1)
        ON CONFLICT (slug) DO NOTHING
        RETURNING id
      `;
      if (rows.length > 0) skinsAdded++;
    }
  }

  // ── Chromas (Community Dragon) ────────────────────────────────────────────
  for (const [skinIdStr, cdSkin] of Object.entries(cdSkins)) {
    const skinIdNum = parseInt(skinIdStr, 10);
    if (Number.isNaN(skinIdNum) || !cdSkin.chromas?.length) continue;
    const champKeyStr = String(Math.floor(skinIdNum / 1000));
    const champ = keyToChamp.get(champKeyStr);
    if (!champ) continue;
    const parentSkinNum = skinIdNum % 1000;
    const parentRarity = cdQualityToRarity(cdSkin.rarity);

    for (const chroma of cdSkin.chromas) {
      const chromaNum = chroma.id % 1000;
      const slug = `chroma_${champ.id.toLowerCase()}_${chromaNum}`;
      const imageUrl = chroma.chromaPath
        ? cdragonAssetUrl(chroma.chromaPath)
        : (cdSkin.splashPath ? cdragonAssetUrl(cdSkin.splashPath) : "");
      const metadata = JSON.stringify({
        championId: champ.id, skinNum: chromaNum, parentSkinNum, chromaPath: chroma.chromaPath ?? null,
      });
      const rows = await sql`
        INSERT INTO card_definitions (slug, name, category, rarity, image_url, metadata_json, sort_order)
        VALUES (${slug}, ${chroma.name}, 'chroma', ${parentRarity}::card_rarity, ${imageUrl}, ${metadata}, 2)
        ON CONFLICT (slug) DO NOTHING
        RETURNING id
      `;
      if (rows.length > 0) chromasAdded++;
    }
  }

  return { version, championsAdded, skinsAdded, chromasAdded };
}

module.exports = { syncNewSkins };
