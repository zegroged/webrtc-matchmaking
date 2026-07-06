'use strict';
const fs = require('fs');
const path = require('path');
const config = require('./config');
const { db } = require('./db');

// --- Metin filtresi -----------------------------------------------------------
// Türkçe + İngilizce temel küfür/hakaret listesi. Normalizasyon: küçük harf,
// aksan temizleme, leet dönüşümü, tekrar eden harflerin sıkıştırılması.
// Üretimde OpenAI Moderation / Perspective API ile zenginleştirilebilir
// (bkz. checkText içindeki genişletme noktası).

const BAD_WORDS = [
  // Türkçe
  'amk', 'aq', 'amina', 'amini', 'sikeyim', 'sikerim', 'sikik', 'sittir',
  'orospu', 'oruspu', 'pic', 'yavsak', 'pezevenk', 'kahpe', 'gavat',
  'ibne', 'godos', 'yarrak', 'siktir', 'anani', 'avradini', 'serefsiz',
  'salak', 'gerizekali', 'mal misin',
  // İngilizce
  'fuck', 'fucking', 'bitch', 'whore', 'slut', 'cunt', 'faggot', 'nigger',
  'asshole', 'dickhead', 'motherfucker',
];

const LEET_MAP = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '8': 'b', '@': 'a', '$': 's', '!': 'i' };

function normalizeText(text) {
  // 'İ'.toLowerCase() 'i'+U+0307 ürettiği için Türkçe I/İ önce elle eşlenir.
  let t = String(text).replace(/İ/g, 'i').replace(/I/g, 'i').toLowerCase();
  t = t.replace(/ı/g, 'i');
  t = t.normalize('NFD').replace(/[̀-ͯ]/g, ''); // ç->c, ğ->g, ş->s, ö->o, ü->u
  t = t.replace(/[0134578@$!]/g, (ch) => LEET_MAP[ch] || ch);
  return t;
}

