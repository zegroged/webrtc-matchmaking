'use strict';
const express = require('express');
const config = require('./config');
const { db } = require('./db');
const { requireUser, publicUser } = require('./auth');
const { ageFromBirthDate } = require('./util');
const { createReport } = require('./moderation');

const router = express.Router();
router.use(requireUser);

// Karşı tarafa gösterilen kısıtlı profil.
function peerView(u) {
  return {
    id: u.id,
    displayName: u.display_name,
    age: ageFromBirthDate(u.birth_date),
    interests: JSON.parse(u.interests),
    languages: JSON.parse(u.languages),
  };
}

router.get('/me', (req, res) => {
  res.json({ user: publicUser(req.user), status: req.userStatus, config: {
    languages: config.LANGUAGES,
    interests: config.INTERESTS,
    moods: config.MOODS,
    reportCategories: config.REPORT_CATEGORIES,
  }});
});

// Doğum tarihi KİLİTLİ — sadece isim/dil/ilgi güncellenebilir (plan §2.1).
router.put('/me', (req, res) => {
  const { displayName, languages, interests } = req.body || {};
  const updates = {};
  if (displayName !== undefined) {
    const name = String(displayName).trim();
    if (name.length < 2 || name.length > 30) return res.status(400).json({ error: 'invalid_name', message: 'İsim 2-30 karakter olmalı.' });
    updates.display_name = name;
  }
  if (languages !== undefined) {
    const langs = Array.isArray(languages) ? languages.filter((l) => config.LANGUAGES.includes(l)) : [];
    if (langs.length < 1) return res.status(400).json({ error: 'invalid_languages', message: 'En az bir dil seçin.' });
    updates.languages = JSON.stringify(langs);
  }
  if (interests !== undefined) {
    const ints = Array.isArray(interests) ? [...new Set(interests.filter((i) => config.INTERESTS.includes(i)))] : [];
    if (ints.length !== config.INTEREST_COUNT) return res.status(400).json({ error: 'invalid_interests', message: `Tam olarak ${config.INTEREST_COUNT} ilgi alanı seçin.` });
    updates.interests = JSON.stringify(ints);
  }
  if (req.body?.birthDate !== undefined) {
    // Değişiklik girişimi = otomatik inceleme bayrağı (plan §4.3)
    console.warn(`[guvenlik] Kullanıcı ${req.user.id} doğum tarihi değiştirmeye çalıştı.`);
    return res.status(403).json({ error: 'birth_date_locked', message: 'Doğum tarihi değiştirilemez. Destek ekibiyle iletişime geçin.' });
  }
  const keys = Object.keys(updates);
  if (keys.length === 0) return res.status(400).json({ error: 'nothing_to_update' });
  const setClause = keys.map((k) => `${k} = ?`).join(', ');
  db.prepare(`UPDATE users SET ${setClause} WHERE id = ?`).run(...keys.map((k) => updates[k]), req.user.id);
  const fresh = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  res.json({ ok: true, user: publicUser(fresh) });
});

// Hesap silme — mağaza zorunluluğu (plan §6). Kişisel veri anonimleştirilir,
// moderasyon kanıtları (raporlar/banlar) yasal gerekçeyle tutulur.
router.delete('/me', (req, res) => {
  const uid = req.user.id;
  const tx = () => {
    db.prepare('DELETE FROM messages WHERE friendship_id IN (SELECT id FROM friendships WHERE user_a = ? OR user_b = ?)').run(uid, uid);
    db.prepare('DELETE FROM friendships WHERE user_a = ? OR user_b = ?').run(uid, uid);
    db.prepare('DELETE FROM blocks WHERE blocker_id = ? OR blocked_id = ?').run(uid, uid);
    db.prepare(
      "UPDATE users SET display_name = 'Silinmiş Kullanıcı', phone_hash = 'deleted:' || id || ':' || ?, languages = '[]', interests = '[]', status = 'deleted' WHERE id = ?"
    ).run(Date.now(), uid);
  };
  db.exec('BEGIN');
  try { tx(); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; }
  res.json({ ok: true });
});

// --- Arkadaşlar & sohbetler -------------------------------------------------------

