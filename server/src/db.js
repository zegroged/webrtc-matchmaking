'use strict';
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');

fs.mkdirSync(path.dirname(config.DB_FILE), { recursive: true });
fs.mkdirSync(config.EVIDENCE_DIR, { recursive: true });
fs.mkdirSync(config.AVATAR_DIR, { recursive: true });

const db = new DatabaseSync(config.DB_FILE);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  phone_hash    TEXT NOT NULL UNIQUE,
  display_name  TEXT NOT NULL,
  birth_date    TEXT NOT NULL,            -- kilitli: değişiklik talebi manuel inceleme gerektirir
  languages     TEXT NOT NULL,            -- JSON dizi, ör. ["tr","en"]
  interests     TEXT NOT NULL,            -- JSON dizi, 3 adet
  status        TEXT NOT NULL DEFAULT 'active',   -- active | suspended | banned
  suspended_until INTEGER,                -- ms epoch; NULL = süresiz değil
  trust_score   INTEGER NOT NULL DEFAULT 100,
  is_admin      INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS otp_codes (
  phone_hash    TEXT PRIMARY KEY,
  code          TEXT NOT NULL,
  expires_at    INTEGER NOT NULL,
  attempts      INTEGER NOT NULL DEFAULT 0,
  requested_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL REFERENCES users(id),
  mood          TEXT NOT NULL,
  started_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS matches (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_a        INTEGER NOT NULL REFERENCES users(id),
  user_b        INTEGER NOT NULL REFERENCES users(id),
  started_at    INTEGER NOT NULL,
  ended_at      INTEGER,
  end_reason    TEXT,                     -- skip | leave | report | disconnect
  ended_by      INTEGER,
  duration_sec  INTEGER,
  friend_req_a  INTEGER NOT NULL DEFAULT 0,
  friend_req_b  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_matches_users ON matches(user_a, user_b);

CREATE TABLE IF NOT EXISTS friendships (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_a        INTEGER NOT NULL REFERENCES users(id),  -- her zaman user_a < user_b
  user_b        INTEGER NOT NULL REFERENCES users(id),
  created_at    INTEGER NOT NULL,
  UNIQUE(user_a, user_b)
);

CREATE TABLE IF NOT EXISTS messages (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  friendship_id INTEGER NOT NULL REFERENCES friendships(id) ON DELETE CASCADE,
  sender_id     INTEGER NOT NULL REFERENCES users(id),
  body          TEXT NOT NULL,
  flagged       INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  read_at       INTEGER
);
CREATE INDEX IF NOT EXISTS idx_messages_friendship ON messages(friendship_id, id);

CREATE TABLE IF NOT EXISTS blocks (
  blocker_id    INTEGER NOT NULL REFERENCES users(id),
  blocked_id    INTEGER NOT NULL REFERENCES users(id),
  created_at    INTEGER NOT NULL,
  PRIMARY KEY (blocker_id, blocked_id)
);

CREATE TABLE IF NOT EXISTS reports (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  match_id      INTEGER REFERENCES matches(id),
  friendship_id INTEGER REFERENCES friendships(id),
  reporter_id   INTEGER NOT NULL REFERENCES users(id),
  reported_id   INTEGER NOT NULL REFERENCES users(id),
  category      TEXT NOT NULL,
  note          TEXT,
  evidence_path TEXT,                     -- rapor anında yakalanan kare (jpeg)
  chat_excerpt  TEXT,                     -- sohbet raporlarında son mesajlar (JSON)
  status        TEXT NOT NULL DEFAULT 'pending',  -- pending | reviewed
  action_taken  TEXT,                     -- dismissed | warned | suspended | banned
  created_at    INTEGER NOT NULL,
  reviewed_at   INTEGER,
  reviewed_by   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status, created_at);
CREATE INDEX IF NOT EXISTS idx_reports_reported ON reports(reported_id, created_at);

CREATE TABLE IF NOT EXISTS bans (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER REFERENCES users(id),
  phone_hash    TEXT NOT NULL,
  reason        TEXT,
  expires_at    INTEGER,                  -- NULL = kalıcı
  created_at    INTEGER NOT NULL,
  created_by    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_bans_phone ON bans(phone_hash);

CREATE TABLE IF NOT EXISTS settings (
  key           TEXT PRIMARY KEY,
  value         TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS admin_accounts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE,
  pass_hash     TEXT NOT NULL,            -- scrypt: salt:hash
  created_at    INTEGER NOT NULL
);
`);

// --- Şema göçleri --------------------------------------------------------------
// Mevcut veritabanlarını bozmadan yeni kolon ekler (CREATE TABLE IF NOT EXISTS
// var olan tabloyu değiştirmez).

function ensureColumn(table, name, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === name)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
}

ensureColumn('users', 'avatar_path', 'avatar_path TEXT');
// İstek kutusu: alıcı isteği reddettiyse bir daha listelenmez.
ensureColumn('matches', 'req_declined_a', 'req_declined_a INTEGER NOT NULL DEFAULT 0');
ensureColumn('matches', 'req_declined_b', 'req_declined_b INTEGER NOT NULL DEFAULT 0');

// --- Ayarlar -----------------------------------------------------------------

function getSetting(key, fallback = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

function setSetting(key, value) {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, String(value));
}

// --- Admin hesabı (ilk çalıştırmada üretilir) ---------------------------------

function scryptHash(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function scryptVerify(password, stored) {
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const candidate = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, 'hex');
  return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
}

function ensureAdminAccount() {
  const existing = db.prepare('SELECT COUNT(*) AS c FROM admin_accounts').get();
  if (existing.c > 0) return null;
  const password = crypto.randomBytes(9).toString('base64url');
  db.prepare('INSERT INTO admin_accounts (username, pass_hash, created_at) VALUES (?, ?, ?)')
    .run('admin', scryptHash(password), Date.now());
  const infoPath = path.join(config.DATA_DIR, 'ADMIN_BILGILERI.txt');
  fs.writeFileSync(
    infoPath,
    `Proje X yönetim paneli girişi\n=============================\nURL      : http://localhost:${config.PORT}/admin\nKullanıcı: admin\nŞifre    : ${password}\n\nBu dosyayı güvenli bir yere taşıyın.\n`,
    'utf8'
  );
  return { username: 'admin', password, infoPath };
}

module.exports = { db, getSetting, setSetting, scryptHash, scryptVerify, ensureAdminAccount };
