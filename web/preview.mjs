/* =========================================================================
   labsoul — превью интерфейса без API (dev-помощник).
   Отдаёт статику из web/ и отвечает на /api/health нейтральным 200,
   чтобы интерфейс сразу ушёл в демо-режим и консоль осталась чистой.
   Настоящие данные даёт только основной сервер: node server/index.mjs
   Запуск:  node web/preview.mjs   →  http://127.0.0.1:5390
   ========================================================================= */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 5390);
const HOST = process.env.HOST || '127.0.0.1';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || HOST}`);
  const pathname = decodeURIComponent(url.pathname);

  if (pathname === '/api/health') {
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    });
    res.end(JSON.stringify({ ok: false, preview: true, message: 'статическое превью без API' }));
    return;
  }

  if (pathname.startsWith('/api/')) {
    res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'в превью нет API' } }));
    return;
  }

  const relative = pathname === '/' ? '/index.html' : pathname;
  const file = path.normalize(path.join(ROOT, relative));
  if (!file.startsWith(ROOT)) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('forbidden');
    return;
  }

  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('not found');
      return;
    }
    res.writeHead(200, {
      'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(data);
  });
});

server.listen(PORT, HOST, () => {
  console.log(`labsoul preview (демо-режим): http://${HOST}:${PORT}`);
});
