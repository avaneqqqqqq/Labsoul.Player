import * as sc from './server/providers/soundcloud.mjs';
import * as finder from './server/proxyfind.mjs';

const clientId = await sc.acquireClientId();
console.log('client_id получен:', clientId.slice(0, 8) + '…');

// берём реальный трек из лайков как эталон
const likes = await sc.likes(3);
const track = likes.items?.[0];
const trackId = track ? track.sourceId : '2424504549';
console.log('проверочный трек:', trackId, track ? `«${track.title}»` : '');

const started = Date.now();
const result = await finder.findWorkingProxy({
  clientId,
  trackId,
  onProgress: (p) => {
    if (p.phase === 'scanning') process.stdout.write(`\r${p.message}`.padEnd(70).slice(0, 70));
    if (p.phase === 'verifying') process.stdout.write(`\n  проверяю ${p.proxy}`.padEnd(70).slice(0, 70));
    if (p.phase === 'done') process.stdout.write(`\n✓ ${p.message}\n`);
  },
});

console.log(`\nитог: ${JSON.stringify(result)}`);
console.log('затрачено секунд:', Math.round((Date.now() - started) / 1000));
