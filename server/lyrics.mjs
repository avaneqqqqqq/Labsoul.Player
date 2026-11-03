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
/**
 * Lrcmux — публичный прокси к караоке-текстам KuGou.
 *
 * Единственный бесплатный источник, отдающий ПОСЛОГОВЫЕ тайминги
 * (`level=word`): внутри каждой строки приходит массив `words` со
 * временем начала и конца. Ключ не нужен.
 */
const LRCMUX = 'https://api.lrcmux.dev';
const LRCMUX_TIMEOUT_MS = 9000;
// На каждую попытку ждём меньше: сервис либо отвечает быстро, либо лежит.
// Две попытки по 3.5 с дают максимум 7 с вместо прежних 18.
const LRCMUX_ATTEMPT_MS = 3500;
const LRCLIB_TIMEOUT_MS = 3500;
const NETEASE_TIMEOUT_MS = 4000;
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

// NetEase иногда отдаёт расширенные метки вида [00:00.00-1] и [mm:ss:xx]
const TIME_TAG = /\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?(?:[-:\u2013]\d+)?\]/g;

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

/**
 * Чистит обычный текст: убирает строки-кредиты и «[00:00.00-1] текст».
 * Возвращает список значимых строк.
 */
export function cleanPlainLines(plain) {
  return String(plain || '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(TIME_TAG, '').replace(/^\[[^\]]*\]\s*/, '').trim())
    .filter((line) => line && !/^\[[a-z]+:/i.test(line) && !isCreditLine(line) && !looksInstrumental(line));
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

/* ---------------------------- язык и совпадения --------------------------- */

const SCRIPT_TESTS = {
  latin: /[a-z]/gi,
  cyrillic: /[а-яё]/gi,
  cjk: /[\u3400-\u9fff\uf900-\ufaff]/g,
  hangul: /[\uac00-\ud7af\u1100-\u11ff]/g,
  kana: /[\u3040-\u30ff]/g,
};

/** Доли письменностей в тексте: {latin, cyrillic, cjk, hangul, kana}. */
export function scriptShares(value) {
  const text = String(value || '');
  const letters = text.replace(/[^\p{L}]/gu, '');
  const total = letters.length || 1;
  const shares = {};
  for (const [name, regex] of Object.entries(SCRIPT_TESTS)) {
    const matches = letters.match(regex);
    shares[name] = (matches ? matches.length : 0) / total;
  }
  return shares;
}

/** Текст на «чужой» письменности по отношению к названию трека. */
export function languageMismatch(title, lyrics) {
  if (!title || !lyrics) return false;
  const track = scriptShares(title);
  const found = scriptShares(String(lyrics).slice(0, 600));

  const trackIsEuropean = track.latin + track.cyrillic > 0.7;
  const trackIsAsian = track.cjk + track.hangul + track.kana > 0.7;

  // европейское название, а в тексте заметная доля азиатской письменности —
  // почти наверняка чужой трек (корейский/китайский оригинал под нашим названием)
  if (trackIsEuropean && (found.cjk + found.hangul + found.kana) > 0.25) return true;

  // азиатское название, а текст латиницей/кириллицей — тоже чужой
  if (trackIsAsian && (found.latin + found.cyrillic) > 0.6) return true;

  return false;
}

/* -------------------------------- LRCLIB -------------------------------- */

function normalizeLrclib(data, provider = 'lrclib') {
  if (!data) return null;
  const synced = data.syncedLyrics ? parseLrc(data.syncedLyrics) : [];
  const plainLines = cleanPlainLines(data.plainLyrics || (synced.length ? synced.map((line) => line.text).join('\n') : ''));
  const plain = plainLines.join('\n').trim();
  if (!synced.length && plainLines.length < 2) {
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
      return { item, delta, nameScore: similarity(item.trackName, title) };
    })
    .filter(({ delta, nameScore }) => nameScore >= 0.6 && (!duration || delta === 999 || delta <= 12)) 
    .sort((a, b) => (b.item.syncedLyrics ? 1 : 0) - (a.item.syncedLyrics ? 1 : 0) || a.delta - b.delta);

  for (const { item } of scored) {
    const normalized = normalizeLrclib(item);
    if (!normalized?.available) continue;
    const joined = normalized.plain || normalized.synced.map((line) => line.text).join('\n');
    if (languageMismatch(title, joined)) continue;
    return normalized;
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
      return {
        song,
        delta,
        nameScore: similarity(song.name, title),
        artistScore: similarity((song.artists || []).map((a) => a.name).join(' '), artist),
      };
    })
    // название должно реально совпадать, длительность — не расходиться сильно
    .filter(({ nameScore, artistScore, delta }) => {
      if (nameScore < 0.55) return false;
      if (duration && delta !== 999 && delta > 12) return false;
      if (artist && artistScore < 0.3 && nameScore < 0.85) return false;
      return true;
    })
    .sort((a, b) => (b.nameScore + b.artistScore) - (a.nameScore + a.artistScore) || a.delta - b.delta);

  // второй проход: название может отличаться (ремиксы, транслит),
  // но длительность и исполнитель должны сойтись почти точно
  const loose = songs
    .map((song) => {
      const songSeconds = Math.round((song.duration || 0) / 1000);
      return {
        song,
        delta: duration && songSeconds ? Math.abs(songSeconds - Number(duration)) : 999,
        artistScore: similarity((song.artists || []).map((a) => a.name).join(' '), artist),
      };
    })
    .filter(({ delta, artistScore }) => delta !== 999 && delta <= 3 && artistScore >= 0.45)
    .sort((a, b) => b.artistScore - a.artistScore || a.delta - b.delta);

  const candidates = [...scored.slice(0, 3), ...loose.slice(0, 2).filter((c) => !scored.slice(0, 3).includes(c))];

  for (const { song } of candidates) {
    try {
      const lyricUrl = `${NETEASE}/song/lyric?id=${song.id}&lv=-1&kv=-1&tv=-1`;
      const data = await fetchJson(lyricUrl, NETEASE_HEADERS, NETEASE_TIMEOUT_MS);
      const lrc = data?.lrc?.lyric || '';
      const synced = cleanSynced(parseLrc(lrc));
      const plainLines = synced.length
        ? synced.map((line) => line.text)
        : cleanPlainLines(stripLrc(lrc));
      const plain = plainLines.join('\n').trim();
      // заглушка «纯音乐» вместо текста — это инструментал
      if (!synced.length && looksInstrumental(lrc)) {
        return {
          available: false,
          instrumental: true,
          synced: [],
          plain: '',
          provider: 'netease',
          matched: {
            title: song.name || null,
            artist: (song.artists || []).map((a) => a.name).join(', ') || null,
            album: song.album?.name || null,
            duration: Math.round((song.duration || 0) / 1000) || null,
          },
        };
      }
      // запись без самого текста (только «作词/作曲») — пропускаем
      if (!synced.length && plainLines.length < 2) continue;
      // чужой язык (корейский/китайский текст под русским или английским названием)
      if (languageMismatch(title, synced.length ? synced.map((l) => l.text).join('\n') : plain)) continue;
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
const CREDIT_PAIR = /^[^:：]{2,20}\s*[:：]\s*\S/;

// NetEase и другие базы помечают инструментал служебной фразой вместо текста
const INSTRUMENTAL_TEXT = /(纯音乐|此歌曲为没有填词的纯音乐|没有填词|instrumental|no lyrics|\[instrumental\])/i;

/** Похоже ли содержимое на пометку «это инструментал». */
export function looksInstrumental(value) {
  return INSTRUMENTAL_TEXT.test(String(value || ''));
}

/** Строка-кредит: «作词 : Кино», «Producer: X» и подобное. */
export function isCreditLine(value) {
  const line = String(value || '').trim().replace(/^\[\d{1,3}:\d{2}[^\]]*\]\s*/, '');
  if (!line) return true;
  if (CREDIT_LINE.test(line)) return true;
  // «роль : имя» — но не просто строка с двоеточием внутри текста песни
  if (CREDIT_PAIR.test(line) && line.length < 60 && !/[.!?…]$/.test(line)) return true;
  return false;
}

/** Убирает служебные строки: «作词 : Кино», «Producer: X», «纯音乐» и подобное. */
export function cleanSynced(lines) {
  return (lines || []).filter((line) => {
    const value = String(line.text || '').trim();
    if (!value) return false;
    if (looksInstrumental(value)) return false;
    return !isCreditLine(value);
  });
}

/* -------------------------------- Lrcmux -------------------------------- */

/**
 * Достать караоке-текст (послоговые тайминги) из KuGou через lrcmux.dev.
 *
 * Это основной источник для «подсветки по слову»: отдаёт массив `lines`,
 * где у каждой строки есть `start`/`end` в миллисекундах и, если повезёт,
 * массив `words` — по одному элементу на слово с собственным временем.
 *
 * @returns {Promise<object|null>} результат в общем формате текстов
 */
async function lrcmuxLyrics(meta) {
  const params = new URLSearchParams({
    // prepare() отдаёт artist строкой, а не массивом
    artist: String(meta.artist || '').trim() || meta.title,
    title: meta.title,
    level: 'word',
  });
  const url = `${LRCMUX}/get?${params}`;

  // Сервис иногда отвечает 404 на первый запрос, который у него ещё не
  // прогрелся в кэше: вторая попытка обычно успешна. Таймаут короткий —
  // при недоступном сервисе ждать 9 секунд на каждой из двух попыток
  // значило держать пользователя у пустого экрана почти полминуты.
  let data = null;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), LRCMUX_ATTEMPT_MS);
    try {
      const response = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
        signal: controller.signal,
      });
      if (response.ok) {
        data = await response.json();
        break;
      }
      if (attempt === 2) log(`lrcmux: HTTP ${response.status}`);
    } catch (error) {
      if (attempt === 2) log(`lrcmux: ${error.message}`);
    } finally {
      clearTimeout(timer);
    }
    if (attempt === 1) await new Promise((resolve) => setTimeout(resolve, 200));
  }
  if (!data) return null;

  const lines = Array.isArray(data?.lines) ? data.lines : [];
  if (!lines.length) return null;

  /*
   * Проверяем, что это тот же трек.
   *
   * Раньше сверялась только длительность с допуском 20 секунд, поэтому
   * для «Brand new smile» подставлялся текст одноимённой другой песни —
   * отсюда клипы с чужим содержимым. Теперь проверяем ещё имя трека и,
   * если сервис отдал её, исполнителя.
   */
  const duration = Number(data?.track?.duration) || 0;
  if (meta.duration && duration && Math.abs(duration - meta.duration) > 8) {
    log(`lrcmux: другая длительность (${duration} против ${meta.duration})`);
    return null;
  }

  const foundTitle = String(data?.track?.title || '');
  if (foundTitle && meta.title) {
    const score = similarity(foundTitle, meta.title);
    if (score < 0.55) {
      log(`lrcmux: другое название («${foundTitle}» против «${meta.title}»)`);
      return null;
    }
  }

  const foundArtist = String(data?.track?.artist || '');
  if (foundArtist && meta.artist && similarity(foundArtist, meta.artist) < 0.45) {
    log(`lrcmux: другой исполнитель («${foundArtist}» против «${meta.artist}»)`);
    return null;
  }

  // первая строка не должна начинаться позже середины — иначе это обрывок
  // текста с конца, и ползунок оказывается не на своём месте
  const firstStart = Number(lines[0]?.start) || 0;
  const totalMs = (Number(meta.duration) || duration || 0) * 1000;
  if (totalMs && firstStart > totalMs * 0.5) {
    log(`lrcmux: текст начинается с ${Math.round(firstStart / 1000)} с — похоже на обрывок`);
    return null;
  }

  const synced = [];
  let wordLevel = false;

  for (const line of lines) {
    const text = String(line?.text || '').trim();
    if (!text) continue;

    const startMs = Number(line.start) || 0;
    const endMs = Number(line.end) || startMs;

    // послоговые данные приходят отдельным массивом
    const words = Array.isArray(line.words)
      ? line.words
        .map((word) => ({
          text: String(word?.text || ''),
          start: (Number(word?.start) || startMs) / 1000,
          end: (Number(word?.end) || endMs) / 1000,
        }))
        .filter((word) => word.text.trim())
      : [];

    if (words.length > 1) wordLevel = true;

    synced.push({
      time: startMs / 1000,
      end: endMs > startMs ? endMs / 1000 : undefined,
      text,
      words: words.length > 1 ? words : undefined,
    });
  }

  if (!synced.length) return null;

  return {
    available: true,
    instrumental: false,
    synced,
    plain: synced.map((line) => line.text).join('\n'),
    provider: wordLevel ? 'lrcmux-word' : 'lrcmux',
    wordLevel,
  };
}

