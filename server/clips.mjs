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
  /*
   * Два запроса разом:
   *   1) «исполнитель название клип» — ловит официальные видео;
   *   2) «исполнитель название» без слова «клип» — ловит те ролики,
   *      где слово не написано, но оно и есть нужное.
   * Раньше был один запрос, и если официального клипа нет, первым
   * выпадал посторонний ролик с похожим названием.
   */
  const queries = [
    [artist, name, 'клип'].filter(Boolean).join(' '),
    [artist, name].filter(Boolean).join(' '),
  ];

  const pages = await Promise.all(queries.map((query) => fetchResults(query, { title, artist })));
  const items = [];
  const seen = new Set();
  for (const page of pages) {
    for (const video of page) {
      if (seen.has(video.id)) continue;
      seen.add(video.id);
      items.push(video);
    }
  }

  // Сопоставление: ставим в начало то видео, которое действительно
  // соответствует треку. Первый результат поиска часто оказывается
  // кавером, slowed-версией или посторонним роликом — пользователю
  // не нужно выбирать вручную.
  const ranked = rankVideos(items, { title, artist });

  cache.set(key, { items: ranked, at: Date.now() });
  if (cache.size > 200) {
    const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) cache.delete(oldest[0]);
  }

  return ranked;
}

/** Запросить результаты поиска по одной строке. */
async function fetchResults(query, meta) {
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

  // fetchResults только собирает найденное; отбор делает searchClips
  return items;
}

/* ------------------------ сопоставление видео с треком ------------------- */

/** Привести строку к сравнимому виду: без регистра, знаков и лишних слов. */
function squash(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/\((?:feat|ft)[^)]*\)/g, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Насколько похожи две строки: 0…1 по общим словам. */
function overlap(a, b) {
  const left = new Set(squash(a).split(' ').filter((w) => w.length > 1));
  const right = new Set(squash(b).split(' ').filter((w) => w.length > 1));
  if (!left.size || !right.size) return 0;
  let common = 0;
  for (const word of left) if (right.has(word)) common += 1;
  return common / Math.max(left.size, right.size);
}

const BAD_WORDS = /slowed|reverb|nightcore|speed\s*up|8d\s*audio|instrumental|караоке|karaoke|минус|cover|кавер|reaction|реакция|tutorial|разбор/;
const GOOD_WORDS = /клип|official|официальн|премьера|premiere|mv|music\s*video|video|клип\b/;

/**
 * Оценить видео и расставить по убыванию соответствия треку.
 *
 * Учитывается: совпадение названия, наличие исполнителя в названии или
 * канале, «официальность» ролика и минусы за каверы, slowed и реакции.
 */
function rankVideos(items, { title, artist }) {
  const wantedTitle = squash(title);
  const wantedArtist = squash(artist);

  const scored = items.map((video, index) => {
    const haystack = `${video.title} ${video.author || ''}`;
    const nameScore = overlap(wantedTitle, video.title);
    const artistScore = wantedArtist ? overlap(wantedArtist, haystack) : 0;

    let score = nameScore * 3 + artistScore * 2;
    if (GOOD_WORDS.test(haystack)) score += 0.8;
    if (BAD_WORDS.test(haystack)) score -= 1.6;
    // порядок в поиске ещё что-то значит, но слабее текстового совпадения
    score -= index * 0.08;

    return { video, score, nameScore };
  });

  // без совпадения названия видео всё равно оставляем, но ниже
  scored.sort((a, b) => b.score - a.score);
  return scored.map((entry) => entry.video);
}
