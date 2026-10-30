/* =========================================================================
   labsoul — экран «Библиотека»: история прослушиваний и избранное.
   Всё хранится локально; история приходит с сервера (или из демо-набора).
   ========================================================================= */

import { bindTrackActions } from '../actions.js';
import { player } from '../audio.js';
import {
  emptyState,
  eqBars,
  icon,
  rowHtml,
  skeletonRows,
} from '../components.js';
import {
  app,
  loadHistory,
  subscribe as storeSubscribe,
} from '../store.js';
import { toast } from '../toast.js';
import { dayKey, dayLabel, esc, plural, pluralTracks } from '../utils.js';

const TAB_KEY = 'player-library-tab';
let tab = 'history';
try {
  const saved = sessionStorage.getItem(TAB_KEY);
  if (saved === 'likes' || saved === 'history') tab = saved;
} catch { /* приватный режим */ }

const screen = { root: null, unsubs: [] };

function rememberTab(next) {
  tab = next;
  try { sessionStorage.setItem(TAB_KEY, next); } catch { /* ignore */ }
}

function historyTracks() {
  return app.history.items.map((row) => row.track);
}

function currentList() {
  return tab === 'history' ? historyTracks() : app.likes;
}

function totalListening() {
  const seconds = app.history.items.reduce((sum, row) => sum + (row.playedSeconds || 0), 0);
  if (!seconds) return '0 мин';
  if (seconds < 3600) return `${Math.round(seconds / 60)} мин`;
  const hours = Math.floor(seconds / 3600);
  const mins = Math.round((seconds % 3600) / 60);
  return `${hours} ч ${mins ? `${mins} мин` : ''}`.trim();
}

function summaryHtml() {
  return `<div class="lib-summary">
    <div class="stat">
      <span class="stat__value">${app.history.items.length}</span>
      <span class="stat__label">${plural(app.history.items.length, ['прослушивание', 'прослушивания', 'прослушиваний'])} в истории</span>
    </div>
    <div class="stat">
      <span class="stat__value">${esc(totalListening())}</span>
      <span class="stat__label">время с плеером</span>
    </div>
    <div class="stat stat--accent">
      <span class="stat__value">${app.likes.length}</span>
      <span class="stat__label">${plural(app.likes.length, ['трек', 'трека', 'треков'])} в избранном</span>
    </div>
  </div>`;
}

function toolbarHtml() {
  return `<div class="lib-toolbar">
    <div class="seg" role="tablist" aria-label="Раздел библиотеки">
      <button type="button" role="tab" data-tab="history" class="${tab === 'history' ? 'on' : ''}" aria-selected="${tab === 'history'}">
        История <span class="chip__count">${app.history.items.length}</span>
      </button>
      <button type="button" role="tab" data-tab="likes" class="${tab === 'likes' ? 'on' : ''}" aria-selected="${tab === 'likes'}">
        Избранное <span class="chip__count">${app.likes.length}</span>
      </button>
    </div>
    <div class="lib-toolbar__spacer"></div>
    <button class="btn btn--ghost btn--sm" type="button" data-lib="refresh">${icon('refresh')} Обновить</button>
    <button class="btn btn--ghost btn--sm" type="button" data-lib="queue-all">${icon('plus')} В очередь</button>
  </div>`;
}

function historyBody() {
  if (app.history.loading && !app.history.items.length) {
    return `<div class="section">${skeletonRows(6)}</div>`;
  }
  if (app.history.error) {
    return `<div class="failure">${icon('alert')}
      <div><b>История недоступна.</b> ${esc(app.history.error)}<br>
      <button class="btn btn--ghost btn--sm" type="button" data-lib="refresh" style="margin-top:8px">${icon('refresh')} Повторить</button></div>
    </div>`;
  }
  if (!app.history.items.length) {
    return `<div class="lib-empty">${emptyState({
      iconName: 'library',
      title: 'История пока пуста',
      text: 'Включите Волну или найдите трек — прослушивания появятся здесь автоматически.',
      actions: `<button class="btn btn--accent btn--sm" type="button" data-route="wave">${icon('wave')} Открыть Волну</button>
        <button class="btn btn--ghost btn--sm" type="button" data-route="search">${icon('search')} Найти трек</button>`,
    })}</div>`;
  }

  const likedIds = new Set(app.likes.map((track) => track.id));
  const currentId = player.getState().current?.id;
  const days = new Map();
  for (const row of app.history.items) {
    const key = dayKey(row.at);
    if (!days.has(key)) days.set(key, []);
    days.get(key).push(row);
  }

  let counter = 0;
  const chunks = [];
  for (const rows of days.values()) {
    const label = dayLabel(rows[0].at);
    chunks.push(`<div class="day-head">${esc(label)}<span>${esc(pluralTracks(rows.length))}</span></div>`);
    chunks.push(`<div class="rows">${rows.map((row) => {
      counter += 1;
      return rowHtml(row.track, {
        index: counter,
        current: row.track.id === currentId,
        likedIds,
        mode: 'library',
        historyAt: row.at,
        playedSeconds: row.playedSeconds,
      });
    }).join('')}</div>`);
  }
  return chunks.join('');
}

