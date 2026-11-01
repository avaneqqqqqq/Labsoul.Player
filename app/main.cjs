'use strict';

/**
 * Десктопная оболочка labsoul.
 *
 * Запускает локальный сервер (server/index.mjs) отдельным процессом Node
 * (через ELECTRON_RUN_AS_NODE), ждёт /api/health и открывает окно с интерфейсом.
 * Данные пользователя — в userData/data, поэтому плеер и браузерная версия
 * не мешают друг другу.
 */

const { app, BrowserWindow, Menu, Tray, dialog, shell, globalShortcut, ipcMain, session } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const net = require('node:net');
const { spawn } = require('node:child_process');
const oauth = require('./oauth.cjs');

// Если файл запустили обычным node (или с ELECTRON_RUN_AS_NODE=1), electron-модули
// приходят пустыми — подсказываем правильный способ запуска вместо стектрейса.
if (!app || typeof app.isPackaged !== 'boolean') {
  console.error(
    'labsoul: этот файл запускается только через Electron.\n' +
      'Используйте start.cmd в этой папке или `npm.cmd start` (а не `node main.cjs`).',
  );
  process.exit(1);
}

const IS_PACKAGED = app.isPackaged;
const PLAYER_ROOT = IS_PACKAGED ? process.resourcesPath : path.join(__dirname, '..');
const SERVER_ENTRY = path.join(PLAYER_ROOT, 'server', 'index.mjs');
const APP_ICON = path.join(__dirname, 'build', 'icon.png');
const DATA_DIR = path.join(app.getPath('userData'), 'data');

let serverProcess = null;
let mainWindow = null;
let tray = null;
let currentPort = 5270;
let quitting = false;

/* ------------------------------- утилиты --------------------------------- */

function logPath() {
  const dir = path.join(app.getPath('userData'), 'logs');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'desktop.log');
}

function log(message) {
  const line = `${new Date().toISOString()} ${message}`;
  console.log(line);
  try {
    fs.appendFileSync(logPath(), line + '\n');
  } catch { /* лог не критичен */ }
}

function findFreePort(start = 5270) {
  return new Promise((resolve) => {
    const attempt = (port) => {
      const probe = net.createServer();
      probe.once('error', () => {
        if (port < start + 20) attempt(port + 1);
        else resolve(start);
      });
      probe.once('listening', () => probe.close(() => resolve(port)));
      probe.listen(port, '127.0.0.1');
    };
    attempt(start);
  });
}

async function waitForHealth(port, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1500) });
      if (res.ok) return true;
    } catch { /* сервер ещё поднимается */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

/* -------------------------------- сервер --------------------------------- */

function startServer(port) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  log(`запуск сервера: ${SERVER_ENTRY} (port ${port})`);

  // Перезапуск сервера вместо аварийного выхода из приложения.
  //
  // Раньше любой разрыв связи с дочерним процессом закрывал labsoul целиком:
  // пользователь видел, что приложение просто исчезло. Теперь сервер
  // поднимается заново, а если не удаётся за несколько попыток — только тогда
  // показываем понятное сообщение.
  let restarts = 0;

  const attach = (child) => {
    child.on('exit', (code, signal) => {
      log(`сервер остановился: code=${code} signal=${signal}`);
      if (serverProcess === child) serverProcess = null;
      if (quitting) return;

      if (restarts >= 3) {
        log('сервер не поднимается после 3 попыток — закрываем приложение');
        dialog.showErrorBox(
          'labsoul не удалось запустить',
          `Локальный сервер падает при старте (${restarts} попыток).\n\nЛог: ${logPath()}`,
        );
        app.quit();
        return;
      }

      restarts += 1;
      log(`перезапуск сервера, попытка ${restarts}`);
      setTimeout(() => {
        if (quitting) return;
        const child2 = spawnServer(currentPort || 5270);
        serverProcess = child2;
        attach(child2);
      }, 800);
    });
  };

  serverProcess = spawnServer(port);
  attach(serverProcess);
}

