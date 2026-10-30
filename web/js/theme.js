/* =========================================================================
   labsoul — тема оформления.
   Единственный источник правды для токенов: JS меняет CSS-переменные,
   состояние хранится в localStorage['player-theme'] (ключ не переименовываем).
   ========================================================================= */

import { paletteFor, paletteFromCover } from './covers.js';
import { clamp, onAccentColor, readJSON, writeJSON } from './utils.js';

export const STORAGE_KEY = 'player-theme';

export const CARD_SIZE = { s: '154px', m: '178px', l: '206px' };

export const BLOCK_DEFS = [
  { id: 'hero', name: 'Шапка «Моя волна»', sub: 'станция, текущий трек, запуск', order: true },
  { id: 'shelf', name: 'Полка обложек', sub: 'карточки из свежей ленты', order: true },
  { id: 'feed', name: 'Лента треков', sub: 'основной список волны', order: true },
  { id: 'sbLib', name: 'Источники в сайдбаре', sub: 'статусы подключений' },
  { id: 'plLike', name: 'Кнопка «Нравится» в плеере' },
  { id: 'plProgress', name: 'Полоса прогресса в плеере' },
  { id: 'plVol', name: 'Громкость и источник в плеере' },
];

const BLOCK_IDS = new Set(BLOCK_DEFS.map((b) => b.id));
const ORDER_IDS = BLOCK_DEFS.filter((b) => b.order).map((b) => b.id);

export const PRESETS = [
  {
    id: 'midnight', name: 'Полночь', variant: 'glass', scheme: 'dark',
    accent: '#ffd23f', wallpaper: 'cover', radius: 22, blur: 24, font: 'ui', grain: true,
    swatch: 'linear-gradient(135deg,#ffd23f,#6ea8ff)',
  },
  {
    id: 'vinyl', name: 'Пластинка', variant: 'vinyl', scheme: 'dark',
    accent: '#d8a24a', wallpaper: 'solid', radius: 6, blur: 0, font: 'serif', grain: true,
    swatch: 'linear-gradient(135deg,#d8a24a,#2a1f14)',
  },
  {
    id: 'club', name: 'Клуб', variant: 'neon', scheme: 'dark',
    accent: '#b46bff', wallpaper: 'ocean', radius: 14, blur: 14, font: 'ui', grain: false,
    swatch: 'linear-gradient(135deg,#b46bff,#12e0c8)',
  },
  {
    id: 'paper', name: 'Бумага', variant: 'paper', scheme: 'light',
    accent: '#ff5a5f', wallpaper: 'solid', radius: 26, blur: 8, font: 'ui', grain: true,
    swatch: 'linear-gradient(135deg,#ff5a5f,#f3efe7)',
  },
  {
    id: 'aurora', name: 'Аврора', variant: 'glass', scheme: 'dark',
    accent: '#9ff3a0', wallpaper: 'aurora', radius: 20, blur: 22, font: 'ui', grain: true,
    swatch: 'linear-gradient(135deg,#0b1026,#9ff3a0)',
  },
  {
    id: 'mono', name: 'Монохром', variant: 'glass', scheme: 'amoled',
    accent: '#f5f5f7', wallpaper: 'none', radius: 16, blur: 6, font: 'mono', grain: false,
    swatch: 'linear-gradient(135deg,#f5f5f7,#101015)',
  },
];

export const DEFAULTS = {
  variant: 'glass',
  scheme: 'dark',
  accent: '#ffd23f',
  accentAuto: true,
  lyricsSize: 100,
  coverRadius: 22,
  lyricsAuto: false,
  barSeek: true,
  wallpaper: 'cover',
  density: 'normal',
  radius: 22,
  blur: 24,
  grain: true,
  anim: true,
  font: 'ui',
  cards: 'm',
  cols: 'auto',
  blocks: {
    hero: true, shelf: true, feed: true,
    sbLib: true, plLike: true, plProgress: true, plVol: true,
  },
  blockOrder: [...ORDER_IDS],
  eq: {
    on: true,
    preset: 'flat',
    preamp: 0,
    bands: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  },
};

const VARIANTS = new Set(['glass', 'vinyl', 'neon', 'paper']);
const SCHEMES = new Set(['dark', 'light', 'amoled']);
const DENSITIES = new Set(['compact', 'normal', 'roomy']);
const FONTS = new Set(['ui', 'serif', 'mono']);
const CARD_SIZES = new Set(['s', 'm', 'l']);
const WALLPAPERS = new Set(['cover', 'aurora', 'sunset', 'ocean', 'solid', 'none', 'custom']);

