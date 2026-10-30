/* =========================================================================
   labsoul — мелкие утилиты: DOM, строки, время, склонения, обработчики
   ========================================================================= */

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** Экранирование для шаблонных строк. */
export function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

export function hashString(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

export const pad2 = (n) => String(n).padStart(2, '0');

/** 213 → «3:33», 0 → «—» */
export function fmtDuration(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  if (!s) return '—';
  return `${Math.floor(s / 60)}:${pad2(s % 60)}`;
}

/** Секунды в «3:33», всегда с нулём (для таймлайна). */
export function fmtClock(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  return `${Math.floor(s / 60)}:${pad2(s % 60)}`;
}

const MONTHS = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];

/** ISO → ключ дня в локальном времени. */
export function dayKey(iso) {
  const d = iso ? new Date(iso) : new Date();
  if (Number.isNaN(d.getTime())) return 'unknown';
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** ISO → «Сегодня», «Вчера» или «29 окт». */
export function dayLabel(iso) {
  const d = iso ? new Date(iso) : new Date();
  if (Number.isNaN(d.getTime())) return 'Давно';
  const today = new Date();
  const start = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((start(today) - start(d)) / 864e5);
  if (diff === 0) return 'Сегодня';
  if (diff === 1) return 'Вчера';
  if (diff > 1 && diff < 7) return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'][d.getDay()]}`;
  return `${d.getDate()} ${MONTHS[d.getMonth()]}${d.getFullYear() !== today.getFullYear() ? ` ${d.getFullYear()}` : ''}`;
}

/** ISO → «21:48». */
export function fmtTimeOfDay(iso) {
  const d = iso ? new Date(iso) : null;
  if (!d || Number.isNaN(d.getTime())) return '';
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** Русские склонения: plural(5, ['трек', 'трека', 'треков']). */
export function plural(n, forms) {
  const abs = Math.abs(Number(n) || 0) % 100;
  const last = abs % 10;
  if (abs > 10 && abs < 20) return forms[2];
  if (last > 1 && last < 5) return forms[1];
  if (last === 1) return forms[0];
  return forms[2];
}

export const pluralTracks = (n) => `${n} ${plural(n, ['трек', 'трека', 'треков'])}`;
export const pluralMinutes = (n) => `${n} ${plural(n, ['минута', 'минуты', 'минут'])}`;

export const artistsLine = (track) => (track?.artists || []).join(', ');

export function debounce(fn, ms = 300) {
  let timer = 0;
  const wrapped = (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
  wrapped.cancel = () => clearTimeout(timer);
  wrapped.flush = (...args) => {
    clearTimeout(timer);
    fn(...args);
  };
  return wrapped;
}

export function isTypingTarget(el) {
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}

export function uid() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function readJSON(key, fallback = null) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function writeJSON(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export function readText(key, fallback = '') {
  try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
}
export function writeText(key, value) {
  try { localStorage.setItem(key, value); } catch { /* приватный режим */ }
}

/** Согласованная hsl-строка → hex (для canvas/палитр). */
export function hslToHex(h, s, l) {
  const hue = ((h % 360) + 360) % 360;
  const sat = clamp(s, 0, 100) / 100;
  const lig = clamp(l, 0, 100) / 100;
  const c = (1 - Math.abs(2 * lig - 1)) * sat;
  const hp = hue / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0; let g = 0; let b = 0;
  if (hp < 1) [r, g, b] = [c, x, 0];
  else if (hp < 2) [r, g, b] = [x, c, 0];
  else if (hp < 3) [r, g, b] = [0, c, x];
  else if (hp < 4) [r, g, b] = [0, x, c];
  else if (hp < 5) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const m = lig - c / 2;
  const to = (v) => Math.round((v + m) * 255).toString(16).padStart(2, '0');
  return `#${to(r)}${to(g)}${to(b)}`;
}

export function hexToRgb(hex) {
  const h = String(hex || '').replace('#', '');
  const n = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const v = parseInt(n, 16);
  if (Number.isNaN(v)) return { r: 0, g: 0, b: 0 };
  return { r: (v >> 16) & 255, g: (v >> 8) & 255, b: v & 255 };
}

/** Относительная яркость (WCAG) — для выбора цвета текста на акценте. */
export function luminance(hex) {
  const { r, g, b } = hexToRgb(hex);
  const f = (c) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

export const onAccentColor = (hex) => (luminance(hex) > 0.42 ? '#14130f' : '#ffffff');

/* Коды ошибок контракта → человеческий текст (статусы, группы поиска). */
const ERROR_LABELS = {
  NO_TOKEN: 'нужен токен',
  AUTH_FAILED: 'токен не подошёл',
  UPSTREAM: 'сервис не отвечает',
  NOT_FOUND: 'не найдено',
  BAD_REQUEST: 'ошибка запроса',
  NOT_SUPPORTED: 'не поддерживается',
  NOT_PLAYABLE: 'недоступно',
  OFFLINE: 'нет связи с сервером',
};

export function humanizeError(error) {
  if (!error) return '';
  const text = String(error).trim();
  if (ERROR_LABELS[text]) return ERROR_LABELS[text];
  const code = text.split(':')[0].trim();
  const rest = text.includes(':') ? text.slice(text.indexOf(':') + 1).trim() : '';
  if (ERROR_LABELS[code]) return rest || ERROR_LABELS[code];
  return text;
}

/** Безопасный вызов асинхронной функции без unhandled rejection. */
export function fire(promise, label = 'async') {
  Promise.resolve(promise).catch((err) => {
    console.warn(`[labsoul] ${label}:`, err);
  });
}
