const { sql } = require("../database");

const WALL_INSULTS = [
  "connard", "conard", "konard", "connart", "connar", "connare",
  "connasse", "conasse", "konasse",
  "con", "conne", "kon",
  "fdp", "fils de pute", "filsdepute", "fi1s de pute",
  "pd", "p.d", "p d",
  "merde", "merd", "mrde", "mrd",
  "encule", "enculer", "enkule", "encoulé", "encoule",
  "ta gueule", "ta geule", "ta guele", "tg",
  "nul", "nulle", "naze", "nas",
  "nul a chier", "nul à chier", "nula chier",
  "debile", "débile", "debil", "idiot", "idiote", "idote", "idio",
  "cretin", "crétin", "createn",
  "pute", "put1", "salope", "salop", "salaud",
  "batard", "batart", "bastard", "bastart",
  "chier", "va chier", "fais chier", "fait chier", "fé chier",
  "inutile", "de merde", "demerde",
  "cringe", "cring",
  "abuse", "abusé", "abuser",
  "ntm", "nique ta mere", "nique ta mère", "nqtm", "niquer",
  "va te faire", "vtff", "vtf",
  "imbecile", "imbécile", "imbesile",
  "raté", "rate", "looser", "loser",
  "boloss", "bolo", "bolos",
  "gros nul", "grosnul",
  "boulet", "boulets",
  "cancer", "cancre",
  "noob", "nub", "newb",
  "de mort", "mort", "mortel", "mortelle",
  "horrible", "atroce", "catastrophe", "catastrophique",
  "casse les pieds", "casse pieds", "cassepied", "cassepieds",
  "ras le bol", "ras-le-bol", "raslebol", "j'en peux plus", "jen peux plus",
  "flan", "flanelle", "bidon", "de la merde",
  "chiant", "chiante", "gonflant", "gonflante", "saoul", "saoul de",
  "pire", "le pire", "c'est le pire", "vraiment le pire",
  "exploser", "explose", "explosé", "explosee", "xplose", "xploser",
  "il explose", "tu exploses", "fait exploser", "fais exploser",
  "ta mere", "ta mère", "ta mer", "tamere", "ta.mere",
  "ta race", "ta rasse", "ta rase",
  "ta daronne", "ta dar",
  "fils de ta mere", "fils de ta mère",
  "va voir ta mere", "va voir ta mère",
  "ta famille", "votre mere", "votre mère",
  "sa mere", "sa mère", "samere",
];

function norm(s) {
  return s.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "");
}

function buildRegex(word) {
  const esc = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![a-z])${esc}(?![a-z])`);
}

const INSULT_REGEXES = WALL_INSULTS.map((w) => buildRegex(norm(w)));

// Détecte "bot" comme mot entier (pas dans "robot", "chatbot"...)
const BOT_WORD_REGEX = /(?<![a-z0-9])bot(?![a-z0-9])/;

function containsBotInsult(text, mentionsBot = false) {
  const lower = norm(text);
  const targetsBot = mentionsBot || BOT_WORD_REGEX.test(lower);
  if (!targetsBot) return false;
  return INSULT_REGEXES.some((re) => re.test(lower));
}

function setupWallListener(client) {
  client.on("messageCreate", async (message) => {
    if (message.author.bot) return;
    if (!message.content || !message.content.trim()) return;
    const mentionsBot = message.mentions.users.has(message.client.user?.id ?? "");
    if (!containsBotInsult(message.content, mentionsBot)) return;

    const [tracked] = await sql`SELECT 1 FROM servers WHERE channel_id = ${message.channelId} LIMIT 1`;
    if (!tracked) return;

    const avatarUrl = message.author.avatar
      ? `https://cdn.discordapp.com/avatars/${message.author.id}/${message.author.avatar}.png?size=128`
      : `https://cdn.discordapp.com/embed/avatars/${Number(BigInt(message.author.id) % 5n)}.png`;

    try {
      await sql`
        INSERT INTO wall_messages (id, channel_id, author_id, author_name, author_avatar, content, created_at_ms)
        VALUES (${message.id}, ${message.channelId}, ${message.author.id},
          ${message.member?.displayName || message.author.globalName || message.author.username},
          ${avatarUrl}, ${message.content.trim()}, ${message.createdTimestamp})
        ON CONFLICT (id) DO NOTHING
      `;
    } catch (e) {
      console.error("wall_messages insert:", e.message);
    }
    // Le bot ne répond plus aux insultes (clapback supprimé) — on archive seulement
    // le message au mur. La détection sert uniquement à alimenter le mur du site.
  });
}

module.exports = { setupWallListener, containsBotInsult };
