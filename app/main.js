'use strict';

const { app, BrowserWindow, Menu, ipcMain, shell, session, dialog } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('node:path');
const fs = require('node:fs');
const { buildThemeCss, buildBlocksScript } = require('./theme');

const MUSIC_URL = 'https://music.yandex.ru/';
const PROJECT_ROOT = path.join(__dirname, '..');

// в упакованном приложении редактор лежит в resources/editor, в разработке — рядом
const EDITOR_ROOT = app.isPackaged
  ? path.join(process.resourcesPath, 'editor')
  : path.join(PROJECT_ROOT, 'yandex-music-redesign');
const EDITOR_HTML = path.join(EDITOR_ROOT, 'index.html');
const BLOCKS_FILE = path.join(__dirname, 'blocks.json');
const PATCHES_FILE = path.join(__dirname, 'patches.css');
const APP_ICON = path.join(__dirname, 'build', 'icon.png');

let musicWin = null;
let editorWin = null;
let themeCssKey = null;
let lastBlocksReport = null;

/* ---------------- хранилище ---------------- */

const themePath = () => path.join(app.getPath('userData'), 'theme.json');

function loadTheme() {
  try {
    return JSON.parse(fs.readFileSync(themePath(), 'utf8'));
  } catch {
    return null;
  }
}

function saveTheme(theme) {
  try {
    fs.mkdirSync(path.dirname(themePath()), { recursive: true });
    fs.writeFileSync(themePath(), JSON.stringify(theme, null, 2), 'utf8');
  } catch (err) {
    console.warn('[theme] не удалось сохранить:', err.message);
  }
}

function loadJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

let currentTheme = null;

/* ---------------- основное окно с музыкой ---------------- */

function createMusicWindow() {
  musicWin = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 980,
    minHeight: 620,
    backgroundColor: '#0a0a0c',
    title: 'Temnikovo Dans',
    icon: APP_ICON,
    autoHideMenuBar: true,
    webPreferences: {
      partition: 'persist:ym-main', // отдельная сессия: куки не смешиваются с системным браузером
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });

  musicWin.loadURL(MUSIC_URL);

  // ссылки наружу — в системный браузер, а не в приложение
  musicWin.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  musicWin.webContents.on('did-finish-load', () => applyAll());
  musicWin.webContents.on('did-navigate-in-page', () => applyAll());

  musicWin.on('closed', () => { musicWin = null; });
}

/* ---------------- применение темы ---------------- */

async function applyAll() {
  if (!musicWin || musicWin.isDestroyed()) return;
  const wc = musicWin.webContents;

  if (themeCssKey) {
    try { await wc.removeInsertedCSS(themeCssKey); } catch { /* уже снят */ }
    themeCssKey = null;
  }

  const css = buildThemeCss(currentTheme);
  const patches = safeRead(PATCHES_FILE);
  if (css || patches) {
    try {
      themeCssKey = await wc.insertCSS((css + '\n' + patches).trim(), { cssOrigin: 'user' });
    } catch (err) {
      console.warn('[theme] insertCSS:', err.message);
    }
  }

  // блоки: применяем только если якоря найдены (safe mode)
  const blocks = loadJson(BLOCKS_FILE, {});
  try {
    const report = await wc.executeJavaScript(buildBlocksScript(blocks), true);
    lastBlocksReport = report;
    if (report && (report.missing.length || report.errors.length)) {
      console.info('[blocks] не применены:', report.missing, report.errors);
    }
  } catch (err) {
    console.warn('[blocks]', err.message);
  }

  if (editorWin && !editorWin.isDestroyed()) {
    editorWin.webContents.send('blocks:report', lastBlocksReport);
  }
}

function safeRead(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return ''; }
}

/* ---------------- окно оформления ---------------- */

function openEditor(page = 'theme') {
  if (editorWin && !editorWin.isDestroyed()) {
    editorWin.webContents.send('editor:page', page);
    editorWin.focus();
    return;
  }

  editorWin = new BrowserWindow({
    width: 1180,
    height: 900,
    minWidth: 820,
    minHeight: 560,
    title: 'Оформление — Temnikovo Dans',
    backgroundColor: '#0a0a0c',
    icon: APP_ICON,
    autoHideMenuBar: true,
    parent: musicWin || undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload-editor.js'),
      contextIsolation: true,
      sandbox: false,
      nodeIntegration: false,
    },
  });

  editorWin.loadFile(EDITOR_HTML, { query: { page, embed: '1' } });
  editorWin.on('closed', () => { editorWin = null; });
}

ipcMain.on('theme:update', (_event, theme) => {
  if (!theme || typeof theme !== 'object') return;
  currentTheme = theme;
  saveTheme(theme);
  applyAll();
});

