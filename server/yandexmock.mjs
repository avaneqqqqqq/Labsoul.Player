'use strict';

/**
 * Тест провайдера Яндекс.Музыки без реального аккаунта: `node server/yandexmock.mjs`
 *
 * Поднимает локальный мок API Яндекса, который повторяет его контракт
 * (account/status, search, tracks, get-file-info с HMAC-подписью, ротор и
 * обратную связь), запускает настоящий сервер плеера с YANDEX_API_BASE на мок
 * и проверяет весь путь: авторизация → поиск → трек → поток (включая
 * зашифрованный encraw) → «Волна» → лайк в ротор.
 *
 * Мок сам проверяет подпись: если алгоритм подписи в провайдере изменится,
 * запрос получит 403 и тест упадёт.
 */

import crypto from 'node:crypto';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { makeWav } from './devtest/plain.mjs';
import { findFreePort, waitUntil } from './devtest/ports.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
let PLAYER_PORT = 0;
let BASE = '';
const TOKEN = 'test-token';

const SIGN_KEY = '7tvSmFbyf5hJnIHhCimDDD';
const WAV = makeWav(2000);
const ENC_KEY = crypto.randomBytes(16);
const ENC_CIPHER = (() => {
  const cipher = crypto.createCipheriv('aes-128-ctr', ENC_KEY, Buffer.alloc(16));
  return Buffer.concat([cipher.update(WAV), cipher.final()]);
})();

const TRACKS = {
  100: {
    id: 100,
    title: 'Группа крови',
    artists: [{ name: 'Кино' }],
    albums: [{ title: 'Группа крови', coverUri: 'avatars.yandex.net/get-music-content/1/2/%%' }],
    durationMs: 265000,
    available: true,
    contentWarning: false,
  },
  200: {
    id: 200,
    title: 'Зашифрованный трек',
    artists: [{ name: 'Тест' }],
    albums: [{ title: 'Enc', coverUri: 'avatars.yandex.net/get-music-content/3/4/%%' }],
    durationMs: 90000,
    available: true,
    contentWarning: false,
  },
  300: {
    id: 300,
    title: 'Второй для волны',
    artists: [{ name: 'Тест' }],
    albums: [{ title: 'Wave', coverUri: 'avatars.yandex.net/get-music-content/5/6/%%' }],
    durationMs: 120000,
    available: true,
    contentWarning: false,
  },
};

const state = { signChecks: [], feedbacks: [], authFailures: 0, encrawUsed: 0, rawRejected: 0 };

function expectedSign({ ts, trackId, quality, codecs, transports }) {
  return crypto
    .createHmac('sha256', SIGN_KEY)
    .update(`${ts}${trackId}${quality}${codecs}${transports}`)
    .digest('base64')
    .replace(/=+$/, '');
}

function json(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': body.length });
  res.end(body);
}

