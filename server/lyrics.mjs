/**
 * Тексты песен с таймингами (LRC).
 *
 * Провайдеры музыки своих текстов в открытом виде не отдают: у Яндекса
 * эндпоинт требует подпись другим ключом, у Spotify и SoundCloud открытого
 * API текстов нет. Поэтому ищем по названию/исполнителю/длительности, каскадом:
 *
 *   1. LRCLIB (lrclib.net) — точное совпадение, отдаёт синхронный LRC;
 *   2. NetEase Cloud Music — широкий каталог, LRC с таймингами;
 *   3. LRCLIB-поиск — то, что осталось (иногда только plain-текст).
 *
 * Первый источник, давший синхронизацию, побеждает. Кэш — в памяти и в
 * data/lyrics-cache.json, чтобы не дёргать чужие API при каждом открытии.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const LRCLIB = 'https://lrclib.net/api';
const NETEASE = 'https://music.163.com/api';
const LRCLIB_TIMEOUT_MS = 4500;
const NETEASE_TIMEOUT_MS = 7000;
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const USER_AGENT = 'labsoul/1.0 (https://github.com/avaneqqqqqq/Labsoul.Player)';
const NETEASE_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
  Referer: 'https://music.163.com/',
  Accept: 'application/json',
};

let cacheFile = null;
const memory = new Map();

function log(message) {
  try {
    console.log(`[lyrics] ${message}`);
  } catch { /* ignore */ }
}

export function configure({ dataDir } = {}) {
  const dir = dataDir || process.env.PLAYER_DATA_DIR
    || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');
  if (!dir) return;

  cacheFile = path.join(dir, 'lyrics-cache.json');
  try {
    if (fs.existsSync(cacheFile)) {
      const raw = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      const now = Date.now();
      for (const [key, entry] of Object.entries(raw || {})) {
        if (entry && now - (entry.at || 0) < CACHE_TTL_MS) memory.set(key, entry);
      }
      log(`кэш текстов: ${memory.size}`);
    }
  } catch (err) {
    log(`кэш текстов не прочитан: ${err.message}`);
  }
}

function persist() {
  if (!cacheFile) return;
  try {
    const now = Date.now();
    const dump = {};
    for (const [key, entry] of memory) {
      if (entry && now - (entry.at || 0) < CACHE_TTL_MS) dump[key] = entry;
    }
    fs.writeFileSync(cacheFile, JSON.stringify(dump), 'utf8');
  } catch { /* кэш не критичен */ }
}

const cacheKey = ({ title, artist, duration }) =>
  `${String(title || '').toLowerCase().trim()}|${String(artist || '').toLowerCase().trim()}|${Math.round(Number(duration) || 0)}`;

/* ------------------------------ LRC-парсер ------------------------------ */

const TIME_TAG = /\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g;

/** Разбирает LRC в отсортированный список строк; понимает несколько меток в строке. */
export function parseLrc(lrc) {
  const lines = [];
  const text = String(lrc || '').replace(/\r\n?/g, '\n');

  for (const rawLine of text.split('\n')) {
    const stamps = [];
    let match;
    TIME_TAG.lastIndex = 0;
    while ((match = TIME_TAG.exec(rawLine)) !== null) {
      const minutes = Number(match[1]);
      const seconds = Number(match[2]);
      const fraction = match[3] ? Number(`0.${match[3]}`) : 0;
      stamps.push(minutes * 60 + seconds + fraction);
    }
    if (!stamps.length) continue;

    const content = rawLine.replace(TIME_TAG, '').trim();
    if (!content) continue;
    for (const time of stamps) lines.push({ time, text: content });
  }

  lines.sort((a, b) => a.time - b.time);

  const unique = [];
  for (const line of lines) {
    const last = unique[unique.length - 1];
    if (last && last.text === line.text && Math.abs(last.time - line.time) < 0.05) continue;
    unique.push(line);
  }
  return unique;
}

