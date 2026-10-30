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
export async function getWave(limit = 20, station = DEFAULT_STATION, sources = null) {
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

  const items = interleave(usable, want);
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
