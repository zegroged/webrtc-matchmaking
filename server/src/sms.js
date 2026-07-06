'use strict';
// SMS sağlayıcı soyutlaması.
// OTP_MODE=dev iken hiç SMS gönderilmez; kod API yanıtında `devCode` olarak döner.
// Üretim için: OTP_MODE=production yapın ve aşağıdaki sendSms'i Netgsm/Twilio
// çağrısıyla doldurun. Arayüz tek fonksiyondur, başka değişiklik gerekmez.

const config = require('./config');

async function sendSms(phone, message) {
  if (config.OTP_MODE === 'dev') {
    console.log(`[sms:dev] ${phone} -> ${message}`);
    return { ok: true, dev: true };
  }
  // ÜRETİM ENTEGRASYON NOKTASI (örnek Twilio):
  // const twilio = require('twilio')(process.env.TWILIO_SID, process.env.TWILIO_TOKEN);
  // await twilio.messages.create({ to: phone, from: process.env.TWILIO_FROM, body: message });
  throw new Error('SMS sağlayıcısı yapılandırılmadı (server/src/sms.js)');
}

module.exports = { sendSms };
