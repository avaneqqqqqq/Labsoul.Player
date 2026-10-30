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
import { decryptBuffer, parseRange } from './streaming.mjs';
import { resolveLink, findCandidates } from './linkimport.mjs';
import { checkForUpdate } from './update.mjs';
import * as localLibrary from './local.mjs';
import * as lyrics from './lyrics.mjs';

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
  const desc = await provider.stream(sourceId);
  if (!desc || (!desc.url && !desc.buffer && !desc.filePath)) {
    const err = new Error('Источник не вернул поток');
    err.code = 'NOT_PLAYABLE';
    throw err;
  }
  descCache.set(key, { at: Date.now(), desc });
  return desc;
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

function serveBuffer(buffer, req, res, contentType) {
  const total = buffer.length;
  res.setHeader('Content-Type', contentType || 'audio/mpeg');
  res.setHeader('Accept-Ranges', 'bytes');
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

async function statusAll() {
  const out = {};
  await Promise.all(
    PROVIDER_NAMES.map(async (name) => {
      try {
        const st = await providers[name].status();
        // провайдеры вправе вернуть error объектом — в UI проще строковый код
        if (st && st.error && typeof st.error === 'object') st.error = st.error.code || 'UPSTREAM';
        out[name] = st;
      } catch (err) {
        out[name] = { connected: false, error: err.code || 'UPSTREAM' };
      }
    }),
  );
  return out;
}

/* --------------------------------- API ----------------------------------- */

async function handleApi(req, res, url) {
  const segments = url.pathname.split('/').filter(Boolean); // ['api', ...]
  const route = segments.slice(1);

  if (route[0] === 'health') {
    sendJson(res, 200, { ok: true, version: '0.1.0', uptime: Math.round(process.uptime()) });
    return;
  }

  if (route[0] === 'status') {
    sendJson(res, 200, { ok: true, version: '0.1.0', sources: await statusAll() });
    return;
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
      sendJson(res, 200, { ok: true, settings: store.maskedSettings(), sources: await statusAll() });
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
    const result = await waveEngine.getWave(limit, station, sources);
    sendJson(res, 200, result);
    return;
  }

  if (route[0] === 'update') {
    sendJson(res, 200, await checkForUpdate());
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

  if (route[0] === 'likes') {
    // избранное по источникам: какие сервисы включены, такие и опрашиваем
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
          const items = await provider.likes(limit);
          return { source, items: Array.isArray(items) ? items : [] };
        } catch (err) {
          return { source, items: [], error: err.code || 'UPSTREAM', message: err.message };
        }
      }),
    );

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

server.listen(PORT, '127.0.0.1', async () => {
  await loadProviders();
  store.log(`labsoul запущен: http://127.0.0.1:${PORT}`);
  process.stdout.write(`\n  labsoul: http://127.0.0.1:${PORT}\n\n`);
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