/** Запуск дочернего процесса сервера (вынесено для перезапуска). */
function spawnServer(port) {
  const child = spawn(process.execPath, [SERVER_ENTRY, `--port=${port}`], {
    cwd: PLAYER_ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      PLAYER_DATA_DIR: DATA_DIR,
      PLAYER_VERSION: app.getVersion(),
      ELECTRON_RUN_AS_NODE: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  child.stdout.on('data', (chunk) => log('[server] ' + String(chunk).trim()));
  child.stderr.on('data', (chunk) => log('[server:err] ' + String(chunk).trim()));
  return child;
}


function stopServer() {
  if (!serverProcess) return;
  log('остановка сервера');

  // Убиваем ТОЛЬКО дочерний процесс по его PID. Раньше здесь стоял
  // `taskkill /IM labsoul.exe /T` — он отстреливал все процессы labsoul,
  // включая сам Electron, из-за чего приложение закрывалось сразу после старта.
  const childPid = serverProcess.pid;
  try {
    serverProcess.kill();
  } catch { /* уже умер */ }
  serverProcess = null;

  if (process.platform === 'win32' && childPid) {
    try {
      const { execFileSync } = require('node:child_process');
      execFileSync('taskkill', ['/F', '/PID', String(childPid), '/T'], {
        stdio: 'ignore',
        timeout: 5000,
      });
    } catch { /* процесса уже нет — это нормально */ }
  }
}

/**
 * Освободить файлы приложения перед установкой обновления.
 *
 * Установщик не может заменить labsoul.exe, пока файл кем-то держится: отсюда
 * «Не удалось закрыть labsoul». Здесь МЫ не убиваем себя по имени —
 * наоборот, гасим всё, что мешает установщику, и даём процессам время
 * освободить дескрипторы.
 *
 * @param {number} waitMs — сколько ждать освобождения файла
 */
async function releaseFilesForInstaller(waitMs = 8000) {
  if (process.platform !== 'win32') return true;
  const exePath = process.execPath;

  const locked = () => {
    try {
      const fd = fs.openSync(exePath, 'r+');
      fs.closeSync(fd);
      return false;
    } catch {
      return true;
    }
  };

  const deadline = Date.now() + waitMs;
  while (locked() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const freed = !locked();
  log(`освобождение файлов перед установкой: ${freed ? 'готово' : 'файл всё ещё занят'}`);
  return freed;
}

/* --------------------------------- окно ---------------------------------- */

function createWindow(port) {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1000,
    minHeight: 640,
    backgroundColor: '#0b0b0f',
    title: 'labsoul',
    icon: fs.existsSync(APP_ICON) ? APP_ICON : undefined,
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      partition: 'persist:player',
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
      preload: path.join(__dirname, 'preload.cjs'),
    },
  });

  // после обновления в кэше Chromium могут остаться старые модули интерфейса:
  // чистим кэш, иначе окно открывается пустым («подключение…»)
  try {
    const sess = mainWindow.webContents.session;
    sess.clearCache()
      .then(() => sess.clearStorageData({ storages: ['serviceworkers', 'cachestorage'] }))
      .then(() => log('кэш интерфейса очищен'))
      .catch((err) => log('кэш не очищен: ' + ((err && err.message) || err)));
  } catch (err) {
    log('кэш не очищен: ' + ((err && err.message) || err));
  }

  mainWindow.loadURL(`http://127.0.0.1:${port}/`);

  mainWindow.once('ready-to-show', () => mainWindow.show());

  // внешние ссылки — в системный браузер
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('did-fail-load', (_event, code, description) => {
    log(`окно не загрузилось: ${code} ${description}`);
  });

  // баннер обновления едет вместе с окном и прячется при сворачивании
  mainWindow.on('move', positionBanner);
  mainWindow.on('resize', positionBanner);

  // Сворачивание оставляет окно в панели задач — в трей уходит только по
  // явной команде «Свернуть в трей» из меню.
  // плашка — отдельное окно поверх. Прячем только при сворачивании/скрытии:
  // на blur её убирать нельзя — иначе клик по кнопке «Скачать» не доходит,
  // плашка исчезает прямо под курсором.
  mainWindow.on('minimize', () => {
    hideUpdateBanner();
  });
  mainWindow.on('show', () => {
    if (updateFlow.phase !== 'idle' && updateFlow.phase !== 'closed') showUpdateBanner();
  });
  mainWindow.on('hide', () => {
    hideUpdateBanner();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    hideUpdateBanner();
  });
}

function toggleWindow() {
  if (!mainWindow) {
    createWindow(currentPort);
    return;
  }
  if (mainWindow.isVisible()) mainWindow.hide();
  else {
    mainWindow.show();
    mainWindow.focus();
  }
}

/* --------------------- вход в Яндекс.Музыку ------------------------------ */

let authWindow = null;

/** Кладём полученный токен в локальный сервер (он же проверит его через /account/status). */
async function saveYandexToken(token) {
  const res = await fetch(`http://127.0.0.1:${currentPort}/api/settings`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ yandex: { token } }),
    signal: AbortSignal.timeout(15000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data && data.error && data.error.message) || `сервер ответил ${res.status}`);
  return data;
}

/**
 * Открывает окно авторизации Яндекса и возвращает {ok, user?} или {ok:false, error, message}.
 * Токен приходит в hash-части адреса, поэтому дополнительно опрашиваем location.href.
 */
