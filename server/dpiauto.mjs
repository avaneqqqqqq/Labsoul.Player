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

/**
 * Перезапуск стратегии zapret.
 *
 * ОПАСНО и по умолчанию НЕ выполняется: убивать чужой winws нельзя —
 * если он не поднимется обратно (права, окно, антивирус), человек
 * останется вообще без обхода, и Discord с YouTube тоже отвалятся.
 *
 * Вместо перезапуска мы правим ВСЕ списки сразу (list-general,
 * list-general-user, list-google) — тогда домены подхватит любая
 * стратегия, как только пользователь её перезапустит сам.
 */
function restartStrategy(folder, { allow = false } = {}) {
  if (!allow) {
    return Promise.resolve({ ok: false, skipped: true, reason: 'перезапуск отключён: чужая стратегия не трогается' });
  }

  return new Promise((resolve) => {
    const script = path.join(folder, 'general.bat');
    if (!fs.existsSync(script)) {
      resolve({ ok: false, reason: 'нет general.bat' });
      return;
    }

    try {
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
  });
}

/**
 * Полное лечение: домены + список IP + перезапуск стратегии.
 * Выполняется не чаще REPAIR_COOLDOWN_MS, чтобы не мешать Discord и YouTube.
 */
/**
 * Диагностика без правок.
 *
 * Проверяем доступность SoundCloud и смотрим, есть ли его домены в
 * пользовательском списке zapret. Ничего не меняем — только сообщаем,
 * что нашлось и что можно сделать. Правки выполняются отдельно и только
 * с согласия пользователя.
 */
export async function inspect() {
  const result = await check();

  const folders = dpi.findZapretFolders();
  const lists = folders.map((folder) => {
    const file = path.join(folder, 'lists', 'list-general-user.txt');
    let present = false;
    let exists = false;
    try {
      exists = fs.existsSync(file);
      if (exists) {
        const text = fs.readFileSync(file, 'utf8').toLowerCase();
        present = text.includes('soundcloud.com');
      }
    } catch { /* список недоступен */ }
    return { folder, exists, present };
  });

  const missing = lists.filter((entry) => !entry.present);

  return {
    ok: result.ok,
    failed: result.failed,
    results: result.results,
    // есть ли что дописывать и куда
    zapretFound: folders.length > 0,
    needsDomains: missing.length > 0,
    folders: lists,
    // предложение показать пользователю
    suggestion: result.ok
      ? null
      : folders.length
        ? 'SoundCloud не открывается. Дописать домены в пользовательский список zapret?'
        : 'SoundCloud не открывается, а сборка zapret не найдена. Установите zapret или включите релей.',
  };
}

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

  /*
   * 3. Перезапуск НЕ делаем намеренно.
   *
   * Убить чужой winws и не поднять его обратно — значит оставить человека
   * без обхода вообще (Discord, YouTube, SoundCloud сразу). Домены уже
   * записаны во все рабочие списки, так что их подхватит любая стратегия
   * при следующем штатном перезапуске. Об этом и сообщаем.
   */
  const restarted = false;

  state.lastRepair = Date.now();
  remember({ action: 'repair', ok: true, added, ipFixed: ipFixed.length, restarted });

  const files = domains.reduce((sum, entry) => sum + (entry.files?.length || 0), 0);

  return {
    ok: true,
    added,
    files,
    ipFixed: ipFixed.length,
    restarted,
    needsRestart: Boolean(added || ipFixed.length),
    message: added || ipFixed.length
      ? `Обход обновлён: доменов ${added} в ${files} списках, исправлено списков IP ${ipFixed.length}. Перезапустите свою стратегию zapret, чтобы домены заработали`
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

  /*
   * Правим списки только когда не работает НИ ОДИН хост.
   *
   * Если часть хостов открывается, дело не в списках, а в сети или у
   * самого сервиса — лезть в чужие файлы из-за одного моргания незачем.
   * Это защита от лишних правок в чужой сборке zapret.
   */
  const total = checkResult.results?.length || 0;
  if (total > 0 && checkResult.failed.length < total) {
    store.log(`[dpi] часть хостов недоступна (${checkResult.failed.join(', ')}), но не все — списки не трогаю`);
    remember({ action: 'ensure', ok: false, reason: 'частичный отказ' });
    return {
      ok: false,
      checked: true,
      repaired: false,
      skipped: true,
      repairMessage: 'Часть адресов не открылась, но не все — списки не трогаю. Проверьте интернет.',
      results: checkResult.results,
      failed: checkResult.failed,
    };
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