/* -------------------------------- Genius -------------------------------- */

const GENIUS_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36',
  Accept: 'text/html,application/json',
};

/** Вырезает содержимое блоков data-lyrics-container с учётом вложенности тегов. */
function extractContainers(html) {
  const out = [];
  const openTag = /<div[^>]*data-lyrics-container="true"[^>]*>/g;
  let match;
  while ((match = openTag.exec(html)) !== null) {
    const start = match.index + match[0].length;
    let depth = 1;
    let end = start;

    const tag = /<(\/?)div\b[^>]*>/gi;
    tag.lastIndex = start;
    let inner;
    while ((inner = tag.exec(html)) !== null) {
      depth += inner[1] ? -1 : 1;
      if (depth === 0) { end = inner.index; break; }
    }

    out.push(html.slice(start, end));
    openTag.lastIndex = end;
  }
  return out;
}

function htmlToText(fragment) {
  return fragment
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\u00a0/g, ' ')
    .trim();
}

const GENIUS_NOISE = /^(contributors?|translations?|romanization|read more|you might also like|\d+\s*contributors?)/i;

/** Чистит страницу Genius: шапка-описание и шум отбрасываются. */
export function extractGeniusLyrics(html) {
  const blocks = extractContainers(String(html || ''));
  if (!blocks.length) return '';

  let text = blocks.map(htmlToText).join('\n');

  // у Genius перед текстом идёт описание песни, заканчивающееся «Read More»
  const readMore = text.lastIndexOf('Read More');
  if (readMore !== -1) text = text.slice(readMore + 'Read More'.length);

  const lines = text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => line && !GENIUS_NOISE.test(line) && line.length <= 240);

  return cleanPlainLines(lines.join('\n')).join('\n').trim();
}

