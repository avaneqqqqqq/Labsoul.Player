/**
 * Автообслуживание обхода блокировки.
 *
 * Задача: пользователь не должен ничего делать руками. Плеер сам замечает,
 * что сервис перестал открываться, подлечивает обход и проверяет снова.
 *
 * Что умеет:
 *   1. Проверяет доступность критичных хостов (SoundCloud, api-v2, CDN).
 *   2. Если хосты отвалились — дописывает домены в список zapret.
 *   3. Чинит пустой список IP: в сборке zapret есть отдельная ветка обхода
 *      по IP, и если ipset-all.txt остался заглушкой, половина соединений
 *      рвётся. Восстанавливаем из ipset-all.txt.backup.
 *   4. Перезапускает стратегию через general.bat — без этого новые
 *      домены не подхватываются.
 *   5. Ведёт журнал и не трогает обход чаще, чем раз в несколько минут,
 *      чтобы не конфликтовать с уже работающим Discord и YouTube.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';

import * as dpi from './dpi.mjs';
import * as store from './store.mjs';

/** Хосты, без которых SoundCloud не работает. */
const CHECK_HOSTS = [
  { name: 'soundcloud.com', url: 'https://soundcloud.com/', label: 'сайт SoundCloud' },
  { name: 'api-v2', url: 'https://api-v2.soundcloud.com/resolve?url=https://soundcloud.com/miyagi', label: 'API SoundCloud' },
  { name: 'CDN', url: 'https://i1.sndcdn.com/', label: 'хранилище обложек' },
];

/**
 * Минимальный интервал между правками обхода.
 * Если чинить чаще, можно помешать работающему Discord и YouTube:
 * перезапуск стратегии на несколько секунд обрывает их соединения.
 */
const REPAIR_COOLDOWN_MS = 10 * 60 * 1000;

const state = {
  lastCheck: 0,
  lastRepair: 0,
  lastResult: null,
  log: [],
};

function remember(entry) {
  state.log.unshift({ at: new Date().toISOString(), ...entry });
  if (state.log.length > 30) state.log.length = 30;
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Проверить один хост. Повторяем попытки: через обход первые соединения
 * часто обрываются, а третье проходит за доли секунды — это норма.
 */
async function checkHost(host, attempts = 3) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const started = Date.now();
    try {
      const response = await fetch(host.url, {
        signal: AbortSignal.timeout(7000),
        headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/136.0.0.0' },
      });
      // 401/403 — сервер жив, просто нужен ключ. Это успех для проверки связи.
      if (response.ok || response.status === 401 || response.status === 403 || response.status === 404) {
        return { host: host.name, label: host.label, ok: true, status: response.status, ms: Date.now() - started, attempt };
      }
    } catch { /* пробуем ещё раз */ }
    if (attempt < attempts) await pause(350);
  }
  return { host: host.name, label: host.label, ok: false, ms: 0, attempt: attempts };
}

/** Проверить все хосты параллельно. */
export async function check() {
  const results = await Promise.all(CHECK_HOSTS.map((host) => checkHost(host)));
  const failed = results.filter((result) => !result.ok);
  state.lastCheck = Date.now();
  state.lastResult = { ok: failed.length === 0, results, failed: failed.map((f) => f.label) };

  if (failed.length) remember({ action: 'check', ok: false, failed: state.lastResult.failed });
  return state.lastResult;
}

/**
 * Починить список IP в zapret.
 *
 * В стратегии general есть ветка «обход по IP» (ipset-all.txt). В сборках
 * этот файл иногда лежит заглушкой из одной строки — тогда соединения по
 * IP идут мимо обхода и рвутся. Рядом обычно есть полный бэкап.
 */
function repairIpSet(folders) {
  const fixed = [];

  for (const folder of folders) {
    const list = path.join(folder, 'lists', 'ipset-all.txt');
    const backup = `${list}.backup`;

    try {
      if (!fs.existsSync(list) || !fs.existsSync(backup)) continue;

      const current = fs.statSync(list).size;
      const full = fs.statSync(backup).size;

      // если список почти пустой, а бэкап полный — восстанавливаем
      if (current < 100_000 && full > 100_000) {
        fs.copyFileSync(backup, list);
        fixed.push({ folder, from: current, to: full });
        store.log(`[dpi] список IP восстановлен: ${folder} (${current} → ${full} байт)`);
      }
    } catch (error) {
      store.log(`[dpi] не удалось проверить список IP: ${error.message}`);
    }
  }

  return fixed;
}