const subscribers = new Set();
let nowPlaying = null;
let palette = paletteFor(null);
let customWall = null;
let saveTimer = 0;

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function mergeEq(base, raw) {
  const out = { ...base };
  if (!raw || typeof raw !== 'object') return out;
  if (typeof raw.on === 'boolean') out.on = raw.on;
  if (typeof raw.preset === 'string') out.preset = raw.preset;
  if (Number.isFinite(raw.preamp)) out.preamp = clamp(Math.round(raw.preamp), -6, 6);
  if (Array.isArray(raw.bands) && raw.bands.length === 10) {
    out.bands = raw.bands.map((v) => clamp(Math.round(Number(v) || 0), -12, 12));
  }
  return out;
}

function normalizeTheme(raw) {
  const out = deepClone(DEFAULTS);
  if (!raw || typeof raw !== 'object') return out;

  if (VARIANTS.has(raw.variant)) out.variant = raw.variant;
  if (SCHEMES.has(raw.scheme)) out.scheme = raw.scheme;
  if (typeof raw.accent === 'string' && /^#[0-9a-f]{6}$/i.test(raw.accent)) out.accent = raw.accent;
  if (typeof raw.accentAuto === 'boolean') out.accentAuto = raw.accentAuto;
  if (Number.isFinite(raw.lyricsSize)) out.lyricsSize = clamp(Math.round(raw.lyricsSize), 85, 150);
  if (Number.isFinite(raw.coverRadius)) out.coverRadius = clamp(Math.round(raw.coverRadius), 0, 34);
  if (typeof raw.lyricsAuto === 'boolean') out.lyricsAuto = raw.lyricsAuto;
  if (typeof raw.barSeek === 'boolean') out.barSeek = raw.barSeek;
  if (WALLPAPERS.has(raw.wallpaper)) out.wallpaper = raw.wallpaper;
  if (DENSITIES.has(raw.density)) out.density = raw.density;
  if (Number.isFinite(raw.radius)) out.radius = clamp(Math.round(raw.radius), 0, 34);
  if (Number.isFinite(raw.blur)) out.blur = clamp(Math.round(raw.blur), 0, 48);
  if (typeof raw.grain === 'boolean') out.grain = raw.grain;
  if (typeof raw.anim === 'boolean') out.anim = raw.anim;
  if (FONTS.has(raw.font)) out.font = raw.font;
  if (CARD_SIZES.has(raw.cards)) out.cards = raw.cards;
  if (['auto', '2', '3', '4', '5', '6'].includes(String(raw.cols))) out.cols = String(raw.cols);

  if (raw.blocks && typeof raw.blocks === 'object') {
    for (const id of BLOCK_IDS) {
      if (typeof raw.blocks[id] === 'boolean') out.blocks[id] = raw.blocks[id];
    }
  }
  if (Array.isArray(raw.blockOrder)) {
    const seen = new Set();
    const order = [];
    for (const id of raw.blockOrder) {
      if (ORDER_IDS.includes(id) && !seen.has(id)) { seen.add(id); order.push(id); }
    }
    for (const id of ORDER_IDS) if (!seen.has(id)) order.push(id);
    out.blockOrder = order;
  }
  out.eq = mergeEq(out.eq, raw.eq);

  if (typeof raw.customWall === 'string' && raw.customWall.startsWith('data:image/')) {
    out.customWall = raw.customWall;
  }
  return out;
}

function persisted(themeValue) {
  const copy = deepClone(themeValue);
  if (copy.customWall && copy.customWall.length > 1_400_000) delete copy.customWall;
  return copy;
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = 0;
    const data = persisted(theme);
    if (!writeJSON(STORAGE_KEY, data)) {
      // квота localStorage: обои могут не влезть — сохраняем тему без них
      const withoutWall = { ...data };
      delete withoutWall.customWall;
      writeJSON(STORAGE_KEY, withoutWall);
    }
  }, 140);
}

function emit() {
  for (const fn of subscribers) {
    try { fn(theme, { nowPlaying, palette, customWall }); } catch { /* не ломаем тему */ }
  }
}

