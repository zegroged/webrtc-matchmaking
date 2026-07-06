'use strict';
const express = require('express');
const path = require('path');
const jwt = require('jsonwebtoken');
const config = require('./config');
const { db, getSetting, setSetting, scryptVerify } = require('./db');
const { banUser, adjustTrust } = require('./moderation');

// initSockets'ten dönen kancalar index.js tarafından buraya bağlanır.
let hub = { isOnline: () => false, onlineCount: () => 0, activeMatchCount: () => 0, queueSize: () => 0, disconnectUser: () => {}, matchmaker: null };
function attachHub(h) { hub = h; }

const router = express.Router();

function signAdminToken(adminId) {
  return jwt.sign({ sub: adminId, kind: 'admin' }, config.JWT_SECRET, { expiresIn: config.ADMIN_JWT_EXPIRES });
}

// Tek bozuk kayıt tüm rapor kuyruğunu 500'e düşürmesin diye güvenli JSON.parse.
function safeParse(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
}

function requireAdmin(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  try {
    const payload = jwt.verify(token, config.JWT_SECRET);
    if (payload.kind !== 'admin') throw new Error();
    req.adminId = payload.sub;
    next();
  } catch {
    res.status(401).json({ error: 'admin_auth_required' });
  }
}

router.post('/login', (req, res) => {
  const { username, password } = req.body || {};
  const account = db.prepare('SELECT * FROM admin_accounts WHERE username = ?').get(String(username || ''));
  if (!account || !scryptVerify(String(password || ''), account.pass_hash)) {
    return res.status(401).json({ error: 'invalid_credentials', message: 'Kullanıcı adı veya şifre hatalı.' });
  }
  res.json({ ok: true, token: signAdminToken(account.id) });
});

router.use(requireAdmin);

// --- Panel metrikleri (plan §5'teki ölçüler) -------------------------------------
router.get('/dashboard', (req, res) => {
  const now = Date.now();
  const dayAgo = now - 24 * 60 * 60 * 1000;
  const q = (sql, ...args) => db.prepare(sql).get(...args);

  const totalUsers = q("SELECT COUNT(*) AS c FROM users WHERE status != 'deleted'").c;
  const newUsers24h = q("SELECT COUNT(*) AS c FROM users WHERE created_at > ? AND status != 'deleted'", dayAgo).c;
  const suspended = q("SELECT COUNT(*) AS c FROM users WHERE status = 'suspended'").c;
  const banned = q("SELECT COUNT(*) AS c FROM users WHERE status = 'banned'").c;
  const matches24h = q('SELECT COUNT(*) AS c FROM matches WHERE started_at > ?', dayAgo).c;
  const avgDuration = q('SELECT AVG(duration_sec) AS v FROM matches WHERE ended_at IS NOT NULL AND started_at > ?', dayAgo).v;
  const skipRate = q(
    "SELECT CAST(SUM(CASE WHEN end_reason = 'skip' THEN 1 ELSE 0 END) AS REAL) / MAX(COUNT(*), 1) AS v FROM matches WHERE ended_at IS NOT NULL AND started_at > ?", dayAgo).v;
  const mutualFriend = q(
    'SELECT CAST(SUM(CASE WHEN friend_req_a = 1 AND friend_req_b = 1 THEN 1 ELSE 0 END) AS REAL) / MAX(COUNT(*), 1) AS v FROM matches WHERE started_at > ?', dayAgo).v;
  const pendingReports = q("SELECT COUNT(*) AS c FROM reports WHERE status = 'pending'").c;
  const messages24h = q('SELECT COUNT(*) AS c FROM messages WHERE created_at > ?', dayAgo).c;
  const flagged24h = q('SELECT COUNT(*) AS c FROM messages WHERE created_at > ? AND flagged = 1', dayAgo).c;

  res.json({
    online: hub.onlineCount(),
    inQueue: hub.queueSize(),
    activeMatches: hub.activeMatchCount(),
    killswitch: getSetting('killswitch', '0') === '1',
    totalUsers, newUsers24h, suspended, banned,
    matches24h,
    avgDurationSec: avgDuration ? Math.round(avgDuration) : 0,
    skipRate: skipRate || 0,
    mutualFriendRate: mutualFriend || 0,   // kuzey yıldızı metrik (plan §5)
    pendingReports, messages24h, flagged24h,
  });
});

// --- Rapor kuyruğu ----------------------------------------------------------------
router.get('/reports', (req, res) => {
  const status = req.query.status === 'reviewed' ? 'reviewed' : 'pending';
  const rows = db.prepare(
    `SELECT r.*,
            reporter.display_name AS reporter_name,
            reported.display_name AS reported_name,
            reported.trust_score  AS reported_trust,
            reported.status       AS reported_status
     FROM reports r
     JOIN users reporter ON reporter.id = r.reporter_id
     JOIN users reported ON reported.id = r.reported_id
     WHERE r.status = ?
     ORDER BY r.created_at ${status === 'pending' ? 'ASC' : 'DESC'}
     LIMIT 100`
  ).all(status);
  res.json({
    reports: rows.map((r) => ({
      id: r.id, matchId: r.match_id, friendshipId: r.friendship_id,
      category: r.category, note: r.note,
      evidenceUrl: r.evidence_path ? `/api/admin/evidence/${r.evidence_path}` : null,
      chatExcerpt: safeParse(r.chat_excerpt),
      createdAt: r.created_at, status: r.status, actionTaken: r.action_taken,
      reporter: { id: r.reporter_id, name: r.reporter_name },
      reported: { id: r.reported_id, name: r.reported_name, trust: r.reported_trust, status: r.reported_status },
    })),
  });
});

