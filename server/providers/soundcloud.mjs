/**
 * Провайдер SoundCloud для локального плеера.
 *
 * Интерфейс — player/CONTRACT.md §4. Только node:-модули и глобальный fetch,
 * никаких npm-зависимостей. Все сетевые запросы ограничены таймаутом,
 * client_id нигде не логируется целиком.
 *
 * Как добывается client_id (первый успешный источник побеждает):
 *   1. settings      — PUT /api/settings → configure({clientId})
 *   2. env           — SOUNDCLOUD_CLIENT_ID
 *   3. m.soundcloud.com — в HTML лежит __NEXT_DATA__ c "clientId":"…" (рабочий путь в этой сети)
 *   4. soundcloud.com   — HTML → бандлы a-v2.sndcdn.com → regex client_id:"…" (как в контракте)
 *   5. публичные списки client_id (GitHub/HuggingFace) — последний рубеж
 * Каждый кандидат проверяется реальным запросом к api-v2 и кэшируется на 6 часов;
 * при 401 от api-v2 кэш сбрасывается и client_id добывается заново.
 *
 * stream(): progressive-транскодинг отдаём как {url}; HLS (у современных треков
 * progressive нет) скачиваем целиком — init.mp4 + все .m4s — и возвращаем
 * {buffer, contentType:'audio/mp4', repeatable:false}.
 */

export const id = 'soundcloud';

const API_ORIGIN = 'https://api-v2.soundcloud.com';
const DESKTOP_ORIGIN = 'https://soundcloud.com';
const MOBILE_ORIGIN = 'https://m.soundcloud.com';

const TIMEOUT_MS = 15_000;
const SCRAPE_TIMEOUT_MS = 12_000;
const CLIENT_ID_TTL_MS = 6 * 60 * 60 * 1000;
const CLIENT_ID_FAIL_TTL_MS = 60 * 1000;
const MAX_CLIENT_ID_CANDIDATES = 10;
const MAX_BUNDLES = 8;
const MAX_BUNDLE_BYTES = 6 * 1024 * 1024;
const MAX_LIST_BYTES = 3 * 1024 * 1024;

// Буфер HLS ограничен, чтобы 2-часовой DJ-сет не съел всю память.
const MAX_HLS_BYTES = 120 * 1024 * 1024;
const MAX_HLS_SEGMENTS = 4000;
const HLS_CONCURRENCY = 4;

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const CLIENT_ID_FORMAT = /^[0-9a-zA-Z]{32}$/;

// clientId (мобильный сайт), client_id (десктопные бандлы), client_id=… (URL внутри JS).
const CLIENT_ID_PATTERNS = [
  /client_?id["']?\s*[:=]\s*["']([0-9a-zA-Z]{32})["']/gi,
  /client_?id=([0-9a-zA-Z]{32})/gi,
];

// protocols, которые мы умеем отдавать. ctr/cbc-encrypted-hls не поддерживаем:
// такие треки помечаются playable:false / not_streamable.
const SUPPORTED_PROTOCOLS = new Set(['progressive', 'hls']);

// Публичные списки client_id — используются только если оба сайта недоступны.
const PUBLIC_CLIENT_ID_LISTS = [
  'https://huggingface.co/spaces/shadowx77/shadow-music-api/raw/main/app.py',
];

/* ------------------------------------------------------------------ */
/* состояние                                                           */
/* ------------------------------------------------------------------ */

let configuredClientId = '';
let validatedClientId = '';
let clientIdSource = '';
let clientIdAt = 0;
let acquirePromise = null;
let lastAcquire = null;
let lastFailError = null;
let lastFailAt = 0;

/* ------------------------------------------------------------------ */
/* ошибки в формате контракта {code, message}                          */
/* ------------------------------------------------------------------ */

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  error.message = message;
  return error;
}

function safeHost(url) {
  try {
    return new URL(url).host;
  } catch {
    return String(url);
  }
}

