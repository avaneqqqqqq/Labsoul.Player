/* =========================================================================
   labsoul вЂ” С‚РѕС‡РєР° РІС…РѕРґР°: С‚РµРјР°, РјР°СЂС€СЂСѓС‚С‹, Р¶РёР·РЅРµРЅРЅС‹Р№ С†РёРєР» СЌРєСЂР°РЅРѕРІ.
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
import { applyTheme, setNowPlaying, restoreFromServer as restoreTheme } from './theme.js';
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

// СЃС‡С‘С‚С‡РёРє РїР°РґРµРЅРёР№ СЌРєСЂР°РЅР°: РїРѕСЃР»Рµ РѕС€РёР±РєРё РґР°С‘Рј РІРµСЂРЅСѓС‚СЊСЃСЏ РЅР° В«Р’РѕР»РЅСѓВ», РЅРµ РїРµСЂРµР·Р°РіСЂСѓР¶Р°СЏ РІСЃС‘
let screenErrorCount = 0;

function paintCrash(container, error) {
  container.innerHTML = `<div class="empty" style="margin-top:40px">
    <svg viewBox="0 0 24 24" aria-hidden="true"><use href="#i-alert"></use></svg>
    <b>Р­РєСЂР°РЅ РЅРµ Р·Р°РіСЂСѓР·РёР»СЃСЏ</b>
    <span>${String(error?.message || error || 'РќРµРёР·РІРµСЃС‚РЅР°СЏ РѕС€РёР±РєР°')}</span>
    <div class="empty__actions">
      <button class="btn btn--accent btn--sm" type="button" onclick="location.reload()">РћР±РЅРѕРІРёС‚СЊ СЃС‚СЂР°РЅРёС†Сѓ</button>
      <button class="btn btn--ghost btn--sm" type="button" onclick="location.hash='#wave';location.reload()">Р’РµСЂРЅСѓС‚СЊСЃСЏ РЅР° В«Р’РѕР»РЅСѓВ»</button>
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
    console.error('[labsoul] РЅРµ СѓРґР°Р»РѕСЃСЊ РѕС‚СЂРёСЃРѕРІР°С‚СЊ СЌРєСЂР°РЅ', err);
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
    // РџРµСЂРІС‹Р№ СЂРµРЅРґРµСЂ СЃР»СѓС‡РёР»СЃСЏ, РїРѕРєР° СЂРµР¶РёРј Р±С‹Р» В«РЅРµРёР·РІРµСЃС‚РµРЅВ» (РґРµРјРѕ-РІРёРґ): РїРµСЂРµСЂРёСЃРѕРІС‹РІР°РµРј
    // СЌРєСЂР°РЅ СѓР¶Рµ РЅР° Р¶РёРІС‹С… РґР°РЅРЅС‹С…, РёРЅР°С‡Рµ РїРѕРґРїРёСЃРё Рё РїРѕРґСЃРєР°Р·РєРё РѕСЃС‚Р°СЋС‚СЃСЏ РґРµРјРѕРЅСЃС‚СЂР°С†РёРѕРЅРЅС‹РјРё.
    renderRoute();
    return;
  }
  // РЎРµСЂРІРµСЂР° РЅРµС‚ вЂ” РїРµСЂРµСЂРёСЃРѕРІС‹РІР°РµРј СЌРєСЂР°РЅ, С‡С‚РѕР±С‹ РґР°РЅРЅС‹Рµ РїСЂРёС€Р»Рё РёР· js/demo.js,
  // Р° РЅРµ РёР· РЅРµСѓРґР°С‡РЅРѕРіРѕ РїРµСЂРІРѕРіРѕ Р·Р°РїСЂРѕСЃР°.
  renderRoute();
}

function boot() {
  applyTheme();

  // РћС„РѕСЂРјР»РµРЅРёРµ РјРѕРіР»Рѕ РїРѕС‚РµСЂСЏС‚СЊСЃСЏ РїСЂРё РѕР±РЅРѕРІР»РµРЅРёРё (localStorage Р¶РёРІС‘С‚ РІ РїСЂРѕС„РёР»Рµ
  // Chromium). Р•СЃР»Рё Р»РѕРєР°Р»СЊРЅРѕР№ РєРѕРїРёРё РЅРµС‚ вЂ” Р·Р°Р±РёСЂР°РµРј СЃРѕС…СЂР°РЅС‘РЅРЅСѓСЋ РЅР° СЃРµСЂРІРµСЂРµ.
  restoreTheme().then((restored) => {
    if (restored) {
      setNowPlaying(player.getState().current);
    }
  });

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
