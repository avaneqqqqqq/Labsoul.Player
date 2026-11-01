const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const OUT = 'C:\\Users\\emosaltlolli\\Documents\\deepseek-harness\\default-workspace\\player\\_proto-out.txt';
const log = (m) => fs.appendFileSync(OUT, m + '\n');

fs.writeFileSync(OUT, 'electron=' + Boolean(app) + '\n');

if (!app) { log('нет electron'); process.exit(1); }

log('до whenReady');
app.whenReady().then(() => {
  log('ready');
  const win = new BrowserWindow({ width: 1100, height: 760, show: false });
  log('окно создано');
  win.loadURL('https://soundcloud.com/tracks/2424504549');

  win.webContents.on('did-finish-load', () => {
    log('страница загружена: ' + win.webContents.getURL().slice(0, 70));
    setTimeout(() => {
      win.webContents
        .executeJavaScript(`(() => {
          const as_ = [...document.querySelectorAll('audio')];
          return JSON.stringify({ title: document.title, n: as_.length, s: as_.map(a => [Math.round(a.currentTime), Math.round(a.duration||0), a.paused, a.readyState]) });
        })()`)
        .then((r) => log('МЕДИА: ' + r))
        .catch((e) => log('JS ошибка: ' + e.message));
    }, 12000);
  });

  win.webContents.on('did-fail-load', (_e, c, d) => log('fail ' + c + ' ' + d));
}).catch((e) => log('whenReady ошибка: ' + e.message));

setTimeout(() => { log('выход'); app.quit(); }, 40000);