function signInYandexOAuth() {
  if (authWindow && !authWindow.isDestroyed()) {
    authWindow.focus();
    return Promise.resolve({ ok: false, error: 'already_open', message: 'Окно входа уже открыто.' });
  }

  return new Promise((resolve) => {
    const client = oauth.OAUTH_CLIENTS[0];
    let settled = false;
    let poller = null;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (poller) clearInterval(poller);
      if (authWindow && !authWindow.isDestroyed()) authWindow.destroy();
      authWindow = null;
      if (result.ok && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('auth:changed', { source: 'yandex' });
      }
      log(`вход в Яндекс: ${result.ok ? 'успешно' : 'не выполнен (' + result.error + ')'}`);
      resolve(result);
    };

    const considerUrl = async (url) => {
      if (settled || !url) return;
      const error = oauth.extractError(url);
      if (error) {
        finish({ ok: false, error: error.code, message: oauth.describeError(error) });
        return;
      }
      const token = oauth.extractToken(url);
      if (!token) return;
      try {
        const data = await saveYandexToken(token);
        const state = data && data.sources ? data.sources.yandex : null;
        if (state && state.connected === false) {
          finish({
            ok: false,
            error: state.error || 'AUTH_FAILED',
            message: 'Яндекс не принял токен — попробуйте войти ещё раз.',
          });
          return;
        }
        finish({ ok: true, user: (state && state.user) || null });
      } catch (err) {
        finish({ ok: false, error: 'SAVE_FAILED', message: err.message });
      }
    };

    authWindow = new BrowserWindow({
      width: 520,
      height: 720,
      parent: mainWindow || undefined,
      modal: Boolean(mainWindow),
      title: 'Вход в Яндекс.Музыку',
      icon: fs.existsSync(APP_ICON) ? APP_ICON : undefined,
      autoHideMenuBar: true,
      webPreferences: {
        partition: 'persist:labsoul-oauth',
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
      },
    });

    authWindow.on('closed', () => {
      authWindow = null;
      if (!settled) {
        settled = true;
        if (poller) clearInterval(poller);
        resolve({ ok: false, error: 'closed', message: 'Окно входа закрыто.' });
      }
    });

    authWindow.webContents.on('will-navigate', (_event, url) => considerUrl(url));
    authWindow.webContents.on('will-redirect', (_event, url) => considerUrl(url));

    // hash-часть адреса не порождает навигационных событий — дочитываем отдельно
    poller = setInterval(async () => {
      if (settled || !authWindow || authWindow.isDestroyed()) return;
      try {
        const href = await authWindow.webContents.executeJavaScript('location.href', true);
        await considerUrl(href);
        if (settled) return;
        // Яндекс мог показать страницу ошибки приложения (например, отключённый client_id):
        // тогда молча ждать бессмысленно — сообщаем наверх, чтобы перейти к запасному пути
        const title = await authWindow.webContents
          .executeJavaScript('document.title', true)
          .catch(() => '');
        if (title && /не существует|недействительн|ошибка|error|invalid|не найден/i.test(title)) {
          finish({ ok: false, error: 'oauth_page_error', message: `Яндекс не принял приложение: ${title}` });
        }
      } catch { /* окно уже закрывается */ }
    }, 900);

    authWindow.loadURL(oauth.buildAuthUrl(client.id));
  });
}

/* ------------------- вход через саму Яндекс.Музыку ----------------------- */

/**
 * Открывает музыкальный сервис в своём окне и забирает OAuth-токен из его же
 * запросов к api.music.yandex.net: пользователь просто входит как обычно, а
 * токен перехватывается заголовком Authorization. Так не нужен ни client_id,
 * ни ручное копирование — и это работает, даже если OAuth-приложение Яндекса
 * когда-нибудь отключат.
 */
