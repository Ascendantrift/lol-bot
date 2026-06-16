#!/usr/bin/env node
/*
 * Rejoue un match RÉEL depuis l'API Riot pour valider l'évaluation des badges.
 * Lecture seule : aucune écriture en base, aucune notification Discord.
 *
 * Usage :
 *   node scripts/replayMatch.js <matchId> <gameName#tag | puuid>
 *   ex : node scripts/replayMatch.js EUW1_1234567890 IncoNitro#EUW
 *
 * Pourquoi cet outil : tester avec des données qu'on fabrique soi-même
 * (`{ challenges: { snowballHit: 20 } }`) valide NOTRE hypothèse, pas la réalité —
 * le test passe même si le vrai champ Riot s'appelle `snowballsHit`. En rejouant un
 * vrai match, on voit les VRAIS noms de champs et on repère les fautes de frappe.
 */

require("dotenv").config();
const axios = require("axios");
const { evaluateTriggeredWinBadges, evaluateTriggeredBadges } = require("../badges");

const KEY = (process.env.RIOT_API_KEY || "").trim();
const REGION = "https://europe.api.riotgames.com";
const H = { headers: { "X-Riot-Token": KEY } };

async function resolvePuuid(idArg) {
  if (!idArg.includes("#")) return idArg; // déjà un puuid
  const [name, tag] = idArg.split("#");
  const { data } = await axios.get(
    `${REGION}/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(name)}/${encodeURIComponent(tag)}`,
    H,
  );
  return data.puuid;
}

async function main() {
  const [matchId, idArg] = process.argv.slice(2);
  if (!KEY) { console.error("❌ RIOT_API_KEY manquant (.env)."); process.exit(1); }
  if (!matchId || !idArg) {
    console.error("Usage : node scripts/replayMatch.js <matchId> <gameName#tag | puuid>");
    process.exit(1);
  }

  const puuid = await resolvePuuid(idArg);
  const { data } = await axios.get(`${REGION}/lol/match/v5/matches/${matchId}`, H);
  const info = data.info;
  const p = info.participants.find((x) => x.puuid === puuid);
  if (!p) { console.error("❌ Participant introuvable dans ce match."); process.exit(1); }

  const win = p.win;
  console.log(`\n=== ${matchId} | queueId=${info.queueId} | ${Math.floor(info.gameDuration / 60)}min | ${win ? "VICTOIRE" : "DÉFAITE"} ===`);
  console.log(`Joueur : ${p.riotIdGameName ?? p.summonerName} — ${p.championName} ${p.kills}/${p.deaths}/${p.assists}`);

  // Dump des vrais champs `challenges` → permet de repérer le bon nom de champ.
  console.log("\n— challenges présents (vrais noms de champs Riot) —");
  console.log(Object.keys(p.challenges || {}).sort().join(", ") || "(aucun)");

  // Évaluation sur les VRAIES données. Streaks/tiers neutres (0/null) : ce replay
  // valide surtout les conditions propres au match (KDA, challenges, stats d'équipe…).
  const triggered = win
    ? evaluateTriggeredWinBadges(p, 0, info, 0, [], null, null)
    : evaluateTriggeredBadges(p, 0, info, [], 0, null, null);

  console.log("\n— badges déclenchés —");
  if (triggered.length === 0) console.log("(aucun — vérifie la condition, la queue, ou le nom de champ)");
  for (const b of triggered) console.log(`  ✔ ${b.key} — ${b.name} (${b.rank})`);
  console.log("\nℹ️  Les badges de série (streak) et de palier (montée de tier) ne sont pas");
  console.log("   testés ici (replay isolé). Le reste reflète exactement ce que verrait le bot.\n");
}

main().catch((e) => {
  console.error("Erreur :", e.response?.status ?? "", e.response?.data?.status?.message ?? e.message);
  process.exit(1);
});
