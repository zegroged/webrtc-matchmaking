'use strict';
const crypto = require('crypto');
const config = require('./config');

function hashPhone(phone) {
  return crypto.createHash('sha256').update(config.PHONE_SALT + normalizePhone(phone)).digest('hex');
}

// Telefonu E.164 benzeri biçime indirger. TR varsayılan ülke kodu.
function normalizePhone(raw) {
  if (typeof raw !== 'string') return null;
  let p = raw.replace(/[\s\-().]/g, '');
  if (!/^\+?\d{7,15}$/.test(p)) return null;
  if (p.startsWith('+')) return p;
  if (p.startsWith('00')) return '+' + p.slice(2);
  if (p.startsWith('0')) return '+90' + p.slice(1); // 05xx... -> +905xx...
  return '+90' + p;
}

function ageFromBirthDate(birthDate) {
  const bd = new Date(birthDate + 'T00:00:00Z');
  if (isNaN(bd.getTime())) return null;
  const now = new Date();
  let age = now.getUTCFullYear() - bd.getUTCFullYear();
  const m = now.getUTCMonth() - bd.getUTCMonth();
  if (m < 0 || (m === 0 && now.getUTCDate() < bd.getUTCDate())) age--;
  return age;
}

function isValidBirthDate(birthDate) {
  if (typeof birthDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(birthDate)) return false;
  const age = ageFromBirthDate(birthDate);
  return age !== null && age >= 0 && age <= 120;
}

function randomOtp() {
  return String(crypto.randomInt(100000, 1000000));
}

function nowMs() {
  return Date.now();
}

function pairKey(a, b) {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

module.exports = { hashPhone, normalizePhone, ageFromBirthDate, isValidBirthDate, randomOtp, nowMs, pairKey };