function likesBody() {
  if (!app.likes.length) {
    return `<div class="lib-empty">${emptyState({
      iconName: 'heart',
      title: 'В избранном пусто',
      text: 'Нажмите сердечко на треке в Волне или поиске — он появится здесь и останется после перезапуска.',
      actions: `<button class="btn btn--accent btn--sm" type="button" data-route="wave">${icon('wave')} Открыть Волну</button>
        <button class="btn btn--ghost btn--sm" type="button" data-route="search">${icon('search')} Найти трек</button>`,
    })}</div>`;
  }
  const likedIds = new Set(app.likes.map((track) => track.id));
  const currentId = player.getState().current?.id;
  return `<div class="rows">${app.likes.map((track, i) => rowHtml(track, {
    index: i + 1,
    current: track.id === currentId,
    likedIds,
    mode: 'likes',
  })).join('')}</div>`;
}

function bodyHtml() {
  const history = historyBody();
  const likes = likesBody();
  return `<div data-tab-body="history"${tab === 'history' ? '' : ' hidden'}>${history}</div>
    <div data-tab-body="likes"${tab === 'likes' ? '' : ' hidden'}>${likes}</div>`;
}

function paint({ bodyOnly = false } = {}) {
  if (!screen.root) return;
  const toolbar = screen.root.querySelector('#lib-toolbar');
  if (toolbar && !bodyOnly) toolbar.innerHTML = toolbarHtml();
  const summary = screen.root.querySelector('#lib-summary');
  if (summary && !bodyOnly) summary.innerHTML = summaryHtml();
  const body = screen.root.querySelector('#lib-body');
  if (body) body.innerHTML = bodyHtml();
}

function syncRows() {
  if (!screen.root) return;
  const currentId = player.getState().current?.id;
  for (const row of screen.root.querySelectorAll('.row[data-row-id]')) {
    const isCurrent = row.dataset.rowId === currentId;
    row.classList.toggle('is-current', isCurrent);
    const num = row.querySelector('.row__num');
    if (!num) continue;
    if (isCurrent) num.innerHTML = eqBars('row-eq');
    else {
      const index = Number(row.dataset.rowIndex) || 0;
      num.textContent = index ? String(index).padStart(2, '0') : '';
    }
  }
}

function playAll({ shuffle = false } = {}) {
  const list = currentList().filter((track) => track.playable);
  if (!list.length) { toast('Пока нечего играть', { type: 'warn' }); return; }
  const ordered = shuffle ? [...list].sort(() => Math.random() - 0.5) : list;
  player.playTracks(ordered, 0);
  toast(shuffle ? 'Перемешано и запущено' : `Играет ${pluralTracks(ordered.length)}`, { icon: 'play' });
}

function queueAll() {
  const list = currentList();
  if (!list.length) { toast('Список пуст', { type: 'warn' }); return; }
  const result = player.enqueue(list);
  toast(result.started ? 'Запущено' : `В очереди: +${result.added}`, { icon: 'queue' });
}

function onClick(event) {
  const tabButton = event.target instanceof Element ? event.target.closest('[data-tab]') : null;
  if (tabButton) {
    rememberTab(tabButton.dataset.tab === 'likes' ? 'likes' : 'history');
    paint();
    return;
  }
  const action = event.target instanceof Element ? event.target.closest('[data-lib]') : null;
  if (!action) return;
  switch (action.dataset.lib) {
    case 'refresh': loadHistory(); toast('История обновляется', { icon: 'refresh' }); break;
    case 'play-all': playAll(); break;
    case 'shuffle-all': playAll({ shuffle: true }); break;
    case 'queue-all': queueAll(); break;
    default: break;
  }
}

export const libraryScreen = {
  id: 'library',
  title: 'Библиотека',

  render(container) {
    container.innerHTML = `
      <div class="page-head">
        <div class="page-head__main">
          <div class="kicker">локальная коллекция</div>
          <h1>Библиотека</h1>
          <p>История прослушиваний и избранное — только на этом компьютере.</p>
        </div>
        <div class="page-head__actions">
          <button class="btn btn--ghost btn--sm" type="button" data-lib="shuffle-all">${icon('shuffle')} Перемешать</button>
          <button class="btn btn--accent btn--sm" type="button" data-lib="play-all">${icon('play')} Слушать всё</button>
        </div>
      </div>
      <div id="lib-summary">${summaryHtml()}</div>
      <div id="lib-toolbar">${toolbarHtml()}</div>
      <div id="lib-body">${bodyHtml()}</div>
      <p class="footnote lib-footnote">История приходит из GET /api/history; избранное хранится в localStorage под ключом player-likes. Никакой синхронизации с чужими аккаунтами нет — labsoul остаётся локальным.</p>
    `;
  },

  mount(container) {
    screen.root = container;
    container.addEventListener('click', onClick);
    const unbindTracks = bindTrackActions(container, {
      getList: () => currentList(),
      feedback: false,
    });

    screen.unsubs.push(unbindTracks);
    screen.unsubs.push(storeSubscribe((_state, event) => {
      if (event === 'history') paint();
      if (event === 'likes') paint();
      if (event === 'net') {
        if (app.history.items.length === 0) loadHistory();
      }
    }));
    screen.unsubs.push(player.subscribe((_snap, event) => {
      if (event === 'time') return;
      syncRows();
    }));
    screen.unsubs.push(() => container.removeEventListener('click', onClick));

    paint();
    if (!app.history.items.length && !app.history.loading) loadHistory();
  },

  destroy() {
    for (const off of screen.unsubs.splice(0)) {
      try { off(); } catch { /* ignore */ }
    }
    screen.root = null;
  },
};

export default libraryScreen;
