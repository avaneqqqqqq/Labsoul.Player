# labsoul — память проекта

Прочитай это целиком перед первой правкой. Здесь всё, что нужно,
чтобы продолжить работу без потери контекста.

**Версия: 1.0.94** (установлена у пользователя)

---

## Что это за приложение

Свой музыкальный плеер: **Яндекс.Музыка + SoundCloud + Spotify** в одном окне.
Десктоп на Electron, локальный сервер Node без зависимостей, ванильный фронтенд.

- Репозиторий: `https://github.com/avaneqqqqqq/Labsoul.Player`
- GitHub-токен: `player/data/.github-token` (93 символа, уже там)
- Сертификат подписи: `player/cert-test.pfx`, пароль `labsoul`

---

## Пути

```
КОРЕНЬ:     C:\Users\emosaltlolli\Documents\deepseek-harness\default-workspace\player
Установлен: %LOCALAPPDATA%\Programs\labsoul-desktop
Данные:     %APPDATA%\labsoul\data\settings.json
Логи:       %APPDATA%\labsoul\logs\desktop.log
```

⚠️ **ЛОВУШКА:** существует папка-двойник
`C:\Users\emosaltlolli\Documents\deepseek-harness\player` (без `default-workspace`).
Файлы иногда пишутся туда, а сборка берёт из правильной папки.
**Всегда** `Set-Location` на абсолютный путь и проверять `pwd`.

---

## Структура

```
player/
├── NOTES.md                  этот файл
├── package.json              версия, npm test
├── cert-test.pfx             сертификат подписи
├── data/.github-token        токен GitHub
├── app/                      Electron-обёртка
│   ├── main.cjs              главный процесс, IPC
│   ├── preload.cjs           мост window.playerDesktop
│   ├── discord.cjs           Rich Presence
│   ├── overlay.cjs           мини-плеер поверх окон
│   ├── miniplayer.html       страница мини-плеера
│   ├── miniplayer-preload.cjs
│   ├── oauth.cjs             вход в Яндекс
│   ├── banner.html           окно обновлений
│   ├── package.json          ⚠️ build.files — ЯВНЫЙ СПИСОК
│   └── build/                icon.ico, icon.png
├── server/
│   ├── index.mjs             HTTP-сервер, ВСЕ маршруты
│   ├── wave.mjs              движок «Волны»
│   ├── lyrics.mjs            поиск текстов
│   ├── clips.mjs             поиск клипов на YouTube
│   ├── store.mjs             настройки
│   ├── librarycache.mjs      кэш ленты
│   ├── dpi.mjs               обход блокировки (zapret)
│   ├── update.mjs            проверка обновлений
│   ├── yandexhost.mjs        выбор живого хоста Яндекса
│   ├── audioconvert.mjs      перекодирование
│   ├── providers/
│   │   ├── yandex.mjs
│   │   ├── soundcloud.mjs
│   │   ├── spotify.mjs
│   │   └── local.mjs         своя музыка
│   └── *test.mjs             тесты
├── web/
│   ├── index.html            разметка + SVG-спрайт иконок
│   ├── favicon.png
│   ├── js/
│   │   ├── main.js           вход, boot
│   │   ├── ui.js             плеер, полноэкранный, текст, клипы
│   │   ├── audio.js          Web Audio граф, состояние
│   │   ├── theme.js          настройки и нормализация
│   │   ├── api.js            запросы к серверу
│   │   ├── store.js          состояние приложения
│   │   ├── visualizer.js     анализатор спектра
│   │   ├── components.js     icon(), rowsHtml()
│   │   ├── toast.js
│   │   └── screens/          wave, library, search, sources, design
│   └── css/                  base, app, nowplaying, screens
└── tools/
    ├── push-github.mjs       заливка кода
    └── sign-release.ps1      подпись
```

---

## Что уже работает

### Источники
- **Яндекс** — каталог, «Волна» (ротор), избранное, плейлисты, тексты.
- **SoundCloud** — HLS-поток, вход через `oauth_token` из cookies.
- **Spotify** — каталог и поиск. **Полный стрим не отдаёт**, только preview.
- **Локальные файлы** — своя музыка.

### Функции (взяты у конкурентов Liner + Spide)
1. **Караоке-текст по слову** — источник `api.lrcmux.dev`.
2. **Discord Rich Presence** — своё приложение «Labsoul».
3. **Мини-плеер поверх окон** — отдельная страница, не копия приложения.
4. **Реактивный фон** — CSS-переменная `--beat` из анализатора.
5. **Нормализация громкости** — `DynamicsCompressor`.
6. **Audio Lab** — бас, глубина, теплота, ширина стерео, реверб, скорость.
7. **Режимы звука** — Студия, Lo-Fi, Nightcore, Slowed, Vaporwave.
8. **Клипы** — поиск на YouTube + синхронизация с треком.

