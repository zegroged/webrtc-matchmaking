'use strict';
const express = require('express');
const jwt = require('jsonwebtoken');
const config = require('./config');
const { db } = require('./db');
const { hashPhone, normalizePhone, randomOtp, isValidBirthDate, ageFromBirthDate } = require('./util');
const { activeBanForPhone, effectiveStatus } = require('./moderation');
const { sendSms } = require('./sms');

const router = express.Router();

function signUserToken(userId) {
  return jwt.sign({ sub: userId, kind: 'user' }, config.JWT_SECRET, { expiresIn: config.JWT_EXPIRES });
}

function signRegistrationToken(phoneHash) {
  return jwt.sign({ ph: phoneHash, kind: 'register' }, config.JWT_SECRET, { expiresIn: '30m' });
}

function verifyToken(token, expectedKind) {
  try {
    const payload = jwt.verify(token, config.JWT_SECRET);
    if (payload.kind !== expectedKind) return null;
    return payload;
  } catch {
    return null;
  }
}

function publicUser(u) {
  return {
    id: u.id,
    displayName: u.display_name,
    birthDate: u.birth_date,
    age: ageFromBirthDate(u.birth_date),
    languages: JSON.parse(u.languages),
    interests: JSON.parse(u.interests),
    status: u.status,
    suspendedUntil: u.suspended_until,
    trustScore: u.trust_score,
    createdAt: u.created_at,
  };
}

// Express middleware: Authorization: Bearer <jwt>
function requireUser(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  const payload = token && verifyToken(token, 'user');
  if (!payload) return res.status(401).json({ error: 'auth_required' });
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(payload.sub);
  if (!user) return res.status(401).json({ error: 'auth_required' });
  const status = effectiveStatus(user);
  if (status === 'deleted') return res.status(401).json({ error: 'account_deleted' });
  if (status === 'banned') return res.status(403).json({ error: 'banned' });
  req.user = user;
  req.userStatus = status;
  next();
}

// --- OTP isteği ---------------------------------------------------------------
router.post('/request-otp', async (req, res) => {
  const phone = normalizePhone(req.body?.phone);
  if (!phone) return res.status(400).json({ error: 'invalid_phone', message: 'Geçerli bir telefon numarası girin.' });
  const phoneHash = hashPhone(phone);

  const ban = activeBanForPhone(phoneHash);
  if (ban) return res.status(403).json({ error: 'banned', message: 'Bu numara engellenmiş.' });

  const now = Date.now();
  const existing = db.prepare('SELECT * FROM otp_codes WHERE phone_hash = ?').get(phoneHash);
  if (existing && now - existing.requested_at < config.OTP_REQUEST_COOLDOWN_MS) {
    return res.status(429).json({ error: 'too_many_requests', message: 'Lütfen biraz bekleyip tekrar deneyin.' });
  }

  const code = randomOtp();
  db.prepare(
    `INSERT INTO otp_codes (phone_hash, code, expires_at, attempts, requested_at) VALUES (?, ?, ?, 0, ?)
     ON CONFLICT(phone_hash) DO UPDATE SET code = excluded.code, expires_at = excluded.expires_at, attempts = 0, requested_at = excluded.requested_at`
  ).run(phoneHash, code, now + config.OTP_TTL_MS, now);

  try {
    await sendSms(phone, `Proje X doğrulama kodunuz: ${code}`);
  } catch (err) {
    return res.status(500).json({ error: 'sms_failed', message: 'SMS gönderilemedi.' });
  }

  const body = { ok: true, ttlSec: config.OTP_TTL_MS / 1000 };
  if (config.OTP_MODE === 'dev') body.devCode = code; // sadece geliştirme modunda
  res.json(body);
});

