'use strict';
process.env.PROJEX_DATA_DIR = require('path').join(require('os').tmpdir(), 'projex-test-mod-' + process.pid);

const { test } = require('node:test');
const assert = require('node:assert');
const { checkText, normalizeText } = require('../src/moderation');

test('temiz metin işaretlenmez', () => {
  assert.equal(checkText('Merhaba, nasılsın? Bugün hava çok güzel.').flagged, false);
  assert.equal(checkText('Hello there, how are you today?').flagged, false);
});

test('Türkçe küfür yakalanır', () => {
  assert.equal(checkText('siktir git').flagged, true);
  assert.equal(checkText('tam bir orospu çocuğusun').flagged, true);
});

test('İngilizce küfür yakalanır', () => {
  assert.equal(checkText('you are a fucking idiot').flagged, true);
});

test('büyük harf ve Türkçe karakter varyantları yakalanır', () => {
  assert.equal(checkText('SİKTİR').flagged, true);
  assert.equal(checkText('Orospu').flagged, true);
});

test('leet yazımı yakalanır', () => {
  assert.equal(checkText('s1kt1r lan').flagged, true);
  assert.equal(checkText('f4ck you').flagged, false); // listede yok, yanlış pozitif üretmemeli
});

test('ayraçla gizleme yakalanır', () => {
  assert.equal(checkText('s.i.k.t.i.r').flagged, true);
  assert.equal(checkText('o-r-o-s-p-u').flagged, true);
});

test('tekrarlı harf şişirme yakalanır', () => {
  assert.equal(checkText('siktiiiiir').flagged, true);
});

test('masum kelimeler yanlış pozitif vermez', () => {
  assert.equal(checkText('pislik değil, temizlik yapıyorum').flagged, false);
  assert.equal(checkText('sıkı çalışmak lazım').flagged, false);
  assert.equal(checkText('Fenerbahçe maçı izledim').flagged, false);
});

test('normalizeText aksan ve leet dönüşümü yapar', () => {
  assert.equal(normalizeText('ŞıKıŞ'), 'sikis');
  assert.equal(normalizeText('h3ll0'), 'hello');
});