ipcMain.on('theme:close', () => {
  if (editorWin && !editorWin.isDestroyed()) editorWin.close();
});

ipcMain.handle('theme:get', () => currentTheme);

/* ---------------- автообновление ---------------- */

const UPDATE_JSON = path.join(__dirname, 'update.json');
let updaterReady = false;

function configureUpdater() {
  if (!app.isPackaged) {
    console.info('[update] режим разработки — автообновление выключено');
    return false;
  }

  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(UPDATE_JSON, 'utf8')); } catch { /* нет файла — пробуем встроенный конфиг */ }

  if (cfg.url) {
    // свой фид (generic): любая HTTPS-папка с latest.yml
    autoUpdater.setFeedURL({ provider: 'generic', url: cfg.url.endsWith('/') ? cfg.url : cfg.url + '/' });
    console.info('[update] фид:', cfg.url);
  } else if (fs.existsSync(path.join(process.resourcesPath, 'app-update.yml'))) {
    // конфиг из сборки: GitHub Releases или провайдер из build.publish
    const yml = fs.readFileSync(path.join(process.resourcesPath, 'app-update.yml'), 'utf8');
    if (yml.includes('YOUR_GITHUB_USER')) {
      console.info('[update] в сборке заглушка owner/repo — автообновление выключено. Релиз собирай через GitHub Actions.');
      return false;
    }
    console.info('[update] использую app-update.yml из сборки');
  } else {
    console.info('[update] не задан ни url в update.json, ни app-update.yml — автообновление выключено');
    return false;
  }

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowPrerelease = false;

  autoUpdater.on('checking-for-update', () => console.info('[update] проверяю…'));
  autoUpdater.on('update-available', (info) => console.info('[update] новая версия:', info.version));
  autoUpdater.on('update-not-available', (info) => console.info('[update] актуально:', info.version));
  autoUpdater.on('download-progress', (p) => console.info(`[update] ${p.percent.toFixed(0)}%`));
  autoUpdater.on('error', (err) => console.warn('[update] ошибка:', err.message));

  autoUpdater.on('update-downloaded', async (info) => {
    const { response } = await dialog.showMessageBox({
      type: 'info',
      buttons: ['Перезапустить', 'Позже'],
      defaultId: 0,
      cancelId: 1,
      title: 'Обновление готово',
      message: `Temnikovo Dans ${info.version} скачан`,
      detail: 'Перезапустить приложение сейчас, чтобы применить обновление?',
    });
    if (response === 0) autoUpdater.quitAndInstall();
  });

  updaterReady = true;
  return true;
}

async function checkUpdates(manual = false) {
  if (!updaterReady) {
    if (manual) {
      dialog.showMessageBox({
        type: 'info',
        title: 'Обновления',
        message: 'Автообновление не настроено',
        detail: 'Укажи адрес раздачи в файле update.json рядом с приложением (resources/app/update.json).',
      });
    }
    return;
  }
  try {
    await autoUpdater.checkForUpdates();
  } catch (err) {
    if (manual) dialog.showErrorBox('Не удалось проверить обновления', err.message);
  }
}

/* ---------------- меню ---------------- */

function buildMenu() {
  const template = [
    {
      label: 'Приложение',
      submenu: [
        { label: 'Оформление', accelerator: 'CmdOrCtrl+E', click: () => openEditor('theme') },
        { label: 'Эквалайзер', accelerator: 'CmdOrCtrl+Shift+E', click: () => openEditor('eq') },
        { type: 'separator' },
        { label: 'Проверить обновления…', click: () => checkUpdates(true) },
        { label: 'Сбросить тему', click: resetTheme },
        { type: 'separator' },
        { role: 'quit', label: 'Выход' },
      ],
    },
    {
      label: 'Вид',
      submenu: [
        { role: 'reload', label: 'Перезагрузить' },
        { role: 'toggleDevTools', label: 'Инструменты разработчика' },
        { type: 'separator' },
        { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'resetZoom' },
        { role: 'togglefullscreen' },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function resetTheme() {
  currentTheme = null;
  try { fs.unlinkSync(themePath()); } catch { /* нет файла */ }
  if (musicWin && !musicWin.isDestroyed()) {
    themeCssKey = null;
    musicWin.reload();
  }
}

/* ---------------- старт ---------------- */

app.setName('Temnikovo Dans');
app.setAppUserModelId('ru.temnikovo.dans');

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (musicWin) {
      if (musicWin.isMinimized()) musicWin.restore();
      musicWin.focus();
    }
  });

  app.whenReady().then(() => {
    currentTheme = loadTheme();
    createMusicWindow();
    buildMenu();

    const configured = configureUpdater();
    if (configured) setTimeout(() => checkUpdates(false), 8000);

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createMusicWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
