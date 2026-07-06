'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.PROJEX_DATA_DIR || path.join(__dirname, '..', '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

// JWT gizli anahtarı ilk çalıştırmada üretilir ve data/ altında saklanır,
// böylece sunucu yeniden başlasa da oturumlar geçerli kalır.
const SECRET_FILE = path.join(DATA_DIR, '.jwt-secret');
let jwtSecret;
if (fs.existsSync(SECRET_FILE)) {
  jwtSecret = fs.readFileSync(SECRET_FILE, 'utf8').trim();
} else {
  jwtSecret = crypto.randomBytes(48).toString('hex');
  fs.writeFileSync(SECRET_FILE, jwtSecret, { mode: 0o600 });
}

module.exports = {
  PORT: parseInt(process.env.PORT || '3000', 10),
  DATA_DIR,
  DB_FILE: process.env.PROJEX_DB_FILE || path.join(DATA_DIR, 'projex.db'),
  EVIDENCE_DIR: path.join(DATA_DIR, 'evidence'),
  JWT_SECRET: jwtSecret,
  JWT_EXPIRES: '30d',
  ADMIN_JWT_EXPIRES: '12h',

  // Telefon numaraları asla düz metin saklanmaz; sabit tuzla SHA-256.
  PHONE_SALT: process.env.PROJEX_PHONE_SALT || 'projex-phone-salt-v1',

  // 'dev' modunda SMS gönderilmez: OTP kodu API yanıtında döner ve konsola yazılır.
  // Gerçek SMS için 'production' yapıp server/src/sms.js içindeki sendSms'i doldurun.
  OTP_MODE: process.env.PROJEX_OTP_MODE || 'dev',
  OTP_TTL_MS: 5 * 60 * 1000,
  OTP_MAX_ATTEMPTS: 5,
  OTP_REQUEST_COOLDOWN_MS: 30 * 1000,

  MIN_AGE: 18,
  INTEREST_COUNT: 3,

  // Eşleşme motoru ayarları (plan §2.3)
  MATCH_TICK_MS: 1000,
  MATCH_THRESHOLDS: [
    { maxWaitMs: 5000, minScore: 60 },
    { maxWaitMs: 15000, minScore: 30 },
    { maxWaitMs: 30000, minScore: 0 },
    // 30 sn'den uzun bekleyen kimse boş dönmesin: küçük havuzda yeniden
    // eşleşme cezası (-100) bile delinebilir olmalı; sert kurallar (dil,
    // engel) her durumda geçerli kalır.
    { maxWaitMs: Infinity, minScore: -200 },
  ],
  SKIP_REMATCH_PENALTY: 30,
  REMATCH_COOLDOWN_MS: 5 * 60 * 1000, // aynı ikili 5 dk içinde tekrar eşleşmez (havuz küçükse puanla delinebilir)

  // Moderasyon (plan §2.1): 24 saatte 3 farklı kişiden rapor -> otomatik askı
  AUTO_SUSPEND_REPORT_COUNT: 3,
  AUTO_SUSPEND_WINDOW_MS: 24 * 60 * 60 * 1000,
  SUSPEND_DURATION_MS: 48 * 60 * 60 * 1000,

  // Yeni hesap hız limiti (plan §4.3): ilk 24 saatte en fazla 30 eşleşme
  NEW_ACCOUNT_WINDOW_MS: 24 * 60 * 60 * 1000,
  NEW_ACCOUNT_MATCH_LIMIT: 30,

  // Arkadaş ekleme: görüşme bittikten sonra bu süre boyunca hâlâ eklenebilir
  FRIEND_GRACE_MS: 90 * 1000,

  MESSAGE_MAX_LEN: 2000,
  REPORT_NOTE_MAX_LEN: 500,
  SNAPSHOT_MAX_BYTES: 2 * 1024 * 1024,

  // WebRTC ICE sunucuları. TURN eklemek için ortam değişkenlerini doldurun
  // (coturn kurulumu README'de anlatılıyor).
  ICE_SERVERS: (() => {
    const servers = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
    if (process.env.PROJEX_TURN_URL) {
      servers.push({
        urls: [process.env.PROJEX_TURN_URL],
        username: process.env.PROJEX_TURN_USER || '',
        credential: process.env.PROJEX_TURN_PASS || '',
      });
    }
    return servers;
  })(),

  LANGUAGES: ['tr', 'en', 'de', 'fr', 'es', 'ar', 'ru'],
  MOODS: ['derin', 'hafif', 'dil', 'eglence'],
  INTERESTS: [
    'muzik', 'oyun', 'spor', 'sinema', 'kitap',
    'teknoloji', 'seyahat', 'yemek', 'sanat', 'bilim',
  ],
  REPORT_CATEGORIES: [
    'ciplaklik', 'taciz', 'nefret', 'siddet', 'resit_olmayan', 'spam', 'diger',
  ],
};