const mock = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const auth = req.headers.authorization || '';
  const client = req.headers['x-yandex-music-client'] || '';

  // статические файлы «CDN»
  if (url.pathname === '/audio-100.mp3') {
    res.writeHead(200, { 'content-type': 'audio/mpeg', 'content-length': WAV.length });
    res.end(WAV);
    return;
  }
  if (url.pathname === '/audio-200.enc') {
    res.writeHead(200, { 'content-type': 'audio/mpeg', 'content-length': ENC_CIPHER.length });
    res.end(ENC_CIPHER);
    return;
  }

  if (auth !== `OAuth ${TOKEN}`) {
    state.authFailures += 1;
    json(res, 401, { error: 'Unauthorized' });
    return;
  }
  if (!client) {
    json(res, 400, { error: 'Bad client' });
    return;
  }

  if (url.pathname === '/account/status') {
    json(res, 200, { result: { account: { displayName: 'Тест Тестович', login: 'tester' } } });
    return;
  }

  if (url.pathname === '/search') {
    const results = [TRACKS[100], TRACKS[300]];
    json(res, 200, { result: { tracks: { results } } });
    return;
  }

  if (url.pathname.startsWith('/tracks/')) {
    const id = url.pathname.split('/')[2];
    const track = TRACKS[id];
    if (!track) {
      json(res, 404, { error: 'not found' });
      return;
    }
    json(res, 200, { result: [track] });
    return;
  }

  if (url.pathname === '/get-file-info') {
    const params = {
      ts: url.searchParams.get('ts'),
      trackId: url.searchParams.get('trackId'),
      quality: url.searchParams.get('quality'),
      codecs: url.searchParams.get('codecs'),
      transports: url.searchParams.get('transports'),
    };
    const sign = url.searchParams.get('sign') || '';
    const ok = sign === expectedSign(params);
    state.signChecks.push({ ok, params, sign });

    if (!ok) {
      json(res, 403, { result: { name: 'track-download-info-error', message: 'not-allowed' } });
      return;
    }

    // трек 200 доступен только как зашифрованный поток — как часть реальных треков
    if (params.trackId === '200' && params.transports === 'raw') {
      state.rawRejected += 1;
      json(res, 403, { result: { name: 'track-download-info-error', message: 'encraw-only' } });
      return;
    }

    if (params.transports === 'encraw') {
      state.encrawUsed += 1;
      const port = mock.address() ? mock.address().port : 0;
      json(res, 200, {
        downloadInfo: {
          codec: 'mp3',
          quality: 'nq',
          bitrate: 320,
          key: ENC_KEY.toString('hex'),
          urls: [`http://127.0.0.1:${port}/audio-200.enc`],
        },
      });
      return;
    }

    const port = mock.address() ? mock.address().port : 0;
    json(res, 200, {
      downloadInfo: {
        codec: 'mp3',
        quality: 'nq',
        bitrate: 320,
        url: `http://127.0.0.1:${port}/audio-100.mp3`,
      },
    });
    return;
  }

  if (url.pathname.startsWith('/rotor/station/')) {
    if (req.method === 'POST' && url.pathname.endsWith('/feedback')) {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        try {
          state.feedbacks.push(JSON.parse(body));
        } catch {
          state.feedbacks.push({ raw: body });
        }
        json(res, 200, { result: { ok: true } });
      });
      return;
    }
    json(res, 200, {
      result: {
        batchId: 'batch-1',
        station: { id: 'user:onyourwave' },
        sequence: [
          { track: TRACKS[100] },
          { track: TRACKS[300] },
        ],
      },
    });
    return;
  }

  json(res, 404, { error: 'unknown endpoint', path: url.pathname });
});

/* -------------------------------- проверки -------------------------------- */

let passed = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures.push(name);
    console.log(`  FAIL ${name}\n       ${err.message}`);
  }
}

function pcheck(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed += 1;
      console.log(`  ok   ${name}`);
    })
    .catch((err) => {
      failures.push(name);
      console.log(`  FAIL ${name}\n       ${err.message}`);
    });
}

function assert(condition, message) {
  if (!condition) throw new Error(message || 'условие не выполнено');
}

function equal(actual, expected, message) {
  if (actual !== expected) throw new Error(`${message || 'не совпало'}: получено ${JSON.stringify(actual)}, ожидалось ${JSON.stringify(expected)}`);
}

async function waitForHealth(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(1500) });
      if (res.ok) return true;
    } catch { /* поднимается */ }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return false;
}