async function geniusLyrics({ title, artist }) {
  if (!title) return null;

  const query = [title, artist].filter(Boolean).join(' ');
  const search = await fetchJson(
    `https://genius.com/api/search/multi?q=${encodeURIComponent(query)}`,
    GENIUS_HEADERS,
    8000,
  );

  const hits = (search?.response?.sections || [])
    .flatMap((section) => section.hits || [])
    .map((hit) => hit.result)
    .filter((result) => result && result.url);

  if (!hits.length) return null;

  const scored = hits
    .map((song) => ({
      song,
      nameScore: similarity(song.title || song.full_title, title),
      artistScore: similarity(song.primary_artist?.name || '', artist),
    }))
    .filter(({ song, nameScore, artistScore }) => {
      // романизированные версии и переводы — не наш текст
      if (/romaniz|translation|transliterat/i.test(String(song.title || song.full_title || ''))) return false;
      if (/romanizations?/i.test(String(song.primary_artist?.name || ''))) return false;
      if (nameScore < 0.6) return false;
      if (artist && artistScore < 0.3 && nameScore < 0.9) return false;
      return true;
    })
    .sort((a, b) => (b.nameScore + b.artistScore) - (a.nameScore + a.artistScore));

  for (const { song } of scored.slice(0, 2)) {
    try {
      const page = await fetch(song.url, { headers: GENIUS_HEADERS, signal: AbortSignal.timeout(NETEASE_TIMEOUT_MS) });
      if (!page.ok) continue;
      const plain = extractGeniusLyrics(await page.text());
      if (plain.split('\n').length < 2) continue;
      if (languageMismatch(title, plain)) continue;
      return {
        available: true,
        instrumental: false,
        synced: [],
        plain,
        provider: 'genius',
        matched: {
          title: song.title || null,
          artist: song.primary_artist?.name || null,
          album: song.album?.name || null,
          duration: null,
        },
      };
    } catch (err) {
      log(`genius page: ${err.message}`);
    }
  }
  return null;
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

  // LRCLIB, NetEase и Lrcmux опрашиваем одновременно: ждать по очереди слишком долго
  const [lrclibResult, neteaseResult, lrcmuxResult] = await Promise.allSettled([
    lrclibExact(meta),
    neteaseLyrics(meta),
    lrcmuxLyrics(meta),
  ]);

  const lrclib = lrclibResult.status === 'fulfilled' ? lrclibResult.value : null;
  const netease = neteaseResult.status === 'fulfilled' ? neteaseResult.value : null;
  const lrcmux = lrcmuxResult.status === 'fulfilled' ? lrcmuxResult.value : null;
  if (lrclibResult.status === 'rejected') log(`lrclib get: ${lrclibResult.reason?.message}`);
  if (neteaseResult.status === 'rejected') log(`netease: ${neteaseResult.reason?.message}`);
  if (lrcmuxResult.status === 'rejected') log(`lrcmux: ${lrcmuxResult.reason?.message}`);

  // Приоритет: у кого есть послоговые тайминги — тот и отдаём первым,
  // иначе подсветка по слову не появится, хотя данные пришли.
  if (lrcmux?.wordLevel && lrcmux.synced?.length) return postProcess(lrcmux);

  const withSync = [lrclib, netease, lrcmux].filter((item) => item?.synced?.length).map(postProcess);
  if (withSync.length) return withSync[0];

  let search = null;
  try { search = await lrclibSearch(meta); } catch (err) { log(`lrclib search: ${err.message}`); }
  const searchSync = search?.synced?.length ? postProcess(search) : null;
  if (searchSync) return searchSync;

  const anyText = [lrclib, netease, lrcmux, search].find((item) => item?.available && item.plain);
  if (anyText) return postProcess(anyText);

  // своих источников не хватило — идём в Genius
  try {
    const genius = await geniusLyrics(meta);
    if (genius) return postProcess(genius);
  } catch (err) {
    log(`genius: ${err.message}`);
  }

  const instrumental = [lrclib, netease, search].find((item) => item?.instrumental);
  if (instrumental) return instrumental;

  return { available: false, instrumental: false, synced: [], plain: '', provider: null };
}

/** Чистит служебные строки и, если слова остались без времени, пересобирает plain. */
function postProcess(result) {
  if (!result) return result;

  const synced = cleanSynced(result.synced);
  const plainLines = cleanPlainLines(result.plain || '');
  if (synced.length) {
    return { ...result, synced, plain: plainLines.length ? plainLines.join('\n') : synced.map((line) => line.text).join('\n') };
  }

  // синхронизации нет: отдаём текст, только если это действительно текст, а не кредиты
  if (plainLines.length >= 2) {
    return { ...result, synced: [], available: true, plain: plainLines.join('\n') };
  }
  const instrumental = looksInstrumental(result.plain) || Boolean(result.instrumental);
  return { ...result, synced: [], available: false, plain: '', instrumental };
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
