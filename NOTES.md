# labsoul — рабочая память проекта

Документ для следующего запуска: что уже сделано, как устроено, где ловушки.
Версия на момент записи: **1.0.92**.

---

## Что это

Свой музыкальный плеер: **Яндекс.Музыка + SoundCloud + Spotify** в одном окне.
Десктоп на Electron, локальный сервер на Node без зависимостей, ванильный фронтенд.
Репозиторий: `https://github.com/avaneqqqqqq/Labsoul.Player`
Токен: `player/data/.github-token`

---

## Пути

```
Корень:  C:\Users\emosaltlolli\Documents\deepseek-harness\default-workspace\player
Установлено: %LOCALAPPDATA%\Programs\labsoul-desktop
Данные:  %APPDATA%\labsoul\data\settings.json
```

**ЛОВУШКА:** есть двойник `Documents\deepseek-harness\player` (без `default-workspace`).
Файлы иногда пишутся туда, а сборка берёт из правильной папки. Всегда проверять `pwd`.

---

## Структура

```
player/
├── app/                      Electron
│   ├── main.cjs              главный процесс, IPC
│   ├── preload.cjs           мост playerDesktop → интерфейс
│   ├── discord.cjs           Rich Presence, CLIENT_ID
│   ├── overlay.cjs           мини-плеер поверх окон
│   ├── miniplayer.html       страница мини-плеера
│   ├── miniplayer-preload.cjs
│   ├── package.json          build.files — ЯВНЫЙ СПИСОК!
│   └── build/                icon.ico, icon.png
├── server/
│   ├── index.mjs             HTTP-сервер, все маршруты
│   ├── wave.mjs              движок «Волны»
│   ├── lyrics.mjs            поиск текстов
│   ├── clips.mjs             поиск клипов на YouTube
│   ├── store.mjs             настройки
│   ├── librarycache.mjs      кэш ленты
│   ├── dpi.mjs               обход блокировки (zapret)
│   ├── update.mjs            проверка обновлений
│   └── providers/            yandex.mjs, soundcloud.mjs, spotify.mjs
├── web/
│   ├── index.html            разметка + SVG-спрайт иконок
│   ├── js/
│   │   ├── main.js           вход, boot
│   │   ├── ui.js             плеер, полноэкранный, текст, клипы
│   │   ├── audio.js          Web Audio граф, состояние
│   │   ├── theme.js          настройки, нормализация
│   │   ├── api.js            запросы к серверу
│   │   ├── store.js          состояние приложения
│   │   ├── visualizer.js     анализатор спектра
│   │   └── screens/          wave, library, search, sources, design
│   └── css/                  base, app, nowplaying, screens
└── tools/                    push-github.mjs, sign-release.ps1
```

---

## Что уже сделано

### Источники
- **Яндекс** — каталог, «Волна» (ротор), избранное, плейлисты, тексты.
- **SoundCloud** — HLS-поток, вход через `oauth_token` из cookies, поиск, лайки.
- **Spotify** — каталог и поиск (Web API не отдаёт полный стрим, только preview).

### Функции из конкурентов (Liner + Spide)
1. **Караоке-текст по слову** — источник `api.lrcmux.dev`.
2. **Discord Rich Presence** — `app/discord.cjs`.
3. **Мини-плеер поверх окон** — `app/overlay.cjs` + `miniplayer.html`.
4. **Реактивный фон** — CSS-переменная `--beat` из анализатора.
5. **Нормализация громкости** — `DynamicsCompressor`.
6. **Audio Lab** — бас, глубина, теплота, ширина стерео, реверб, скорость.
7. **Режимы звука** — Студия, Lo-Fi, Nightcore, Slowed, Vaporwave.
8. **Клипы к трекам** — поиск видео на YouTube + синхронизация.

### Прочее
- Страница исполнителя (клик по имени в баре и в полноэкранном).
- Оформление: 7 разделов, 37 настроек, 5 схем, 7 стилей, 5 шрифтов.
- Сброс по каждому разделу отдельно.
- Библиотека открывается на избранном.

---

## Discord — важные факты

```js
// app/discord.cjs
const CLIENT_ID = '1567249448998932490';  // приложение называется «Labsoul»
```

- Rich Presence работает **только** под зарегистрированным приложением.
  Придуманный ID → `{"code":4000,"message":"Invalid Client ID"}`.
- Имя в профиле = имя приложения на портале, на лету не меняется.
- Портал: https://discord.com/developers/applications
- Капча на портале не грузилась с ПК — прошла только с телефона.
- Неудачный ID `1567248147573514352` (404 Unknown Application) — не использовать.

---

## Тексты песен

Источники параллельно: `lrclib`, `netease`, `lrcmux` (слово-уровень), `genius`.
Таймауты: lrcmux 3500 мс × 2 попытки, lrclib 3500, netease 4000.

**Строгая сверка lrcmux:** длительность ±8 с, название ≥55%, исполнитель ≥45%,
первая строка не позже середины трека.

**ЛОВУШКА:** `isDemo()` должен быть `net.mode === 'demo'`, а не `!== 'online'`.
Иначе до готовности сервера все запросы идут в заглушки и текст «не находится».

**Три бага, которые ломали текст:**
1. Пустой ответ кэшировался в `lyricsMemo` навсегда → кэшировать только успешные.
2. Статус `none` блокировал повторный запрос → пробовать раз в минуту.
3. Клик по строке брал индекс из полного массива → использовать `state.shownLines`.

**Синхронизация:** время берётся каждый кадр из `audio.currentTime` (событие `tick`),
а не из `timeupdate` (4 раза в секунду).

---

## Клипы

