/**
 * Мини-плеер поверх всех окон (идея из Liner).
 *
 * Это отдельное лёгкое окно со своей страницей: раньше сюда грузилась вся
 * страница приложения — отсюда огромный размер и лишние элементы.
 *
 * Окно без рамки, всегда сверху, не забирает фокус у игр и видео,
 * перетаскивается за любую точку.
 */

const path = require('node:path');
const { BrowserWindow, ipcMain } = require('electron');

const SIZE = { width: 330, height: 74 };

let overlay = null;
/** Окно приложения, которому пересылаем команды из мини-плеера. */
let mainWindowRef = null;
let actionsBound = false;

/** Подключить главное окно — команды мини-плеера идут в него. */
function attachMain(win) {
  mainWindowRef = win;
}

/**
 * Создать окно мини-плеера.
 * @param {{html: string}} opts — путь к странице мини-плеера
 */
function create({ html }) {
  if (overlay && !overlay.isDestroyed()) {
    overlay.showInactive();
    return overlay;
  }

  overlay = new BrowserWindow({
    ...SIZE,
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    // не отбираем фокус у активного приложения
    focusable: false,
    hasShadow: false,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'miniplayer-preload.cjs'),
    },
  });

  try {
    overlay.setAlwaysOnTop(true, 'screen-saver');
    overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  } catch { /* ignore */ }

  overlay.loadFile(html);
  overlay.once('ready-to-show', () => {
    if (overlay && !overlay.isDestroyed()) overlay.showInactive();
  });

  overlay.on('closed', () => {
    overlay = null;
  });

  return overlay;
}

/** Показать/скрыть мини-плеер. */
function toggle(opts) {
  if (overlay && !overlay.isDestroyed()) {
    if (overlay.isVisible()) {
      overlay.hide();
      return false;
    }
    overlay.showInactive();
    return true;
  }
  create(opts);
  return true;
}

function close() {
  if (overlay && !overlay.isDestroyed()) overlay.close();
  overlay = null;
}

/** Последнее отправленное состояние — чтобы отдать его новому окну. */
let lastState = null;

/** Отправить состояние трека в мини-плеер. */
function send(state) {
  lastState = state;
  if (!overlay || overlay.isDestroyed()) return false;
  try {
    overlay.webContents.send('mini:state', state);
    return true;
  } catch {
    return false;
  }
}

/** Текущее состояние (для запроса из окна при загрузке). */
function getState() {
  return lastState;
}

function isOpen() {
  return Boolean(overlay && !overlay.isDestroyed() && overlay.isVisible());
}

/**
 * Команды из мини-плеера (плей/пауза, следующий, предыдущий).
 * Обработчик регистрируется один раз.
 */
function handleActions() {
  if (actionsBound) return;
  actionsBound = true;
  ipcMain.on('mini:action', (_event, action) => {
    if (action === 'close') { close(); return; }
    // остальные команды пересылаем в главное окно — там живёт плеер
    if (mainWindowRef && !mainWindowRef.isDestroyed()) {
      mainWindowRef.webContents.send('mini:command', action);
    }
  });

  // мини-плеер просит состояние сразу после открытия
  ipcMain.on('mini:request-state', () => {
    if (lastState && overlay && !overlay.isDestroyed()) {
      send(lastState);
    } else if (mainWindowRef && !mainWindowRef.isDestroyed()) {
      // состояние ещё не приходило — просим приложение прислать свежее
      mainWindowRef.webContents.send('mini:command', 'refresh');
    }
  });
}

module.exports = { create, toggle, close, send, getState, isOpen, attachMain, handleActions };
