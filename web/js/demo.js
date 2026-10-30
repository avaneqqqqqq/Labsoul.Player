/* =========================================================================
   labsoul — демо-набор треков.
   Используется, когда локальный сервер ещё не запущен: интерфейс можно
   открыть и посмотреть сразу. Формат — ровно Track из CONTRACT.md.
   ========================================================================= */

const t = (source, sourceId, title, artists, album, duration, extra = {}) => ({
  id: `${source}:${sourceId}`,
  source,
  sourceId,
  title,
  artists,
  album: album || null,
  cover: null,
  duration,
  playable: true,
  reason: null,
  explicit: false,
  ...extra,
});

export const DEMO_TRACKS = [
  t('yandex', 'demo-101', 'Стеклянный город', ['Mira Vale'], 'Полутона', 218),
  t('yandex', 'demo-102', 'Ночная смена', ['Кирилл Астахов'], 'Окраина', 194),
  t('yandex', 'demo-103', 'Витрины', ['Sonnaya Reka'], 'Ветер с юга', 241),
  t('yandex', 'demo-104', 'Тихий час', ['Полина Тень'], 'Комнаты', 176),
  t('yandex', 'demo-105', 'Иней', ['Дмитрий Ли'], 'Северный шум', 263),
  t('yandex', 'demo-106', 'Пауза', ['Каскад'], 'Между', 205, { playable: false, reason: 'go_plus' }),
  t('yandex', 'demo-107', 'Огни', ['Алиса Мир'], 'Ритмы', 188),
  t('yandex', 'demo-108', 'Без адреса', ['Голос города'], 'Улица', 227, { playable: false, reason: 'no_preview' }),
  t('yandex', 'demo-109', 'Плеер', ['Signal 3'], 'Сеть', 212),
  t('yandex', 'demo-110', 'Полдень', ['Тёплый Шум'], 'Полдень', 233, { explicit: true }),

  t('soundcloud', 'demo-201', 'lavender static', ['nikita fm'], null, 203),
  t('soundcloud', 'demo-202', 'demo tape #7', ['warmwolf'], null, 149, { playable: false, reason: 'not_streamable' }),
  t('soundcloud', 'demo-203', 'late bus home', ['yuki & komo'], null, 232),
  t('soundcloud', 'demo-204', 'кассета 1999', ['Витя П.'], null, 187, { playable: false, reason: 'no_preview' }),
  t('soundcloud', 'demo-205', 'soap bubbles', ['кира'], null, 118),
  t('soundcloud', 'demo-206', 'field recording, 6am', ['moss'], null, 264),

  t('spotify', 'demo-301', 'Midnight Reservoir', ['Pale Arcade'], 'Reservoir', 246),
  t('spotify', 'demo-302', 'quiet money', ['lune'], 'Paperwork', 198),
  t('spotify', 'demo-303', 'Silver Line', ['Oda Renn'], 'Silver Line', 221),
  t('spotify', 'demo-304', 'No Signal', ['VELL'], 'No Signal', 174, { playable: false, reason: 'geo' }),
  t('spotify', 'demo-305', 'Half-light', ['Nika Sol'], 'Half-light', 238),
  t('spotify', 'demo-306', 'Delta', ['Furrow'], 'Delta', 294),
];

const DAY = 864e5;

/** История за последние три дня — с «живыми» датами относительно сейчас. */
export function demoHistory(limit = 50) {
  const now = Date.now();
  const rows = [
    [DEMO_TRACKS[0], 0.35 * DAY, 191],
    [DEMO_TRACKS[10], 0.6 * DAY, 203],
    [DEMO_TRACKS[16], 1.2 * DAY, 246],
    [DEMO_TRACKS[2], 1.35 * DAY, 140],
    [DEMO_TRACKS[12], 1.8 * DAY, 232],
    [DEMO_TRACKS[6], 2.1 * DAY, 188],
    [DEMO_TRACKS[18], 2.4 * DAY, 221],
    [DEMO_TRACKS[14], 3.2 * DAY, 118],
    [DEMO_TRACKS[4], 3.6 * DAY, 263],
    [DEMO_TRACKS[19], 4.1 * DAY, 238],
  ];
  return {
    items: rows
      .slice(0, Math.max(0, limit))
      .map(([track, ago, playedSeconds]) => ({
        track,
        at: new Date(now - ago).toISOString(),
        playedSeconds,
      })),
  };
}

let waveBatch = 0;
let waveCursor = 0;
let waveOrder = [];

/** Бесконечный демо-поток: уникальные треки внутри партии, новый тас при исчерпании. */
export function demoWave(limit = 20) {
  waveBatch += 1;
  const items = [];
  for (let i = 0; i < limit; i += 1) {
    if (waveCursor >= waveOrder.length) {
      waveOrder = [...DEMO_TRACKS].sort(() => Math.random() - 0.5);
      waveCursor = 0;
    }
    items.push({ ...waveOrder[waveCursor] });
    waveCursor += 1;
  }
  // Первый трек партии всегда играбельный: он попадает в шапку и в кнопку
  // «Слушать», а демо-бейдж «недоступно» у первого трека выглядел бы поломкой.
  if (items.length && !items[0].playable) {
    const swap = items.findIndex((track) => track.playable);
    if (swap > 0) [items[0], items[swap]] = [items[swap], items[0]];
  }
  return {
    station: 'user:onyourwave',
    batchId: `demo-batch-${waveBatch}`,
    items,
  };
}

export function demoSearch(query = '', sources = null, limit = 20) {
  const q = String(query).trim().toLowerCase();
  const picked = DEMO_TRACKS.filter((track) => {
    if (sources && sources.length && !sources.includes(track.source)) return false;
    if (!q) return true;
    const hay = [track.title, ...track.artists, track.album || ''].join(' ').toLowerCase();
    return hay.includes(q);
  });
  const groups = ['yandex', 'soundcloud', 'spotify'].map((source) => ({
    source,
    items: picked.filter((x) => x.source === source).slice(0, limit),
    error: null,
  }));
  return { groups };
}

export function demoStatus() {
  return {
    ok: false,
    demo: true,
    version: 'demo',
    sources: {
      yandex: { connected: false, error: 'демо-режим' },
      soundcloud: { connected: false, error: 'демо-режим' },
      spotify: { connected: false, error: 'демо-режим' },
    },
  };
}

export function demoSettings() {
  return {
    yandex: { token: null },
    soundcloud: { clientId: null },
    spotify: { clientId: null, clientSecret: null },
  };
}

/** Быстрые запросы для пустого поиска. */
export const DEMO_QUERIES = ['Стеклянный город', 'nikita fm', 'Midnight', 'кассета', 'Silver Line'];
