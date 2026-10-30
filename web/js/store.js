/* =========================================================================
   labsoul — состояние приложения: маршрут, лента, поиск, история, лайки.
   Мини-хранилище с подписками; никаких зависимостей.
   ========================================================================= */

import {
  getHistory,
  getSettings,
  getStatus,
  getWave,
  net,
  onNetChange,
  saveSettings,
  search,
} from './api.js';
import { readJSON, writeJSON } from './utils.js';

export const ROUTES = ['wave', 'search', 'library', 'sources', 'design'];
export const ROUTE_TITLES = {
  wave: 'Волна',
  search: 'Поиск',
  library: 'Библиотека',
  sources: 'Подключения',
  design: 'Оформление',
};
export const SOURCES = ['yandex', 'soundcloud', 'spotify'];
const LIKES_KEY = 'player-likes';

// Источники «Волны»: объявлены до app, потому что инициализация состояния
// читает сохранённый выбор (иначе const попадёт в temporal dead zone).
const WAVE_SOURCES_KEY = 'player-wave-sources';
export const WAVE_SOURCE_KEYS = ['yandex', 'soundcloud', 'spotify'];
const DEFAULT_WAVE_SOURCES = ['yandex', 'soundcloud'];

function readWaveSources() {
  try {
    const raw = JSON.parse(localStorage.getItem(WAVE_SOURCES_KEY) || 'null');
    if (Array.isArray(raw)) {
      const list = raw.filter((s) => WAVE_SOURCE_KEYS.includes(s));
      if (list.length) return list;
    }
  } catch { /* localStorage может быть недоступен */ }
  return [...DEFAULT_WAVE_SOURCES];
}

export const app = {
  route: 'wave',
  ready: false,
  status: null,
  settings: null,
  statusLoading: false,
  likes: [],
  wave: {
    items: [],
    station: 'user:onyourwave',
    // из каких источников собирать ленту; выбор пользователя переживает перезапуск
    sources: readWaveSources(),
    batchId: null,
    loading: false,
    error: null,
    done: false,
    batches: 0,
  },
  search: {
    query: '',
    sources: [...SOURCES],
    groups: [],
    loading: false,
    error: null,
    ran: false,
    updatedAt: 0,
  },
  history: {
    items: [],
    loading: false,
    error: null,
  },
  ui: {
    queueOpen: false,
    likesLoaded: false,
  },
};

const listeners = new Set();
const trackIndex = new Map();
const trackBatch = new Map();

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function emit(event = 'change') {
  for (const fn of listeners) {
    try { fn(app, event); } catch (err) { console.warn('[labsoul] store listener', err); }
  }
}

function safeTracks(list) {
  return (Array.isArray(list) ? list : []).filter((t) => t && t.id && t.title);
}

/* ------------------------------------------------------------------ */
/* Реестр треков — действия по data-id без повторных запросов           */
/* ------------------------------------------------------------------ */

export function rememberTracks(tracks) {
  for (const track of safeTracks(tracks)) {
    trackIndex.set(track.id, track);
  }
}

export function trackById(id) {
  return trackIndex.get(id) || app.likes.find((t) => t.id === id) || null;
}

export function batchOf(trackId) {
  return trackBatch.get(trackId) || app.wave.batchId;
}

/* ------------------------------------------------------------------ */
/* Маршрутизация                                                        */
/* ------------------------------------------------------------------ */

export function go(route) {
  const next = ROUTES.includes(route) ? route : 'wave';
  if (location.hash !== `#${next}`) {
    location.hash = next; // hashchange обработает main.js
  } else {
    setRoute(next);
  }
}

export function setRoute(route) {
  const next = ROUTES.includes(route) ? route : 'wave';
  if (app.route === next) return;
  app.route = next;
  emit('route');
}

/* ------------------------------------------------------------------ */
/* Лайки (локальные, переживают перезапуск)                             */
/* ------------------------------------------------------------------ */

