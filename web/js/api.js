/* =========================================================================
   labsoul — клиент API (CONTRACT.md).
   Любой сетевой сбой переводит приложение в демо-режим: интерфейс остаётся
   живым, а данные берутся из js/demo.js. Ошибки уровня источника приходят
   внутри groups/status и демо-режим не включают.
   ========================================================================= */

import {
  DEMO_TRACKS,
  demoHistory,
  demoSettings,
  demoSearch,
  demoStatus,
  demoWave,
} from './demo.js';

export class ApiError extends Error {
  constructor(code, message, status = 0) {
    super(message || code || 'Ошибка API');
    this.name = 'ApiError';
    this.code = code || 'ERROR';
    this.status = status;
  }
}

export const SOURCE_KEYS = ['yandex', 'soundcloud', 'spotify'];
const SOURCES = new Set(SOURCE_KEYS);

/** Состояние связи с локальным сервером. */
export const net = {
  mode: 'unknown', // unknown | online | demo
  version: null,
  demo: true,
  error: null,
  // последний мягкий сбой (таймаут запроса) — не переводит интерфейс в демо
  lastError: null,
};

const listeners = new Set();
function notify() {
  for (const fn of listeners) {
    try { fn(net); } catch { /* слушатель не должен ломать сеть */ }
  }
}
export function onNetChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function setMode(mode, version = null, error = null) {
  const changed = net.mode !== mode || net.version !== version || net.error !== error;
  net.mode = mode;
  net.demo = mode !== 'online';
  if (version !== null) net.version = version;
  net.error = error;
  if (changed) notify();
}

function degrade(err) {
  // Даже один медленный запрос (волна думает 10 секунд) не должен ронять
  // весь интерфейс в демо-режим. Переключаемся только если сервер реально
  // перестал отвечать на /api/health — это проверяет recoverIfNeeded().
  const message = err?.name === 'AbortError'
    ? 'запрос превысил время ожидания'
    : err?.message || 'сервер не отвечает';
  net.lastError = message;
  if (net.mode === 'online') {
    // мягкий сбой: остаёмся онлайн, но помечаем проблему и проверяем живость
    scheduleHealthCheck();
    return;
  }
  setMode('demo', net.version, message);
}

let healthCheckTimer = 0;

/** Проверяем сервер после мягкого сбоя: жив — остаёмся онлайн. */
function scheduleHealthCheck() {
  if (healthCheckTimer) return;
  healthCheckTimer = setTimeout(async () => {
    healthCheckTimer = 0;
    try {
      const res = await fetch('/api/health', { cache: 'no-store', signal: AbortSignal.timeout(4000) });
      if (res.ok) {
        const data = await res.json().catch(() => null);
        setMode('online', data?.version || net.version, null);
        return;
      }
    } catch { /* сервер правда недоступен */ }
    setMode('demo', net.version, 'сервер не отвечает');
  }, 1200);
}

export const isOnline = () => net.mode === 'online';
/**
 * Демо-режим.
 *
 * Пока сервер не подтвердил готовность (net.mode === 'unknown'), это НЕ демо:
 * запросы нужно отправлять, иначе текст песни, статус источников и всё
 * остальное отдают заглушки первые секунды после запуска. Демо — только
 * когда сервер точно недоступен.
 */
export const isDemo = () => net.mode === 'demo';

/* ------------------------------------------------------------------ */
/* Низкий уровень                                                      */
/* ------------------------------------------------------------------ */

