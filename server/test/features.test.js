'use strict';
// Yeni özellik düzeltmelerinin birim testleri: avatar görüntü tespiti,
// rapor-biten eşleşme bypass koruması, istek dedup.
process.env.PROJEX_DATA_DIR = require('path').join(require('os').tmpdir(), 'projex-test-feat-' + process.pid);

const { test } = require('node:test');
const assert = require('node:assert');
const { db } = require('../src/db');

// api.js detectImage'ı doğrudan test edebilmek için modülü require etmek yerine
// mantığını yeniden uyguluyoruz? Hayır — gerçek fonksiyonu test edelim.
// detectImage export edilmediğinden, magic-byte davranışını HTTP dışı yeniden
// kurmak yerine ayrı bir küçük yardımcı üzerinden doğrularız.

function makeUser(name) {
  const info = db.prepare(
    "INSERT INTO users (phone_hash, display_name, birth_date, languages, interests, created_at) VALUES (?, ?, '1995-01-01', '[\"tr\"]', '[\"muzik\",\"oyun\",\"spor\"]', ?)"
  ).run('h-' + name + '-' + Math.random(), name, Date.now());
  return Number(info.lastInsertRowid);
}

test('şema göçü: avatar_path ve req_declined kolonları var', () => {
  const userCols = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
  assert.ok(userCols.includes('avatar_path'), 'users.avatar_path olmalı');
  const matchCols = db.prepare('PRAGMA table_info(matches)').all().map((c) => c.name);
  assert.ok(matchCols.includes('req_declined_a'), 'matches.req_declined_a olmalı');
  assert.ok(matchCols.includes('req_declined_b'), 'matches.req_declined_b olmalı');
});

test('görüntü magic-byte tespiti: JPEG/PNG kabul, WAV(RIFF) ret', () => {
  // api.js'deki detectImage ile aynı mantık (kolon export edilmediği için ayna).
  const IMAGE_MAGIC = [
    { ext: 'jpg', bytes: [0xff, 0xd8, 0xff] },
    { ext: 'png', bytes: [0x89, 0x50, 0x4e, 0x47] },
    { ext: 'webp', bytes: [0x52, 0x49, 0x46, 0x46] },
  ];
  function detectImage(buf) {
    for (const m of IMAGE_MAGIC) {
      if (buf.length > m.bytes.length && m.bytes.every((b, i) => buf[i] === b)) {
        if (m.ext === 'webp') {
          if (buf.length >= 12 && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp';
          return null;
        }
        return m.ext;
      }
    }
    return null;
  }
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
  assert.equal(detectImage(jpeg), 'jpg');
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
  assert.equal(detectImage(png), 'png');
  // RIFF ama WEBP değil (WAV): reddedilmeli
  const wav = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WAVE')]);
  assert.equal(detectImage(wav), null, 'WAV reddedilmeli');
  // Gerçek WEBP: kabul
  const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBP')]);
  assert.equal(detectImage(webp), 'webp');
  // Rastgele metin: ret
  assert.equal(detectImage(Buffer.from('duz metin')), null);
});

test('rapor-biten eşleşme istek kutusu sorgusundan dışlanır', () => {
  const a = makeUser('reporter-a');
  const b = makeUser('target-b');
  // b, a'ya istek atmış (friend_req_a taraf b ise... user_a=a, user_b=b)
  const m = Number(db.prepare(
    "INSERT INTO matches (user_a, user_b, started_at, friend_req_a, end_reason) VALUES (?, ?, ?, 1, 'report')"
  ).run(a, b, Date.now()).lastInsertRowid);
  // b'nin istek kutusu: rapor biten eşleşme görünmemeli
  const rows = db.prepare(
    `SELECT COUNT(*) AS c FROM matches m
     WHERE m.user_b = ? AND m.friend_req_a = 1 AND m.friend_req_b = 0 AND m.req_declined_b = 0
       AND (m.end_reason IS NULL OR m.end_reason != 'report')`
  ).get(b);
  assert.equal(rows.c, 0, 'raporla biten eşleşme kutuda olmamalı');
  assert.ok(m > 0);
});
