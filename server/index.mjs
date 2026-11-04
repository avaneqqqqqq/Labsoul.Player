'use strict';

/**
 * Локальный сервер плеера: статика + JSON-API + прокси аудиопотоков.
 *
 * Особенности:
 *  - ноль зависимостей (только node:*);
 *  - /api/stream поддерживает Range (нужно для перемотки в <audio>);
 *  - потоки со «шифром» (Яндекс encraw) расшифровываются на лету и кэшируются;
 *  - подписанные ссылки, которые живут недолго, запрашиваются заново при протухании.
 */

import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';

import * as store from './store.mjs';
import * as waveEngine from './wave.mjs';
import * as clips from './clips.mjs';
import { decryptBuffer, parseRange } from './streaming.mjs';
import { resolveLink, findCandidates } from './linkimport.mjs';
import { checkForUpdate, currentVersion } from './update.mjs';
import * as localLibrary from './local.mjs';
import * as lyrics from './lyrics.mjs';
import * as audioconvert from './audioconvert.mjs';
import * as libraryCache from './librarycache.mjs';
import * as proxySupport from './proxy.mjs';
import * as scProxy from './scproxy.mjs';
import * as proxyFinder from './proxyfind.mjs';
import * as dpi from './dpi.mjs';
import * as dpiauto from './dpiauto.mjs';
import * as dpiwatcher from './dpiwatcher.mjs';
import * as debuglog from './debuglog.mjs';
import * as autofix from './autofix.mjs';

const PORT = Number(
  process.env.PORT ||
    (process.argv.find((a) => a.startsWith('--port=')) || '').split('=')[1] ||
    5270,
);

const WEB_DIR = path.join(store.paths.ROOT, 'web');
const PROVIDER_NAMES = ['yandex', 'soundcloud', 'spotify'];
const providers = {};

/* ------------------------------ загрузка --------------------------------- */

function makeStub(name) {
  const notReady = () => {
    const err = new Error(`Провайдер «${name}» не установлен`);
    err.code = 'NOT_SUPPORTED';
    throw err;
  };
  return {
    id: name,
    configure() {},
    async status() {
      return { connected: false, error: 'NOT_INSTALLED' };
    },
    search: notReady,
    track: notReady,
    stream: notReady,
    wave: notReady,
    async feedback() {
      return { ok: true, skipped: true };
    },
  };
}

async function loadProviders() {
  const settings = store.loadSettings();

  // Прокси — только для SoundCloud и только если пользователь задал его сам.
  // Автоподбор отключён: SoundCloud чинится обходом блокировки (zapret),
  // а публичные прокси нестабильны и мешают работе.
  try {
    if (settings.network?.proxy) {
      await scProxy.adopt(settings.network.proxy);
      store.log(`[proxy] принят прокси из настроек: ${settings.network.proxy}`);
    }
  } catch (err) {
    store.log(`[proxy] ошибка инициализации: ${(err && err.message) || err}`);
  }

  for (const name of PROVIDER_NAMES) {
    try {
      const mod = await import(`./providers/${name}.mjs`);
      providers[name] = mod;
      store.log(`[providers] ${name}: загружен`);
    } catch (err) {
      providers[name] = makeStub(name);
      store.log(`[providers] ${name}: не загружен (${err.message})`);
    }
    try {
      providers[name].configure?.(settings[name] || {});
    } catch (err) {
      store.log(`[providers] ${name}: ошибка конфигурации — ${err.message}`);
    }
  }

  // Отладочные провайдеры подключаются только по явному требованию —
  // их использует server/streamtest.mjs, чтобы проверить отдачу звука без сети.
  if (process.env.PLAYER_TEST_PROVIDERS === '1') {
    const extra = [
      ['__plain', './devtest/plain.mjs'],
      ['__enc', './devtest/encrypted.mjs'],
    ];
    for (const [testId, modulePath] of extra) {
      try {
        providers[testId] = await import(modulePath);
        PROVIDER_NAMES.push(testId);
        store.log(`[providers] ${testId}: отладочный загружен`);
      } catch (err) {
        store.log(`[providers] ${testId}: отладочный не загружен (${err.message})`);
      }
    }
  }

  // «своя музыка» не сетевой источник: грузим отдельно, чтобы не попадать
  // в поиск по каталогам и в статусы сервисов
  try {
    providers.local = await import('./providers/local.mjs');
    store.log('[providers] local: загружен');
  } catch (err) {
    providers.local = makeStub('local');
    store.log('[providers] local: не загружен (' + err.message + ')');
  }

  waveEngine.bind(providers);
}

/* ------------------------------- утилиты --------------------------------- */

function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

const STATUS_BY_CODE = {
  BAD_REQUEST: 400,
  NO_TOKEN: 400,
  AUTH_FAILED: 401,
  NOT_FOUND: 404,
  NOT_PLAYABLE: 409,
  NOT_SUPPORTED: 501,
  UPSTREAM: 502,
};

function sendError(res, err) {
  const code = err && STATUS_BY_CODE[err.code] ? err.code : 'UPSTREAM';
  const status = STATUS_BY_CODE[code] || 500;
  if (status >= 500) store.log('[error]', err && (err.stack || err.message));
  sendJson(res, status, {
    error: { code, message: (err && err.message) || 'Внутренняя ошибка' },
  });
}

function badRequest(message) {
  const err = new Error(message);
  err.code = 'BAD_REQUEST';
  return err;
}

async function readJson(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > 2 * 1024 * 1024) throw badRequest('Слишком большое тело запроса');
    chunks.push(chunk);
  }
  if (!total) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw badRequest('Тело запроса не является JSON');
  }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

/* -------------------------------- статика -------------------------------- */

const PLACEHOLDER = `<!doctype html><html lang="ru"><head><meta charset="utf-8">
<title>labsoul — интерфейс собирается</title>
<style>
  :root{color-scheme:dark}
  body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0b0f;color:#e8e8ee;
       font:16px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
  .card{max-width:620px;padding:34px 36px;border-radius:22px;background:#14141b;border:1px solid #24242f}
  h1{font-size:22px;margin:0 0 12px}
  code{background:#1e1e28;padding:2px 7px;border-radius:6px;font-size:14px}
  ul{padding-left:20px;color:#b9b9c6}
  .k{color:#ffd23f}
</style></head><body><div class="card">
  <h1>labsoul: сервер работает</h1>
  <p>Каталог <code>web/</code> пока пуст — интерфейс ещё собирается. API уже живое:</p>
  <ul>
    <li><span class="k">GET</span> /api/status — какие источники подключены</li>
    <li><span class="k">GET</span> /api/wave?limit=10 — лента рекомендаций</li>
    <li><span class="k">GET</span> /api/search?q=мираж</li>
    <li><span class="k">PUT</span> /api/settings — токены источников</li>
  </ul>
  <p>Проверка живости: <code>/api/health</code></p>
</div></body></html>`;

