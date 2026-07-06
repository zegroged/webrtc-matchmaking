'use strict';
// Moda göre buzkıran soruları. Eşleşme kurulduğunda ikisine de aynı soru gösterilir.
const QUESTIONS = {
  derin: [
    'Hayatında seni en çok değiştiren olay neydi?',
    'İnsanların çoğunun fark etmediği ama senin fark ettiğin şey ne?',
    'Beş yıl önceki sana tek bir cümle söyleyebilsen ne derdin?',
    'Mutluluk sence bir hedef mi, yan etki mi?',
    'En son ne zaman fikrini kökten değiştirdin?',
    'Kimsenin sormadığı ama cevabını anlatmak istediğin soru ne?',
  ],
  hafif: [
    'Bugün seni gülümseten en küçük şey neydi?',
    'Tartışmaya kapalı en garip yemek görüşün ne?',
    'Telefonundaki en gereksiz uygulama hangisi?',
    'Hangi şarkıyı utanmadan sonuna kadar açarsın?',
    'Kahve mi çay mı — ve neden haklısın?',
    'Hafta sonu için mükemmel plan nedir?',
  ],
  dil: [
    'Öğrendiğin dilde en sevdiğin kelime ne? / What is your favorite word?',
    'Bu dili neden öğreniyorsun? / Why are you learning this language?',
    'En çok zorlandığın telaffuz hangisi? / Which pronunciation is hardest for you?',
    'Dizi mi kitap mı — dil öğrenmek için hangisi? / Series or books for learning?',
    'Kendi dilinde çevirisi olmayan bir kelime söyle. / Say an untranslatable word.',
  ],
  eglence: [
    'İki doğru bir yalan söyle, ben bileyim!',
    'Zombi kıyametinde ilk işin ne olurdu?',
    'En kötü süper güç ne olurdu?',
    'Hayvan olsan hangi hayvan olurdun ve neden?',
    '10 saniyede beni güldürebilir misin?',
    'En absürt "keşke" anını anlat.',
  ],
};

function pickIcebreaker(mood) {
  const pool = QUESTIONS[mood] || QUESTIONS.hafif;
  return pool[Math.floor(Math.random() * pool.length)];
}

module.exports = { pickIcebreaker, QUESTIONS };
