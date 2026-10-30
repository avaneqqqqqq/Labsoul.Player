const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';
const html = await (await fetch('https://m.soundcloud.com/', { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(25000) })).text();
const patterns = [/client_id\s*[=:]\s*["']?([0-9a-zA-Z]{20,40})/, /clientId["']?\s*[=:]\s*["']([0-9a-zA-Z]{20,40})/, /apiClientId/i];
for (const p of patterns) {
  const m = html.match(p);
  console.log(String(p), '->', m ? (m[1] ? m[1].slice(0, 8) + '… len ' + m[1].length : 'есть упоминание') : 'нет');
}
const scripts = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map(m => m[1]).filter(s => /sndcdn/.test(s));
for (const src of scripts) {
  try {
    const res = await fetch(src, { headers: { 'User-Agent': UA, Range: 'bytes=0-1500000' }, signal: AbortSignal.timeout(45000) });
    const js = await res.text();
    const m = js.match(/client_id\s*[:=]\s*["']([0-9a-zA-Z]{32})["']/) || js.match(/clientId["']?\s*[:=]\s*["']([0-9a-zA-Z]{32})["']/);
    console.log((m ? 'FOUND ' : 'нет   ') + src.split('/').pop() + ' (' + Math.round(js.length / 1024) + 'КБ, HTTP ' + res.status + ')' + (m ? ' -> ' + m[1].slice(0, 6) + '…' : ''));
    if (m) { console.log('CLIENT_ID=' + m[1]); break; }
  } catch (e) { console.log('ошибка ' + src.split('/').pop() + ': ' + e.message); }
}
