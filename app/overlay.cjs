/**
 * Оверлей-плеер: маленькое окно поверх всех приложений (идея из Liner).
 *
 * Показывает, что играет, и даёт управление без переключения в labsoul —
 * удобно, когда работаешь в другом окне на весь экран.
 *
 * Окно без рамки, всегда сверху, не перехватывает фокус у игр и видео
 * (focusable), закрывается кнопкой и горячей клавишей.
 */

const path = require('node:path');
const { BrowserWindow } = require('electron');

const SIZE = { width: 340, height: 88 };

let overlay = null;
let overlayEnabled = false;

/**
 * Создать оверлей. Возвращает окно или null, если уже есть.
 * @param {object} opts
 * @param {string} opts.html — страница оверлея
 * @param {number} opts.port — порт локального сервера
 */
function create({ html, port }) {
  if (overlay && !overlay.isDestroyed()) {
    overlay.show();
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
    // не забираем фокус у активного приложения
    focusable: false,
    hasShadow: false,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // поверх полноэкранных окон, включая игры
  try {
    overlay.setAlwaysOnTop(true, 'screen-saver');
    overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  } catch { /* ignore */ }

  overlay.loadURL(`${html}${html.includes('?') ? '&' : '?'}overlay=1&port=${port}`);
  overlay.once('ready-to-show', () => {
    if (overlay && !overlay.isDestroyed()) overlay.showInactive();
  });

  overlay.on('closed', () => {
    overlay = null;
  });

  return overlay;
}

/** Показать/скрыть оверлей. */
function toggle(opts) {
  if (overlay && !overlay.isDestroyed()) {
    if (overlay.isVisible()) overlay.hide();
    else overlay.showInactive();
    return Boolean(overlay.isVisible());
  }
  create(opts);
  return true;
}

/** Закрыть оверлей. */
function close() {
  if (overlay && !overlay.isDestroyed()) overlay.close();
  overlay = null;
  overlayEnabled = false;
}

/** Отправить данные о треке в оверлей. */
function send(state) {
  if (!overlay || overlay.isDestroyed()) return;
  try {
    overlay.webContents.send('overlay:state', state);
  } catch { /* ignore */ }
}

function isOpen() {
  return Boolean(overlay && !overlay.isDestroyed() && overlay.isVisible());
}

module.exports = { create, toggle, close, send, isOpen, overlayEnabled };
