/**
 * Автоподбор рабочего прокси для SoundCloud.
 *
 * Порядок:
 *   1) берём публичные списки прокси (несколько источников);
 *   2) быстрый отсев мёртвых (любой простой запрос);
 *   3) ГЛАВНАЯ проверка — реальная загрузка аудио SoundCloud через прокси:
 *      карточка трека → медиа-URL → скачивание первых килобайт.
 *      Прокси, который открыл API, но не отдал звук, отбрасывается.
 *   4) возвращаем первый подходящий.
 *
 * Это временная мера: публичные прокси живут часами. Для постоянной работы
 * нужен свой прокси (VPN-клиент или VPS).
 */

import { ProxyAgent, fetch as httpFetch } from 'undici';

const LIST_SOURCES = [
  { url: 'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt', kind: 'http' },
  { url: 'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/socks5.txt', kind: 'socks5' },
  { url: 'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt', kind: 'http' },
  { url: 'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/socks5.txt', kind: 'socks5' },
];

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';

/** Простая проверка «прокси вообще живой». */
const ALIVE_URL = 'http://httpbin.org/ip';

let cancelled = false;

/** Прервать текущий подбор. */
export function cancelSearch() {
  cancelled = true;
}

async function probe(dispatcher, url, timeout) {
  const started = Date.now();
  try {
    const response = await httpFetch(url, {
      dispatcher,
      signal: AbortSignal.timeout(timeout),
      headers: { 'user-agent': UA },
      redirect: 'manual',
    });
    return { ok: true, status: response.status, ms: Date.now() - started, response };
  } catch {
    return { ok: false, status: 0, ms: Date.now() - started };
  }
}

function makeAgent(proxyUrl) {
  try {
    return new ProxyAgent({
      uri: proxyUrl,
      connectTimeout: 6000,
      requestTls: { rejectUnauthorized: false },
      proxyTls: { rejectUnauthorized: false },
    });
  } catch {
    return null;
  }
}

/**
 * Главная проверка: скачивает ли прокси реальное аудио SoundCloud.
 *
 * @param {string} proxyUrl
 * @param {{clientId?: string, trackId?: string}} hint — рабочий client_id и трек
 */
export async function canPlaySoundCloud(proxyUrl, hint = {}) {
  const dispatcher = makeAgent(proxyUrl);
  if (!dispatcher) return { ok: false, reason: 'неверный адрес' };

  const clientId = hint.clientId;
  if (!clientId) return { ok: false, reason: 'нет client_id' };

  const trackId = hint.trackId;

  // 1) карточка трека (API) — короткий таймаут: мёртвый прокси отсеется сразу
  const trackProbe = await probe(
    dispatcher,
    `https://api-v2.soundcloud.com/tracks/${trackId}?client_id=${clientId}`,
    12000,
  );
  if (!trackProbe.ok || trackProbe.status !== 200) {
    return { ok: false, reason: `API ответил ${trackProbe.status || 'молчит'}` };
  }

  let track = null;
  try {
    track = await trackProbe.response.json();
  } catch {
    return { ok: false, reason: 'API вернул не JSON' };
  }

  const transcoding = track?.media?.transcodings?.[0];
  if (!transcoding?.url) return { ok: false, reason: 'нет аудиопотока у трека' };

  // 2) получаем прямой адрес медиа
  const resolveProbe = await probe(dispatcher, `${transcoding.url}?client_id=${clientId}`, 12000);
  if (!resolveProbe.ok || resolveProbe.status !== 200) {
    return { ok: false, reason: `медиа-URL не получен (${resolveProbe.status || 'молчит'})` };
  }

  let mediaUrl = '';
  try {
    mediaUrl = (await resolveProbe.response.json())?.url || '';
  } catch {
    return { ok: false, reason: 'медиа-ответ не JSON' };
  }
  if (!mediaUrl) return { ok: false, reason: 'пустой медиа-URL' };

  // 3) РЕАЛЬНАЯ загрузка звука — вот здесь отсеиваются «почти рабочие»
  const started = Date.now();
  try {
    const audio = await httpFetch(mediaUrl, {
      dispatcher,
      signal: AbortSignal.timeout(25000),
      headers: { 'user-agent': UA, Range: 'bytes=0-60000' },
    });
    if (!(audio.status === 200 || audio.status === 206)) {
      return { ok: false, reason: `аудио не отдаётся (${audio.status})` };
    }
    const buf = Buffer.from(await audio.arrayBuffer());
    if (buf.length < 8000) return { ok: false, reason: 'аудио пришло пустым' };
    return { ok: true, audioBytes: buf.length, audioMs: Date.now() - started };
  } catch (err) {
    return { ok: false, reason: `загрузка оборвалась (${(err.cause && err.cause.code) || err.name})` };
  }
}

