'use strict';

/**
 * Отладочный провайдер: обычный (незашифрованный) поток.
 * Используется только в server/streamtest.mjs и только при PLAYER_TEST_PROVIDERS=1.
 *
 * Поднимает собственный HTTP-апстрим с поддержкой Range — ровно тот случай,
 * который в реальности обслуживает pipeUpstream() в index.mjs.
 */

import http from 'node:http';

export const id = '__plain';

/** Маленький валидный WAV: 8 кГц, моно, 16 бит, ~1 секунда тишины. */
export function makeWav(samples = 8000) {
  const dataSize = samples * 2;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write('RIFF', 0, 'latin1');
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8, 'latin1');
  buffer.write('fmt ', 12, 'latin1');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(1, 22); // моно
  buffer.writeUInt32LE(8000, 24); // sample rate
  buffer.writeUInt32LE(8000 * 2, 28); // byte rate
  buffer.writeUInt16LE(2, 32); // block align
  buffer.writeUInt16LE(16, 34); // bits per sample
  buffer.write('data', 36, 'latin1');
  buffer.writeUInt32LE(dataSize, 40);
  // лёгкий тон вместо полной тишины — проще заметить, что байты не нулевые
  for (let i = 0; i < samples; i += 1) {
    const value = Math.round(8000 * Math.sin((2 * Math.PI * 440 * i) / 8000));
    buffer.writeInt16LE(value, 44 + i * 2);
  }
  return buffer;
}

export const testWav = makeWav(4000); // ~0.5 с

let upstream = null;

function ensureUpstream() {
  if (upstream) return upstream;
  const server = http.createServer((req, res) => {
    const total = testWav.length;
    const range = req.headers.range;
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (match && (match[1] || match[2])) {
        let start;
        let end;
        if (!match[1]) {
          // суффиксный диапазон: последние N байт (так ведёт себя реальный CDN)
          const suffix = Number(match[2]);
          start = Math.max(0, total - suffix);
          end = total - 1;
        } else {
          start = Number(match[1]);
          end = match[2] ? Math.min(Number(match[2]), total - 1) : total - 1;
        }
        if (start >= total || start > end) {
          res.writeHead(416, { 'content-range': `bytes */${total}` });
          res.end();
          return;
        }
        res.writeHead(206, {
          'content-type': 'audio/wav',
          'content-range': `bytes ${start}-${end}/${total}`,
          'content-length': end - start + 1,
          'accept-ranges': 'bytes',
        });
        res.end(testWav.subarray(start, end + 1));
        return;
      }
    }
    res.writeHead(200, {
      'content-type': 'audio/wav',
      'content-length': total,
      'accept-ranges': 'bytes',
    });
    res.end(testWav);
  });
  server.listen(0, '127.0.0.1');
  upstream = { server, port: server.address() ? server.address().port : 0 };
  if (!upstream.port) {
    // listen асинхронный: дождёмся, но без блокировки module top-level
    upstream.server.once('listening', () => {
      upstream.port = upstream.server.address().port;
    });
  }
  return upstream;
}

export function configure() {}

export async function status() {
  return { connected: true, user: 'test-plain' };
}

export async function search() {
  return [];
}

export async function track() {
  const err = new Error('Тестовый провайдер не отдаёт метаданные');
  err.code = 'NOT_FOUND';
  throw err;
}

export async function stream() {
  const { server } = ensureUpstream();
  if (!server.listening) {
    await new Promise((resolve) => server.once('listening', resolve));
  }
  const port = server.address().port;
  return {
    url: `http://127.0.0.1:${port}/tone.wav`,
    contentType: 'audio/wav',
    repeatable: true,
  };
}

export async function wave() {
  return { station: 'test', batchId: null, items: [] };
}

export async function feedback() {
  return { ok: true };
}
