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

  for (const host of candidates) {
    try {
      const response = await probe(`${host}/rotor/stations/list`, {});
      if (response && (response.ok || response.status === 401 || response.status === 403)) {
        // 401/403 значит «хост живой, но нужен токен» — это нормально
        activeHost = host;
        checkedAt = Date.now();
        lastResult = { ok: true, host, at: new Date().toISOString() };
        return host;
      }
    } catch (err) {
      lastResult = { ok: false, host, error: (err && err.message) || 'недоступен', at: new Date().toISOString() };
    }
  }

  activeHost = null;
  checkedAt = Date.now();
  return null;
}

/** Сбросить выбор: пригодится при сетевой ошибке посреди работы. */
export function invalidate() {
  activeHost = null;
  checkedAt = 0;
}
