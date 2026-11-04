/**
 * Релей для SoundCloud — один файл для Netlify и Cloudflare.
 *
 * Зачем: soundcloud.com заблокирован у провайдеров. Сами Netlify и
 * Cloudflare в России открываются напрямую (проверено). Значит можно
 * поставить маленький сервер-посредник на бесплатном хостинге: плеер
 * ходит к нему, а он — к SoundCloud.
 *
 * Как развернуть — см. README.md рядом.
 */

/* ------------------------------------------------------------------ */
/* разрешённые домены                                                  */
/* ------------------------------------------------------------------ */

const ALLOWED_HOSTS = [
  'soundcloud.com',
  'www.soundcloud.com',
  'm.soundcloud.com',
  'api-v2.soundcloud.com',
  'api-auth.soundcloud.com',
  'api.soundcloud.com',
  'secure.soundcloud.com',
  'sndcdn.com',
];

/** Поддомены этих зон разрешены целиком (медиа-серверы). */
const ALLOWED_ZONES = [
  'sndcdn.com',
  'soundcloud.cloud',
  'sndcdn.co',
];

const PROXY_PREFIX = '/p/';

function isAllowed(hostname) {
  const host = String(hostname || '').toLowerCase();
  if (!host) return false;
  if (ALLOWED_HOSTS.includes(host)) return true;
  if (host.endsWith('.soundcloud.com')) return true;
  return ALLOWED_ZONES.some((zone) => host === zone || host.endsWith(`.${zone}`));
}

/** Заголовки, которые нельзя отдавать обратно как есть. */
const HOP_HEADERS = [
  'content-encoding', 'content-length', 'transfer-encoding', 'connection',
  'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer',
  'upgrade', 'set-cookie',
];

function cleanHeaders(headers) {
  const out = new Headers(headers);
  for (const name of HOP_HEADERS) out.delete(name);
  return out;
}

function corsHeaders() {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS, HEAD',
    'access-control-allow-headers': '*',
    'access-control-max-age': '86400',
  };
}

function infoPage() {
  return new Response(
    `<!doctype html><meta charset="utf-8"><title>labsoul relay</title>
<style>body{font:16px system-ui;background:#0b0b10;color:#e8e8f0;padding:40px;max-width:640px;margin:auto}
code{background:#1a1a24;padding:2px 6px;border-radius:4px}h1{font-size:22px}</style>
<h1>Релей labsoul работает</h1>
<p>Скопируйте этот адрес в плеере: <b>Настройки → SoundCloud → Релеи</b>.</p>
<p>Сейчас: <code id="u"></code></p>
<script>document.getElementById('u').textContent = location.origin;</script>`,
    { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', ...corsHeaders() } },
  );
}

/**
 * Основная функция. Одинакова для обеих платформ.
 * @param {Request} request
 */
export async function handleRequest(request) {
  const url = new URL(request.url);

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  if (url.pathname === '/' || url.pathname === '') {
    if (request.method === 'GET') return infoPage();
    return new Response('только чтение', { status: 405, headers: corsHeaders() });
  }

  if (url.pathname.startsWith(PROXY_PREFIX)) {
    const raw = url.pathname.slice(PROXY_PREFIX.length) + url.search;

    let target;
    try {
      target = new URL(decodeURIComponent(raw));
    } catch {
      return new Response('некорректный адрес', { status: 400, headers: corsHeaders() });
    }

    if (target.protocol !== 'https:') {
      return new Response('только https', { status: 400, headers: corsHeaders() });
    }

    if (!isAllowed(target.hostname)) {
      return new Response(`домен не разрешён: ${target.hostname}`, { status: 403, headers: corsHeaders() });
    }

    const incoming = new Headers(request.headers);
    for (const name of ['host', 'origin', 'referer', 'cf-connecting-ip', 'x-forwarded-for', 'x-real-ip', 'content-length']) {
      incoming.delete(name);
    }

    const init = { method: request.method, headers: incoming, redirect: 'follow' };
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      init.body = await request.arrayBuffer();
    }

    try {
      const response = await fetch(target.toString(), init);
      const body = await response.arrayBuffer();
      const headers = cleanHeaders(response.headers);
      headers.set('access-control-allow-origin', '*');
      headers.set('access-control-expose-headers', '*');
      headers.set('cache-control', 'no-store');
      return new Response(body, { status: response.status, headers });
    } catch (error) {
      return new Response(`релей: ${error?.message || 'ошибка'}`, { status: 502, headers: corsHeaders() });
    }
  }

  return new Response('не найдено', { status: 404, headers: corsHeaders() });
}