### Интерфейс
- Страница исполнителя — клик по имени в нижнем баре и в полноэкранном.
- Оформление: 7 разделов, 37 настроек, 5 схем, 7 стилей, 5 шрифтов.
- Сброс по каждому разделу отдельно.
- Библиотека открывается на избранном.
- Полноэкранный плеер: обложка + текст + клип, всё в одной сетке.

---

## Discord — критично знать

```js
// app/discord.cjs
const CLIENT_ID = '1567249448998932490';  // приложение называется «Labsoul»
```

- Rich Presence работает **только** под зарегистрированным приложением.
  Придуманный ID → `{"code":4000,"message":"Invalid Client ID"}`.
- Имя в профиле = имя приложения на портале, **на лету не меняется**.
- Портал: https://discord.com/developers/applications
- Капча на портале не грузилась с ПК — проходила только с телефона.
- Неудачный ID `1567248147573514352` (404 Unknown Application) — не использовать.
- Обновление статуса троттлится 4 секунды, повторы строк убираются.

---

## Тексты песен

Источники параллельно: `lrclib`, `netease`, `lrcmux` (слово-уровень), `genius`.
Таймауты: lrcmux 3500 мс × 2 попытки, lrclib 3500, netease 4000.
Серверный кэш 6 часов.

**Строгая сверка lrcmux:** длительность ±8 с, название ≥55%,
исполнитель ≥45%, первая строка не позже середины трека.

**Три бага, которые ломали текст (все исправлены):**
1. `isDemo() === net.mode !== 'online'` → до готовности сервера всё в заглушках.
   Стало: `net.mode === 'demo'`.
2. Пустой ответ кэшировался в `lyricsMemo` навсегда → кэшировать только успешные.
3. Статус `none` блокировал повтор → пробовать снова раз в минуту.

**Синхронизация:** время берётся каждый кадр из `audio.currentTime`
(событие `tick`), а не из `timeupdate` (4 раза в секунду). Смещение убрано.

---

## Клипы

**Публичное API Яндекса клипы не отдаёт** — проверено: 404, полей нет.

Решение — `server/clips.mjs`:
- Два запроса параллельно: «исполнитель название клип» и без слова «клип» → 12–13 кандидатов.
- Отбор: название ×3, исполнитель ×2, плюс за «клип/official/премьера»,
  минус за slowed/cover/караоке/reaction.
- `pickEmbeddable()` через `oembed`: 200 = можно встроить, 401 = запрещено.
- Маршрут: `GET /api/clips?title=&artist=`

**Видео в интерфейсе (`ui.js`):**
- YouTube IFrame API, `controls:0`, `modestbranding:1`, `disablekb:1`, `fs:0`.
- `onReady` → `mute()` — **звук видео всегда выключен**.
- **НЕ вызывать `seekTo` при `state === -1 или 3` (buffering)** —
  seek сам запускает видео и ломает паузу.
- `destroyClipPlayer()` при закрытии панели и смене трека.
- Раскладка: `.np.is-clips` — видео слева; `.np.is-clips.is-lyrics` — три колонки.
- Интерфейс YouTube перекрыт `.np__clips-shade` (`z-index: 9`) + видео 124%.

---

## Запуск и подключение — что было исправлено в 1.0.93–1.0.94

**«Не удалось подключиться к серверу» появлялось то сразу, то через время.**

Пять рубежей защиты, все на месте:
1. **Сервер открывает порт только после загрузки провайдеров.**
   Было: `listen()` сразу, провайдеры внутри колбэка → интерфейс спрашивал
   статус в эту щель и получал заглушки.
2. **Кэш статуса только осмысленный.** Пустой ответ (провайдеры не готовы,
   таймаут) больше не залипает на минуту.
3. **`ping` при старте — 3 попытки** с паузой 600/1200 мс.
4. **`scheduleHealthCheck` — 5 попыток** с нарастающей паузой,
   а не одна и сразу «демо-навсегда».
5. **`status()` Яндекса — 3 попытки.** Первый HTTPS-запрос после запуска
   часто падает с `fetch failed` (DNS-кэш, пул соединений, обход блокировки).

**Проверено:** первый статус 30 мс, `yandex: ок soundcloud: ок`.

---

## Производительность (замеры)