async function loadCandidates(limit = 4000) {
  const out = [];
  for (const source of LIST_SOURCES) {
    try {
      const response = await fetch(source.url, { signal: AbortSignal.timeout(20000) });
      if (!response.ok) continue;
      const text = await response.text();
      for (const line of text.split('\n')) {
        const value = line.trim();
        if (/^\d{1,3}(\.\d{1,3}){3}:\d{1,5}$/.test(value)) {
          out.push(`${source.kind}://${value}`);
          if (out.length >= limit) return out;
        }
      }
    } catch { /* источник недоступен */ }
  }
  return out;
}

/**
 * Подобрать рабочий прокси.
 *
 * @param {{clientId:string, trackId:string, onProgress?:(p:object)=>void}} options
 */
export async function findWorkingProxy({ clientId, trackId, onProgress } = {}) {
  cancelled = false;
  const report = (payload) => {
    try { onProgress?.(payload); } catch { /* подписчик не должен ломать поиск */ }
  };

  report({ phase: 'lists', message: 'Загружаю списки прокси…' });
  const candidates = await loadCandidates();
  report({ phase: 'lists', found: candidates.length, message: `Кандидатов: ${candidates.length}` });

  if (!candidates.length) return { ok: false, message: 'Не удалось получить списки прокси' };

  const BATCH = 100;
  let checked = 0;

  for (let i = 0; i < candidates.length; i += BATCH) {
    if (cancelled) return { ok: false, cancelled: true, message: 'Поиск остановлен' };

    const batch = candidates.slice(i, i + BATCH);
    checked += batch.length;

    // 1) быстрый отсев: жив ли прокси вообще
    const alive = [];
    await Promise.all(
      batch.map(async (proxyUrl) => {
        const dispatcher = makeAgent(proxyUrl);
        if (!dispatcher) return;
        const result = await probe(dispatcher, ALIVE_URL, 5000);
        if (result.ok) alive.push(proxyUrl);
      }),
    );

    report({
      phase: 'scanning',
      checked,
      total: candidates.length,
      alive: alive.length,
      message: `Проверено ${checked} из ${candidates.length} · откликнулись ${alive.length}`,
    });

    // 2) главная проверка: реальное аудио SoundCloud
    for (const proxyUrl of alive) {
      if (cancelled) return { ok: false, cancelled: true, message: 'Поиск остановлен' };
      report({ phase: 'verifying', proxy: proxyUrl, message: `Проверяю ${proxyUrl} на аудио SoundCloud…` });
      const check = await canPlaySoundCloud(proxyUrl, { clientId, trackId });
      if (check.ok) {
        report({ phase: 'done', proxy: proxyUrl, message: `Найден рабочий прокси: ${proxyUrl}` });
        return { ok: true, proxy: proxyUrl, audioBytes: check.audioBytes, audioMs: check.audioMs };
      }
    }

    // если долго ничего нет — продолжаем, но первые партии самые живые
    if (checked >= 2400) break;
  }

  return { ok: false, message: 'Рабочих прокси не нашлось. Публичные прокси живут недолго — попробуйте позже.' };
}