function networkMessage(url, error, timeout) {
  const name = String(error?.name || '');
  const code = String(error?.cause?.code || error?.code || '');
  const host = safeHost(url);
  if (name === 'TimeoutError' || name === 'AbortError' || /TIMEOUT/i.test(code)) {
    return `SoundCloud: ${host} не ответил за ${timeout} мс`;
  }
  return `SoundCloud: сетевая ошибка при обращении к ${host}${code ? ` (${code})` : ''}`;
}

function maskClientId(value) {
  const text = String(value || '');
  if (!text) return '(нет)';
  if (text.length <= 6) return `${text.slice(0, 2)}***`;
  return `${text.slice(0, 4)}***${text.slice(-2)}`;
}

function clampInt(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(number)));
}

/* ------------------------------------------------------------------ */
/* сетевые примитивы                                                   */
/* ------------------------------------------------------------------ */

async function httpFetch(url, { method = 'GET', headers = {}, body, timeout = TIMEOUT_MS } = {}) {
  const requestHeaders = {
    'user-agent': USER_AGENT,
    'accept-language': 'en-US,en;q=0.9',
    ...headers,
  };
  try {
    return await fetch(url, {
      method,
      headers: requestHeaders,
      body,
      redirect: 'follow',
      signal: AbortSignal.timeout(timeout),
    });
  } catch (error) {
    throw fail('UPSTREAM', networkMessage(url, error, timeout));
  }
}

async function httpText(url, { method = 'GET', headers = {}, body, timeout = TIMEOUT_MS, maxBytes = 0 } = {}) {
  const response = await httpFetch(url, { method, headers, body, timeout });
  if (maxBytes > 0) {
    const declared = Number(response.headers.get('content-length') || 0);
    if (declared > maxBytes) {
      try {
        await response.body?.cancel();
      } catch {
        /* ignore */
      }
      return { ok: false, status: response.status, body: '', truncated: true };
    }
  }
  let text;
  try {
    text = await response.text();
  } catch (error) {
    throw fail('UPSTREAM', networkMessage(url, error, timeout));
  }
  return { ok: response.ok, status: response.status, body: text };
}

async function httpBuffer(url, { headers = {}, timeout = TIMEOUT_MS } = {}) {
  const response = await httpFetch(url, { headers, timeout });
  let buffer;
  try {
    buffer = Buffer.from(await response.arrayBuffer());
  } catch (error) {
    throw fail('UPSTREAM', networkMessage(url, error, timeout));
  }
  return { ok: response.ok, status: response.status, buffer, headers: response.headers };
}

/* ------------------------------------------------------------------ */
/* добыча client_id                                                    */
/* ------------------------------------------------------------------ */

function extractClientIds(text) {
  const found = [];
  for (const pattern of CLIENT_ID_PATTERNS) {
    for (const match of String(text).matchAll(pattern)) {
      const value = match[1];
      if (CLIENT_ID_FORMAT.test(value) && !found.includes(value)) found.push(value);
    }
  }
  return found;
}

async function scrapeHtmlClientIds(url) {
  const page = await httpText(url, {
    timeout: SCRAPE_TIMEOUT_MS,
    headers: { accept: 'text/html,application/xhtml+xml' },
  });
  if (!page.ok) throw fail('UPSTREAM', `SoundCloud: ${safeHost(url)} ответил HTTP ${page.status}`);
  return extractClientIds(page.body);
}