router.get('/friends', (req, res) => {
  const uid = req.user.id;
  const rows = db.prepare(
    `SELECT f.id AS friendship_id, f.created_at,
            u.id AS friend_id, u.display_name, u.birth_date, u.interests, u.languages, u.status
     FROM friendships f
     JOIN users u ON u.id = CASE WHEN f.user_a = ? THEN f.user_b ELSE f.user_a END
     WHERE f.user_a = ? OR f.user_b = ?
     ORDER BY f.created_at DESC`
  ).all(uid, uid, uid);

  const lastMsgStmt = db.prepare(
    'SELECT body, sender_id, created_at, flagged FROM messages WHERE friendship_id = ? ORDER BY id DESC LIMIT 1'
  );
  const unreadStmt = db.prepare(
    'SELECT COUNT(*) AS c FROM messages WHERE friendship_id = ? AND sender_id != ? AND read_at IS NULL'
  );

  const friends = rows.map((r) => {
    const last = lastMsgStmt.get(r.friendship_id);
    const unread = unreadStmt.get(r.friendship_id, uid).c;
    return {
      friendshipId: r.friendship_id,
      createdAt: r.created_at,
      friend: {
        id: r.friend_id,
        displayName: r.status === 'deleted' ? 'Silinmiş Kullanıcı' : r.display_name,
        age: ageFromBirthDate(r.birth_date),
        interests: JSON.parse(r.interests || '[]'),
        deleted: r.status === 'deleted',
      },
      lastMessage: last ? { body: last.flagged ? '⚠ filtrelenen mesaj' : last.body, senderId: last.sender_id, createdAt: last.created_at } : null,
      unread,
    };
  });
  res.json({ friends });
});

function findFriendship(friendshipId, uid) {
  const f = db.prepare('SELECT * FROM friendships WHERE id = ?').get(friendshipId);
  if (!f || (f.user_a !== uid && f.user_b !== uid)) return null;
  return f;
}

router.get('/friends/:friendshipId/messages', (req, res) => {
  const f = findFriendship(Number(req.params.friendshipId), req.user.id);
  if (!f) return res.status(404).json({ error: 'not_found' });
  const before = Number(req.query.before) || Number.MAX_SAFE_INTEGER;
  const limit = Math.min(Number(req.query.limit) || 50, 100);
  const msgs = db.prepare(
    'SELECT id, sender_id, body, flagged, created_at, read_at FROM messages WHERE friendship_id = ? AND id < ? ORDER BY id DESC LIMIT ?'
  ).all(f.id, before, limit).reverse();
  res.json({
    messages: msgs.map((m) => ({
      id: m.id, senderId: m.sender_id, body: m.body, flagged: !!m.flagged,
      createdAt: m.created_at, readAt: m.read_at,
    })),
  });
});

// Arkadaşlıktan çıkar (mesaj geçmişi silinir).
router.delete('/friends/:friendshipId', (req, res) => {
  const f = findFriendship(Number(req.params.friendshipId), req.user.id);
  if (!f) return res.status(404).json({ error: 'not_found' });
  db.prepare('DELETE FROM messages WHERE friendship_id = ?').run(f.id);
  db.prepare('DELETE FROM friendships WHERE id = ?').run(f.id);
  res.json({ ok: true });
});

// Engelle: arkadaşlık silinir + bir daha asla eşleşemez + yazamaz (plan §3).
router.post('/blocks/:userId', (req, res) => {
  const targetId = Number(req.params.userId);
  const target = db.prepare('SELECT id FROM users WHERE id = ?').get(targetId);
  if (!target || targetId === req.user.id) return res.status(400).json({ error: 'invalid_target' });
  db.prepare('INSERT OR IGNORE INTO blocks (blocker_id, blocked_id, created_at) VALUES (?, ?, ?)')
    .run(req.user.id, targetId, Date.now());
  const f = db.prepare(
    'SELECT * FROM friendships WHERE (user_a = ? AND user_b = ?) OR (user_a = ? AND user_b = ?)'
  ).get(Math.min(req.user.id, targetId), Math.max(req.user.id, targetId), Math.max(req.user.id, targetId), Math.min(req.user.id, targetId));
  if (f) {
    db.prepare('DELETE FROM messages WHERE friendship_id = ?').run(f.id);
    db.prepare('DELETE FROM friendships WHERE id = ?').run(f.id);
  }
  res.json({ ok: true });
});

// Sohbet içi raporlama: son mesajlar kanıt olarak eklenir (plan §3).
router.post('/friends/:friendshipId/report', (req, res) => {
  const f = findFriendship(Number(req.params.friendshipId), req.user.id);
  if (!f) return res.status(404).json({ error: 'not_found' });
  const reportedId = f.user_a === req.user.id ? f.user_b : f.user_a;
  const excerpt = db.prepare(
    'SELECT sender_id, body, created_at FROM messages WHERE friendship_id = ? ORDER BY id DESC LIMIT 20'
  ).all(f.id).reverse();
  const { reportId, autoSuspended } = createReport({
    friendshipId: f.id,
    reporterId: req.user.id,
    reportedId,
    category: req.body?.category,
    note: req.body?.note,
    chatExcerpt: excerpt,
  });
  res.json({ ok: true, reportId, autoSuspended });
});

// WebRTC ICE yapılandırması (STUN/TURN) — istemciler dinamik çeker.
router.get('/rtc-config', (req, res) => {
  res.json({ iceServers: config.ICE_SERVERS });
});

module.exports = { router, peerView };
