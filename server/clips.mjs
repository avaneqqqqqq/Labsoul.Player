/**
 * Клипы к трекам.
 *
 * Публичное API Яндекс.Музыки видео не отдаёт (полей clip/video в ответе нет
 * совсем), а Spotify клипы показывает только в своём клиенте. Поэтому ищем
 * видео на YouTube по «исполнитель + название» и отдаём список — играть
 * можно прямо в окне плеера или открыть в браузере.
 *
 * Ключ не нужен: страница результатов обычная, данные извлекаются из неё.
 */

const TIMEOUT_MS = 12_000;
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

/** Готовые ответы: один и тот же трек не ищем дважды. */
const cache = new Map();
const CACHE_TTL_MS = 60 * 60 * 1000;

function decodeTitle(raw) {
  return String(raw)
    .replace(/\\u0026/g, '&')
    .replace(/\\"/g, '"')
    .replace(/\\n/g, ' ')
    .replace(/\\\\/g, '\\');
}

/** Длительность вида «3:45» в секунды. */
function parseLength(text) {
  const parts = String(text || '').split(':').map(Number);
  if (parts.some((n) => !Number.isFinite(n)) || !parts.length) return 0;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

/**
 * Найти видео по треку.
 * @param {{title: string, artist: string}} meta
 * @returns {Promise<Array<{id: string, title: string, author: string, duration: number, thumb: string}>>}
 */
export async function searchClips({ title, artist }) {
  const name = String(title || '').trim();
  if (!name) return [];

  const key = `${artist || ''}|${name}`.toLowerCase();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.items;

  const query = [artist, name, 'клип'].filter(Boolean).join(' ');
  const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let html = '';
  try {
    const response = await fetch(url, {
      headers: {
        'user-agent': USER_AGENT,
        'accept-language': 'ru-RU,ru;q=0.9,en;q=0.8',
      },
      signal: controller.signal,
    });
    if (!response.ok) return [];
    html = await response.text();
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }

  // Пары «идентификатор видео + длительность» лежат в разметке рядом,
  // поэтому собираем в одном проходе по видео-блокам.
  const items = [];
  const seen = new Set();

  const videoBlocks = html.split('"videoRenderer":');
  for (const block of videoBlocks.slice(1)) {
    const idMatch = block.match(/"videoId":"([\w-]{11})"/);
    if (!idMatch) continue;
    const id = idMatch[1];
    if (seen.has(id)) continue;
    seen.add(id);

    const titleMatch = block.match(/"title":\{"runs":\[\{"text":"((?:[^"\\]|\\.)*)"/);
    const authorMatch = block.match(/"ownerText":\{"runs":\[\{"text":"((?:[^"\\]|\\.)*)"/);
    const lengthMatch = block.match(/"lengthText":\{"accessibility"[^}]*"simpleText":"([\d:]+)"/)
      || block.match(/"lengthText":\{[^}]*?"simpleText":"([\d:]+)"/);
    const thumbMatch = block.match(/"thumbnails":\[\{[^\]]*?"url":"(https:[^"]+)"/);

    items.push({
      id,
      title: titleMatch ? decodeTitle(titleMatch[1]) : 'Видео',
      author: authorMatch ? decodeTitle(authorMatch[1]) : '',
      duration: lengthMatch ? parseLength(lengthMatch[1]) : 0,
      thumb: thumbMatch ? decodeTitle(thumbMatch[1]) : `https://i.ytimg.com/vi/${id}/mqdefault.jpg`,
    });

    if (items.length >= 8) break;
  }

  cache.set(key, { items, at: Date.now() });
  if (cache.size > 200) {
    const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) cache.delete(oldest[0]);
  }

  return items;
}
