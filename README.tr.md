# WebRTC Eşleştirme Motoru

> Gerçek zamanlı bir eşleştirme motoru ve WebRTC sinyalleşme sunucusu; Android, iOS ve Web için Flutter istemcisiyle birlikte.

![Node.js 22.13+](https://img.shields.io/badge/Node.js-22.13%2B-339933?logo=node.js&logoColor=white)
![Socket.IO](https://img.shields.io/badge/Socket.IO-4.8-010101?logo=socket.io&logoColor=white)
![WebRTC](https://img.shields.io/badge/WebRTC-P2P-333333?logo=webrtc&logoColor=white)
![Flutter](https://img.shields.io/badge/Flutter-Android%20%7C%20iOS%20%7C%20Web-02569B?logo=flutter&logoColor=white)
![SQLite](https://img.shields.io/badge/node%3Asqlite-yerle%C5%9Fik-003B57?logo=sqlite&logoColor=white)
![Testler](https://img.shields.io/badge/testler-27%20birim%20%2B%2050%20u%C3%A7tan%20uca-brightgreen)
![Lisans](https://img.shields.io/badge/lisans-MIT-blue)

[English README](README.md)

---

**Nasıl yazıldı:** kod yapay zekâ yardımıyla yazıldı ve yazar tarafından gözden geçirildi.

## Genel bakış

Bu proje yabancıları kısa, uçtan uca (P2P) görüntülü aramalarda eşleştirir ve sonrasında iki tarafın da isterse kalıcı bir bağlantı kurmasına izin verir. İlginç olan kısım video değil — onu `flutter_webrtc` hallediyor — çevresindeki her şey: **kimin kiminle** konuşması gerektiğine karar vermek, birbirini hiç görmemiş iki istemci arasında WebRTC el sıkışmasını yürütmek ve bekleme havuzu küçükken sistemi kullanılabilir tutmak.

Kod tabanının gerçekte etrafında kurulduğu iki problem şu: **havuz açken eşleşme kalitesi** ve **kötüye kullananlara nasıl kaçacaklarını öğretmeyen moderasyon**. Naif bir eşleştirici ya bulduğu ilk iki kişiyi eşler (kalite sıfırdır) ya da mükemmel eşleşmeyi bekler (kimse hiç eşleşmez). Buradaki motor her aday çifti ağırlıklı bir ölçüte göre puanlar ve sonra *kullanıcı bekledikçe kabul eşiğini gevşetir*; böylece yoğun bir havuz iyi eşleşmeler alır, boş bir havuz yine de eşleşme alır. Moderasyon katmanı Türkçe metni bir dizi kaçınma numarasına karşı normalleştirir (leet ikamesi, aksan temizleme, ayraç serpme, karakter tekrarı) ve sonra, **tasarım gereği**, işaretlenen mesajı yine de iletir; engellemek yerine işareti kaydeder ve gönderenin güven puanını düşürür. Engellemek, saldırgana hangi kelimenin filtreye takıldığını tam olarak söyler.

Arka uç tek bir Node.js süreci: REST için Express, eşleştirme kuyruğu ve sinyalleşme için Socket.IO, kalıcılık için `node:sqlite` (modern Node'a yerleşik). Yani sistemin tamamı `npm install && npm start` ile, harici bir veritabanı, aracı ya da konteyner olmadan çalışır. Flutter istemcisi Android, iOS ve Web'i hedefleyen tek bir kod tabanı. `/admin` altında düz HTML/CSS/JS bir yönetim paneli var: şikâyet kuyruğu, kullanıcı yönetimi ve bir acil durdurma anahtarı. **Bu bir teknik prototiptir — hiç yayınlanmadı ve kullanıcısı yok. Ondan başka bir anlam çıkarmadan önce [Bilinen sınırlamalar](#bilinen-sınırlamalar) bölümünü okuyun.**

---

## Teknoloji

| Katman | Tercih | Neden |
|---|---|---|
| İstemci | Flutter (Dart 3.12) | Android, iOS ve Web için tek kod tabanı |
| Video | `flutter_webrtc` 1.5 | P2P medya; varsayılan STUN, ortam değişkeniyle TURN |
| Gerçek zaman | Socket.IO 4.8 | Kuyruk, sinyal aktarımı, sohbet, çevrimiçilik — ack geri çağrılarıyla |
| Arka uç | Node.js 22.13+ / Express 4.21 | Asgari çalışma zamanı bağımlılığı (toplam 3 üretim paketi) |
| Veritabanı | `node:sqlite` (`DatabaseSync`) | Kurulacak DB sunucusu yok; WAL kipi, yabancı anahtarlar açık |
| Kimlik | `jsonwebtoken` 9 + SMS OTP | 30 günlük kullanıcı jetonu, 12 saatlik yönetici jetonu |
| Yönetim arayüzü | Düz HTML/CSS/JS | Derleme adımı yok; `/admin` altından statik sunulur |

Arka uç üretim bağımlılıkları: `express`, `socket.io`, `jsonwebtoken`. Listenin tamamı bu.

**Boyut:** 12 modülde ~2.000 satır arka uç kaynağı, ~1.500 satır yönetim paneli, ~350 satır birim testi, ~280 satır uçtan uca simülasyon ve ~4.000 satır Dart (6 ekran, bir sekme kabuğu ve paylaşılan istemci tesisatı). Şema 11 SQLite tablosu; HTTP yüzeyi üç yönlendirici üzerinde 28 REST ucu.

---

## Özellikler

**Eşleştirme (`server/src/matchmaking.js`)**
- Sert kural vetolarıyla ağırlıklı çift puanlama (ortak dil yoksa ya da taraflardan biri ötekini engellediyse → çift cezalandırılmaz, **yasaklanır**)
- Dört bekleme bandı boyunca kademeli eşik gevşemesi
- En uzun bekleyen kullanıcı önce seçer, böylece kimse açlığa düşmez
- Çift başına 5 dakikalık yeniden eşleşme bekleme süresi; atlamayla biten bir çift 24 saat daha puan cezası taşır (bellekte tutulur, yeniden başlatmada temizlenir)
- Kuyruk girişini süreç genelinde durduran yönetici acil durdurma anahtarı

**Sinyalleşme ve arama yaşam döngüsü (`server/src/sockets.js`)**
- Socket.IO üzerinden SDP teklif/yanıt ve ICE adayı aktarımı, yalnız iki soketin ait olduğu eşleşmeyle sınırlı
- ICE sunucu listesi `/api/rtc-config` adresinden sunulur (varsayılan iki Google STUN sunucusu, TURN ortamdan enjekte edilir)
- `initiator` bayrağı sunucu tarafında belirlenir, böylece teklifi tam olarak bir taraf oluşturur
- Eşleşme bitiş sebepleri süreyle birlikte izlenir (`skip` / `leave` / `report` / `disconnect`)
- Hesap başına tek etkin soket; ikinci bir giriş, birincisini `session:replaced` ile düşürür
- Uzak açıklama ayarlanana kadar istemci tarafında ICE adayı tamponlama

**Bağlantılar ve sohbet**
- Karşılıklı rıza: arkadaşlık yalnız **iki taraf da** eklemeye dokunduğunda kurulur. Tek taraflı bir istek arama ekranında hiç gösterilmez — sonradan bir gelen kutusunda belirir, böylece kimse o anda baskı hissetmez
- Arama bittikten sonra birini eklemek için 90 saniyelik pencere
- Okundu bilgisi, çevrimiçilik ve 5 saniyede 10 mesaj hız sınırıyla kalıcı birebir mesajlaşma
- Bir isteği reddetmek sessizdir — gönderene hiçbir zaman söylenmez

**Moderasyon (`server/src/moderation.js`)**
- Çok aşamalı normalleştirmeyle Türkçe + İngilizce metin filtresi
- Şikâyetler; şikâyet anında canlı video izinden yakalanan isteğe bağlı bir kanıt karesi ve mesaj şikâyetleri için bir sohbet alıntısıyla
- Otomatik askıya alma: 24 saat içinde **3 farklı** kullanıcıdan 3 şikâyet → 48 saat askı
- Şikâyetler, işaretlenen mesajlar ve arama telemetrisiyle sürülen güven puanı (0–100)
- Şikâyet tekilleştirme: bir kullanıcı tekrar tekrar şikâyet ederek bir başkasının güven puanını boşaltamaz

**Yönetim paneli (`server/public/admin/`)**
- Gösterge paneli: çevrimiçi / kuyrukta / aramada sayıları, 24 saatlik eşleşme hacmi, ortalama süre, atlama oranı, karşılıklı ekleme oranı, bekleyen şikâyetler, 24 saatlik mesaj ve işaretli mesaj sayıları
- Kanıt görüntüleyicili şikâyet kuyruğu; yok say / uyar / askıya al / yasakla eylemleri
- Kullanıcı arama, yasaklı listesi ve acil durdurma anahtarı

**Hesap ve güvenlik tesisatı**
- SMS OTP ile kayıt (6 hane, 5 dakika ömür, 5 deneme, 30 saniye yeniden gönderme bekleme süresi)
- Kayıtta 18+ kapısı; doğum tarihi kayıttan sonra değiştirilemez
- Yasaklar telefon özetine bağlıdır, böylece yasaklı bir numara öylece yeniden kaydolamaz
- Uygulama içi engelleme (arkadaşlığı siler ve gelecekteki eşleşmeleri kalıcı olarak veto eder)
- Uygulama içi hesap silme (işlemsel temizlik + mezar taşı kaydı + soket düşürme)

---

## Mimari / tasarım notları

### Kademeli eşik gevşemesi

`Matchmaker.tick()` saniyede bir çalışır. Bekleyen her kullanıcı için diğer bütün adayları puanlar, en iyisini tutar ve sonra o puanı **çiftin ne kadar beklediğinden** türetilen bir eşikle karşılaştırır:

```js
MATCH_THRESHOLDS: [
  { maxWaitMs:  5000, minScore:   60 },
  { maxWaitMs: 15000, minScore:   30 },
  { maxWaitMs: 30000, minScore:    0 },
  { maxWaitMs: Infinity, minScore: -200 },
]
```

Puanlama şöyle: aynı sohbet ruh hâli için `+50`, her ortak ilgi alanı için `+15`, yaş yakınlığı için `+max(0, 10 - yaşFarkı)`, bu çift daha önce atlamayla bittiyse `-30`, 5 dakikalık yeniden eşleşme bekleme süresi içindelerse `-100` ve ortalama güven puanları 50'nin altındaysa `-10`.

Son `-200` bandı taşıyıcı karardır. Anlamı şu: 30 saniyeden sonra `-100`'lük bekleme cezası bile aşılabilir hâle gelir — çünkü dört kişilik bir havuzda kimseyi yeniden eşleştirmemek, hiç kimseyi eşleştirmemek demektir. **Sert kurallar her bandı sağ atlatır**: ortak dil yoksa ya da taraflardan biri ötekini engellemişse `scorePair` düşük bir puan değil `null` döndürür ve `null` hiçbir eşikte eşleşemez. Yumuşak tercihler baskı altında erir; güvenlik kısıtları erimez. "Ceza" ile "veto" arasındaki bu ayrım modülün çekirdeğidir.

### İşaretlemek engellemekten iyidir

`checkText()` beş normalleştirme adımı uygular (Türkçe büyük-küçük harf katlama, aksan temizleme, leet ikamesi, ayraç temizleme ve karakter tekrarı sıkıştırma) ve kelime listesini ortaya çıkan her varyantla eşleştirir. Böylece `s.i.k.t.i.r`, `S1KT1R` ve `siktiiiir` aynı belirtece iner.

Türkçe harf katlama adımı özellikle gösterilmeye değer:

```js
// 'İ'.toLowerCase() 'i' + U+0307 uretir, bu yuzden Turkce I/İ once elle eslenir.
let t = String(text).replace(/İ/g, 'i').replace(/I/g, 'i').toLowerCase();
t = t.replace(/ı/g, 'i');
```

JavaScript'in `toLowerCase()` fonksiyonu `İ` (U+0130) harfini `i` ve ardından birleşen bir üst nokta (U+0307) olarak ayrıştırır. Aşağıdaki herhangi bir karşılaştırma düz bir `i` ile yapıldığında sessizce başarısız olur ve filtre sızdırır. Açık ön eşleme bunu kapatır.

Davranışsal karar, dizge işlemeden daha önemli: işaretlenen bir mesaj **yine de iletilir**. Sunucu `flagged = 1` yazar ve gönderenden 2 güven puanı düşer. Mesajı reddetmek, filtreyi bir kâhine çevirirdi — gönder, reddi gözle, ayarla, tekrarla; ta ki geçen bir yazım bulana kadar. Sessiz işaretleme saldırgana hiçbir sinyal vermezken yönetim kuyruğunun üzerinde çalıştığı kanıt izini yine de biriktirir.

### Biriken telemetri olarak güven puanı

Güven bir moderasyon hükmü değil; *eşleştirmeye geri besleyen* akan bir sinyaldir. Yalnız şikâyetlerle değil, olağan kullanımla da hareket eder: 5 saniye içinde atlanmak, atlanan kullanıcıya 1 puana mal olur; 2 dakikayı aşan bir arama iki tarafa da 1 puan kazandırır; işaretlenen bir mesaj 2, bir şikâyet 5, otomatik askıya alma 15 puana mal olur; bir yöneticinin reddettiği şikâyet ise suçlanana 5 puan iade eder. Çift ortalaması 50'nin altına düştüğünde `scorePair` 10 puan düşer — düşük güvenli kullanıcılar yasaklanmak yerine önceliksizleştirilir; bu, muhtemel kötü aktörlerin deneyimini sert ve itiraz edilebilir bir karar olmadan bozar.

### Sağlayıcı dikişleri

Satıcı hesabı gerektirecek her entegrasyon tek bir fonksiyonun arkasına alınmıştır, böylece sistem hesap olmadan uçtan uca çalışır:

- `sms.js` tek bir `sendSms()` sunar. `dev` kipinde göndermek yerine loglar ve OTP, API yanıtında `devCode` olarak döner — otomatik uçtan uca koşumu mümkün kılan da budur.
- ICE sunucuları `config.js` içinde kurulur; TURN eklemek üç ortam değişkeni, sıfır kod değişikliği demektir ve istemciler sonucu sabit kodlamak yerine çalışma anında çeker.
- Metin filtresinde harici bir moderasyon API'si için işaretlenmiş bir genişletme noktası var.

### Anılmaya değer arıza kipi işlemleri

Birkaç küçük karar, eşzamanlılık ya da düşmanca girdi altında neyin bozulacağını düşünmekten çıktı:

- **Eşleşme oluşturma, kuyruk ortasındaki kopmalara karşı korumalı.** Soketlerden biri kuyruğa alınmayla eşleştirilme arasında kaybolduysa `onMatch`, yarı ölü bir eşleşme yaratmak yerine sağ kalanı kuyruğa geri koyar.
- **Sohbet alıntıları asla JSON olarak kesilmez.** Her mesaj gövdesi `JSON.stringify` işleminden **önce** sınırlanır, çünkü serileştirilmiş bir dizgeyi dilimlemek geçersiz JSON üretir — ve tam bu durum için bir regresyon testi vardır.
- **Bir şikâyet yalnız bir kez sonuçlandırılabilir.** `/reports/:id/resolve`, zaten incelenmiş bir şikâyette `409` döner; böylece aynı anda tıklayan iki yönetici çelişen eylemler uygulayamaz. "Askıya al" eylemi ayrıca `AND status != 'banned'` ile korunur, dolayısıyla bir yasağı sessizce aşağı çekemez.
- **Avatar yüklemeleri beyan edilen türe göre değil, sihirli baytlara göre doğrulanır** ve RIFF dalı ayrıca 8. konumda `WEBP` imzasını şart koşar — aksi hâlde her WAV ve AVI dosyası görsel olarak geçerdi.
- **Kanıt dosyaları yalnız yöneticiye açıktır** ve dosya adı, yol geçişini engellemek için `path.basename()` içinden geçirilir.
- **Telefon numaraları hiçbir zaman düz metin saklanmaz** — yalnız bir SHA-256 özeti, ki yasaklar da ona bağlıdır.
- **Şema göçleri eklemelidir** ve bir `ensureColumn()` yardımcısıyla uygulanır, çünkü `CREATE TABLE IF NOT EXISTS` zaten var olan bir tabloyu değiştirmez.

### Tercihen tek süreç, dikişleri işaretlenmiş hâlde

Ölçekte Redis'te yaşayacak durum — bekleme havuzu, çevrimiçilik, etkin eşleşmeler, sohbet hız sınırları — `Map` yapılarında duruyor. Bu bilinçli bir takas: prototipi çalıştırmak için sıfır altyapı, karşılığında yatay ölçeklenememe. Geçiş noktaları, değişmesi gereken yerlerde kaynakta işaretlenmiştir.

---

## Başlarken

**Gereksinimler:** Node.js 22.13+ ya da 24+, ve Dart 3.12+ taşıyan bir Flutter sürümü (`app/pubspec.yaml` içinde `sdk: ^3.12.1`). Sürüm tabanının sebebi `node:sqlite`: Node 22.5 öncesinde yoktur ve 22.5–22.12 sürümlerinde `npm start` komutunun geçirmediği bir `--experimental-sqlite` bayrağı ister.

```bash
# Arka uç
cd server
npm install
npm start          # http://localhost:3000  — yönetim paneli /admin altında
```

Sunucu `dev` OTP kipinde başlar: SMS gönderilmez ve doğrulama kodu API yanıtında `devCode` olarak döner. İlk çalıştırmada bir yönetici parolası üretip `data/ADMIN_BILGILERI.txt` dosyasına, bir JWT anahtarı da `data/.jwt-secret` dosyasına yazar (`data/` dizininin tamamı gitignore'dadır).

```bash
# Web istemcisi — aynı sunucuya derlenir, yani tek süreç her şeyi sunar
cd app
flutter build web --release
cd ../server && npm start        # http://localhost:3000 adresini aç

# Android
cd app
flutter run                       # emülatör ana makineye varsayılan olarak 10.0.2.2:3000 ile ulaşır
flutter build apk --release

# iOS (macOS + Xcode gerekir)
cd app
flutter build ios --release
```

Fiziksel bir Android cihazda, açılış ekranındaki "sunucu adresi" alanına makinenin yerel ağ adresini gir; değer `SharedPreferences` içinde saklanır. Tarayıcılar kamera ve mikrofon erişimini yalnız `localhost` ya da HTTPS üzerinden verir.

```bash
# Testler
cd server
npm test           # 27 birim testi (eşleştirme, moderasyon, şikâyetler, şema göçü)
npm run e2e        # 50 doğrulama: sunucuyu başlatır, üç simüle kullanıcıyı uçtan uca sürer
npm run seed       # yönetim paneli için demo veri

cd app
flutter analyze
flutter test
```

Uçtan uca simülasyon şunları kapsar: kayıt (18 yaş altı reddi dahil), eşleştirme, WebRTC sinyal alışverişi, karşılıklı arkadaş ekleme, küfür filtresiyle kalıcı mesajlaşma, avatar yükleme ve görsel olmayan verinin reddi, kanıt kareli şikâyet, engelleme ve acil durdurma anahtarı dahil tüm yönetim API'si.

### Yapılandırma

Kopyalanacak bir `.env` dosyası yok — her şey, `server/src/config.js` içinde çalışan varsayılanlarıyla ortam değişkenlerinden okunur:

| Değişken | Varsayılan | Amaç |
|---|---|---|
| `PORT` | `3000` | HTTP portu |
| `PROJEX_DATA_DIR` | `<depo>/data` | SQLite veritabanı, kanıt kareleri, avatarlar, sırlar |
| `PROJEX_DB_FILE` | `<veri dizini>/projex.db` | Veri dizininin dışında durması gerekiyorsa SQLite dosya konumu |
| `PROJEX_OTP_MODE` | `dev` | `production`, `sms.js` içinde gerçek bir SMS sağlayıcısı ister |
| `PROJEX_PHONE_SALT` | yerleşik sabit | Gerçek bir dağıtımda **mutlaka değiştirilmeli** |
| `PROJEX_TURN_URL` / `_USER` / `_PASS` | tanımsız | TURN aktarımı; onsuz simetrik NAT arkasındaki kullanıcılar bağlanamaz |

---

## Bilinen sınırlamalar

Bunlar gerçek boşluklar; kimse kaynağı okuyarak keşfetmek zorunda kalmasın diye listelendi.

- **Görsel ya da video moderasyonu yok. Kodun üretime hazır olmamasının sebebi budur.** Filtre yalnız metindir. Canlı video akışını hiçbir şey incelemez — cihaz üstü NSFW ön filtresi yok, bulut görüntü API'si yok, periyodik kare örneklemesi yok. İstemci bir kare yakalayabilir (`call_screen.dart` içinde `_captureSnapshot`), ama bu yalnız bir kullanıcı şikâyet ettiğinde çalışır. Otomatik video moderasyonu olmayan rastgele bir görüntülü eşleştirme servisi işletilmemelidir ve bu da işletilmiyor.
- **Yaş kapısı beyana dayalıdır.** Kayıt, doğum tarihine göre 18 yaş altını reddeder ve tarih sonradan kilitlenir, ama bunu hiçbir şey doğrulamaz. Tek gerçek kimlik sinyali telefon numarası sahipliğidir.
- **Küfür listesi elle bakılan küçük bir kelime listesidir.** Normalleştirici mekanik gizlemeyi bozar, yeni kelime dağarcığını değil; ayrıca alt dizge eşleştirmenin olağan yanlış-pozitif riskini taşır. Gerçek bir dağıtım, işaretlenmiş genişletme noktasının arkasına harici bir moderasyon API'si ister.
- **Yalnızca tek süreç.** Eşleştirme havuzu, çevrimiçilik tablosu, etkin eşleşme kaydı ve hız sınırlayıcılar bellek içi `Map` yapılarıdır ve bir Socket.IO Redis adaptörü yoktur. İki örnek çalıştırmak eşleştirme havuzunu böler ve sinyalleşmeyi bozar. SQLite yazmaları eşzamanlıdır ve olay döngüsünde sıraya girer.
- **SMS sağlayıcısı bir stub.** `sendSms()`, bir entegrasyon doldurulana kadar üretim kipinde hata fırlatır. `dev` yedeği OTP'yi HTTP yanıtında döndürür; bu test için uygun, yayınlanırsa kritik bir açıktır.
- **Telefon özetleme, uygulama genelinde tek bir sabit tuz kullanır.** Özet dolayısıyla tüm kullanıcılarda belirlenimlidir; veritabanı ve tuz elde olduğunda telefon numarası uzayı numaralandırılabilecek kadar küçüktür. Gerçek bir dağıtım, anahtarı veritabanının dışında tutulan bir HMAC ister.
- **Push bildirimi yok.** Çevrimdışı bir kullanıcıya giden mesajlar saklanır ama uygulama yeniden bağlanana kadar iletilmez. FCM/APNs bağlanma noktası `chat:send` işleyicisinde işaretlidir.
- **Arayüz yalnız Türkçe.** Metinler widget'lara gömülüdür; ARB/l10n kurulumu yoktur ve `en` desteklenen diller arasında listelenmesine rağmen uygulama yereli `tr` olarak sabitlenmiştir.
- **İstemci test kapsamı ince.** Dart tarafında tek bir widget testi var. Anlamlı test kapsamının tamamı — 27 birim testi ve 50 uçtan uca doğrulama — arka uçtadır.
- **Geliştirme kipi taşıma ayarları hâlâ açık.** Android'de `usesCleartextTraffic="true"` ayarlı ve sunucu düz HTTP sunuyor; gerçek bir dağıtımdan önce ikisi de değişmeli.
- **Kanıt kareleri yerel diskte şifresiz saklanır**, saklama politikası ya da otomatik süre sonu yoktur.

---

## Durum

Teknik prototip. **Hiç yayınlanmadı, sıfır kullanıcı, üretim dağıtımı yok.** Düzgün çözmek istediğim iki problemi çalışmak için yapıldı — aç bir havuzda eşleştirme ve kaçınmaya direnen metin moderasyonu — ve orada durdu; çünkü rastgele bir görüntülü eşleştirme ürününü sorumlu biçimde yayınlamak otomatik video moderasyonu ve gerçek yaş doğrulaması gerektirir, ben de ikisini de iyi yapacak durumda değildim.

Bir referans uygulaması olarak yayımlanıyor. Okunmaya değer kısımlar `matchmaking.js` ve `moderation.js`; geri kalanı, onları uçtan uca test edilebilir kılan çevre sistemdir. Yukarıda iddia edilen her şey kaynakta doğrulanabilir ve test takımları harici servis olmadan çevrimdışı çalışır.

---

## Lisans

MIT — bkz. [LICENSE](LICENSE).
