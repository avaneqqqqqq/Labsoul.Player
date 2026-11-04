/**
 * Автоподбор и запуск стратегии zapret.
 *
 * В сборке 23 стратегии (general, general (ALT), general (FAKE TLS AUTO)…).
 * Какая сработает — зависит от провайдера, угадать нельзя. Поэтому:
 *
 *   1. Если winws уже работает — ничего не трогаем (конфликт исключён).
 *   2. Иначе перебираем стратегии по порядку: запускаем одну, проверяем
 *      SoundCloud, не помогла — гасим и берём следующую.
 *   3. Запоминаем рабочую и в следующий раз поднимаем сразу её.
 *
 * Все запуски требуют прав администратора: Windows покажет окно UAC.
 * Если пользователь откажет — честно сообщаем, обход не включён.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';

import * as dpi from './dpi.mjs';
import * as store from './store.mjs';

/** Где помним рабочую стратегию. */
let stateFile = null;
let cachedGood = null;

export function configure({ dataDir } = {}) {
  const base = dataDir || process.env.PLAYER_DATA_DIR || path.join(process.cwd(), 'data');
  stateFile = path.join(base, 'zapret', 'strategy.json');
  try {
    cachedGood = JSON.parse(fs.readFileSync(stateFile, 'utf8'))?.good || null;
  } catch {
    cachedGood = null;
  }
}

function rememberGood(name) {
  cachedGood = name;
  try {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify({ good: name, at: Date.now() }, null, 2), 'utf8');
  } catch { /* не критично */ }
}

/** Порядок перебора: сначала та, что работала в прошлый раз. */
/**
 * Все стратегии в папке — для выбора в интерфейсе.
 *
 * У разных людей работают разные: зависит от провайдера и города.
 * Поэтому пользователь может выбрать сам, какая подходит.
 */
export function listStrategies() {
  const folders = dpi.findZapretFolders();
  if (!folders.length) return { folders: [], strategies: [] };

  const folder = folders[0];
  const strategies = strategyOrder(folder).map((name) => ({
    name,
    label: name.replace(/^general/i, 'Стратегия').replace(/\.bat$/i, ''),
    isDefault: name.toLowerCase() === 'general.bat',
    remembered: name === cachedGood,
  }));

  return { folder, folders, strategies, current: cachedGood };
}

function strategyOrder(folder) {
  let names = [];
  try {
    names = fs.readdirSync(folder)
      .filter((name) => /^general.*\.bat$/i.test(name))
      .sort((a, b) => {
        // general.bat — первым, дальше ALT по номеру, потом остальные
        const rank = (name) => (name.toLowerCase() === 'general.bat' ? 0 : 1);
        if (rank(a) !== rank(b)) return rank(a) - rank(b);
        return a.localeCompare(b, 'ru', { numeric: true });
      });
  } catch {
    return [];
  }

  if (cachedGood && names.includes(cachedGood)) {
    names = [cachedGood, ...names.filter((name) => name !== cachedGood)];
  }
  return names;
}

/** Запустить .bat с правами администратора. */
function launchElevated(script, folder) {
  return new Promise((resolve) => {
    if (!fs.existsSync(script)) {
      resolve({ ok: false, reason: 'нет файла' });
      return;
    }

    const command = [
      '-NoProfile',
      '-WindowStyle', 'Hidden',
      '-Command',
      `Start-Process -FilePath 'cmd.exe' -ArgumentList '/c','"${script}"' -WorkingDirectory '${folder}' -Verb RunAs`,
    ];

    execFile('powershell.exe', command, { timeout: 45_000, windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        const message = `${error.message} ${stderr || ''}`;
        const cancelled = /canceled|cancelled|отменен|отменён|1223|The operation was canceled/i.test(message);
        resolve({ ok: false, cancelled, reason: cancelled ? 'запрос прав отменён' : message.slice(0, 120) });
        return;
      }
      resolve({ ok: true });
    });
  });
}

/** Погасить текущий winws (только наши запуски, если он сам поднялся штатно — трогаем). */
function stopWinws() {
  return new Promise((resolve) => {
    execFile('taskkill', ['/IM', 'winws.exe', '/F'], { timeout: 8000, windowsHide: true }, () => resolve());
  });
}

/** Проверить, работает ли обход прямо сейчас. */
async function bypassWorks() {
  for (const url of ['https://soundcloud.com/', 'https://api-v2.soundcloud.com/resolve?url=https://soundcloud.com/miyagi']) {
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const response = await fetch(url, {
          signal: AbortSignal.timeout(6000),
          headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/136.0.0.0' },
        });
        if (response.status < 500) return true;
      } catch { /* следующая попытка */ }
    }
  }
  return false;
}

