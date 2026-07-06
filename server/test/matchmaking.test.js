'use strict';
process.env.PROJEX_DATA_DIR = require('path').join(require('os').tmpdir(), 'projex-test-mm-' + process.pid);

const { test } = require('node:test');
const assert = require('node:assert');
const { Matchmaker } = require('../src/matchmaking');

function entry(userId, opts = {}) {
  return {
    userId,
    socketId: 's' + userId,
    mood: opts.mood || 'hafif',
    languages: opts.languages || ['tr'],
    interests: opts.interests || ['muzik', 'oyun', 'spor'],
    age: opts.age ?? 25,
    trustScore: opts.trustScore ?? 100,
    joinedAt: opts.joinedAt ?? Date.now(),
  };
}

function makeMm(blocked = []) {
  const matches = [];
  const mm = new Matchmaker({
    onMatch: (a, b) => matches.push([a.userId, b.userId]),
    isBlockedPair: (a, b) => blocked.some(([x, y]) => (x === a && y === b) || (x === b && y === a)),
  });
  return { mm, matches };
}

test('dil kesişimi yoksa eşleşme yasak', () => {
  const { mm } = makeMm();
  const a = entry(1, { languages: ['tr'] });
  const b = entry(2, { languages: ['en'] });
  assert.equal(mm.scorePair(a, b), null);
});

test('engelli çift eşleşemez', () => {
  const { mm } = makeMm([[1, 2]]);
  assert.equal(mm.scorePair(entry(1), entry(2)), null);
});

test('puanlama: mod + ortak ilgi + yaş yakınlığı', () => {
  const { mm } = makeMm();
  const a = entry(1, { mood: 'derin', interests: ['muzik', 'oyun', 'kitap'], age: 25 });
  const b = entry(2, { mood: 'derin', interests: ['muzik', 'oyun', 'sanat'], age: 27 });
  // mod 50 + 2 ortak ilgi * 15 + (10 - 2 yaş farkı) = 88
  assert.equal(mm.scorePair(a, b), 88);
});

test('skip edilen çift ceza alır', () => {
  const { mm } = makeMm();
  mm.notePairEnded(1, 2, true);
  const base = mm.scorePair(entry(1), entry(3));
  const penalized = mm.scorePair(entry(1), entry(2));
  // -30 skip cezası + -100 bekleme süresi cezası
  assert.equal(penalized, base - 130);
});

test('uyumlu iki kullanıcı tick ile eşleşir', () => {
  const { mm, matches } = makeMm();
  mm.enqueue(entry(1, { mood: 'derin' }));
  mm.enqueue(entry(2, { mood: 'derin' }));
  mm.tick();
  assert.equal(matches.length, 1);
  assert.deepEqual(matches[0].slice().sort(), [1, 2]);
  assert.equal(mm.size, 0);
});

test('düşük puanlı çift ancak bekleme süresi dolunca eşleşir', () => {
  const { mm, matches } = makeMm();
  // Farklı mod, ortak ilgi yok, yaş farkı 10+ -> puan 0
  const a = entry(1, { mood: 'derin', interests: ['muzik', 'oyun', 'spor'], age: 20 });
  const b = entry(2, { mood: 'hafif', interests: ['kitap', 'sanat', 'bilim'], age: 40 });
  mm.enqueue(a);
  mm.enqueue(b);
  mm.tick();
  assert.equal(matches.length, 0, 'yüksek eşik aşamasında eşleşmemeli');

  // 15+ saniye beklemiş gibi göster -> eşik 0'a düşer
  mm.queue.get(1).joinedAt = Date.now() - 16000;
  mm.queue.get(2).joinedAt = Date.now() - 16000;
  mm.tick();
  assert.equal(matches.length, 1, 'eşik gevşeyince eşleşmeli');
});

test('en iyi puanlı aday seçilir', () => {
  const { mm, matches } = makeMm();
  const now = Date.now();
  mm.enqueue(entry(1, { mood: 'derin', interests: ['muzik', 'oyun', 'spor'], joinedAt: now - 3000 }));
  mm.enqueue(entry(2, { mood: 'hafif', interests: ['muzik', 'oyun', 'spor'], joinedAt: now - 2000 })); // mod farklı
  mm.enqueue(entry(3, { mood: 'derin', interests: ['muzik', 'oyun', 'spor'], joinedAt: now - 1000 })); // mod aynı
  mm.queue.get(1).joinedAt = now - 3000;
  mm.tick();
  assert.equal(matches.length, 1);
  assert.deepEqual(matches[0].slice().sort(), [1, 3], 'aynı moddaki aday tercih edilmeli');
});

test('acil durdurma kuyruk alımını keser', () => {
  const { mm, matches } = makeMm();
  mm.paused = true;
  const r = mm.enqueue(entry(1));
  assert.equal(r.ok, false);
  mm.tick();
  assert.equal(matches.length, 0);
});

test('kuyruktan ayrılma çalışır', () => {
  const { mm } = makeMm();
  mm.enqueue(entry(1));
  assert.equal(mm.inQueue(1), true);
  mm.dequeue(1);
  assert.equal(mm.inQueue(1), false);
});

test('bekleme eşiği tanımlı aralıklarla gevşer', () => {
  const { mm } = makeMm();
  assert.equal(mm.thresholdFor(0), 60);
  assert.equal(mm.thresholdFor(4999), 60);
  assert.equal(mm.thresholdFor(5000), 30);
  assert.equal(mm.thresholdFor(14999), 30);
  assert.equal(mm.thresholdFor(15000), 0);
  assert.equal(mm.thresholdFor(29999), 0);
  assert.equal(mm.thresholdFor(30000), -200, 'uzun beklemede rematch cezası delinebilir olmalı');
});

test('küçük havuzda cooldown\'lu çift uzun beklemede yeniden eşleşebilir', () => {
  const { mm, matches } = makeMm();
  mm.notePairEnded(1, 2, false); // az önce görüştüler (cooldown aktif)
  mm.enqueue(entry(1, { interests: ['muzik', 'kitap', 'sanat'] }));
  mm.enqueue(entry(2, { interests: ['muzik', 'oyun', 'spor'] }));
  mm.tick();
  assert.equal(matches.length, 0, 'cooldown içinde hemen eşleşmemeli');
  mm.queue.get(1).joinedAt = Date.now() - 31000;
  mm.queue.get(2).joinedAt = Date.now() - 31000;
  mm.tick();
  assert.equal(matches.length, 1, '30sn+ beklemede eşleşmeli');
});
