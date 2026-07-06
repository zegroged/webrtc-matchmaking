'use strict';
// createReport tekilleştirme + effectiveStatus('deleted') düzeltmelerinin testi.
process.env.PROJEX_DATA_DIR = require('path').join(require('os').tmpdir(), 'projex-test-rep-' + process.pid);

const { test } = require('node:test');
const assert = require('node:assert');
const { db } = require('../src/db');
const { createReport, effectiveStatus } = require('../src/moderation');

function makeUser(name) {
  const info = db.prepare(
    "INSERT INTO users (phone_hash, display_name, birth_date, languages, interests, created_at) VALUES (?, ?, '1990-01-01', '[\"tr\"]', '[\"muzik\",\"oyun\",\"spor\"]', ?)"
  ).run('h-' + name + '-' + Math.random(), name, Date.now());
  return Number(info.lastInsertRowid);
}

test('aynı raporcunun aynı maçı tekrar raporlaması yeni kayıt/ceza üretmez', () => {
  const reporter = makeUser('reporter');
  const reported = makeUser('reported');
  const matchInfo = db.prepare('INSERT INTO matches (user_a, user_b, started_at) VALUES (?, ?, ?)')
    .run(reporter, reported, Date.now());
  const matchId = Number(matchInfo.lastInsertRowid);

  const before = db.prepare('SELECT trust_score FROM users WHERE id = ?').get(reported).trust_score;

  const r1 = createReport({ matchId, reporterId: reporter, reportedId: reported, category: 'taciz' });
  assert.equal(r1.duplicate, undefined, 'ilk rapor yeni olmalı');

  const afterFirst = db.prepare('SELECT trust_score FROM users WHERE id = ?').get(reported).trust_score;
  assert.equal(afterFirst, before - 5, 'ilk raporda güven puanı 5 düşmeli');

  // Aynı raporcu 10 kez daha raporlasın
  for (let i = 0; i < 10; i++) {
    const rn = createReport({ matchId, reporterId: reporter, reportedId: reported, category: 'taciz' });
    assert.equal(rn.duplicate, true, 'tekrar raporlar duplicate işaretli olmalı');
    assert.equal(rn.reportId, r1.reportId, 'aynı reportId dönmeli');
  }

  const afterSpam = db.prepare('SELECT trust_score FROM users WHERE id = ?').get(reported).trust_score;
  assert.equal(afterSpam, before - 5, 'tekrar raporlar güven puanını daha fazla düşürmemeli');

  const count = db.prepare('SELECT COUNT(*) AS c FROM reports WHERE reported_id = ?').get(reported).c;
  assert.equal(count, 1, 'yalnızca tek rapor kaydı olmalı');
});

test('farklı raporcular ayrı ayrı sayılır', () => {
  const a = makeUser('a');
  const b = makeUser('b');
  const target = makeUser('target');
  const m1 = Number(db.prepare('INSERT INTO matches (user_a, user_b, started_at) VALUES (?, ?, ?)').run(a, target, Date.now()).lastInsertRowid);
  const m2 = Number(db.prepare('INSERT INTO matches (user_a, user_b, started_at) VALUES (?, ?, ?)').run(b, target, Date.now()).lastInsertRowid);
  createReport({ matchId: m1, reporterId: a, reportedId: target, category: 'spam' });
  createReport({ matchId: m2, reporterId: b, reportedId: target, category: 'spam' });
  const count = db.prepare('SELECT COUNT(*) AS c FROM reports WHERE reported_id = ?').get(target).c;
  assert.equal(count, 2, 'farklı raporcular ayrı kayıt oluşturmalı');
});

test('effectiveStatus silinen hesabı deleted döndürür', () => {
  const u = makeUser('deleted-user');
  db.prepare("UPDATE users SET status = 'deleted' WHERE id = ?").run(u);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(u);
  assert.equal(effectiveStatus(user), 'deleted');
});

test('bozuk chat_excerpt üretilmez: uzun mesajlar geçerli JSON kalır', () => {
  const reporter = makeUser('r2');
  const reported = makeUser('t2');
  const f = Number(db.prepare('INSERT INTO friendships (user_a, user_b, created_at) VALUES (?, ?, ?)')
    .run(Math.min(reporter, reported), Math.max(reporter, reported), Date.now()).lastInsertRowid);
  const longExcerpt = Array.from({ length: 20 }, (_, i) => ({
    sender_id: reporter,
    body: 'x'.repeat(2000), // config.MESSAGE_MAX_LEN
    created_at: Date.now() + i,
  }));
  const r = createReport({ friendshipId: f, reporterId: reporter, reportedId: reported, category: 'taciz', chatExcerpt: longExcerpt });
  const row = db.prepare('SELECT chat_excerpt FROM reports WHERE id = ?').get(r.reportId);
  assert.doesNotThrow(() => JSON.parse(row.chat_excerpt), 'chat_excerpt geçerli JSON olmalı');
  const parsed = JSON.parse(row.chat_excerpt);
  assert.equal(parsed.length, 20);
  assert.ok(parsed[0].body.length <= 300, 'her mesaj gövdesi kısaltılmalı');
});
