/* =========================================================================
   labsoul — точка входа: тема, маршруты, жизненный цикл экранов.
   ========================================================================= */

import { isOnline, ping } from './api.js';
import { player } from './audio.js';
import designScreen from './screens/design.js';
import libraryScreen from './screens/library.js';
import searchScreen from './screens/search.js';
import sourcesScreen from './screens/sources.js';
import waveScreen from './screens/wave.js';
import {
  app,
  initStore,
  loadHistory,
  loadSettings,
  ROUTES,
  refreshStatus,
  runSearch,
  setRoute,
  subscribe as storeSubscribe,
} from './store.js';
import { applyTheme, setNowPlaying } from './theme.js';
import { initShell } from './ui.js';

const SCREENS = {
  wave: waveScreen,
  search: searchScreen,
  library: libraryScreen,
  sources: sourcesScreen,
  design: designScreen,
};

let activeScreen = null;
let rendering = false;

function routeFromHash() {
  const raw = String(location.hash || '').replace(/^#\/?/, '').split('?')[0];
  return ROUTES.includes(raw) ? raw : 'wave';
}

function paintCrash(container, error) {
  container.innerHTML = `<div class="empty" style="margin-top:40px">
    <svg viewBox="0 0 24 24" aria-hidden="true"><use href="#i-alert"></use></svg>
    <b>Экран не загрузился</b>
    <span>${String(error?.message || error || 'Неизвестная ошибка')}</span>
    <div class="empty__actions">
      <button class="btn btn--accent btn--sm" type="button" onclick="location.reload()">Обновить страницу</button>
    </div>
  </div>`;
}

function renderRoute() {
  if (rendering) return;
  rendering = true;
  const route = routeFromHash();
  const content = document.getElementById('content');
  if (!content) { rendering = false; return; }
  const screen = SCREENS[route] || SCREENS.wave;

  try {
    if (activeScreen?.destroy) activeScreen.destroy();
    content.replaceChildren();
    const wrapper = document.createElement('div');
    wrapper.className = 'page-anim';
    wrapper.id = `screen-${screen.id}`;
    content.appendChild(wrapper);
    screen.render(wrapper);
    screen.mount(wrapper);
    activeScreen = screen;
    setRoute(route);
    content.scrollTop = 0;
  } catch (err) {
    console.error('[labsoul] не удалось отрисовать экран', err);
    paintCrash(content, err);
    setRoute(route);
  } finally {
    rendering = false;
  }
}

function onHashChange() {
  renderRoute();
}

async function detectServer() {
  const online = await ping(1800);
  if (online) {
    await refreshStatus();
    if (app.route === 'library') loadHistory();
    if (app.route === 'search' && app.search.query.trim()) runSearch(app.search.query);
    if (app.route === 'sources') loadSettings();
    // Первый рендер случился, пока режим был «неизвестен» (демо-вид): перерисовываем
    // экран уже на живых данных, иначе подписи и подсказки остаются демонстрационными.
    renderRoute();
    return;
  }
  // Сервера нет — перерисовываем экран, чтобы данные пришли из js/demo.js,
  // а не из неудачного первого запроса.
  renderRoute();
}

function boot() {
  applyTheme();
  initStore();
  initShell();
  setNowPlaying(player.getState().current);

  if (!location.hash) {
    history.replaceState(null, '', '#wave');
  }

  renderRoute();
  window.addEventListener('hashchange', onHashChange);

  player.subscribe((snap, event) => {
    if (event === 'track' || event === 'init') {
      setNowPlaying(snap.current);
    }
  });

  storeSubscribe((_state, event) => {
    if (event === 'net' && isOnline()) {
      refreshStatus();
      if (app.route === 'library') loadHistory();
      if (app.route === 'search' && app.search.query.trim()) runSearch(app.search.query);
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && !isOnline()) {
      ping(1500);
    }
  });

  detectServer();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}