// --- OTP doğrulama -------------------------------------------------------------
router.post('/verify-otp', (req, res) => {
  const phone = normalizePhone(req.body?.phone);
  const code = String(req.body?.code || '');
  if (!phone || !/^\d{6}$/.test(code)) {
    return res.status(400).json({ error: 'invalid_request', message: 'Kod 6 haneli olmalı.' });
  }
  const phoneHash = hashPhone(phone);
  const row = db.prepare('SELECT * FROM otp_codes WHERE phone_hash = ?').get(phoneHash);
  if (!row || row.expires_at < Date.now()) {
    return res.status(400).json({ error: 'otp_expired', message: 'Kodun süresi doldu, yeniden isteyin.' });
  }
  if (row.attempts >= config.OTP_MAX_ATTEMPTS) {
    return res.status(429).json({ error: 'too_many_attempts', message: 'Çok fazla deneme. Yeni kod isteyin.' });
  }
  if (row.code !== code) {
    db.prepare('UPDATE otp_codes SET attempts = attempts + 1 WHERE phone_hash = ?').run(phoneHash);
    return res.status(400).json({ error: 'wrong_code', message: 'Kod hatalı.' });
  }
  db.prepare('DELETE FROM otp_codes WHERE phone_hash = ?').run(phoneHash);

  const ban = activeBanForPhone(phoneHash);
  if (ban) return res.status(403).json({ error: 'banned', message: 'Bu numara engellenmiş.' });

  const user = db.prepare('SELECT * FROM users WHERE phone_hash = ?').get(phoneHash);
  if (user) {
    const status = effectiveStatus(user);
    if (status === 'banned') return res.status(403).json({ error: 'banned', message: 'Hesap engellenmiş.' });
    return res.json({ ok: true, token: signUserToken(user.id), user: publicUser(user) });
  }
  // Yeni kullanıcı: profil tamamlama adımına geç.
  res.json({ ok: true, needsProfile: true, registrationToken: signRegistrationToken(phoneHash) });
});

// --- Profil tamamlama (kayıt) ----------------------------------------------------
router.post('/complete-profile', (req, res) => {
  const { registrationToken, displayName, birthDate, languages, interests } = req.body || {};
  const payload = verifyToken(registrationToken, 'register');
  if (!payload) return res.status(401).json({ error: 'invalid_registration', message: 'Kayıt oturumu geçersiz, baştan deneyin.' });

  const name = String(displayName || '').trim();
  if (name.length < 2 || name.length > 30) {
    return res.status(400).json({ error: 'invalid_name', message: 'İsim 2-30 karakter olmalı.' });
  }
  if (!isValidBirthDate(birthDate)) {
    return res.status(400).json({ error: 'invalid_birth_date', message: 'Geçerli bir doğum tarihi girin.' });
  }
  const age = ageFromBirthDate(birthDate);
  if (age < config.MIN_AGE) {
    // 18 altı tamamen dışarıda (plan §4.2 kararı).
    return res.status(403).json({ error: 'underage', message: 'Proje X yalnızca 18 yaş ve üzeri içindir.' });
  }
  const langs = Array.isArray(languages) ? languages.filter((l) => config.LANGUAGES.includes(l)) : [];
  if (langs.length < 1) return res.status(400).json({ error: 'invalid_languages', message: 'En az bir dil seçin.' });
  const ints = Array.isArray(interests) ? [...new Set(interests.filter((i) => config.INTERESTS.includes(i)))] : [];
  if (ints.length !== config.INTEREST_COUNT) {
    return res.status(400).json({ error: 'invalid_interests', message: `Tam olarak ${config.INTEREST_COUNT} ilgi alanı seçin.` });
  }

  const existing = db.prepare('SELECT id FROM users WHERE phone_hash = ?').get(payload.ph);
  if (existing) return res.status(409).json({ error: 'already_registered', message: 'Bu numara zaten kayıtlı.' });

  const info = db.prepare(
    'INSERT INTO users (phone_hash, display_name, birth_date, languages, interests, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(payload.ph, name, birthDate, JSON.stringify(langs), JSON.stringify(ints), Date.now());
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
  res.json({ ok: true, token: signUserToken(user.id), user: publicUser(user) });
});

module.exports = { router, requireUser, verifyToken, signUserToken, publicUser };
