/**
 * Обход блокировки SoundCloud через zapret (WinDivert).
 *
 * Блокировка в РФ работает на уровне DPI: провайдер смотрит на TLS-пакеты
 * и рвёт соединения с доменами SoundCloud. zapret (winws.exe) перехватывает
 * наши пакеты и режет TLS на части так, что DPI не может собрать их обратно.
 * Трафик идёт напрямую, без прокси.
 *
 * Конфликты:
 *   • у большинства пользователей уже стоит zapret для YouTube и Discord;
 *   • второй winws запускать не нужно — дописываем домены SoundCloud
 *     в его список list-general-user.txt и просим перезапустить стратегию;
 *   • домены YouTube и Discord не трогаем — их обходит их установка.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Домены, которые нужно обходить для работы SoundCloud. */
export const TARGET_DOMAINS = [
  'soundcloud.com',
  'sndcdn.com',
  'soundcloud.cloud',
  'api-v2.soundcloud.com',
  'api-auth.soundcloud.com',
  'soundcloud.app.goo.gl',
  // YouTube нужен для клипов: без него поиск видео возвращает пустоту
  'youtube.com',
  'www.youtube.com',
  'youtu.be',
  'youtube-nocookie.com',
  'googlevideo.com',
  'ytimg.com',
];

/** Домены, которые НЕ трогаем — у пользователя свой обход для них. */
/**
 * Домены, которые НЕ трогаем.
 *
 * Discord не трогаем: у пользователя своя стратегия для него, и наши
 * правки могли помешать голосовой связи. YouTube, наоборот, нам нужен —
 * он в TARGET_DOMAINS, потому что без него не работают клипы.
 */
export const AVOID_DOMAINS = [
  'discord.com',
  'discordapp.com',
  'discord.gg',
];

let dir = '';

/** Каталог для наших файлов (если понадобится свой обход). */
export function configure({ dataDir } = {}) {
  const base = dataDir || process.env.PLAYER_DATA_DIR || path.join(HERE, '..', 'data');
  dir = path.join(base, 'zapret');
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    /* каталог может быть недоступен */
  }
}

/**
 * Найти папки установленного zapret.
 *
 * У людей сборка лежит где угодно: C:\zapret, рабочий стол, Загрузки.
 * Признак установки — файл bin\winws.exe.
 */
export function findZapretFolders() {
  if (process.platform !== 'win32') return [];

  const home = process.env.USERPROFILE || '';
  const roots = [
    'C:\\zapret',
    'C:\\zapret-discord-youtube',
    'C:\\Program Files\\zapret',
    path.join(home, 'Desktop'),
    path.join(home, 'Downloads'),
    path.join(home, 'Documents'),
  ].filter(Boolean);

  const found = new Set();

  const consider = (candidate) => {
    try {
      if (fs.existsSync(path.join(candidate, 'bin', 'winws.exe'))) found.add(candidate);
    } catch {
      /* путь недоступен */
    }
  };

  for (const root of roots) {
    consider(root);
    try {
      for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        if (/zapret|byedpi|goodbye/i.test(entry.name)) consider(path.join(root, entry.name));
      }
    } catch {
      /* каталога нет */
    }
  }

  return [...found];
}

/**
 * Списки zapret, куда дописываем домены SoundCloud.
 *
 * Почему все, а не один: разные сборки и разные стратегии подключают
 * разные списки. Если дописать только в list-general-user.txt, стратегия
 * вроде «general (ALT5)» использовать его не станет, и SoundCloud будет
 * рваться. Пишем во все основные списки — тогда подходит любая стратегия.
 *
 * Исключения НЕ трогаем: list-exclude*.txt — это «не обходить», запись
 * туда сделала бы хуже.
 */
export const WRITABLE_LISTS = [
  'list-general-user.txt',
  'list-general.txt',
  'list-google.txt',
];

/** Списки, которые нельзя трогать ни при каких условиях. */
const FORBIDDEN_LISTS = ['list-exclude.txt', 'list-exclude-user.txt'];

/**
 * Безопасная запись списка: сначала копия, потом запись, потом проверка.
 *
 * Если после записи файл стал меньше или потерял строки — откатываем.
 * Так обход не может «сломаться целиком» из-за нашей правки.
 */
