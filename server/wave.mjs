'use strict';

/**
 * Движок ленты рекомендаций «Волна».
 *
 * Источники выбираются пользователем (Волна → «откуда собирать»):
 *   - yandex      — настоящий ротор «Моя волна» (личная станция, обучается на лайках);
 *   - soundcloud  — локальные рекомендации: профиль вкуса из истории и оценок;
 *   - spotify     — подборка каталога по тому же профилю (Spotify не даёт играть
 *                   чужие треки сторонним плеерам, поэтому такие треки помечены
 *                   как недоступные и служат для матчинга).
 *
 * Выбранные источники опрашиваются параллельно, результаты перемешиваются
 * «по кругу», дубликаты удаляются. Порядок и состав задаёт вызывающая сторона,
 * поэтому один и тот же код обслуживает и «только Яндекс», и микс трёх сервисов.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as store from './store.mjs';

const LOCAL_STATION = 'local:wave';
const DEFAULT_STATION = 'user:onyourwave';
export const ALL_SOURCES = ['yandex', 'soundcloud', 'spotify'];

let deps = { yandex: null, soundcloud: null, spotify: null };

export function bind(providers) {
  deps = {
    yandex: providers.yandex || null,
    soundcloud: providers.soundcloud || null,
    spotify: providers.spotify || null,
  };
}

function clampWant(limit) {
  return Math.min(Math.max(Number(limit) || 20, 1), 50);
}

/** Оставляем только известные источники, сохраняя порядок, и убираем повторы. */
export function normalizeSources(input) {
  const list = Array.isArray(input)
    ? input
    : String(input || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    const source = String(raw).toLowerCase();
    if (!ALL_SOURCES.includes(source) || seen.has(source)) continue;
    seen.add(source);
    out.push(source);
  }
  return out.length ? out : ALL_SOURCES.slice();
}

/* ------------------------------- публичное ------------------------------- */

/**
 * @param {number} limit сколько треков нужно
 * @param {string} station станция Яндекса (для остальных источников игнорируется)
 * @param {string[]|string|null} sources выбранные источники
 */
/* ------------------------------------------------------------------ */
/* Показанное: волна не должна повторять одни и те же треки            */
/* ------------------------------------------------------------------ */

const HERE_DIR = path.dirname(fileURLToPath(import.meta.url));
const SEEN_FILE = path.join(process.env.PLAYER_DATA_DIR || path.join(HERE_DIR, '..', 'data'), 'wave-seen.json');
const SEEN_TTL_MS = 24 * 60 * 60 * 1000;

// когда «Моя волна» иссякла, продолжаем родственными станциями —
// иначе лента либо встаёт, либо начинает круг заново
let fallbackCursor = 0;

const FALLBACK_STATIONS = [
  'personal:never-heard',
  'personal:missed-likes',
  'personal:hits',
  'mood:energetic',
  'mood:dark',
  'genre:rap',
];
const SEEN_MAX = 2500;

/** station -> Map(id -> когда показали) */
const seenByStation = new Map();
let seenLoaded = false;

function loadSeen() {
  if (seenLoaded) return;
  seenLoaded = true;
  try {
    if (!fs.existsSync(SEEN_FILE)) return;
    const raw = JSON.parse(fs.readFileSync(SEEN_FILE, 'utf8'));
    const now = Date.now();
    for (const [station, entries] of Object.entries(raw || {})) {
      const map = new Map();
      for (const [id, at] of Object.entries(entries || {})) {
        if (now - Number(at) < SEEN_TTL_MS) map.set(id, Number(at));
      }
      if (map.size) seenByStation.set(station, map);
    }
  } catch (err) {
    store.log('[wave] не удалось прочитать историю показанных треков:', err.message);
  }
}

let saveTimer = null;
function saveSeenSoon() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      const dump = {};
      for (const [station, map] of seenByStation) {
        dump[station] = Object.fromEntries(map);
      }
      fs.mkdirSync(path.dirname(SEEN_FILE), { recursive: true });
      fs.writeFileSync(SEEN_FILE, JSON.stringify(dump), 'utf8');
    } catch { /* не критично */ }
  }, 1500);
  if (typeof saveTimer.unref === 'function') saveTimer.unref();
}

function seenMap(station) {
  loadSeen();
  const key = String(station || DEFAULT_STATION);
  if (!seenByStation.has(key)) seenByStation.set(key, new Map());
  return seenByStation.get(key);
}

function wasSeen(station, id) {
  if (!id) return true;
  return seenMap(station).has(String(id));
}