function serveStatic(req, res, pathname) {
  let requested = decodeURIComponent(pathname);
  if (requested === '/' || requested === '') requested = '/index.html';

  const full = path.normalize(path.join(WEB_DIR, requested));
  const inside = full === WEB_DIR || full.startsWith(WEB_DIR + path.sep);
  if (!inside) {
    sendJson(res, 403, { error: { code: 'BAD_REQUEST', message: 'Недопустимый путь' } });
    return;
  }

  let stat = null;
  try {
    stat = fs.statSync(full);
  } catch {
    stat = null;
  }

  if (!stat || !stat.isFile()) {
    if (requested === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(PLACEHOLDER);
      return;
    }
    sendJson(res, 404, { error: { code: 'NOT_FOUND', message: 'Файл не найден' } });
    return;
  }

  const ext = path.extname(full).toLowerCase();
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Length': stat.size,
    'Cache-Control': 'no-cache',
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  fs.createReadStream(full).pipe(res);
}

/* ----------------------------- аудиопотоки -------------------------------- */

const descCache = new Map(); // `source:id` → { at, desc }
const bufferCache = new Map(); // `source:id` → { at, buf, contentType }
let bufferCacheBytes = 0;
const BUFFER_CACHE_LIMIT = 160 * 1024 * 1024;
const DESC_TTL = 20000;

async function getDescriptor(source, sourceId, force = false) {
  const key = `${source}:${sourceId}`;
  const hit = descCache.get(key);
  if (!force && hit && Date.now() - hit.at < DESC_TTL) return hit.desc;
  const provider = providers[source];
  if (!provider) throw badRequest('Неизвестный источник');

  // Провайдер может «залипнуть» на медиа-CDN: ограничиваем ожидание.
  // Важно: таймер обязательно очищаем. Иначе после успешного ответа он
  // срабатывает позже, отклоняет уже ненужный промис и роняет процесс
  // необработанным исключением.
  let timer = null;
  try {
    const desc = await Promise.race([
      provider.stream(sourceId),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const err = new Error('Таймаут получения потока');
          err.code = 'UPSTREAM_TIMEOUT';
          reject(err);
        }, 15000);
        if (typeof timer.unref === 'function') timer.unref();
      }),
    ]);
    if (!desc || (!desc.url && !desc.buffer && !desc.filePath)) {
      const err = new Error('Источник не вернул поток');
      err.code = 'NOT_PLAYABLE';
      throw err;
    }
    descCache.set(key, { at: Date.now(), desc });
    return desc;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function openUpstream(urlStr, headers, redirects = 4) {
  return new Promise((resolve, reject) => {
    let target;
    try {
      target = new URL(urlStr);
    } catch {
      reject(new Error('Некорректный адрес потока'));
      return;
    }
    const lib = target.protocol === 'http:' ? http : https;
    const request = lib.get(target, { headers }, (upstream) => {
      const status = upstream.statusCode || 0;
      const location = upstream.headers.location;
      if ([301, 302, 303, 307, 308].includes(status) && location && redirects > 0) {
        upstream.resume();
        resolve(openUpstream(new URL(location, target).toString(), headers, redirects - 1));
        return;
      }
      resolve(upstream);
    });
    request.on('error', reject);
    request.setTimeout(20000, () => request.destroy(new Error('Апстрим не ответил вовремя')));
  });
}

function collectStream(stream, maxBytes = 120 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    stream.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        stream.destroy();
        reject(new Error('Поток больше допустимого размера'));
        return;
      }
      chunks.push(chunk);
    });
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

function rememberBuffer(key, buf, contentType) {
  const existing = bufferCache.get(key);
  if (existing) bufferCacheBytes -= existing.buf.length;
  bufferCache.set(key, { at: Date.now(), buf, contentType });
  bufferCacheBytes += buf.length;
  while (bufferCacheBytes > BUFFER_CACHE_LIMIT && bufferCache.size > 1) {
    const oldestKey = bufferCache.keys().next().value;
    const oldest = bufferCache.get(oldestKey);
    bufferCache.delete(oldestKey);
    bufferCacheBytes -= oldest.buf.length;
  }
}

async function getBuffered(source, sourceId, desc) {
  const key = `${source}:${sourceId}`;
  const hit = bufferCache.get(key);
  if (hit) return hit;

  const upstream = await openUpstream(desc.url, desc.headers || {});
  if ((upstream.statusCode || 500) >= 400) {
    upstream.resume();
    const err = new Error(`Апстрим ответил ${upstream.statusCode}`);
    err.code = 'UPSTREAM';
    throw err;
  }
  const raw = await collectStream(upstream);
  const data = desc.decrypt ? decryptBuffer(raw, desc.decrypt) : raw;
  rememberBuffer(key, data, desc.contentType || upstream.headers['content-type']);
  return bufferCache.get(key);
}

/** Отдача файла пользователя с диска: Range нужен для перемотки в <audio>. */
function serveLocalFile(filePath, req, res, contentType) {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    const err = new Error('Файл не найден на диске');
    err.code = 'NOT_FOUND';
    throw err;
  }

  const total = stat.size;
  res.setHeader('Content-Type', contentType || 'application/octet-stream');
  res.setHeader('Accept-Ranges', 'bytes');
  // поток читает Web Audio (эквалайзер): без CORS элемент считается
  // кросс-доменным и анализ звука ломается
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'private, max-age=600');

  const range = parseRange(req.headers.range, total);
  if (range) {
    if (range.unsatisfiable) {
      res.writeHead(416, { 'Content-Range': `bytes */${total}` });
      res.end();
      return;
    }
    const { start, end } = range;
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${total}`,
      'Content-Length': end - start + 1,
    });
    if (req.method === 'HEAD') { res.end(); return; }
    fs.createReadStream(filePath, { start, end }).pipe(res);
    return;
  }

  res.writeHead(200, { 'Content-Length': total });
  if (req.method === 'HEAD') { res.end(); return; }
  fs.createReadStream(filePath).pipe(res);
}

/** Похоже ли на MP4/M4A: сигнатура ftyp в первых байтах. */
function looksLikeMp4(buffer) {
  if (!buffer || buffer.length < 12) return false;
  return buffer.subarray(4, 8).toString('latin1') === 'ftyp';
}

function serveBuffer(buffer, req, res, contentType) {
  const total = buffer.length;
  res.setHeader('Content-Type', contentType || 'audio/mpeg');
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'private, max-age=600');

  const range = parseRange(req.headers.range, total);
  if (range) {
    if (range.unsatisfiable) {
      res.writeHead(416, { 'Content-Range': `bytes */${total}` });
      res.end();
      return;
    }
    const { start, end } = range;
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${total}`,
      'Content-Length': end - start + 1,
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    res.end(buffer.subarray(start, end + 1));
    return;
  }

  res.writeHead(200, { 'Content-Length': total });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  res.end(buffer);
}

