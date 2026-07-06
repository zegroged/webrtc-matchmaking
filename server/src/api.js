'use strict';
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');
const { db } = require('./db');
const { requireUser, publicUser } = require('./auth');
const { ageFromBirthDate } = require('./util');
const { createReport, effectiveStatus } = require('./moderation');

const router = express.Router();

// Socket hub kancaları index.js tarafından bağlanır (oturum düşürme + canlı bildirim).
let hub = { disconnectUser: () => {}, emitToUser: () => {} };
function attachHub(h) { hub = h; }

router.use(requireUser);

// Karşı tarafa gösterilen kısıtlı profil.
function peerView(u) {
  return {
    id: u.id,
    displayName: u.display_name,
    age: ageFromBirthDate(u.birth_date),
    interests: JSON.parse(u.interests),
    languages: JSON.parse(u.languages),
    avatarUrl: u.avatar_path ? `/avatars/${u.avatar_path}` : null,
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
      "UPDATE users SET display_name = 'Silinmiş Kullanıcı', phone_hash = 'deleted:' || id || ':' || ?, languages = '[]', interests = '[]', avatar_path = NULL, status = 'deleted' WHERE id = ?"
    ).run(Date.now(), uid);
  };
  db.exec('BEGIN');
  try { tx(); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; }
  // Profil fotoğrafı diskte yetim kalmasın: hesap silinince dosya da silinir.
  removeAvatarFile(req.user.avatar_path);
  // Aktif socket'i düşür: kuyruktan çıkar, varsa görüşmeyi bitir (disconnect
  // handler'ı bunları yapar). Böylece silinen hesap anında pasifleşir.
  hub.disconnectUser(uid);
  res.json({ ok: true });
});

// --- Profil fotoğrafı ---------------------------------------------------------------

const IMAGE_MAGIC = [
  { ext: 'jpg', bytes: [0xff, 0xd8, 0xff] },
  { ext: 'png', bytes: [0x89, 0x50, 0x4e, 0x47] },
  { ext: 'webp', bytes: [0x52, 0x49, 0x46, 0x46] }, // RIFF....WEBP
];

