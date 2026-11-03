/**
 * Провайдер Spotify для локального плеера.
 *
 * Интерфейс — player/CONTRACT.md §4. Только node:-модули и глобальный fetch,
 * 0 npm-зависимостей.
 *
 * Авторизация: client credentials flow (client_id + client_secret), токен
 * кэшируется до истечения. С 27.11.2024 Web API новым приложениям не отдаёт
 * preview_url — это норма, трек при этом помечается playable:false,
 * reason:'not_streamable'.
 *
 * Ограничения Web API: 30-секундные превью (только если preview_url есть) —
 * полноценного стрима Spotify наружу не отдаёт.
 */

export const id = 'spotify';

const TOKEN_URL = 'https://accounts.spotify.com/api/token';
const API_ORIGIN = 'https://api.spotify.com/v1';

const TIMEOUT_MS = 15_000;
const TOKEN_SAFETY_MS = 60_000;
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const SPOTIFY_ID = /^[0-9A-Za-z]{22}$/;

/* ------------------------------------------------------------------ */
/* состояние                                                           */
/* ------------------------------------------------------------------ */

let configured = { clientId: '', clientSecret: '' };
let accessToken = '';
let accessTokenExpiresAt = 0;
let tokenPromise = null;

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
    return `Spotify: ${host} не ответил за ${timeout} мс`;
  }
  return `Spotify: сетевая ошибка при обращении к ${host}${code ? ` (${code})` : ''}`;
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
  try {
    return await fetch(url, {
      method,
      headers: { 'user-agent': USER_AGENT, accept: 'application/json', ...headers },
      body,
      redirect: 'follow',
      signal: AbortSignal.timeout(timeout),
    });
  } catch (error) {
    throw fail('UPSTREAM', networkMessage(url, error, timeout));
  }
}

async function httpText(url, options = {}) {
  const { timeout = TIMEOUT_MS } = options;
  const response = await httpFetch(url, { ...options, timeout });
  let text;
  try {
    text = await response.text();
  } catch (error) {
    throw fail('UPSTREAM', networkMessage(url, error, timeout));
  }
  return { ok: response.ok, status: response.status, body: text };
}

/* ------------------------------------------------------------------ */
/* токен                                                               */
/* ------------------------------------------------------------------ */

function credentials() {
  const clientId = String(configured.clientId || process.env.SPOTIFY_CLIENT_ID || '').trim();
  const clientSecret = String(configured.clientSecret || process.env.SPOTIFY_CLIENT_SECRET || '').trim();
  return { clientId, clientSecret };
}

function clearToken() {
  accessToken = '';
  accessTokenExpiresAt = 0;
  tokenPromise = null;
}

async function requestToken(clientId, clientSecret) {
  const basic = Buffer.from(`${clientId}:${clientSecret}`, 'utf8').toString('base64');
  const response = await httpText(TOKEN_URL, {
    method: 'POST',
    timeout: TIMEOUT_MS,
    headers: {
      authorization: `Basic ${basic}`,
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
    },
    body: 'grant_type=client_credentials',
  });

  if (response.status === 400 || response.status === 401 || response.status === 403) {
    throw fail('AUTH_FAILED', 'Spotify отклонил client_id/client_secret');
  }
  if (!response.ok) throw fail('UPSTREAM', `Spotify token endpoint ответил HTTP ${response.status}`);

  let data;
  try {
    data = JSON.parse(response.body);
  } catch {
    throw fail('UPSTREAM', 'Spotify token endpoint вернул некорректный JSON');
  }
  if (!data?.access_token) throw fail('AUTH_FAILED', 'Spotify не вернул access_token');

  const expiresIn = Math.max(60, Number(data.expires_in) || 3600);
  accessToken = String(data.access_token);
  accessTokenExpiresAt = Date.now() + expiresIn * 1000;
  return accessToken;
}

async function getToken(force = false) {
  const { clientId, clientSecret } = credentials();
  if (!clientId || !clientSecret) {
    throw fail(
      'NO_TOKEN',
      'Spotify не настроен: задайте SPOTIFY_CLIENT_ID и SPOTIFY_CLIENT_SECRET (или clientId/clientSecret в /api/settings)',
    );
  }
  if (!force && accessToken && Date.now() < accessTokenExpiresAt - TOKEN_SAFETY_MS) return accessToken;
  if (!tokenPromise) {
    tokenPromise = requestToken(clientId, clientSecret).finally(() => {
      tokenPromise = null;
    });
  }
  return tokenPromise;
}

