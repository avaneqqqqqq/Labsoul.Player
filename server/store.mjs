'use strict';

/**
 * Хранилище приложения: настройки источников, история прослушивания, обратная связь.
 * Всё лежит в player/data/ рядом с кодом (в Electron переопределяется через PLAYER_DATA_DIR).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = process.env.PLAYER_DATA_DIR
  ? path.resolve(process.env.PLAYER_DATA_DIR)
  : path.join(ROOT, 'data');

const FILES = {
  settings: path.join(DATA, 'settings.json'),
  history: path.join(DATA, 'history.jsonl'),
  feedback: path.join(DATA, 'feedback.jsonl'),
  log: path.join(DATA, 'server.log'),
};

const HISTORY_MAX_LINES = 5000;

function ensureDir() {
  try {
    fs.mkdirSync(DATA, { recursive: true });
  } catch {
    /* каталог уже есть или запрещён — работаем без файлов */
  }
}

/* ------------------------------- логи ---------------------------------- */

export function log(...args) {
  const line = `${new Date().toISOString()} ${args.map(String).join(' ')}`;
  console.log(line);
  try {
    ensureDir();
    // держим лог в разумных размерах
    try {
      const st = fs.statSync(FILES.log);
      if (st.size > 4 * 1024 * 1024) fs.renameSync(FILES.log, FILES.log + '.1');
    } catch { /* файла ещё нет */ }
    fs.appendFileSync(FILES.log, line + '\n');
  } catch { /* логи не должны ломать работу */ }
}

/* ----------------------------- настройки -------------------------------- */

/** Пустые значения-«заглушки», чтобы структура всегда была предсказуемой. */
const DEFAULT_SETTINGS = {
  yandex: { token: '', quality: 'nq' },
  soundcloud: { clientId: '', profileUrl: '', cookies: '', cookiesAt: 0 },
  spotify: { clientId: '', clientSecret: '' },
  // прокси: свой адрес или системный из Windows (нужно для доступа к SC из РФ)
  // autoProxy — автоматически подбирать и менять прокси для SoundCloud
  network: { proxy: '', useSystemProxy: false, autoProxy: true },
  // из каких источников собирать «Волну» (порядок = порядок в интерфейсе)
  wave: { sources: ['yandex', 'soundcloud'] },
};

export function loadSettings() {
  try {
    const raw = JSON.parse(fs.readFileSync(FILES.settings, 'utf8'));
    return mergeSettings(DEFAULT_SETTINGS, raw);
  } catch {
    return structuredClone(DEFAULT_SETTINGS);
  }
}

function mergeSettings(base, patch) {
  const out = structuredClone(base);
  if (!patch || typeof patch !== 'object') return out;
  for (const key of Object.keys(out)) {
    if (patch[key] && typeof patch[key] === 'object') {
      Object.assign(out[key], patch[key]);
    }
  }
  return out;
}

export function saveSettings(patch) {
  ensureDir();
  const merged = mergeSettings(loadSettings(), patch);
  fs.writeFileSync(FILES.settings, JSON.stringify(merged, null, 2), 'utf8');
  return merged;
}

/** Настройки для отдачи в UI: секреты замаскированы, но видно, что задано. */
export function maskedSettings() {
  const s = loadSettings();
  const mask = (v) => (v && String(v).length > 4 ? '••••' + String(v).slice(-4) : v ? '••••' : '');
  return {
    yandex: { token: mask(s.yandex.token), quality: s.yandex.quality, hasToken: Boolean(s.yandex.token) },
    soundcloud: { clientId: mask(s.soundcloud.clientId), hasClientId: Boolean(s.soundcloud.clientId), profileUrl: s.soundcloud.profileUrl, hasCookies: Boolean(s.soundcloud.cookies), cookiesAt: s.soundcloud.cookiesAt || 0 },
    spotify: {
      clientId: s.spotify.clientId || '',
      clientSecret: mask(s.spotify.clientSecret),
      hasCredentials: Boolean(s.spotify.clientId && s.spotify.clientSecret),
    },
    wave: { sources: Array.isArray(s.wave?.sources) ? s.wave.sources : ['yandex', 'soundcloud'] },
    network: {
      proxy: s.network?.proxy || '',
      hasProxy: Boolean(s.network?.proxy),
      useSystemProxy: Boolean(s.network?.useSystemProxy),
      // автоподбор прокси для SoundCloud: по умолчанию включён
      autoProxy: s.network?.autoProxy !== false,
    },
  };
}

/* ------------------------------ история --------------------------------- */

function appendJsonl(file, obj) {
  try {
    ensureDir();
    fs.appendFileSync(file, JSON.stringify(obj) + '\n');
  } catch (err) {
    log('не удалось записать', file, err.message);
  }
}

function readJsonl(file, limit) {
  try {
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    // при переполнении подрезаем файл, чтобы он не рос бесконечно
    if (lines.length > HISTORY_MAX_LINES) {
      fs.writeFileSync(file, lines.slice(-HISTORY_MAX_LINES).join('\n') + '\n');
    }
    const tail = lines.slice(-limit).reverse();
    return tail.map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
  } catch {
    return [];
  }
}

export function addHistory(entry) {
  if (!entry || !entry.track) return;
  appendJsonl(FILES.history, {
    at: new Date().toISOString(),
    track: entry.track,
    playedSeconds: Math.max(0, Math.round(Number(entry.playedSeconds) || 0)),
  });
}

export function getHistory(limit = 50) {
  return readJsonl(FILES.history, Math.min(Math.max(1, limit), 500));
}

export function addFeedback(entry) {
  appendJsonl(FILES.feedback, { at: new Date().toISOString(), ...entry });
}

export function getFeedback(limit = 200) {
  return readJsonl(FILES.feedback, Math.min(Math.max(1, limit), 2000));
}

export const paths = { ROOT, DATA };