function stripSeparators(text) {
  return text.replace(/[\s.\-_*+/\\|,'"`~^]+/g, '');
}

// true dönerse mesaj işaretlenir (yine iletilir ama flagged=1 + güven puanı düşer).
function checkText(text) {
  const norm = normalizeText(text);
  const squeezed = norm.replace(/(.)\1+/g, '$1'); // "siktiiiir" -> "siktir"
  const compact = stripSeparators(norm);
  const compactSqueezed = stripSeparators(squeezed);
  const words = norm.split(/[^a-z]+/).filter(Boolean);
  for (const bad of BAD_WORDS) {
    const badCompact = stripSeparators(bad);
    if (bad.includes(' ')) {
      if (norm.includes(bad) || squeezed.includes(bad)) return { flagged: true, term: bad };
    } else if (words.includes(bad) || compact.includes(badCompact) || compactSqueezed.includes(badCompact)) {
      return { flagged: true, term: bad };
    }
  }
  // Genişletme noktası: harici moderasyon API çağrısı (async kuyruğa atılabilir).
  return { flagged: false };
}

// --- Ban / askı kontrolleri ----------------------------------------------------

function activeBanForPhone(phoneHash) {
  const now = Date.now();
  return db.prepare(
    'SELECT * FROM bans WHERE phone_hash = ? AND (expires_at IS NULL OR expires_at > ?) ORDER BY id DESC LIMIT 1'
  ).get(phoneHash, now) || null;
}

function activeBanForUser(userId) {
  const now = Date.now();
  return db.prepare(
    'SELECT * FROM bans WHERE user_id = ? AND (expires_at IS NULL OR expires_at > ?) ORDER BY id DESC LIMIT 1'
  ).get(userId, now) || null;
}

// Kullanıcının anlık erişim durumu; süresi dolan askıları otomatik kaldırır.
function effectiveStatus(user) {
  if (!user) return 'unknown';
  if (user.status === 'deleted') return 'deleted'; // silinen hesap hiçbir işlem yapamaz
  if (user.status === 'banned') return 'banned';
  if (user.status === 'suspended') {
    if (user.suspended_until && user.suspended_until <= Date.now()) {
      db.prepare("UPDATE users SET status = 'active', suspended_until = NULL WHERE id = ?").run(user.id);
      return 'active';
    }
    return 'suspended';
  }
  return 'active';
}

// --- Raporlama ------------------------------------------------------------------

function saveEvidence(reportTag, base64Jpeg) {
  if (!base64Jpeg) return null;
  try {
    const buf = Buffer.from(base64Jpeg, 'base64');
    if (buf.length === 0 || buf.length > config.SNAPSHOT_MAX_BYTES) return null;
    const name = `${Date.now()}-${reportTag}.jpg`;
    fs.writeFileSync(path.join(config.EVIDENCE_DIR, name), buf);
    return name;
  } catch {
    return null;
  }
}

function createReport({ matchId = null, friendshipId = null, reporterId, reportedId, category, note, snapshotBase64, chatExcerpt = null }) {
  if (!config.REPORT_CATEGORIES.includes(category)) category = 'diger';

  // Tekilleştirme: aynı raporcunun aynı maçı/arkadaşlığı defalarca raporlaması
  // güven puanını drenaj etmesin ve kuyruğu spam'lemesin. Mevcut rapor varsa
  // aynı reportId'yi döndür, yeni yan etki uygulama.
  if (matchId || friendshipId) {
    const existing = db.prepare(
      `SELECT id FROM reports WHERE reporter_id = ? AND reported_id = ?
       AND ((match_id IS NOT NULL AND match_id = ?) OR (friendship_id IS NOT NULL AND friendship_id = ?))
       ORDER BY id DESC LIMIT 1`
    ).get(reporterId, reportedId, matchId ?? -1, friendshipId ?? -1);
    if (existing) return { reportId: existing.id, autoSuspended: false, duplicate: true };
  }

  const evidencePath = saveEvidence(`m${matchId || 0}-u${reportedId}`, snapshotBase64);
  // Sohbet dökümünü güvenli biçimde küçült: her gövdeyi kısalt, sonra bütünü
  // sınırla. JSON.stringify().slice() geçersiz JSON üreteceği için ASLA kullanma.
  let chatExcerptJson = null;
  if (Array.isArray(chatExcerpt) && chatExcerpt.length) {
    const trimmed = chatExcerpt.slice(-20).map((m) => ({
      sender_id: m.sender_id,
      body: String(m.body ?? '').slice(0, 300),
      created_at: m.created_at,
    }));
    chatExcerptJson = JSON.stringify(trimmed);
  }
  const info = db.prepare(
    `INSERT INTO reports (match_id, friendship_id, reporter_id, reported_id, category, note, evidence_path, chat_excerpt, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(matchId, friendshipId, reporterId, reportedId, category,
        note ? String(note).slice(0, config.REPORT_NOTE_MAX_LEN) : null,
        evidencePath, chatExcerptJson, Date.now());

  adjustTrust(reportedId, -5);
  const suspended = maybeAutoSuspend(reportedId);
  return { reportId: Number(info.lastInsertRowid), autoSuspended: suspended };
}

// 24 saat içinde 3 FARKLI kullanıcıdan rapor -> otomatik geçici askı (plan §2.1).
function maybeAutoSuspend(reportedId) {
  const since = Date.now() - config.AUTO_SUSPEND_WINDOW_MS;
  const row = db.prepare(
    'SELECT COUNT(DISTINCT reporter_id) AS c FROM reports WHERE reported_id = ? AND created_at > ?'
  ).get(reportedId, since);
  if (row.c < config.AUTO_SUSPEND_REPORT_COUNT) return false;
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(reportedId);
  if (!user || user.status !== 'active') return false;
  db.prepare("UPDATE users SET status = 'suspended', suspended_until = ? WHERE id = ?")
    .run(Date.now() + config.SUSPEND_DURATION_MS, reportedId);
  adjustTrust(reportedId, -15);
  return true;
}

function adjustTrust(userId, delta) {
  db.prepare('UPDATE users SET trust_score = MAX(0, MIN(100, trust_score + ?)) WHERE id = ?').run(delta, userId);
}

function banUser({ userId, reason, expiresAt = null, adminId = null }) {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user) return false;
  db.prepare('INSERT INTO bans (user_id, phone_hash, reason, expires_at, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?)')
    .run(userId, user.phone_hash, reason || null, expiresAt, Date.now(), adminId);
  db.prepare("UPDATE users SET status = 'banned' WHERE id = ?").run(userId);
  return true;
}

module.exports = {
  checkText, normalizeText,
  activeBanForPhone, activeBanForUser, effectiveStatus,
  createReport, maybeAutoSuspend, adjustTrust, banUser, saveEvidence,
};