function scriptSrcs(html) {
  const urls = [];
  const matches = String(html).matchAll(/<script[^>]+src=["']([^"']+)["']/gi);
  for (const match of matches) {
    let value = match[1].trim();
    if (!value) continue;
    if (value.startsWith('//')) value = `https:${value}`;
    else if (!/^https?:/i.test(value)) {
      try {
        value = new URL(value, DESKTOP_ORIGIN).toString();
      } catch {
        continue;
      }
    }
    if (/sndcdn\.com\//i.test(value) && !urls.includes(value)) urls.push(value);
  }
  // Бандлы a-v2 — те, что указаны в контракте; остальные sndcdn идут после.
  urls.sort((a, b) => Number(b.includes('a-v2.sndcdn.com')) - Number(a.includes('a-v2.sndcdn.com')));
  return urls;
}

/** Путь из контракта: HTML soundcloud.com → бандлы a-v2.sndcdn.com → regex client_id. */
async function scrapeDesktopClientIds() {
  const page = await httpText(`${DESKTOP_ORIGIN}/`, {
    timeout: SCRAPE_TIMEOUT_MS,
    headers: { accept: 'text/html,application/xhtml+xml' },
  });
  if (!page.ok) throw fail('UPSTREAM', `SoundCloud: soundcloud.com ответил HTTP ${page.status}`);

  const inline = extractClientIds(page.body);
  if (inline.length) return inline;

  const bundles = scriptSrcs(page.body).slice(0, MAX_BUNDLES);
  for (const bundleUrl of bundles) {
    try {
      const bundle = await httpText(bundleUrl, {
        timeout: SCRAPE_TIMEOUT_MS,
        maxBytes: MAX_BUNDLE_BYTES,
        headers: { accept: '*/*' },
      });
      if (!bundle.ok) continue;
      const found = extractClientIds(bundle.body);
      if (found.length) return found;
    } catch {
      // один битый бандл не должен ломать весь скрейп
    }
  }
  return [];
}

async function scrapePublicClientIds() {
  const found = [];
  for (const url of PUBLIC_CLIENT_ID_LISTS) {
    try {
      const response = await httpText(url, { timeout: SCRAPE_TIMEOUT_MS, maxBytes: MAX_LIST_BYTES });
      if (!response.ok) continue;
      for (const value of extractClientIds(response.body)) {
        if (!found.includes(value)) found.push(value);
      }
    } catch {
      // источник недоступен — пробуем следующий
    }
    if (found.length) break;
  }
  return found;
}

async function validateClientId(value) {
  const url = new URL('/search/tracks', API_ORIGIN);
  url.searchParams.set('q', 'soundcloud');
  url.searchParams.set('limit', '1');
  url.searchParams.set('client_id', value);
  try {
    const response = await httpText(url.toString(), {
      timeout: TIMEOUT_MS,
      headers: { accept: 'application/json' },
    });
    if (response.status !== 200) return false;
    const data = JSON.parse(response.body);
    return Array.isArray(data?.collection);
  } catch {
    return false;
  }
}

function setClientId(value, source) {
  validatedClientId = value;
  clientIdSource = source;
  clientIdAt = Date.now();
  lastFailError = null;
  lastFailAt = 0;
}

function invalidateClientId() {
  validatedClientId = '';
  clientIdAt = 0;
}

async function acquireClientId() {
  const startedAt = Date.now();
  const deadline = startedAt + 25_000;
  const attempts = [];
  const candidates = [];
  const addCandidate = (value, source) => {
    const text = String(value || '').trim();
    if (!CLIENT_ID_FORMAT.test(text)) return;
    if (candidates.some((candidate) => candidate.value === text)) return;
    candidates.push({ value: text, source });
  };

  // 1-2: настройки и переменная окружения
  addCandidate(configuredClientId, 'settings');
  addCandidate(process.env.SOUNDCLOUD_CLIENT_ID, 'env');

  // 3: мобильный сайт — единственный публичный хост SoundCloud, открывающийся в этой сети
  if (Date.now() < deadline) {
    try {
      const ids = await scrapeHtmlClientIds(`${MOBILE_ORIGIN}/`);
      attempts.push({ source: 'scrape m.soundcloud.com', ok: ids.length > 0, detail: `кандидатов: ${ids.length}` });
      for (const value of ids) addCandidate(value, 'scrape m.soundcloud.com');
    } catch (error) {
      attempts.push({ source: 'scrape m.soundcloud.com', ok: false, detail: error.message });
    }
  }

  // 4: десктопный сайт + бандлы a-v2.sndcdn.com
  if (Date.now() < deadline) {
    try {
      const ids = await scrapeDesktopClientIds();
      attempts.push({ source: 'scrape soundcloud.com', ok: ids.length > 0, detail: `кандидатов: ${ids.length}` });
      for (const value of ids) addCandidate(value, 'scrape soundcloud.com');
    } catch (error) {
      attempts.push({ source: 'scrape soundcloud.com', ok: false, detail: error.message });
    }
  }

  // 5: публичные списки
  if (Date.now() < deadline) {
    try {
      const ids = await scrapePublicClientIds();
      attempts.push({ source: 'public client_id lists', ok: ids.length > 0, detail: `кандидатов: ${ids.length}` });
      for (const value of ids) addCandidate(value, 'public client_id lists');
    } catch (error) {
      attempts.push({ source: 'public client_id lists', ok: false, detail: error.message });
    }
  }

  // Проверяем кандидатов по одному живым запросом к api-v2.
  for (const candidate of candidates.slice(0, MAX_CLIENT_ID_CANDIDATES)) {
    const valid = await validateClientId(candidate.value);
    attempts.push({
      source: candidate.source,
      ok: valid,
      detail: `${maskClientId(candidate.value)}${valid ? ' принят' : ' отклонён'}`,
    });
    if (!valid) continue;
    setClientId(candidate.value, candidate.source);
    lastAcquire = {
      ok: true,
      at: new Date().toISOString(),
      ms: Date.now() - startedAt,
      source: candidate.source,
      masked: maskClientId(candidate.value),
      attempts,
    };
    return candidate.value;
  }

  const error = fail(
    'AUTH_FAILED',
    'SoundCloud: не удалось получить рабочий client_id (сайты недоступны, ни один найденный ключ не принят)',
  );
  lastFailError = error;
  lastFailAt = Date.now();
  lastAcquire = {
    ok: false,
    at: new Date().toISOString(),
    ms: Date.now() - startedAt,
    attempts,
    error: { code: error.code, message: error.message },
  };
  throw error;
}

async function getClientId(force = false) {
  if (!force) {
    if (validatedClientId && Date.now() - clientIdAt < CLIENT_ID_TTL_MS) return validatedClientId;
    if (lastFailError && Date.now() - lastFailAt < CLIENT_ID_FAIL_TTL_MS) throw lastFailError;
  }
  if (!acquirePromise) {
    acquirePromise = acquireClientId().finally(() => {
      acquirePromise = null;
    });
  }
  return acquirePromise;
}

/* ------------------------------------------------------------------ */
/* api-v2                                                              */
/* ------------------------------------------------------------------ */

function apiUrl(pathname, params = {}) {
  const url = new URL(pathname, API_ORIGIN);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }
  return url;
}