async function main() {
  PLAYER_PORT = await findFreePort();
  BASE = `http://127.0.0.1:${PLAYER_PORT}`;
  await new Promise((resolve) => mock.listen(0, '127.0.0.1', resolve));
  const mockPort = mock.address().port;

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'labsoul-yamock-'));
  const child = spawn(process.execPath, [path.join(HERE, 'index.mjs'), `--port=${PLAYER_PORT}`], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PLAYER_PORT),
      PLAYER_DATA_DIR: dataDir,
      YANDEX_API_BASE: `http://127.0.0.1:${mockPort}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  child.stdout.on('data', (chunk) => { serverLog += String(chunk); });
  child.stderr.on('data', (chunk) => { serverLog += String(chunk); });

  const stop = () => {
    try { child.kill(); } catch { /* уже */ }
    try { mock.close(); } catch { /* уже */ }
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* не критично */ }
  };

  try {
    if (!(await waitForHealth())) {
      console.error('Сервер не поднялся. Лог:\n' + serverLog.slice(-1500));
      stop();
      process.exit(1);
    }

    console.log('\n1. Авторизация');

    const auth = await fetch(`${BASE}/api/settings`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ yandex: { token: TOKEN } }),
    });
    const authData = await auth.json();
    await pcheck('токен принят, аккаунт определён', () => {
      equal(auth.status, 200, 'код ответа');
      equal(authData.sources.yandex.connected, true, 'connected');
      equal(authData.sources.yandex.user, 'Тест Тестович', 'имя пользователя');
    });

    console.log('\n2. Поиск и трек');

    const search = await fetch(`${BASE}/api/search?q=кино&sources=yandex`).then((r) => r.json());
    await pcheck('поиск вернул треки и корректно их разобрал', () => {
      const group = search.groups.find((g) => g.source === 'yandex');
      assert(group && group.items.length >= 2, 'ожидались результаты Яндекса');
      const first = group.items[0];
      equal(first.id, 'ym:100', 'id');
      equal(first.artists[0], 'Кино', 'исполнитель');
      equal(first.duration, 265, 'длительность в секундах');
      assert(String(first.cover).startsWith('https://avatars.yandex.net'), 'обложка не собрана: ' + first.cover);
      equal(first.playable, true, 'playable');
    });

    const track = await fetch(`${BASE}/api/track/yandex/100`).then((r) => r.json());
    await pcheck('/api/track отдаёт трек по id', () => {
      equal(track.track.title, 'Группа крови', 'название');
      equal(track.track.album, 'Группа крови', 'альбом');
    });

    console.log('\n3. Поток');

    const stream = await fetch(`${BASE}/api/stream/yandex/100`);
    const streamBody = Buffer.from(await stream.arrayBuffer());
    await pcheck('обычный поток отдаётся целиком', () => {
      equal(stream.status, 200, 'код ответа');
      assert(streamBody.equals(WAV), 'байты потока не совпали');
    });

    await pcheck('подпись get-file-info валидна (проверена моком)', () => {
      const checks = state.signChecks.filter((c) => c.ok);
      assert(checks.length > 0, 'мок не получил ни одного запроса с верной подписью');
      const bad = state.signChecks.filter((c) => !c.ok);
      equal(bad.length, 0, 'были запросы с неверной подписью');
    });

    const encStream = await fetch(`${BASE}/api/stream/yandex/200`);
    const encBody = Buffer.from(await encStream.arrayBuffer());
    await pcheck('зашифрованный трек расшифрован на сервере', () => {
      equal(encStream.status, 200, 'код ответа');
      assert(encBody.equals(WAV), 'после расшифровки байты не совпали');
      assert(state.rawRejected > 0, 'ожидался отказ raw-транспорта для encraw-трека');
      assert(state.encrawUsed > 0, 'провайдер не перешёл на encraw');
    });

    console.log('\n4. Волна и обратная связь');

    const wave = await fetch(`${BASE}/api/wave?limit=3&sources=yandex`).then((r) => r.json());
    await pcheck('ротор отдал ленту', () => {
      equal(wave.engine, 'yandex', 'движок');
      equal(wave.batchId, 'batch-1', 'batchId');
      assert(wave.items.length >= 2, 'ожидались треки из ротора');
      equal(wave.items[0].source, 'yandex', 'источник трека');
    });

    const feedback = await fetch(`${BASE}/api/wave/feedback`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'like', trackId: 'ym:100', batchId: 'batch-1', station: 'user:onyourwave', position: 42 }),
    }).then((r) => r.json());
    await pcheck('лайк ушёл в ротор Яндекса', async () => {
      await waitUntil(() => state.feedbacks.length > 0, 4000);
      equal(feedback.ok, true, 'ok');
      equal(feedback.forwarded, true, 'forwarded');
      const sent = state.feedbacks[0];
      assert(sent, 'мок не получил обратную связь');
      equal(sent.type, 'like', 'тип события');
      equal(String(sent.trackId), '100', 'id трека');
      equal(sent.batchId, 'batch-1', 'batchId');
    });

    console.log('\n5. Неверный токен');

    await fetch(`${BASE}/api/settings`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ yandex: { token: 'wrong-token' } }),
    });
    const status = await fetch(`${BASE}/api/status`).then((r) => r.json());
    await pcheck('неверный токен даёт AUTH_FAILED, а не падение', () => {
      equal(status.sources.yandex.connected, false, 'connected');
      equal(status.sources.yandex.error, 'AUTH_FAILED', 'код ошибки');
      assert(state.authFailures > 0, 'мок не получил запросов с неверным токеном');
    });
  } finally {
    stop();
  }

  console.log('');
  if (failures.length) {
    console.log(`Провалено: ${failures.length} из ${passed + failures.length}`);
    process.exit(1);
  }
  console.log(`Все проверки пройдены: ${passed}`);
}

main().catch((err) => {
  console.error('Тест упал:', err.message);
  process.exit(1);
});