async function pipeUpstream(req, res, source, sourceId, attempt = 0) {
  const desc = await getDescriptor(source, sourceId, attempt > 0);
  const headers = { ...(desc.headers || {}) };
  if (req.headers.range) headers.Range = req.headers.range;
  headers['User-Agent'] = headers['User-Agent'] || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)';

  const upstream = await openUpstream(desc.url, headers);
  const status = upstream.statusCode || 0;

  // подписанная ссылка могла протухнуть — берём свежую и пробуем ещё раз
  if ((status === 401 || status === 403 || status === 410) && attempt < 1) {
    upstream.resume();
    return pipeUpstream(req, res, source, sourceId, attempt + 1);
  }

  for (const header of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified']) {
    if (upstream.headers[header]) res.setHeader(header, upstream.headers[header]);
  }
  // без CORS элемент считает поток кросс-доменным, и Web Audio (эквалайзер)
  // выдаёт тишину — это и ломало звук у SoundCloud и Spotify
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges');
  if (!res.getHeader('content-type')) res.setHeader('content-type', desc.contentType || 'audio/mpeg');
  if (!res.getHeader('accept-ranges')) res.setHeader('accept-ranges', 'bytes');
  res.setHeader('Cache-Control', 'private, max-age=600');
  res.writeHead(status || 200);

  if (req.method === 'HEAD') {
    upstream.resume();
    res.end();
    return;
  }
  res.on('close', () => upstream.destroy());
  upstream.pipe(res);
}

async function handleStream(req, res, source, sourceId) {
  const provider = providers[source];
  if (!provider) throw badRequest('Неизвестный источник');

  const desc = await getDescriptor(source, sourceId);
  // своя музыка: отдаём файл с диска, с поддержкой Range
  if (desc.filePath) {
    serveLocalFile(desc.filePath, req, res, desc.contentType);
    return;
  }
  if (desc.buffer) {
    // AAC в MP4-контейнере (SoundCloud) не играет в <audio> этого движка:
    // пере-упаковываем в MP3 один раз и кэшируем
    const isMp4 = /audio\/(mp4|m4a|x-m4a)/i.test(String(desc.contentType || ''))
      || looksLikeMp4(desc.buffer);
    if (isMp4 && audioconvert.hasFfmpeg()) {
      try {
        const mp3 = await audioconvert.getMp3(`${source}:${sourceId}`, async () => desc.buffer);
        if (mp3) {
          serveBuffer(mp3, req, res, 'audio/mpeg');
          return;
        }
      } catch (err) {
        store.log('[audio] конвертация не удалась:', err.message);
      }
    }
    serveBuffer(desc.buffer, req, res, desc.contentType);
    return;
  }
  if (desc.decrypt) {
    const cached = await getBuffered(source, sourceId, desc);
    serveBuffer(cached.buf, req, res, cached.contentType);
    return;
  }
  await pipeUpstream(req, res, source, sourceId);
}

/* ------------------------------- статусы --------------------------------- */

/**
 * Статус всех сервисов.
 *
 * Раньше каждый вызов ждал ЖИВОЙ проверки: первый занимал до 8 секунд
 * (SoundCloud ищет client_id, Яндекс перебирает хосты), и приложение,
 * не дождавшись, показывало «нет доступа». Теперь статус отдаётся из кэша
 * сразу, а проверка идёт в фоне и обновляет его.
 */
const STATUS_TTL_MS = 60_000;
let statusCache = null;
let statusCacheAt = 0;
let statusRefreshing = null;

/** Живая проверка всех провайдеров, с ограничением по времени. */
async function probeStatusAll(timeoutMs = 9_000) {
  const work = (async () => {
    const out = {};
    await Promise.all(
      PROVIDER_NAMES.map(async (name) => {
        try {
          const st = await providers[name].status();
          if (st && st.error && typeof st.error === 'object') st.error = st.error.code || 'UPSTREAM';
          out[name] = st;
        } catch (err) {
          out[name] = { connected: false, error: err.code || 'UPSTREAM' };
        }
      }),
    );
    return out;
  })();

  // если провайдер завис — не держим интерфейс, отдаём что есть
  const timer = new Promise((resolve) => setTimeout(() => resolve(null), timeoutMs).unref?.());
  return Promise.race([work, timer]);
}

function refreshStatus() {
  if (statusRefreshing) return statusRefreshing;
  statusRefreshing = probeStatusAll()
    .then((result) => {
      /*
       * Кэшируем только осмысленный результат.
       *
       * Если провайдеры ещё не загрузились (первые миллисекунды после
       * старта сервера) или сработал таймаут, приходит пустой ответ.
       * Раньше он попадал в кэш на минуту, и интерфейс минуту показывал
       * «нет доступа» ко всем сервисам, пока не нажмёшь «Проверить».
       */
      const meaningful = result
        && Object.keys(result).length > 0
        && Object.values(result).some((s) => s && s.connected);
      const allStubs = result && Object.values(result).every((s) => s && s.error === 'NOT_INSTALLED');

      if (meaningful || (result && !allStubs)) {
        statusCache = result;
        statusCacheAt = Date.now();
      }
      return result;
    })
    .catch(() => null)
    .finally(() => { statusRefreshing = null; });
  return statusRefreshing;
}

/**
 * Статус для интерфейса.
 * @param {boolean} force — дождаться живой проверки (кнопка «обновить»)
 */
async function statusAll(force = false) {
  const fresh = statusCache && Date.now() - statusCacheAt < STATUS_TTL_MS;

  /*
   * Лимит SoundCloud подставляем всегда свежим.
   *
   * Статус кэшируется на минуту — иначе каждый заход в интерфейс дёргал
   * бы все сервисы. Но счётчик прослушиваний меняется постоянно, и в
   * кэше он отставал бы: человек слушает треки, а остаток стоит на месте.
   */
  const withLimit = (result) => {
    if (!result?.soundcloud) return result;
    try {
      const limit = providers.soundcloud.rateLimitState?.();
      if (limit) return { ...result, soundcloud: { ...result.soundcloud, rateLimit: limit } };
    } catch { /* не критично */ }
    return result;
  };

  // принудительно — ждём полную проверку без обрезки по времени
  if (force) {
    const result = await probeStatusAll(20_000);
    if (result) {
      statusCache = result;
      statusCacheAt = Date.now();
      return withLimit(result);
    }
  }

  // свежий кэш — отдаём сразу
  if (fresh) return withLimit(statusCache);

  // кэш устарел: показываем его и параллельно обновляем в фоне
  if (statusCache) {
    refreshStatus();
    return withLimit(statusCache);
  }

  // самый первый запрос — ждём, но не дольше семи секунд
  const result = await refreshStatus();
  return withLimit(result || {});
}