/* ------------------------------------------------------------------ */
/* api.spotify.com                                                     */
/* ------------------------------------------------------------------ */

function apiUrl(pathname, params = {}) {
  // API_ORIGIN содержит путь /v1, поэтому склеиваем строками:
  // new URL('/search', '…/v1') потерял бы /v1.
  const url = new URL(`${API_ORIGIN}${pathname.startsWith('/') ? pathname : `/${pathname}`}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }
  return url;
}

async function callApi(pathname, params, token) {
  const url = apiUrl(pathname, params);
  return httpText(url.toString(), {
    timeout: TIMEOUT_MS,
    headers: { authorization: `Bearer ${token}` },
  });
}

async function apiJson(pathname, params = {}, { retry = true } = {}) {
  let token = await getToken();
  let response = await callApi(pathname, params, token);

  // Токен мог истечь раньше срока — обновляем и повторяем один раз.
  if (response.status === 401 && retry) {
    clearToken();
    token = await getToken(true);
    response = await callApi(pathname, params, token);
  }

  if (response.status === 401) throw fail('AUTH_FAILED', 'Spotify отклонил access_token (HTTP 401)');
  if (response.status === 403) throw fail('AUTH_FAILED', 'Spotify запретил доступ к ресурсу (HTTP 403)');
  if (response.status === 404) throw fail('NOT_FOUND', 'Spotify: трек не найден');
  if (response.status === 429) throw fail('UPSTREAM', 'Spotify ограничил частоту запросов (HTTP 429)');
  if (!response.ok) throw fail('UPSTREAM', `Spotify ответил HTTP ${response.status}`);

  try {
    return JSON.parse(response.body);
  } catch {
    throw fail('UPSTREAM', 'Spotify вернул некорректный JSON');
  }
}

function normalizeSourceId(sourceId) {
  const value = String(sourceId ?? '')
    .trim()
    .replace(/^spotify:/i, '');
  if (!SPOTIFY_ID.test(value)) throw fail('BAD_REQUEST', 'Некорректный Spotify id трека');
  return value;
}

async function fetchTrackRaw(sourceId) {
  const trackId = normalizeSourceId(sourceId);
  return apiJson(`/tracks/${encodeURIComponent(trackId)}`);
}

/* ------------------------------------------------------------------ */
/* маппинг Track                                                       */
/* ------------------------------------------------------------------ */

function mapTrack(raw) {
  const preview = raw?.preview_url ? String(raw.preview_url) : null;
  const images = Array.isArray(raw?.album?.images) ? raw.album.images : [];
  const cover = images.length && images[0]?.url ? String(images[0].url) : null;
  return {
    id: `spotify:${raw.id}`,
    source: 'spotify',
    sourceId: String(raw.id),
    // идентификатор первого исполнителя — для его страницы
    artistId: Array.isArray(raw?.artists) && raw.artists[0]?.id
      ? String(raw.artists[0].id)
      : null,
    title: String(raw.name || '').trim() || 'Без названия',
    artists: (Array.isArray(raw?.artists) ? raw.artists : [])
      .map((artist) => String(artist?.name || '').trim())
      .filter(Boolean),
    album: raw?.album?.name ? String(raw.album.name) : null,
    cover,
    duration: Math.max(0, Math.round(Number(raw?.duration_ms || 0) / 1000)),
    playable: Boolean(preview),
    reason: preview ? null : 'not_streamable',
    explicit: Boolean(raw?.explicit),
  };
}

/* ------------------------------------------------------------------ */
/* публичный интерфейс провайдера                                      */
/* ------------------------------------------------------------------ */

/**
 * @param {{clientId?: string, clientSecret?: string}} [cfg]
 */
export function configure(cfg = {}) {
  const next = {
    clientId: typeof cfg?.clientId === 'string' ? cfg.clientId.trim() : '',
    clientSecret: typeof cfg?.clientSecret === 'string' ? cfg.clientSecret.trim() : '',
  };
  if (next.clientId === configured.clientId && next.clientSecret === configured.clientSecret) return;
  configured = next;
  clearToken();
}

export async function status() {
  const { clientId, clientSecret } = credentials();
  if (!clientId || !clientSecret) {
    return {
      connected: false,
      error: {
        code: 'NO_TOKEN',
        message: 'Spotify не настроен: нужны client_id и client_secret',
      },
    };
  }
  try {
    await getToken();
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
export async function search(query, limit) {
  const text = String(query ?? '').trim();
  if (!text) throw fail('BAD_REQUEST', 'Пустой поисковый запрос');
  const size = clampInt(limit, 20, 1, 50);
  const data = await apiJson('/search', { q: text, type: 'track', limit: size });
  const items = Array.isArray(data?.tracks?.items) ? data.tracks.items : [];
  return items.filter(Boolean).map(mapTrack);
}

/**
 * @param {string} sourceId
 * @returns {Promise<object>} Track
 */
export async function track(sourceId) {
  return mapTrack(await fetchTrackRaw(sourceId));
}

/**
 * Топ-треки исполнителя в Spotify.
 *
 * Web API отдаёт их через `/artists/{id}/top-tracks` — отдельного id
 * трека не нужно, достаточно идентификатора исполнителя.
 *
 * @param {string} artistId
 * @param {number} limit
 */
export async function artistTracks(artistId, limit = 50) {
  const id = String(artistId || '').trim();
  if (!id) throw fail('BAD_REQUEST', 'Не указан исполнитель');

  const size = Math.min(Math.max(Number(limit) || 50, 1), 50);
  const data = await apiJson(`/artists/${encodeURIComponent(id)}/top-tracks`, {
    market: 'US',
  });
  const list = Array.isArray(data?.tracks) ? data.tracks.slice(0, size) : [];
  return { artistId: id, tracks: list.map(mapTrack).filter(Boolean) };
}

/** Имя и аватар исполнителя для заголовка страницы. */
export async function artistInfo(artistId) {
  const id = String(artistId || '').trim();
  if (!id) return null;
  try {
    const artist = await apiJson(`/artists/${encodeURIComponent(id)}`);
    if (!artist) return null;
    const images = Array.isArray(artist.images) ? artist.images : [];
    return {
      artistId: id,
      name: artist.name || '',
      cover: images[0]?.url || null,
    };
  } catch {
    return null;
  }
}

/**
 * Spotify Web API отдаёт только 30-секундное превью (если preview_url есть).
 * Полного стрима нет — при отсутствии preview_url бросаем NOT_PLAYABLE.
 *
 * @param {string} sourceId
 */
export async function stream(sourceId) {
  const raw = await fetchTrackRaw(sourceId);
  const preview = raw?.preview_url ? String(raw.preview_url) : null;
  if (!preview) {
    throw fail(
      'NOT_PLAYABLE',
      'Spotify не отдаёт аудио для этого трека: Web API вернул preview_url=null (норма для новых приложений с 27.11.2024)',
    );
  }
  return {
    url: preview,
    headers: {},
    contentType: 'audio/mpeg',
    repeatable: true,
  };
}

export async function wave() {
  throw fail('NOT_SUPPORTED', 'Spotify не поддерживает «Волну» — используйте поиск');
}

export async function feedback() {
  throw fail('NOT_SUPPORTED', 'Spotify не поддерживает feedback');
}

/* ------------------------------------------------------------------ */
/* отладочные хуки для _probe-sc.mjs (не часть контракта)              */
/* ------------------------------------------------------------------ */

export const _debug = {
  configured() {
    const { clientId, clientSecret } = credentials();
    return {
      clientId: clientId ? `${clientId.slice(0, 4)}***` : '',
      clientSecret: clientSecret ? '***' : '',
    };
  },
  hasToken() {
    return Boolean(accessToken) && Date.now() < accessTokenExpiresAt;
  },
};

/**
 * Плейлисты Spotify.
 *
 * Пользовательские плейлисты требуют авторизации конкретного слушателя
 * (PKCE + согласие в браузере), которой у стороннего приложения нет.
 * Честно сообщаем причину вместо пустого списка.
 */
export async function playlists() {
  return { items: [], reason: 'NOT_SUPPORTED' };
}

export async function playlistTracks() {
  return { items: [], reason: 'NOT_SUPPORTED' };
}