async function callApi(pathname, params, clientId) {
  const url = apiUrl(pathname, params);
  url.searchParams.set('client_id', clientId);
  return httpText(url.toString(), { timeout: TIMEOUT_MS, headers: { accept: 'application/json' } });
}

async function apiJson(pathname, params = {}, { retry = true } = {}) {
  let clientId = await getClientId();
  let response = await callApi(pathname, params, clientId);

  // 401 — протух/отозван client_id: перевыпускаем и повторяем один раз.
  if (response.status === 401 && retry) {
    invalidateClientId();
    clientId = await getClientId(true);
    response = await callApi(pathname, params, clientId);
  }

  if (response.status === 401) throw fail('AUTH_FAILED', 'SoundCloud отклонил client_id (HTTP 401)');
  if (response.status === 404) throw fail('NOT_FOUND', 'SoundCloud: трек не найден');
  if (response.status === 403) throw fail('NOT_PLAYABLE', 'SoundCloud запретил доступ к треку (HTTP 403)');
  if (response.status === 429) throw fail('UPSTREAM', 'SoundCloud ограничил частоту запросов (HTTP 429)');
  if (!response.ok) throw fail('UPSTREAM', `SoundCloud ответил HTTP ${response.status}`);

  try {
    return JSON.parse(response.body);
  } catch {
    throw fail('UPSTREAM', 'SoundCloud вернул некорректный JSON');
  }
}

function normalizeSourceId(sourceId) {
  const value = String(sourceId ?? '')
    .trim()
    .replace(/^soundcloud:/i, '');
  if (!/^\d+$/.test(value)) throw fail('BAD_REQUEST', 'Некорректный SoundCloud id трека');
  return value;
}

async function fetchTrackRaw(sourceId) {
  const trackId = normalizeSourceId(sourceId);
  return apiJson(`/tracks/${encodeURIComponent(trackId)}`);
}