function signInYandexSite() {
  if (authWindow && !authWindow.isDestroyed()) {
    authWindow.focus();
    return Promise.resolve({ ok: false, error: 'already_open', message: 'Окно входа уже открыто.' });
  }

  return new Promise((resolve) => {
    const PARTITION = 'persist:labsoul-yandex';
    const sess = session.fromPartition(PARTITION);
    let settled = false;
    let captured = false;

    const cleanup = () => {
      try {
        sess.webRequest.onBeforeSendHeaders(null);
      } catch { /* уже снят */ }
    };

    const finish = (result) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (authWindow && !authWindow.isDestroyed()) authWindow.destroy();
      authWindow = null;
      if (result.ok && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('auth:changed', { source: 'yandex' });
      }
      log(`вход в Яндекс (окно сервиса): ${result.ok ? 'успешно' : 'не выполнен (' + result.error + ')'}`);
      resolve(result);
    };

    const acceptToken = async (token) => {
      if (settled || captured || !token) return;
      captured = true;
      try {
        const data = await saveYandexToken(token);
        const state = data && data.sources ? data.sources.yandex : null;
        if (state && state.connected === false) {
          captured = false;
          return; // токен пришёл, но сервис его не принял — ждём следующего
        }
        finish({ ok: true, user: (state && state.user) || null });
      } catch (err) {
        finish({ ok: false, error: 'SAVE_FAILED', message: err.message });
      }
    };

    const onHeaders = (details, callback) => {
      const headers = details.requestHeaders || {};
      // смотрим все запросы окна, но реагируем только на яндексовые хосты:
      // сервис может ходить и в api.music.yandex.net, и в другие свои поддомены
      const host = String(details.url || '').toLowerCase();
      if (/yandex\./.test(host)) {
        const auth = headers.Authorization || headers.authorization;
        const token = oauth.tokenFromAuthorizationHeader(auth);
        if (token) acceptToken(token);
      }
      callback({ requestHeaders: headers });
    };

    try {
      sess.webRequest.onBeforeSendHeaders({ urls: ['<all_urls>'] }, onHeaders);
    } catch (err) {
      finish({ ok: false, error: 'SNIFF_FAILED', message: err.message });
      return;
    }

    authWindow = new BrowserWindow({
      width: 1060,
      height: 780,
      parent: mainWindow || undefined,
      modal: Boolean(mainWindow),
      title: 'Вход в Яндекс.Музыку — окно закроется само',
      icon: fs.existsSync(APP_ICON) ? APP_ICON : undefined,
      autoHideMenuBar: true,
      webPreferences: {
        partition: PARTITION,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
      },
    });

    authWindow.on('closed', () => {
      authWindow = null;
      if (!settled) {
        settled = true;
        cleanup();
        resolve({
          ok: false,
          error: 'closed',
          message: 'Окно закрыто до входа. Можно попробовать снова или вставить токен вручную.',
        });
      }
    });

    // если сервис не сделал ни одного запроса с токеном (например, не открылся),
    // окно не держим вечно
    const timer = setTimeout(() => {
      if (!settled && !captured) {
        finish({
          ok: false,
          error: 'no_token',
          message: 'Токен не появился: войдите в аккаунт в открывшемся окне.',
        });
      }
    }, 5 * 60 * 1000);
    authWindow.on('closed', () => clearTimeout(timer));

    // подсказка поверх страницы сервиса: пользователю должно быть понятно, что делать
    authWindow.webContents.on('did-finish-load', () => {
      authWindow.webContents
        .executeJavaScript(
          `(() => {
             if (document.getElementById('labsoul-hint')) return;
             const bar = document.createElement('div');
             bar.id = 'labsoul-hint';
             bar.textContent = 'labsoul: войдите в аккаунт — окно закроется само и подключение произойдёт';
             bar.style.cssText = 'position:fixed;z-index:2147483647;left:0;right:0;top:0;padding:10px 14px;' +
               'background:#ffd23f;color:#17140a;font:600 13px/1.4 system-ui,sans-serif;text-align:center;' +
               'box-shadow:0 2px 12px rgba(0,0,0,.35)';
             document.documentElement.appendChild(bar);
             document.body.style.paddingTop = '42px';
           })()`,
          true,
        )
        .catch(() => { /* служебная подсказка, на ошибку не влияет */ });
    });

    authWindow.loadURL('https://music.yandex.ru/');
  });
}

/**
 * Кнопка «Войти». Порядок попыток:
 *   1. классический OAuth Яндекса — вход и «Разрешить», токен приходит сразу в адресе;
 *   2. окно самого сервиса — пользователь просто входит, токен перехватывается из запросов;
 *   3. если оба пути не сработали — предложение вставить токен вручную.
 */
async function signInYandex() {
  // Основной путь — вход на самом сайте Яндекс.Музыки: пользователь обычно уже
  // залогинен в Яндексе, поэтому достаточно открыть сервис, а токен перехватывается
  // из запросов к api.music.yandex.net. OAuth-страница (oauth.yandex.ru/authorize)
  // показывает общую авторизацию Яндекса и часто не возвращает токен в адресе —
  // из-за этого окно открывалось, а подключение не происходило.
  const siteResult = await signInYandexSite();
  if (siteResult.ok) return siteResult;
  if (siteResult.error === 'closed') return siteResult;

  // запасной путь: OAuth-приложение, если перехват на сайте не сработал
  const oauthResult = await signInYandexOAuth();
  if (oauthResult.ok) return oauthResult;
  if (oauthResult.error === 'closed' || oauthResult.error === 'access_denied') return oauthResult;

  const choice = dialog.showMessageBoxSync(mainWindow || undefined, {
    type: 'question',
    title: 'Вход в Яндекс.Музыку',
    message: siteResult.message || oauthResult.message || 'Не удалось войти автоматически',
    detail:
      'Можно попробовать ещё раз или вставить токен вручную в разделе «Подключения» (DevTools → Network → ' +
      'Authorization: OAuth …).',
    buttons: ['Попробовать ещё раз', 'Вставить токен вручную'],
    defaultId: 0,
    cancelId: 1,
  });
  if (choice === 0) return signInYandexOAuth();
  return { ok: false, error: 'manual', message: 'Вставьте токен вручную в разделе «Подключения».' };
}

ipcMain.handle('auth:yandex', () => signInYandex());

/* --------------------------- вход в SoundCloud --------------------------- */

let soundcloudAuthWindow = null;

/**
 * Одноразовый вход в SoundCloud.
 *
 * Открываем обычное окно входа с постоянным профилем (persist:labsoul-soundcloud):
 * после логина SoundCloud ставит cookie oauth_token — забираем их и отдаём
 * серверу, чтобы он сам тянул лайки и плейлисты. Повторно входить не нужно:
 * профиль остаётся, сервер проверяет сессию при запуске.
 */
