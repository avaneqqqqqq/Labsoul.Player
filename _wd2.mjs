// берём много треков и проверяем, что ни один запрос не висит дольше 20 секунд
const wave = await (await fetch('http://127.0.0.1:5378/api/wave?limit=20&sources=yandex,soundcloud', { signal: AbortSignal.timeout(90000) })).json();
const items = wave.items || [];
console.log('треков для проверки:', items.length);
let slow = 0, ok = 0;
for (const t of items.slice(0, 12)) {
  const t0 = Date.now();
  try {
    const r = await fetch(`http://127.0.0.1:5378/api/stream/${t.source}/${t.sourceId}`, { signal: AbortSignal.timeout(21000) });
    const ms = Date.now() - t0;
    if (ms > 16000) { slow += 1; console.log(`МЕДЛЕННО ${ms}мс ${t.source} ${t.title.slice(0, 26)}`); }
    else if (r.ok || r.status === 206) ok += 1;
  } catch (err) {
    if (err.name === 'TimeoutError') { slow += 1; console.log(`ВИСНЕТ >21с: ${t.source} ${t.title.slice(0, 26)}`); }
  }
}
console.log(`быстрых ${ok}, медленных ${slow}`);