/* ------------------------------------------------------------------ */
/* маппинг Track                                                       */
/* ------------------------------------------------------------------ */

function upgradeArtworkUrl(url) {
  if (!url) return null;
  const text = String(url);
  if (/-t\d+x\d+\./i.test(text)) return text;
  return text.replace(/-large(\.[a-z]+)(\?.*)?$/i, '-t500x500$1$2');
}

function artistsOf(raw) {
  const names = [];
  const user = raw?.user?.username;
  if (user) names.push(String(user));
  const metaArtist = raw?.publisher_metadata?.artist;
  if (metaArtist && !names.some((name) => name.toLowerCase() === String(metaArtist).toLowerCase())) {
    names.push(String(metaArtist));
  }
  return names.length ? names : ['Неизвестный исполнитель'];
}

function availabilityOf(raw) {
  const policy = String(raw?.policy || '').toUpperCase();
  const monetization = String(raw?.monetization_model || '').toUpperCase();
  const transcodings = Array.isArray(raw?.media?.transcodings) ? raw.media.transcodings : [];

  if (raw?.streamable === false) return { playable: false, reason: 'not_streamable' };
  if (policy === 'SNIP' || monetization.startsWith('SUB_HIGH_TIER')) {
    return { playable: false, reason: 'go_plus' };
  }
  if (raw?.access === 'blocked' || policy === 'BLOCK') return { playable: false, reason: 'geo' };

  const usable = transcodings.some((transcoding) => {
    const protocol = String(transcoding?.format?.protocol || '').toLowerCase();
    return !transcoding?.snipped && SUPPORTED_PROTOCOLS.has(protocol);
  });
  if (!usable) return { playable: false, reason: 'not_streamable' };

  return { playable: true, reason: null };
}

function mapTrack(raw) {
  const availability = availabilityOf(raw);
  const durationMs = Number(raw?.full_duration || raw?.duration || 0);
  return {
    id: `soundcloud:${raw.id}`,
    source: 'soundcloud',
    sourceId: String(raw.id),
    title: String(raw.title || '').trim() || 'Без названия',
    artists: artistsOf(raw),
    album: raw?.publisher_metadata?.album_title ? String(raw.publisher_metadata.album_title) : null,
    cover: upgradeArtworkUrl(raw?.artwork_url) || upgradeArtworkUrl(raw?.user?.avatar_url),
    duration: Math.max(0, Math.round(durationMs / 1000)),
    playable: availability.playable,
    reason: availability.reason,
    explicit: Boolean(raw?.publisher_metadata?.explicit ?? raw?.explicit ?? false),
  };
}

/* ------------------------------------------------------------------ */
/* публичный интерфейс провайдера                                      */
/* ------------------------------------------------------------------ */

/**
 * @param {{clientId?: string}} [cfg] настройки источника (PUT /api/settings)
 */
export function configure(cfg = {}) {
  const next = typeof cfg?.clientId === 'string' ? cfg.clientId.trim() : '';
  if (next === configuredClientId) return;
  configuredClientId = next;
  // Пользовательский ключ имеет приоритет: сбрасываем прежний кэш.
  invalidateClientId();
  lastFailError = null;
  lastFailAt = 0;
}

export async function status() {
  try {
    await getClientId();
    return { connected: true };
  } catch (error) {
    return {
      connected: false,
      error: { code: error.code || 'UPSTREAM', message: error.message },
    };
  }
}

/**
 * @param {string} query
 * @param {number} [limit]
 * @returns {Promise<Array<object>>} Track[]
 */
/**
 * Лайкнутое из SoundCloud: /users/{id}/likes.
 *
 * Требует постоянного client_id (public client_id из браузера чужие лайки не
 * отдаёт — 401), поэтому берём его из настроек или переменной окружения.
 * Без client_id возвращаем понятную причину, а не пустой список.
 *
 * @param {number} limit
 * @param {string} [profileUrl]
 * @returns {Promise<{items: object[], reason?: string}>}
 */
