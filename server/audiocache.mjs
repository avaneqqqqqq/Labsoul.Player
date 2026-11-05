/**
 * Кэш аудио на диск.
 *
 * Зачем: трек, который уже звучал, при повторном прослушивании берётся с
 * диска — мгновенно и без сети. Это решает сразу три вещи:
 *
 *   1. Повтор не тратит суточный лимит SoundCloud (1500 прослушиваний).
 *   2. Не мешает блокировка: файл уже скачан.
 *   3. Перемотка назад не требует нового запроса.
 *
 * Храним готовый поток (буфер, который отдаёт провайдер) под именем
 * источника и трека. Ограничиваем общий размер, чтобы диск не забился.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import * as store from './store.mjs';

/** Сколько места разрешаем кэшу. По умолчанию 2 ГБ. */
const MAX_BYTES = Number(process.env.PLAYER_CACHE_BYTES) || 2 * 1024 * 1024 * 1024;

/** Сколько помним трек. Неделя — потом может обновиться. */
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

let dir = '';

/** Создать каталог кэша рядом с данными приложения. */
export function configure(dataDir) {
  const base = dataDir || process.env.PLAYER_DATA_DIR || path.join(process.cwd(), 'data');
  dir = path.join(base, 'audio-cache');
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    dir = '';
  }
}

/** Имя файла для трека: источник + id, плюс хэш, чтобы не было запрещённых символов. */
function fileFor(source, sourceId) {
  const safe = `${source}-${String(sourceId)}`.replace(/[^\w.-]+/g, '_').slice(0, 80);
  const hash = crypto.createHash('sha1').update(`${source}:${sourceId}`).digest('hex').slice(0, 8);
  return path.join(dir, `${safe}-${hash}.bin`);
}

/** Есть ли трек в кэше. */
export function has(source, sourceId) {
  if (!dir) return false;
  try {
    const file = fileFor(source, sourceId);
    const stat = fs.statSync(file);
    return stat.size > 0 && Date.now() - stat.mtimeMs < MAX_AGE_MS;
  } catch {
    return false;
  }
}

/** Прочитать трек из кэша. */
export function read(source, sourceId) {
  if (!dir) return null;
  try {
    const file = fileFor(source, sourceId);
    const buffer = fs.readFileSync(file);
    if (!buffer.length) return null;
    // обновляем время, чтобы редко слушаемое удалялось первым
    try { fs.utimesSync(file, new Date(), new Date()); } catch { /* ignore */ }
    return buffer;
  } catch {
    return null;
  }
}

/** Записать трек в кэш. Не мешает воспроизведению при ошибке. */
export function write(source, sourceId, buffer) {
  if (!dir || !buffer?.length) return false;
  try {
    const file = fileFor(source, sourceId);
    fs.writeFileSync(file, buffer);
    trim();
    return true;
  } catch (error) {
    store.log(`[cache] не удалось сохранить: ${error.message}`);
    return false;
  }
}

/**
 * Освободить место: удаляем самые старые файлы, пока не влезем в лимит.
 * Вызывается после записи, поэтому диск не растёт бесконечно.
 */
function trim() {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.bin'))
      .map((entry) => {
        const full = path.join(dir, entry.name);
        const stat = fs.statSync(full);
        return { full, size: stat.size, at: stat.mtimeMs };
      });

    let total = entries.reduce((sum, entry) => sum + entry.size, 0);
    if (total <= MAX_BYTES) return;

    // сначала удаляем те, что давно не открывались
    entries.sort((a, b) => a.at - b.at);
    for (const entry of entries) {
      if (total <= MAX_BYTES) break;
      try {
        fs.unlinkSync(entry.full);
        total -= entry.size;
      } catch { /* файл занят — пропускаем */ }
    }
  } catch { /* каталог недоступен */ }
}

/** Сколько занято и сколько файлов. */
export function stats() {
  if (!dir) return { dir: '', files: 0, bytes: 0, maxBytes: MAX_BYTES };
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile() && e.name.endsWith('.bin'));
    let bytes = 0;
    for (const entry of entries) {
      try { bytes += fs.statSync(path.join(dir, entry.name)).size; } catch { /* ignore */ }
    }
    return { dir, files: entries.length, bytes, maxBytes: MAX_BYTES };
  } catch {
    return { dir, files: 0, bytes: 0, maxBytes: MAX_BYTES };
  }
}

/** Очистить кэш. */
export function clear() {
  if (!dir) return 0;
  try {
    let count = 0;
    for (const entry of fs.readdirSync(dir)) {
      if (!entry.endsWith('.bin')) continue;
      try { fs.unlinkSync(path.join(dir, entry)); count += 1; } catch { /* ignore */ }
    }
    return count;
  } catch {
    return 0;
  }
}
