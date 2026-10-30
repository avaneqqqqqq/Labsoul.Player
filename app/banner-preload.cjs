'use strict';

/**
 * Мост для окна-уведомления об обновлении: только два действия и приём
 * состояния. Ничего лишнего в страницу не отдаём.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('labsoulBanner', {
  onState(callback) {
    if (typeof callback !== 'function') return;
    ipcRenderer.on('banner:state', (_event, state) => callback(state));
  },
  action(name) {
    if (typeof name === 'string') ipcRenderer.send('banner:action', name);
  },
});