function markSeen(station, id) {
  const map = seenMap(station);
  map.set(String(id), Date.now());
  if (map.size > SEEN_MAX) {
    const oldest = [...map.entries()].sort((a, b) => a[1] - b[1]).slice(0, map.size - SEEN_MAX);
    for (const [key] of oldest) map.delete(key);
  }
  saveSeenSoon();
}

/* ------------------------------------------------------------------ */
/* Заготовка партий: ротор отвечает ~5 секунд, поэтому следующий набор  */
/* собираем в фоне, а клиенту отдаём уже готовый.                      */
/* ------------------------------------------------------------------ */

const prepared = new Map();   // ключ -> готовый ответ
const preparing = new Set();   // ключи, которые собираются сейчас
const pending = new Map();     // ключ -> промис сборки (тот же, что в заготовке)

const waveKey = (station, wanted) => `${station}|${wanted.join(',')}`;

function kickPrepare(key, want, station, wanted) {
  if (prepared.has(key) || preparing.has(key)) return;
  preparing.add(key);
  buildWave(want, station, wanted)
    .then((result) => {
      // buildWave уже отфильтровал показанное и пометил треки — здесь не фильтруем повторно,
      // иначе заготовка всегда остаётся пустой
      const items = (result.items || []).filter((track) => track?.id);
      if (!items.length) return;
      prepared.set(key, { ...result, items });
    })
    .catch((err) => store.log('[wave] заготовка не собралась:', err.message))
    .finally(() => preparing.delete(key));
}

/** Ответ волны: готовая партия — сразу, иначе собираем на месте. */
export async function getWave(limit = 20, station = DEFAULT_STATION, sources = null) {
  const want = clampWant(limit);
  const wanted = normalizeSources(sources);
  const key = waveKey(station, wanted);

  const remember = (result) => {
    (result?.items || []).forEach((track) => markSeen(station, track.id));
    return result;
  };

  const ready = prepared.get(key);
  if (ready) {
    prepared.delete(key);
    kickPrepare(key, want, station, wanted);
    // заготовка могла устареть: убираем то, что успели показать иначе
    const fresh = (ready.items || []).filter((track) => track?.id && !wasSeen(station, track.id));
    if (fresh.length) return remember({ ...ready, items: fresh });
  }

  kickPrepare(key, want, station, wanted);

  // Ротор отвечает медленно, поэтому не держим запрос: отдаём пустой ответ
  // с пометкой warming — клиент повторит через секунду, а заготовка догонит.
  // готового нет — собираем на месте (первый запрос после запуска)
  return remember(await buildWave(want, station, wanted));
}

async function buildWave(limit = 20, station = DEFAULT_STATION, sources = null) {
  const want = clampWant(limit);
  const wanted = normalizeSources(sources);

  const batches = await Promise.all(
    wanted.map(async (source) => {
      try {
        if (source === 'yandex') return await yandexBatch(want, station);
        if (source === 'soundcloud') return await soundcloudBatch(want);
        if (source === 'spotify') return await spotifyBatch(want);
        return null;
      } catch (err) {
        store.log(`[wave] источник ${source} не дал ленту:`, err.message);
        return { source, engine: source, items: [], batchId: null, error: err.code || 'UPSTREAM', message: err.message };
      }
    }),
  );

  const usable = batches.filter((b) => b && Array.isArray(b.items) && b.items.length);
  const hints = [];
  let skipped = 0;
  for (const batch of batches) {
    if (!batch) continue;
    if (!batch.items.length) skipped += 1;
    if (batch.hint) hints.push(batch.hint);
  }

  if (!usable.length) {
    const reason = batches.every((b) => b && b.items.length === 0)
      ? buildEmptyHint(wanted)
      : buildEmptyHint(wanted);
    return {
      engine: 'none',
      station,
      batchId: null,
      sources: wanted,
      items: [],
      hint: reason,
      perSource: batches.filter(Boolean).map((b) => ({ source: b.source, count: b.items.length, error: b.error || null })),
    };
  }

  // выкидываем то, что уже показывали, чтобы волна не ходила по кругу
  let items = interleave(usable, want).filter((track) => !wasSeen(station, track.id));

  // если новинок мало — добираем ещё пару раз у тех же источников
  for (let attempt = 0; attempt < 2 && items.length < want; attempt += 1) {
    const extra = await Promise.all(
      wanted.map(async (source) => {
        try {
          if (source === 'yandex') return await yandexBatch(want, station);
          if (source === 'soundcloud') return await soundcloudBatch(want);
          if (source === 'spotify') return await spotifyBatch(want);
          return null;
        } catch { return null; }
      }),
    );
    const usableExtra = extra.filter((b) => b && Array.isArray(b.items) && b.items.length);
    if (!usableExtra.length) break;

    const more = interleave(usableExtra, want - items.length)
      .filter((track) => track.id && !items.some((item) => item.id === track.id) && !wasSeen(station, track.id));
    if (!more.length) break;

    items = items.concat(more);
  }

  // личная волна иссякла — тянем с родственных станций, а не повторяем старое
  if (items.length < want && wanted.includes('yandex')) {
    // каждый вызов начинает с другой станции, чтобы не зацикливаться на одной
    fallbackCursor = (fallbackCursor + 2) % FALLBACK_STATIONS.length;
    const ordered = [
      ...FALLBACK_STATIONS.slice(fallbackCursor),
      ...FALLBACK_STATIONS.slice(0, fallbackCursor),
    ].slice(0, 3);
    for (const alt of ordered) {
      if (items.length >= want) break;
      if (alt === station) continue;
      try {
        const altBatch = await yandexBatch(want - items.length, alt);
        const more = (altBatch.items || [])
          .filter((track) => track.id && !items.some((item) => item.id === track.id) && !wasSeen(station, track.id));
        if (!more.length) continue;
        items = items.concat(more);
      } catch (err) {
        store.log('[wave] соседняя станция не ответила:', err.message);
      }
    }
  }

  // ничего нового нет — повтор вернём только спустя время, чтобы не было петли
  if (!items.length) {
    const map = seenMap(station);
    const oldest = [...map.values()].sort((a, b) => a - b)[0] || 0;
    const stale = Date.now() - oldest > 30 * 60 * 1000;
    if (stale) {
      map.clear();
      items = interleave(usable, want);
    }
  }

  // «источник» в ответе определяем только по тем, кто реально дал треки
  const single = usable.length === 1;

  return {
    engine: single ? usable[0].engine : 'mixed',
    station: usable.length === 1 ? usable[0].station || station : station,
    batchId: usable.find((b) => b.batchId)?.batchId || null,
    sources: wanted,
    items,
    hint: hints.length ? hints[0] : null,
    perSource: batches.filter(Boolean).map((b) => ({ source: b.source, count: b.items.length, error: b.error || null })),
  };
}

