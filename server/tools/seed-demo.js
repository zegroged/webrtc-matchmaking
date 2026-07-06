'use strict';
// Çalışan sunucuya demo verisi yükler: 3 kullanıcı, eşleşmeler, arkadaşlık,
// mesajlar (biri filtreli), rapor + kanıt karesi.
// Kullanım: sunucu çalışırken `npm run seed` (varsayılan http://localhost:3000)

const { io } = require('socket.io-client');

const BASE = process.env.SEED_BASE || 'http://localhost:3000';

async function api(method, url, body, token) {
  const res = await fetch(BASE + url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function registerOrLogin(phone, name, opts = {}) {
  const otp = await api('POST', '/api/auth/request-otp', { phone });
  if (!otp.body.devCode) throw new Error('OTP dev modu kapalı ya da sunucu erişilemez');
  const verify = await api('POST', '/api/auth/verify-otp', { phone, code: otp.body.devCode });
  if (verify.body.needsProfile) {
    const profile = await api('POST', '/api/auth/complete-profile', {
      registrationToken: verify.body.registrationToken,
      displayName: name,
      birthDate: opts.birthDate || '1998-06-20',
      languages: opts.languages || ['tr'],
      interests: opts.interests || ['muzik', 'oyun', 'sinema'],
    });
    return { token: profile.body.token, user: profile.body.user };
  }
  return { token: verify.body.token, user: verify.body.user };
}

function connect(token) {
  return io(BASE, { auth: { token }, transports: ['websocket'], reconnection: false });
}

function waitFor(socket, event, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`'${event}' zaman aşımı`)), timeoutMs);
    socket.once(event, (d) => { clearTimeout(t); resolve(d); });
  });
}

function emitAck(socket, event, payload) {
  return new Promise((resolve) => socket.emit(event, payload, resolve));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log(`Demo verisi yükleniyor -> ${BASE}`);
  const ayse = await registerOrLogin('05550000101', 'Ayşe', { interests: ['muzik', 'kitap', 'sanat'], birthDate: '1999-03-10' });
  const mehmet = await registerOrLogin('05550000102', 'Mehmet', { interests: ['muzik', 'oyun', 'spor'], birthDate: '1996-11-25' });
  await registerOrLogin('05550000103', 'Zeynep', { interests: ['seyahat', 'yemek', 'sinema'], birthDate: '2000-07-07' });
  console.log('✔ 3 kullanıcı hazır (Ayşe, Mehmet, Zeynep)');

  const sA = connect(ayse.token);
  const sM = connect(mehmet.token);
  await Promise.all([waitFor(sA, 'connect'), waitFor(sM, 'connect')]);

  // 1. eşleşme: arkadaş olurlar
  const mA = waitFor(sA, 'match:found');
  const mM = waitFor(sM, 'match:found');
  await emitAck(sA, 'queue:join', { mood: 'derin' });
  await emitAck(sM, 'queue:join', { mood: 'derin' });
  const [matchA] = await Promise.all([mA, mM]);
  console.log(`✔ Eşleşme kuruldu (#${matchA.matchId})`);
  await sleep(1500);

  const fA = waitFor(sA, 'friend:new');
  await emitAck(sA, 'friend:add', { matchId: matchA.matchId });
  await emitAck(sM, 'friend:add', { matchId: matchA.matchId });
  const friendship = await fA;
  await emitAck(sA, 'match:end', {});
  console.log(`✔ Arkadaşlık kuruldu (#${friendship.friendshipId})`);

  const messages = [
    [sA, 'Selam! Az önceki sohbet çok iyiydi 😄'],
    [sM, 'Aynen! Müzik zevkin gerçekten güzelmiş.'],
    [sA, 'Haftaya o konsere gidecek misin?'],
    [sM, 'siktir ya biletler tükenmiş 😤'],
    [sA, 'Olsun, başka konser buluruz 🙂'],
  ];
  for (const [sock, body] of messages) {
    await emitAck(sock, 'chat:send', { friendshipId: friendship.friendshipId, body });
    await sleep(150);
  }
  console.log(`✔ ${messages.length} mesaj gönderildi (biri küfür filtresine takıldı)`);

  // 2. eşleşme: rapor senaryosu (aynı ikili; cooldown nedeniyle ~30 sn sürer)
  const m2A = waitFor(sA, 'match:found', 60000);
  const m2M = waitFor(sM, 'match:found', 60000);
  await emitAck(sA, 'queue:join', { mood: 'eglence' });
  await emitAck(sM, 'queue:join', { mood: 'eglence' });
  const [match2] = await Promise.all([m2A, m2M]);
  await sleep(1000);
  const tinyJpeg = '/9j/4AAQSkZJRgABAQEAAAAAAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==';
  const rep = await emitAck(sA, 'match:report', {
    matchId: match2.matchId,
    category: 'taciz',
    note: 'Uygunsuz sözler söyledi (demo raporu).',
    snapshot: tinyJpeg,
  });
  console.log(`✔ Rapor oluşturuldu (#${rep.reportId})`);

  sA.disconnect();
  sM.disconnect();
  console.log('\nDemo verisi hazır. Yönetim paneli: ' + BASE + '/admin');
  process.exit(0);
}

main().catch((e) => { console.error('Seed hatası:', e.message); process.exit(1); });
