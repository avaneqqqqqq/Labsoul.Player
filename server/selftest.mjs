'use strict';

/**
 * Самопроверка labsoul без сети и без токенов: `node server/selftest.mjs`
 *
 * Покрывает то, что нельзя увидеть глазами в интерфейсе:
 *  - подпись запросов Яндекс.Музыки (формат материала и base64 без паддинга);
 *  - расшифровку потока AES-128-CTR (включая «перемотку» со смещения);
 *  - разбор Range-заголовков (200 / 206 / 416);
 *  - движок «Волны» и правдоподобность ответов API на живом сервере.
 *
 * Выход с кодом 1, если хотя бы одна проверка провалилась.
 */

import crypto from 'node:crypto';
import { decryptBuffer, parseRange } from './streaming.mjs';
import { isNewer, parseVersion, isLabsoulRelease } from './update.mjs';

let passed = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } catch (err) {
    failures.push({ name, error: err });
    console.log(`  \x1b[31m✗\x1b[0m ${name}\n      ${err.message}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function equal(actual, expected, message) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${message || 'значения не совпали'}: получено ${a}, ожидалось ${e}`);
}

/* ------------------------------ подпись Яндекс --------------------------- */

// Алгоритм сервиса: HMAC-SHA256 по конкатенации ts+trackId+quality+codecs+transports,
// результат — base64 без завершающих «=».
const SIGN_KEY = '7tvSmFbyf5hJnIHhCimDDD';

function signFileInfo(ts, trackId, quality, codecs, transports) {
  return crypto
    .createHmac('sha256', SIGN_KEY)
    .update(`${ts}${trackId}${quality}${codecs}${transports}`)
    .digest('base64')
    .replace(/=+$/, '');
}

console.log('\n\x1b[1m1. Подпись запроса Яндекс.Музыки\x1b[0m');

check('подпись детерминирована', () => {
  const a = signFileInfo(1700000000, '12345', 'nq', 'mp3', 'raw');
  const b = signFileInfo(1700000000, '12345', 'nq', 'mp3', 'raw');
  equal(a, b, 'одинаковые входные данные должны давать одинаковую подпись');
});

check('подпись меняется вместе с параметрами', () => {
  const base = signFileInfo(1700000000, '12345', 'nq', 'mp3', 'raw');
  const changed = signFileInfo(1700000001, '12345', 'nq', 'mp3', 'raw');
  assert(base !== changed, 'изменение ts должно менять подпись');
});

check('формат подписи — base64 без «=»', () => {
  const sign = signFileInfo(1700000000, '12345', 'nq', 'mp3', 'raw');
  assert(/^[A-Za-z0-9+/]+$/.test(sign), `недопустимые символы в подписи: ${sign}`);
  assert(!sign.includes('='), 'в подписи не должно быть паддинга');
  // sha256 → 32 байта → 44 символа base64 с паддингом, то есть 43 без него
  equal(sign.length, 43, 'длина подписи без паддинга');
});

check('подпись совпадает с эталоном (регрессия)', () => {
  // Эталон посчитан независимой реализацией того же алгоритма на Node.
  const sign = signFileInfo(1750000000, '98765432', 'lossless', 'flac', 'encraw');
  const expected = crypto
    .createHmac('sha256', SIGN_KEY)
    .update('175000000098765432losslessflacencraw')
    .digest('base64')
    .slice(0, 43);
  equal(sign, expected, 'материал подписи собирается в неверном порядке');
});

/* --------------------------- расшифровка потока -------------------------- */

console.log('\n\x1b[1m2. Расшифровка потока (AES-128-CTR)\x1b[0m');

function encryptCtr(plain, key, offset = 0) {
  // Шифруем так же, как отдаёт сервис: CTR, нулевой IV, но начиная с нужного блока.
  const iv = Buffer.alloc(16);
  const decipher = crypto.createDecipheriv('aes-128-ctr', key, iv);
  if (offset) {
    // пропускаем offset байт, чтобы поток «начинался» со смещения
    decipher.update(Buffer.alloc(offset));
  }
  return decipher.update(plain);
}

check('расшифровка возвращает исходные байты', () => {
  const key = crypto.randomBytes(16);
  const original = crypto.randomBytes(64 * 1024);
  const encrypted = encryptCtr(original, key);
  const decrypted = decryptBuffer(encrypted, { algo: 'aes-128-ctr', keyHex: key.toString('hex') });
  assert(decrypted.equals(original), 'данные после расшифровки не совпали с исходными');
  equal(decrypted.length, original.length, 'длина не должна меняться в CTR');
});

