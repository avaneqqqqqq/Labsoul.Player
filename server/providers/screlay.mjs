/**
 * Релеи SoundCloud.
 *
 * Когда soundcloud.com заблокирован у провайдера, а zapret ставить не
 * хочется или нельзя — запросы идут через свой маленький сервер-посредник
 * на бесплатном хостинге. Он открывается напрямую из России (проверено),
 * а его сервер уже может достучаться до SoundCloud.
 *
 * Поддерживается несколько релеев: если первый не ответил, берём второй.
 * Порядок задаёт пользователь в настройках.
 *
 * Формат: <релей>/p/<полный адрес SoundCloud, закодированный>
 * Пример: https://labsoul.netlify.app/p/https%3A%2F%2Fapi-v2.soundcloud.com%2Ftracks%2F123
 */

/**
 * Релеи по умолчанию — два независимых.
 *
 * Первый на Netlify, второй на Cloudflare. Если один не ответил или
 * исчерпал лимит, запрос уходит через второй. Пользователю настраивать
 * ничего не нужно.
 */
export const DEFAULT_RELAYS = [
  'https://labsoul.netlify.app',
  'https://labsoul-relay.danil-chichov-za.workers.dev',
];

/** Первый из списка — основной. */
export const DEFAULT_RELAY = DEFAULT_RELAYS[0];

let relays = [];
let lastWorking = null;

/** Задать список релеев (адреса без хвостового слэша). */
export function configure(value) {
  const list = Array.isArray(value) ? value : String(value || '').split(/[\s,;]+/);
  relays = list
    .map((item) => String(item || '').trim().replace(/\/+$/, ''))
    .filter((item) => /^https?:\/\//i.test(item));
}

/** Есть ли хоть один релей. */
export function hasRelay() {
  return relays.length > 0;
}

/** Список для интерфейса. */
export function list() {
  return { relays: [...relays], working: lastWorking };
}

/** Превратить адрес SoundCloud в адрес через релей. */
export function wrap(relay, targetUrl) {
  return `${relay}/p/${encodeURIComponent(targetUrl)}`;
}

/**
 * Выполнить запрос с учётом релеев.
 *
 * Если релеи не заданы — обычный fetch напрямую.
 * Если заданы — идём через них; при сетевой ошибке пробуем следующий.
 *
 * @param {string} url — настоящий адрес SoundCloud
 * @param {(requestUrl: string) => Promise<Response>} perform — как отправлять
 */
export async function through(url, perform) {
  if (!relays.length) return perform(url);

  // рабочий релей — первым
  const order = lastWorking && relays.includes(lastWorking)
    ? [lastWorking, ...relays.filter((item) => item !== lastWorking)]
    : [...relays];

  let lastError = null;

  for (const relay of order) {
    try {
      const response = await perform(wrap(relay, url));
      // 5xx от релея — считаем сбоем релея, пробуем следующий
      if (response.status >= 500 && order.length > 1) {
        lastError = new Error(`релей ${relay} ответил ${response.status}`);
        continue;
      }
      lastWorking = relay;
      return response;
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error('ни один релей не ответил');
}

/** Сбросить запомненный рабочий релей. */
export function reset() {
  lastWorking = null;
}
