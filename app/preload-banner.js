'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bannerAPI', {
  action: (name) => ipcRenderer.send('banner:action', name),
  onState: (cb) => ipcRenderer.on('banner:state', (_event, state) => cb(state)),
});
