/* =========================================================================
   labsoul — обложки и палитры.
   1) Детерминированный градиент для трека без обложки.
   2) Квантование картинки на canvas: два доминирующих цвета.
   ========================================================================= */

import { clamp, hashString, hexToRgb, hslToHex } from './utils.js';

const paletteCache = new Map();
const coverCache = new Map();

/** Обложки, которые не загрузились в этой сессии: не дёргаем сеть повторно. */
export const failedCovers = new Set();

/* ------------------------------------------------------------------ */
/* Детерминированная палитра                                            */
/* ------------------------------------------------------------------ */

export function paletteFor(track) {
  const key = track ? `${track.id || track.sourceId}|${track.title || ''}` : 'labsoul';
  const cached = paletteCache.get(key);
  if (cached) {
    if (track?.cover && cached.cover !== track.cover) cached.cover = track.cover;
    return cached;
  }
  const seed = hashString(key);
  const hue = seed % 360;
  const altHue = (hue + 140 + (seed % 70)) % 360;
  const palette = {
    a: hslToHex(hue, 56, 52),
    b: hslToHex((hue + 16) % 360, 46, 15),
    c: hslToHex(altHue, 74, 62),
    accent: hslToHex(altHue, 72, 60),
    cover: track?.cover || null,
    fromCover: false,
  };
  paletteCache.set(key, palette);
  return palette;
}

/* ------------------------------------------------------------------ */
/* Canvas-квантование                                                   */
/* ------------------------------------------------------------------ */

function rgbToHsl(r, g, b) {
  const rn = r / 255; const gn = g / 255; const bn = b / 255;
  const max = Math.max(rn, gn, bn); const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6;
  else if (max === gn) h = ((bn - rn) / d + 2) / 6;
  else h = ((rn - gn) / d + 4) / 6;
  return { h: h * 360, s, l };
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.referrerPolicy = 'no-referrer';
    img.decoding = 'async';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Не удалось загрузить обложку'));
    img.src = new URL(url, document.baseURI).href;
  });
}

function paletteFromPixels(data) {
  const buckets = new Map();
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3];
    if (a < 200) continue;
    const r = data[i]; const g = data[i + 1]; const b = data[i + 2];
    const { s, l } = rgbToHsl(r, g, b);
    if (l < 0.07 || l > 0.94) continue;      // почти чёрное/белое не даёт характера
    if (s < 0.08) continue;                  // серое тоже
    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    const bucket = buckets.get(key) || { n: 0, r: 0, g: 0, b: 0, s: 0 };
    bucket.n += 1;
    bucket.r += r; bucket.g += g; bucket.b += b;
    bucket.s += s;
    buckets.set(key, bucket);
  }
  if (!buckets.size) return null;

  const ranked = [...buckets.values()]
    .map((bucket) => {
      const r = bucket.r / bucket.n; const g = bucket.g / bucket.n; const b = bucket.b / bucket.n;
      const hsl = rgbToHsl(r, g, b);
      return {
        r, g, b, hsl,
        score: bucket.n * (0.35 + hsl.s) * (1 - Math.abs(hsl.l - 0.52)),
      };
    })
    .sort((x, y) => y.score - x.score);

  const first = ranked[0];
  const second = ranked.find((cand) => {
    const dh = Math.abs(cand.hsl.h - first.hsl.h);
    const hueDist = Math.min(dh, 360 - dh);
    return hueDist > 32 && cand.hsl.s > 0.22;
  }) || ranked[1] || null;

  const a = hslToHex(first.hsl.h, clamp(first.hsl.s * 100, 48, 84), clamp(first.hsl.l * 100, 46, 62));
  const b = hslToHex((first.hsl.h + 16) % 360, clamp(first.hsl.s * 80, 30, 58), 15);
  const c = second
    ? hslToHex(second.hsl.h, clamp(second.hsl.s * 100, 55, 88), clamp(second.hsl.l * 100, 52, 70))
    : hslToHex((first.hsl.h + 140) % 360, 70, 62);

  return { a, b, c, accent: c, fromCover: true };
}

async function extract(url) {
  const img = await loadImage(url);
  const size = 42;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(img, 0, 0, size, size);
  let data;
  try {
    data = ctx.getImageData(0, 0, size, size).data;
  } catch {
    return null; // canvas «испорчен» CORS — остаёмся на детерминированной палитре
  }
  return paletteFromPixels(data);
}

/**
 * Палитра из обложки (кэшируется). Всегда резолвится: null — не получилось.
 * @param {string} url
 * @returns {Promise<object|null>}
 */
export function coverPalette(url) {
  if (!url) return Promise.resolve(null);
  if (failedCovers.has(url)) return Promise.resolve(null);
  if (coverCache.has(url)) return coverCache.get(url);
  const job = extract(url)
    .catch(() => {
      failedCovers.add(url);
      return null;
    })
    .then((palette) => palette);
  coverCache.set(url, job);
  return job;
}

/** Обновляет кэш трека палитрой из обложки; возвращает актуальную палитру. */
export async function paletteFromCover(track) {
  const base = paletteFor(track);
  if (!track?.cover) return base;
  const fromCover = await coverPalette(track.cover);
  if (!fromCover) return base;
  Object.assign(base, fromCover, { cover: track.cover });
  return base;
}

/** Сбросить вычисленную палитру (например, сменилась обложка). */
export function forgetPalette(track) {
  if (!track) return;
  paletteCache.delete(`${track.id || track.sourceId}|${track.title || ''}`);
}

export { hexToRgb };
