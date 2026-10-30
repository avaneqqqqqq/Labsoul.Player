'use strict';

/**
 * Чистые функции потоковой отдачи: расшифровка и разбор Range.
 * Вынесены из index.mjs, чтобы их можно было проверить без сети (server/selftest.mjs).
 */

import crypto from 'node:crypto';

const CTR_ALGORITHMS = new Set(['aes-128-ctr', 'aes-192-ctr', 'aes-256-ctr']);

/**
 * Расшифровка потока Яндекс.Музыки.
 *
 * Схема сервиса: AES-CTR, ключ приходит hex-строкой (16 байт = AES-128),
 * начальное значение счётчика — нули (nonce 12 байт + счётчик 4 байта).
 * CTR — потоковый режим, поэтому перемотка по байтам не ломает расшифровку.
 *
 * @param {Buffer} buffer зашифрованные данные
 * @param {{algo?: string, keyHex: string}} decrypt описание из stream()
 * @returns {Buffer} расшифрованные данные той же длины
 */
export function decryptBuffer(buffer, decrypt) {
  if (!decrypt || !decrypt.keyHex) throw new Error('Не передано описание расшифровки');
  const algorithm = String(decrypt.algo || 'aes-128-ctr').toLowerCase();
  if (!CTR_ALGORITHMS.has(algorithm)) {
    throw new Error(`Неподдерживаемый алгоритм расшифровки: ${decrypt.algo}`);
  }
  const key = Buffer.from(decrypt.keyHex, 'hex');
  if (![16, 24, 32].includes(key.length)) {
    throw new Error('Некорректный ключ расшифровки (ожидается 16/24/32 байта в hex)');
  }
  const iv = Buffer.alloc(16);
  const decipher = crypto.createDecipheriv(algorithm, key, iv);
  return Buffer.concat([decipher.update(buffer), decipher.final()]);
}

/**
 * Разбор заголовка Range для одного непрерывного диапазона.
 *
 * Понимает `bytes=0-`, `bytes=100-199`, `bytes=-500`. Возвращает:
 *   null                     — заголовка нет или он не про bytes (отдаём файл целиком),
 *   {unsatisfiable: true}    — диапазон вне файла (ответ 416),
 *   {start, end}             — валидный диапазон для ответа 206.
 *
 * Мультидиапазоны (`bytes=0-1,5-6`) сознательно не поддерживаются: <audio>
 * их не запрашивает, а корректный multipart-ответ только усложнил бы код.
 */
export function parseRange(rangeHeader, total) {
  if (!rangeHeader || !Number.isFinite(total) || total <= 0) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(rangeHeader).trim());
  if (!match) return null;

  const [, rawStart, rawEnd] = match;
  if (!rawStart && !rawEnd) return null;

  let start;
  let end;

  if (!rawStart) {
    // суффиксный диапазон: последние N байт
    const suffix = Number.parseInt(rawEnd, 10);
    if (!Number.isFinite(suffix) || suffix <= 0) return { unsatisfiable: true };
    start = Math.max(0, total - suffix);
    end = total - 1;
  } else {
    start = Number.parseInt(rawStart, 10);
    end = rawEnd ? Number.parseInt(rawEnd, 10) : total - 1;
  }

  if (!Number.isFinite(start) || !Number.isFinite(end)) return { unsatisfiable: true };
  if (end >= total) end = total - 1;
  if (start > end || start >= total) return { unsatisfiable: true };
  return { start, end };
}