function signInSoundCloud() {
  if (soundcloudAuthWindow && !soundcloudAuthWindow.isDestroyed()) {
    soundcloudAuthWindow.focus();
    return Promise.resolve({ ok: false, error: 'already_open', message: 'Окно входа уже открыто.' });
  }

  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
      try {
        if (soundcloudAuthWindow && !soundcloudAuthWindow.isDestroyed()) soundcloudAuthWindow.close();
      } catch { /* ignore */ }
      soundcloudAuthWindow = null;
    };

    soundcloudAuthWindow = new BrowserWindow({
      width: 520,
      height: 760,
      parent: mainWindow || undefined,
      modal: false,
      show: true,
      title: 'Вход в SoundCloud',
      autoHideMenuBar: true,
      webPreferences: {
        partition: 'persist:labsoul-soundcloud',
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
      },
    });

    const session = soundcloudAuthWindow.webContents.session;

    // проверяем сессию после каждой загрузки: как только появился oauth_token — готово
    const checkSession = async () => {
      try {
        // сессия ставится на разные хосты (soundcloud.com, secure.soundcloud.com, m.soundcloud.com),
        // поэтому берём ВСЕ cookie сессии и фильтруем по имени
        const all = await session.cookies.get({});
        const cookies = all.filter((item) => /soundcloud/i.test(item.domain || '') && item.value);

        // sc_session ставится ДО входа (анонимная сессия) — считать её входом нельзя,
        // иначе окно закрывается через пару секунд и форма логина исчезает
        const token = cookies.find(
          (item) => /^oauth_token$/i.test(item.name) && item.value && item.value.length > 8,
        );
        if (!token) {
          log('SoundCloud: ждём входа (oauth_token ещё нет)');
          return;
        }

        const payload = {
          cookies: JSON.stringify(cookies),
          clientId: process.env.SOUNDCLOUD_CLIENT_ID || '',
          profileUrl: '',
        };
        log('SoundCloud: сессия получена, передаю на сервер');

        const res = await fetch(`http://127.0.0.1:${currentPort}/api/soundcloud/session`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(15000),
        });
        const data = await res.json().catch(() => ({}));
        finish({ ok: res.ok, me: data?.me || null, error: data?.error || null });
      } catch (err) {
        log('SoundCloud: проверка сессии не удалась — ' + ((err && err.message) || err));
      }
    };

    soundcloudAuthWindow.webContents.on('did-finish-load', () => {
      const url = soundcloudAuthWindow?.webContents.getURL() || '';
      log('SoundCloud: страница ' + url.slice(0, 70));
      // после логина SoundCloud уводит на /you, /discover или /stream — проверяем с запасом
      [0, 1500, 3500, 6000, 10000].forEach((delay) => setTimeout(checkSession, delay));
    });

    // следим за переходами: успешный вход = уход со страницы signin
    soundcloudAuthWindow.webContents.on('did-navigate', (_e, url) => {
      log('SoundCloud: переход ' + String(url).slice(0, 70));
      [500, 2000, 5000].forEach((delay) => setTimeout(checkSession, delay));
    });

    soundcloudAuthWindow.on('closed', () => {
      soundcloudAuthWindow = null;
      if (!settled) { settled = true; resolve({ ok: false, canceled: true }); }
    });

    soundcloudAuthWindow.loadURL('https://soundcloud.com/signin');
  });
}

ipcMain.handle('auth:soundcloud', () => signInSoundCloud());

/* --------------------------- своя музыка --------------------------------- */

ipcMain.handle('local:pick', async () => {
  const result = await dialog.showOpenDialog(mainWindow || undefined, {
    title: 'Добавить свою музыку',
    buttonLabel: 'Добавить',
    properties: ['openFile', 'multiSelections', 'openDirectory'],
    filters: [{ name: 'Аудио', extensions: ['mp3', 'flac', 'm4a', 'aac', 'ogg', 'opus', 'wav', 'webm'] }],
  });

  if (result.canceled || !result.filePaths.length) return { ok: false, canceled: true };

  try {
    const res = await fetch('http://127.0.0.1:' + currentPort + '/api/local/import', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ paths: result.filePaths }),
      signal: AbortSignal.timeout(120000),
    });
    const data = await res.json().catch(() => ({}));
    log('своя музыка: добавлено ' + (data.added || 0) + ', пропущено ' + (data.skipped || 0));
    return { ok: res.ok, added: data.added || 0, skipped: data.skipped || 0, errors: data.errors || [] };
  } catch (err) {
    log('своя музыка: ошибка импорта ' + ((err && err.message) || err));
    return { ok: false, error: (err && err.message) || 'не удалось добавить файлы' };
  }
});


/* ----------------------- уведомление об обновлении ----------------------- */

const BANNER_W = 560;
const BANNER_H = 78;
let bannerWin = null;

/** Состояние обновления: idle → available → downloading → ready | error. */
const updateFlow = {
  phase: 'idle',
  version: null,
  url: null,
  percent: 0,
  error: null,
};

const appSettingsPath = () => path.join(app.getPath('userData'), 'settings.json');

function readAppSettings() {
  try {
    return JSON.parse(fs.readFileSync(appSettingsPath(), 'utf8'));
  } catch {
    return {};
  }
}

