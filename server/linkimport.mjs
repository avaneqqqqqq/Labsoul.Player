'use strict';

/**
 * Импорт трека по ссылке — без токенов и ключей.
 *
 * Spotify и SoundCloud отдают публичный oEmbed (название + обложка), Яндекс
 * умеет отдавать трек по id, если он подключён. Дальше мы ищем этот трек в
 * каталогах, которые реально умеют играть, — так ссылка из Spotify превращается
 * в трек, который можно послушать.
 */

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const TIMEOUT_MS = 15000;

function fail(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

export function detectService(rawUrl) {
  let parsed;
  try {
    parsed = new URL(String(rawUrl || '').trim());
  } catch {
    throw fail('BAD_REQUEST', 'Это не похоже на ссылку');
  }
  if (!/^https?:$/.test(parsed.protocol)) throw fail('BAD_REQUEST', 'Нужна http(s)-ссылка');

  const host = parsed.hostname.replace(/^www\./i, '').toLowerCase();
  if (host === 'open.spotify.com' || host === 'spotify.com') {
    return { service: 'spotify', url: parsed, spotifyId: (parsed.pathname.match(/\/(track|album|playlist)\/([A-Za-z0-9]+)/) || [])[2] || null };
  }
  if (/^music\.yandex\.(ru|com|by|kz|uz)$/.test(host)) {
    return { service: 'yandex', url: parsed, trackId: (parsed.pathname.match(/\btrack\/(\d+)/) || [])[1] || null };
  }
  if (host === 'soundcloud.com' || host.endsWith('.soundcloud.com')) {
    return { service: 'soundcloud', url: parsed };
  }
  throw fail('NOT_SUPPORTED', 'Поддерживаются ссылки Spotify, Яндекс.Музыки и SoundCloud');
}

async function fetchOembed(endpoint, targetUrl) {
  const url = `${endpoint}?${new URLSearchParams({ format: 'json', url: targetUrl })}`;
  let res;
  try {
    res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw fail('UPSTREAM', `Сервис недоступен: ${(err.cause && err.cause.code) || err.message}`);
  }
  if (!res.ok) throw fail('UPSTREAM', `Сервис ответил ${res.status}`);
  try {
    return await res.json();
  } catch {
    throw fail('UPSTREAM', 'Сервис вернул не-JSON');
  }
}

/** Разбирает «Artist — Title» / «Artist - Title» на части, если сервис отдал одной строкой. */
function splitTitle(value, fallbackArtist = '') {
  const text = String(value || '').trim();
  const match = text.match(/^(.{2,80}?)\s+[—–-]\s+(.{2,120})$/);
  if (match) return { artist: match[1].trim(), title: match[2].trim() };
  return { artist: String(fallbackArtist || '').trim(), title: text };
}

export async function resolveLink(rawUrl) {
  const info = detectService(rawUrl);

  if (info.service === 'spotify') {
    const data = await fetchOembed('https://open.spotify.com/oembed', info.url.toString());
    const parsedTitle = splitTitle(data.title);
    const cover = Array.isArray(data.thumbnail_url) ? data.thumbnail_url[0] : data.thumbnail_url;
    return {
      service: 'spotify',
      sourceId: info.spotifyId,
      title: parsedTitle.title || String(data.title || '').trim(),
      artists: parsedTitle.artist ? [parsedTitle.artist] : [],
      cover: cover || null,
      playable: false,
      note: 'Spotify отдаёт только метаданные — ищем играбельную версию в других каталогах.',
    };
  }

  if (info.service === 'soundcloud') {
    const data = await fetchOembed('https://soundcloud.com/oembed', info.url.toString());
    const author = String(data.author_name || '').trim();
    return {
      service: 'soundcloud',
      sourceId: null,
      title: String(data.title || '').trim(),
      artists: author ? [author] : [],
      cover: (data.thumbnail_url && String(data.thumbnail_url).replace('-t500x500', '-t500x500')) || null,
      playable: true,
      note: 'SoundCloud-ссылка: такой трек можно открыть в каталоге SoundCloud.',
    };
  }

  // Яндекс: если подключён — тянем полноценный трек по id, иначе только id из ссылки
  return {
    service: 'yandex',
    sourceId: info.trackId,
    title: '',
    artists: [],
    cover: null,
    playable: null,
    note: info.trackId
      ? 'Яндекс.Музыка: трек можно открыть по id, если аккаунт подключён.'
      : 'Не удалось разобрать ссылку Яндекс.Музыки.',
  };
}

/** Поиск играбельной версии в подключённых каталогах. */
export async function findCandidates(resolved, providers, limit = 3) {
  const query = [resolved.artists[0], resolved.title].filter(Boolean).join(' ').trim();
  if (!query) return [];
  const targets = ['yandex', 'soundcloud'].filter((name) => providers[name]);
  const results = await Promise.all(
    targets.map(async (source) => {
      try {
        const found = await providers[source].search(query, limit);
        return (Array.isArray(found) ? found : []).filter((t) => t.playable).slice(0, limit);
      } catch {
        return [];
      }
    }),
  );
  return results.flat();
}
