'use strict';

/**
 * Провайдер Яндекс.Музыки.
 *
 * Авторизация: OAuth-токен.
 * Поток: GET /get-file-info с HMAC-SHA256-подписью; при transports=raw отдаётся
 *        прямая ссылка на CDN, при transports=encraw — зашифрованный поток
 *        (AES-128-CTR, ключ приходит в ответе полем key).
 * «Моя волна»: rotor-станция user:onyourwave.
 */

import crypto from 'node:crypto';

// Базовый адрес можно переопределить: удобно для своего прокси/зеркала и для
// тестов, где api.music.yandex.net подменяется локальным мок-сервером.
const API = (process.env.YANDEX_API_BASE || 'https://api.music.yandex.net').replace(/\/+$/, '');
const CLIENT_HEADER = 'YandexMusicWebNext/1.0.0';
// Ключ подписи web-клиента музыкального сервиса (используется открытыми клиентами).
const SIGN_KEY = '7tvSmFbyf5hJnIHhCimDDD';
const TIMEOUT = 15000;

const cfg = { token: '', quality: 'nq' };
let cachedUser = null;
let lastError = null;

export const id = 'yandex';

/* ------------------------------ утилиты --------------------------------- */

function fail(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function authHeaders() {
  return {
    Authorization: `OAuth ${cfg.token}`,
    'X-Yandex-Music-Client': CLIENT_HEADER,
    Accept: 'application/json',
  };
}

async function request(pathname, { method = 'GET', body, headers = {} } = {}) {
  if (!cfg.token) throw fail('NO_TOKEN', 'Не задан OAuth-токен Яндекс.Музыки');
  let res;
  try {
    res = await fetch(API + pathname, {
      method,
      headers: {
        ...authHeaders(),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT),
    });
  } catch (err) {
    throw fail('UPSTREAM', `Яндекс.Музыка недоступна: ${err.message}`);
  }

  const text = await res.text();
  if (res.status === 401 || res.status === 403) {
    throw fail('AUTH_FAILED', 'Яндекс.Музыка отклонила токен (401/403)');
  }
  if (!res.ok) {
    throw fail('UPSTREAM', `Яндекс.Музыка ответила ${res.status}: ${text.slice(0, 200)}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw fail('UPSTREAM', 'Яндекс.Музыка вернула не-JSON ответ');
  }
}

/** Прямой GET по абсолютному адресу (CDN, без OAuth-заголовков). */
async function fetchJson(url) {
  const res = await fetch(url, {
    headers: { 'X-Yandex-Music-Client': CLIENT_HEADER, Accept: 'application/json' },
    signal: AbortSignal.timeout(TIMEOUT),
  });
  if (!res.ok) throw fail('UPSTREAM', `CDN ответил ${res.status}`);
  return res.json();
}

/* --------------------------- нормализация ------------------------------- */

function coverUrl(uri, size = '400x400') {
  if (!uri) return null;
  const path = String(uri).replace('%%', size);
  return path.startsWith('http') ? path : `https://${path}`;
}

export function mapTrack(t) {
  if (!t || !t.id) return null;
  const albums = Array.isArray(t.albums) ? t.albums : [];
  const album = albums[0] || null;
  const artists = (Array.isArray(t.artists) ? t.artists : []).map((a) => a && a.name).filter(Boolean);
  const available = t.available !== false && !(album && album.available === false);

  return {
    id: `ym:${t.id}`,
    source: 'yandex',
    sourceId: String(t.id),
    title: t.title || 'Без названия',
    artists: artists.length ? artists : ['Неизвестный исполнитель'],
    album: album ? album.title || null : null,
    cover: coverUrl(album && album.coverUri) || coverUrl(t.coverUri),
    duration: t.durationMs ? Math.round(t.durationMs / 1000) : Number(t.duration) || 0,
    playable: Boolean(available),
    reason: available ? null : 'geo',
    explicit: Boolean(t.contentWarning),
  };
}

/* ------------------------- интерфейс провайдера -------------------------- */

export function configure(next) {
  if (!next || typeof next !== 'object') return;
  if (typeof next.token === 'string') {
    const token = next.token.trim();
    if (token !== cfg.token) {
      cfg.token = token;
      cachedUser = null;
      cachedUid = null;
    }
  }
  if (typeof next.quality === 'string' && ['lq', 'nq', 'lossless'].includes(next.quality)) {
    cfg.quality = next.quality;
  }
}

export async function status() {
  if (!cfg.token) return { connected: false, error: 'NO_TOKEN' };
  try {
    const data = await request('/account/status');
    const account = data?.result?.account || data?.account || {};
    cachedUser = account.displayName || account.login || account.uid || 'пользователь';
    lastError = null;
    return { connected: true, user: cachedUser };
  } catch (err) {
    lastError = err.code || 'UPSTREAM';
    cachedUser = null;
    return { connected: false, error: lastError, message: err.message };
  }
}

export async function search(query, limit = 20) {
  const q = String(query || '').trim();
  if (!q) return [];
  const data = await request(
    `/search?text=${encodeURIComponent(q)}&type=track&page=0&page_size=${Math.min(Math.max(limit, 1), 50)}&nocorrect=false`,
  );
  const tracks = data?.result?.tracks?.results || data?.result?.tracks || [];
  return (Array.isArray(tracks) ? tracks : []).map(mapTrack).filter(Boolean);
}

export async function track(sourceId) {
  const data = await request(`/tracks/${encodeURIComponent(String(sourceId))}`);
  const list = data?.result || data;
  const raw = Array.isArray(list) ? list[0] : list;
  const mapped = mapTrack(raw);
  if (!mapped) throw fail('NOT_FOUND', 'Трек не найден');
  return mapped;
}

/* ---------------------------- получение потока --------------------------- */

function signFileInfo(ts, trackId, quality, codecs, transports) {
  const material = `${ts}${trackId}${quality}${codecs}${transports}`;
  return crypto.createHmac('sha256', SIGN_KEY).update(material).digest('base64').replace(/=+$/, '');
}

async function getFileInfo(trackId, { quality, codecs, transports }) {
  const ts = Math.floor(Date.now() / 1000);
  const sign = signFileInfo(ts, trackId, quality, codecs, transports);
  const url =
    `${API}/get-file-info?ts=${ts}&trackId=${encodeURIComponent(trackId)}` +
    `&quality=${quality}&codecs=${codecs}&transports=${transports}&sign=${encodeURIComponent(sign)}`;

  let data;
  try {
    const res = await fetch(url, {
      headers: { ...authHeaders(), Referer: 'https://music.yandex.ru/' },
      signal: AbortSignal.timeout(TIMEOUT),
    });
    const text = await res.text();
    if (!res.ok) throw fail('UPSTREAM', `get-file-info ${res.status}`);
    data = JSON.parse(text);
  } catch (err) {
    throw err.code ? err : fail('UPSTREAM', `get-file-info: ${err.message}`);
  }

  const info = data?.downloadInfo || data?.result?.downloadInfo || data?.result;
  if (!info) throw fail('NOT_PLAYABLE', 'Сервис не вернул информацию о файле');

  const urls = Array.isArray(info.urls) ? info.urls : info.url ? [info.url] : [];
  if (!urls.length) throw fail('NOT_PLAYABLE', 'Нет доступных ссылок на файл');

  return {
    url: decodeURIComponent(urls[0]),
    key: info.key || null,
    codec: info.codec || codecs,
    bitrate: info.bitrate || 0,
  };
}

export async function stream(sourceId) {
  const trackId = String(sourceId);
  // Набор попыток: сначала тот же формат, что у обычных клиентов (mp3),
  // затем шифрованный поток, из которого сервер сам снимет защиту.
  const quality = cfg.quality === 'lossless' ? 'lossless' : cfg.quality === 'lq' ? 'lq' : 'nq';
  const attempts =
    quality === 'lossless'
      ? [
          { quality: 'lossless', codecs: 'flac', transports: 'raw' },
          { quality: 'lossless', codecs: 'flac', transports: 'encraw' },
          { quality: 'nq', codecs: 'mp3', transports: 'raw' },
        ]
      : [
          { quality, codecs: 'mp3', transports: 'raw' },
          { quality, codecs: 'mp3', transports: 'encraw' },
          { quality: 'lq', codecs: 'mp3', transports: 'raw' },
        ];

  let lastErr = null;
  for (const attempt of attempts) {
    try {
      const info = await getFileInfo(trackId, attempt);
      const lossless = String(info.codec).includes('flac');
      const isMp4 = String(info.codec).includes('mp4');
      const result = {
        url: info.url,
        contentType: lossless ? 'audio/flac' : isMp4 ? 'audio/mp4' : 'audio/mpeg',
        repeatable: false,
      };
      if (info.key && attempt.transports === 'encraw') {
        result.decrypt = { algo: 'aes-128-ctr', keyHex: info.key, nonceLen: 12 };
      }
      return result;
    } catch (err) {
      lastErr = err;
      if (err.code === 'AUTH_FAILED' || err.code === 'NO_TOKEN') throw err;
    }
  }
  throw lastErr || fail('NOT_PLAYABLE', 'Не удалось получить поток');
}

/* ------------------------------- ротор ---------------------------------- */

const DEFAULT_STATION = 'user:onyourwave';

export async function wave(limit = 20, station = DEFAULT_STATION) {
  const want = Math.min(Math.max(Number(limit) || 20, 1), 50);
  const items = [];
  const seen = new Set();
  let batchId = null;

  // Ротор отдаёт по 5 треков и только последовательные вызовы дают разные
  // порции: параллельные возвращают одну и ту же пятёрку. Поэтому идём
  // по очереди, а латентность скрывает серверная заготовка партий.
  const maxRounds = Math.min(6, Math.ceil(want / 5) + 1);
  for (let round = 0; round < maxRounds && items.length < want; round += 1) {
    let data;
    try {
      data = await request(`/rotor/station/${encodeURIComponent(station)}/tracks?settings2=true`);
    } catch (err) {
      if (items.length) break;
      throw err;
    }

    const result = data?.result || data;
    batchId = result?.batchId || batchId;
    const sequence = Array.isArray(result?.sequence) ? result.sequence : [];
    if (!sequence.length) break;

    let added = 0;
    for (const step of sequence) {
      const mapped = mapTrack(step?.track);
      if (mapped && !seen.has(mapped.id)) {
        seen.add(mapped.id);
        items.push(mapped);
        added += 1;
      }
    }
    if (!added) break;
  }

  return { station, batchId, items: items.slice(0, want) };
;
}

/* --------------------------- лайкнутые треки ----------------------------- */

let cachedUid = null;

async function accountUid() {
  if (cachedUid) return cachedUid;
  const data = await request('/account/status');
  const account = data?.result?.account || {};
  cachedUid = account.uid || account.login || null;
  if (!cachedUid) throw fail('AUTH_FAILED', 'Не удалось определить пользователя Яндекс.Музыки');
  return cachedUid;
}

/**
 * Лайкнутые треки аккаунта.
 *
 * Сервис отдаёт в /likes/tracks только пары id:albumId (и игнорирует limit),
 * поэтому нужное количество отрезаем сами, а метаданные дозапрашиваем пачками
 * по 50: большой единый запрос API отвергает (413).
 */
export async function likes(limit = 100) {
  const want = Math.min(Math.max(Number(limit) || 100, 1), 300);
  const uid = await accountUid();
  const data = await request(`/users/${encodeURIComponent(uid)}/likes/tracks`);
  const entries = Array.isArray(data?.result?.library?.tracks) ? data.result.library.tracks : [];
  const ids = entries.slice(0, want).map((entry) => `${entry.id}:${entry.albumId}`);

  const tracks = [];
  const seen = new Set();
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50).join(',');
    try {
      const res = await request(`/tracks?trackIds=${encodeURIComponent(chunk)}`);
      for (const raw of Array.isArray(res?.result) ? res.result : []) {
        const mapped = mapTrack(raw);
        if (mapped && !seen.has(mapped.id)) {
          seen.add(mapped.id);
          tracks.push(mapped);
        }
      }
    } catch (err) {
      // одна проблемная пачка не должна обнулять всю библиотеку
      if (i === 0) throw err;
      console.warn('[yandex] likes batch:', err.message);
    }
  }
  return tracks;
}

/* ------------------------- категории «Моей волны» ------------------------ */

const STATION_LABELS = {
  personal: 'Персональные',
  genre: 'Жанры',
  mood: 'Настроение',
  activity: 'Занятие',
  epoch: 'Эпоха',
  tempo: 'Темп',
  editorial: 'Подборки',
  'local-language': 'Языки',
  'micro-genre': 'Микро-жанры',
  author: 'Авторские',
  locale: 'Страны',
  other: 'Ещё',
};

// Технические миксы дублируют обычные категории — в интерфейсе они не нужны.
const STATION_SKIP = /^mix-by-/;

let stationsCache = null;

/**
 * Категории станций ротора: жанры, настроения, занятия и т.д.
 * /rotor/stations/list отдаёт ~700 станций, где id — объект {type, tag},
 * поэтому собираем полный id как «type:tag» и группируем по типу.
 */
export async function stations() {
  if (stationsCache) return stationsCache;

  const data = await request('/rotor/stations/list');
  const list = Array.isArray(data?.result) ? data.result : [];
  const byType = new Map();

  // персональная станция всегда доступна отдельно
  byType.set('personal', [{ id: 'user:onyourwave', name: 'Моя волна', icon: null }]);

  for (const item of list) {
    const station = item?.station || item;
    const idObject = station?.id;
    if (!idObject || typeof idObject !== 'object') continue;
    const type = idObject.type;
    const tag = idObject.tag || (idObject.name ? String(idObject.name) : null);
    if (!type || !tag) continue;
    const id = `${type}:${tag}`;
    if (!byType.has(type)) byType.set(type, []);
    const bucket = byType.get(type);
    if (bucket.length >= 120) continue;
    if (bucket.some((s) => s.id === id)) continue;
    bucket.push({
      id,
      name: station.name || tag,
      icon: station.icon?.imageUrl ? `https://${String(station.icon.imageUrl).replace('%%', '200x200')}` : null,
    });
  }

  stationsCache = [...byType.entries()]
    .filter(([type, items]) => items.length && !STATION_SKIP.test(type))
    .map(([type, items]) => ({
      type,
      label: STATION_LABELS[type] || type,
      stations: items,
    }))
    .sort((a, b) => (a.type === 'personal' ? -1 : b.type === 'personal' ? 1 : a.label.localeCompare(b.label, 'ru')));

  return stationsCache;
}

const FEEDBACK_TYPES = {
  like: 'like',
  dislike: 'dislike',
  skip: 'skip',
  started: 'trackStarted',
  finished: 'trackFinished',
};

export async function feedback(event) {
  const type = FEEDBACK_TYPES[event?.type];
  if (!type) return { ok: true, skipped: true };
  if (!cfg.token) return { ok: true, skipped: true };

  const station = event.station || DEFAULT_STATION;
  const body = {
    type,
    trackId: String(event.sourceId || event.trackId || ''),
    batchId: event.batchId || '',
    timestamp: new Date().toISOString(),
  };
  // Яндекс требует это поле всегда, иначе 400 «Some parts were not parsed»
  body.totalPlayedSeconds = Math.max(0, Math.round(Number(event.position) || 0));

  try {
    await request(`/rotor/station/${encodeURIComponent(station)}/feedback`, { method: 'POST', body });
    return { ok: true };
  } catch (err) {
    // дизлайк/скип не должен валить UI из-за сетевой ошибки
    logFeedbackFailure(err);
    return { ok: false, error: err.code || 'UPSTREAM' };
  }
}

function logFeedbackFailure(err) {
  console.warn('[yandex] feedback:', err && err.message);
}

/** Служебное: проверить токен и получить 2 трека — используется в doctor-скрипте. */
export async function diagnose() {
  const st = await status();
  if (!st.connected) return { connected: false, error: st.error };
  const found = await search('Мираж', 3).catch((e) => ({ error: e.message }));
  return {
    connected: true,
    user: st.user,
    quality: cfg.quality,
    searchSample: Array.isArray(found) ? found.map((t) => `${t.artists[0]} — ${t.title}`) : found,
  };
}