/* --------------------------------- API ----------------------------------- */

async function handleApi(req, res, url) {
  const segments = url.pathname.split('/').filter(Boolean); // ['api', ...]
  const route = segments.slice(1);

  if (route[0] === 'health') {
    sendJson(res, 200, { ok: true, version: currentVersion(), uptime: Math.round(process.uptime()) });
    return;
  }

  /*
   * Одна кнопка на сервис.
   *
   * Пользователь не разбирается в стратегиях, ключах и перелогинах —
   * жмёт кнопку, сервер сам проходит шаги и отвечает итогом.
   */
  if (route[0] === 'fix' && req.method === 'POST') {
    const source = String(route[1] || '');
    let body = {};
    try { body = await readJson(req) || {}; } catch { body = {}; }
    const result = await autofix.fix(source, { relogin: Boolean(body.relogin) });
    // после починки статус мог измениться — сбрасываем кэш
    statusCache = null;
    statusCacheAt = 0;
    sendJson(res, 200, result);
    return;
  }

  /*
   * Журнал диагностики.
   *
   * Клиент присылает сюда события (нажатия, смены состояния, ответы о
   * текстах), сервер пишет их в файл. Нужен, чтобы увидеть проблемы
   * внутри упакованного приложения, где консоль недоступна.
   */
  if (route[0] === 'debug') {
    if (req.method === 'POST') {
      let body = null;
      try { body = await readJson(req); } catch { body = null; }
      if (body?.events && Array.isArray(body.events)) {
        for (const item of body.events) {
          debuglog.write(item.category || 'client', item.message || '', item.data);
        }
      } else if (body) {
        debuglog.write(body.category || 'client', body.message || '', body.data);
      }
      sendJson(res, 200, { ok: true });
      return;
    }

    // GET — путь к файлу и последние строки
    sendJson(res, 200, { ok: true, path: debuglog.filePath(), tail: debuglog.tail(200) });
    return;
  }

  if (route[0] === 'status') {
    sendJson(res, 200, { ok: true, version: currentVersion(), sources: await statusAll() });
    return;
  }

  if (route[0] === 'theme') {
    // Оформление плеера: хранится на сервере, чтобы не сбрасываться при
    // обновлении (localStorage живёт в профиле Chromium и теряется).
    if (req.method === 'GET') {
      const settings = store.loadSettings();
      sendJson(res, 200, {
        theme: settings.theme?.data || null,
        savedAt: settings.theme?.savedAt || 0,
      });
      return;
    }
    if (req.method === 'PUT' || req.method === 'POST') {
      const body = await readJson(req);
      if (!body || typeof body.theme !== 'object' || body.theme === null) {
        throw badRequest('Нужен объект theme');
      }
      store.saveSettings({ theme: { data: body.theme, savedAt: Date.now() } });
      sendJson(res, 200, { ok: true });
      return;
    }
    throw badRequest('Неподдерживаемый метод');
  }

  if (route[0] === 'settings') {
    if (req.method === 'GET') {
      sendJson(res, 200, { settings: store.maskedSettings() });
      return;
    }
    if (req.method === 'PUT' || req.method === 'POST') {
      const body = await readJson(req);
      const saved = store.saveSettings(body || {});
      for (const name of PROVIDER_NAMES) {
        try {
          providers[name].configure?.(saved[name] || {});
        } catch (err) {
          store.log(`[settings] ${name}: ${err.message}`);
        }
      }
      // настройки изменились (например, токен) — старый статус больше не верен
      statusCache = null;
      statusCacheAt = 0;
      sendJson(res, 200, { ok: true, settings: store.maskedSettings(), sources: await statusAll(true) });
      return;
    }
    throw badRequest('Метод не поддерживается');
  }

  if (route[0] === 'search') {
    const q = (url.searchParams.get('q') || '').trim();
    if (!q) throw badRequest('Пустой поисковый запрос');
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 20, 1), 50);
    const requested = (url.searchParams.get('sources') || PROVIDER_NAMES.join(','))
      .split(',')
      .map((s) => s.trim())
      .filter((s) => PROVIDER_NAMES.includes(s));
    const sources = requested.length ? requested : PROVIDER_NAMES;

    const groups = await Promise.all(
      sources.map(async (source) => {
        try {
          const items = await providers[source].search(q, limit);
          return { source, items: Array.isArray(items) ? items : [] };
        } catch (err) {
          return { source, items: [], error: err.code || 'UPSTREAM', message: err.message };
        }
      }),
    );
    sendJson(res, 200, { query: q, groups });
    return;
  }

  if (route[0] === 'track' && route[1] && route[2]) {
    const found = await providers[route[1]].track(decodeURIComponent(route[2]));
    sendJson(res, 200, { track: found });
    return;
  }

  if (route[0] === 'lyrics' && route[1] && route[2]) {
    // текст песни: ищем по названию/исполнителю/длительности, с кэшем
    try {
      const provider = providers[route[1]];
      const track = provider && typeof provider.track === 'function'
        ? await provider.track(decodeURIComponent(route[2]))
        : null;
      if (!track) {
        sendJson(res, 200, { available: false, synced: [], plain: '', reason: 'NO_TRACK' });
        return;
      }
      const found = await lyrics.findLyrics({
        title: track.title,
        artist: (track.artists || []).join(', '),
        album: track.album,
        duration: track.duration,
      });
      sendJson(res, 200, found);
    } catch (err) {
      sendJson(res, 200, { available: false, synced: [], plain: '', reason: err.code || 'ERROR', message: err.message });
    }
    return;
  }

  if (route[0] === 'stream' && route[1] && route[2]) {
    await handleStream(req, res, route[1], decodeURIComponent(route[2]));
    return;
  }

  if (route[0] === 'wave' && route[1] === 'stations') {
    // категории станций: жанры, настроения, занятия — из ротора Яндекса
    try {
      const yandexProvider = providers.yandex;
      if (!yandexProvider || typeof yandexProvider.stations !== 'function') {
        throw Object.assign(new Error('Категории доступны только с Яндекс.Музыкой'), { code: 'NOT_SUPPORTED' });
      }
      const categories = await yandexProvider.stations();
      sendJson(res, 200, { categories });
    } catch (err) {
      sendJson(res, 200, { categories: [], error: err.code || 'UPSTREAM', message: err.message });
    }
    return;
  }

  if (route[0] === 'wave') {
    if (route[1] === 'feedback') {
      if (req.method !== 'POST') throw badRequest('Ожидается POST');
      const body = await readJson(req);
      const result = await waveEngine.sendFeedback(body || {});
      sendJson(res, 200, result);
      return;
    }
    const limit = Number(url.searchParams.get('limit')) || 20;
    const station = url.searchParams.get('station') || 'user:onyourwave';
    // источники: явный параметр важнее сохранённой настройки
    const fromQuery = url.searchParams.get('sources');
    const saved = store.loadSettings().wave?.sources;
    const sources = fromQuery ? fromQuery.split(',') : saved;
    const waveKey = `${station}|${(sources || []).join(',')}`;

    // Быстрый старт: если лента уже загружалась недавно, отдаём её сразу,
    // не дожидаясь ротора Яндекса (он думает 6–9 секунд). Свежие треки
    // подтянутся следующим запросом.
    const quick = url.searchParams.get('quick') === '1';
    // live: кнопка «обновить» просит настоящую сборку, без подмены сохранённой лентой
    const live = url.searchParams.get('live') === '1';
    if (quick && !live) {
      const fresh = waveEngine.readyBatch(waveKey);
      if (fresh) {
        // из памяти приходит свежая партия (пометки cached нет), с диска — сохранённая
        sendJson(res, 200, { ...fresh, items: fresh.items.slice(0, limit) });
        return;
      }
      // Готовой партии нет, но на диске есть прошлая лента — отдаём её
      // мгновенно, а свежую собираем в фоне. Без этого первый вход
      // ждал до 20 секунд, пока ответят все сервисы.
      const onDisk = libraryCache.loadWave(waveKey);
      if (onDisk && Array.isArray(onDisk.items) && onDisk.items.length) {
        sendJson(res, 200, {
          items: onDisk.items.slice(0, limit),
          station: onDisk.station || station,
          fromCache: true,
          cachedAt: new Date(onDisk.at).toISOString(),
        });
        // прогрев в фоне: следующий запрос получит свежую партию
        waveEngine.getWave(limit, station, sources)
          .then((fresh2) => {
            if (Array.isArray(fresh2?.items) && fresh2.items.length) {
              libraryCache.saveWave(waveKey, fresh2.items, fresh2.station || station);
            }
          })
          .catch(() => {});
        return;
      }
    }

    // Живая сборка с ограничением по времени: один медленный сервис
    // не должен держать ленту дольше восьми секунд.
    //
    // Ещё лучше — не держать вообще: если на диске есть прошлая лента,
    // отдаём её сразу, а свежую собираем в фоне (ровно как в quick-режиме).
    // Клиент получает пометку warming и один раз переспрашивает сам.
    const onDisk = libraryCache.loadWave(waveKey);
    if (!live && onDisk && Array.isArray(onDisk.items) && onDisk.items.length
        && !waveEngine.hasPrepared(station, sources)) {
      sendJson(res, 200, {
        items: onDisk.items.slice(0, limit),
        station: onDisk.station || station,
        sources,
        fromCache: true,
        warming: true,
        cachedAt: new Date(onDisk.at).toISOString(),
        hint: 'Показана сохранённая лента — свежая собирается в фоне.',
      });
      waveEngine.getWave(limit, station, sources)
        .then((freshBatch) => {
          if (Array.isArray(freshBatch?.items) && freshBatch.items.length) {
            libraryCache.saveWave(waveKey, freshBatch.items, freshBatch.station || station);
          }
        })
        .catch(() => {});
      return;
    }

    // live (кнопка «обновить») получает и время, и полные проходы ротора:
    // пользователь сам попросил новый набор и ждёт его осознанно
    const result = await Promise.race([
      waveEngine.getWave(limit, station, sources, live ? { budgetMs: 12000, thorough: true } : {}),
      new Promise((resolve) => setTimeout(
        () => resolve({ items: [], station, warming: true, hint: 'Собираем ленту — ещё пара секунд' }),
        live ? 14_000 : 8_000,
      ).unref?.()),
    ]);

    // кэш ленты: сохраняем непустые партии и используем их, когда сервис недоступен
    if (Array.isArray(result.items) && result.items.length) {
      libraryCache.saveWave(waveKey, result.items, result.station || station);
    } else {
      const cached = libraryCache.loadWave(waveKey);
      if (cached) {
        sendJson(res, 200, {
          ...result,
          items: cached.items,
          station: cached.station || station,
          cached: true,
          cachedAt: new Date(cached.at).toISOString(),
          hint: result.hint || 'Сервис недоступен — показана сохранённая лента.',
        });
        return;
      }
    }

    sendJson(res, 200, result);
    return;
  }

  if (route[0] === 'update') {
    // ?force=1 — проверка по кнопке: кэш игнорируем, иначе отдаётся
    // ответ часовой давности и кажется, что обновление не находится
    const force = url.searchParams.get('force') === '1';
    sendJson(res, 200, await checkForUpdate({ force }));
    return;
  }

  if (route[0] === 'link') {
    const raw = url.searchParams.get('url');
    if (!raw) throw badRequest('Нужен параметр url');
    const resolved = await resolveLink(raw);

    // если это конкретный трек Яндекса и аккаунт подключён — подтягиваем метаданные
    if (resolved.service === 'yandex' && resolved.sourceId) {
      try {
        const track = await providers.yandex.track(resolved.sourceId);
        Object.assign(resolved, {
          title: track.title,
          artists: track.artists,
          cover: track.cover,
          playable: track.playable,
          track,
        });
      } catch {
        /* метаданные недоступны — работаем с тем, что разобрали из ссылки */
      }
    }

    const candidates = await findCandidates(resolved, providers);
    sendJson(res, 200, { ...resolved, candidates });
    return;
  }

  if (route[0] === 'local') {
    if (route[1] === 'import' && req.method === 'POST') {
      const body = await readJson(req);
      const list = Array.isArray(body?.paths) ? body.paths : [];
      if (!list.length) throw badRequest('Нужен список путей к файлам или папкам');
      const result = await localLibrary.importPaths(list);
      sendJson(res, 200, { ok: true, added: result.added, skipped: result.skipped, errors: result.errors });
      return;
    }

    if (route[1] === 'upload' && (req.method === 'PUT' || req.method === 'POST')) {
      const name = url.searchParams.get('name') || 'track.mp3';
      const track = await localLibrary.addUpload(name, req);
      sendJson(res, 200, { ok: true, track });
      return;
    }

    if (req.method === 'DELETE' && route[1]) {
      const removed = localLibrary.removeTrack(decodeURIComponent(route[1]));
      if (!removed) throw Object.assign(new Error('Такого трека нет'), { code: 'NOT_FOUND' });
      sendJson(res, 200, { ok: true });
      return;
    }

    sendJson(res, 200, { items: localLibrary.listTracks(), count: localLibrary.count() });
    return;
  }

