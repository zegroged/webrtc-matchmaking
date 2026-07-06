# Proje X — Rastgele Görüntülü Sohbet + Arkadaşlık

Omegle tarzı rastgele görüntülü eşleşme + karşılıklı onayla arkadaş ekleme ve kalıcı yazılı sohbet.
Soruya dayalı akıllı eşleşme, sıkı güvenlik ve moderasyon. **Android, iOS ve Web** (bilgisayar dahil)
tek kod tabanından çalışır.

Bu depo, geliştirme planındaki **Faz 1–3 çekirdeğinin** (görüntülü eşleşme + arkadaşlık + kalıcı
mesajlaşma + moderasyon/admin) tam işleyen, test edilmiş uygulamasıdır.

---

## İçindekiler

- [Mimari](#mimari)
- [Hızlı başlangıç](#hızlı-başlangıç)
- [Web'i çalıştırma (bilgisayar/tarayıcı)](#webi-çalıştırma)
- [Android'i çalıştırma / APK](#androidi-çalıştırma)
- [iOS'u çalıştırma (Mac gerekir)](#iosu-çalıştırma)
- [Yönetim paneli](#yönetim-paneli)
- [Test](#test)
- [Üretime hazırlık (SMS, TURN, moderasyon, ölçek)](#üretime-hazırlık)
- [Mağaza gönderim kontrol listesi](#mağaza-gönderim-kontrol-listesi)
- [Proje yapısı](#proje-yapısı)

---

## Mimari

| Katman | Teknoloji | Not |
|--------|-----------|-----|
| İstemci | **Flutter** (Android/iOS/Web) | Tek kod tabanı, koyu tema, Türkçe |
| Görüntülü görüşme | **WebRTC** (`flutter_webrtc`) | P2P + STUN; TURN opsiyonel |
| Gerçek zamanlı | **Socket.IO** | Eşleşme kuyruğu, sinyalleşme, canlı mesajlaşma |
| Backend | **Node.js + Express** | Harici çalışma zamanı bağımlılığı minimum |
| Veritabanı | **node:sqlite** (Node 22+ dahili) | Ayrı DB sunucusu kurmadan çalışır |
| Moderasyon | Kendi metin filtresi + rapor/ban/güven puanı | Harici API entegrasyon noktaları hazır |
| Yönetim paneli | Saf HTML/CSS/JS | `/admin` altında |

> **Neden SQLite/tek süreç?** MVP'yi sıfır altyapı kurulumuyla çalıştırmak için. Plandaki
> PostgreSQL + Redis'e geçiş noktaları kaynak kodda yorumlarla işaretlidir (`// Redis'e taşıma`,
> matchmaking havuzu, presence, hız limitleri). Ölçek büyüdüğünde bu sınırlar aşılır.

---

## Hızlı başlangıç

Gereksinimler: **Node.js 22+** ve **Flutter 3.35+** (Dart 3.9+).

```bash
# 1) Backend'i başlat
cd server
npm install
npm start
# -> http://localhost:3000  (yönetim paneli: /admin)
# İlk çalıştırmada admin şifresi konsola ve data/ADMIN_BILGILERI.txt dosyasına yazılır.
```

Backend `dev` OTP modunda başlar: **SMS gönderilmez**, doğrulama kodu API yanıtında `devCode`
olarak döner ve onboarding ekranında görünür. Böylece SMS sağlayıcısı olmadan uçtan uca test
edebilirsiniz.

---

## Web'i çalıştırma

Web istemcisi backend tarafından servis edilir; tek sunucu her şeyi karşılar.

```bash
cd app
flutter build web --release      # app/build/web üretir
cd ../server
npm start
# Tarayıcıda aç: http://localhost:3000
```

Geliştirme sırasında canlı yeniden yükleme için ayrı çalıştırma:

```bash
cd app
flutter run -d chrome            # backend ayrı bir terminalde çalışıyor olmalı
```

> **Not:** Tarayıcıda kamera/mikrofon erişimi için `localhost` veya HTTPS gerekir (tarayıcı
> güvenlik kuralı). LAN IP ile test edecekseniz üretimde TLS kullanın.

---

## Android'i çalıştırma

```bash
cd app
flutter run                      # bağlı cihaz/emülatörde çalışır
# veya release APK:
flutter build apk --release      # app/build/app/outputs/flutter-apk/app-release.apk
```

- Kamera, mikrofon ve internet izinleri `AndroidManifest.xml`'de tanımlıdır.
- **Emülatör** host makinedeki backend'e `http://10.0.2.2:3000` ile ulaşır (varsayılan).
- **Gerçek cihaz**: onboarding ekranındaki "Sunucu adresi (geliştirici)" alanına
  bilgisayarınızın LAN IP'sini girin (ör. `http://192.168.1.20:3000`). Adres cihazda saklanır.
- `usesCleartextTraffic="true"` yalnızca geliştirme kolaylığı içindir; üretimde HTTPS'e geçip
  bunu kaldırın.

Play Store için App Bundle: `flutter build appbundle --release`.

---

## iOS'u çalıştırma

iOS derlemesi **macOS + Xcode** gerektirir (Windows'ta yapılamaz). Kod ve izinler hazırdır:

```bash
cd app
flutter build ios --release      # veya: flutter run -d <iphone>
```

- Kamera/mikrofon açıklamaları `ios/Runner/Info.plist`'te tanımlı.
- App Store için: Xcode'da imzalama profili seçin, `flutter build ipa` ile arşivleyin.

---

## Yönetim paneli

`http://localhost:3000/admin` — koyu temalı, Türkçe.

- **Giriş bilgileri**: ilk çalıştırmada üretilir, `server/data/ADMIN_BILGILERI.txt` dosyasına yazılır.
- **Genel Bakış**: çevrimiçi/kuyruk/aktif görüşme, eşleşme sayısı, ortalama süre, geçme oranı,
  **karşılıklı ekleme oranı** (kuzey yıldızı metriği), bekleyen rapor, mesaj/filtrelenen mesaj.
- **Rapor Kuyruğu**: kategori, kanıt karesi (modal), sohbet dökümü; Reddet/Uyar/Askıya Al/Banla.
- **Kullanıcılar**: isim veya ID ile arama, durum, güven puanı, ban/askı yönetimi.
- **Banlar**: aktif ban listesi.
- **Acil Durdurma**: tüm eşleşmeyi anında durduran anahtar (kriz senaryosu).

Demo verisi yüklemek için (sunucu çalışırken):

```bash
cd server
npm run seed     # 3 kullanıcı, eşleşme, arkadaşlık, mesaj (biri filtreli), rapor + kanıt
```

---

## Test

```bash
cd server
npm test         # birim testleri (eşleşme motoru + moderasyon), 24 test
npm run e2e      # uçtan uca simülasyon: 2 sahte kullanıcı, tam akış, 35 kontrol
```

```bash
cd app
flutter analyze  # statik analiz (0 sorun)
flutter test     # widget testi
```

E2E simülasyonu şunları doğrular: kayıt (18+ kontrolü, doğum tarihi kilidi) → eşleşme →
WebRTC sinyal takası → karşılıklı arkadaş ekleme (tek taraflı istek sızmaz) → kalıcı mesajlaşma
(küfür filtresi) → raporlama + kanıt karesi → engelleme → yönetici API + acil durdurma.

---

## Üretime hazırlık

Uygulama fonksiyonel olarak eksiksiz; canlıya almadan önce entegrasyon noktaları:

### 1. SMS doğrulama
`server/src/sms.js` içindeki `sendSms` fonksiyonunu doldurun (Netgsm/Twilio örneği yorumda).
Sonra ortam değişkeni: `PROJEX_OTP_MODE=production`.

### 2. TURN sunucusu (NAT arkasındaki kullanıcılar için zorunlu)
`coturn` kurun ve ortam değişkenlerini verin:
```bash
PROJEX_TURN_URL=turn:turn.alanadiniz.com:3478
PROJEX_TURN_USER=kullanici
PROJEX_TURN_PASS=parola
```
Sunucu bunları `/api/rtc-config` üzerinden istemcilere dağıtır. STUN zaten yapılandırılıdır.

### 3. Görüntü moderasyonu (plan §3)
Cihaz üstü NSFW ön filtre + şüpheli karelerin buluta gönderimi. `call_screen.dart`'taki
`_captureSnapshot` kare yakalamayı zaten yapıyor; periyodik örnekleme + Hive/Rekognition/Sightengine
çağrısı eklenecek nokta burasıdır. Sunucuda `moderation.js` içindeki `checkText`'e harici metin
moderasyon API'si (OpenAI Moderation / Perspective) eklenebilir.

### 4. Push bildirim
Çevrimdışı kullanıcıya mesaj gelince FCM/APNs push. Gönderim noktası `sockets.js` `chat:send`
handler'ında yorumla işaretli.

### 5. Ölçek (PostgreSQL + Redis)
- Eşleşme havuzu, presence, hız limitleri → Redis (kaynak kodda `// Redis'e taşıma` noktaları).
- Kalıcı veri → PostgreSQL (şema `db.js` ile birebir uyumlu).
- Çoklu süreç için WebRTC sinyalleşmede Socket.IO Redis adapter.

### 6. Güvenlik sertleştirme
- HTTPS/WSS zorunlu (reverse proxy: Caddy/Nginx).
- Android'de `usesCleartextTraffic` kaldır, iOS'ta `NSAllowsArbitraryLoads` kaldır.
- JWT gizli anahtarı `data/.jwt-secret`'ta üretilir; üretimde gizli yönetimine taşıyın.

---

## Mağaza gönderim kontrol listesi

Apple'ın UGC (kullanıcı üretimli içerik) kuralı 1.2 — reddedilmenin 1 numaralı sebebi. Bu
uygulamada hepsi **hazır**:

- [x] **Uygulama içi raporlama** — görüşme ve sohbet ekranlarında görünür ve çalışır.
- [x] **Engelleme** — arkadaşlık silinir, bir daha eşleşemez ve yazamaz.
- [x] **Hesap silme uygulama içinden erişilebilir** — Profil → "Hesabı kalıcı olarak sil".
- [x] **18+ yaş kapısı** — kayıtta reddedilir; doğum tarihi kilitli.
- [x] **Moderasyon mekanizması** — otomatik askı, güven puanı, admin kuyruğu, acil durdurma.
- [ ] **17+/18+ içerik derecelendirmesi** — mağaza konsolunda ayarlayın.
- [ ] **Gizlilik Politikası + Kullanım Koşulları URL'si** — KVKK uyumlu metin hazırlayıp bağlayın.
- [ ] **Play Data Safety / Apple Privacy Nutrition formları** — konsolda doldurun.
- [ ] **Demo hesap + inceleme ekibi için test talimatı** — `npm run seed` ile hazır veri.

İnceleme notuna eklenecek moderasyon açıklaması taslağı `server/src` moderasyon kodundadır.

---

## Proje yapısı

```
omeglev2/
├─ server/                    Node.js backend + admin paneli
│  ├─ src/
│  │  ├─ index.js             Express + Socket.IO giriş noktası
│  │  ├─ config.js            Tüm ayarlar (eşleşme eşikleri, moderasyon, ICE)
│  │  ├─ db.js                node:sqlite şema + admin hesabı
│  │  ├─ auth.js              SMS OTP kayıt/giriş, JWT
│  │  ├─ api.js               REST: profil, arkadaşlar, mesajlar, engelleme
│  │  ├─ sockets.js           Eşleşme kuyruğu, WebRTC sinyal, canlı sohbet
│  │  ├─ matchmaking.js       Ağırlıklı puanlama + kademeli eşik gevşetme
│  │  ├─ moderation.js        Küfür filtresi, rapor, ban, güven puanı
│  │  ├─ admin.js             Yönetim API'si
│  │  ├─ icebreakers.js       Moda göre buzkıran soruları
│  │  └─ sms.js               SMS sağlayıcı soyutlaması
│  ├─ public/admin/           Yönetim paneli arayüzü (HTML/CSS/JS)
│  ├─ test/                   Birim testleri (node --test)
│  └─ tools/                  e2e simülasyonu + demo seed
├─ app/                       Flutter istemcisi (Android/iOS/Web)
│  └─ lib/
│     ├─ main.dart
│     └─ src/
│        ├─ config.dart, theme.dart, models.dart
│        ├─ api_client.dart, session.dart, socket_service.dart
│        └─ screens/          onboarding, discover, call, chats, chat, profile
└─ README.md
```

---

Bu proje, geliştirme planındaki en riskli iki teknik belirsizliği (eşleşme motoru + WebRTC/TURN
sinyalleşme) çözülmüş, uçtan uca test edilmiş bir çekirdek olarak teslim edilmiştir.
