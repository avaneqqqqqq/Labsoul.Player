import * as sc from './server/providers/soundcloud.mjs';
for (const [id, name] of [['2417721978', 'Снег BassBoosted'], ['611343828', 'ВПИСКА']]) {
  const t0 = Date.now();
  try {
    const d = await sc.stream(id);
    console.log(`${name.padEnd(20)} ${d.buffer ? (d.buffer.length/1024/1024).toFixed(2)+' МБ' : 'ПУСТО'} | ${d.contentType || '?'} | ${Date.now()-t0} мс`);
  } catch (e) {
    console.log(`${name.padEnd(20)} ОШИБКА: ${e.code || e.message} | ${Date.now()-t0} мс`);
  }
}
