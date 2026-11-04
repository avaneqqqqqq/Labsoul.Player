/** Проверка релея: поднимаем локально и гоняем запросы. */

import http from 'node:http';
import { handleRequest } from './relay.mjs';

const server = http.createServer(async (req, res) => {
  // собираем тело
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);

  const url = `http://127.0.0.1:${server.address().port}${req.url}`;
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
  }

  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  const request = new Request(url, { method: req.method, headers, body });

  try {
    const response = await handleRequest(request);
    res.statusCode = response.status;
    response.headers.forEach((value, key) => res.setHeader(key, value));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    res.statusCode = 500;
    res.end(`ошибка: ${error.message}`);
  }
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;

console.log(`релей на ${base}\n`);

async function test(name, path, expectOk = true) {
  const started = Date.now();
  try {
    const response = await fetch(base + path, { signal: AbortSignal.timeout(20000) });
    const text = await response.text();
    const good = expectOk ? response.ok : !response.ok;
    console.log(`${good ? 'OK ' : 'FAIL'} ${String(Date.now() - started).padStart(6)}мс ${response.status} ${name} ${text.slice(0, 80).replace(/\n/g, ' ')}`);
    return response;
  } catch (error) {
    console.log(`FAIL ${name}: ${error.message}`);
    return null;
  }
}

// 1. служебная страница
await test('служебная страница', '/', true);

// 2. запрещённый домен
await test('чужой домен (должен отказать)', '/p/' + encodeURIComponent('https://evil.com/x'), false);

// 3. SoundCloud API
await test('SoundCloud главная', '/p/' + encodeURIComponent('https://soundcloud.com/'), true);

// 4. трек
await test('SoundCloud трек', '/p/' + encodeURIComponent('https://api-v2.soundcloud.com/tracks/1659373005'), true);

// 5. CDN обложек
await test('CDN обложек', '/p/' + encodeURIComponent('https://i1.sndcdn.com/artworks-ZO8z0KZ1zwdGZRyS-ZQuRkA-large.jpg'), true);

server.close();
setTimeout(() => process.exit(0), 300);