export async function likes(limit = 100, profileUrl = '') {
  const size = clampInt(limit, 100, 1, 300);
  const permanents = [configuredClientId, process.env.SOUNDCLOUD_CLIENT_ID]
    .map((value) => String(value || '').trim())
    .filter(Boolean);
  if (!permanents.length) {
    return { items: [], reason: 'NO_CLIENT_ID' };
  }

  const clientId = permanents[0];
  const url = String(profileUrl || '').trim() || 'https://soundcloud.com/you';
  let userId = null;

  try {
    const resolved = JSON.parse(await callApi('/resolve', { url }, clientId));
    userId = resolved?.id ?? null;
  } catch (err) {
    return { items: [], reason: 'NO_PROFILE' };
  }
  if (!userId) return { items: [], reason: 'NO_PROFILE' };

  try {
    const data = JSON.parse(await callApi(`/users/${userId}/likes`, { limit: size, linked_partitioning: 1 }, clientId));
    const collection = Array.isArray(data?.collection) ? data.collection : [];
    const items = collection
      .map((entry) => entry?.track || entry)
      .filter((raw) => raw && raw.id)
      .map(mapTrack);
    return { items };
  } catch (err) {
    const reason = err?.status === 401 || /HTTP 40[13]/.test(String(err?.message)) ? 'CLIENT_ID_REJECTED' : 'UPSTREAM';
    return { items: [], reason };
  }
}

export async function search(query, limit) {
  const text = String(query ?? '').trim();
  if (!text) throw fail('BAD_REQUEST', 'Пустой поисковый запрос');
  const size = clampInt(limit, 20, 1, 50);
  const data = await apiJson('/search/tracks', {
    q: text,
    limit: size,
    linked_partitioning: 1,
    app_locale: 'en',
  });
  const collection = Array.isArray(data?.collection) ? data.collection : [];
  return collection.map(mapTrack);
}

/**
 * @param {string|number} sourceId
 * @returns {Promise<object>} Track
 */
export async function track(sourceId) {
  return mapTrack(await fetchTrackRaw(sourceId));
}

function transcodingRank(transcoding) {
  const protocol = String(transcoding?.format?.protocol || '').toLowerCase();
  const preset = String(transcoding?.preset || '').toLowerCase();
  if (protocol === 'progressive') return preset.startsWith('mp3_0') ? 0 : 1;
  if (protocol === 'hls') {
    if (preset.startsWith('aac_160')) return 2;
    if (preset.startsWith('aac_96')) return 3;
    if (preset.startsWith('mp3_')) return 4;
    if (preset === 'abr_sq') return 6;
    return 5;
  }
  return 9;
}

async function callTranscoding(transcodingUrl, clientId) {
  let url;
  try {
    url = new URL(transcodingUrl);
  } catch {
    throw fail('UPSTREAM', 'SoundCloud вернул некорректный URL транскодинга');
  }
  url.searchParams.set('client_id', clientId);
  return httpText(url.toString(), { timeout: TIMEOUT_MS, headers: { accept: 'application/json' } });
}

/** transcoding.url → {url, contentType} уже подписанного медиа-URL (живёт ограниченное время). */
async function resolveTranscoding(transcoding, { retry = true } = {}) {
  if (!transcoding?.url) throw fail('UPSTREAM', 'У транскодинга SoundCloud нет URL');
  let clientId = await getClientId();
  let response = await callTranscoding(transcoding.url, clientId);

  if (response.status === 401 && retry) {
    invalidateClientId();
    clientId = await getClientId(true);
    response = await callTranscoding(transcoding.url, clientId);
  }

  if (response.status === 404) throw fail('NOT_PLAYABLE', 'SoundCloud не отдал этот поток (HTTP 404)');
  if (response.status === 401) throw fail('AUTH_FAILED', 'SoundCloud отклонил client_id при запросе потока');
  if (!response.ok) throw fail('UPSTREAM', `SoundCloud не отдал поток (HTTP ${response.status})`);

  let data;
  try {
    data = JSON.parse(response.body);
  } catch {
    throw fail('UPSTREAM', 'SoundCloud вернул некорректный JSON при запросе потока');
  }
  if (!data?.url) throw fail('UPSTREAM', 'SoundCloud не вернул URL потока');

  return { url: String(data.url), contentType: transcoding?.format?.mime_type || null };
}

