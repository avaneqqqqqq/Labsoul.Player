'use strict';

/**
 * Отладочный провайдер: зашифрованный поток по схеме Яндекс.Музыки
 * (AES-128-CTR, нулевой счётчик, ключ hex-строкой в ответе stream()).
 *
 * Проверяет ветку getBuffered() → decryptBuffer() → serveBuffer() в index.mjs:
 * апстрим отдаёт шифротекст, наружу должен уйти корректный WAV.
 */

import http from 'node:http';
import crypto from 'node:crypto';
import { makeWav } from './plain.mjs';

export const id = '__enc';

export const testKey = crypto.randomBytes(16);
export const testKeyHex = testKey.toString('hex');
const plain = makeWav(4000);

// шифруем ровно так же, как это делает сервис: CTR, нулевой IV
function encrypt(buffer, key) {
  const cipher = crypto.createCipheriv('aes-128-ctr', key, Buffer.alloc(16));
  return Buffer.concat([cipher.update(buffer), cipher.final()]);
}

export const testCipher = encrypt(plain, testKey);
export const testPlain = plain;

let upstream = null;

function ensureUpstream() {
  if (upstream) return upstream;
  const server = http.createServer((req, res) => {
    const total = testCipher.length;
    const range = req.headers.range;
    if (range) {
      const match = /^bytes=(\d+)-(\d*)$/.exec(range);
      if (match) {
        const start = Number(match[1]);
        const end = match[2] ? Math.min(Number(match[2]), total - 1) : total - 1;
        res.writeHead(206, {
          'content-type': 'audio/x-test',
          'content-range': `bytes ${start}-${end}/${total}`,
          'content-length': end - start + 1,
        });
        res.end(testCipher.subarray(start, end + 1));
        return;
      }
    }
    res.writeHead(200, { 'content-type': 'audio/x-test', 'content-length': total });
    res.end(testCipher);
  });
  server.listen(0, '127.0.0.1');
  upstream = { server };
  return upstream;
}

export function configure() {}

export async function status() {
  return { connected: true, user: 'test-enc' };
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
    url: `http://127.0.0.1:${port}/encrypted.wav`,
    contentType: 'audio/wav',
    repeatable: false,
    decrypt: { algo: 'aes-128-ctr', keyHex: testKeyHex, nonceLen: 12 },
  };
}

export async function wave() {
  return { station: 'test', batchId: null, items: [] };
}

export async function feedback() {
  return { ok: true };
}