function loadLikes() {
  const raw = readJSON(LIKES_KEY, []);
  app.likes = safeTracks(raw);
  rememberTracks(app.likes);
  app.ui.likesLoaded = true;
}

function persistLikes() {
  writeJSON(LIKES_KEY, app.likes);
}

export function isLiked(id) {
  return app.likes.some((track) => track.id === id);
}

/** @returns {boolean} новое состояние «нравится» */
export function toggleLike(track) {
  if (!track) return false;
  rememberTracks([track]);
  const exists = app.likes.some((item) => item.id === track.id);
  if (exists) {
    app.likes = app.likes.filter((item) => item.id !== track.id);
  } else {
    app.likes = [track, ...app.likes];
  }
  persistLikes();
  emit('likes');
  return !exists;
}

export function removeLike(id) {
  const before = app.likes.length;
  app.likes = app.likes.filter((track) => track.id !== id);
  if (app.likes.length !== before) {
    persistLikes();
    emit('likes');
  }
}

/* ------------------------------------------------------------------ */
/* Статус источников и настройки                                        */
/* ------------------------------------------------------------------ */

export async function refreshStatus() {
  app.statusLoading = true;
  emit('status');
  try {
    app.status = await getStatus();
  } catch (err) {
    app.status = {
      ok: false,
      version: null,
      demo: true,
      sources: {
        yandex: { connected: false, error: err?.message || 'ошибка' },
        soundcloud: { connected: false, error: err?.message || 'ошибка' },
        spotify: { connected: false, error: err?.message || 'ошибка' },
      },
    };
  } finally {
    app.statusLoading = false;
    emit('status');
  }
  return app.status;
}

export async function loadSettings() {
  try {
    app.settings = await getSettings();
  } catch (err) {
    app.settings = null;
    emit('settings');
    throw err;
  }
  emit('settings');
  return app.settings;
}

export async function commitSettings(payload) {
  const result = await saveSettings(payload);
  if (result?.sources) {
    app.status = { ...(app.status || {}), sources: result.sources, ok: true };
    emit('status');
  }
  try { app.settings = await getSettings(); } catch { /* маска могла не обновиться */ }
  emit('settings');
  return result;
}

/* ------------------------------------------------------------------ */
/* Волна                                                                */
/* ------------------------------------------------------------------ */

export async function loadWaveMore({ force = false } = {}) {
  if (app.wave.loading) return;
  if (app.wave.done && !force) return;
  app.wave.loading = true;
  app.wave.error = null;
  emit('wave');
  try {
    const batch = await getWave(20, app.wave.station, app.wave.sources);
    if (batch.station) app.wave.station = batch.station;
    if (batch.batchId) app.wave.batchId = batch.batchId;
    const items = safeTracks(batch.items);
    if (!items.length) {
      app.wave.done = true;
    } else {
      stateAppendWave(items, batch.batchId);
    }
    rememberTracks(items);
    app.wave.batches += 1;
  } catch (err) {
    app.wave.error = err?.message || 'Не удалось получить волну';
  } finally {
    app.wave.loading = false;
    emit('wave');
  }
}

function stateAppendWave(items, batchId) {
  const existing = new Set(app.wave.items.map((t) => t.id));
  for (const track of items) {
    trackBatch.set(track.id, batchId);
    if (existing.has(track.id)) {
      // повтор в бесконечном потоке допустим, но не подряд
      const last = app.wave.items[app.wave.items.length - 1];
      if (last && last.id === track.id) continue;
    }
    app.wave.items.push(track);
    existing.add(track.id);
  }
}

export function resetWave() {
  app.wave.items = [];
  app.wave.done = false;
  app.wave.batchId = null;
  app.wave.batches = 0;
  emit('wave');
}

