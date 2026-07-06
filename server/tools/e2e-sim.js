'use strict';
// Uçtan uca simülasyon: sunucuyu ayrı süreçte başlatır, iki sahte kullanıcıyla
// tam akışı doğrular: kayıt -> eşleşme -> WebRTC sinyal takası -> karşılıklı
// arkadaş ekleme -> kalıcı mesajlaşma (küfür filtresi dahil) -> raporlama.
// Kullanım: npm run e2e

const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { io } = require('socket.io-client');

const PORT = 3100;
const BASE = `http://localhost:${PORT}`;
const DATA_DIR = path.join(os.tmpdir(), 'projex-e2e-' + Date.now());

let passed = 0;
let failed = 0;
function check(name, cond) {
  if (cond) { passed++; console.log(`  ✔ ${name}`); }
  else { failed++; console.log(`  ✖ ${name}`); }
}

function waitFor(socket, event, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`'${event}' beklenirken zaman aşımı`)), timeoutMs);
    socket.once(event, (data) => { clearTimeout(t); resolve(data); });
  });
}

function emitAck(socket, event, payload, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`'${event}' ack beklenirken zaman aşımı`)), timeoutMs);
    socket.emit(event, payload, (res) => { clearTimeout(t); resolve(res); });
  });
}

async function api(method, url, body, token) {
  const res = await fetch(BASE + url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, body: json };
}

async function registerUser(phone, name, opts = {}) {
  const otp = await api('POST', '/api/auth/request-otp', { phone });
  if (!otp.body.devCode) throw new Error('devCode yok: ' + JSON.stringify(otp.body));
  const verify = await api('POST', '/api/auth/verify-otp', { phone, code: otp.body.devCode });
  if (!verify.body.needsProfile) throw new Error('needsProfile bekleniyordu');
  const profile = await api('POST', '/api/auth/complete-profile', {
    registrationToken: verify.body.registrationToken,
    displayName: name,
    birthDate: opts.birthDate || '1999-04-15',
    languages: opts.languages || ['tr'],
    interests: opts.interests || ['muzik', 'oyun', 'spor'],
  });
  if (!profile.body.token) throw new Error('kayıt başarısız: ' + JSON.stringify(profile.body));
  return { token: profile.body.token, user: profile.body.user };
}

function connect(token) {
  return io(BASE, { auth: { token }, transports: ['websocket'], reconnection: false });
}

