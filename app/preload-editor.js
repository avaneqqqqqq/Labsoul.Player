'use strict';

/**
 * Мост между окном оформления (наш прототип) и основным приложением.
 * Прототип сохраняет тему в localStorage — здесь её читаем и отдаём в main.
 * Никакой логики темы тут нет: только транспорт.
 */

const { ipcRenderer } = require('electron');

let lastSent = '';

function readTheme() {
  try {
    const raw = window.localStorage.getItem('ym-theme');
    if (!raw || raw === lastSent) return;
    const parsed = JSON.parse(raw);
    lastSent = raw;
    ipcRenderer.send('theme:update', parsed);
  } catch {
    /* мусор в localStorage — игнорируем, тема остаётся прежней */
  }
}

window.addEventListener('DOMContentLoaded', () => {
  // первый прогон после загрузки прототипа: там уже лежит тема
  setTimeout(readTheme, 400);
  setInterval(readTheme, 350);
});

window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') ipcRenderer.send('theme:close');
});

// страницу можно переключить из главного меню (Оформление / Эквалайзер)
ipcRenderer.on('editor:page', (_event, page) => {
  if (page === 'eq' || page === 'theme') {
    const url = new URL(window.location.href);
    url.searchParams.set('page', page);
    window.location.replace(url.toString());
  }
});

// отчёт о применении блоков — пригодится для отладки калибровки
ipcRenderer.on('blocks:report', (_event, report) => {
  window.__ymBlocksReport = report;
  console.info('[blocks]', report);
});