function detectImage(buf) {
  for (const m of IMAGE_MAGIC) {
    if (buf.length > m.bytes.length && m.bytes.every((b, i) => buf[i] === b)) {
      // RIFF konteyneri tek başına yeterli değil (WAV/AVI de RIFF'tir):
      // 8-11. baytlarda 'WEBP' imzası şart.
      if (m.ext === 'webp') {
        if (buf.length >= 12 && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp';
        return null;
      }
      return m.ext;
    }
  }
  return null;
}

function removeAvatarFile(avatarPath) {
  if (!avatarPath) return;
  try { fs.unlinkSync(path.join(config.AVATAR_DIR, path.basename(avatarPath))); } catch {}
}

// Fotoğraf base64 JSON olarak gelir (istemci zaten 512px'e küçültüp sıkıştırıyor).
// Dosya adı tahmin edilemez rastgele bileşen içerir; /avatars altında kimliksiz
// servis edilir (URL yalnızca eşleştiğin kişilere ve arkadaşlara verilir).
router.post('/me/avatar', (req, res) => {
  const b64 = req.body?.imageBase64;
  if (typeof b64 !== 'string' || b64.length < 8) {
    return res.status(400).json({ error: 'invalid_image', message: 'Görsel verisi eksik.' });
  }
  let buf;
  try { buf = Buffer.from(b64, 'base64'); } catch { buf = null; }
  if (!buf || buf.length === 0 || buf.length > config.AVATAR_MAX_BYTES) {
    return res.status(400).json({ error: 'invalid_image', message: 'Görsel en fazla 2MB olabilir.' });
  }
  const ext = detectImage(buf);
  if (!ext) {
    return res.status(400).json({ error: 'invalid_image', message: 'Yalnızca JPEG, PNG veya WebP yükleyebilirsiniz.' });
  }
  const name = `u${req.user.id}-${crypto.randomBytes(8).toString('hex')}.${ext}`;
  fs.writeFileSync(path.join(config.AVATAR_DIR, name), buf);
  removeAvatarFile(req.user.avatar_path);
  db.prepare('UPDATE users SET avatar_path = ? WHERE id = ?').run(name, req.user.id);
  res.json({ ok: true, avatarUrl: `/avatars/${name}` });
});

router.delete('/me/avatar', (req, res) => {
  removeAvatarFile(req.user.avatar_path);
  db.prepare('UPDATE users SET avatar_path = NULL WHERE id = ?').run(req.user.id);
  res.json({ ok: true });
});

// --- Arkadaşlık isteği kutusu ---------------------------------------------------------
// Tek taraflı kalan istekler (ör. yanlışlıkla geçilen eşleşmeler) burada listelenir;
// alıcı dilediği zaman onaylayabilir veya sessizce reddedebilir (istek sahibi
// reddedildiğini asla öğrenmez).

function friendshipExists(a, b) {
  const [ua, ub] = a < b ? [a, b] : [b, a];
  return !!db.prepare('SELECT 1 FROM friendships WHERE user_a = ? AND user_b = ?').get(ua, ub);
}

function isBlockedPair(a, b) {
  return !!db.prepare(
    'SELECT 1 FROM blocks WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?) LIMIT 1'
  ).get(a, b, b, a);
}

// Bana gelen bekleyen istekler: karşı taraf istemiş, ben istememişim/reddetmemişim.
function pendingRequestsFor(uid) {
  const since = Date.now() - config.FRIEND_REQUEST_TTL_MS;
  const rows = db.prepare(
    `SELECT m.id AS match_id, m.started_at, m.ended_at, m.duration_sec,
            u.id AS peer_id, u.display_name, u.birth_date, u.interests, u.avatar_path, u.status AS peer_status
     FROM matches m
     JOIN users u ON u.id = CASE WHEN m.user_a = ? THEN m.user_b ELSE m.user_a END
     WHERE ((m.user_b = ? AND m.friend_req_a = 1 AND m.friend_req_b = 0 AND m.req_declined_b = 0)
         OR (m.user_a = ? AND m.friend_req_b = 1 AND m.friend_req_a = 0 AND m.req_declined_a = 0))
       AND (m.end_reason IS NULL OR m.end_reason != 'report')
       AND m.started_at > ?
       AND (u.status = 'active'
            OR (u.status = 'suspended' AND u.suspended_until IS NOT NULL AND u.suspended_until <= ?))
     ORDER BY m.started_at DESC`
  ).all(uid, uid, uid, since, Date.now());

  // Aynı kişiden birden çok eşleşme varsa en yenisi kalır; engelli/mevcut
  // arkadaşlar elenir.
  const seen = new Set();
  const requests = [];
  for (const r of rows) {
    if (seen.has(r.peer_id)) continue;
    seen.add(r.peer_id);
    if (friendshipExists(uid, r.peer_id) || isBlockedPair(uid, r.peer_id)) continue;
    requests.push({
      matchId: r.match_id,
      matchedAt: r.started_at,
      durationSec: r.duration_sec,
      from: {
        id: r.peer_id,
        displayName: r.display_name,
        age: ageFromBirthDate(r.birth_date),
        interests: JSON.parse(r.interests || '[]'),
        avatarUrl: r.avatar_path ? `/avatars/${r.avatar_path}` : null,
      },
    });
  }
  return requests;
}

router.get('/friend-requests', (req, res) => {
  res.json({ requests: pendingRequestsFor(req.user.id) });
});

// İsteğin geldiği eşleşmeyi bul ve benim taraf kolonlarımı döndür.
function requestMatchFor(uid, matchId) {
  const m = db.prepare('SELECT * FROM matches WHERE id = ?').get(matchId);
  if (!m) return null;
  // Raporla biten eşleşme asla arkadaşlığa dönüşemez (socket tarafıyla tutarlı).
  if (m.end_reason === 'report') return null;
  if (m.user_a === uid && m.friend_req_b === 1 && m.friend_req_a === 0) {
    return { m, myReqCol: 'friend_req_a', myDeclineCol: 'req_declined_a', peerId: m.user_b };
  }
  if (m.user_b === uid && m.friend_req_a === 1 && m.friend_req_b === 0) {
    return { m, myReqCol: 'friend_req_b', myDeclineCol: 'req_declined_b', peerId: m.user_a };
  }
  return null;
}

router.post('/friend-requests/:matchId/accept', (req, res) => {
  const ctx = requestMatchFor(req.user.id, Number(req.params.matchId));
  if (!ctx) return res.status(404).json({ error: 'not_found', message: 'Bekleyen istek bulunamadı.' });
  const { m, myReqCol, peerId } = ctx;
  if (isBlockedPair(req.user.id, peerId)) return res.status(400).json({ error: 'blocked' });
  const peer = db.prepare('SELECT * FROM users WHERE id = ?').get(peerId);
  // effectiveStatus süresi dolan askıyı da temizler (ham kolon okuma yanılgısı olmasın).
  if (!peer || effectiveStatus(peer) !== 'active') {
    return res.status(400).json({ error: 'peer_unavailable', message: 'Bu kullanıcı artık uygun değil.' });
  }

  db.prepare(`UPDATE matches SET ${myReqCol} = 1 WHERE id = ?`).run(m.id);
  const [ua, ub] = req.user.id < peerId ? [req.user.id, peerId] : [peerId, req.user.id];
  let friendshipId;
  try {
    friendshipId = Number(
      db.prepare('INSERT INTO friendships (user_a, user_b, created_at) VALUES (?, ?, ?)')
        .run(ua, ub, Date.now()).lastInsertRowid
    );
  } catch {
    friendshipId = db.prepare('SELECT id FROM friendships WHERE user_a = ? AND user_b = ?').get(ua, ub)?.id;
  }
  if (!friendshipId) return res.status(500).json({ error: 'friendship_failed' });

  // İki tarafa da canlı bildir (çevrimiçilerse).
  const meView = peerView(req.user);
  hub.emitToUser(peerId, 'friend:new', { friendshipId, friend: meView, matchId: m.id });
  hub.emitToUser(req.user.id, 'friend:new', { friendshipId, friend: peerView(peer), matchId: m.id });
  res.json({ ok: true, friendshipId });
});

router.post('/friend-requests/:matchId/decline', (req, res) => {
  const ctx = requestMatchFor(req.user.id, Number(req.params.matchId));
  if (!ctx) return res.status(404).json({ error: 'not_found' });
  // Aynı kişiyle birden çok eşleşmeden istek varsa hepsini reddet;
  // aksi halde reddedilen kişi eski bir eşleşme üzerinden yeniden belirir.
  const uid = req.user.id;
  db.prepare(
    'UPDATE matches SET req_declined_b = 1 WHERE user_b = ? AND user_a = ? AND friend_req_a = 1 AND friend_req_b = 0'
  ).run(uid, ctx.peerId);
  db.prepare(
    'UPDATE matches SET req_declined_a = 1 WHERE user_a = ? AND user_b = ? AND friend_req_b = 1 AND friend_req_a = 0'
  ).run(uid, ctx.peerId);
  res.json({ ok: true }); // istek sahibine hiçbir bildirim gitmez
});

// --- Arkadaşlar & sohbetler -------------------------------------------------------

router.get('/friends', (req, res) => {
  const uid = req.user.id;
  const rows = db.prepare(
    `SELECT f.id AS friendship_id, f.created_at,
            u.id AS friend_id, u.display_name, u.birth_date, u.interests, u.languages, u.status, u.avatar_path
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
        avatarUrl: r.status !== 'deleted' && r.avatar_path ? `/avatars/${r.avatar_path}` : null,
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

module.exports = { router, peerView, attachHub };
