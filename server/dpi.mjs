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
];

/** Домены, которые НЕ трогаем — у пользователя свой обход для них. */
export const AVOID_DOMAINS = [
  'youtube.com',
  'googlevideo.com',
  'ytimg.com',
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
 * Дописать домены SoundCloud в пользовательский список zapret.
 *
 * list-general-user.txt в папке lists — штатное место для своих доменов,
 * его подхватывает любая стратегия general*.bat при перезапуске.
 */
export function addDomainsToZapret(folders) {
  const results = [];

  for (const folder of folders) {
    const userList = path.join(folder, 'lists', 'list-general-user.txt');
    try {
      const existing = fs.existsSync(userList) ? fs.readFileSync(userList, 'utf8') : '';
      const lines = existing.split(/\r?\n/);
      const known = new Set(lines.map((line) => line.trim().toLowerCase()));
      const added = [];

      for (const domain of TARGET_DOMAINS) {
        if (!known.has(domain)) {
          lines.push(domain);
          known.add(domain);
          added.push(domain);
        }
      }

      // убираем заглушку, чтобы файл не выглядел пустым
      const cleaned = lines.filter((line) => line.trim() !== 'domain.example.abc');
      if (!cleaned.some((line) => line.trim().startsWith('#'))) {
        cleaned.unshift('# Домены SoundCloud (добавлено labsoul)');
      }

      if (added.length) fs.writeFileSync(userList, `${cleaned.join('\n').trimEnd()}\n`, 'utf8');
      results.push({ folder, file: userList, added });
    } catch (err) {
      results.push({ folder, file: userList, added: [], error: (err && err.message) || 'не удалось записать' });
    }
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

/** Проверка, открывается ли SoundCloud прямо сейчас. */
export async function probe() {
  const started = Date.now();
  try {
    const res = await fetch('https://soundcloud.com/', {
      signal: AbortSignal.timeout(10000),
      headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/136.0.0.0' },
    });
    return { ok: res.ok, status: res.status, ms: Date.now() - started };
  } catch (err) {
    return { ok: false, error: (err.cause && err.cause.code) || err.name, ms: Date.now() - started };
  }
}

/** Состояние для интерфейса. */
export function status() {
  return {
    dir,
    domains: TARGET_DOMAINS,
    avoid: AVOID_DOMAINS,
  };
}