async function main() {
  console.log('Sunucu başlatılıyor...');
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'index.js')], {
    env: { ...process.env, PORT: String(PORT), PROJEX_DATA_DIR: DATA_DIR, PROJEX_OTP_MODE: 'dev' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr.on('data', (d) => process.stderr.write('[server] ' + d));

  try {
    // Sağlık kontrolü bekle
    let up = false;
    for (let i = 0; i < 40; i++) {
      try {
        const r = await fetch(BASE + '/health');
        if (r.ok) { up = true; break; }
      } catch {}
      await new Promise((r) => setTimeout(r, 250));
    }
    if (!up) throw new Error('Sunucu açılmadı');
    console.log('\n[1] Kayıt akışı');

    const ayse = await registerUser('05550000001', 'Ayşe');
    const mehmet = await registerUser('05550000002', 'Mehmet');
    check('iki kullanıcı kaydoldu', !!ayse.user.id && !!mehmet.user.id);

    // 18 yaş altı reddedilmeli
    const otpU = await api('POST', '/api/auth/request-otp', { phone: '05550000003' });
    const verU = await api('POST', '/api/auth/verify-otp', { phone: '05550000003', code: otpU.body.devCode });
    const under = await api('POST', '/api/auth/complete-profile', {
      registrationToken: verU.body.registrationToken,
      displayName: 'Genç', birthDate: '2012-01-01', languages: ['tr'], interests: ['muzik', 'oyun', 'spor'],
    });
    check('18 yaş altı kayıt reddedildi', under.status === 403 && under.body.error === 'underage');

    // Doğum tarihi kilidi
    const bdTry = await api('PUT', '/api/me', { birthDate: '1990-01-01' }, ayse.token);
    check('doğum tarihi değişikliği engellendi', bdTry.status === 403 && bdTry.body.error === 'birth_date_locked');

    console.log('\n[2] Eşleşme + WebRTC sinyalleşme');
    const sockA = connect(ayse.token);
    const sockM = connect(mehmet.token);
    await Promise.all([waitFor(sockA, 'connect'), waitFor(sockM, 'connect')]);
    check('iki socket bağlandı', sockA.connected && sockM.connected);

    const matchPromiseA = waitFor(sockA, 'match:found');
    const matchPromiseM = waitFor(sockM, 'match:found');
    const joinA = await emitAck(sockA, 'queue:join', { mood: 'derin' });
    const joinM = await emitAck(sockM, 'queue:join', { mood: 'derin' });
    check('kuyruğa katılma onaylandı', joinA.ok && joinM.ok);

    const [matchA, matchM] = await Promise.all([matchPromiseA, matchPromiseM]);
    check('eşleşme iki tarafa bildirildi', matchA.matchId === matchM.matchId);
    check('karşı taraf profili doğru', matchA.peer.displayName === 'Mehmet' && matchM.peer.displayName === 'Ayşe');
    check('buzkıran sorusu aynı', matchA.icebreaker === matchM.icebreaker && matchA.icebreaker.length > 3);
    check('tek taraf initiator', matchA.initiator !== matchM.initiator);
    check('ortak ilgi alanları hesaplandı', Array.isArray(matchA.commonInterests) && matchA.commonInterests.length === 3);

    const sigToM = waitFor(sockM, 'rtc:signal');
    sockA.emit('rtc:signal', { matchId: matchA.matchId, data: { type: 'offer', sdp: 'sahte-sdp-teklifi' } });
    const gotM = await sigToM;
    check('sinyal A→M iletildi', gotM.data.sdp === 'sahte-sdp-teklifi');

    const sigToA = waitFor(sockA, 'rtc:signal');
    sockM.emit('rtc:signal', { matchId: matchM.matchId, data: { type: 'answer', sdp: 'sahte-sdp-cevabi' } });
    const gotA = await sigToA;
    check('sinyal M→A iletildi', gotA.data.sdp === 'sahte-sdp-cevabi');

    console.log('\n[3] Karşılıklı arkadaş ekleme');
    const friendA = waitFor(sockA, 'friend:new');
    const friendM = waitFor(sockM, 'friend:new');
    const addA = await emitAck(sockA, 'friend:add', { matchId: matchA.matchId });
    check('tek taraflı istek karşıya sızmıyor', addA.ok && addA.mutual === false);
    const addM = await emitAck(sockM, 'friend:add', { matchId: matchM.matchId });
    check('ikinci istek mutual', addM.ok && addM.mutual === true);
    const [fA, fM] = await Promise.all([friendA, friendM]);
    check('arkadaşlık iki tarafa bildirildi', fA.friendshipId === fM.friendshipId);

    console.log('\n[4] Görüşmeyi bitirme');
    const endedA = waitFor(sockA, 'match:ended');
    const endedM = waitFor(sockM, 'match:ended');
    await emitAck(sockA, 'match:end', {});
    const [eA, eM] = await Promise.all([endedA, endedM]);
    check('bitiş iki tarafa bildirildi', eA.reason === 'leave' && eM.reason === 'leave');
    check('bitiren taraf doğru işaretli', eA.byPeer === false && eM.byPeer === true);

    console.log('\n[5] Kalıcı mesajlaşma');
    const msgToM = waitFor(sockM, 'chat:message');
    const sendRes = await emitAck(sockA, 'chat:send', { friendshipId: fA.friendshipId, body: 'Selam! Tanıştığımıza memnun oldum.' });
    check('mesaj gönderildi', sendRes.ok && sendRes.message.id > 0);
    const recvM = await msgToM;
    check('mesaj karşıya ulaştı', recvM.message.body.includes('memnun oldum'));

    const badRes = await emitAck(sockM, 'chat:send', { friendshipId: fA.friendshipId, body: 'siktir git lan' });
    check('küfürlü mesaj işaretlendi', badRes.ok && badRes.message.flagged === true);

    const friendsList = await api('GET', '/api/friends', null, ayse.token);
    check('arkadaş listesi dolu', friendsList.body.friends.length === 1 && friendsList.body.friends[0].friend.displayName === 'Mehmet');
    check('okunmamış sayacı çalışıyor', friendsList.body.friends[0].unread === 1);

    const history = await api('GET', `/api/friends/${fA.friendshipId}/messages`, null, mehmet.token);
    check('mesaj geçmişi dönüyor', history.body.messages.length === 2);

    console.log('\n[6] Raporlama + otomatik askı');
    // Yeni eşleşme kur: A tekrar kuyruğa, M tekrar kuyruğa -> aynı ikili
    // (cooldown cezası havuzda başka kimse olmadığı için eşik 0'a düşünce aşılır)
    const match2A = waitFor(sockA, 'match:found', 25000);
    const match2M = waitFor(sockM, 'match:found', 25000);
    await emitAck(sockA, 'queue:join', { mood: 'eglence' });
    await emitAck(sockM, 'queue:join', { mood: 'eglence' });
    const [m2A] = await Promise.all([match2A, match2M]);
    check('ikinci eşleşme kuruldu', m2A.matchId > matchA.matchId);

    const tinyJpegBase64 = '/9j/4AAQSkZJRgABAQEAAAAAAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==';
    const repRes = await emitAck(sockA, 'match:report', { matchId: m2A.matchId, category: 'taciz', note: 'Uygunsuz davranış', snapshot: tinyJpegBase64 });
    check('rapor kabul edildi', repRes.ok && repRes.reportId > 0);
    const evidenceFiles = fs.readdirSync(path.join(DATA_DIR, 'evidence'));
    check('kanıt karesi kaydedildi', evidenceFiles.length === 1);

    console.log('\n[6.5] Arkadaşlık isteği kutusu');
    const deniz = await registerUser('05550000005', 'Deniz');
    const sockD = connect(deniz.token);
    await waitFor(sockD, 'connect');
    const m3M = waitFor(sockM, 'match:found', 40000);
    const m3D = waitFor(sockD, 'match:found', 40000);
    const reqEvt = waitFor(sockM, 'friend:request', 40000);
    await emitAck(sockD, 'queue:join', { mood: 'hafif' });
    await emitAck(sockM, 'queue:join', { mood: 'hafif' });
    const [m3] = await Promise.all([m3D, m3M]);
    check('üçüncü eşleşme kuruldu (Deniz-Mehmet)', m3.matchId > 0);
    const addD = await emitAck(sockD, 'friend:add', { matchId: m3.matchId });
    check('tek taraflı istek gönderildi', addD.ok === true && addD.mutual === false);
    const evt = await reqEvt;
    check('alıcıya friend:request olayı düştü', evt.from.displayName === 'Deniz');
    await emitAck(sockD, 'match:end', {});

    const inbox = await api('GET', '/api/friend-requests', null, mehmet.token);
    check('istek kutusunda Deniz görünüyor',
      inbox.body.requests.length === 1 && inbox.body.requests[0].from.displayName === 'Deniz');
    const senderInbox = await api('GET', '/api/friend-requests', null, deniz.token);
    check('istek sahibinin kutusu boş (tek yönlü)', senderInbox.body.requests.length === 0);

    const fNewD = waitFor(sockD, 'friend:new', 8000);
    const acc = await api('POST', `/api/friend-requests/${m3.matchId}/accept`, {}, mehmet.token);
    check('istek onaylandı', acc.body.ok === true);
    const fnD = await fNewD;
    check('istek sahibine friend:new bildirimi gitti', fnD.friend.displayName === 'Mehmet');
    const inbox2 = await api('GET', '/api/friend-requests', null, mehmet.token);
    check('onay sonrası kutu boşaldı', inbox2.body.requests.length === 0);
    const mFriends = await api('GET', '/api/friends', null, mehmet.token);
    check('arkadaş listesine Deniz eklendi',
      mFriends.body.friends.some((f) => f.friend.displayName === 'Deniz'));
    sockD.disconnect();

    console.log('\n[6.8] Profil fotoğrafı');
    const avatarRes = await api('POST', '/api/me/avatar', { imageBase64: tinyJpegBase64 }, ayse.token);
    check('avatar yüklendi', avatarRes.body.ok === true && String(avatarRes.body.avatarUrl).startsWith('/avatars/'));
    const avatarFetch = await fetch(BASE + avatarRes.body.avatarUrl);
    check('avatar servis ediliyor', avatarFetch.status === 200);
    const meAfterAvatar = await api('GET', '/api/me', null, ayse.token);
    check('profilde avatarUrl görünüyor', meAfterAvatar.body.user.avatarUrl === avatarRes.body.avatarUrl);
    const badAvatar = await api('POST', '/api/me/avatar', { imageBase64: Buffer.from('kotu-veri-goruntu-degil').toString('base64') }, ayse.token);
    check('görüntü olmayan veri reddedildi', badAvatar.status === 400);
    const delAvatar = await api('DELETE', '/api/me/avatar', null, ayse.token);
    check('avatar kaldırıldı', delAvatar.body.ok === true);
    const meAfterDel = await api('GET', '/api/me', null, ayse.token);
    check('avatarUrl temizlendi', meAfterDel.body.user.avatarUrl === null);

    console.log('\n[7] Engelleme');
    const blockRes = await api('POST', `/blocks/${mehmet.user.id}`.replace('/blocks', '/api/blocks'), {}, ayse.token);
    check('engelleme başarılı', blockRes.body.ok === true);
    const friendsAfter = await api('GET', '/api/friends', null, ayse.token);
    check('engelleme arkadaşlığı sildi', friendsAfter.body.friends.length === 0);

    console.log('\n[8] Yönetici API');
    const adminInfo = fs.readFileSync(path.join(DATA_DIR, 'ADMIN_BILGILERI.txt'), 'utf8');
    const adminPass = adminInfo.match(/Şifre\s+:\s+(\S+)/)[1];
    const login = await api('POST', '/api/admin/login', { username: 'admin', password: adminPass });
    check('admin girişi', login.body.ok === true);
    const dash = await api('GET', '/api/admin/dashboard', null, login.body.token);
    check('dashboard metrikleri', dash.body.totalUsers === 3 && dash.body.pendingReports === 1 && dash.body.matches24h === 3);
    const reports = await api('GET', '/api/admin/reports?status=pending', null, login.body.token);
    check('rapor kuyruğu dolu', reports.body.reports.length === 1 && reports.body.reports[0].category === 'taciz');
    check('kanıt URL üretildi', !!reports.body.reports[0].evidenceUrl);
    const resolve = await api('POST', `/api/admin/reports/${reports.body.reports[0].id}/resolve`, { action: 'warned' }, login.body.token);
    check('rapor karara bağlandı', resolve.body.ok === true);

    const ks = await api('POST', '/api/admin/killswitch', { on: true }, login.body.token);
    check('acil durdurma açıldı', ks.body.killswitch === true);
    const joinBlocked = await emitAck(sockA, 'queue:join', { mood: 'hafif' });
    check('acil durdurma kuyruk alımını kesti', joinBlocked.ok === false && joinBlocked.error === 'paused');
    await api('POST', '/api/admin/killswitch', { on: false }, login.body.token);

    sockA.disconnect();
    sockM.disconnect();
  } finally {
    server.kill();
  }

  console.log(`\nSonuç: ${passed} başarılı, ${failed} başarısız`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('\nE2E HATASI:', err.message);
  process.exit(1);
});