/** Перезапустить стратегию zapret, чтобы новые списки подхватились. */
function restartStrategy(folder) {
  return new Promise((resolve) => {
    const script = path.join(folder, 'general.bat');
    if (!fs.existsSync(script)) {
      resolve({ ok: false, reason: 'нет general.bat' });
      return;
    }

    // останавливаем текущий winws
    execFile('taskkill', ['/IM', 'winws.exe', '/F'], { timeout: 8000, windowsHide: true }, () => {
      setTimeout(() => {
        try {
          // запускаем стратегию отдельно и без окна
          const child = spawn('cmd.exe', ['/c', script], {
            cwd: folder,
            detached: true,
            stdio: 'ignore',
            windowsVerbatimArguments: true,
          });
          child.unref();
          setTimeout(() => resolve({ ok: true }), 3500);
        } catch (error) {
          resolve({ ok: false, reason: error.message });
        }
      }, 1200);
    });
  });
}

/**
 * Полное лечение: домены + список IP + перезапуск стратегии.
 * Выполняется не чаще REPAIR_COOLDOWN_MS, чтобы не мешать Discord и YouTube.
 */
export async function repair({ force = false } = {}) {
  const now = Date.now();
  if (!force && now - state.lastRepair < REPAIR_COOLDOWN_MS) {
    const wait = Math.ceil((REPAIR_COOLDOWN_MS - (now - state.lastRepair)) / 60000);
    return { ok: false, skipped: true, message: `Обход уже правился недавно, следующая попытка через ${wait} мин` };
  }

  const folders = dpi.findZapretFolders();
  if (!folders.length) {
    remember({ action: 'repair', ok: false, reason: 'zapret не найден' });
    return { ok: false, message: 'Сборка zapret не найдена на компьютере' };
  }

  // 1. домены
  const domains = dpi.addDomainsToZapret(folders);
  const added = domains.reduce((sum, entry) => sum + (entry.added?.length || 0), 0);

  // 2. список IP
  const ipFixed = repairIpSet(folders);

  // 3. перезапуск — только если что-то поменяли
  let restarted = false;
  if (added || ipFixed.length) {
    for (const folder of folders) {
      const result = await restartStrategy(folder);
      if (result.ok) { restarted = true; break; }
    }
  }

  state.lastRepair = Date.now();
  remember({ action: 'repair', ok: true, added, ipFixed: ipFixed.length, restarted });

  return {
    ok: true,
    added,
    ipFixed: ipFixed.length,
    restarted,
    message: added || ipFixed.length
      ? `Обход обновлён: доменов ${added}, списков IP ${ipFixed.length}${restarted ? ', стратегия перезапущена' : ''}`
      : 'Обход в порядке, менять нечего',
  };
}

/**
 * Проверить и при необходимости починить.
 * @param {{force?: boolean}} options
 */
export async function ensure({ force = false } = {}) {
  const checkResult = await check();
  if (checkResult.ok) {
    remember({ action: 'ensure', ok: true });
    return { ok: true, checked: true, repaired: false, results: checkResult.results };
  }

  store.log(`[dpi] недоступно: ${checkResult.failed.join(', ')} — пробую починить`);
  const repairResult = await repair({ force });

  // перепроверяем после лечения
  await pause(2500);
  const after = await check();

  return {
    ok: after.ok,
    checked: true,
    repaired: repairResult.ok && !repairResult.skipped,
    repairMessage: repairResult.message,
    results: after.results,
    failed: after.failed,
  };
}

/** Журнал и состояние для интерфейса. */
export function report() {
  return {
    lastCheck: state.lastCheck,
    lastRepair: state.lastRepair,
    lastResult: state.lastResult,
    log: state.log,
    cooldownMs: REPAIR_COOLDOWN_MS,
  };
}

/** Сбросить паузу между правками (кнопка «проверить и починить»). */
export function resetCooldown() {
  state.lastRepair = 0;
}
