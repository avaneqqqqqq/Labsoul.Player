import { ProxyAgent, fetch as F } from 'undici';
import * as sc from './providers/soundcloud.mjs';
const cid = await sc.acquireClientId();
for (const p of ['46.232.249.209:40001', '51.81.22.6:18080']) {
  const t0 = Date.now();
  try {
    const agent = new ProxyAgent({ uri: 'http://' + p, connectTimeout: 5000 });
    const r = await F(`https://api-v2.soundcloud.com/tracks/2424504549?client_id=${cid}`, {
      dispatcher: agent, signal: AbortSignal.timeout(12000), headers: { 'user-agent': 'Mozilla/5.0' },
    });
    console.log(p.padEnd(24), r.status, Date.now() - t0, 'мс');
  } catch (e) { console.log(p.padEnd(24), 'ОШИБКА', (e.cause && e.cause.code) || e.name, Date.now() - t0, 'мс'); }
}
