/**
 * Проверки разбора и чистки текстов песен.
 *
 * Запуск: node server/lyricstest.mjs (входит в npm test).
 * Покрывает реальные случаи из эксплуатации:
 *  - метки NetEase с хвостом-диапазоном [00:00.00-1];
 *  - китайская заглушка «纯音乐，请欣赏» вместо текста;
 *  - кредиты «作词 : имя»;
 *  - текст на чужом языке под русским названием.
 */

import assert from 'node:assert/strict';
import {
  cleanPlainLines,
  cleanSynced,
  languageMismatch,
  looksInstrumental,
  parseLrc,
  scriptShares,
} from './lyrics.mjs';

let passed = 0;
const checks = [];

function check(name, fn) {
  checks.push([name, fn]);
}

check('LRC с обычными метками', () => {
  const lines = parseLrc('[00:12.50]Первая строка\n[00:15.00]Вторая');
  assert.equal(lines.length, 2);
  assert.equal(lines[0].time, 12.5);
  assert.equal(lines[1].text, 'Вторая');
});

check('LRC с хвостом-диапазоном NetEase', () => {
  const lines = parseLrc('[00:00.00-1] 作词 : Борисенко\n[00:32.10-2]Тёплое место');
  assert.equal(lines.length, 2);
  assert.equal(lines[0].time, 0);
  assert.equal(lines[1].time, 32.1);
  assert.equal(lines[1].text, 'Тёплое место');
});

check('кредиты отфильтровываются', () => {
  const lines = cleanSynced([
    { time: 0, text: '作词 : Борисенко Даниил' },
    { time: 1, text: 'Producer: Someone' },
    { time: 32, text: 'Тёплое место, но улицы ждут' },
  ]);
  assert.equal(lines.length, 1);
  assert.match(lines[0].text, /Тёплое место/);
});

check('заглушка инструментала распознаётся', () => {
  assert.equal(looksInstrumental('纯音乐，请欣赏'), true);
  assert.equal(looksInstrumental('此歌曲为没有填词的纯音乐'), true);
  assert.equal(looksInstrumental('Тёплое место'), false);
});

check('заглушка не считается строкой текста', () => {
  const synced = cleanSynced([{ time: 0, text: '纯音乐，请欣赏' }]);
  assert.equal(synced.length, 0);
  const plain = cleanPlainLines('纯音乐，请欣赏');
  assert.equal(plain.length, 0);
});

check('чужой язык определяется', () => {
  assert.equal(languageMismatch('Группа крови', '너무 멀리 왔어\nI just lied to you'), true);
  assert.equal(languageMismatch('Группа крови', 'Тёплое место, но улицы ждут'), false);
  assert.equal(languageMismatch('Hello', 'Hello, it is me'), false);
  assert.equal(languageMismatch('Hello', '안녕하세요 오랜만이에요'), true);
});

check('доли письменностей считаются', () => {
  const shares = scriptShares('Привет hello');
  assert.ok(shares.cyrillic > 0.4 && shares.latin > 0.3);
});

check('текст без тегов остаётся как есть', () => {
  const lines = cleanPlainLines('Первая строка\nВторая строка');
  assert.deepEqual(lines, ['Первая строка', 'Вторая строка']);
});

for (const [name, fn] of checks) {
  try {
    fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (err) {
    console.error(`  FAIL ${name}: ${err.message}`);
    process.exitCode = 1;
  }
}

console.log(`\nВсе проверки пройдены: ${passed}`);
if (passed !== checks.length) process.exit(1);