| Что | Было | Стало |
|---|---|---|
| Статус сервисов | 7978 мс | 28 мс |
| Волна (холодная) | 21766 мс | 29 мс |
| SoundCloud HLS | 3718 мс | 489 мс |
| Клипы | — | 617–917 мс |

Методы: кэш статуса 60 с + прогрев; кэш ленты на диске;
`Promise.race` с потолком 7 с для источников; `content-visibility: auto`;
убран `backdrop-filter` со скроллящихся элементов.

---

## ЛОВУШКИ

1. **`build.files` — явный список.** Новый `.cjs` без записи в
   `app/package.json` не попадёт в установщик → приложение упадёт при запуске.
   Защита: автотест в `server/importtest.mjs`.
2. **Папка-двойник** — см. «Пути».
3. **Кодировка:** НЕ править русский текст через PowerShell
   (`Set-Content`, `-replace`) — двойная перекодировка и BOM.
   Только инструменты `edit` / `write`.
4. **`isDemo()`** — демо только при `net.mode === 'demo'`.
5. **Стили клипа и текста** — в `nowplaying.css`, не в `app.css`.
6. **Каждая настройка** должна нормализоваться в `normalizeTheme`,
   иначе не сохранится.
7. **Ползунки** обрабатываются в `onInput` (событие `input`),
   а не только в `onChange`.
8. **Запуск приложения из окружения агента заблокирован** —
   проверять статически, тестами и по скриншотам пользователя.
9. **Сборка может оборваться** — установщик получается 0.18–0.21 МБ вместо 98 МБ.
   Причина: занятые процессы. Повторить после паузы 10–12 секунд.

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
Start-Sleep -Seconds 12
Remove-Item "$root\app\dist" -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item "$root\.builder-cache\tmp" -Recurse -Force -ErrorAction SilentlyContinue
Set-Location "$root\app"
$env:ELECTRON_BUILDER_CACHE = "$root\.builder-cache"
$env:TMP = "$root\.builder-cache\tmp"; $env:TEMP = $env:TMP
npm.cmd run dist
```

### Подпись и portable
```powershell
Set-Location $root
& powershell -File "$root\tools\sign-release.ps1" -Pfx "cert-test.pfx" -Password "labsoul"
Compress-Archive -Path "$root\app\dist\win-unpacked\*" `
  -DestinationPath "$root\app\dist\labsoul-<V>-portable.zip"
```

### Заливка кода
```powershell
node "tools\push-github.mjs" --apply --message "что изменилось"
```

### Публикация релиза
1. Создать draft release с тегом `v<V>` через GitHub API.
2. Загрузить 4 файла: `labsoul-<V>-setup.exe`, `latest.yml`,
   `labsoul-<V>-setup.exe.blockmap`, `labsoul-<V>-portable.zip`.
3. PATCH `draft: false`.

### Установка пользователю (разрешено делать сразу)
```powershell
Get-Process labsoul -ErrorAction SilentlyContinue | Stop-Process -Force
Invoke-WebRequest "https://github.com/avaneqqqqqq/Labsoul.Player/releases/download/v<V>/labsoul-<V>-setup.exe" -OutFile "$env:TEMP\setup.exe"
Start-Process "$env:TEMP\setup.exe" -ArgumentList "/S" -Wait
(Get-Item "$env:LOCALAPPDATA\Programs\labsoul-desktop\labsoul.exe").VersionInfo.FileVersion
```

---

## Чек-лист перед выпуском

```
1. node --check всех изменённых файлов
2. npm test — 350 проверок импортов и 5 наборов
3. Добавил .cjs → проверить его в build.files
4. Добавил настройку → нормализация в theme.js
5. Добавил иконку → symbol в web/index.html
6. Добавил маршрут → проверить ответ
7. Собрал → установщик должен быть ~98 МБ, не 0.2
```

---

## Как общаться с пользователем

- Пишет по-русски, коротко, присылает скриншоты.
- **Ждёт, что версия сразу установится** — это разрешено.
- Ценит объяснение причины бага, а не только факт исправления.
- Просит всё в одном обновлении, а не по частям.
- Не любит лишних вопросов и воды.
- **Не гонять один и тот же круг правок впустую** — жалуется на расход токенов.

---

## Открытые вопросы

- Spotify не отдаёт полный стрим — треки каталога не играют.
- SoundCloud `client_id` добывается скрейпингом, может отваливаться.
- Клипы с запретом встраивания фильтруются только среди 4 лучших
  кандидатов — иногда нужного видео нет вовсе.