/** Убирает LRC-теги и служебные строки — для текста без синхронизации. */
export function stripLrc(lrc) {
  return String(lrc || '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(TIME_TAG, '').trim())
    .filter((line) => line && !/^\[[a-z]+:/i.test(line))
    .join('\n')
    .trim();
}

/* ------------------------------- запросы -------------------------------- */

async function fetchJson(url, headers = { Accept: 'application/json', 'User-Agent': USER_AGENT }, timeoutMs = LRCLIB_TIMEOUT_MS) {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  if (res.status === 404) return null;
  if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
  return res.json();
}

const normalize = (value) => String(value || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

function similarity(a, b) {
  const left = normalize(a);
  const right = normalize(b);
  if (!left || !right) return 0;
  if (left === right) return 1;
  if (left.includes(right) || right.includes(left)) return 0.8;
  const leftWords = new Set(left.split(' '));
  const rightWords = new Set(right.split(' '));
  let common = 0;
  for (const word of leftWords) if (rightWords.has(word)) common += 1;
  return common / Math.max(leftWords.size, rightWords.size);
}

/* -------------------------------- LRCLIB -------------------------------- */

function normalizeLrclib(data, provider = 'lrclib') {
  if (!data) return null;
  const synced = data.syncedLyrics ? parseLrc(data.syncedLyrics) : [];
  const plain = String(data.plainLyrics || (synced.length ? synced.map((line) => line.text).join('\n') : '')).trim();
  if (!synced.length && !plain) {
    return data.instrumental
      ? { available: false, instrumental: true, synced: [], plain: '', provider }
      : null;
  }
  return {
    available: true,
    instrumental: false,
    synced,
    plain,
    provider,
    matched: {
      title: data.trackName || null,
      artist: data.artistName || null,
      album: data.albumName || null,
      duration: data.duration || null,
    },
  };
}

async function lrclibExact({ title, artist, album, duration }) {
  if (!title) return null;
  const params = new URLSearchParams();
  params.set('track_name', title);
  if (artist) params.set('artist_name', artist);
  if (album) params.set('album_name', String(album));
  if (duration) params.set('duration', String(Math.round(duration)));
  const data = await fetchJson(`${LRCLIB}/get?${params}`);
  return Array.isArray(data) ? null : normalizeLrclib(data);
}

async function lrclibSearch({ title, artist, duration }) {
  if (!title) return null;
  const params = new URLSearchParams({ track_name: title });
  if (artist) params.set('artist_name', artist);
  const data = await fetchJson(`${LRCLIB}/search?${params}`);
  if (!Array.isArray(data)) return null;

  const scored = data
    .map((item) => {
      const delta = duration && item.duration ? Math.abs(Number(item.duration) - Number(duration)) : 999;
      return { item, score: (item.syncedLyrics ? 0 : 100) + delta };
    })
    .sort((a, b) => a.score - b.score);

  for (const { item } of scored) {
    const normalized = normalizeLrclib(item);
    if (normalized?.available) return normalized;
  }
  return null;
}

/* -------------------------------- NetEase ------------------------------- */

async function neteaseLyrics({ title, artist, duration }) {
  if (!title) return null;

  const query = [title, artist].filter(Boolean).join(' ');
  const searchUrl = `${NETEASE}/search/get?${new URLSearchParams({ s: query, type: '1', limit: '10', offset: '0' })}`;
  const found = await fetchJson(searchUrl, NETEASE_HEADERS, NETEASE_TIMEOUT_MS);
  const songs = found?.result?.songs || [];
  if (!songs.length) return null;

  const scored = songs
    .map((song) => {
      const songSeconds = Math.round((song.duration || 0) / 1000);
      const delta = duration && songSeconds ? Math.abs(songSeconds - Number(duration)) : 999;
      const nameScore = similarity(song.name, title);
      const artistScore = similarity((song.artists || []).map((a) => a.name).join(' '), artist);
      // приоритет: похожее название и исполнитель, затем близкая длительность
      return { song, score: (1 - nameScore) * 100 + (1 - artistScore) * 40 + delta };
    })
    .sort((a, b) => a.score - b.score);

  for (const { song, score } of scored.slice(0, 3)) {
    if (score > 220) continue;
    try {
      const lyricUrl = `${NETEASE}/song/lyric?id=${song.id}&lv=-1&kv=-1&tv=-1`;
      const data = await fetchJson(lyricUrl, NETEASE_HEADERS, NETEASE_TIMEOUT_MS);
      const lrc = data?.lrc?.lyric || '';
      const synced = parseLrc(lrc);
      const plain = synced.length ? synced.map((line) => line.text).join('\n') : stripLrc(lrc);
      if (!plain) continue;
      return {
        available: true,
        instrumental: false,
        synced,
        plain,
        provider: 'netease',
        matched: {
          title: song.name || null,
          artist: (song.artists || []).map((a) => a.name).join(', ') || null,
          album: song.album?.name || null,
          duration: Math.round((song.duration || 0) / 1000) || null,
        },
      };
    } catch (err) {
      log(`netease lyric: ${err.message}`);
    }
  }
  return null;
}

/* --------------------------- чистка разметки --------------------------- */

const CREDIT_LINE = /^(作词|作曲|编曲|制作人?|出品|监制|录音|混音|母带|和声|吉他|贝斯|鼓|键盘|弦乐|lyrics?|composer|producer|arranger|written|mixed|mastered|performed)\b/i;
const CREDIT_PAIR = /^[^:：]{2,14}\s*[:：]\s*\S/;

/** Убирает служебные строки: «作词 : Кино», «Producer: X» и подобное. */
export function cleanSynced(lines) {
  return (lines || []).filter((line) => {
    const value = String(line.text || '').trim();
    if (!value) return false;
    if (CREDIT_LINE.test(value)) return false;
    if (CREDIT_PAIR.test(value) && value.length < 40) return false;
    return true;
  });
}

/* ------------------------------ оркестратор ----------------------------- */

function prepare({ title, artist, album, duration }) {
  return {
    title: String(title || '').replace(/\s*[([].*?[)\]]\s*$/, '').trim(),
    artist: String(artist || '').split(',')[0].trim(),
    album: album ? String(album) : '',
    duration: Math.round(Number(duration) || 0),
  };
}

export async function lookup(rawMeta) {
  const meta = prepare(rawMeta);

  // LRCLIB и NetEase опрашиваем одновременно: ждать по очереди слишком долго
  const [lrclibResult, neteaseResult] = await Promise.allSettled([
    lrclibExact(meta),
    neteaseLyrics(meta),
  ]);

  const lrclib = lrclibResult.status === 'fulfilled' ? lrclibResult.value : null;
  const netease = neteaseResult.status === 'fulfilled' ? neteaseResult.value : null;
  if (lrclibResult.status === 'rejected') log(`lrclib get: ${lrclibResult.reason?.message}`);
  if (neteaseResult.status === 'rejected') log(`netease: ${neteaseResult.reason?.message}`);

  const withSync = [lrclib, netease].filter((item) => item?.synced?.length).map(postProcess);
  if (withSync.length) return withSync[0];

  let search = null;
  try { search = await lrclibSearch(meta); } catch (err) { log(`lrclib search: ${err.message}`); }
  const searchSync = search?.synced?.length ? postProcess(search) : null;
  if (searchSync) return searchSync;

  const anyText = [lrclib, netease, search].find((item) => item?.available && item.plain);
  if (anyText) return postProcess(anyText);

  const instrumental = [lrclib, netease, search].find((item) => item?.instrumental);
  if (instrumental) return instrumental;

  return { available: false, instrumental: false, synced: [], plain: '', provider: null };
}

/** Чистит служебные строки и, если слова остались без времени, пересобирает plain. */
function postProcess(result) {
  if (!result?.synced?.length) return result;
  const synced = cleanSynced(result.synced);
  if (!synced.length) return { ...result, synced: [], available: Boolean(result.plain) };
  return {
    ...result,
    synced,
    plain: result.plain || synced.map((line) => line.text).join('\n'),
  };
}

// отрицательный ответ кэшируем недолго: источники бывают перегружены
const NEGATIVE_TTL_MS = 15 * 60 * 1000;

function freshEnough(entry) {
  if (!entry) return false;
  const ttl = entry.value?.available ? CACHE_TTL_MS : NEGATIVE_TTL_MS;
  return Date.now() - (entry.at || 0) < ttl;
}

/** Поиск текста с кэшем. */
export async function findLyrics(meta) {
  const key = cacheKey(meta);
  const cached = memory.get(key);
  if (freshEnough(cached)) {
    return { ...cached.value, cached: true };
  }

  const value = await lookup(meta);
  memory.set(key, { at: Date.now(), value });
  persist();
  return value;
}

export function clearCache() {
  memory.clear();
  if (cacheFile) {
    try { fs.unlinkSync(cacheFile); } catch { /* нет файла */ }
  }
}
