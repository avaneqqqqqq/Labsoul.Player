'use strict';

/**
 * Мост между оболочкой и интерфейсом: медиа-клавиши, вход в Яндекс и сведения
 * о платформе. Специально минимальный — страница остаётся обычным вебом,
 * а в браузере (без Electron) эти методы просто отсутствуют.
 */

const { contextBridge, ipcRenderer, webUtils } = require('electron');

function subscribe(channel, callback) {
  if (typeof callback !== 'function') return () => {};
  const handler = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld('playerDesktop', {
  isDesktop: true,
  platform: process.platform,

  /** Войти в Яндекс.Музыку: открывает окно OAuth и сохраняет токен на сервере. */
  signInYandex() {
    return ipcRenderer.invoke('auth:yandex');
  },

  /**
   * Путь файла, перетащенного в окно. В Electron 32 свойство File.path убрано,
   * поэтому путь берём через webUtils (документированный способ).
   */
  getPathForFile(file) {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return null;
    }
  },

  /** Диалог выбора файлов/папок для своей музыки: возвращает {ok, added, skipped}. */
  pickMusic() {
    return ipcRenderer.invoke('local:pick');
  },

  /** Подписка на события авторизации: callback({source}). */
  onAuthChanged(callback) {
    return subscribe('auth:changed', callback);
  },

  /** Медиа-клавиши клавиатуры: callback('play-pause' | 'next' | 'prev'). */
  onMediaKey(callback) {
    return subscribe('media-key', callback);
  },
});
