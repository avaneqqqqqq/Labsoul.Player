/**
 * Локальный кэш библиотеки и волны (вариант «Д»).
 *
 * Что кэшируем: избранное по сервисам и последние партии волны. Если сервис
 * недоступен (например, из РФ), приложение показывает ранее загруженное вместо
 * пустого экрана и помечает данные как «сохранённые».
 *
 * Логика простая: при успешном ответе кладём результат на диск; при ошибке
 * отдаём последнее сохранённое с пометкой stale=true и временем снимка.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // месяц: дольше — уже неактуально

let file = null;
let state = { likes: {}, wave: {} };

export function configure({ dataDir } = {}) {
  const dir = dataDir || process.env.PLAYER_DATA_DIR || path.join(HERE, '..', 'data');
  file = path.join(dir, 'library-cache.json');
  try {
    if (fs.existsSync(file)) {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      state = {
        likes: raw && typeof raw.likes === 'object' ? raw.likes : {},
        wave: raw && typeof raw.wave === 'object' ? raw.wave : {},
      };
    }
  } catch { /* битый кэш просто игнорируем */ }
}

function save() {
  if (!file) return;
  try {
    fs.writeFileSync(file, JSON.stringify(state), 'utf8');
  } catch { /* кэш не критичен */ }
}

const fresh = (entry) => entry && Array.isArray(entry.items) && Date.now() - (entry.at || 0) < MAX_AGE_MS;

/** Сохранить избранное сервиса. */
export function saveLikes(source, items) {
  if (!Array.isArray(items) || !items.length) return;
  state.likes[source] = { at: Date.now(), items: items.slice(0, 400) };
  save();
}

/** Последнее сохранённое избранное сервиса. */
export function loadLikes(source) {
  const entry = state.likes[source];
  if (!fresh(entry)) return null;
  return { items: entry.items, at: entry.at, stale: true };
}

/** Сохранить партию волны (для одной станции и набора источников). */
export function saveWave(key, items, station = null) {
  if (!Array.isArray(items) || !items.length) return;
  state.wave[key] = { at: Date.now(), station, items: items.slice(0, 120) };
  save();
}

/** Последняя сохранённая лента. */
export function loadWave(key) {
  const entry = state.wave[key];
  if (!fresh(entry)) return null;
  return { items: entry.items, station: entry.station, at: entry.at, stale: true };
}

export function stats() {
  return {
    likesSources: Object.keys(state.likes).length,
    waveKeys: Object.keys(state.wave).length,
    file,
  };
}