function safeWriteList(file, nextContent) {
  const before = fs.readFileSync(file, 'utf8');
  const beforeLines = before.split(/\r?\n/).filter((line) => line.trim()).length;

  const backup = `${file}.labsoul-backup`;
  try {
    if (!fs.existsSync(backup)) fs.copyFileSync(file, backup);
  } catch { /* бэкап не критичен */ }

  fs.writeFileSync(file, nextContent, 'utf8');

  // проверка: строк стало не меньше, файл не пустой
  const after = fs.readFileSync(file, 'utf8');
  const afterLines = after.split(/\r?\n/).filter((line) => line.trim()).length;

  if (!afterLines || afterLines < beforeLines) {
    // что-то пошло не так — возвращаем как было
    fs.writeFileSync(file, before, 'utf8');
    throw new Error(`проверка не прошла (${beforeLines} → ${afterLines} строк), откат`);
  }
}

/**
 * Дописать домены SoundCloud во все рабочие списки zapret.
 *
 * Возвращает отчёт по каждой папке и каждому файлу.
 */
export function addDomainsToZapret(folders) {
  const results = [];

  for (const folder of folders) {
    const entry = { folder, files: [], added: [], skipped: [], errors: [] };

    for (const name of WRITABLE_LISTS) {
      if (FORBIDDEN_LISTS.includes(name)) continue;

      const file = path.join(folder, 'lists', name);
      try {
        if (!fs.existsSync(file)) {
          entry.skipped.push(name);
          continue;
        }

        const existing = fs.readFileSync(file, 'utf8');
        const lines = existing.split(/\r?\n/);
        // учитываем и «^домен» — синтаксис zapret для точного совпадения
        const known = new Set(lines.map((line) => line.trim().toLowerCase().replace(/^\^/, '')));
        const added = [];

        for (const domain of TARGET_DOMAINS) {
          if (!known.has(domain)) {
            lines.push(domain);
            known.add(domain);
            added.push(domain);
          }
        }

        if (!added.length) continue;

        // убираем заглушку, чтобы файл не выглядел пустым
        const cleaned = lines.filter((line) => line.trim() !== 'domain.example.abc');
        const next = `${cleaned.join('\n').trimEnd()}\n`;

        safeWriteList(file, next);
        entry.files.push(name);
        entry.added.push(...added);
      } catch (error) {
        entry.errors.push(`${name}: ${error.message}`);
      }
    }

    results.push(entry);
  }

  return results;
}

/** Есть ли запущенный обход (чужой или наш). */
export function detectRunning() {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') {
      resolve({ running: false });
      return;
    }
    execFile(
      'tasklist',
      ['/FI', 'IMAGENAME eq winws.exe', '/FO', 'CSV', '/NH'],
      { timeout: 5000, windowsHide: true },
      (err, stdout) => {
        if (err || !stdout) {
          resolve({ running: false });
          return;
        }
        const running = /winws\.exe/i.test(stdout);
        resolve({ running, name: running ? 'winws.exe' : null });
      },
    );
  });
}

/**
 * Проверка, открывается ли SoundCloud прямо сейчас.
 *
 * Через обход первые соединения после запуска часто обрываются по
 * таймауту, а следующие проходят за 70–200 мс (проверено: 17 из 20
 * успешных, все три сбоя — самые первые). Поэтому делаем несколько
 * попыток с коротким таймаутом, а не одну длинную: одна неудачная
 * проверка показывала в интерфейсе «SoundCloud не открывается», хотя
 * всё работало.
 */
export async function probe() {
  const started = Date.now();
  let lastError = null;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const res = await fetch('https://soundcloud.com/', {
        signal: AbortSignal.timeout(6000),
        headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/136.0.0.0' },
      });
      if (res.status < 500) {
        return { ok: true, status: res.status, ms: Date.now() - started, attempt };
      }
      lastError = `HTTP ${res.status}`;
    } catch (err) {
      lastError = (err.cause && err.cause.code) || err.name;
    }

    if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 400));
  }

  return { ok: false, error: lastError, ms: Date.now() - started, attempt: 3 };
}

/** Состояние для интерфейса. */
export function status() {
  return {
    dir,
    domains: TARGET_DOMAINS,
    avoid: AVOID_DOMAINS,
  };
}