function writeAppSettings(patch) {
  try {
    const next = { ...readAppSettings(), ...(patch || {}) };
    fs.mkdirSync(path.dirname(appSettingsPath()), { recursive: true });
    fs.writeFileSync(appSettingsPath(), JSON.stringify(next, null, 2), 'utf8');
  } catch { /* настройки окна — не критично */ }
}

/* --------------------------- автообновление ------------------------------ */

let updater = null;
let updaterTried = false;

/** electron-updater подключаем лениво: в dev-режиме он не нужен. */
function getUpdater() {
  if (updaterTried) return updater;
  updaterTried = true;
  try {
    ({ autoUpdater: updater } = require('electron-updater'));
    log('electron-updater загружен');
  } catch (err) {
    updater = null;
    log('electron-updater недоступен: ' + ((err && err.message) || err));
  }
  return updater;
}

function setupUpdater() {
  const instance = getUpdater();
  if (!instance) return;
  if (!IS_PACKAGED) {
    log('автообновление выключено: режим разработки');
    return;
  }

  instance.autoDownload = false;
  instance.autoInstallOnAppQuit = true;
  instance.allowPrerelease = false;
  instance.allowDowngrade = false;

  instance.on('download-progress', (progress) => {
    updateFlow.percent = Number(progress && progress.percent) || 0;
    if (updateFlow.phase === 'downloading') sendBannerState();
  });

  instance.on('update-downloaded', (info) => {
    updateFlow.phase = 'ready';
    updateFlow.version = (info && info.version) || updateFlow.version;
    updateFlow.percent = 100;
    log('обновление скачано: ' + updateFlow.version);
    showUpdateBanner();
  });

  instance.on('error', (err) => {
    log('ошибка автообновления: ' + ((err && err.message) || err));
    if (updateFlow.phase === 'downloading' || updateFlow.phase === 'ready') {
      updateFlow.phase = 'error';
      updateFlow.error = (err && err.message) || 'не удалось скачать обновление';
      showUpdateBanner();
    }
  });

  log('автообновление включено');
}

/* ----------------------- уведомление об обновлении ----------------------- */

function bannerState() {
  return {
    mode: updateFlow.phase,
    version: updateFlow.version,
    current: app.getVersion(),
    percent: Math.round(updateFlow.percent || 0),
    url: updateFlow.url,
    error: updateFlow.error,
  };
}

function positionBanner() {
  if (!bannerWin || bannerWin.isDestroyed() || !mainWindow || mainWindow.isDestroyed()) return;
  const bounds = mainWindow.getBounds();
  bannerWin.setBounds({
    x: bounds.x + Math.round((bounds.width - BANNER_W) / 2),
    y: bounds.y + 38,
    width: BANNER_W,
    height: BANNER_H,
  });
}

function sendBannerState() {
  if (bannerWin && !bannerWin.isDestroyed()) bannerWin.webContents.send('banner:state', bannerState());
}

/** Плавающая плашка поверх окна плеера — как в прежней оболочке. */
function showUpdateBanner() {
  // если главное окно свёрнуто или скрыто — плашка не должна висеть на экране
  const mainVisible = mainWindow && !mainWindow.isDestroyed() && !mainWindow.isMinimized() && mainWindow.isVisible();
  if (!mainVisible) {
    log('баннер обновления отложен: окно не на экране');
    return;
  }

  if (bannerWin && !bannerWin.isDestroyed()) {
    sendBannerState();
    positionBanner();
    bannerWin.showInactive();
    return;
  }

  bannerWin = new BrowserWindow({
    width: BANNER_W,
    height: BANNER_H,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    hasShadow: false,
    parent: mainWindow || undefined,
    webPreferences: {
      preload: path.join(__dirname, 'banner-preload.cjs'),
      contextIsolation: true,
      sandbox: false,
      nodeIntegration: false,
    },
  });

  bannerWin.loadFile(path.join(__dirname, 'banner.html'));
  bannerWin.webContents.on('did-finish-load', () => {
    sendBannerState();
    positionBanner();
    bannerWin.showInactive();
  });
  bannerWin.on('closed', () => { bannerWin = null; });
  log('баннер обновления: ' + updateFlow.phase + ' ' + (updateFlow.version || ''));
}

function hideUpdateBanner() {
  if (bannerWin && !bannerWin.isDestroyed()) bannerWin.close();
}

/**
 * Одна проверка обновлений с ожиданием результата.
 *
 * Слушатели снимаются после завершения, чтобы повторные проверки не
 * накапливали обработчики и не получали ответ от старой проверки.
 *
 * @returns {Promise<object|null>} объект обновления или null, если его нет
 */
function checkUpdateOnce(instance, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('сервер обновлений не ответил'));
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timer);
      instance.removeListener('update-available', onAvailable);
      instance.removeListener('update-not-available', onNone);
      instance.removeListener('error', onError);
    };

    const onAvailable = (value) => { cleanup(); resolve(value); };
    const onNone = () => { cleanup(); resolve(null); };
    const onError = (error) => { cleanup(); reject(error); };

    instance.once('update-available', onAvailable);
    instance.once('update-not-available', onNone);
    instance.once('error', onError);

    Promise.resolve(instance.checkForUpdates()).catch((error) => {
      cleanup();
      reject(error);
    });
  });
}

