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
  setMode('demo', net.version, err?.message || 'сервер не отвечает');
}

export const isOnline = () => net.mode === 'online';
export const isDemo = () => net.mode !== 'online';

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
  const artists = Array.isArray(raw.artists)
    ? raw.artists.filter((x) => typeof x === 'string' && x.trim())
    : (raw.artist ? [String(raw.artist)] : []);
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

export async function ping(timeout = 1800) {
  if (typeof location !== 'undefined' && location.protocol === 'file:') {
    degrade(new Error('страница открыта как файл'));
    return false;
  }
  try {
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

export async function search(query, sources = [], limit = 20) {  const q = String(query || '').trim();
  const sourceParam = (sources && sources.length ? sources : SOURCE_KEYS).join(',');
  if (isDemo()) return normalizeGroups(demoSearch(q, sources, limit));
  try {
    const params = new URLSearchParams({ q, sources: sourceParam, limit: String(limit) });
    return normalizeGroups(await request(`/api/search?${params.toString()}`));
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

/** Текст песни с таймингами (LRC) — ищется на сервере по названию и исполнителю. */
export async function getLyrics(source, sourceId) {
  if (isDemo()) return { available: false, synced: [], plain: '' };
  try {
    return await request(`/api/lyrics/${encodeURIComponent(source)}/${encodeURIComponent(sourceId)}`, { timeout: 30000 });
  } catch (err) {
    if (isNetworkError(err)) degrade(err);
    return { available: false, synced: [], plain: '', reason: err?.code || 'ERROR' };
  }
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

export async function getWave(limit = 20, station = 'user:onyourwave', sources = null) {
  const list = Array.isArray(sources) && sources.length ? sources : null;
  if (isDemo()) return normalizeWave(demoWave(limit, list));
  try {
    const params = new URLSearchParams({ limit: String(limit), station });
    if (list) params.set('sources', list.join(','));
    return normalizeWave(await request(`/api/wave?${params.toString()}`, { timeout: 12000 }));
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
