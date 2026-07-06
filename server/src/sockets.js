'use strict';
const config = require('./config');
const { db, getSetting } = require('./db');
const { verifyToken } = require('./auth');
const { Matchmaker } = require('./matchmaking');
const { pickIcebreaker } = require('./icebreakers');
const { checkText, createReport, effectiveStatus, adjustTrust } = require('./moderation');
const { ageFromBirthDate } = require('./util');

// ---------------------------------------------------------------------------
// Durum: tek süreçli MVP'de bellekte tutulur. Redis'e taşıma noktaları:
//  - connectedUsers -> Redis hash + pub/sub (çoklu süreç)
//  - activeMatches  -> Redis hash
// ---------------------------------------------------------------------------

const connectedUsers = new Map(); // userId -> socket
const userMatch = new Map();      // userId -> matchId
const activeMatches = new Map();  // matchId -> state
const recentMatches = new Map();  // matchId -> state (arkadaş ekleme ek süresi için)
const chatRate = new Map();       // userId -> {count, resetAt}

function isBlockedPair(a, b) {
  const row = db.prepare(
    'SELECT 1 FROM blocks WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?) LIMIT 1'
  ).get(a, b, b, a);
  return !!row;
}

function peerViewOf(userId) {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!u) return null;
  return {
    id: u.id,
    displayName: u.display_name,
    age: ageFromBirthDate(u.birth_date),
    interests: JSON.parse(u.interests),
    languages: JSON.parse(u.languages),
    avatarUrl: u.avatar_path ? `/avatars/${u.avatar_path}` : null,
  };
}

function commonInterests(aId, bId) {
  const a = peerViewOf(aId);
  const b = peerViewOf(bId);
  if (!a || !b) return [];
  return a.interests.filter((i) => b.interests.includes(i));
}