function reasonMessage(reason) {
  const texts = {
    NO_CLIENT_ID: 'Для лайков SoundCloud войдите в аккаунт (кнопка «Войти в SoundCloud») или укажите ссылку на профиль.',
    CLIENT_ID_REJECTED: 'SoundCloud отклонил ключ доступа — войдите в аккаунт заново.',
    NO_PROFILE: 'Не удалось найти профиль SoundCloud — укажите ссылку на свой профиль.',
    SESSION_EXPIRED: 'Сессия SoundCloud истекла — войдите заново кнопкой «Войти в SoundCloud».',
    NO_TOKEN: 'Нужен токен Яндекс.Музыки — подключите его в «Подключениях».',
    AUTH_FAILED: 'Токен Яндекс.Музыки не подошёл — получите новый.',
    NOT_SUPPORTED: 'Spotify не отдаёт «Мне нравится» без пользовательской авторизации.',
    UPSTREAM: 'Сервис не ответил — возможно, он недоступен из вашей сети. Проверьте интернет или включите VPN.',
    UPSTREAM_TIMEOUT: 'Сервис долго не отвечает — скорее всего, ограничен доступ из вашей сети.',
  };
  return texts[reason] || null;
}
  if (route[0] === 'clips') {
    // Клипы к треку: Яндексовое API видео не отдаёт, поэтому ищем на YouTube
    const title = url.searchParams.get('title') || '';
    const artist = url.searchParams.get('artist') || '';
    if (!title) throw badRequest('Не указано название трека');
    const items = await clips.searchClips({ title, artist });
    sendJson(res, 200, { ok: true, items });
    return;
  }

  if (route[0] === 'artist') {
    // Страница исполнителя: клик по имени в плеере открывает его треки.
    // Яндекс отдаёт и исполнителя, и его популярные треки по одному id.
    const source = String(route[1] || 'yandex');
    const artistId = decodeURIComponent(String(route[2] || ''));
    const provider = providers[source];
    if (!provider || typeof provider.artistTracks !== 'function') {
      throw badRequest('Для этого источника нет страниц исполнителей');
    }
    if (!artistId) throw badRequest('Не указан исполнитель');

    const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 50, 1), 100);
    const result = await provider.artistTracks(artistId, limit);
    let info = null;
    if (typeof provider.artistInfo === 'function') {
      try { info = await provider.artistInfo(artistId); } catch { /* имя не критично */ }
    }
    sendJson(res, 200, {
      source,
      artistId,
      name: info?.name || (result.tracks[0]?.artists || [])[0] || 'Исполнитель',
      cover: info?.cover || result.tracks.find((t) => t.cover)?.cover || null,
      tracks: result.tracks,
    });
    return;
  }

  if (route[0] === 'playlists') {
    // плейлисты сервисов: свои и чужие (по логину), список и треки
    const settings = store.loadSettings();
    const source = String(route[1] || 'yandex');
    const provider = providers[source];
    if (!provider || typeof provider.playlists !== 'function') {
      sendJson(res, 200, { items: [], error: 'NOT_SUPPORTED', message: reasonMessage('NOT_SUPPORTED') });
      return;
    }

    // треки конкретного плейлиста: /api/playlists/{source}/{id}
    if (route[2]) {
      if (typeof provider.playlistTracks !== 'function') {
        sendJson(res, 200, { items: [], error: 'NOT_SUPPORTED' });
        return;
      }
      try {
        const result = await provider.playlistTracks(decodeURIComponent(route[2]));
        const items = Array.isArray(result) ? result : result?.items || [];
        sendJson(res, 200, { items, error: items.length ? null : result?.reason || null });
      } catch (err) {
        sendJson(res, 200, { items: [], error: err.code || 'UPSTREAM', message: err.message });
      }
      return;
    }

    const owner = url.searchParams.get('owner') || '';
    try {
      const result = await provider.playlists({ owner });
      const items = Array.isArray(result) ? result : result?.items || [];
      sendJson(res, 200, {
        items,
        error: items.length ? null : result?.reason || null,
        message: items.length ? null : reasonMessage(result?.reason),
      });
    } catch (err) {
      sendJson(res, 200, { items: [], error: err.code || 'UPSTREAM', message: err.message });
    }
    return;
  }

  if (route[0] === 'network') {
    // прокси: состояние, проверка соединения и сохранение — без перезапуска
    if (req.method === 'GET') {
      const settings = store.loadSettings();
      sendJson(res, 200, {
        ...proxySupport.status(),
        // система автоподбора: включена по умолчанию, отключается в настройках
        autoProxy: settings.network?.autoProxy !== false,
        autoProxyCurrent: scProxy.current() || '',
        autoProxyLast: scProxy.last(),
        ffmpeg: audioconvert.hasFfmpeg(),
      });
      return;
    }

    if (req.method === 'POST' && route[1] === 'find') {
      // Автоподбор: перебираем публичные прокси и проверяем реальное аудио SoundCloud.
      let clientId = '';
      try {
        clientId = await providers.soundcloud?.acquireClientId?.() || '';
      } catch (err) {
        store.log('[proxy] не удалось получить client_id: ' + ((err && err.message) || err));
      }
      if (!clientId) throw badRequest('Не удалось получить client_id SoundCloud — без него проверка невозможна');

      // эталонный трек: из избранного, иначе известный публичный
      let trackId = '2424504549';
      try {
        const liked = await providers.soundcloud.likes(3);
        if (liked?.items?.length) trackId = liked.items[0].sourceId;
      } catch { /* используем запасной */ }

      const result = await proxyFinder.findWorkingProxy({ clientId, trackId });
      if (result.ok) {
        // найденный прокси сразу сохраняем и применяем
        store.saveSettings({ network: { proxy: result.proxy, useSystemProxy: false } });
        await proxySupport.refresh(store.loadSettings().network || {});
        store.log('[proxy] автоподбор: применён ' + result.proxy);
      }
      sendJson(res, 200, result);
      return;
    }

    if (req.method === 'POST' && route[1] === 'stop') {
      proxyFinder.cancelSearch();
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === 'POST' && route[1] === 'test') {
      const result = await proxySupport.test();
      sendJson(res, 200, result);
      return;
    }

    if (req.method === 'PUT' || req.method === 'POST') {
      const body = await readJson(req);
      const proxyValue = typeof body?.proxy === 'string' ? body.proxy.trim() : '';
      if (proxyValue && !proxySupport.normalizeProxy(proxyValue)) {
        throw badRequest('Неверный адрес прокси. Пример: socks5://127.0.0.1:1080 или http://127.0.0.1:8080');
      }

      store.saveSettings({
        network: {
          proxy: proxyValue,
          useSystemProxy: Boolean(body?.useSystemProxy),
          // выключатель системы автоподбора для SoundCloud
          ...(typeof body?.autoProxy === 'boolean' ? { autoProxy: body.autoProxy } : {}),
        },
      });

      const saved = store.loadSettings().network || {};
      const auto = saved.autoProxy !== false;

      if (!auto) {
        // автоподбор выключен: снимаем прокси и работаем напрямую
        await scProxy.reset();
        const state = await proxySupport.refresh(saved);
        store.log('[proxy] автоподбор выключен пользователем');
        sendJson(res, 200, { ok: true, autoProxy: false, ...state });
        return;
      }

      // ручной адрес задан — принимаем его; пустой — пусть подбирает сам
      if (proxyValue) {
        await scProxy.adopt(proxyValue);
      } else {
        scProxy.ensure({ force: true }).catch(() => {});
      }

      const state = await proxySupport.refresh(saved);
      const label = state.active ? `${state.activeMasked} (${state.activeSource})` : 'выключен';
      store.log(`[proxy] применено: ${label}, автоподбор: ${auto ? 'вкл' : 'выкл'}`);
      sendJson(res, 200, { ok: true, autoProxy: auto, ...state });
      return;
    }

    throw badRequest('Неподдерживаемый метод');
  }

  if (route[0] === 'soundcloud' && route[1] === 'keycheck') {
    // Проверка автоключа: получен ли client_id и работает ли он на деле.
    // Кнопка «Проверить автоключ» в «Подключениях» вызывала несуществующий
    // маршрут и молча ничего не делала.
    try {
      const clientId = await providers.soundcloud?.acquireClientId?.() || '';
      if (!clientId) {
        sendJson(res, 200, { ok: false, message: 'Автоключ не получен' });
        return;
      }

      // короткий настоящий запрос: если API принял ключ, он отвечает 200/401,
      // а не отказом авторизации — этого достаточно
      const probe = await providers.soundcloud?.search?.('test', 1).catch((err) => ({ error: err }));
      const works = !probe?.error;

      sendJson(res, 200, {
        ok: works,
        clientId: `${clientId.slice(0, 6)}…`,
        message: works ? 'Автоключ работает' : 'Ключ получен, но запрос не прошёл',
      });
    } catch (err) {
      sendJson(res, 200, { ok: false, message: (err && err.message) || 'Не удалось проверить' });
    }
    return;
  }

  if (route[0] === 'soundcloud' && route[1] === 'session') {
    // сессия после входа: сохраняем cookie и сразу проверяем, кто вошёл
    if (req.method === 'DELETE') {
      store.saveSettings({ soundcloud: { cookies: '', cookiesAt: 0 } });
      await loadProviders();
      statusCache = null;
      statusCacheAt = 0;
      sendJson(res, 200, { ok: true, me: null });
      return;
    }

    if (req.method !== 'PUT' && req.method !== 'POST') throw badRequest('Ожидается PUT');
    const body = await readJson(req);
    if (!body || typeof body.cookies !== 'string' || !body.cookies.trim()) {
      throw badRequest('Нужны cookie сессии SoundCloud');
    }

    const saved = store.saveSettings({
      soundcloud: {
        cookies: body.cookies,
        cookiesAt: Date.now(),
        ...(typeof body.clientId === 'string' && body.clientId.trim() ? { clientId: body.clientId.trim() } : {}),
        ...(typeof body.profileUrl === 'string' && body.profileUrl.trim() ? { profileUrl: body.profileUrl.trim() } : {}),
      },
    });

    // провайдер перечитывает настройки и пробует /me
    for (const name of PROVIDER_NAMES) {
      try { providers[name].configure?.(saved[name] || {}); } catch { /* ignore */ }
    }
    // вошли в аккаунт — прежний статус «не подключено» уже неверен
    statusCache = null;
    statusCacheAt = 0;

    let me = null;
    try {
      const probe = await providers.soundcloud?.sessionUser?.();
      me = probe || null;
    } catch (err) {
      store.log('[soundcloud] проверка сессии: ' + ((err && err.message) || err));
    }

    sendJson(res, 200, { ok: true, me });
    return;
  }

  if (route[0] === 'dpi') {
    // Обход блокировки SoundCloud через zapret (DPI).
    // У большинства в РФ уже стоит zapret для YouTube/Discord — мы НЕ запускаем
    // второй обходчик, а дописываем домены SoundCloud в его списки.

    // Автообслуживание проверяем ДО общей ветки GET: иначе она перехватит
    if (route[1] === 'check') {
      // ?force=1 — не ждать паузу между правками (кнопка «починить»)
      const force = url.searchParams.get('force') === '1';
      if (force) dpiauto.resetCooldown();
      sendJson(res, 200, await dpiauto.ensure({ force }));
      return;
    }

    if (route[1] === 'report') {
      sendJson(res, 200, dpiauto.report());
      return;
    }

    // Включить обход: поднять winws, если не запущен (спросит права)
    if (route[1] === 'start' && req.method === 'POST') {
      const payload = await readJson(req).catch(() => ({}));
      sendJson(res, 200, await dpiwatcher.startBypass({ strategy: payload?.strategy || null }));
      return;
    }

    if (route[1] === 'state') {
      sendJson(res, 200, { ...await dpiwatcher.status(), ...dpiwatcher.listStrategies() });
      return;
    }

    // Список всех стратегий — для выбора вручную
    if (route[1] === 'strategies') {
      sendJson(res, 200, dpiwatcher.listStrategies());
      return;
    }

    if (req.method === 'GET') {
      sendJson(res, 200, {
        ...dpi.status(),
        folders: dpi.findZapretFolders(),
        running: await dpi.detectRunning(),
        probe: await dpi.probe(),
      });
      return;
    }

    if (req.method === 'POST' && route[1] === 'apply') {
      const folders = dpi.findZapretFolders();
      if (!folders.length) {
        sendJson(res, 200, {
          ok: false,
          message: 'Установленный zapret не найден. Поставьте сборку Flowseal и повторите.',
          folders: [],
        });
        return;
      }
      const results = dpi.addDomainsToZapret(folders);
      const added = results.reduce((sum, item) => sum + (item.added || []).length, 0);
      store.log(`[dpi] домены SoundCloud добавлены: ${added} шт. в ${results.length} папках`);
      sendJson(res, 200, { ok: true, added, results, probe: await dpi.probe() });
      return;
    }

    if (req.method === 'POST' && route[1] === 'probe') {
      sendJson(res, 200, await dpi.probe());
      return;
    }

    throw badRequest('Неподдерживаемый метод');
  }

  if (route[0] === 'likes') {
    // избранное по источникам: какие сервисы включены, такие и опрашиваем
    const settings = store.loadSettings();
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 100, 1), 300);
    const requested = (url.searchParams.get('sources') || 'yandex')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => PROVIDER_NAMES.includes(s));
    const sources = requested.length ? requested : ['yandex'];

    const groups = await Promise.all(
      sources.map(async (source) => {
        const provider = providers[source];
        if (!provider || typeof provider.likes !== 'function') {
          return {
            source,
            items: [],
            error: 'NOT_SUPPORTED',
            message: 'Этот сервис не отдаёт избранное без входа в аккаунт',
          };
        }
        try {
          // провайдер может вернуть список либо {items, reason} — приводим к одному виду
          const result = await provider.likes(limit, settings.soundcloud?.profileUrl || '');
          if (Array.isArray(result)) return { source, items: result };
          const items = Array.isArray(result?.items) ? result.items : [];
          return {
            source,
            items,
            error: items.length ? null : result?.reason || null,
            message: items.length ? null : reasonMessage(result?.reason),
          };
        } catch (err) {
          return { source, items: [], error: err.code || 'UPSTREAM', message: err.message };
        }
      }),
    );

    // успешные источники кэшируем; при ошибке отдаём сохранённое ранее
    for (const group of groups) {
      if (!group.error && Array.isArray(group.items) && group.items.length) {
        libraryCache.saveLikes(group.source, group.items);
        continue;
      }
      const cached = libraryCache.loadLikes(group.source);
      if (cached) {
        Object.assign(group, {
          items: cached.items,
          cached: true,
          cachedAt: new Date(cached.at).toISOString(),
          message: group.message ? `${group.message} Показаны сохранённые треки.` : 'Показаны сохранённые треки.',
        });
      }
    }

    sendJson(res, 200, { groups });
    return;
  }

  if (route[0] === 'history') {
    if (req.method === 'POST') {
      const body = await readJson(req);
      if (!body || !body.track) throw badRequest('Нужен объект track');
      store.addHistory(body);
      sendJson(res, 200, { ok: true });
      return;
    }
    sendJson(res, 200, { items: store.getHistory(Number(url.searchParams.get('limit')) || 50) });
    return;
  }

  sendJson(res, 404, { error: { code: 'NOT_FOUND', message: 'Такого метода API нет' } });
}

