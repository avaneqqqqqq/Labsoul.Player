'use strict';

/**
 * Тесты разбора OAuth-возврата: `node app/oauth.test.cjs`
 * Без сети и без Electron — проверяем только чистые функции.
 */

const { buildAuthUrl, extractToken, extractError, describeError, OAUTH_CLIENTS, tokenFromAuthorizationHeader } = require('./oauth.cjs');

let passed = 0;
const failed = [];

function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (err) {
    failed.push(name);
    console.log(`  FAIL ${name}\n       ${err.message}`);
  }
}

function equal(actual, expected, message) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${message || 'не совпало'}: получено ${a}, ожидалось ${e}`);
}

function assert(value, message) {
  if (!value) throw new Error(message || 'условие не выполнено');
}

const TOKEN = 'y0_FAKE_TEST_TOKEN_aBcDeFgHiJkLmNoPqRsTuVwXyZ012345';

console.log('\n1. Токен из URL');

check('hash-часть (как отдаёт Яндекс)', () => {
  equal(extractToken(`https://music.yandex.ru/#access_token=${TOKEN}&token_type=bearer&expires_in=31536000`), TOKEN);
});

check('query-часть (authorization code обмен → token)', () => {
  equal(extractToken(`https://music.yandex.ru/callback?access_token=${TOKEN}`), TOKEN);
});

check('hash и query одновременно — берём hash', () => {
  const url = `https://x/#access_token=${TOKEN}&a=1?access_token=wrong_token_value_that_is_long`;
  equal(extractToken(url), TOKEN);
});

check('без токена — null', () => {
  equal(extractToken('https://music.yandex.ru/'), null);
  equal(extractToken(''), null);
  equal(extractToken(null), null);
});

check('слишком короткое значение не считается токеном', () => {
  equal(extractToken('https://x/#access_token=abc'), null);
});

// Регрессия 1.0.42: раньше требовалось ≥20 символов, и реальные токены
// отбрасывались — вход в Яндексе «молча не срабатывал».
check('короткий реальный токен принимается', () => {
  equal(extractToken('https://music.yandex.ru/#access_token=AQAAAAAmTxyzABCDEF&token_type=bearer'), 'AQAAAAAmTxyzABCDEF');
});

check('токен из query-части короткий тоже принимается', () => {
  equal(extractToken('https://music.yandex.ru/?access_token=y0_AgAAAq123456'), 'y0_AgAAAq123456');
});

check('мусорные символы в токене отбрасываются', () => {
  equal(extractToken('https://x/#access_token=short%20value%3Cscript%3E'), null);
});

console.log('\n2. Ошибки авторизации');

check('access_denied из hash', () => {
  const err = extractError('https://music.yandex.ru/#error=access_denied&error_description=User+denied');
  equal(err && err.code, 'access_denied');
  assert(/отмен/i.test(describeError(err)), 'ожидался человеческий текст про отмену');
});

check('ошибки нет — null', () => {
  equal(extractError(`https://x/#access_token=${TOKEN}`), null);
});

check('неизвестная ошибка описывается понятно', () => {
  const text = describeError({ code: 'weird_error', description: '' });
  assert(text.includes('weird_error'), 'в тексте должен быть код ошибки');
});

console.log('\n3. Перехват токена из запросов сервиса');

check('Authorization: OAuth <token> распознаётся', () => {
  equal(tokenFromAuthorizationHeader(`OAuth ${TOKEN}`), TOKEN);
});

check('регистр схемы не важен', () => {
  equal(tokenFromAuthorizationHeader(`oauth ${TOKEN}`), TOKEN);
});

check('чужая схема не принимается', () => {
  equal(tokenFromAuthorizationHeader(`Bearer ${TOKEN}`), null);
  equal(tokenFromAuthorizationHeader('OAuth'), null);
  equal(tokenFromAuthorizationHeader(''), null);
  equal(tokenFromAuthorizationHeader(undefined), null);
});

check('короткий токен из заголовка принимается', () => {
  // регрессия: раньше требовалось ≥20 символов, и вход через окно Яндекс.Музыки
  // не срабатывал — токен из заголовка Authorization отбрасывался
  equal(tokenFromAuthorizationHeader('OAuth y0_AgAAAAAXyz12345'), 'y0_AgAAAAAXyz12345');
  equal(tokenFromAuthorizationHeader('OAuth AQAAAAAmTxyzABCDEF'), 'AQAAAAAmTxyzABCDEF');
});

check('слишком короткий токен в заголовке отбрасывается', () => {
  equal(tokenFromAuthorizationHeader('OAuth abc'), null);
});

console.log('\n4. Адрес авторизации');
check('собирается корректно', () => {
  const url = buildAuthUrl(OAUTH_CLIENTS[0].id);
  assert(url.startsWith('https://oauth.yandex.ru/authorize?'), 'неверный хост');
  assert(url.includes('response_type=token'), 'нужен implicit flow');
  assert(url.includes(`client_id=${OAUTH_CLIENTS[0].id}`), 'client_id потерялся');
});

console.log('');
if (failed.length) {
  console.log(`Провалено: ${failed.length} из ${passed + failed.length}`);
  process.exit(1);
}
console.log(`Все проверки пройдены: ${passed}`);
