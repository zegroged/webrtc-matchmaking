'use strict';
const http = require('http');
const path = require('path');
const fs = require('fs');
const express = require('express');
const { Server } = require('socket.io');

const config = require('./config');
const { ensureAdminAccount } = require('./db');
const auth = require('./auth');
const api = require('./api');
const admin = require('./admin');
const { initSockets } = require('./sockets');

const app = express();
app.use(express.json({ limit: '3mb' })); // rapor kanıt kareleri için

// CORS: Flutter web (aynı origin) + mobil uygulamalar (origin yok) + geliştirme.
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use('/api/auth', auth.router);
app.use('/api/admin', admin.router);
app.use('/api', api.router);

app.get('/health', (req, res) => res.json({ ok: true, ts: Date.now() }));

// Yönetim paneli
app.use('/admin', express.static(path.join(__dirname, '..', 'public', 'admin')));

// Flutter web build'i (varsa) kökten servis edilir -> tek sunucu her platforma yeter.
const webBuildDir = path.join(__dirname, '..', '..', 'app', 'build', 'web');
if (fs.existsSync(path.join(webBuildDir, 'index.html'))) {
  app.use(express.static(webBuildDir));
  app.get(/^\/(?!api|admin|socket\.io|health).*/, (req, res) => {
    res.sendFile(path.join(webBuildDir, 'index.html'));
  });
} else {
  app.get('/', (req, res) => {
    res.type('html').send('<h1>Proje X sunucusu çalışıyor</h1><p>Web istemcisi için: <code>cd app && flutter build web</code> sonra sunucuyu yeniden başlatın.</p><p>Yönetim paneli: <a href="/admin">/admin</a></p>');
  });
}

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  maxHttpBufferSize: 4 * 1024 * 1024, // rapor kanıt kareleri socket üzerinden gelir
});

const hub = initSockets(io);
admin.attachHub(hub);
api.attachHub(hub);

// Hata yakalayıcı: beklenmeyen hatalarda süreç ayakta kalır, hata loglanır.
process.on('uncaughtException', (err) => console.error('[fatal] uncaughtException:', err));
process.on('unhandledRejection', (err) => console.error('[fatal] unhandledRejection:', err));

server.listen(config.PORT, () => {
  console.log(`Proje X sunucusu: http://localhost:${config.PORT}`);
  console.log(`Yönetim paneli  : http://localhost:${config.PORT}/admin`);
  console.log(`OTP modu        : ${config.OTP_MODE}${config.OTP_MODE === 'dev' ? ' (kod API yanıtında döner, SMS gönderilmez)' : ''}`);
  const created = ensureAdminAccount();
  if (created) {
    console.log('--------------------------------------------------');
    console.log('İLK KURULUM: yönetici hesabı oluşturuldu');
    console.log(`  Kullanıcı: ${created.username}`);
    console.log(`  Şifre    : ${created.password}`);
    console.log(`  (${created.infoPath} dosyasına da yazıldı)`);
    console.log('--------------------------------------------------');
  }
});

module.exports = { app, server, io };
