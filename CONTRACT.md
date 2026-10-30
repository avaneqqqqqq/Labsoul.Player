# labsoul — контракт API v1 (единый документ для сервера и UI)

Приложение полностью локальное, **ноль npm-зависимостей**, Node >= 22, ESM (`.mjs`).

```
node server/index.mjs        →  http://127.0.0.1:5270
```

Сервер отдаёт статику из `web/` и JSON-API из `/api/*` (тот же origin, CORS не нужен).

---

## 1. Единый трек (Track)

Любой трек из любого сервиса приводится к этой форме:

```json
{
  "id": "ym:12345678",
  "source": "yandex",
  "sourceId": "12345678",
  "title": "Название",
  "artists": ["Исполнитель"],
  "album": "Альбом или null",
  "cover": "https://... или null",
  "duration": 213,
  "playable": true,
  "reason": null,
  "explicit": false
}
```

- `id` = `<source>:<sourceId>`, всегда стабильный.
- `source` ∈ `yandex` | `soundcloud` | `spotify`.
- `duration` в секундах (целое).
- `playable=false` + `reason` ∈ `no_preview` | `go_plus` | `geo` | `not_streamable` — когда звук реально недоступен.

## 2. Ошибки

HTTP-код + тело `{"error":{"code":"...","message":"..."}}`.
Коды: `NO_TOKEN`, `AUTH_FAILED`, `NOT_PLAYABLE`, `NOT_FOUND`, `UPSTREAM`, `BAD_REQUEST`, `NOT_SUPPORTED`.

## 3. API

| Метод | Путь | Назначение |
|---|---|---|
| GET | `/api/status` | что подключено: `{ok, version, sources:{yandex:{connected,user,error},soundcloud:{...},spotify:{...}}}` |
| GET | `/api/settings` | сохранённые настройки, секреты **маскируются** (`"••••1234"`) |
| PUT | `/api/settings` | `{yandex:{token?, quality?}, soundcloud:{clientId?}, spotify:{clientId?, clientSecret?}, wave:{sources?:string[]}}` — сохранить + переконфигурировать, вернуть `{ok, sources}` |
| GET | `/api/search?q=&sources=yandex,soundcloud,spotify&limit=20` | `{groups:[{source, items:Track[], error?}]}` |
| GET | `/api/track/:source/:id` | `Track` |
| GET | `/api/stream/:source/:id` | аудиопоток, **обязателен Range/206**, `Content-Type: audio/*` |
| GET | `/api/wave?limit=20&station=user:onyourwave&sources=yandex,soundcloud` | `{engine, station, batchId, sources, items:Track[], hint?, perSource[]}`. `sources` необязателен: без него берётся сохранённая настройка `wave.sources`, затем все три источника |
| POST | `/api/wave/feedback` | `{type:"started"\|"finished"\|"like"\|"dislike"\|"skip", trackId, batchId, position}` → `{ok}` |
| GET | `/api/link?url=<ссылка>` | разбор ссылки Spotify / Яндекс.Музыки / SoundCloud: `{service, title, artists, cover, note, candidates:Track[]}`. Работает без токенов для Spotify и SoundCloud (публичный oEmbed), для Яндекса использует токен, если он есть |
| GET | `/api/history?limit=50` | `{items:[{track:Track, at:ISO, playedSeconds}]}` |
| POST | `/api/history` | `{track, playedSeconds}` → `{ok}` |
| GET | `/api/health` | `{ok:true}` — для проверки живости |

`/api/search` и `/api/wave` **никогда** не падают целиком из-за одного сервиса: недоступный источник отдаёт `error` в своей группе.

## 4. Интерфейс провайдера (`server/providers/<name>.mjs`)

Каждый провайдер — независимый модуль с одинаковыми экспортами:

```js
export const id = 'yandex';

export function configure(cfg) {}            // cfg — объект настроек этого источника; вызывается при старте и после PUT /api/settings
export async function status() {}            // {connected, user?, error?}
export async function search(query, limit) {} // Track[]
export async function track(sourceId) {}      // Track
export async function stream(sourceId) {}     // см. ниже
export async function wave(limit) {}          // {batchId, items:Track[]} — если не поддерживается, throw NOT_SUPPORTED
export async function feedback(event) {}      // {type, sourceId, batchId, position} — опционально
```

`stream()` возвращает:

```js
{
  url: 'https://...',            // прямой апстрим
  headers: { ... },              // необязательные заголовки для апстрима
  contentType: 'audio/mpeg',
  decrypt: { algo:'aes-128-ctr', keyHex:'...', nonceLen:12 },  // опционально
  repeatable: true               // true — URL можно запрашивать много раз (Range); false — одноразовый
}
```

Сервер сам качает апстрим, при `decrypt` расшифровывает, кэширует и отдаёт с поддержкой Range.
Если `repeatable:false` (подписанные на время ссылки Яндекс/SoundCloud) — сервер запрашивает новый URL на каждый Range-запрос через повторный вызов `stream()`.

## 5. Правила реализации

- Только `node:`-модули (`node:http`, `node:crypto`, `node:fs`, `node:path`, `node:stream`). Глобальный `fetch` разрешён.
- Все внешние запросы — с таймаутом (≥10 с) и понятной ошибкой; не логировать токены.
- Не писать в чужие файлы: зоны ответственности зафиксированы в задачах.
- UI: ванильный JS (ES-модули), без сборщика, без фреймворков; всё оформление — в CSS-переменных (токенах), см. `yandex-music-redesign/THEME-SPEC.md`.
- Порт по умолчанию 5270 (`PORT` в env переопределяет).
