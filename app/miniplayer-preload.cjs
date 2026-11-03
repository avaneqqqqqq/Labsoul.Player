/**
 * Мост мини-плеера: получает состояние трека и отправляет команды.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktopOverlay', {
  /** Команды управления: prev | next | toggle | close. */
  send(action) {
    ipcRenderer.send('mini:action', action);
  },

  /** Подписка на обновления трека. */
  onState(callback) {
    ipcRenderer.on('mini:state', (_event, state) => callback(state));
  },

  /** Открыть главное окно приложения. */
  openApp() {
    ipcRenderer.send('mini:action', 'open');
  },
});
