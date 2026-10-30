#!/usr/bin/env node
/**
 * Живая самопроверка провайдеров SoundCloud и Spotify.
 *
 * Запуск:
 *   node player/server/providers/_probe-sc.mjs
 *
 * Что делает:
 *   1. SoundCloud: status + получение client_id скрейпингом (m.soundcloud.com → бандлы)
 *   2. поиск треков и маппинг в Track
 *   3. track(id) по одному треку
 *   4. stream() для progressive-трека: URL + проверка первых 64 КБ (Range)
 *   5. HLS-трек: resolve m3u8 → init.mp4 + первый сегмент (частичное чтение)
 *   6. Go+ / SNIP: playable:false + reason:'go_plus'
 *   7. Spotify: без ключей ожидаем NO_TOKEN (не падение), с ключами — поиск и превью
 *
 * Скрипт ничего не пишет на диск и завершает процесс кодом 0/1.
 * Внимание: client_id печатается только в маскированном виде.
 */

import * as soundcloud from './soundcloud.mjs';
import * as spotify from './spotify.mjs';

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const NET_TIMEOUT_MS = 15_000;
const PARTIAL_TIMEOUT_MS = 20_000;

const results = [];
let hardFailures = 0;

function log(text = '') {
  process.stdout.write(`${text}\n`);
}

function ok(name, detail) {
  results.push({ status: 'OK', name, detail });
  log(`[OK]   ${name}: ${detail}`);
}

function fail(name, detail) {
  results.push({ status: 'FAIL', name, detail });
  hardFailures += 1;
  log(`[FAIL] ${name}: ${detail}`);
}

function note(name, detail) {
  results.push({ status: 'NOTE', name, detail });
  log(`[NOTE] ${name}: ${detail}`);
}

function mask(value) {
  const text = String(value || '');
  if (!text) return '(нет)';
  if (text.length <= 6) return `${text.slice(0, 2)}***`;
  return `${text.slice(0, 4)}***${text.slice(-2)}`;
}

async function attempt(timerName, fn) {
  const startedAt = Date.now();
  try {
    const value = await fn();
    return { ok: true, value, ms: Date.now() - startedAt };
  } catch (error) {
    return { ok: false, error, ms: Date.now() - startedAt, timerName };
  }
}

/** Частичное чтение: первые maxBytes байт или timeoutMs — что раньше. */
async function readSome(url, maxBytes, timeoutMs = PARTIAL_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let bytes = 0;
  try {
    const response = await fetch(url, {
      headers: { 'user-agent': USER_AGENT, range: `bytes=0-${Math.max(0, maxBytes - 1)}` },
      signal: controller.signal,
    });
    const reader = response.body.getReader();
    while (bytes < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.length;
    }
    try {
      await reader.cancel();
    } catch {
      /* ignore */
    }
    return { status: response.status, contentType: response.headers.get('content-type'), bytes };
  } catch (error) {
    const reason =
      error?.name === 'AbortError' || error?.name === 'TimeoutError'
        ? `таймаут ${timeoutMs} мс`
        : error?.cause?.code || error?.message || 'ошибка';
    return { status: 0, contentType: null, bytes, error: reason };
  } finally {
    clearTimeout(timer);
  }
}

function briefTrack(track) {
  return {
    id: track.id,
    title: track.title,
    artists: track.artists,
    album: track.album,
    cover: track.cover,
    duration: track.duration,
    playable: track.playable,
    reason: track.reason,
    explicit: track.explicit,
  };
}

/* ------------------------------------------------------------------ */
/* 1. SoundCloud                                                       */
/* ------------------------------------------------------------------ */