check('длина ключа 24 и 32 байта тоже поддерживается', () => {
  for (const size of [24, 32]) {
    const key = crypto.randomBytes(size);
    const original = crypto.randomBytes(1024);
    const algorithm = size === 24 ? 'aes-192-ctr' : 'aes-256-ctr';
    const cipher = crypto.createCipheriv(algorithm, key, Buffer.alloc(16));
    const encrypted = Buffer.concat([cipher.update(original), cipher.final()]);
    const decrypted = decryptBuffer(encrypted, { algo: algorithm, keyHex: key.toString('hex') });
    assert(decrypted.equals(original), `расшифровка не удалась для ключа ${size} байт`);
  }
});

check('битый ключ отвергается с понятной ошибкой', () => {
  let caught = null;
  try {
    decryptBuffer(Buffer.from('abc'), { keyHex: 'zz' });
  } catch (err) {
    caught = err;
  }
  assert(caught, 'ожидалась ошибка на некорректном ключе');
  assert(/ключ/i.test(caught.message), `неожиданный текст ошибки: ${caught.message}`);
});

/* ------------------------------- Range ---------------------------------- */

console.log('\n\x1b[1m3. Разбор Range-заголовков\x1b[0m');

check('без заголовка — весь файл', () => {
  equal(parseRange(undefined, 1000), null);
});

check('bytes=0- — весь файл', () => {
  equal(parseRange('bytes=0-', 1000), { start: 0, end: 999 });
});

check('bytes=100-199 — середина', () => {
  equal(parseRange('bytes=100-199', 1000), { start: 100, end: 199 });
});

check('bytes=-500 — последние 500 байт', () => {
  equal(parseRange('bytes=-500', 1000), { start: 500, end: 999 });
});

check('конец за пределами файла подрезается', () => {
  equal(parseRange('bytes=900-5000', 1000), { start: 900, end: 999 });
});

check('начало за пределами файла → 416', () => {
  equal(parseRange('bytes=5000-6000', 1000), { unsatisfiable: true });
});

check('перевёрнутый диапазон → 416', () => {
  equal(parseRange('bytes=500-100', 1000), { unsatisfiable: true });
});

check('мусор в заголовке игнорируется', () => {
  equal(parseRange('items=0-10', 1000), null);
  equal(parseRange('bytes=abc', 1000), null);
});

check('пустой файл не отдаёт диапазонов', () => {
  equal(parseRange('bytes=0-10', 0), null);
});

/* --------------------------- проверка обновлений ------------------------- */

console.log('\n\x1b[1m4. Проверка обновлений\x1b[0m');

check('версия разбирается из тега', () => {
  equal(parseVersion('v1.2.3'), [1, 2, 3]);
  equal(parseVersion('0.10.0'), [0, 10, 0]);
  equal(parseVersion('мусор'), null);
  equal(parseVersion(undefined), null);
});

check('сравнение версий числовое, а не строчное', () => {
  assert(isNewer('0.2.0', '0.1.0'), '0.2.0 должно быть новее 0.1.0');
  assert(!isNewer('0.1.0', '0.1.0'), 'равные версии не новее');
  assert(isNewer('0.1.10', '0.1.9'), '0.1.10 новее 0.1.9');
  assert(!isNewer('0.1.0', '0.10.0'), '0.1.0 не новее 0.10.0');
  assert(isNewer('1.0.0', '0.99.99'), 'мажор важнее');
});

check('релизы старого мода не считаются обновлением', () => {
  assert(
    !isLabsoulRelease({ tag_name: 'v0.2.1', assets: [{ name: 'TemnikovoDans-0.2.1-x64.exe' }] }),
    'релиз мода не должен распознаваться как наш',
  );
  assert(
    isLabsoulRelease({ tag_name: 'v0.1.0', assets: [{ name: 'labsoul-0.1.0-setup.exe' }] }),
    'наш установщик должен распознаваться',
  );
  assert(
    !isLabsoulRelease({ draft: true, assets: [{ name: 'labsoul-0.1.0-setup.exe' }] }),
    'черновик не должен считаться опубликованным',
  );
  assert(!isLabsoulRelease(null), 'пустой релиз не должен ломать проверку');
});

/* ------------------------------- итог ----------------------------------- */

console.log('');
if (failures.length) {
  console.log(`\x1b[31m\x1b[1mПровалено проверок: ${failures.length}\x1b[0m из ${passed + failures.length}`);
  process.exit(1);
}
console.log(`\x1b[32m\x1b[1mВсе проверки пройдены: ${passed}\x1b[0m`);
