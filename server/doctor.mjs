'use strict';

/**
 * Диагностика источников: `node server/doctor.mjs`
 *
 * Проверяет по каждому сервису: подключение → поиск → получение потока.
 * Ничего не меняет, только читает. Удобно, когда «не играет» и непонятно, где обрыв.
 */

import * as store from './store.mjs';

const NAMES = ['yandex', 'soundcloud', 'spotify'];
const settings = store.loadSettings();

const green = (s) => `\x1b[32m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;

async function probe(name) {
  process.stdout.write(`\n${bold(name)}  `);
  let provider;
  try {
    provider = await import(`./providers/${name}.mjs`);
  } catch (err) {
    console.log(red('модуль не найден') + dim(` (${err.message})`));
    return;
  }
  provider.configure?.(settings[name] || {});

  let status;
  try {
    status = await provider.status();
  } catch (err) {
    console.log(red('status() упал: ' + err.message));
    return;
  }
  if (!status.connected) {
    console.log(red('не подключён') + dim(` (${status.error || 'нет данных'})`));
    return;
  }
  console.log(green('подключён') + (status.user ? ` — ${status.user}` : ''));

  let found = [];
  try {
    found = await provider.search('мираж', 3);
  } catch (err) {
    console.log('  поиск: ' + red(err.message));
    return;
  }
  console.log(`  поиск: ${found.length ? green(`${found.length} трек(ов)`) : red('пусто')}`);
  const sample = found.find((t) => t.playable) || found[0];
  if (!sample) return;
  console.log(`  пример: ${sample.artists.join(', ')} — ${sample.title} ${dim(`[${sample.source}:${sample.sourceId}]`)}`);
  if (!sample.playable) {
    console.log('  поток: ' + dim('пропущено, трек помечен как недоступный'));
    return;
  }

  try {
    const desc = await provider.stream(sample.sourceId);
    if (desc.buffer) {
      console.log(`  поток: ${green('буфер')} ${Math.round(desc.buffer.length / 1024)} КБ, ${desc.contentType || '?'}`);
      return;
    }
    const head = await fetch(desc.url, {
      method: 'HEAD',
      headers: desc.headers || {},
      signal: AbortSignal.timeout(15000),
    });
    const ok = head.ok || head.status === 206;
    console.log(
      `  поток: ${ok ? green(head.status + ' OK') : red(head.status + ' FAIL')}` +
        ` ${head.headers.get('content-type') || ''} ${head.headers.get('content-length') || ''}` +
        (desc.decrypt ? dim(' + расшифровка на сервере') : ''),
    );
  } catch (err) {
    console.log('  поток: ' + red(err.message));
  }
}

console.log(bold('labsoul — диагностика'));
console.log(dim(`данные: ${store.paths.DATA}`));
for (const name of NAMES) await probe(name);
console.log('');