async function request(path, { method = 'GET', body = null, rawBody = null, timeout = 7000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(path, {
      method,
      headers: body
        ? { 'content-type': 'application/json' }
        : rawBody
          ? { 'content-type': (rawBody.type || 'application/octet-stream') }
          : undefined,
      body: body ? JSON.stringify(body) : rawBody || undefined,
      signal: controller.signal,
      credentials: 'same-origin',
      cache: 'no-store',
    });
    const text = await res.text();
    let data = null;
    if (text) {
      try { data = JSON.parse(text); } catch { data = null; }
    }
    if (!res.ok) {
      const apiError = data && data.error ? data.error : null;
      throw new ApiError(
        apiError?.code || `HTTP_${res.status}`,
        apiError?.message || `Сервер ответил ${res.status}`,
        res.status,
      );
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

function isNetworkError(err) {
  return !(err instanceof ApiError);
}

/* ------------------------------------------------------------------ */
/* Нормализация (сервер обязан отдавать контракт, но UI не должен падать) */
/* ------------------------------------------------------------------ */

export function normalizeTrack(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const source = SOURCES.has(raw.source) ? raw.source : 'yandex';
  const sourceId = raw.sourceId != null
    ? String(raw.sourceId)
    : String(raw.id || '').split(':').slice(1).join(':');
  // без повторов: один и тот же исполнитель приходит из разных полей
  const artists = [...new Set(
    Array.isArray(raw.artists)
      ? raw.artists.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim())
      : (raw.artist ? [String(raw.artist).trim()] : []),
  )];
  const duration = Math.max(0, Math.round(Number(raw.duration) || 0));
  const playable = raw.playable !== false;
  const reason = playable ? null : (
    ['no_preview', 'go_plus', 'geo', 'not_streamable'].includes(raw.reason)
      ? raw.reason
      : 'not_streamable'
  );
  return {
    id: raw.id || `${source}:${sourceId}`,
    source,
    sourceId,
    // идентификатор исполнителя: без него не открыть его страницу
    artistId: raw.artistId != null ? String(raw.artistId) : null,
    // все исполнители трека со своими id — чтобы можно было выбрать любого
    artistList: Array.isArray(raw.artistList)
      ? raw.artistList
        .filter((a) => a && a.id && a.name)
        .map((a) => ({ id: String(a.id), name: String(a.name) }))
      : [],
    title: typeof raw.title === 'string' && raw.title.trim() ? raw.title : 'Без названия',
    artists: artists.length ? artists : ['Неизвестный исполнитель'],
    album: raw.album || null,
    cover: raw.cover || null,
    duration,
    playable,
    reason,
    explicit: raw.explicit === true,
  };
}

function normalizeTrackList(list) {
  if (!Array.isArray(list)) return [];
  return list.map(normalizeTrack).filter(Boolean);
}

function normalizeWave(raw) {
  return {
    station: raw?.station || 'user:onyourwave',
    batchId: raw?.batchId || null,
    items: normalizeTrackList(raw?.items),
  };
}

function normalizeGroups(raw) {
  const groups = Array.isArray(raw?.groups) ? raw.groups : [];
  return {
    groups: groups
      .filter((g) => g && SOURCES.has(g.source))
      .map((g) => ({
        source: g.source,
        items: normalizeTrackList(g.items),
        error: g.error ? String(g.error) : null,
      })),
  };
}

function normalizeHistory(raw) {
  const items = Array.isArray(raw?.items) ? raw.items : [];
  return {
    items: items
      .map((row) => ({
        track: normalizeTrack(row?.track),
        at: row?.at || null,
        playedSeconds: Math.max(0, Math.round(Number(row?.playedSeconds) || 0)),
      }))
      .filter((row) => row.track),
  };
}

export function normalizeStatus(raw) {
  const out = { ok: raw?.ok === true, version: raw?.version || null, demo: raw?.demo === true, sources: {} };
  for (const key of SOURCE_KEYS) {
    const src = raw?.sources?.[key] || {};
    out.sources[key] = {
      connected: src.connected === true,
      user: src.user || null,
      error: src.error ? String(src.error) : null,
    };
  }
  return out;
}

function normalizeSettings(raw) {
  const pick = (v) => (typeof v === 'string' && v ? v : null);
  return {
    yandex: { token: pick(raw?.yandex?.token) },
    soundcloud: { clientId: pick(raw?.soundcloud?.clientId) },
    spotify: {
      clientId: pick(raw?.spotify?.clientId),
      clientSecret: pick(raw?.spotify?.clientSecret),
    },
  };
}

/* ------------------------------------------------------------------ */
/* Проверка живости                                                    */
/* ------------------------------------------------------------------ */

export async function ping(timeout = 6000) {
  if (typeof location !== 'undefined' && location.protocol === 'file:') {
    degrade(new Error('страница открыта как файл'));
    return false;
  }
  try {
    // 1.8 секунды было мало: при первом запуске сервер ещё поднимает
    // провайдеров, ping не успевал и интерфейс переходил в «нет соединения»
    // на всех трёх сервисах. Кнопка «Проверить» потом проходила, потому
    // что сервер к тому моменту уже готов.
    const data = await request('/api/health', { timeout });
    if (data && data.ok) {
      setMode('online', data.version || null);
      return true;
    }
    degrade(new Error('сервер не подтвердил готовность'));
    return false;
  } catch (err) {
    degrade(err);
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* API                                                                 */
/* ------------------------------------------------------------------ */

/** Состояние сети и прокси. */
export async function getNetwork() {
  try {
    return await request('/api/network', { timeout: 8000 });
  } catch {
    return { active: false, error: null };
  }
}

/** Сохранить настройки прокси (применяются сразу). */
export async function saveNetwork({ proxy = '', useSystemProxy = false, autoProxy } = {}) {
  try {
    const data = await request('/api/network', {
      method: 'PUT',
      body: { proxy, useSystemProxy, ...(typeof autoProxy === 'boolean' ? { autoProxy } : {}) },
      timeout: 20000,
    });
    return { ok: true, ...data };
  } catch (err) {
    return { ok: false, error: err?.message || 'Не удалось сохранить прокси' };
  }
}

/**
 * Автоподбор рабочего прокси: сервер перебирает публичные прокси и проверяет
 * реальную загрузку аудио SoundCloud. Найденный применяется сразу.
 */
export async function findProxy() {
  try {
    return await request('/api/network/find', { method: 'POST', body: {}, timeout: 240000 });
  } catch (err) {
    return { ok: false, message: err?.message || 'поиск не удался' };
  }
}

/** Проверить, работает ли автоключ SoundCloud. */
export async function checkSoundcloudKey() {
  try {
    return await request('/api/soundcloud/keycheck', { method: 'POST', body: {}, timeout: 40000 });
  } catch (err) {
    return { ok: false, message: err?.message || 'Сервер не ответил' };
  }
}

/** Страница исполнителя: имя, обложка и его треки. */
export async function getArtist(source, artistId, limit = 50) {
  const params = new URLSearchParams({ limit: String(limit) });
  return request(`/api/artist/${encodeURIComponent(source)}/${encodeURIComponent(artistId)}?${params}`, { timeout: 25000 });
}

/** Клипы к треку: поиск видео на YouTube по названию и исполнителю. */
export async function getClips(title, artist) {
  const params = new URLSearchParams({ title: String(title || ''), artist: String(artist || '') });
  return request(`/api/clips?${params}`, { timeout: 20000 });
}

/** Состояние обхода блокировки SoundCloud (zapret). */
export async function getDpi() {
  try {
    return await request('/api/dpi', { timeout: 20000 });
  } catch (err) {
    return { folders: [], probe: { ok: false, error: err?.message } };
  }
}

/** Дописать домены SoundCloud в списки установленного zapret. */
export async function applyDpi() {
  try {
    return await request('/api/dpi/apply', { method: 'POST', body: {}, timeout: 30000 });
  } catch (err) {
    return { ok: false, message: err?.message || 'не удалось применить' };
  }
}

/** Остановить автоподбор. */
export async function stopFindProxy() {
  try {
    await request('/api/network/stop', { method: 'POST', body: {}, timeout: 8000 });
  } catch { /* остановка не критична */ }
}

/** Проверить соединение с SoundCloud (через прокси, если включён). */
export async function testNetwork() {
  try {
    return await request('/api/network/test', { method: 'POST', body: {}, timeout: 25000 });
  } catch (err) {
    return { error: err?.message || 'проверка не удалась' };
  }
}

export function streamUrl(track) {
  if (!track) return null;
  const source = encodeURIComponent(track.source);
  const id = encodeURIComponent(track.sourceId);
  return `/api/stream/${source}/${id}`;
}

export async function getStatus() {
  if (isDemo()) return normalizeStatus(demoStatus());
  try {
    return normalizeStatus(await request('/api/status'));
  } catch (err) {
    if (isNetworkError(err)) { degrade(err); return normalizeStatus(demoStatus()); }
    throw err;
  }
}

export async function getSettings() {
  if (isDemo()) return normalizeSettings(demoSettings());
  try {
    return normalizeSettings(await request('/api/settings'));
  } catch (err) {
    if (isNetworkError(err)) { degrade(err); return normalizeSettings(demoSettings()); }
    throw err;
  }
}

export async function saveSettings(payload) {
  if (isDemo()) {
    throw new ApiError('OFFLINE', 'Сервер не запущен — настройки некуда сохранить. Запустите node server/index.mjs и обновите страницу.');
  }
  try {
    const data = await request('/api/settings', { method: 'PUT', body: payload, timeout: 12000 });
    if (data?.sources) return { ok: data.ok !== false, sources: normalizeStatus({ sources: data.sources }).sources };
    return { ok: data?.ok !== false, sources: null };
  } catch (err) {
    if (isNetworkError(err)) degrade(err);
    throw err;
  }
}

export async function search(query, sources = [], limit = 20) {
  const q = String(query || '').trim();
  const sourceParam = (sources && sources.length ? sources : SOURCE_KEYS).join(',');
  if (isDemo()) return normalizeGroups(demoSearch(q, sources, limit));
  try {
    const params = new URLSearchParams({ q, sources: sourceParam, limit: String(limit) });
    // поиск опрашивает три сервиса разом: стандартных 7 секунд мало,
    // из-за этого «быстрый» первый ответ обрывался и уходил в демо-режим
    return normalizeGroups(await request(`/api/search?${params.toString()}`, { timeout: 20000 }));
  } catch (err) {
    if (isNetworkError(err)) { degrade(err); return normalizeGroups(demoSearch(q, sources, limit)); }
    throw err;
  }
}

/**
 * Разбор ссылки на трек (Spotify / Яндекс.Музыка / SoundCloud).
 * Работает и без токенов: Spotify и SoundCloud отдают публичные метаданные.
 */
export async function linkLookup(url) {
  const value = String(url || '').trim();
  if (!value) throw new ApiError('BAD_REQUEST', 'Нужна ссылка на трек');
  if (isDemo()) {
    throw new ApiError('OFFLINE', 'В демо-режиме импорт по ссылке недоступен — нужен запущенный сервер');
  }
  return await request(`/api/link?url=${encodeURIComponent(value)}`, { timeout: 20000 });
}

/**
 * Проверка наличия новой версии (публичные релизы GitHub, без токенов).
 * Возвращает { current, latest, updateAvailable }.
 */
export async function getUpdate() {
  if (isDemo()) return { current: null, latest: null, updateAvailable: false };
  try {
    return await request('/api/update', { timeout: 12000 });
  } catch (err) {
    if (isNetworkError(err)) degrade(err);
    return { current: null, latest: null, updateAvailable: false };
  }
}

/* ------------------------------------------------------------------ */
/* Своя музыка (локальные файлы)                                        */
/* ------------------------------------------------------------------ */

export async function getLocalTracks() {
  if (isDemo()) return [];
  const data = await request('/api/local', { timeout: 15000 });
  return Array.isArray(data?.items) ? data.items.map(normalizeTrack).filter(Boolean) : [];
}

/** Импорт по путям (десктоп: из диалога или перетаскиванием). */
export async function importLocalPaths(paths) {
  const list = (Array.isArray(paths) ? paths : [paths]).filter(Boolean);
  if (!list.length) return { ok: false, added: 0, skipped: 0 };
  return await request('/api/local/import', { method: 'POST', body: { paths: list }, timeout: 180000 });
}

/** Загрузка файла из браузера (когда пути к файлу нет). */
export async function uploadLocalFile(file) {
  const name = encodeURIComponent(file.name || 'track.mp3');
  return await request(`/api/local/upload?name=${name}`, { method: 'PUT', rawBody: file, timeout: 300000 });
}

export async function removeLocalTrack(sourceId) {
  return await request(`/api/local/${encodeURIComponent(sourceId)}`, { method: 'DELETE' });
}

/**
 * Избранное (лайки) по источникам: какие сервисы переданы, те и опрашиваются.
 * Сервис без права доступа к аккаунту вернёт группу с ошибкой — это нормально.
 */
export async function getLikes(sources = ['yandex'], limit = 100) {
  const list = (Array.isArray(sources) ? sources : []).filter((s) => SOURCES.has(s));
  if (!list.length || isDemo()) return [];
  try {
    const params = new URLSearchParams({ sources: list.join(','), limit: String(limit) });
    return normalizeGroups(await request(`/api/likes?${params.toString()}`, { timeout: 25000 }));
  } catch (err) {
    if (isNetworkError(err)) degrade(err);
    throw err;
  }
}

/** Плейлисты сервиса: свои и (по ссылке на профиль) чужие. */
export async function getPlaylists(source, owner = '') {
  if (isDemo()) return { items: [], error: 'NOT_SUPPORTED' };
  const query = owner ? `?owner=${encodeURIComponent(owner)}` : '';
  try {
    return await request(`/api/playlists/${encodeURIComponent(source)}${query}`, { timeout: 30000 });
  } catch (err) {
    if (isNetworkError(err)) degrade(err);
    return { items: [], error: err?.code || 'ERROR', message: err?.message };
  }
}

/** Треки одного плейлиста. */
export async function getPlaylistTracks(source, playlistId) {
  if (isDemo()) return { items: [] };
  try {
    return await request(
      `/api/playlists/${encodeURIComponent(source)}/${encodeURIComponent(playlistId)}`,
      { timeout: 40000 },
    );
  } catch (err) {
    if (isNetworkError(err)) degrade(err);
    return { items: [], error: err?.code || 'ERROR', message: err?.message };
  }
}

/**
 * Текст песни с таймингами (LRC) — ищется на сервере по названию и исполнителю.
 *
 * Один повтор: источники текстов периодически отвечают медленно, и
 * единственный сбой превращался в «Текст не найден» до конца сессии.
 */
export async function getLyrics(source, sourceId) {
  if (isDemo()) return { available: false, synced: [], plain: '' };

  const url = `/api/lyrics/${encodeURIComponent(source)}/${encodeURIComponent(sourceId)}`;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const data = await request(url, { timeout: 30000 });
      // пустой ответ сервера — тоже повод повторить, кроме явного «нет текста»
      if (data?.available || data?.instrumental) return data;
      if (attempt === 2) return data;
    } catch (err) {
      if (isNetworkError(err)) degrade(err);
      if (attempt === 2) return { available: false, synced: [], plain: '', reason: err?.code || 'ERROR' };
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  return { available: false, synced: [], plain: '' };
}

/** Категории станций: жанры, настроения, занятия (данные ротора Яндекса). */
export async function getWaveStations() {
  if (isDemo()) return { categories: [] };
  try {
    return await request('/api/wave/stations', { timeout: 30000 });
  } catch (err) {
    if (isNetworkError(err)) degrade(err);
    return { categories: [] };
  }
}

export async function getWave(limit = 20, station = 'user:onyourwave', sources = null, { quick = false } = {}) {
  const list = Array.isArray(sources) && sources.length ? sources : null;
  if (isDemo()) return normalizeWave(demoWave(limit, list));
  try {
    const params = new URLSearchParams({ limit: String(limit), station });
    if (list) params.set('sources', list.join(','));
    // быстрый режим: сервер отдаёт уже собранную ленту, не дожидаясь ротора
    if (quick) params.set('quick', '1');
    // волна собирается на сервере до 12 секунд: даём запас, иначе таймаут
    // засчитывался как «сервер недоступен» и интерфейс уходил в демо-режим
    return normalizeWave(await request(`/api/wave?${params.toString()}`, { timeout: quick ? 8000 : 40000 }));
  } catch (err) {
    if (isNetworkError(err)) { degrade(err); return normalizeWave(demoWave(limit, list)); }
    throw err;
  }
}

export async function waveFeedback({ type, trackId, batchId, position = 0 }) {
  const payload = { type, trackId, batchId, position };
  if (isDemo()) return { ok: true };
  try {
    return await request('/api/wave/feedback', { method: 'POST', body: payload, timeout: 6000 });
  } catch (err) {
    if (isNetworkError(err)) degrade(err);
    return { ok: false };
  }
}

export async function getHistory(limit = 50) {
  if (isDemo()) return normalizeHistory(demoHistory(limit));
  try {
    return normalizeHistory(await request(`/api/history?limit=${limit}`));
  } catch (err) {
    if (isNetworkError(err)) { degrade(err); return normalizeHistory(demoHistory(limit)); }
    throw err;
  }
}

export async function postHistory(track, playedSeconds = 0) {
  if (isDemo() || !track) return { ok: true };
  try {
    return await request('/api/history', {
      method: 'POST',
      body: { track, playedSeconds: Math.round(playedSeconds) },
      timeout: 6000,
    });
  } catch (err) {
    if (isNetworkError(err)) degrade(err);
    return { ok: false };
  }
}

export async function getTrack(source, sourceId) {
  if (!isDemo()) {
    try {
      return normalizeTrack(await request(`/api/track/${encodeURIComponent(source)}/${encodeURIComponent(sourceId)}`));
    } catch (err) {
      if (!isNetworkError(err) && err.status !== 404) throw err;
      if (isNetworkError(err)) degrade(err);
    }
  }
  return normalizeTrack(DEMO_TRACKS.find((x) => x.source === source && x.sourceId === String(sourceId)) || null);
}

/** Запасной список треков — нужен поиску в демо-режиме и пустым состояниям. */
export { DEMO_TRACKS };
