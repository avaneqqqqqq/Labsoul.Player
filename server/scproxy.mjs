/**
 * Автоподбор и самовосстановление прокси ТОЛЬКО для SoundCloud.
 *
 * Логика:
 *   1. при старте (и при обращении к SC) проверяем текущий прокси;
 *   2. если он мёртв — автоматически ищем новый в публичных списках,
 *      при этом проверяем именно РЕАЛЬНУЮ загрузку аудио SoundCloud;
 *   3. найденный сохраняем в настройки и применяем сразу;
 *   4. пока идёт поиск, SC-запросы уходят напрямую (не блокируют остальное).
 *
 * Яндекса, Spotify, тексты и обновления это не касается вообще — прокси
 * применяется только в провайдере SoundCloud.
 *
 * Систему можно полностью выключить в настройках (network.autoProxy = false):
 * тогда никакие прокси не подбираются и не применяются.
 */

import * as proxy from './proxy.mjs';
import * as finder from './proxyfind.mjs';
import * as store from './store.mjs';

let busy = false;
let lastAttemptAt = 0;
let lastResult = null;
let currentProxy = '';
let clientIdHint = '';
let trackIdHint = '2424504549';

const MIN_INTERVAL_MS = 60 * 1000; // не чаще раза в минуту

/** Включена ли система автоподбора (настройка пользователя). */
function enabled() {
  try {
    return store.loadSettings().network?.autoProxy !== false;
  } catch {
    return true;
  }
}

/** Настройки изменились: сбросить состояние, если автоподбор выключили. */
export async function syncSetting() {
  if (!enabled()) {
    await reset();
  }
}

/** Запомнить данные для проверки (client_id и эталонный трек). */
export function setProbeHints({ clientId, trackId } = {}) {
  if (clientId) clientIdHint = String(clientId);
  if (trackId) trackIdHint = String(trackId);
}

/** Текущий прокси, применённый для SoundCloud. */
export function current() {
  return currentProxy;
}

/** Последний результат поиска. */
export function last() {
  return lastResult;
}

/** Жив ли прокси: быстрая проверка реальной загрузки аудио. */
async function isUsable(proxyUrl) {
  if (!proxyUrl) return false;
  try {
    const result = await finder.canPlaySoundCloud(proxyUrl, {
      clientId: clientIdHint,
      trackId: trackIdHint,
    });
    return Boolean(result && result.ok);
  } catch {
    return false;
  }
}

/**
 * Проверить текущий прокси и, если он мёртв, найти новый.
 * Возвращает { ok, proxy, changed, message }.
 */
export async function ensure({ force = false, save } = {}) {
  if (busy) return { ok: Boolean(currentProxy), proxy: currentProxy, changed: false, message: 'поиск уже идёт' };

  if (!force && Date.now() - lastAttemptAt < MIN_INTERVAL_MS) {
    return { ok: Boolean(currentProxy), proxy: currentProxy, changed: false, message: 'недавно проверяли' };
  }

  busy = true;
  lastAttemptAt = Date.now();

  try {
    // 1) текущий прокси ещё жив?
    if (currentProxy && (await isUsable(currentProxy))) {
      lastResult = { ok: true, proxy: currentProxy, changed: false, message: 'текущий прокси работает' };
      return lastResult;
    }

    // 2) ищем новый, проверяя реальное аудио SoundCloud
    const found = await finder.findWorkingProxy({
      clientId: clientIdHint,
      trackId: trackIdHint,
    });

    if (found && found.ok) {
      const changed = found.proxy !== currentProxy;
      currentProxy = found.proxy;
      await proxy.refresh({ proxy: found.proxy, useSystemProxy: false });
      try {
        save?.({ proxy: found.proxy });
      } catch { /* сохранение не критично */ }
      lastResult = { ok: true, proxy: found.proxy, changed, message: `найден новый прокси: ${found.proxy}` };
      return lastResult;
    }

    currentProxy = '';
    await proxy.refresh({});
    lastResult = { ok: false, proxy: '', changed: true, message: (found && found.message) || 'рабочих прокси не нашлось' };
    return lastResult;
  } catch (err) {
    lastResult = { ok: Boolean(currentProxy), proxy: currentProxy, changed: false, message: (err && err.message) || 'ошибка' };
    return lastResult;
  } finally {
    busy = false;
  }
}

/** Задать прокси вручную (из настроек) и запомнить его для автопроверки. */
export async function adopt(proxyUrl) {
  currentProxy = proxyUrl || '';
  await proxy.refresh({ proxy: currentProxy, useSystemProxy: false });
  return currentProxy;
}

/** Забыть прокси (например, после полного отказа). */
export async function reset() {
  currentProxy = '';
  await proxy.refresh({});
}

/**
 * Вызывается провайдером при сетевом сбое:
 * просит автоподбор найти рабочий прокси и сообщает, стоит ли повторить запрос.
 */
// Автоподбор отключён: чиним SoundCloud обходом блокировки, а не прокси.
const AUTO_DISABLED = true;

export async function recover(error) {
  if (AUTO_DISABLED) return false;
  if (!enabled()) return false;
  // таймауты и обрывы — повод проверить прокси; 401/404 — нет
  const name = String((error && error.name) || '');
  const message = String((error && error.message) || '');
  if (/AUTH|NOT_FOUND|FORBIDDEN/i.test(message)) return false;
  if (!/Timeout|Abort|network|fetch|ECONN|ETIMEDOUT|UND_ERR/i.test(name + message)) return false;

  const before = currentProxy;
  const result = await ensure({ force: true });
  if (!result || !result.ok) return false;
  // повторяем запрос, только если прокси реально изменился
  return result.proxy && result.proxy !== before;
}