/** Скачиваем обновление через electron-updater; если нельзя — открываем страницу релиза. */
async function startDownload() {
  const instance = getUpdater();
  if (!instance || !IS_PACKAGED) {
    if (updateFlow.url) shell.openExternal(updateFlow.url);
    hideUpdateBanner();
    return;
  }

  updateFlow.phase = 'downloading';
  updateFlow.percent = 0;
  updateFlow.error = null;
  // плашка живёт отдельным окном; если главное окно не на экране — просто
  // скачиваем в фоне и покажем плашку, когда окно вернётся
  showUpdateBanner();

  try {
    // Проверка обновлений могла уже пройти раньше — electron-updater держит
    // старый updateInfo и отвечает «Please check update first». Сбрасываем
    // кэш, иначе повторная проверка не находит обновление.
    try {
      instance.updateInfo = null;
      instance.updateInfoAndProvider = null;
    } catch { /* поле может быть недоступно */ }

    const info = await checkUpdateOnce(instance, 30000);

    if (!info) throw new Error('установлена последняя версия');
    log('обновление: начинаем скачивание ' + (info.version || ''));
    await instance.downloadUpdate();
    log('обновление: скачивание запущено');
  } catch (err) {
    log('скачивание обновления не удалось: ' + ((err && err.message) || err));
    updateFlow.phase = 'error';
    updateFlow.error = (err && err.message) || 'не удалось скачать обновление';
    showUpdateBanner();
  }
}

/**
 * Установщик обновления нужно запустить САМОСТОЯТЕЛЬНО, а не через
 * quitAndInstall.
 *
 * Причина: quitAndInstall стартует установщик и тут же завершает приложение.
 * Процессы Electron (окно, рендерер, GPU) ещё несколько секунд держат
 * labsoul.exe — и NSIS показывает «Не удалось закрыть labsoul».
 *
 * Здесь: находим скачанный установщик в кеше обновлений и запускаем его
 * detached-процессом, а приложение закрываем уже после.
 */
function launchDownloadedInstaller() {
  const candidates = [
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'labsoul-desktop-updater', 'pending'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'labsoul-desktop-updater'),
  ].filter(Boolean);

  for (const dir of candidates) {
    try {
      if (!fs.existsSync(dir)) continue;
      const files = fs.readdirSync(dir).filter((name) => /setup\.exe$/i.test(name));
      if (!files.length) continue;
      // берём самый свежий файл
      const full = files
        .map((name) => path.join(dir, name))
        .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];

      log('запуск установщика напрямую: ' + full);
      const child = spawn(full, ['--updated', '/S', '--force-run'], {
        detached: true,
        stdio: 'ignore',
        windowsHide: false,
      });
      child.unref();
      return true;
    } catch (err) {
      log('не удалось запустить установщик: ' + ((err && err.message) || err));
    }
  }
  return false;
}

/** Перезапуск с установкой скачанного обновления. */
async function restartToInstall() {
  const instance = getUpdater();
  if (instance && updateFlow.phase === 'ready') {
    try {
      quitting = true;
      // гасим сервер, чтобы он не держал файлы
      stopServer();

      // Дожидаемся полного освобождения labsoul.exe. Сам Electron отпускает
      // его только при выходе, поэтому ждём ограниченно и не блокируемся.
      await releaseFilesForInstaller(3000);

      // Запускаем установщик отдельным процессом: он не зависит от нашего
      // завершения и не попадёт под закрытие.
      if (launchDownloadedInstaller()) {
        log('установщик запущен, закрываем приложение');
        // даём установщику время перехватить файлы
        await new Promise((resolve) => setTimeout(resolve, 1200));
        app.exit(0);
        return;
      }

      log('установщик не найден — пробуем штатный путь');
      instance.quitAndInstall(true, true);
      return;
    } catch (err) {
      log('тихая установка не удалась: ' + ((err && err.message) || err));
      try {
        instance.quitAndInstall(false, true);
        return;
      } catch (fallbackError) {
        log('quitAndInstall не сработал: ' + ((fallbackError && fallbackError.message) || fallbackError));
      }
    }
  }
  if (updateFlow.url) shell.openExternal(updateFlow.url);
  hideUpdateBanner();
}

ipcMain.on('banner:action', (_event, action) => {
  if (action === 'download') { startDownload(); return; }
  if (action === 'restart') { restartToInstall(); return; }
  if (action === 'later') {
    writeAppSettings({ dismissedUpdate: updateFlow.version || '' });
    hideUpdateBanner();
    return;
  }
  if (action === 'hide') hideUpdateBanner();
});