/** Текущее состояние темы — живой объект. Не мутируйте напрямую, используйте update(). */
export const theme = normalizeTheme(readJSON(STORAGE_KEY, null));
customWall = theme.customWall || null;

export function subscribe(fn) {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

export function currentAccent() {
  if (theme.accentAuto && palette?.accent) return palette.accent;
  return theme.accent;
}

export function currentPalette() {
  return palette;
}

export function nowPlayingTrack() {
  return nowPlaying;
}

function wallpaperLayers() {
  const { a, b, c } = palette || {};
  switch (theme.wallpaper) {
    case 'custom':
      return customWall
        ? `linear-gradient(rgba(4, 4, 8, .46), rgba(4, 4, 8, .58)), url("${customWall}")`
        : 'none';
    case 'aurora':
      return 'radial-gradient(80% 60% at 20% 0%, rgba(27,107,90,.9), transparent 60%), radial-gradient(70% 60% at 80% 10%, rgba(216,255,107,.35), transparent 60%), linear-gradient(160deg,#050816,#071a19 60%,#0b2c26)';
    case 'sunset':
      return 'radial-gradient(70% 60% at 15% 0%, rgba(255,95,109,.6), transparent 60%), radial-gradient(60% 70% at 90% 15%, rgba(255,195,113,.45), transparent 65%), linear-gradient(160deg,#1a0b23,#3d1430 55%,#5a2038)';
    case 'ocean':
      return 'radial-gradient(70% 60% at 18% 0%, rgba(11,110,122,.85), transparent 62%), radial-gradient(60% 60% at 85% 12%, rgba(159,243,224,.3), transparent 60%), linear-gradient(160deg,#021019,#032430 60%,#04313a)';
    case 'cover':
      return `radial-gradient(70% 55% at 14% 6%, color-mix(in srgb, ${a || '#6ea8ff'} 64%, transparent) 0%, transparent 62%),
              radial-gradient(60% 60% at 88% 16%, color-mix(in srgb, ${c || '#ffd23f'} 56%, transparent) 0%, transparent 66%),
              linear-gradient(165deg, color-mix(in srgb, ${a || '#6ea8ff'} 20%, transparent), transparent 58%)`;
    case 'solid':
    case 'none':
    default:
      return 'none';
  }
}

/** CSS-фон: вуаль обязательна, иначе панели теряют контраст. */
export function wallpaperCss() {
  const layers = wallpaperLayers();
  if (layers === 'none') return 'none';
  const veil = theme.scheme === 'light'
    ? 'linear-gradient(rgba(252,248,240,.6), rgba(252,248,240,.78))'
    : theme.scheme === 'amoled'
      ? 'linear-gradient(rgba(0,0,0,.5), rgba(0,0,0,.78))'
      : 'linear-gradient(rgba(5,5,9,.46), rgba(5,5,9,.7))';
  return `${veil}, ${layers}`;
}

/** Первичная и синхронная отрисовка темы. */
export function applyTheme({ emitEvent = false } = {}) {
  const body = document.body;
  if (!body) return;
  const accent = currentAccent();

  body.dataset.variant = theme.variant;
  body.dataset.scheme = theme.scheme;
  body.dataset.density = theme.density;
  body.dataset.font = theme.font;
  body.dataset.anim = theme.anim ? 'on' : 'off';

  body.style.setProperty('--radius', `${theme.radius}px`);
  body.style.setProperty('--cover-radius', `${theme.coverRadius}px`);
  body.style.setProperty('--np-lyrics-scale', String((theme.lyricsSize || 100) / 100));
  body.classList.toggle('hide-pl-seek', theme.barSeek === false);
  body.style.setProperty('--radius-sm', `${Math.max(3, Math.round(theme.radius * 0.64))}px`);
  body.style.setProperty('--blur', `${theme.blur}px`);
  body.style.setProperty('--grain', theme.grain ? '' : '0');
  body.style.setProperty('--card-min', CARD_SIZE[theme.cards] || CARD_SIZE.m);
  body.style.setProperty('--cols', theme.cols === 'auto' ? 'auto-fill' : theme.cols);
  body.style.setProperty('--accent', accent);
  body.style.setProperty('--on-accent', onAccentColor(accent));
  body.style.setProperty('--wp', wallpaperCss());
  body.style.setProperty('--art-a', palette?.a || '#ffd23f');
  body.style.setProperty('--art-b', palette?.b || '#8a5a10');
  body.style.setProperty('--art-c', palette?.c || '#fff3c4');

  body.classList.toggle('hide-sb-lib', !theme.blocks.sbLib);
  body.classList.toggle('hide-pl-like', !theme.blocks.plLike);
  body.classList.toggle('hide-pl-progress', !theme.blocks.plProgress);
  body.classList.toggle('hide-pl-vol', !theme.blocks.plVol);

  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', theme.scheme === 'light' ? '#f3efe7' : '#0a0a0c');

  if (emitEvent) emit();
}

/**
 * Обновить поле темы по пути ('radius', 'eq.bands', 'blocks.hero').
 * @param {string} path
 * @param {*} value
 * @param {{save?:boolean}} opts
 */
export function update(path, value, { save = true, apply = true } = {}) {
  const keys = String(path).split('.');
  if (!keys.length || keys.some((k) => !k)) return theme;
  let target = theme;
  for (let i = 0; i < keys.length - 1; i += 1) {
    const key = keys[i];
    if (!target[key] || typeof target[key] !== 'object') target[key] = {};
    target = target[key];
  }
  target[keys[keys.length - 1]] = value;
  if (save) scheduleSave();
  if (apply) applyTheme({ emitEvent: true });
  else emit();
  return theme;
}

export function setNowPlaying(track) {
  nowPlaying = track || null;
  palette = paletteFor(track || null);
  applyTheme({ emitEvent: true });

  if (track?.cover) {
    const current = track;
    paletteFromCover(track).then((fromCover) => {
      if (nowPlaying !== current || !fromCover) return;
      palette = fromCover;
      applyTheme({ emitEvent: true });
    }).catch(() => { /* остаёмся на детерминированной палитре */ });
  }
}

export function refreshAccentFromCover() {
  if (!nowPlaying) return;
  setNowPlaying(nowPlaying);
}

export function applyPreset(id) {
  const preset = PRESETS.find((p) => p.id === id);
  if (!preset) return false;
  Object.assign(theme, {
    variant: preset.variant,
    scheme: preset.scheme,
    accent: preset.accent,
    accentAuto: false,
    wallpaper: preset.wallpaper,
    radius: preset.radius,
    blur: preset.blur,
    font: preset.font,
    grain: preset.grain,
  });
  scheduleSave();
  applyTheme({ emitEvent: true });
  return true;
}

export function resetTheme() {
  const fresh = deepClone(DEFAULTS);
  for (const key of Object.keys(theme)) delete theme[key];
  Object.assign(theme, fresh);
  customWall = null;
  scheduleSave();
  applyTheme({ emitEvent: true });
}

export function setCustomWallpaper(dataUrl) {
  customWall = dataUrl || null;
  if (customWall) {
    theme.customWall = customWall;
    theme.wallpaper = 'custom';
  } else {
    delete theme.customWall;
    if (theme.wallpaper === 'custom') theme.wallpaper = 'solid';
  }
  const ok = writeJSON(STORAGE_KEY, persisted(theme));
  if (!ok && customWall) {
    delete theme.customWall;
    scheduleSave();
    applyTheme({ emitEvent: true });
    return { persisted: false, dataUrl: customWall };
  }
  scheduleSave();
  applyTheme({ emitEvent: true });
  return { persisted: ok, dataUrl: customWall };
}

export function exportTheme() {
  const data = persisted(theme);
  data.product = 'labsoul';
  data.savedAt = new Date().toISOString();
  return data;
}

export function importTheme(raw) {
  const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Ожидается JSON-объект темы');
  }
  const next = normalizeTheme({ ...theme, ...parsed, eq: parsed.eq ?? theme.eq });
  for (const key of Object.keys(theme)) delete theme[key];
  Object.assign(theme, next);
  customWall = theme.customWall || null;
  if (customWall) theme.wallpaper = 'custom';
  scheduleSave();
  applyTheme({ emitEvent: true });
  return theme;
}

export function cycleScheme() {
  const order = ['dark', 'light', 'amoled'];
  const next = order[(order.indexOf(theme.scheme) + 1) % order.length];
  update('scheme', next);
  return next;
}

export function cardsToPx(cards) {
  return CARD_SIZE[cards] || CARD_SIZE.m;
}

export { VARIANTS, SCHEMES, DENSITIES, FONTS, WALLPAPERS };
