'use strict';
// Eşleşme motoru — plan §2.3'ün uygulaması.
// Bekleme havuzu bellekte tutulur (tek süreç MVP). Redis'e taşıma noktaları
// yorumlarla işaretlidir: havuz -> Redis sorted set, skip geçmişi -> Redis TTL key.

const config = require('./config');
const { pairKey, nowMs } = require('./util');

class Matchmaker {
  /**
   * @param {object} deps
   * @param {(a: Entry, b: Entry) => void} deps.onMatch  Eşleşme kurulunca çağrılır.
   * @param {(a: number, b: number) => boolean} deps.isBlockedPair  Engel kontrolü (iki yönlü).
   */
  constructor({ onMatch, isBlockedPair }) {
    this.queue = new Map();          // userId -> entry
    this.recentPairs = new Map();    // pairKey -> {until, skipped}
    this.onMatch = onMatch;
    this.isBlockedPair = isBlockedPair;
    this.timer = null;
    this.paused = false;             // acil durdurma anahtarı (admin)
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), config.MATCH_TICK_MS);
    if (this.timer.unref) this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** entry: {userId, socketId, mood, languages:[], interests:[], age, trustScore, joinedAt} */
  enqueue(entry) {
    if (this.paused) return { ok: false, reason: 'paused' };
    entry.joinedAt = nowMs();
    this.queue.set(entry.userId, entry);
    return { ok: true };
  }

  dequeue(userId) {
    return this.queue.delete(userId);
  }

  inQueue(userId) {
    return this.queue.has(userId);
  }

  get size() {
    return this.queue.size;
  }

  // Görüşme bitince çağrılır: aynı ikilinin hemen tekrar eşleşmesini engelle,
  // skip ise kalıcı puan cezası da uygula (plan: daha_önce_skip_ettiyse * 30).
  notePairEnded(userA, userB, wasSkip) {
    const key = pairKey(userA, userB);
    const prev = this.recentPairs.get(key);
    this.recentPairs.set(key, {
      until: nowMs() + config.REMATCH_COOLDOWN_MS,
      skipped: wasSkip || (prev && prev.skipped) || false,
    });
  }

  thresholdFor(waitMs) {
    for (const t of config.MATCH_THRESHOLDS) {
      if (waitMs < t.maxWaitMs) return t.minScore;
    }
    return 0;
  }

  // Plan §2.3: puanlama. null dönerse eşleşme yasak (sert kural).
  scorePair(a, b) {
    const sharedLangs = a.languages.filter((l) => b.languages.includes(l));
    if (sharedLangs.length === 0) return null;               // dil kesişimi yok -> yasak
    if (this.isBlockedPair(a.userId, b.userId)) return null; // engel -> yasak

    let score = 0;
    if (a.mood === b.mood) score += 50;
    const sharedInterests = a.interests.filter((i) => b.interests.includes(i)).length;
    score += sharedInterests * 15;
    score += Math.max(0, 10 - Math.abs(a.age - b.age));

    const recent = this.recentPairs.get(pairKey(a.userId, b.userId));
    if (recent) {
      if (recent.skipped) score -= config.SKIP_REMATCH_PENALTY;
      if (recent.until > nowMs()) score -= 100;               // bekleme süresi dolmadan tekrar eşleşme fiilen kapalı
    }

    // Düşük güven puanı önceliği düşürür (plan §4.3)
    const trustAvg = ((a.trustScore ?? 100) + (b.trustScore ?? 100)) / 2;
    if (trustAvg < 50) score -= 10;

    return score;
  }

  tick() {
    if (this.paused || this.queue.size < 2) return;
    const now = nowMs();

    // Süresi geçen recentPairs kayıtlarını ayıkla (bellek hijyeni; skip cezası
    // kalsın diye skipped=true olanlar 24 saat tutulur).
    for (const [key, val] of this.recentPairs) {
      if (val.until <= now && (!val.skipped || val.until <= now - 24 * 60 * 60 * 1000)) {
        this.recentPairs.delete(key);
      }
    }

    // En uzun bekleyen önce eşleşme hakkı bulur (açlığı önler).
    const waiting = [...this.queue.values()].sort((x, y) => x.joinedAt - y.joinedAt);
    const matched = new Set();

    for (const a of waiting) {
      if (matched.has(a.userId)) continue;
      let best = null;
      let bestScore = -Infinity;
      for (const b of waiting) {
        if (b.userId === a.userId || matched.has(b.userId)) continue;
        const score = this.scorePair(a, b);
        if (score === null) continue;
        if (score > bestScore) {
          bestScore = score;
          best = b;
        }
      }
      if (!best) continue;

      // Eşik, çiftin en uzun süredir bekleyenine göre gevşer.
      const maxWait = Math.max(now - a.joinedAt, now - best.joinedAt);
      if (bestScore < this.thresholdFor(maxWait)) continue;

      matched.add(a.userId);
      matched.add(best.userId);
      this.queue.delete(a.userId);
      this.queue.delete(best.userId);
      try {
        this.onMatch(a, best);
      } catch (err) {
        console.error('[matchmaker] onMatch hatası:', err);
      }
    }
  }
}

module.exports = { Matchmaker };