function initSockets(io) {
  const matchmaker = new Matchmaker({
    isBlockedPair,
    onMatch(entryA, entryB) {
      const sockA = connectedUsers.get(entryA.userId);
      const sockB = connectedUsers.get(entryB.userId);
      // Kuyruğa girdikten sonra bağlantısı kopan olduysa diğerini geri koy.
      if (!sockA || !sockB) {
        if (sockA) matchmaker.enqueue(entryA);
        if (sockB) matchmaker.enqueue(entryB);
        return;
      }
      const now = Date.now();
      const info = db.prepare(
        'INSERT INTO matches (user_a, user_b, started_at) VALUES (?, ?, ?)'
      ).run(entryA.userId, entryB.userId, now);
      const matchId = Number(info.lastInsertRowid);
      const icebreaker = pickIcebreaker(entryA.mood === entryB.mood ? entryA.mood : 'hafif');
      const state = {
        id: matchId,
        a: { userId: entryA.userId, mood: entryA.mood },
        b: { userId: entryB.userId, mood: entryB.mood },
        startedAt: now,
        friendReq: {},
        endedAt: null,
      };
      activeMatches.set(matchId, state);
      userMatch.set(entryA.userId, matchId);
      userMatch.set(entryB.userId, matchId);

      const common = commonInterests(entryA.userId, entryB.userId);
      // user_a WebRTC teklifini başlatan taraftır.
      sockA.emit('match:found', { matchId, peer: peerViewOf(entryB.userId), commonInterests: common, icebreaker, initiator: true });
      sockB.emit('match:found', { matchId, peer: peerViewOf(entryA.userId), commonInterests: common, icebreaker, initiator: false });
    },
  });
  matchmaker.paused = getSetting('killswitch', '0') === '1';
  matchmaker.start();

  // Arkadaş ekleme ek süresi dolan biten eşleşmeleri temizle.
  const cleanup = setInterval(() => {
    const cutoff = Date.now() - config.FRIEND_GRACE_MS;
    for (const [id, st] of recentMatches) {
      if (st.endedAt && st.endedAt < cutoff) recentMatches.delete(id);
    }
  }, 30 * 1000);
  if (cleanup.unref) cleanup.unref();

  function endMatch(matchId, reason, endedByUserId) {
    const state = activeMatches.get(matchId);
    if (!state) return null;
    activeMatches.delete(matchId);
    state.endedAt = Date.now();
    state.endReason = reason;
    recentMatches.set(matchId, state);

    const durationSec = Math.round((state.endedAt - state.startedAt) / 1000);
    db.prepare('UPDATE matches SET ended_at = ?, end_reason = ?, ended_by = ?, duration_sec = ? WHERE id = ?')
      .run(state.endedAt, reason, endedByUserId || null, durationSec, matchId);

    userMatch.delete(state.a.userId);
    userMatch.delete(state.b.userId);
    matchmaker.notePairEnded(state.a.userId, state.b.userId, reason === 'skip');

    // Telemetri temelli güven ayarı: 5 sn altında geçilen kullanıcı hafif ceza,
    // 2 dk üzeri sohbetlerde iki taraf da hafif ödül alır (plan §4.3 trust_score).
    if (reason === 'skip' && durationSec < 5 && endedByUserId) {
      const skipped = endedByUserId === state.a.userId ? state.b.userId : state.a.userId;
      adjustTrust(skipped, -1);
    } else if (durationSec >= 120) {
      adjustTrust(state.a.userId, +1);
      adjustTrust(state.b.userId, +1);
    }

    for (const side of [state.a, state.b]) {
      const sock = connectedUsers.get(side.userId);
      if (sock) {
        sock.emit('match:ended', {
          matchId,
          reason,
          byPeer: endedByUserId ? endedByUserId !== side.userId : false,
          durationSec,
          canAddFriend: reason !== 'report',
        });
      }
    }
    return state;
  }

  function tryCreateFriendship(state) {
    const { a, b } = state;
    if (!(state.friendReq[a.userId] && state.friendReq[b.userId])) return;
    if (isBlockedPair(a.userId, b.userId)) return;
    const [ua, ub] = a.userId < b.userId ? [a.userId, b.userId] : [b.userId, a.userId];
    let friendshipId;
    try {
      const info = db.prepare('INSERT INTO friendships (user_a, user_b, created_at) VALUES (?, ?, ?)')
        .run(ua, ub, Date.now());
      friendshipId = Number(info.lastInsertRowid);
    } catch {
      const existing = db.prepare('SELECT id FROM friendships WHERE user_a = ? AND user_b = ?').get(ua, ub);
      if (!existing) return;
      friendshipId = existing.id;
    }
    for (const [self, other] of [[a.userId, b.userId], [b.userId, a.userId]]) {
      const sock = connectedUsers.get(self);
      if (sock) sock.emit('friend:new', { friendshipId, friend: peerViewOf(other), matchId: state.id });
    }
  }

  // --- Socket kimlik doğrulaması ---------------------------------------------
  io.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    const payload = token && verifyToken(token, 'user');
    if (!payload) return next(new Error('auth_required'));
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(payload.sub);
    if (!user) return next(new Error('auth_required'));
    const status = effectiveStatus(user);
    if (status === 'deleted') return next(new Error('account_deleted'));
    if (status === 'banned') return next(new Error('banned'));
    if (status === 'suspended') return next(new Error('suspended'));
    socket.data.userId = user.id;
    next();
  });

  io.on('connection', (socket) => {
    const userId = socket.data.userId;

    // Kullanıcı başına tek aktif bağlantı: eskisini düşür.
    const old = connectedUsers.get(userId);
    if (old && old.id !== socket.id) {
      old.emit('session:replaced');
      old.disconnect(true);
    }
    connectedUsers.set(userId, socket);

    // Arkadaşlara çevrimiçi bilgisi gönder.
    notifyPresence(userId, true);

    socket.on('presence:query', (payload, cb) => {
      if (typeof cb !== 'function') return;
      const ids = Array.isArray(payload?.userIds) ? payload.userIds.slice(0, 200) : [];
      cb({ online: ids.filter((id) => connectedUsers.has(id)) });
    });

    // --- Eşleşme kuyruğu ------------------------------------------------------
    socket.on('queue:join', (payload, cb) => {
      const ack = typeof cb === 'function' ? cb : () => {};
      if (getSetting('killswitch', '0') === '1') {
        return ack({ ok: false, error: 'paused', message: 'Eşleşme geçici olarak durduruldu. Kısa süre sonra tekrar deneyin.' });
      }
      const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
      const status = effectiveStatus(user);
      if (status !== 'active') {
        return ack({ ok: false, error: status, message: 'Hesabınız şu anda eşleşmeye kapalı.' });
      }
      if (userMatch.has(userId)) {
        return ack({ ok: false, error: 'in_match', message: 'Zaten bir görüşmedesiniz.' });
      }
      const mood = config.MOODS.includes(payload?.mood) ? payload.mood : 'hafif';

      // Yeni hesap hız limiti (plan §4.3)
      const accountAge = Date.now() - user.created_at;
      if (accountAge < config.NEW_ACCOUNT_WINDOW_MS) {
        const cnt = db.prepare(
          'SELECT COUNT(*) AS c FROM matches WHERE (user_a = ? OR user_b = ?) AND started_at > ?'
        ).get(userId, userId, Date.now() - config.NEW_ACCOUNT_WINDOW_MS).c;
        if (cnt >= config.NEW_ACCOUNT_MATCH_LIMIT) {
          return ack({ ok: false, error: 'rate_limited', message: 'Yeni hesaplar için günlük eşleşme sınırına ulaştınız.' });
        }
      }

      db.prepare('INSERT INTO sessions (user_id, mood, started_at) VALUES (?, ?, ?)').run(userId, mood, Date.now());
      const result = matchmaker.enqueue({
        userId,
        socketId: socket.id,
        mood,
        languages: JSON.parse(user.languages),
        interests: JSON.parse(user.interests),
        age: ageFromBirthDate(user.birth_date),
        trustScore: user.trust_score,
      });
      if (!result.ok) return ack({ ok: false, error: result.reason });
      ack({ ok: true, queueSize: matchmaker.size });
    });

    socket.on('queue:leave', (payload, cb) => {
      matchmaker.dequeue(userId);
      if (typeof cb === 'function') cb({ ok: true });
    });

    // --- WebRTC sinyal aktarımı ----------------------------------------------
    socket.on('rtc:signal', (payload) => {
      const matchId = userMatch.get(userId);
      if (!matchId || payload?.matchId !== matchId) return;
      const state = activeMatches.get(matchId);
      if (!state) return;
      const peerId = state.a.userId === userId ? state.b.userId : state.a.userId;
      const peerSock = connectedUsers.get(peerId);
      if (peerSock) peerSock.emit('rtc:signal', { matchId, data: payload.data });
    });

    // --- Eşleşme yaşam döngüsü -------------------------------------------------
    socket.on('match:skip', (payload, cb) => {
      const matchId = userMatch.get(userId);
      if (!matchId) return typeof cb === 'function' && cb({ ok: false });
      const state = endMatch(matchId, 'skip', userId);
      if (typeof cb === 'function') cb({ ok: !!state });
    });

    socket.on('match:end', (payload, cb) => {
      const matchId = userMatch.get(userId);
      if (!matchId) return typeof cb === 'function' && cb({ ok: false });
      const state = endMatch(matchId, 'leave', userId);
      if (typeof cb === 'function') cb({ ok: !!state });
    });

    socket.on('match:report', (payload, cb) => {
      const ack = typeof cb === 'function' ? cb : () => {};
      const matchId = payload?.matchId ?? userMatch.get(userId);
      const state = activeMatches.get(matchId) || recentMatches.get(matchId);
      if (!state || (state.a.userId !== userId && state.b.userId !== userId)) {
        return ack({ ok: false, error: 'no_match' });
      }
      const reportedId = state.a.userId === userId ? state.b.userId : state.a.userId;
      const { reportId, autoSuspended } = createReport({
        matchId: state.id,
        reporterId: userId,
        reportedId,
        category: payload?.category,
        note: payload?.note,
        snapshotBase64: typeof payload?.snapshot === 'string' ? payload.snapshot : null,
      });
      if (activeMatches.has(state.id)) endMatch(state.id, 'report', userId);
      if (autoSuspended) {
        const sock = connectedUsers.get(reportedId);
        if (sock) {
          sock.emit('account:suspended', { message: 'Hesabınız gelen raporlar nedeniyle geçici olarak askıya alındı.' });
          sock.disconnect(true);
        }
      }
      ack({ ok: true, reportId });
    });

    // --- Arkadaş ekleme (çift taraflı onay, plan §3) ----------------------------
    socket.on('friend:add', (payload, cb) => {
      const ack = typeof cb === 'function' ? cb : () => {};
      const matchId = payload?.matchId ?? userMatch.get(userId);
      const state = activeMatches.get(matchId) || recentMatches.get(matchId);
      if (!state || (state.a.userId !== userId && state.b.userId !== userId)) {
        return ack({ ok: false, error: 'no_match' });
      }
      if (state.endedAt && Date.now() - state.endedAt > config.FRIEND_GRACE_MS) {
        return ack({ ok: false, error: 'expired', message: 'Arkadaş ekleme süresi doldu.' });
      }
      if (state.endReason === 'report') return ack({ ok: false, error: 'not_allowed' });
      state.friendReq[userId] = true;
      const col = state.a.userId === userId ? 'friend_req_a' : 'friend_req_b';
      db.prepare(`UPDATE matches SET ${col} = 1 WHERE id = ?`).run(state.id);
      const peerId = state.a.userId === userId ? state.b.userId : state.a.userId;
      const mutual = !!state.friendReq[peerId];
      // Tek taraflı istek görüşme EKRANINDA gösterilmez (baskı oluşturmasın);
      // karşı taraf isteği Sohbetler'deki istek kutusundan görür ve dilerse
      // sonradan onaylar.
      if (!mutual && !isBlockedPair(userId, peerId)) {
        const peerSock = connectedUsers.get(peerId);
        if (peerSock) {
          peerSock.emit('friend:request', { from: peerViewOf(userId), matchId: state.id });
        }
      }
      tryCreateFriendship(state);
      ack({ ok: true, mutual });
    });

    // --- Kalıcı mesajlaşma ------------------------------------------------------
    socket.on('chat:send', (payload, cb) => {
      const ack = typeof cb === 'function' ? cb : () => {};
      const friendshipId = Number(payload?.friendshipId);
      const body = String(payload?.body ?? '').trim();
      if (!friendshipId || body.length === 0) return ack({ ok: false, error: 'invalid' });
      if (body.length > config.MESSAGE_MAX_LEN) return ack({ ok: false, error: 'too_long', message: 'Mesaj çok uzun.' });

      // Basit hız limiti: 5 saniyede en fazla 10 mesaj.
      const now = Date.now();
      let rate = chatRate.get(userId);
      if (!rate || rate.resetAt < now) { rate = { count: 0, resetAt: now + 5000 }; chatRate.set(userId, rate); }
      rate.count++;
      if (rate.count > 10) return ack({ ok: false, error: 'rate_limited', message: 'Çok hızlı mesaj gönderiyorsunuz.' });

      const f = db.prepare('SELECT * FROM friendships WHERE id = ?').get(friendshipId);
      if (!f || (f.user_a !== userId && f.user_b !== userId)) return ack({ ok: false, error: 'not_found' });
      const peerId = f.user_a === userId ? f.user_b : f.user_a;
      if (isBlockedPair(userId, peerId)) return ack({ ok: false, error: 'blocked' });

      const peerUser = db.prepare('SELECT * FROM users WHERE id = ?').get(peerId);
      if (!peerUser || peerUser.status === 'deleted') return ack({ ok: false, error: 'peer_gone' });

      // Metin moderasyonu mesajlarda da çalışır (plan §3).
      const mod = checkText(body);
      if (mod.flagged) adjustTrust(userId, -2);

      const info = db.prepare(
        'INSERT INTO messages (friendship_id, sender_id, body, flagged, created_at) VALUES (?, ?, ?, ?, ?)'
      ).run(friendshipId, userId, body, mod.flagged ? 1 : 0, now);
      const message = {
        id: Number(info.lastInsertRowid),
        friendshipId,
        senderId: userId,
        body,
        flagged: mod.flagged,
        createdAt: now,
      };
      const peerSock = connectedUsers.get(peerId);
      if (peerSock) peerSock.emit('chat:message', { message });
      // Çevrimdışıysa: FCM/APNs push entegrasyon noktası (README'de anlatılıyor).
      ack({ ok: true, message, tempId: payload?.tempId });
    });

    socket.on('chat:read', (payload) => {
      const friendshipId = Number(payload?.friendshipId);
      if (!friendshipId) return;
      const f = db.prepare('SELECT * FROM friendships WHERE id = ?').get(friendshipId);
      if (!f || (f.user_a !== userId && f.user_b !== userId)) return;
      db.prepare(
        'UPDATE messages SET read_at = ? WHERE friendship_id = ? AND sender_id != ? AND read_at IS NULL'
      ).run(Date.now(), friendshipId, userId);
      const peerId = f.user_a === userId ? f.user_b : f.user_a;
      const peerSock = connectedUsers.get(peerId);
      if (peerSock) peerSock.emit('chat:read', { friendshipId, readerId: userId });
    });

    // --- Kopma ------------------------------------------------------------------
    socket.on('disconnect', () => {
      if (connectedUsers.get(userId)?.id === socket.id) {
        connectedUsers.delete(userId);
        notifyPresence(userId, false);
      }
      matchmaker.dequeue(userId);
      const matchId = userMatch.get(userId);
      if (matchId) endMatch(matchId, 'disconnect', userId);
    });
  });

  function notifyPresence(userId, online) {
    const rows = db.prepare(
      'SELECT user_a, user_b FROM friendships WHERE user_a = ? OR user_b = ?'
    ).all(userId, userId);
    for (const r of rows) {
      const friendId = r.user_a === userId ? r.user_b : r.user_a;
      const sock = connectedUsers.get(friendId);
      if (sock) sock.emit('friend:presence', { userId, online });
    }
  }

  return {
    matchmaker,
    isOnline: (userId) => connectedUsers.has(userId),
    onlineCount: () => connectedUsers.size,
    activeMatchCount: () => activeMatches.size,
    queueSize: () => matchmaker.size,
    disconnectUser: (userId) => {
      const sock = connectedUsers.get(userId);
      if (sock) sock.disconnect(true);
    },
    emitToUser: (userId, event, payload) => {
      const sock = connectedUsers.get(userId);
      if (sock) sock.emit(event, payload);
    },
  };
}

module.exports = { initSockets };
