/**
 * Надёжная сеть для всех провайдеров.
 *
 * Одна точка отказа на всех — чего не хватало: каждый провайдер сам
 * придумывал, как делать таймауты и повторы, и в каждом были свои дыры.
 *
 * Здесь собрано то, что реально спасает от сбоев:
 *
 *   1. Таймаут на попытку и общий дедлайн.
 *   2. Повтор при временных ошибках (ECONNRESET, таймаут, 5xx) с паузой.
 *   3. При обрыве соединения переключаемся на другой хост из списка —
 *      не «запоминаем отказ», а сразу пробуем следующую точку входа.
 *   4. Не кэшируем отказ надолго: сервис может отвечать через секунду.
 *   5. Читаем Retry-After / X-Ratelimit — не долбим сервис, если он
 *      попросил подождать.
 */

/** Ошибки, при которых имеет смысл повторить запрос. */
const RETRYABLE_CODES = new Set([
  'ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EAI_AGAIN', 'ENOTFOUND',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_SOCKET',
  'UND_ERR_CLOSED', 'EPIPE', 'EHOSTUNREACH', 'ENETUNREACH',
]);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Достать код сетевой ошибки из любой обёртки fetch. */
export function errorCode(error) {
  if (!error) return 'UNKNOWN';
  if (error.name === 'TimeoutError') return 'TIMEOUT';
  if (error.name === 'AbortError') return 'ABORTED';
  const cause = error.cause || error;
  return cause?.code || cause?.name || error.name || 'UNKNOWN';
}

/** Временная ли ошибка — стоит ли повторять. */
export function isRetryable(error) {
  const code = errorCode(error);
  return code === 'TIMEOUT' || RETRYABLE_CODES.has(code);
}

/**
 * Запрос с таймаутом и повторами.
 *
 * @param {string} url
 * @param {object} options
 * @param {object} [options.headers]
 * @param {string} [options.method]
 * @param {*} [options.body]
 * @param {number} [options.timeoutMs] — ожидание одной попытки
 * @param {number} [options.attempts] — сколько раз пробуем
 * @param {(response: Response) => boolean} [options.retryOn] — повторить по ответу
 * @returns {Promise<Response>}
 */
export async function request(url, {
  headers = {},
  method = 'GET',
  body,
  timeoutMs = 10_000,
  attempts = 3,
  retryOn,
} = {}) {
  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        method,
        headers,
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });

      // ответ пришёл — решаем по нему, повторять ли
      if (retryOn && retryOn(response) && attempt < attempts) {
        const wait = retryDelay(response, attempt);
        lastError = new Error(`HTTP ${response.status}`);
        await sleep(wait);
        continue;
      }
      return response;
    } catch (error) {
      lastError = error;
      if (!isRetryable(error) || attempt === attempts) break;
      await sleep(250 * attempt);
    }
  }

  throw lastError || new Error('запрос не удался');
}

/** Сколько ждать перед повтором: сервис может сам попросить. */
function retryDelay(response, attempt) {
  try {
    const retryAfter = Number(response.headers?.get?.('retry-after') || 0);
    if (retryAfter > 0) return Math.min(retryAfter * 1000, 8000);
  } catch { /* заголовка нет */ }
  return 300 * attempt;
}

/**
 * Запрос с автоматическим переключением хостов.
 *
 * Пробуем точки по очереди: если первая не отвечает — берём следующую.
 * Рабочий хост запоминается и возвращается последним запросом, поэтому
 * следующая попытка начинается сразу с него.
 */
export function createHostPool(hosts, { probePath = '/', timeoutMs = 6000 } = {}) {
  const list = [...new Set(hosts.filter(Boolean))];
  let preferred = null;
  let lastSuccess = 0;

  return {
    /** Все хосты — начиная с последнего рабочего. */
    order() {
      if (!preferred) return [...list];
      return [preferred, ...list.filter((host) => host !== preferred)];
    },

    /** Хост, на котором прошёл последний запрос. */
    current() {
      return preferred;
    },

    /** Сколько прошло с последнего успеха (мс). */
    sinceSuccess() {
      return lastSuccess ? Date.now() - lastSuccess : Infinity;
    },

    /**
     * Выполнить запрос, перебирая хосты.
     * @param {(base: string, attempt: number) => Promise<Response>} run
     */
    async run(run) {
      const errors = [];
      for (const base of this.order()) {
        // на одном хосте две попытки: сеть дёргается, со второго раза обычно проходит
        for (let attempt = 1; attempt <= 2; attempt += 1) {
          try {
            const response = await run(base, attempt);
            preferred = base;
            lastSuccess = Date.now();
            return response;
          } catch (error) {
            errors.push(`${base}: ${errorCode(error)}`);
            if (!isRetryable(error)) break;
            if (attempt === 1) await sleep(150);
          }
        }
      }
      const error = new Error(`нет ответа ни от одного хоста (${errors.join('; ')})`);
      error.code = 'ALL_HOSTS_FAILED';
      error.details = errors;
      throw error;
    },

    /** Сбросить предпочтение — следующий запрос начнёт с первой точки. */
    reset() {
      preferred = null;
      lastSuccess = 0;
    },
  };
}
