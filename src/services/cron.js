const { sql } = require("../database");

const SKIP_DISCORD_SEND =
  process.env.SKIP_DISCORD_NOTIFICATIONS === "1" ||
  process.env.SKIP_DISCORD_NOTIFICATIONS === "true";

async function announceMonthlyStats(client) {
  const now = new Date();
  now.setMonth(now.getMonth() - 1);
  const prevMonthStr = now.toISOString().slice(0, 7);

  const rows = await sql`
    SELECT
      COALESCE(u.discord_id, a.game_name || '#' || a.tag_line) AS identifier,
      MAX(u.discord_id) AS discord_id,
      SUM(ms.losses)::int AS total_month
    FROM monthly_stats ms
    JOIN accounts a ON a.puuid = ms.puuid
    LEFT JOIN users u ON u.id = a.user_id
    WHERE ms.month = ${prevMonthStr}
    GROUP BY COALESCE(u.discord_id, a.game_name || '#' || a.tag_line)
    ORDER BY total_month DESC
  `;

  if (!rows.length) return;

  let msg = `📢 **BILAN MENSUEL DES DÉFAITES (${prevMonthStr})** 📢\n━━━━━━━━━━━━━━━━━━━━━━━━\n`;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    let label = `**${r.identifier}**`;
    if (r.discord_id) {
      try {
        const user = client.users.cache.get(r.discord_id) || await client.users.fetch(r.discord_id);
        label = `**${user.globalName || user.username}**`;
      } catch { /* fallback au pseudo LoL */ }
    }
    msg += `${i + 1}. ${label} : **${r.total_month}** défaites\n`;
  }
  msg += "━━━━━━━━━━━━━━━━━━━━━━━━";

  const channels = await sql`SELECT channel_id FROM servers`;
  for (const c of channels) {
    const chan = await client.channels.fetch(c.channel_id).catch(() => null);
    if (!chan) continue;
    if (SKIP_DISCORD_SEND) {
      console.log("[SKIP_DISCORD_NOTIFICATIONS] Bilan mensuel non envoyé.");
      break;
    }
    await chan.send(msg);
  }
}

module.exports = { announceMonthlyStats };
