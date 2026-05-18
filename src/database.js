const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");

const dbFile = process.env.DATABASE_PATH || "data/database.db";
const db = new Database(path.isAbsolute(dbFile) ? dbFile : path.join(process.cwd(), dbFile));

function ensureSchema() {
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  // ═══════════════════════════════════════════════════════
  // TABLES PRINCIPALES
  // ═══════════════════════════════════════════════════════

  // Utilisateurs de la plateforme (auth Discord OAuth)
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      discord_id TEXT UNIQUE NOT NULL,
      username   TEXT NOT NULL,
      avatar     TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    );
    CREATE INDEX IF NOT EXISTS idx_users_discord_id ON users (discord_id);
  `);

  // Comptes LoL suivis
  db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      puuid                  TEXT PRIMARY KEY,
      game_name              TEXT,
      tag_line               TEXT,
      discord_user_id        TEXT,
      owner_user_id          INTEGER REFERENCES users(id) ON DELETE SET NULL,
      total_losses           INTEGER DEFAULT 0,
      max_loss_streak        INTEGER DEFAULT 0,
      loss_streak            INTEGER DEFAULT 0,
      total_wins             INTEGER DEFAULT 0,
      win_streak             INTEGER DEFAULT 0,
      max_win_streak         INTEGER DEFAULT 0,
      total_time_spent_dead  INTEGER DEFAULT 0,
      last_match_id          TEXT,
      last_match_at          INTEGER DEFAULT 0,
      last_checked_at        INTEGER DEFAULT 0,
      last_tier_solo         TEXT,
      last_tier_flex         TEXT,
      glyph                  TEXT
    );
  `);

  // Serveurs communautaires (1 serveur = 1 guild Discord + 1 salon de notifs)
  db.exec(`
    CREATE TABLE IF NOT EXISTS servers (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      name                TEXT NOT NULL,
      guild_id            TEXT NOT NULL,
      channel_id          TEXT NOT NULL,
      mode                TEXT NOT NULL DEFAULT 'negative' CHECK(mode IN ('positive', 'negative', 'both')),
      invite_code         TEXT UNIQUE,
      created_by_user_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at          INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    );
    CREATE INDEX IF NOT EXISTS idx_servers_guild_id ON servers (guild_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_servers_guild_channel ON servers (guild_id, channel_id);
  `);

  // Membres par serveur (quels comptes LoL sont trackés dans quel serveur)
  db.exec(`
    CREATE TABLE IF NOT EXISTS server_members (
      server_id  INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
      puuid      TEXT    NOT NULL REFERENCES accounts(puuid) ON DELETE CASCADE,
      PRIMARY KEY (server_id, puuid)
    );
    CREATE INDEX IF NOT EXISTS idx_server_members_puuid ON server_members (puuid);
  `);

  // Stats mensuelles par compte
  db.exec(`
    CREATE TABLE IF NOT EXISTS monthly_stats (
      puuid                TEXT,
      month                TEXT,
      losses               INTEGER DEFAULT 0,
      wins                 INTEGER DEFAULT 0,
      games                INTEGER DEFAULT 0,
      total_time_spent_dead INTEGER DEFAULT 0,
      PRIMARY KEY (puuid, month)
    );
  `);

  // Déblocages de badges (par compte LoL ou par utilisateur Discord)
  db.exec(`
    CREATE TABLE IF NOT EXISTS badges (
      entity_id        TEXT NOT NULL,
      is_discord       INTEGER NOT NULL DEFAULT 0,
      badge_key        TEXT NOT NULL,
      first_unlocked_at TEXT NOT NULL,
      last_unlocked_at  TEXT NOT NULL,
      unlock_count     INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (entity_id, badge_key)
    );
  `);

  // Historique des parties
  db.exec(`
    CREATE TABLE IF NOT EXISTS match_history (
      id                        TEXT NOT NULL,
      puuid                     TEXT NOT NULL,
      champion_name             TEXT,
      kills                     INTEGER DEFAULT 0,
      deaths                    INTEGER DEFAULT 0,
      assists                   INTEGER DEFAULT 0,
      duration_seconds          INTEGER DEFAULT 0,
      queue_id                  INTEGER,
      played_at                 TEXT NOT NULL,
      win                       INTEGER NOT NULL DEFAULT 0,
      badges_json               TEXT,
      time_spent_dead_seconds   INTEGER DEFAULT 0,
      team_position             TEXT,
      PRIMARY KEY (id, puuid)
    );
    CREATE INDEX IF NOT EXISTS idx_match_history_puuid_played
      ON match_history (puuid, played_at DESC);
  `);

  // Journal des notifications Discord
  db.exec(`
    CREATE TABLE IF NOT EXISTS notifications (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      ts            INTEGER NOT NULL,
      kind          TEXT NOT NULL,
      account_puuid TEXT,
      message       TEXT NOT NULL,
      details_json  TEXT,
      match_id      TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_notifications_ts    ON notifications (ts DESC);
    CREATE INDEX IF NOT EXISTS idx_notifications_puuid ON notifications (account_puuid);
  `);

  // Mur des messages Discord
  db.exec(`
    CREATE TABLE IF NOT EXISTS wall_messages (
      id             TEXT PRIMARY KEY,
      channel_id     TEXT NOT NULL,
      author_id      TEXT NOT NULL,
      author_name    TEXT NOT NULL,
      author_avatar  TEXT,
      content        TEXT NOT NULL,
      created_at_ms  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_wall_messages_ts ON wall_messages (created_at_ms DESC);
  `);

  // Parties en cours (Riot Spectator V5)
  db.exec(`
    CREATE TABLE IF NOT EXISTS live_games (
      id              TEXT PRIMARY KEY,
      queue_id        INTEGER,
      game_mode       TEXT,
      map_id          INTEGER,
      started_at_ms   INTEGER,
      observed_at_ms  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_live_games_observed ON live_games (observed_at_ms DESC);

    CREATE TABLE IF NOT EXISTS live_participants (
      game_id          TEXT    NOT NULL,
      puuid            TEXT    NOT NULL,
      summoner_name    TEXT,
      champion_id      INTEGER,
      champion_name    TEXT,
      team_id          INTEGER NOT NULL,
      is_server        INTEGER NOT NULL DEFAULT 0,
      spell1_id        INTEGER,
      spell2_id        INTEGER,
      kills            INTEGER,
      deaths           INTEGER,
      assists          INTEGER,
      gold             INTEGER,
      minions_killed   INTEGER,
      champion_level   INTEGER,
      riot_lane        TEXT,
      perks_json       TEXT,
      PRIMARY KEY (game_id, puuid)
    );
    CREATE INDEX IF NOT EXISTS idx_live_participants_puuid ON live_participants (puuid);
  `);

  // Titres des joueurs
  db.exec(`
    CREATE TABLE IF NOT EXISTS titles (
      id     INTEGER PRIMARY KEY AUTOINCREMENT,
      title  TEXT NOT NULL,
      puuid  TEXT NOT NULL REFERENCES accounts(puuid) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_titles_puuid ON titles (puuid);
  `);

  // Tribunal — fusionné dans la DB principale
  db.exec(`
    CREATE TABLE IF NOT EXISTS tribunal_cases (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      complainants_json TEXT NOT NULL DEFAULT '[]',
      accused_json      TEXT NOT NULL DEFAULT '[]',
      video_url         TEXT,
      video_path        TEXT,
      complaint         TEXT NOT NULL,
      created_at        INTEGER NOT NULL,
      closes_at         INTEGER NOT NULL DEFAULT 0,
      status            TEXT NOT NULL DEFAULT 'open'
    );

    CREATE TABLE IF NOT EXISTS tribunal_votes (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      case_id     INTEGER NOT NULL REFERENCES tribunal_cases(id) ON DELETE CASCADE,
      voter_name  TEXT NOT NULL,
      verdict     TEXT NOT NULL CHECK(verdict IN ('guilty', 'not_guilty')),
      voted_at    INTEGER NOT NULL,
      UNIQUE(case_id, voter_name)
    );
  `);

  // Catalogue des définitions de badges
  try {
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
        valence     TEXT NOT NULL DEFAULT 'negative' CHECK(valence IN ('positive', 'negative'))
      );
    `);
    const { seedBadgeDefinitions } = require("./seedBadgeDefinitions");
    seedBadgeDefinitions(db);
  } catch (e) {
    console.error("❌ seed badge_definitions:", e.message);
  }

  // ═══════════════════════════════════════════════════════
  // MIGRATIONS COLONNES MANQUANTES
  // ═══════════════════════════════════════════════════════

  // accounts : glyph
  try {
    const accCols = db.prepare("PRAGMA table_info(accounts)").all().map(c => c.name);
    if (!accCols.includes("glyph")) {
      db.exec("ALTER TABLE accounts ADD COLUMN glyph TEXT");
      console.log("✅ Migration : accounts.glyph ajoutée.");
    }
    if (!accCols.includes("owner_user_id")) {
      db.exec("ALTER TABLE accounts ADD COLUMN owner_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL");
      console.log("✅ Migration : accounts.owner_user_id ajoutée.");
    }
    if (!accCols.includes("total_wins")) {
      db.exec("ALTER TABLE accounts ADD COLUMN total_wins INTEGER DEFAULT 0");
      db.exec("ALTER TABLE accounts ADD COLUMN win_streak INTEGER DEFAULT 0");
      db.exec("ALTER TABLE accounts ADD COLUMN max_win_streak INTEGER DEFAULT 0");
      console.log("✅ Migration : accounts win stats ajoutées.");
    }
    // Backfill glyph manquants
    const { glyphForPuuid } = require("./accountGlyph");
    const needGlyph = db.prepare(`SELECT puuid FROM accounts WHERE glyph IS NULL OR TRIM(COALESCE(glyph,'')) = ''`).all();
    const upd = db.prepare("UPDATE accounts SET glyph = ? WHERE puuid = ?");
    for (const row of needGlyph) upd.run(glyphForPuuid(row.puuid), row.puuid);
    if (needGlyph.length > 0) console.log(`✅ Comptes : ${needGlyph.length} glyph(s) ajoutés.`);
  } catch (e) { console.error("❌ Migration accounts cols:", e.message); }

  // accounts : séparation last_tier → last_tier_solo / last_tier_flex
  try {
    const cols = db.prepare("PRAGMA table_info(accounts)").all().map(c => c.name);
    if (!cols.includes("last_tier_solo")) {
      db.exec("ALTER TABLE accounts ADD COLUMN last_tier_solo TEXT");
      db.exec("ALTER TABLE accounts ADD COLUMN last_tier_flex TEXT");
      console.log("✅ Migration : last_tier_solo / last_tier_flex ajoutées.");
    }
    if (cols.includes("last_tier")) {
      db.exec(`UPDATE accounts SET last_tier_solo = last_tier WHERE last_tier IS NOT NULL AND (last_tier_solo IS NULL OR TRIM(last_tier_solo) = '')`);
      db.exec("ALTER TABLE accounts DROP COLUMN last_tier");
      console.log("✅ Migration : last_tier → last_tier_solo.");
    }
  } catch (e) { console.error("❌ Migration solo/flex:", e.message); }

  // monthly_stats : colonne wins
  try {
    const msCols = db.prepare("PRAGMA table_info(monthly_stats)").all().map(c => c.name);
    if (!msCols.includes("wins")) {
      db.exec("ALTER TABLE monthly_stats ADD COLUMN wins INTEGER DEFAULT 0");
      console.log("✅ Migration : monthly_stats.wins ajoutée.");
    }
  } catch (e) { console.error("❌ Migration monthly_stats.wins:", e.message); }

  // match_history : colonnes manquantes
  try {
    const mhCols = db.prepare("PRAGMA table_info(match_history)").all().map(c => c.name);
    if (!mhCols.includes("time_spent_dead_seconds")) db.exec("ALTER TABLE match_history ADD COLUMN time_spent_dead_seconds INTEGER DEFAULT 0");
    if (!mhCols.includes("team_position"))           db.exec("ALTER TABLE match_history ADD COLUMN team_position TEXT");
  } catch (e) { console.error("❌ Migration match_history cols:", e.message); }

  // notifications : colonne match_id
  try {
    const nCols = db.prepare("PRAGMA table_info(notifications)").all().map(c => c.name);
    if (!nCols.includes("match_id")) {
      db.exec("ALTER TABLE notifications ADD COLUMN match_id TEXT");
      console.log("✅ Migration : notifications.match_id ajoutée.");
    }
  } catch (e) { console.error("❌ Migration notifications.match_id:", e.message); }

  // badge_definitions : colonne valence
  try {
    const bdCols = db.prepare("PRAGMA table_info(badge_definitions)").all().map(c => c.name);
    if (!bdCols.includes("valence")) {
      db.exec("ALTER TABLE badge_definitions ADD COLUMN valence TEXT NOT NULL DEFAULT 'negative'");
      console.log("✅ Migration : badge_definitions.valence ajoutée.");
    }
  } catch (e) { console.error("❌ Migration badge_definitions.valence:", e.message); }

  // accounts : user_id (FK vers users.id, remplace discord_user_id côté front)
  try {
    const accCols = db.prepare("PRAGMA table_info(accounts)").all().map(c => c.name);
    if (!accCols.includes("user_id")) {
      db.exec("ALTER TABLE accounts ADD COLUMN user_id INTEGER REFERENCES users(id) ON DELETE SET NULL");
      // Peuple depuis discord_user_id si la colonne existe
      if (accCols.includes("discord_user_id")) {
        db.exec(`UPDATE accounts SET user_id = (
          SELECT id FROM users WHERE discord_id = accounts.discord_user_id
        ) WHERE discord_user_id IS NOT NULL`);
      }
      console.log("✅ Migration : accounts.user_id ajouté et peuplé.");
    }
  } catch (e) { console.error("❌ Migration accounts.user_id:", e.message); }

  // ═══════════════════════════════════════════════════════
  // MIGRATIONS TABLES OBSOLÈTES
  // ═══════════════════════════════════════════════════════

  // players → accounts
  try {
    const playersTable = db.prepare("PRAGMA table_info(players)").all();
    if (playersTable.length > 0) {
      const cols = playersTable.map(c => c.name);
      const selectFields = [
        "puuid",
        cols.includes("game_name") ? "game_name" : "NULL",
        cols.includes("tag_line") ? "tag_line" : "NULL",
        cols.includes("discord_user_id") ? "discord_user_id" : "NULL",
        cols.includes("total_losses") ? "total_losses" : "0",
        cols.includes("max_loss_streak") ? "max_loss_streak" : "0",
        cols.includes("loss_streak") ? "loss_streak" : "0",
        "0 AS total_time_spent_dead",
        cols.includes("last_match_id") ? "last_match_id" : "NULL",
        "0 AS last_match_at",
        "0 AS last_checked_at",
      ].join(", ");
      const res = db.prepare(`INSERT OR IGNORE INTO accounts (puuid,game_name,tag_line,discord_user_id,total_losses,max_loss_streak,loss_streak,total_time_spent_dead,last_match_id,last_match_at,last_checked_at) SELECT ${selectFields} FROM players`).run();
      console.log(`📊 Migration : ${res.changes} joueurs players → accounts.`);
      db.exec("DROP TABLE players");
    }
  } catch (e) { console.error("❌ Migration players → accounts:", e.message); }

  // subscriptions → guild_tracking (étape intermédiaire conservée pour compat)
  try {
    const subsTable = db.prepare("PRAGMA table_info(subscriptions)").all();
    if (subsTable.length > 0) {
      const cols = subsTable.map(c => c.name);
      // On crée guild_tracking temporairement si elle n'existe pas encore
      db.exec(`CREATE TABLE IF NOT EXISTS guild_tracking (puuid TEXT, guild_id TEXT, channel_id TEXT, PRIMARY KEY (puuid, guild_id))`);
      if (cols.includes("guild_id")) {
        db.prepare("INSERT OR IGNORE INTO guild_tracking (puuid,guild_id,channel_id) SELECT puuid,guild_id,channel_id FROM subscriptions").run();
      } else {
        db.prepare("INSERT OR IGNORE INTO guild_tracking (puuid,guild_id,channel_id) SELECT puuid,'882374360269197342',channel_id FROM subscriptions").run();
      }
      db.exec("DROP TABLE subscriptions");
      console.log("📊 Migration : subscriptions → guild_tracking.");
    }
  } catch (e) { console.error("❌ Migration subscriptions:", e.message); }

  // guild_tracking → servers + server_members (migration principale)
  try {
    const gtTable = db.prepare("PRAGMA table_info(guild_tracking)").all();
    if (gtTable.length > 0) {
      // Un serveur = une paire unique (guild_id, channel_id)
      const rows = db.prepare("SELECT DISTINCT guild_id, channel_id FROM guild_tracking").all();
      const upsertServer = db.prepare(`
        INSERT INTO servers (name, guild_id, channel_id, created_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(guild_id, channel_id) DO NOTHING
      `);
      const now = Date.now();
      const tx = db.transaction(() => {
        for (const row of rows) {
          upsertServer.run(`Serveur ${row.guild_id}`, row.guild_id, row.channel_id, now);
        }
      });
      tx();

      // Membres : chaque (puuid, guild_id, channel_id) → server_members
      db.exec(`
        INSERT OR IGNORE INTO server_members (server_id, puuid)
        SELECT s.id, gt.puuid
        FROM guild_tracking gt
        JOIN servers s ON s.guild_id = gt.guild_id AND s.channel_id = gt.channel_id
      `);

      const memberCount = db.prepare("SELECT COUNT(*) AS c FROM server_members").get();
      console.log(`📊 Migration : guild_tracking → ${rows.length} serveur(s), ${memberCount.c} membre(s).`);
      db.exec("DROP TABLE guild_tracking");
    }
  } catch (e) { console.error("❌ Migration guild_tracking → servers:", e.message); }

  // monthly_losses → monthly_stats
  try {
    const mlTable = db.prepare("PRAGMA table_info(monthly_losses)").all();
    if (mlTable.length > 0) {
      db.prepare("INSERT OR IGNORE INTO monthly_stats (puuid,month,losses) SELECT puuid,month,losses FROM monthly_losses").run();
      db.exec("DROP TABLE monthly_losses");
      console.log("📊 Migration : monthly_losses → monthly_stats.");
    }
  } catch (e) { console.error("❌ Migration monthly_losses:", e.message); }

  // entity_badges → badges
  try {
    const ebTable = db.prepare("PRAGMA table_info(entity_badges)").all();
    if (ebTable.length > 0) {
      db.prepare("INSERT OR IGNORE INTO badges (entity_id,is_discord,badge_key,first_unlocked_at,last_unlocked_at,unlock_count) SELECT entity_id,is_discord,badge_key,first_unlocked_at,last_unlocked_at,unlock_count FROM entity_badges").run();
      db.exec("DROP TABLE entity_badges");
      console.log("📊 Migration : entity_badges → badges.");
    }
  } catch (e) { console.error("❌ Migration entity_badges:", e.message); }

  try { db.exec("DROP TABLE IF EXISTS player_badges"); } catch (e) {}

  // Tribunal : migration depuis tribunal.db séparé → tables dans la DB principale
  try {
    const absDbFile = path.isAbsolute(dbFile) ? dbFile : path.join(process.cwd(), dbFile);
    const tribunalPath = path.join(path.dirname(absDbFile), "tribunal.db");
    if (fs.existsSync(tribunalPath)) {
      const trib = new Database(tribunalPath, { readonly: true });
      const tribCases = trib.prepare("SELECT * FROM cases").all();
      const tribVotes = trib.prepare("SELECT * FROM votes").all();
      trib.close();

      if (tribCases.length > 0) {
        const insertCase = db.prepare(`
          INSERT OR IGNORE INTO tribunal_cases (id, complainants_json, accused_json, video_url, video_path, complaint, created_at, closes_at, status)
          VALUES (@id, @complainants_json, @accused_json, @video_url, @video_path, @complaint, @created_at, @closes_at, @status)
        `);
        const insertVote = db.prepare(`
          INSERT OR IGNORE INTO tribunal_votes (id, case_id, voter_name, verdict, voted_at)
          VALUES (@id, @case_id, @voter_name, @verdict, @voted_at)
        `);
        const migrateTrib = db.transaction(() => {
          for (const c of tribCases) insertCase.run(c);
          for (const v of tribVotes)  insertVote.run(v);
        });
        migrateTrib();
        console.log(`📊 Migration : ${tribCases.length} affaire(s) tribunal + ${tribVotes.length} vote(s) → DB principale.`);
      }
      // Archiver l'ancien fichier tribunal.db
      fs.renameSync(tribunalPath, tribunalPath + ".migrated");
      console.log("✅ tribunal.db archivé en tribunal.db.migrated.");
    }
  } catch (e) { console.error("❌ Migration tribunal.db:", e.message); }

  // Backfill notifications depuis match_history (si notifications vide)
  try {
    const notifCount = db.prepare("SELECT COUNT(*) AS c FROM notifications").get();
    if (notifCount && notifCount.c === 0) {
      const histCount = db.prepare("SELECT COUNT(*) AS c FROM match_history").get();
      if (histCount && histCount.c > 0) {
        const QUEUE_LABEL = { 420:"Ranked Solo", 440:"Ranked Flex", 450:"ARAM", 400:"Draft Normale", 490:"Quickplay", 480:"Swiftplay", 430:"Blind Pick" };
        const losses = db.prepare(`
          SELECT mh.id, mh.puuid, mh.champion_name, mh.kills, mh.deaths, mh.assists,
                 mh.duration_seconds, mh.queue_id, mh.played_at, mh.badges_json,
                 a.game_name, a.last_tier_solo
          FROM match_history mh
          JOIN accounts a ON a.puuid = mh.puuid
          WHERE mh.win = 0
          ORDER BY datetime(mh.played_at) ASC
        `).all();
        const ins = db.prepare("INSERT INTO notifications (ts,kind,account_puuid,message,details_json) VALUES (?,?,?,?,?)");
        const insBadge = db.prepare("INSERT INTO notifications (ts,kind,account_puuid,message,details_json) VALUES (?,'badge',?,?,?)");
        const tx = db.transaction(() => {
          for (const r of losses) {
            const ts = Date.parse(r.played_at) || Date.now();
            const ql = QUEUE_LABEL[r.queue_id] ?? "Partie";
            const mins = Math.floor(r.duration_seconds / 60);
            const secs = String(r.duration_seconds % 60).padStart(2, "0");
            const name = r.game_name || "Invocateur";
            ins.run(ts, "loss", r.puuid, `🚨 [${ql}] - ${name} a perdu avec ${r.champion_name} (${r.kills}/${r.deaths}/${r.assists}) en ${mins}:${secs} min.`, JSON.stringify({ queueLabel: ql, accountName: name, champion: r.champion_name, kills: r.kills, deaths: r.deaths, assists: r.assists, durationSeconds: r.duration_seconds }));
            if (r.badges_json) {
              try {
                const keys = JSON.parse(r.badges_json);
                if (Array.isArray(keys)) {
                  for (const k of keys) {
                    const def = db.prepare("SELECT name FROM badge_definitions WHERE id = ?").get(k);
                    insBadge.run(ts, r.puuid, `✨ ${name} a débloqué « ${def?.name ?? k} ».`, JSON.stringify({ accountName: name, badgeKey: k, badgeName: def?.name ?? k }));
                  }
                }
              } catch { /* ignore */ }
            }
          }
        });
        tx();
        console.log(`📝 Notifications : backfill de ${losses.length} pertes.`);
      }
    }
  } catch (e) { console.error("❌ Backfill notifications:", e.message); }

  // Seed "Beta testeur" pour les comptes sans ce titre
  try {
    const existing = db.prepare("SELECT COUNT(*) AS c FROM titles WHERE title = 'Beta testeur'").get();
    if (existing && existing.c === 0) {
      const allAccounts = db.prepare("SELECT puuid FROM accounts").all();
      const ins = db.prepare("INSERT INTO titles (title, puuid) VALUES ('Beta testeur', ?)");
      const tx = db.transaction(() => { for (const row of allAccounts) ins.run(row.puuid); });
      tx();
      if (allAccounts.length > 0) console.log(`✅ Titre "Beta testeur" ajouté à ${allAccounts.length} compte(s).`);
    }
  } catch (e) { console.error("❌ Seed titles:", e.message); }
}

module.exports = { db, ensureSchema };
