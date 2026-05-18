const { sql } = require("../database");

const SKIP_DISCORD_SEND =
  process.env.SKIP_DISCORD_NOTIFICATIONS === "1" ||
  process.env.SKIP_DISCORD_NOTIFICATIONS === "true";

const MIN_MS            = 48 * 3_600_000;
const MAX_MS            = 72 * 3_600_000;
const CHECK_INTERVAL_MS = 3_600_000;

function randomDelay() { return MIN_MS + Math.random() * (MAX_MS - MIN_MS); }

let nextMockAt = Date.now() + randomDelay();

async function pickLoss() {
  const cutoff = new Date(Date.now() - 60 * 86_400_000).toISOString();
  const [row] = await sql`
    SELECT mh.champion_name, mh.kills, mh.deaths, mh.assists, mh.played_at, a.game_name
    FROM match_history mh
    JOIN accounts a ON mh.puuid = a.puuid
    WHERE mh.win = false AND mh.played_at >= ${cutoff} AND mh.deaths > 0
    ORDER BY RANDOM()
    LIMIT 1
  `;
  return row ?? null;
}

function timeSince(dateStr) {
  const days = Math.floor((Date.now() - new Date(dateStr).getTime()) / 86_400_000);
  if (days === 0) return "aujourd'hui";
  if (days === 1) return "hier";
  if (days < 7)  return `il y a ${days} jours`;
  if (days < 30) return `il y a ${Math.floor(days / 7)} semaine${days >= 14 ? "s" : ""}`;
  return `il y a ${Math.floor(days / 30)} mois`;
}

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

function buildMock(loss) {
  const { game_name: name, champion_name: champ, kills: k, deaths: d, assists: a, played_at } = loss;
  const kda  = `${k}/${d}/${a}`;
  const when = timeSince(played_at);
  return pick([
    `Petite pensée pour **${name}** qui a feed ${kda} sur ${champ} ${when}. Courage l'ami.`,
    `En mémoire du ${champ} de **${name}** (${kda}, ${when}). Repose en paix.`,
    `Fun fact : **${name}** a fait ${kda} sur ${champ} ${when}. La défaite elle a des formes.`,
    `Quiz : qui a pris ${d} morts sur ${champ} ${when} ? Réponse : **${name}**. Le silence s'impose.`,
    `**${name}** après ses ${d} morts sur ${champ} ${when} : *"gg wp"*`,
    `Rappel que ${when}, **${name}** a fait ${kda} sur ${champ}. La cicatrice est encore fraîche ?`,
    `${champ} de **${name}**, ${when} : ${kda}. On passe à autre chose.`,
    `**${name}** ${when} sur ${champ} : ${kda}. J'avais promis de pas en parler. J'ai menti.`,
  ]);
}

async function tickMockTimer(client) {
  if (Date.now() < nextMockAt) return;
  nextMockAt = Date.now() + randomDelay();

  const loss = await pickLoss();
  if (!loss) return;

  const message  = buildMock(loss);
  const channels = await sql`SELECT channel_id FROM servers LIMIT 10`;

  if (SKIP_DISCORD_SEND) {
    console.log("[MOCK_TIMER] Message non envoyé :", message);
    return;
  }

  for (const row of channels) {
    const chan = await client.channels.fetch(row.channel_id).catch(() => null);
    if (chan) await chan.send(message).catch(() => {});
  }
}

function startMockTimer(client) {
  setInterval(() => tickMockTimer(client).catch(console.error), CHECK_INTERVAL_MS);
}

module.exports = { startMockTimer };
