const { app, BrowserWindow } = require('electron');

const log = (m) => {
  console.log('[T] ' + m);
  require('node:fs').appendFileSync(require('node:path').join(require('node:os').tmpdir(), 'proto-out.txt'), m + '\n');
};
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const outFile = path.join(os.tmpdir(), 'proto-out.txt');
fs.writeFileSync(outFile, 'start ' + new Date().toISOString() + '\n');

log('electron загружен: ' + (app ? 'да' : 'нет'));

app.whenReady().then(() => {
  log('app ready');
  const win = new BrowserWindow({ width: 1100, height: 760, show: true });
  win.loadURL('https://soundcloud.com/tracks/2424504549');
  log('загружаем SoundCloud');

  win.webContents.on('did-finish-load', () => {
    log('страница загружена');
    setTimeout(() => {
      win.webContents
        .executeJavaScript(
          `(() => {
            const as_ = [...document.querySelectorAll('audio')];
            return JSON.stringify({ title: document.title, n: as_.length, state: as_.map(a => ({p: a.paused, t: a.currentTime, d: a.duration, r: a.readyState})) });
          })()`,
        )
        .then((r) => log('медиа: ' + r))
        .catch((e) => log('ошибка JS: ' + e.message));
    }, 12000);
  });

  win.webContents.on('did-fail-load', (_e, code, desc) => log(`не загрузилось: ${code} ${desc}`));
});

setTimeout(() => {
  log('завершаем');
  app.quit();
}, 45000);