/**
 * Включить обход: поднять winws нужной стратегией, если он не работает.
 *
 * @returns {Promise<{ok:boolean, alreadyRunning?:boolean, started?:boolean, strategy?:string, message:string, needDownload?:boolean}>}
 */
export async function startBypass({ strategy = null } = {}) {
  /*
   * 1. winws уже работает.
   *
   * Если пользователь ВЫБРАЛ конкретную стратегию — её надо применить:
   * гасим текущий процесс и поднимаем выбранную. Иначе он нажимает
   * «включить», видит «обход уже работает», а фактически остаётся на
   * прежней стратегии — что и выглядело как «опять включается general».
   *
   * Если стратегия не выбрана — ничего не трогаем, второй winws не нужен.
   */
  const running = await dpi.detectRunning();
  if (running.running) {
    const works = await bypassWorks();
    const current = cachedGood;

    if (!strategy || strategy === current) {
      return {
        ok: true,
        alreadyRunning: true,
        works,
        strategy: current,
        message: works
          ? `Обход уже работает${current ? ` (${current})` : ''}`
          : 'Обход запущен, но SoundCloud не открывается — выберите другую стратегию',
      };
    }

    // просят другую стратегию — переключаем
    store.log(`[dpi] переключаю стратегию: ${current || 'текущая'} → ${strategy}`);
    await stopWinws();
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  // 2. ищем сборку
  const folders = dpi.findZapretFolders();
  if (!folders.length) {
    return {
      ok: false,
      needDownload: true,
      message: 'Сборка zapret не найдена. Скачайте её и положите на рабочий стол — после этого обход включится в один клик.',
    };
  }

  /*
   * Выбираем папку сборки.
   *
   * Если пользователь выбрал конкретную стратегию — пишем и запускаем
   * ИМЕННО её сборку. Стратегии внутри одной папки читают общие списки
   * (list-general, list-general-user, list-google), поэтому запись в
   * любую стратегию той же папки работает для ALT9, ALT11 и остальных.
   *
   * Когда стратегия не выбрана — берём первую найденную и пишем во все,
   * чтобы домены точно оказались там, где нужно.
   */
  let targetFolders = folders;
  let folder = folders[0];

  if (strategy) {
    const owner = folders.find((candidate) => fs.existsSync(path.join(candidate, strategy)));
    if (owner) {
      folder = owner;
      targetFolders = [owner];
      store.log(`[dpi] стратегия «${strategy}» найдена в ${owner}`);
    }
  }

  // домены во все списки выбранной сборки
  const written = dpi.addDomainsToZapret(targetFolders);
  const domains = written.reduce((sum, entry) => sum + (entry.added?.length || 0), 0);
  if (domains) store.log(`[dpi] доменов дописано: ${domains}`);

  // 3. перебираем стратегии
  let order = strategyOrder(folder);
  if (!order.length) return { ok: false, message: 'В папке zapret нет стратегий (general*.bat)' };

  /*
   * Выбор вручную: пользователь лучше знает, какая стратегия работает
   * у его провайдера. Если выбрана конкретная — пробуем только её.
   */
  if (strategy && order.includes(strategy)) {
    order = [strategy];
  }

  for (const name of order) {
    const script = path.join(folder, name);
    store.log(`[dpi] пробую стратегию «${name}»`);

    const launched = await launchElevated(script, folder);
    if (!launched.ok) {
      if (launched.cancelled) {
        return { ok: false, message: 'Без прав администратора обход не запустить — нажмите «Да» в окне запроса' };
      }
      continue;
    }

    // ждём подъёма и проверяем
    await new Promise((resolve) => setTimeout(resolve, 4000));
    const up = await dpi.detectRunning();
    if (!up.running) continue;

    const works = await bypassWorks();
    if (works) {
      rememberGood(name);
      store.log(`[dpi] стратегия «${name}» работает`);
      return { ok: true, started: true, strategy: name, message: `Обход включён (${name})` };
    }

    // не помогла — гасим и пробуем дальше
    store.log(`[dpi] стратегия «${name}» не помогла`);
    await stopWinws();
    await new Promise((resolve) => setTimeout(resolve, 800));
  }

  return { ok: false, message: 'Ни одна стратегия не сработала — возможно, нужна другая сборка zapret' };
}

/** Состояние для кнопки: работает ли обход и какая стратегия. */
export async function status() {
  const running = await dpi.detectRunning();
  return {
    running: running.running,
    strategy: cachedGood,
    folders: dpi.findZapretFolders(),
  };
}