/** Выбор источников «Волны»: сразу сохраняем, пересобираем ленту и оповещаем экран. */
export function setWaveSources(sources) {
  const list = (Array.isArray(sources) ? sources : []).filter((s) => WAVE_SOURCE_KEYS.includes(s));
  const next = list.length ? list : [...DEFAULT_WAVE_SOURCES];
  app.wave.sources = next;
  try { localStorage.setItem(WAVE_SOURCES_KEY, JSON.stringify(next)); } catch { /* приватный режим */ }
  resetWave();
  emit('wave-sources');
  loadWaveMore({ force: true });
  return next;
}

export function toggleWaveSource(sourceKey) {
  if (!WAVE_SOURCE_KEYS.includes(sourceKey)) return app.wave.sources;
  const current = app.wave.sources.slice();
  const index = current.indexOf(sourceKey);
  if (index >= 0) {
    // последний источник выключать нельзя — иначе лента станет пустой
    if (current.length === 1) return current;
    current.splice(index, 1);
  } else {
    current.push(sourceKey);
  }
  return setWaveSources(current);
}

/* ------------------------------------------------------------------ */
/* Поиск                                                                */
/* ------------------------------------------------------------------ */

export function setSearchQuery(query) {
  app.search.query = String(query || '');
  emit('search-query');
}

export function toggleSearchSource(sourceKey) {
  if (!SOURCES.includes(sourceKey)) return;
  const has = app.search.sources.includes(sourceKey);
  app.search.sources = has
    ? app.search.sources.filter((s) => s !== sourceKey)
    : [...app.search.sources, sourceKey];
  if (!app.search.sources.length) app.search.sources = [...SOURCES];
  emit('search-sources');
}

export function setSearchSources(list) {
  const next = (Array.isArray(list) ? list : []).filter((s) => SOURCES.includes(s));
  app.search.sources = next.length ? next : [...SOURCES];
  emit('search-sources');
}

export async function runSearch(query = app.search.query) {
  const q = String(query || '').trim();
  app.search.query = q;
  app.search.loading = true;
  app.search.error = null;
  app.search.ran = true;
  emit('search');
  const stamp = Date.now();
  try {
    const data = await search(q, app.search.sources, 20);
    if (stamp < app.search.updatedAt) return; // устаревший ответ
    app.search.updatedAt = stamp;
    app.search.groups = data.groups;
    for (const group of data.groups) rememberTracks(group.items);
  } catch (err) {
    app.search.groups = [];
    app.search.error = err?.message || 'Поиск не удался';
  } finally {
    app.search.loading = false;
    emit('search');
  }
}

/* ------------------------------------------------------------------ */
/* История                                                              */
/* ------------------------------------------------------------------ */

export async function loadHistory() {
  app.history.loading = true;
  app.history.error = null;
  emit('history');
  try {
    const data = await getHistory(60);
    app.history.items = data.items;
    rememberTracks(data.items.map((row) => row.track));
  } catch (err) {
    app.history.items = [];
    app.history.error = err?.message || 'История недоступна';
  } finally {
    app.history.loading = false;
    emit('history');
  }
}

/* ------------------------------------------------------------------ */
/* Очередь                                                              */
/* ------------------------------------------------------------------ */

export function setQueueOpen(open) {
  app.ui.queueOpen = !!open;
  emit('queue-ui');
}

/* ------------------------------------------------------------------ */
/* Инициализация                                                        */
/* ------------------------------------------------------------------ */

export function initStore() {
  loadLikes();
  onNetChange(() => {
    emit('net');
  });
  if (net.mode === 'online') {
    refreshStatus().catch(() => {});
  }
  app.ready = true;
  emit('init');
  return app;
}

/** Быстрый счётчик по источникам для подписи поиска. */
export function searchSourceCounts() {
  const counts = { yandex: 0, soundcloud: 0, spotify: 0 };
  for (const group of app.search.groups) {
    counts[group.source] = group.items.length;
  }
  return counts;
}