/** Перемешивание «по кругу»: по одному треку с каждого источника, без повторов. */
function interleave(batches, want) {
  const out = [];
  const seen = new Set();
  const longest = Math.max(...batches.map((b) => b.items.length));
  for (let index = 0; index < longest && out.length < want; index += 1) {
    for (const batch of batches) {
      const track = batch.items[index];
      if (!track || !track.id || seen.has(track.id)) continue;
      seen.add(track.id);
      out.push(track);
      if (out.length >= want) break;
    }
  }
  return out;
}

function buildEmptyHint(wanted) {
  const names = { yandex: 'Яндекс.Музыка', soundcloud: 'SoundCloud', spotify: 'Spotify' };
  const list = wanted.map((s) => names[s] || s).join(', ');
  return `Нет треков из выбранных источников (${list}). Проверьте подключение в разделе «Подключения» и обновите волну.`;
}

/* ------------------------------- источники ------------------------------- */

async function yandexBatch(want, station) {
  const yandex = deps.yandex;
  if (!yandex) return { source: 'yandex', engine: 'yandex', items: [], error: 'NOT_INSTALLED' };
  const status = await yandex.status().catch((err) => ({ connected: false, error: err.code || 'UPSTREAM' }));
  if (!status.connected) {
    return { source: 'yandex', engine: 'yandex', items: [], error: status.error || 'NO_TOKEN', hint: null };
  }
  const result = await yandex.wave(want, station);
  return {
    source: 'yandex',
    engine: 'yandex',
    station,
    batchId: result.batchId || null,
    items: Array.isArray(result.items) ? result.items : [],
  };
}

async function soundcloudBatch(want) {
  const sc = deps.soundcloud;
  if (!sc) return { source: 'soundcloud', engine: 'local-discovery', items: [], error: 'NOT_INSTALLED' };
  const status = await sc.status().catch(() => ({ connected: false }));
  if (!status || !status.connected) {
    return { source: 'soundcloud', engine: 'local-discovery', items: [], error: 'NO_TOKEN' };
  }
  const { ranked, dislikedIds, recentIds } = buildTaste();
  const hasTaste = ranked.length > 0;
  const seeds = hasTaste ? ranked.slice(0, 3).map((s) => s.artist) : ['electronic', 'indie', 'hip hop'];

  const found = await Promise.all(
    seeds.map((seed) =>
      sc
        .search(seed, Math.ceil(want / seeds.length) + 4)
        .then((list) => (Array.isArray(list) ? list : []))
        .catch(() => []),
    ),
  );

  const items = [];
  const seen = new Set();
  const longest = Math.max(0, ...found.map((f) => f.length));
  for (let i = 0; i < longest; i += 1) {
    for (const list of found) {
      const track = list[i];
      if (!track || !track.id || seen.has(track.id)) continue;
      if (!track.playable) continue;
      if (dislikedIds.has(track.id) || recentIds.has(track.id)) continue;
      seen.add(track.id);
      items.push(track);
    }
  }

  return {
    source: 'soundcloud',
    engine: hasTaste ? 'local-taste' : 'local-discovery',
    items: items.slice(0, want),
    hint: hasTaste ? null : 'Профиля пока нет — это обзорная лента SoundCloud.',
  };
}