/** Спрашиваем локальный сервер (он кэширует ответ GitHub на час). */
async function checkUpdates({ manual = false } = {}) {
  try {
    // по кнопке обходим кэш сервера: иначе отдаётся ответ часовой давности
    const suffix = manual ? '?force=1' : '';
    const res = await fetch('http://127.0.0.1:' + currentPort + '/api/update' + suffix, {
      signal: AbortSignal.timeout(15000),
    });
    const data = await res.json();
    log('обновления: текущая ' + data.current + ', доступна ' + (data.latest ? data.latest.version : 'нет'));

    if (!data.updateAvailable || !data.latest) {
      if (manual) {
        dialog.showMessageBox({
          type: 'info',
          title: 'Обновления',
          message: 'У вас последняя версия' + (data.current ? ' (' + data.current + ')' : ''),
        });
      }
      hideUpdateBanner();
      return;
    }

    updateFlow.phase = 'available';
    updateFlow.version = data.latest.version;
    updateFlow.url = data.latest.url;
    updateFlow.percent = 0;
    updateFlow.error = null;

    const dismissed = readAppSettings().dismissedUpdate;
    if (!manual && dismissed === data.latest.version) return;

    showUpdateBanner();
  } catch (err) {
    log('проверка обновлений не удалась: ' + ((err && err.message) || err));
    if (manual) dialog.showErrorBox('Не удалось проверить обновления', (err && err.message) || String(err));
  }
}

/* -------------------------------- трей ----------------------------------- */

function createTray() {
  if (!fs.existsSync(APP_ICON)) return;
  tray = new Tray(APP_ICON);
  tray.setToolTip('labsoul');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Показать / скрыть', click: toggleWindow },
      {
        label: 'Перезагрузить интерфейс',
        click: () => mainWindow && mainWindow.reload(),
      },
      {
        label: 'Открыть папку данных',
        click: () => shell.openPath(DATA_DIR),
      },
      { type: 'separator' },
      {
        label: 'Выход',
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ]),
  );
  tray.on('click', toggleWindow);
}

/* -------------------------------- меню ----------------------------------- */

function buildMenu() {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: 'labsoul',
        submenu: [
          {
            label: 'Войти в Яндекс.Музыку…',
            click: () => signInYandex(),
          },
          { type: 'separator' },
          {
            label: 'Проверить обновления…',
            click: () => checkUpdates({ manual: true }),
          },
          {
            label: 'Открыть папку данных',
            click: () => shell.openPath(DATA_DIR),
          },
          {
            label: 'Диагностика (консоль сервера)',
            click: () => shell.openPath(path.join(app.getPath('userData'), 'logs')),
          },
          { type: 'separator' },
          {
            label: 'Выход',
            click: () => {
              quitting = true;
              app.quit();
            },
          },
        ],
      },
      {
        label: 'Вид',
        submenu: [
          { role: 'reload', label: 'Перезагрузить' },
          { role: 'toggleDevTools', label: 'Инструменты разработчика' },
          { type: 'separator' },
          { role: 'zoomIn' },
          { role: 'zoomOut' },
          { role: 'resetZoom' },
          { role: 'togglefullscreen' },
        ],
      },
    ]),
  );
}

/* ------------------------------ жизненный цикл --------------------------- */

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.setName('labsoul');
  app.setAppUserModelId('ru.labsoul.player');
  // интерфейсу нужен звук без клика (волна запускается сама)
  app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    log(`старт приложения, packaged=${IS_PACKAGED}`);
    currentPort = await findFreePort(5270);
    startServer(currentPort);

    let healthy = await waitForHealth(currentPort);

    // Сервер мог не успеть подняться с первого раза (медленный диск, антивирус,
    // первый запуск после обновления). Даём вторую попытку на свободном порту,
    // прежде чем показывать ошибку.
    if (!healthy) {
      log('health не ответил с первой попытки — пробуем ещё раз');
      stopServer();
      currentPort = await findFreePort(5270);
      startServer(currentPort);
      healthy = await waitForHealth(currentPort);
    }

    log(`health: ${healthy ? 'ok' : 'не ответил'}`);
    if (!healthy) {
      dialog.showErrorBox(
        'Не удалось запустить labsoul',
        `Локальный сервер не ответил на порту ${currentPort} после двух попыток.\n\nЛог: ${logPath()}`,
      );
      app.quit();
      return;
    }

    createWindow(currentPort);
    buildMenu();
    createTray();
    setupUpdater();

    // проверка обновлений: не сразу, чтобы не мешать старту
    setTimeout(() => checkUpdates(), 4000);

    // проверка внешнего вида уведомления без реального релиза: labsoul.exe --fake-update
    if (process.argv.includes('--fake-update')) {
      setTimeout(() => {
        updateFlow.phase = 'available';
        updateFlow.version = '9.9.9';
        updateFlow.url = 'https://github.com/avaneqqqqqq/Labsoul.Player/releases';
        showUpdateBanner();
      }, 2500);
    }

    // медиа-клавиши клавиатуры
    const send = (action) => mainWindow && mainWindow.webContents.send('media-key', action);
    for (const [key, action] of [
      ['MediaPlayPause', 'play-pause'],
      ['MediaNextTrack', 'next'],
      ['MediaPreviousTrack', 'prev'],
    ]) {
      try {
        globalShortcut.register(key, () => send(action));
      } catch { /* клавиша занята другой программой */ }
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow(currentPort);
    });
  });

  app.on('before-quit', () => {
    quitting = true;
    globalShortcut.unregisterAll();
    stopServer();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