**Публичное API Яндекса клипы не отдаёт** — проверено, 404 и нет полей в треке.

Решение — `server/clips.mjs`, поиск на YouTube:
- Два запроса параллельно (со словом «клип» и без) → 12–13 кандидатов.
- Отбор автоматический: название ×3, исполнитель ×2,
  плюс за «клип/official/премьера», минус за slowed/cover/караоке/reaction.
- `pickEmbeddable()` через `oembed`: 200 = можно встроить, 401 = запрещено.
- Маршрут: `GET /api/clips?title=&artist=`

**Видео в интерфейсе:**
- YouTube IFrame API, `controls:0`, `modestbranding:1`, `disablekb:1`, `fs:0`.
- `onReady` → `mute()` — **звук видео всегда выключен**, музыку даёт плеер.
- **НЕ вызывать `seekTo` при `state === -1 или 3` (buffering)** — seek сам
  запускает видео и ломает паузу.
- `destroyClipPlayer()` при закрытии панели и смене трека.
- Раскладка: `.np.is-clips` — видео слева; `.np.is-clips.is-lyrics` — три колонки.
- Интерфейс YouTube перекрыт `.np__clips-shade` (`z-index: 9`) + видео 124%.

---

## Производительность (замеры)

| Что | Было | Стало |
|---|---|---|
| Статус сервисов | 7978 мс | 28 мс |
| Волна (холодная) | 21766 мс | 29 мс |
| SoundCloud (HLS) | 3718 мс | 489 мс |
| Клипы | — | 617–917 мс |

Методы: кэш статуса 60 с + прогрев при старте; кэш ленты на диске;
`Promise.race` с потолком 7 с; `content-visibility: auto`;
без `backdrop-filter` на скроллящихся элементах.

---

## ЛОВУШКИ

1. **`build.files` — явный список.** Новый `.cjs` без записи в `app/package.json`
   не попадёт в установщик → приложение упадёт при запуске.
   Защита: автотест в `server/importtest.mjs`.
2. **Папка-двойник** — см. «Пути». Всегда проверять `pwd`.
3. **Кодировка:** НЕ править русский текст через PowerShell (`Set-Content`,
   `-replace`) — двойная перекодировка и BOM. Только `edit`/`write`.
4. **`isDemo()`** — демо только при `net.mode === 'demo'`.
5. **Стили клипа и текста** — в `nowplaying.css`, не в `app.css`.
6. **Каждая настройка** должна нормализоваться в `normalizeTheme`, иначе не сохранится.
7. **Ползунки** обрабатываются в `onInput` (событие `input`), а не только в `onChange`.
8. **Запуск приложения из окружения агента заблокирован** — проверять только
   статически, тестами и по скриншотам пользователя.

---

## Команды

### Тесты
```
npm test
# selftest 19 + oauth 17 + streamtest 8 + yandexmock 9 + lyrics 8 + imports 350
```

### Сборка
```powershell
$root = "C:\Users\emosaltlolli\Documents\deepseek-harness\default-workspace\player"
Get-Process labsoul,electron,app-builder,makensis -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 10
Remove-Item "$root\app\dist" -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item "$root\.builder-cache\tmp" -Recurse -Force -ErrorAction SilentlyContinue
Set-Location "$root\app"
$env:ELECTRON_BUILDER_CACHE = "$root\.builder-cache"
$env:TMP = "$root\.builder-cache\tmp"; $env:TEMP = $env:TMP
npm.cmd run dist
```

**Если установщик получился 0.18–0.21 МБ — сборка оборвалась.** Повторить
с большей паузой (10–12 секунд) после завершения процессов.

### Подпись и portable
```powershell
& powershell -File "$root\tools\sign-release.ps1" -Pfx "cert-test.pfx" -Password "labsoul"
Compress-Archive -Path "$root\app\dist\win-unpacked\*" `
  -DestinationPath "$root\app\dist\labsoul-<V>-portable.zip"
```

### Публикация
1. Создать draft release с тегом `v<V>`.
2. Загрузить: `labsoul-<V>-setup.exe`, `latest.yml`, `.blockmap`, `-portable.zip`.
3. PATCH `draft: false`.

### Установка пользователю
```powershell
Get-Process labsoul -ErrorAction SilentlyContinue | Stop-Process -Force
Invoke-WebRequest "https://github.com/avaneqqqqqq/Labsoul.Player/releases/download/v<V>/labsoul-<V>-setup.exe" -OutFile "$env:TEMP\setup.exe"
Start-Process "$env:TEMP\setup.exe" -ArgumentList "/S" -Wait
(Get-Item "$env:LOCALAPPDATA\Programs\labsoul-desktop\labsoul.exe").VersionInfo.FileVersion
```

---

## Проверка перед выпуском

```
1. node --check всех изменённых файлов
2. npm test — 350 проверок импортов и 5 наборов
3. Если добавлял .cjs — проверить его в build.files
4. Если добавлял настройку — нормализация в theme.js
5. Если добавлял иконку — symbol в web/index.html
6. Если добавлял маршрут — проверить ответ через fetch
```

---

## Стиль работы с пользователем

- Пишет по-русски, коротко, присылает скриншоты.
- Ждёт, что обновление сразу установится — это разрешено.
- Ценит объяснение причины бага, а не только факт исправления.
- Просит всё в одном обновлении, а не по частям.
- Не любит лишних вопросов и воды.

---

## Открытые вопросы

- Клипы с запретом встраивания фильтруются через `oembed`, но проверка
  идёт только для 4 лучших кандидатов — иногда нужного видео нет вовсе.
- Spotify не отдаёт полный стрим: треки каталога не играют.
- SoundCloud `client_id` добывается скрейпингом, может отваливаться.