/* -------------------------------- сервер --------------------------------- */

const server = http.createServer((req, res) => {
  const startedAt = Date.now();
  let url;
  try {
    url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  } catch {
    sendJson(res, 400, { error: { code: 'BAD_REQUEST', message: 'Некорректный URL' } });
    return;
  }

  const done = () => {
    if (url.pathname.startsWith('/api/') && !url.pathname.startsWith('/api/stream/')) {
      store.log(`[api] ${req.method} ${url.pathname}${url.search} → ${res.statusCode} (${Date.now() - startedAt} мс)`);
    }
  };
  res.on('finish', done);

  if (url.pathname.startsWith('/api/')) {
    handleApi(req, res, url).catch((err) => {
      if (!res.headersSent) sendError(res, err);
      else res.destroy();
    });
    return;
  }

  try {
    serveStatic(req, res, url.pathname);
  } catch (err) {
    if (!res.headersSent) sendError(res, err);
  }
});

lyrics.configure();
audioconvert.configure();
libraryCache.configure();
dpi.configure();
dpiwatcher.configure();

/*
 * Порт открываем ПОСЛЕ загрузки провайдеров.
 *
 * Раньше listen() срабатывал сразу, а провайдеры грузились внутри колбэка.
 * Интерфейс успевал спросить /api/status в эту щель и получал заглушки
 * («нет доступа» ко всем сервисам), которые потом залипали в кэше.
 */
