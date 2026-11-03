/* =========================================================================
   labsoul — состояние приложения: маршрут, лента, поиск, история, лайки.
   Мини-хранилище с подписками; никаких зависимостей.
   ========================================================================= */

import {
  getHistory,
  getLikes,
  getLocalTracks,
  getPlaylistTracks,
  getPlaylists,
  getSettings,
  getStatus,
  getWave,
  getWaveStations,
  importLocalPaths,
  net,
  onNetChange,
  removeLocalTrack,
  saveSettings,
  search,
  uploadLocalFile,
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

// Источники для «Избранного» в библиотеке: локальные лайки + сервисы,
// которые умеют отдавать лайки аккаунта. Выключаются так же, как в Волне.
const LIBRARY_SOURCES_KEY = 'player-library-sources';
export const LIBRARY_SOURCE_KEYS = ['local', 'yandex', 'soundcloud', 'spotify'];
const DEFAULT_LIBRARY_SOURCES = ['local', 'yandex'];

function readLibrarySources() {
  try {
    const raw = JSON.parse(localStorage.getItem(LIBRARY_SOURCES_KEY) || 'null');
    if (Array.isArray(raw)) {
      const list = raw.filter((s) => LIBRARY_SOURCE_KEYS.includes(s));
      if (list.length) return list;
    }
  } catch { /* localStorage может быть недоступен */ }
  return [...DEFAULT_LIBRARY_SOURCES];
}

export const app = {
  route: 'wave',
  ready: false,
  status: null,
  settings: null,
  statusLoading: false,
  likes: [],
  // своя музыка с диска
  local: {
    items: [],
    loading: false,
    importing: false,
    error: null,
    loadedAt: 0,
  },
  library: {
    historySource: 'all',
    // какие сервисы показывать в «Избранном»
    sources: readLibrarySources(),
    // ответы серверных источников: [{source, items, error?, message?}]
    remote: [],
    loading: false,
    error: null,
    loadedAt: 0,
  },
  wave: {
    items: [],
    station: 'user:onyourwave',
    stations: [],
    stationsLoading: false,
    category: 'personal',
    stationsError: null,
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

  // Сервер при первом запуске ещё поднимает источники — статус мог прийти
  // с сетевыми ошибками. Молча повторяем пару раз, вместо того чтобы
  // требовать от пользователя нажимать «Проверить связь».
  const sources = app.status?.sources || {};
  const shaky = Object.values(sources).some((s) => s && !s.connected && (s.error === 'UPSTREAM' || s.error === 'TIMEOUT'));
  if (shaky && (refreshStatus.tries = (refreshStatus.tries || 0) + 1) <= 2) {
    setTimeout(() => { refreshStatus().catch(() => {}); }, 1500);
  } else if (!shaky) {
    refreshStatus.tries = 0;
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

export async function loadWaveMore({ force = false, quick = false } = {}) {
  if (app.wave.loading) return;
  if (app.wave.done && !force) return;

  // Быстрый режим не показывает скелетоны: если лента уже есть, экран
  // рисуется сразу, а свежая партия догружается незаметно в фоне.
  // Раньше здесь выставлялся loading=true, интерфейс снова показывал
  // скелетоны и полная загрузка выглядела как «10 секунд ожидания».
  const silent = quick && app.wave.items.length > 0;

  if (!silent) {
    app.wave.loading = true;
    app.wave.error = null;
    emit('wave');
  }

  try {
    const batch = await getWave(20, app.wave.station, app.wave.sources, { quick });
    if (batch.station) app.wave.station = batch.station;
    if (batch.batchId) app.wave.batchId = batch.batchId;
    const items = safeTracks(batch.items);
    // запоминаем готовую ленту: при возврате к этому источнику покажем сразу
    if (items.length) waveCacheSet(app.wave.items.length ? app.wave.items : items);
    // быстрый режим: отдали готовую ленту — следом просим свежую партию
    if (quick && items.length) {
      setTimeout(() => loadWaveMore({ force: true, quick: true }), 300);
    }
    // сервер ещё собирает партию (warming) — повторим чуть позже, ленту не закрываем
    if (!items.length && batch.warming) {
      setTimeout(() => loadWaveMore(), 900);
      return;
    }
    if (!items.length) {
      // новых треков нет: пробуем позже, но ленту не закрываем навсегда
      setTimeout(() => {
        if (app.route === 'wave') { app.wave.done = false; loadWaveMore(); }
      }, 20000);
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

/**
 * Готовые ленты по набору источников.
 *
 * Переключение источника раньше ждало полный ответ сервера, а он собирает
 * партию заново — это и выглядело как «долгая загрузка». Держим последние
 * готовые ленты в памяти и показываем их сразу, обновляя в фоне.
 */
const waveCache = new Map();
const WAVE_CACHE_LIMIT = 8;

function waveCacheKey() {
  return `${app.wave.station}|${app.wave.sources.slice().sort().join(',')}`;
}

function waveCacheGet() {
  const hit = waveCache.get(waveCacheKey());
  if (!hit) return null;
  // старше двух минут — показываем, но сразу обновляем
  return { items: hit.items, stale: Date.now() - hit.at > 120_000 };
}

function waveCacheSet(items) {
  if (!Array.isArray(items) || !items.length) return;
  waveCache.set(waveCacheKey(), { items: items.slice(), at: Date.now() });
  // держим кэш маленьким: удаляем самые старые записи
  if (waveCache.size > WAVE_CACHE_LIMIT) {
    const oldest = [...waveCache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) waveCache.delete(oldest[0]);
  }
}

export function resetWave() {
  app.wave.items = [];
  app.wave.done = false;
  app.wave.batchId = null;
  app.wave.batches = 0;
  emit('wave');
}

/**
 * Выбор источников «Волны».
 *
 * Лента из кэша показывается мгновенно, а свежая партия подгружается в фоне —
 * переключение сервисов больше не висит в ожидании сервера.
 */
export function setWaveSources(sources) {
  const list = (Array.isArray(sources) ? sources : []).filter((s) => WAVE_SOURCE_KEYS.includes(s));
  const next = list.length ? list : [...DEFAULT_WAVE_SOURCES];
  app.wave.sources = next;
  try { localStorage.setItem(WAVE_SOURCES_KEY, JSON.stringify(next)); } catch { /* приватный режим */ }

  const cached = waveCacheGet();
  if (cached) {
    // кэш есть — показываем его сразу, без скелетонов
    app.wave.items = cached.items.slice();
    app.wave.done = false;
    app.wave.batchId = null;
    app.wave.batches = 0;
    emit('wave');
    emit('wave-sources');
    loadWaveMore({ force: true, quick: true });
    return next;
  }

  resetWave();
  emit('wave-sources');
  loadWaveMore({ force: true });
  return next;
}

/** Категории станций и выбор станции «Моей волны». */
export async function loadWaveStations({ force = false } = {}) {
  if (app.wave.stationsLoading) return;
  if (!force && app.wave.stations.length) return;
  app.wave.stationsLoading = true;
  app.wave.stationsError = null;
  emit('wave-stations');
  try {
    const data = await getWaveStations();
    app.wave.stations = Array.isArray(data?.categories) ? data.categories : [];
    if (!app.wave.stations.some((c) => c.type === app.wave.category)) {
      app.wave.category = app.wave.stations[0]?.type || 'personal';
    }
  } catch (err) {
    app.wave.stationsError = err?.message || 'Не удалось загрузить категории';
  } finally {
    app.wave.stationsLoading = false;
    emit('wave-stations');
  }
}

export function setWaveCategory(type) {
  const next = String(type || 'personal');
  if (next === app.wave.category) return app.wave.category;
  app.wave.category = next;
  emit('wave-stations');
  return next;
}

export function setWaveStation(stationId) {
  const next = String(stationId || 'user:onyourwave');
  if (next === app.wave.station) return app.wave.station;
  app.wave.station = next;
  resetWave();
  emit('wave');
  loadWaveMore({ force: true });
  return next;
}

export function toggleWaveSource(sourceKey) {  if (!WAVE_SOURCE_KEYS.includes(sourceKey)) return app.wave.sources;
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
/* Библиотека: избранное по источникам                                  */
/* ------------------------------------------------------------------ */

/** Подтягивает лайки из выбранных сервисов (локальные лайки уже в app.likes). */
export async function loadLibraryLikes({ force = false } = {}) {
  const remote = app.library.sources.filter((source) => source !== 'local');
  if (!remote.length) {
    app.library.remote = [];
    app.library.error = null;
    emit('library');
    return;
  }
  if (app.library.loading) return;
  // Пока не известно, жив ли сервер, запрос бессмысленен: демо-режим закэшировал бы
  // пустой ответ на минуту. Дождёмся события 'net' — экран перезапросит сам.
  if (net.mode !== 'online') return;
  if (!force && app.library.loadedAt && Date.now() - app.library.loadedAt < 60_000) return;

  app.library.loading = true;
  app.library.error = null;
  emit('library');
  try {
    // getLikes возвращает {groups:[...]} — в состоянии храним именно массив групп
    const result = await getLikes(remote, 150);
    app.library.remote = Array.isArray(result?.groups) ? result.groups : [];
    // Регистрируем треки в реестре: без этого кнопка play на строке избранного
    // молча ничего не делает — trackById() не находит трек по data-id.
    for (const group of app.library.remote) {
      rememberTracks(group?.items);
    }
    app.library.loadedAt = Date.now();
  } catch (err) {
    app.library.remote = [];
    app.library.error = err?.message || 'Не удалось загрузить избранное';
  } finally {
    app.library.loading = false;
    emit('library');
  }
}

/** Включает/выключает сервис в «Избранном». Последний выключить нельзя. */
/** Источник для вкладки «История»: all | local | yandex | soundcloud | spotify. */
export function setHistorySource(sourceKey) {
  const allowed = ['all', 'local', 'yandex', 'soundcloud', 'spotify'];
  const next = allowed.includes(sourceKey) ? sourceKey : 'all';
  if (app.library.historySource === next) return next;
  app.library.historySource = next;
  emit('history');
  return next;
}

export function toggleLibrarySource(sourceKey) {
  if (!LIBRARY_SOURCE_KEYS.includes(sourceKey)) return app.library.sources;
  const current = app.library.sources.slice();
  const index = current.indexOf(sourceKey);
  if (index >= 0) {
    if (current.length === 1) return current;
    current.splice(index, 1);
  } else {
    current.push(sourceKey);
  }
  app.library.sources = current;
  try { localStorage.setItem(LIBRARY_SOURCES_KEY, JSON.stringify(current)); } catch { /* приватный режим */ }
  emit('library');
  loadLibraryLikes({ force: true });
  return current;
}

/**
 * Объединённый список избранного: локальные лайки + лайки из включённых сервисов.
 * Дубликаты по id отбрасываются, локальные идут первыми (ими управляет сам пользователь).
 */
export function libraryTracks() {
  const includeLocal = app.library.sources.includes('local');
  const merged = includeLocal ? app.likes.slice() : [];
  const seen = new Set(merged.map((track) => track.id));
  for (const group of app.library.remote) {
    if (!app.library.sources.includes(group.source)) continue;
    for (const track of group.items || []) {
      if (!track || !track.id || seen.has(track.id)) continue;
      seen.add(track.id);
      merged.push(track);
    }
  }
  return merged;
}


/* ------------------------------------------------------------------ */
/* Своя музыка                                                          */
/* ------------------------------------------------------------------ */

export async function loadLocalTracks({ force = false } = {}) {
  if (app.local.loading) return;
  if (!force && app.local.loadedAt && Date.now() - app.local.loadedAt < 15_000) return;
  app.local.loading = true;
  app.local.error = null;
  emit('local');
  try {
    app.local.items = await getLocalTracks();
    // локальные треки тоже должны быть в реестре для кнопки play
    rememberTracks(app.local.items);
    app.local.loadedAt = Date.now();
  } catch (err) {
    app.local.error = err?.message || 'Не удалось прочитать локальную библиотеку';
  } finally {
    app.local.loading = false;
    emit('local');
  }
}

/** Добавить файлы/папки по путям (десктоп: диалог или перетаскивание). */
export async function addLocalPaths(paths) {
  const list = (Array.isArray(paths) ? paths : [paths]).filter((p) => typeof p === 'string' && p.trim());
  if (!list.length) return { ok: false, added: 0, skipped: 0 };
  app.local.importing = true;
  emit('local');
  try {
    const result = await importLocalPaths(list);
    await loadLocalTracks({ force: true });
    return result;
  } finally {
    app.local.importing = false;
    emit('local');
  }
}

/** Добавить файлы, выбранные в браузере (путей нет — заливаем содержимое). */
export async function addLocalFiles(files) {
  const list = Array.from(files || []).filter(Boolean);
  if (!list.length) return { ok: false, added: 0 };
  app.local.importing = true;
  emit('local');
  let added = 0;
  const errors = [];
  try {
    for (const file of list) {
      try {
        await uploadLocalFile(file);
        added += 1;
      } catch (err) {
        errors.push(file.name + ': ' + (err?.message || 'ошибка'));
      }
    }
    await loadLocalTracks({ force: true });
    return { ok: true, added, errors };
  } finally {
    app.local.importing = false;
    emit('local');
  }
}

export async function deleteLocalTrack(sourceId) {
  try {
    await removeLocalTrack(sourceId);
    app.local.items = app.local.items.filter((track) => track.sourceId !== String(sourceId) && track.id !== String(sourceId));
    emit('local');
    return true;
  } catch (err) {
    app.local.error = err?.message || 'Не удалось удалить трек';
    emit('local');
    return false;
  }
}

/** Ошибки серверных источников — для честных подсказок в интерфейсе. */
/* ------------------------------------------------------------------ */
/* Плейлисты                                                            */
/* ------------------------------------------------------------------ */

/** Загрузить плейлисты выбранного сервиса. */
export async function loadPlaylists(source = app.playlists.source) {
  app.playlists.source = source;
  app.playlists.loading = true;
  app.playlists.error = null;
  app.playlists.message = null;
  emit('playlists');
  try {
    const data = await getPlaylists(source);
    app.playlists.items = Array.isArray(data?.items) ? data.items : [];
    app.playlists.error = data?.error || null;
    app.playlists.message = data?.message || null;
  } catch (err) {
    app.playlists.items = [];
    app.playlists.error = err?.code || 'ERROR';
    app.playlists.message = err?.message || 'Не удалось загрузить плейлисты';
  } finally {
    app.playlists.loading = false;
    emit('playlists');
  }
}

/** Сменить сервис плейлистов. */
export function setPlaylistSource(source) {
  if (app.playlists.source === source) return;
  app.playlists.openId = null;
  app.playlists.tracks = [];
  loadPlaylists(source);
}

/** Открыть плейлист: подгружает треки. */
export async function openPlaylist(playlistId) {
  app.playlists.openId = playlistId;
  app.playlists.tracks = [];
  app.playlists.tracksLoading = true;
  emit('playlists');
  try {
    const data = await getPlaylistTracks(app.playlists.source, playlistId);
    app.playlists.tracks = safeTracks(data?.items);
    // регистрируем в реестре: иначе play на строке плейлиста не сработает
    rememberTracks(app.playlists.tracks);
    app.playlists.error = data?.error || null;
  } catch (err) {
    app.playlists.tracks = [];
    app.playlists.error = err?.code || 'ERROR';
  } finally {
    app.playlists.tracksLoading = false;
    emit('playlists');
  }
}

/** Вернуться к списку плейлистов. */
export function closePlaylist() {
  app.playlists.openId = null;
  app.playlists.tracks = [];
  emit('playlists');
}

export function libraryErrors() {
  return app.library.remote
    .filter((group) => group.error)
    .map((group) => ({ source: group.source, error: group.error, message: group.message }));
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
    app.history.items = Array.isArray(data?.items) ? data.items : [];
    rememberTracks(app.history.items.map((row) => row?.track).filter(Boolean));
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
  onNetChange((state) => {
    emit('net');
    // Сервер поднялся позже интерфейса — догоняем статус, не дожидаясь
    // нажатия «Проверить связь».
    if (state?.mode === 'online' && !app.status?.sources) {
      refreshStatus().catch(() => {});
    }
  });

  // Статус запрашиваем всегда: даже если ping ещё не ответил, сервер может
  // быть уже готов. Пустой результат не кэшируется на сервере.
  refreshStatus().catch(() => {});

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
