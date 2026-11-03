/**
 * Устойчивость к недоступным хостам Яндекс.Музыки (вариант «А»).
 *
 * Из РФ `api.music.yandex.net` иногда не отвечает: соединение висит или
 * приходит ECONNRESET. Приложение должно само попробовать альтернативные
 * точки входа, а если не вышло — честно сказать «сервис недоступен из вашей
 * сети», а не показывать пустой список.
 */

const HOSTS = [
  'https://api.music.yandex.net',
  // запасные точки того же сервиса (тот же API, другая балансировка)
  'https://api.music.yandex.ru',
  // фронтовые хосты того же API: отвечают тем же контрактом
  'https://music.yandex.ru/api',
];

const CHECK_TTL_MS = 5 * 60 * 1000;
let activeHost = null;
let checkedAt = 0;
let lastResult = null;

/** Текущий рабочий хост Яндекса (или null, пока не проверяли). */
export function currentHost() {
  return activeHost;
}

/** Последняя диагностика: { ok, host, error, at }. */
export function diagnosis() {
  return lastResult;
}

/**
 * Проверяет доступность хостов и выбирает первый живой.
 * @param {(url:string, init:object)=>Promise<Response>} probe
 */
export async function resolveHost(probe, { force = false } = {}) {
  if (!force && activeHost && Date.now() - checkedAt < CHECK_TTL_MS) return activeHost;

  const envHost = process.env.YANDEX_API_BASE;
  const candidates = envHost ? [envHost.replace(/\/+$/, ''), ...HOSTS] : HOSTS;

  // Опрашиваем ВСЕ точки параллельно: при последовательном переборе таймаут
  // первого хоста (api.music.yandex.net блокируется в РФ) съедал всё время,
  // и рабочий запасной адрес даже не успевал ответить.
  const checks = candidates.map(async (host) => {
    try {
      const response = await probe(`${host}/rotor/stations/list`, {});
      if (response && (response.ok || response.status === 401 || response.status === 403)) {
        // 401/403 значит «хост живой, но нужен токен» — это нормально
        return host;
      }
      return null;
    } catch (err) {
      lastResult = { ok: false, host, error: (err && err.message) || 'недоступен', at: new Date().toISOString() };
      return null;
    }
  });

  // берём первый ответивший (по порядку приоритета в candidates)
  const results = await Promise.all(checks);
  const index = results.findIndex((value) => value);
  const chosen = index >= 0 ? results[index] : null;

  if (chosen) {
    activeHost = chosen;
    checkedAt = Date.now();
    lastResult = { ok: true, host: chosen, at: new Date().toISOString() };
    return chosen;
  }

  /*
   * Ни один хост не ответил.
   *
   * Раньше в этом месте ставился null И время проверки — на пять минут.
   * Один неудачный прогрев (сразу после запуска, когда соединения ещё
   * холодные) запирал Яндекс в «недоступен», пока не истечёт срок.
   * Теперь кэшируем отказ на короткое время и пробуем сами.
   */
  activeHost = null;
  checkedAt = Date.now() - CHECK_TTL_MS + FAIL_TTL_MS;

  if (!force) {
    // короткая пауза и один повтор: после запуска это обычно помогает
    await new Promise((resolve) => setTimeout(resolve, 400));
    return resolveHost(probe, { force: true });
  }

  return null;
}

/** Сбросить выбор: пригодится при сетевой ошибке посреди работы. */
export function invalidate() {
  activeHost = null;
  checkedAt = 0;
}