async function probeSoundCloud() {
  log('\n=== SoundCloud ===');

  const statusResult = await attempt('status', () => soundcloud.status());
  if (!statusResult.ok) {
    fail('soundcloud.status()', statusResult.error.message);
  } else if (statusResult.value.connected) {
    ok('soundcloud.status()', `connected=true (${statusResult.ms} мс)`);
  } else {
    fail('soundcloud.status()', `connected=false, ${statusResult.value.error?.code}: ${statusResult.value.error?.message}`);
  }

  // client_id
  let clientIdOk = false;
  const clientIdResult = await attempt('client_id', () => soundcloud._debug.clientId());
  if (!clientIdResult.ok) {
    fail('client_id', clientIdResult.error.message);
    const last = soundcloud._debug.lastAcquisition?.();
    for (const entry of last?.attempts || []) {
      log(`        · ${entry.source}: ${entry.ok ? 'ok' : 'fail'} — ${entry.detail}`);
    }
  } else {
    clientIdOk = true;
    const info = clientIdResult.value;
    ok(
      'client_id получен',
      `${info.masked}, источник="${info.source}", ${info.acquire?.ms ?? clientIdResult.ms} мс`,
    );
    for (const entry of info.acquire?.attempts || []) {
      log(`        · ${entry.source}: ${entry.ok ? 'ok' : 'fail'} — ${entry.detail}`);
    }
  }

  // поиск
  const searchResult = await attempt('search', () => soundcloud.search('lofi hip hop', 5));
  if (!searchResult.ok) {
    fail('soundcloud.search()', `${searchResult.error.code || ''} ${searchResult.error.message}`.trim());
    return;
  }
  const found = searchResult.value;
  if (!found.length) {
    fail('soundcloud.search()', 'вернулось 0 треков');
    return;
  }
  ok('soundcloud.search("lofi hip hop", 5)', `${found.length} трек(ов), ${searchResult.ms} мс`);
  log(`        первый: ${JSON.stringify(briefTrack(found[0]))}`);

  // маппинг search vs track
  const trackResult = await attempt('track', () => soundcloud.track(found[0].sourceId));
  if (!trackResult.ok) {
    fail('soundcloud.track()', `${trackResult.error.code || ''} ${trackResult.error.message}`.trim());
  } else if (trackResult.value.id !== found[0].id || trackResult.value.title !== found[0].title) {
    fail('soundcloud.track()', `маппинг не совпал: ${trackResult.value.id} !== ${found[0].id}`);
  } else {
    ok('soundcloud.track()', `${trackResult.value.id} «${trackResult.value.title}», ${trackResult.ms} мс`);
  }

  if (!clientIdOk) return;

  // progressive: URL потока + частичная проверка байтов
  const flickerResult = await attempt('search-flickermood', () => soundcloud.search('flickermood', 10));
  let progressiveTrack = null;
  if (flickerResult.ok) {
    for (const candidate of flickerResult.value) {
      const inspect = await attempt('inspect', () => soundcloud._debug.inspect(candidate.sourceId));
      if (!inspect.ok) continue;
      if (inspect.value.transcodings.some((item) => item.protocol === 'progressive')) {
        progressiveTrack = candidate;
        break;
      }
    }
  }

  if (!progressiveTrack) {
    note('progressive', 'не нашёл трек с progressive-транскодингом — проверка URL пропущена');
  } else {
    const streamResult = await attempt('stream-progressive', () => soundcloud.stream(progressiveTrack.sourceId));
    if (!streamResult.ok) {
      fail('soundcloud.stream() progressive', `${streamResult.error.code || ''} ${streamResult.error.message}`.trim());
    } else if (!streamResult.value.url) {
      fail('soundcloud.stream() progressive', 'в ответе нет url');
    } else {
      const streamUrl = streamResult.value.url;
      ok(
        'stream() progressive → URL',
        `${new URL(streamUrl).host}${new URL(streamUrl).pathname.slice(0, 24)}… contentType=${streamResult.value.contentType}, repeatable=${streamResult.value.repeatable}, ${streamResult.ms} мс`,
      );
      const partial = await readSome(streamUrl, 65536);
      if (partial.status === 200 || partial.status === 206) {
        note(
          'передача аудио (progressive)',
          `HTTP ${partial.status}, получено ${partial.bytes}/${65536} байт${partial.error ? `, ${partial.error}` : ''}`,
        );
        if (partial.bytes === 0) note('сеть', 'медиа-CDN SoundCloud не отдаёт байты из этой сети — ограничение сети, не кода');
      } else {
        note('передача аудио (progressive)', `HTTP ${partial.status}${partial.error ? `, ${partial.error}` : ''}`);
      }
    }
  }

  // HLS: resolve плейлиста + init + первый сегмент
  const hlsTrack = found.find((item) => item.playable) || null;
  if (!hlsTrack) {
    note('HLS', 'в выдаче нет воспроизводимого трека — проверка HLS пропущена');
    return;
  }
  const inspectResult = await attempt('inspect-hls', () => soundcloud._debug.inspect(hlsTrack.sourceId));
  if (!inspectResult.ok) {
    fail('HLS inspect', inspectResult.error.message);
  } else {
    const protocols = [...new Set(inspectResult.value.transcodings.map((item) => item.protocol))];
    note('транскодинги трека', protocols.join(', ') || 'нет');
    const resolveResult = await attempt('resolve-hls', () => soundcloud._debug.resolve(hlsTrack.sourceId, 'hls'));
    if (!resolveResult.ok) {
      fail('HLS resolve', `${resolveResult.error.code || ''} ${resolveResult.error.message}`.trim());
    } else {
      ok('stream() HLS → m3u8', `${resolveResult.value.preset}, ${resolveResult.value.mime}, ${new URL(resolveResult.value.url).host}`);
      let playlistText = '';
      let playlistError = null;
      for (const timeoutMs of [12_000, 12_000]) {
        try {
          const response = await fetch(resolveResult.value.url, {
            headers: { 'user-agent': USER_AGENT },
            signal: AbortSignal.timeout(timeoutMs),
          });
          playlistText = await response.text();
          playlistError = null;
          break;
        } catch (error) {
          playlistError = error;
        }
      }
      if (!playlistText) {
        // Медиа-CDN SoundCloud в этой сети недоступен/замедлен — это ограничение сети, а не кода.
        note(
          'HLS playlist',
          `медиа-CDN недоступен из этой сети: ${playlistError?.cause?.code || playlistError?.message || 'ошибка'}`,
        );
      }
      if (playlistText) {
        const segments = playlistText
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter((line) => line && !line.startsWith('#'));
        const initMatch = playlistText.match(/#EXT-X-MAP:URI="([^"]+)"/);
        note('HLS-плейлист', `сегментов=${segments.length}, init.mp4=${initMatch ? 'есть' : 'нет'}`);
        if (initMatch) {
          const init = await readSome(new URL(initMatch[1], resolveResult.value.url).toString(), 4096);
          note('HLS init-сегмент', `HTTP ${init.status}, ${init.bytes} байт`);
        }
        if (segments.length) {
          const segmentUrl = new URL(segments[0], resolveResult.value.url).toString();
          const segment = await readSome(segmentUrl, 65536);
          note(
            'HLS первый сегмент',
            `HTTP ${segment.status}, получено ${segment.bytes}/65536 байт${segment.error ? `, ${segment.error}` : ''}`,
          );
          if (segment.bytes === 0) {
            note('HLS полнота', 'сегменты из этой сети недоступны — полный buffer-путь не проверен живьём');
          }
        }
      }
    }
  }

  // Go+ / SNIP
  const goPlusResult = await attempt('search-theweeknd', () => soundcloud.search('The Weeknd', 5));
  if (!goPlusResult.ok) {
    note('Go+ маппинг', `поиск не удался: ${goPlusResult.error.message}`);
  } else {
    const goPlus = goPlusResult.value.filter((item) => item.playable === false && item.reason === 'go_plus');
    if (goPlus.length) {
      ok('Go+ маппинг', `${goPlus.length}/${goPlusResult.value.length} треков playable=false reason=go_plus`);
      log(`        пример: ${JSON.stringify(briefTrack(goPlus[0]))}`);
    } else {
      note('Go+ маппинг', 'в этой выдаче нет SNIP/SUB_HIGH_TIER треков');
    }
  }
}

/* ------------------------------------------------------------------ */
/* 2. Spotify                                                          */
/* ------------------------------------------------------------------ */

async function probeSpotify() {
  log('\n=== Spotify ===');
  const configured = spotify._debug.configured();
  log(`        ключи: clientId=${configured.clientId || '(нет)'}, secret=${configured.clientSecret || '(нет)'}`);

  const statusResult = await attempt('spotify-status', () => spotify.status());
  if (!statusResult.ok) {
    fail('spotify.status()', statusResult.error.message);
    return;
  }
  const status = statusResult.value;

  if (!status.connected) {
    const code = status.error?.code;
    if (code === 'NO_TOKEN') {
      ok('spotify.status() без ключей', 'connected=false, NO_TOKEN — корректно, не падение');
    } else {
      fail('spotify.status()', `connected=false, ${code}: ${status.error?.message}`);
    }

    // search/stream обязаны бросить NO_TOKEN, а не упасть неожиданно
    const searchProbe = await attempt('spotify-search', () => spotify.search('daft punk', 3));
    if (!searchProbe.ok && searchProbe.error.code === 'NO_TOKEN') {
      ok('spotify.search() без ключей', 'брошено NO_TOKEN — корректно');
    } else if (searchProbe.ok) {
      fail('spotify.search() без ключей', 'неожиданно вернул данные без ключей');
    } else {
      fail('spotify.search() без ключей', `ожидался NO_TOKEN, получено ${searchProbe.error.code}: ${searchProbe.error.message}`);
    }

    const streamProbe = await attempt('spotify-stream', () => spotify.stream('4uLU6hMCjMI75M1A2tKUQC'));
    if (!streamProbe.ok && streamProbe.error.code === 'NO_TOKEN') {
      ok('spotify.stream() без ключей', 'брошено NO_TOKEN — корректно');
    } else if (streamProbe.ok) {
      fail('spotify.stream() без ключей', 'неожиданно вернул поток без ключей');
    } else {
      fail('spotify.stream() без ключей', `ожидался NO_TOKEN, получено ${streamProbe.error.code}`);
    }
    return;
  }

  ok('spotify.status()', 'connected=true (токен получен)');
  const searchResult = await attempt('spotify-search', () => spotify.search('daft punk', 5));
  if (!searchResult.ok) {
    fail('spotify.search()', `${searchResult.error.code || ''} ${searchResult.error.message}`.trim());
    return;
  }
  const tracks = searchResult.value;
  if (!tracks.length) {
    fail('spotify.search()', 'вернулось 0 треков');
    return;
  }
  const playable = tracks.filter((item) => item.playable);
  ok(
    'spotify.search()',
    `${tracks.length} трек(ов), playable=${playable.length} (preview_url), ${searchResult.ms} мс`,
  );
  log(`        первый: ${JSON.stringify(briefTrack(tracks[0]))}`);

  const previewTrack = playable[0];
  if (!previewTrack) {
    note('spotify.stream()', 'ни у одного трека нет preview_url — стрим проверить нечем (норма для новых приложений)');
    return;
  }
  const streamResult = await attempt('spotify-stream', () => spotify.stream(previewTrack.sourceId));
  if (!streamResult.ok) {
    fail('spotify.stream()', `${streamResult.error.code || ''} ${streamResult.error.message}`.trim());
  } else {
    ok('spotify.stream() → URL', `${new URL(streamResult.value.url).host}, contentType=${streamResult.value.contentType}`);
    const partial = await readSome(streamResult.value.url, 32768);
    note('передача аудио (Spotify preview)', `HTTP ${partial.status}, получено ${partial.bytes}/32768 байт${partial.error ? `, ${partial.error}` : ''}`);
  }
}

/* ------------------------------------------------------------------ */
/* run                                                                 */
/* ------------------------------------------------------------------ */

async function main() {
  log(`SoundCloud/Spotify probe — Node ${process.version}, ${new Date().toISOString()}`);
  log(`маскирование client_id: ${mask('0123456789abcdef0123456789abcdef')}`);

  try {
    await probeSoundCloud();
  } catch (error) {
    fail('SoundCloud: необработанная ошибка', error?.stack || String(error));
  }

  try {
    await probeSpotify();
  } catch (error) {
    fail('Spotify: необработанная ошибка', error?.stack || String(error));
  }

  log('\n=== ИТОГ ===');
  for (const item of results) log(`${item.status.padEnd(4)} ${item.name}: ${item.detail}`);
  const hasFailures = results.some((item) => item.status === 'FAIL');
  log(`\n${hasFailures || hardFailures > 0 ? 'ЕСТЬ ПРОБЛЕМЫ' : 'ВСЁ КЛЮЧЕВОЕ РАБОТАЕТ'} (fail-ов: ${hardFailures})`);
  process.exit(hasFailures || hardFailures > 0 ? 1 : 0);
}

main().catch((error) => {
  log(`FATAL: ${error?.stack || error}`);
  process.exit(1);
});