/** HLS → один буфер: init.mp4 + все сегменты по порядку (fMP4 остаётся валидным). */
async function hlsToBuffer(playlistUrl, transcoding) {
  const playlist = await httpText(playlistUrl, { timeout: TIMEOUT_MS, headers: { accept: '*/*' } });
  if (!playlist.ok) throw fail('UPSTREAM', `HLS-плейлист SoundCloud недоступен (HTTP ${playlist.status})`);
  const text = playlist.body;
  if (!text.includes('#EXTM3U')) throw fail('UPSTREAM', 'HLS-плейлист SoundCloud имеет неожиданный формат');

  const segments = [];
  for (const line of text.split(/\r?\n/)) {
    const value = line.trim();
    if (!value || value.startsWith('#')) continue;
    try {
      segments.push(new URL(value, playlistUrl).toString());
    } catch {
      /* мусорная строка — пропускаем */
    }
  }
  if (!segments.length) throw fail('UPSTREAM', 'В HLS-плейлисте SoundCloud нет сегментов');
  if (segments.length > MAX_HLS_SEGMENTS) {
    throw fail('NOT_SUPPORTED', `HLS-трек SoundCloud слишком длинный (${segments.length} сегментов)`);
  }

  const initMatch = text.match(/#EXT-X-MAP:URI="([^"]+)"/);
  let initUrl = null;
  if (initMatch) {
    try {
      initUrl = new URL(initMatch[1], playlistUrl).toString();
    } catch {
      initUrl = null;
    }
  }

  const parts = [];
  let total = 0;
  if (initUrl) {
    const init = await httpBuffer(initUrl, { timeout: TIMEOUT_MS });
    if (!init.ok) throw fail('UPSTREAM', `HLS init-сегмент SoundCloud недоступен (HTTP ${init.status})`);
    total += init.buffer.length;
    parts.push(init.buffer);
  }

  const chunks = new Array(segments.length);
  let cursor = 0;
  let failure = null;
  const worker = async () => {
    for (;;) {
      if (failure) return;
      const index = cursor;
      cursor += 1;
      if (index >= segments.length) return;
      try {
        const chunk = await httpBuffer(segments[index], { timeout: TIMEOUT_MS });
        if (!chunk.ok) {
          throw fail('UPSTREAM', `HLS-сегмент SoundCloud #${index} недоступен (HTTP ${chunk.status})`);
        }
        total += chunk.buffer.length;
        if (total > MAX_HLS_BYTES) {
          throw fail('NOT_SUPPORTED', `HLS-поток SoundCloud больше лимита буфера (${Math.round(MAX_HLS_BYTES / 1048576)} МБ)`);
        }
        chunks[index] = chunk.buffer;
      } catch (error) {
        failure = failure || error;
        throw error;
      }
    }
  };

  const workerCount = Math.min(HLS_CONCURRENCY, segments.length);
  try {
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
  } catch (error) {
    throw failure || error;
  }

  const mime = String(transcoding?.format?.mime_type || '').toLowerCase();
  const contentType = initUrl ? 'audio/mp4' : mime.includes('mp4') ? 'audio/mp4' : 'audio/mpeg';

  return {
    buffer: Buffer.concat([...parts, ...chunks]),
    contentType,
    segments: segments.length,
    hasInit: Boolean(initUrl),
  };
}

/**
 * stream:
 *  - progressive → {url, headers, contentType, repeatable:false}
 *  - hls         → {buffer, contentType:'audio/mp4', repeatable:false}
 * Подписанные ссылки SoundCloud живут ограниченное время, поэтому repeatable:false —
 * сервер будет заново спрашивать stream() на каждый Range-запрос.
 *
 * @param {string|number} sourceId
 */
export async function stream(sourceId) {
  const raw = await fetchTrackRaw(sourceId);
  const availability = availabilityOf(raw);

  if (!availability.playable) {
    if (availability.reason === 'go_plus') {
      throw fail('NOT_PLAYABLE', 'Трек доступен только в SoundCloud Go+ (полный звук недоступен)');
    }
    if (availability.reason === 'geo') throw fail('NOT_PLAYABLE', 'Трек заблокирован для этого региона');
    if (availability.reason === 'not_streamable') {
      throw fail('NOT_PLAYABLE', 'У трека нет доступного аудиопотока (только зашифрованный HLS или стрим отключён)');
    }
    throw fail('NOT_PLAYABLE', 'Трек недоступен для воспроизведения');
  }

  const transcodings = (Array.isArray(raw?.media?.transcodings) ? raw.media.transcodings : [])
    .filter((transcoding) => {
      const protocol = String(transcoding?.format?.protocol || '').toLowerCase();
      return !transcoding?.snipped && SUPPORTED_PROTOCOLS.has(protocol);
    })
    .sort((a, b) => transcodingRank(a) - transcodingRank(b));

  let lastError = null;
  // Не больше двух вариантов: если первый HLS-поток не скачался из-за сети,
  // повторять то же самое на другом качестве бессмысленно и долго.
  for (const transcoding of transcodings.slice(0, 2)) {
    const protocol = String(transcoding?.format?.protocol || '').toLowerCase();
    try {
      const resolved = await resolveTranscoding(transcoding);
      if (protocol === 'progressive') {
        return {
          url: resolved.url,
          headers: { 'user-agent': USER_AGENT },
          contentType: 'audio/mpeg',
          repeatable: false,
        };
      }
      const buffer = await hlsToBuffer(resolved.url, transcoding);
      return {
        buffer: buffer.buffer,
        contentType: buffer.contentType,
        repeatable: false,
      };
    } catch (error) {
      lastError = error;
    }
  }

  if (lastError && lastError.code) throw lastError;
  throw fail('NOT_PLAYABLE', 'SoundCloud не отдал ни одного аудиопотока для трека');
}

export async function wave() {
  throw fail('NOT_SUPPORTED', 'SoundCloud не поддерживает «Волну» — используйте поиск');
}

export async function feedback() {
  throw fail('NOT_SUPPORTED', 'SoundCloud не поддерживает feedback');
}

/* ------------------------------------------------------------------ */
/* отладочные хуки для _probe-sc.mjs (не часть контракта)              */
/* ------------------------------------------------------------------ */

export const _debug = {
  async clientId() {
    const value = await getClientId();
    return { masked: maskClientId(value), source: clientIdSource, acquire: lastAcquire };
  },
  lastAcquisition() {
    return lastAcquire;
  },
  async inspect(sourceId) {
    const raw = await fetchTrackRaw(sourceId);
    const availability = availabilityOf(raw);
    return {
      id: raw.id,
      title: raw.title,
      policy: raw.policy,
      monetization_model: raw.monetization_model,
      streamable: raw.streamable,
      access: raw.access,
      durationSec: Math.round(Number(raw.full_duration || raw.duration || 0) / 1000),
      playable: availability.playable,
      reason: availability.reason,
      artwork: raw.artwork_url,
      transcodings: (Array.isArray(raw?.media?.transcodings) ? raw.media.transcodings : []).map((transcoding) => ({
        preset: transcoding.preset,
        protocol: transcoding.format?.protocol,
        mime: transcoding.format?.mime_type,
        snipped: Boolean(transcoding.snipped),
        url: transcoding.url,
      })),
    };
  },
  async resolve(sourceId, protocol = 'hls') {
    const raw = await fetchTrackRaw(sourceId);
    const wanted = String(protocol).toLowerCase();
    const candidates = (Array.isArray(raw?.media?.transcodings) ? raw.media.transcodings : [])
      .filter((transcoding) => String(transcoding?.format?.protocol || '').toLowerCase() === wanted)
      .sort((a, b) => transcodingRank(a) - transcodingRank(b));
    if (!candidates.length) throw fail('NOT_FOUND', `У трека нет транскодинга ${wanted}`);
    const resolved = await resolveTranscoding(candidates[0]);
    return {
      protocol: wanted,
      preset: candidates[0].preset,
      mime: candidates[0].format?.mime_type,
      url: resolved.url,
    };
  },
};
