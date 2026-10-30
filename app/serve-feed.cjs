'use strict';

/**
 * Локальная раздача обновлений для проверки автообновления.
 * Запуск: node serve-feed.cjs [порт]
 * Потом в update.json у установленного приложения указать http://localhost:8080/
 * (electron-updater разрешает http только для localhost).
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const PORT = Number(process.argv[2] || 8080);
const ROOT = path.join(__dirname, 'dist');

const MIME = {
  '.yml': 'text/yaml; charset=utf-8',
  '.exe': 'application/octet-stream',
  '.blockmap': 'application/octet-stream',
};

http.createServer((req, res) => {
  const name = decodeURIComponent((req.url || '/').split('?')[0]).replace(/^\/+/, '') || 'latest.yml';
  const file = path.join(ROOT, name);
  if (!file.startsWith(ROOT)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  fs.readFile(file, (err, buf) => {
    if (err) {
      console.log('404', name);
      res.writeHead(404).end('not found');
      return;
    }
    console.log('200', name, buf.length, 'bytes');
    res.writeHead(200, {
      'content-type': MIME[path.extname(file)] || 'application/octet-stream',
      'content-length': buf.length,
      'cache-control': 'no-store',
    });
    res.end(buf);
  });
}).listen(PORT, '127.0.0.1', () => {
  console.log(`Feed: http://localhost:${PORT}/  (раздаётся папка ${ROOT})`);
  console.log('Проверка манифеста: http://localhost:' + PORT + '/latest.yml');
});