// Kanıt görselleri sadece admin oturumuyla erişilebilir.
router.get('/evidence/:file', (req, res) => {
  const file = path.basename(req.params.file); // path traversal engeli
  res.sendFile(path.join(config.EVIDENCE_DIR, file), (err) => {
    if (err) res.status(404).json({ error: 'not_found' });
  });
});

// Rapor kararı: dismissed | warned | suspended | banned
router.post('/reports/:id/resolve', (req, res) => {
  const report = db.prepare('SELECT * FROM reports WHERE id = ?').get(Number(req.params.id));
  if (!report) return res.status(404).json({ error: 'not_found' });
  // Çift/çelişkili moderasyon aksiyonunu engelle: yalnızca bekleyen raporlar çözülebilir.
  if (report.status !== 'pending') return res.status(409).json({ error: 'already_reviewed', message: 'Bu rapor zaten incelenmiş.' });
  const action = String(req.body?.action || '');
  const valid = ['dismissed', 'warned', 'suspended', 'banned'];
  if (!valid.includes(action)) return res.status(400).json({ error: 'invalid_action' });

  if (action === 'suspended') {
    // Banlı kullanıcının durumunu ezip banı fiilen kaldırmayı önle.
    db.prepare("UPDATE users SET status = 'suspended', suspended_until = ? WHERE id = ? AND status != 'banned'")
      .run(Date.now() + config.SUSPEND_DURATION_MS, report.reported_id);
    adjustTrust(report.reported_id, -10);
    hub.disconnectUser(report.reported_id);
  } else if (action === 'banned') {
    banUser({ userId: report.reported_id, reason: `Rapor #${report.id} (${report.category})`, adminId: req.adminId });
    hub.disconnectUser(report.reported_id);
  } else if (action === 'warned') {
    adjustTrust(report.reported_id, -5);
  } else if (action === 'dismissed') {
    // Haksız rapor: raporlanan kişiye puan iadesi.
    adjustTrust(report.reported_id, +5);
  }
  db.prepare("UPDATE reports SET status = 'reviewed', action_taken = ?, reviewed_at = ?, reviewed_by = ? WHERE id = ?")
    .run(action, Date.now(), req.adminId, report.id);
  res.json({ ok: true });
});

// --- Kullanıcı yönetimi --------------------------------------------------------------
router.get('/users', (req, res) => {
  const search = String(req.query.q || '').trim();
  const rows = search
    ? db.prepare("SELECT * FROM users WHERE (display_name LIKE ? OR id = ?) AND status != 'deleted' ORDER BY id DESC LIMIT 50")
        .all(`%${search}%`, Number(search) || -1)
    : db.prepare("SELECT * FROM users WHERE status != 'deleted' ORDER BY id DESC LIMIT 50").all();
  res.json({
    users: rows.map((u) => ({
      id: u.id, displayName: u.display_name, birthDate: u.birth_date,
      status: u.status, suspendedUntil: u.suspended_until, trustScore: u.trust_score,
      createdAt: u.created_at, online: hub.isOnline(u.id),
      reportCount: db.prepare('SELECT COUNT(*) AS c FROM reports WHERE reported_id = ?').get(u.id).c,
    })),
  });
});

router.post('/users/:id/ban', (req, res) => {
  const userId = Number(req.params.id);
  const days = req.body?.days ? Number(req.body.days) : null;
  const ok = banUser({
    userId,
    reason: String(req.body?.reason || 'Yönetici kararı'),
    expiresAt: days ? Date.now() + days * 24 * 60 * 60 * 1000 : null,
    adminId: req.adminId,
  });
  if (!ok) return res.status(404).json({ error: 'not_found' });
  hub.disconnectUser(userId);
  res.json({ ok: true });
});

router.post('/users/:id/unban', (req, res) => {
  const userId = Number(req.params.id);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user) return res.status(404).json({ error: 'not_found' });
  db.prepare('UPDATE bans SET expires_at = ? WHERE user_id = ? AND (expires_at IS NULL OR expires_at > ?)')
    .run(Date.now(), userId, Date.now());
  db.prepare("UPDATE users SET status = 'active', suspended_until = NULL WHERE id = ?").run(userId);
  res.json({ ok: true });
});

router.post('/users/:id/unsuspend', (req, res) => {
  const userId = Number(req.params.id);
  db.prepare("UPDATE users SET status = 'active', suspended_until = NULL WHERE id = ? AND status = 'suspended'").run(userId);
  res.json({ ok: true });
});

// --- Ban listesi -----------------------------------------------------------------------
router.get('/bans', (req, res) => {
  const rows = db.prepare(
    `SELECT b.*, u.display_name FROM bans b LEFT JOIN users u ON u.id = b.user_id
     WHERE b.expires_at IS NULL OR b.expires_at > ? ORDER BY b.created_at DESC LIMIT 100`
  ).all(Date.now());
  res.json({
    bans: rows.map((b) => ({
      id: b.id, userId: b.user_id, name: b.display_name || '(silinmiş)',
      reason: b.reason, expiresAt: b.expires_at, createdAt: b.created_at,
    })),
  });
});

// --- Acil durdurma (plan §4.4) -----------------------------------------------------------
router.post('/killswitch', (req, res) => {
  const on = !!req.body?.on;
  setSetting('killswitch', on ? '1' : '0');
  if (hub.matchmaker) hub.matchmaker.paused = on;
  res.json({ ok: true, killswitch: on });
});

module.exports = { router, attachHub };
