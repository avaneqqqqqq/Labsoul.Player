/**
 * Преобразование аудио для воспроизведения.
 *
 * Зачем: SoundCloud отдаёт AAC в MP4-контейнере (audio/mp4). В Chrome/Electron
 * элемент <audio> воспроизводит такой поток нестабильно — трек «загружается»,
 * но play() не стартует (нет звука, нет ошибки). Проверено на живых треках:
 * контейнер валиден (ftyp/moov/mdat), кодек aac, но воспроизведение не идёт.
 *
 * Решение: пере-упаковываем AAC в обычный MP3 один раз при первом запросе и
 * кэшируем на диск. ffmpeg берётся из пакета ffmpeg-static — ничего доустанавливать
 * пользователю не нужно.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));

let ffmpegPath = null;
let cacheDir = null;

/**
 * Путь к встроенному ffmpeg.
 *
 * В собранном приложении сервер лежит в `resources/server`, а пакет ffmpeg-static
 * — в `resources/app.asar.unpacked/node_modules` (asarUnpack). В исходниках —
 * в `app/node_modules`. Проверяем все варианты по порядку.
 */
function resolveFfmpeg() {
  if (ffmpegPath !== null) return ffmpegPath;

  const candidates = [
    // 1) собранное приложение: resources/app.asar.unpacked/node_modules/ffmpeg-static
    path.join(HERE, '..', 'app.asar.unpacked', 'node_modules', 'ffmpeg-static', 'ffmpeg.exe'),
    // 2) рядом с сервером (если распаковали вручную)
    path.join(HERE, '..', 'node_modules', 'ffmpeg-static', 'ffmpeg.exe'),
    // 3) исходники: server/../app/node_modules
    path.join(HERE, '..', 'app', 'node_modules', 'ffmpeg-static', 'ffmpeg.exe'),
  ];

  try {
    // 4) путь из пакета (работает и в dev-режиме)
    const resolved = require('ffmpeg-static');
    if (resolved) {
      candidates.push(String(resolved).replace('app.asar', 'app.asar.unpacked'));
    }
  } catch { /* пакета нет — проверяем системный */ }

  // 5) системный ffmpeg (если пользователь поставил его сам)
  candidates.push(process.env.FFMPEG_PATH || '');

  for (const candidate of candidates) {
    try {
      if (candidate && fs.existsSync(candidate)) {
        ffmpegPath = candidate;
        return ffmpegPath;
      }
    } catch { /* путь недоступен */ }
  }

  ffmpegPath = '';
  return ffmpegPath;
}

export function configure({ dataDir } = {}) {
  const dir = dataDir || process.env.PLAYER_DATA_DIR
    || path.join(HERE, '..', 'data');
  cacheDir = path.join(dir, 'audio-cache');
  try {
    fs.mkdirSync(cacheDir, { recursive: true });
  } catch { /* кэш не критичен */ }
}

const memory = new Map(); // ключ → Buffer
const MAX_MEMORY = 12;

/**
 * Конвертирует AAC/MP4-буфер в MP3.
 * @param {Buffer} input
 * @returns {Promise<Buffer|null>} MP3-буфер или null, если ffmpeg недоступен
 */
export async function toMp3(input) {
  const exe = resolveFfmpeg();
  if (!exe) return null;

  return await new Promise((resolve) => {
    const args = [
      '-hide_banner', '-loglevel', 'error',
      '-f', 'mp4', '-i', 'pipe:0',
      '-vn', '-acodec', 'libmp3lame', '-b:a', '192k',
      // без ID3: нужен чистый MP3-поток для <audio>
      '-id3v2_version', '0', '-write_xing', '0',
      '-f', 'mp3', 'pipe:1',
    ];

    let child;
    try {
      child = spawn(exe, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch {
      resolve(null);
      return;
    }

    const chunks = [];
    let failed = false;

    child.stdout.on('data', (chunk) => chunks.push(chunk));
    child.stderr.on('data', () => { /* ошибки читаем по коду выхода */ });
    child.on('error', () => { failed = true; resolve(null); });
    child.on('close', (code) => {
      if (failed) return;
      if (code !== 0 || !chunks.length) { resolve(null); return; }
      resolve(Buffer.concat(chunks));
    });

    try {
      child.stdin.end(input);
    } catch {
      resolve(null);
    }
  });
}

/** Отдаёт MP3 для ключа: память → диск → конвертация. */
export async function getMp3(key, producer) {
  const cached = memory.get(key);
  if (cached) return cached;

  const file = cacheDir ? path.join(cacheDir, `${hashKey(key)}.mp3`) : null;
  if (file) {
    try {
      const data = fs.readFileSync(file);
      if (data.length > 1024) {
        remember(key, data);
        return data;
      }
    } catch { /* нет файла */ }
  }

  const source = await producer();
  if (!source || !source.length) return null;

  const mp3 = await toMp3(source);
  if (!mp3) return null;

  remember(key, mp3);
  if (file) {
    try { fs.writeFileSync(file, mp3); } catch { /* кэш не критичен */ }
  }
  return mp3;
}

function remember(key, data) {
  memory.set(key, data);
  if (memory.size > MAX_MEMORY) {
    const first = memory.keys().next().value;
    memory.delete(first);
  }
}

function hashKey(key) {
  return crypto.createHash('sha1').update(String(key)).digest('hex').slice(0, 24);
}

/** Доступен ли ffmpeg (для диагностики в интерфейсе). */
export function hasFfmpeg() {
  return Boolean(resolveFfmpeg());
}
