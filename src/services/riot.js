const axios = require("axios");

const RIOT_API_KEY = process.env.RIOT_API_KEY ? process.env.RIOT_API_KEY.trim() : "";

const QUEUE_TYPES = {
  400: "Draft Normale",
  420: "Ranked Solo",
  430: "Blind Pick",
  440: "Ranked Flex",
  450: "ARAM",
  480: "Swiftplay",
  490: "Quickplay",
  700: "Clash",
  720: "ARAM Clash",
  1900: "URF",
  2400: "ARAM Chaos",
};

/**
 * Récupère le rank et les LP d'un joueur via l'API Riot (by-puuid).
 * @param {string} puuid - Le PUUID du joueur
 * @param {number} queueId - L'ID de la queue (420 = Solo, 440 = Flex)
 * @returns {Promise<{tier: string, rank: string, lp: number} | null>}
 */
async function fetchPlayerRank(puuid, queueId) {
  if (queueId !== 420 && queueId !== 440) return null;

  try {
    const axiosConfig = { headers: { "X-Riot-Token": RIOT_API_KEY } };
    const url = `https://euw1.api.riotgames.com/lol/league/v4/entries/by-puuid/${puuid}`;
    const leagueRes = await axios.get(url, axiosConfig);

    const queueType = queueId === 440 ? "RANKED_FLEX_SR" : "RANKED_SOLO_5x5";
    const entry = leagueRes.data.find((e) => e.queueType === queueType);

    if (!entry) return null;

    return {
      tier: entry.tier,
      rank: entry.rank,
      lp: entry.leaguePoints,
      wins: entry.wins ?? 0,
      losses: entry.losses ?? 0,
    };
  } catch (e) {
    if (e.response?.status === 403) {
      console.error("❌ Erreur 403 Riot API : Vérifiez si votre clé est bien à jour sur le portail.");
    } else {
      console.error(`⚠️ Impossible de récupérer le rank (${puuid}) : ${e.message}`);
    }
    return null;
  }
}

/**
 * Retourne "GOLD IV" (solo > flex) pour l'affichage live. Un seul appel API.
 * @param {string} puuid
 * @returns {Promise<string|null>}
 */
async function fetchBestRankForLive(puuid) {
  try {
    const { data } = await axios.get(
      `https://euw1.api.riotgames.com/lol/league/v4/entries/by-puuid/${puuid}`,
      { headers: { "X-Riot-Token": RIOT_API_KEY } },
    );
    const solo = data.find((e) => e.queueType === "RANKED_SOLO_5x5");
    const flex = data.find((e) => e.queueType === "RANKED_FLEX_SR");
    const entry = solo ?? flex ?? null;
    if (!entry) return null;
    return entry.rank ? `${entry.tier} ${entry.rank}` : entry.tier;
  } catch {
    return null;
  }
}

let championsCache = null;
let ddragonVersionCache = null;

/**
 * Version Data Dragon courante (CDN images, pas l'API Riot Games).
 * @see https://developer.riotgames.com/docs/lol#data-dragon
 */
async function getDdragonVersion() {
  if (ddragonVersionCache) return ddragonVersionCache;
  const vRes = await axios.get(
    "https://ddragon.leagueoflegends.com/api/versions.json",
  );
  ddragonVersionCache = vRes.data[0];
  return ddragonVersionCache;
}

/** Icône champion : `championName` = champ retourné par Match-V5 (`participant.championName`, ex. "MissFortune"). */
async function championSquareImgUrl(championName) {
  if (!championName) return null;
  const v = await getDdragonVersion();
  return `https://ddragon.leagueoflegends.com/cdn/${v}/img/champion/${championName}.png`;
}

/**
 * Récupère la partie active d’un joueur via Riot Spectator V5.
 * Retourne `null` si le joueur n’est pas en partie (404) ou si la requête échoue.
 *
 * @param {string} puuid
 * @returns {Promise<null | {
 *   gameId: string|number,
 *   gameQueueConfigId: number,
 *   gameMode: string,
 *   mapId: number,
 *   gameStartTime: number,
 *   participants: Array<{ puuid: string, championId: number, teamId: number, summonerName?: string, riotId?: string }>,
 * }>}
 */
async function getActiveGameByPuuid(puuid, retries = 2) {
  const axiosConfig = { headers: { "X-Riot-Token": RIOT_API_KEY } };
  const url = `https://euw1.api.riotgames.com/lol/spectator/v5/active-games/by-summoner/${puuid}`;
  try {
    const res = await axios.get(url, axiosConfig);
    return res.data;
  } catch (e) {
    if (e.response?.status === 429 && retries > 0) {
      const retryAfter = parseInt(e.response.headers?.["retry-after"] ?? "5", 10);
      const wait = (Number.isFinite(retryAfter) ? retryAfter : 5) * 1000;
      await new Promise((r) => setTimeout(r, wait));
      return getActiveGameByPuuid(puuid, retries - 1);
    }
    if (!e.response || e.response.status !== 404) {
      console.error(`⚠️ Spectator API (${puuid}) : ${e.message}`);
    }
    return null;
  }
}

async function getChampionName(championId) {
  if (!championsCache) {
    try {
      const vRes = await axios.get("https://ddragon.leagueoflegends.com/api/versions.json");
      const v = vRes.data[0];
      const cRes = await axios.get(`https://ddragon.leagueoflegends.com/cdn/${v}/data/fr_FR/champion.json`);
      championsCache = cRes.data.data;
    } catch (e) {
      return "Inconnu";
    }
  }
  for (const key in championsCache) {
    if (championsCache[key].key == championId) {
      return key; // Data Dragon image key (e.g. "TahmKench", "MonkeyKing")
    }
  }
  return "Inconnu";
}

module.exports = {
  RIOT_API_KEY,
  QUEUE_TYPES,
  fetchPlayerRank,
  fetchBestRankForLive,
  getChampionName,
  getActiveGameByPuuid,
  getDdragonVersion,
  championSquareImgUrl,
};