loadProviders()
  .then(() => {
    server.listen(PORT, '127.0.0.1', () => {
      store.log(`labsoul запущен: http://127.0.0.1:${PORT}`);
      process.stdout.write(`\n  labsoul: http://127.0.0.1:${PORT}\n\n`);

      // Прогрев статуса: первый заход в интерфейс покажет готовые данные.
      refreshStatus().catch(() => {});

      /*
       * Прогрев соединений через обход.
       *
       * Первые обращения к SoundCloud после запуска обрываются по
       * таймауту — соединения ещё холодные, а обход только начал
       * работать. Прогреваем сразу и повторяем в фоне: к первому
       * нажатию «играть» канал уже готов, и трек не висит.
       */
      const warmupBypass = async () => {
        for (let round = 1; round <= 3; round += 1) {
          await dpi.probe();
        }
      };
      warmupBypass().catch(() => {});

      /*
       * Автообслуживание обхода блокировки.
       *
       * Проверяем доступность SoundCloud в фоне и, если хосты отвалились,
       * сами восстанавливаем списки zapret. Пользователю не нужно ничего
       * нажимать. Чужую стратегию не перезапускаем никогда — это могло
       * оставить без обхода вообще.
       */
      setTimeout(() => {
        dpiauto.ensure().then((result) => {
          if (result.repaired) store.log(`[dpi] автопочинка: ${result.repairMessage}`);
          else if (!result.ok) store.log(`[dpi] недоступно: ${(result.failed || []).join(', ')}`);
        }).catch((error) => store.log(`[dpi] проверка не удалась: ${error.message}`));
      }, 6000);
    });
  })
  .catch((err) => {
    store.log('Ошибка загрузки провайдеров:', err?.message || err);
    // даже без провайдеров интерфейс должен открыться
    server.listen(PORT, '127.0.0.1', () => {
      process.stdout.write(`\n  labsoul: http://127.0.0.1:${PORT}\n\n`);
    });
  });

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    store.log(`Порт ${PORT} занят — скорее всего плеер уже запущен.`);
    process.exit(0);
  }
  store.log('Ошибка сервера:', err.message);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    store.log('Остановка сервера');
    server.close(() => process.exit(0));
  });
}
