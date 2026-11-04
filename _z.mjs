import fs from 'node:fs';
const s = JSON.parse(fs.readFileSync(process.env.APPDATA + '/labsoul/data/settings.json', 'utf8'));
const cookies = JSON.parse(s.soundcloud.cookies);
const oauth = cookies.find(c => c.name === 'oauth_token')?.value || '';

const track = await (await fetch('https://api-v2.soundcloud.com/tracks/1659373005', { headers: { authorization: `OAuth ${oauth}` }, signal: AbortSignal.timeout(12000) })).json();
const hls = track.media.transcodings.find(t => t.format.protocol === 'hls' && !t.snipped);
const r = await fetch(hls.url, { headers: { authorization: `OAuth ${oauth}`, accept: 'application/json' }, signal: AbortSignal.timeout(12000) });
const streamUrl = (await r.json()).url;
const pl = await (await fetch(streamUrl, { signal: AbortSignal.timeout(15000) })).text();
const segs = [...pl.matchAll(/^(https:\/\/[^\s]+)$/gm)].map(m => m[1]);
const seg = segs[0];

for (const kb of [8, 16, 32, 64, 128]) {
  const t0 = Date.now();
  try {
    const sr = await fetch(seg, { signal: AbortSignal.timeout(15000), headers: { 'user-agent': 'Mozilla/5.0', range: `bytes=0-${kb*1024-1}` } });
    const buf = await sr.arrayBuffer();
    console.log(`  ${String(kb).padStart(4)} КБ: ${sr.status} ${String(Date.now()-t0).padStart(5)}мс ${(buf.byteLength/1024).toFixed(1)} КБ`);
  } catch (e) { console.log(`  ${String(kb).padStart(4)} КБ: ОШИБКА ${(e.cause && e.cause.code) || e.name} ${Date.now()-t0}мс`); }
}
