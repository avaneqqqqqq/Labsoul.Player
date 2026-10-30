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
  SOURCE_NAMES,
} from '../components.js';
import {
  app,
  libraryErrors,
  libraryTracks,
  loadHistory,
  loadLibraryLikes,
  subscribe as storeSubscribe,
  toggleLibrarySource,
} from '../store.js';
import { toast } from '../toast.js';
import { dayKey, dayLabel, esc, humanizeError, plural, pluralTracks } from '../utils.js';

const TAB_KEY = 'player-library-tab';
let tab = 'history';
let tabExplicit = false;
try {
  const saved = sessionStorage.getItem(TAB_KEY);
  if (saved === 'likes' || saved === 'history') {
    tab = saved;
    tabExplicit = true;
  }
} catch { /* приватный режим */ }

const screen = { root: null, unsubs: [] };

function rememberTab(next) {
  tab = next;
  tabExplicit = true;
  try { sessionStorage.setItem(TAB_KEY, next); } catch { /* ignore */ }
}

/**
 * Пока пользователь сам не выбрал вкладку, показываем то, где есть содержимое:
 * на первом запуске истории ещё нет, а избранное из подключённого сервиса — есть.
 */
function autoTab() {
  if (tabExplicit) return;
  if (app.history.items.length) {
    tab = 'history';
    return;
  }
  tab = libraryTracks().length ? 'likes' : 'history';
}

function historyTracks() {
  return app.history.items.map((row) => row.track);
}

function currentList() {
  return tab === 'history' ? historyTracks() : libraryTracks();
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
      <span class="stat__value">${libraryTracks().length}</span>
      <span class="stat__label">${plural(libraryTracks().length, ['трек', 'трека', 'треков'])} в избранном</span>
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
        Избранное <span class="chip__count">${libraryTracks().length}</span>
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

const LIB_SOURCE_META = [
  { key: 'local', label: 'На компьютере' },
  { key: 'yandex', label: 'Яндекс.Музыка' },
  { key: 'soundcloud', label: 'SoundCloud' },
  { key: 'spotify', label: 'Spotify' },
];

/** Полоска «избранное из»: те же переключатели, что и у Волны. */
function likesStripHtml() {
  const active = new Set(app.library.sources || []);
  const status = app.status?.sources || {};
  const chips = LIB_SOURCE_META.map(({ key, label }) => {
    const on = active.has(key);
    const ready = key === 'local' ? true : Boolean(status[key]?.connected);
    const hint =
      key === 'local'
        ? 'Лайки, поставленные в labsoul'
        : ready
          ? 'Аккаунт подключён — лайки подтянутся'
          : 'Нужен вход в аккаунт сервиса';
    return `<button class="wsrc${on ? ' is-on' : ''}${ready ? '' : ' is-off'}" type="button"
        data-lib-src="${key}" aria-pressed="${on}" title="${hint}">
        <i aria-hidden="true"></i>${esc(label)}${ready ? '' : '<u aria-hidden="true"></u>'}
      </button>`;
  }).join('');

  return `<div class="wave-sources lib-sources" role="group" aria-label="Избранное из каких сервисов">
    <span class="wave-sources__label">избранное из</span>${chips}
  </div>`;
}

function likesNotesHtml() {
  const errors = libraryErrors();
  if (!errors.length) return '';
  return `<div class="lib-notes">${errors.map((entry) => {
    const name = SOURCE_NAMES[entry.source] || entry.source;
    const reason = entry.error === 'NOT_SUPPORTED'
      ? 'не отдаёт избранное без входа в аккаунт'
      : humanizeError(entry.message || entry.error);
    return `<div class="lib-note">${icon('alert')}<span><b>${esc(name)}</b> — ${esc(reason)}</span></div>`;
  }).join('')}</div>`;
}

function likesBody() {
  const tracks = libraryTracks();
  const strip = `${likesStripHtml()}${likesNotesHtml()}`;

  if (app.library.loading && !tracks.length) {
    return `${strip}<div class="section">${skeletonRows(5)}</div>`;
  }

  if (!tracks.length) {
    const anyRemote = (app.library.sources || []).some((key) => key !== 'local');
    return `${strip}<div class="lib-empty">${emptyState({
      iconName: 'heart',
      title: 'В избранном пусто',
      text: anyRemote
        ? 'Поставьте сердечко в labsoul или проверьте, что аккаунт сервиса подключён в «Подключениях» — лайки оттуда подтянутся сюда.'
        : 'Выберите хотя бы один сервис в полоске «избранное из» или поставьте сердечко на треке.',
      actions: `<button class="btn btn--accent btn--sm" type="button" data-route="wave">${icon('wave')} Открыть Волну</button>
        <button class="btn btn--ghost btn--sm" type="button" data-route="sources">${icon('connection')} Подключения</button>`,
    })}</div>`;
  }

  const likedIds = new Set(app.likes.map((track) => track.id));
  const currentId = player.getState().current?.id;
  return `${strip}<div class="rows">${tracks.map((track, i) => rowHtml(track, {
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
  autoTab();
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
  const sourceButton = event.target instanceof Element ? event.target.closest('[data-lib-src]') : null;
  if (sourceButton) {
    toggleLibrarySource(sourceButton.dataset.libSrc);
    return;
  }
  const tabButton = event.target instanceof Element ? event.target.closest('[data-tab]') : null;
  if (tabButton) {
    const next = tabButton.dataset.tab === 'likes' ? 'likes' : 'history';
    rememberTab(next);
    paint();
    if (next === 'likes') loadLibraryLikes();
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
      <p class="footnote lib-footnote">История приходит из GET /api/history. Избранное собирается из локальных лайков и лайков подключённых сервисов (GET /api/likes) — какие сервисы участвуют, задаёт полоска «избранное из». labsoul ничего не пишет в чужие аккаунты, только читает.</p>
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
      if (event === 'likes' || event === 'library' || event === 'status') paint();
      if (event === 'net') {
        if (app.history.items.length === 0) loadHistory();
        loadLibraryLikes({ force: true });
      }
    }));
    screen.unsubs.push(player.subscribe((_snap, event) => {
      if (event === 'time') return;
      syncRows();
    }));
    screen.unsubs.push(() => container.removeEventListener('click', onClick));

    paint();
    if (!app.history.items.length && !app.history.loading) loadHistory();
    // избранное подтягиваем сразу: полоска сервисов должна показывать живые статусы
    loadLibraryLikes();
  },

  destroy() {
    for (const off of screen.unsubs.splice(0)) {
      try { off(); } catch { /* ignore */ }
    }
    screen.root = null;
  },
};

export default libraryScreen;