async function spotifyBatch(want) {
  const spotify = deps.spotify;
  if (!spotify) return { source: 'spotify', engine: 'spotify', items: [], error: 'NOT_INSTALLED' };
  const status = await spotify.status().catch(() => ({ connected: false }));
  if (!status || !status.connected) {
    return { source: 'spotify', engine: 'spotify', items: [], error: 'NO_TOKEN' };
  }
  const { ranked } = buildTaste();
  const seeds = ranked.length ? ranked.slice(0, 2).map((s) => s.artist) : ['top hits'];
  const found = await Promise.all(
    seeds.map((seed) =>
      spotify
        .search(seed, Math.ceil(want / seeds.length) + 2)
        .then((list) => (Array.isArray(list) ? list : []))
        .catch(() => []),
    ),
  );
  const items = [];
  const seen = new Set();
  const longest = Math.max(0, ...found.map((f) => f.length));
  for (let i = 0; i < longest && items.length < want; i += 1) {
    for (const list of found) {
      const track = list[i];
      if (!track || !track.id || seen.has(track.id)) continue;
      seen.add(track.id);
      items.push(track);
      if (items.length >= want) break;
    }
  }
  return {
    source: 'spotify',
    engine: 'spotify',
    items,
    hint: 'Spotify отдаёт только каталог: такие треки не воспроизводятся в labsoul, их удобно матчить на Яндекс или SoundCloud.',
  };
}

/* -------------------------------- профиль -------------------------------- */

function artistOf(track) {
  return track && Array.isArray(track.artists) && track.artists[0] ? track.artists[0] : null;
}

/** Профиль вкуса: история прослушивания + явные лайки/дизлайки/скипы. */
function buildTaste() {
  const history = store.getHistory(200);
  const feedback = store.getFeedback(400);
  const weights = new Map();
  const likedIds = new Set();
  const dislikedIds = new Set();
  const recentIds = new Set();

  for (const entry of history) {
    const artist = artistOf(entry.track);
    if (entry.track && entry.track.id) recentIds.add(entry.track.id);
    if (!artist) continue;
    weights.set(artist, (weights.get(artist) || 0) + 1);
  }

  for (const fb of feedback) {
    const artist = artistOf(fb.track);
    if (fb.track && fb.track.id) {
      if (fb.type === 'like') likedIds.add(fb.track.id);
      if (fb.type === 'dislike') dislikedIds.add(fb.track.id);
    }
    if (!artist) continue;
    if (fb.type === 'like') weights.set(artist, (weights.get(artist) || 0) + 3);
    else if (fb.type === 'dislike') weights.set(artist, (weights.get(artist) || 0) - 2);
    else if (fb.type === 'skip') weights.set(artist, (weights.get(artist) || 0) - 0.5);
  }

  const ranked = [...weights.entries()]
    .filter(([, score]) => score > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([artist, score]) => ({ artist, score }));

  return { ranked, likedIds, dislikedIds, recentIds };
}

/* ------------------------- обратная связь -------------------------------- */

export async function sendFeedback(event) {
  const payload = event && typeof event === 'object' ? event : {};
  store.addFeedback({
    type: String(payload.type || 'unknown'),
    trackId: payload.track?.id || payload.trackId || null,
    station: payload.station || DEFAULT_STATION,
    position: Math.max(0, Math.round(Number(payload.position) || 0)),
    track: payload.track || null,
  });

  const isYandexTrack = /^ym:/.test(String(payload.track?.id || payload.trackId || ''));
  const stationIsLocal = String(payload.station || '').startsWith('local:');
  if (deps.yandex && isYandexTrack && !stationIsLocal) {
    const result = await deps.yandex
      .feedback({
        type: payload.type,
        sourceId: String(payload.track?.sourceId || payload.trackId || '').replace(/^ym:/, ''),
        batchId: payload.batchId,
        position: payload.position,
        station: payload.station,
      })
      .catch(() => ({ ok: false }));
    return { ok: true, forwarded: Boolean(result && result.ok), engine: 'yandex' };
  }

  return { ok: true, forwarded: false, engine: 'local' };
}

export const stations = { LOCAL_STATION, DEFAULT_STATION };
