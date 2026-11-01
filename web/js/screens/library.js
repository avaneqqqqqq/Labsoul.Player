/* =========================================================================
   labsoul — экран «Библиотека»: история прослушиваний и избранное.
   Всё хранится локально; история приходит с сервера (или из демо-набора).
   ========================================================================= */

import { bindTrackActions } from '../actions.js';
import { player, getAnalyser } from '../audio.js';
import { bindVisualizer, releaseVisualizer } from '../visualizer.js';
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
  addLocalFiles,
  addLocalPaths,
  deleteLocalTrack,
  libraryErrors,
  libraryTracks,
  loadHistory,
  setHistorySource,
  loadLibraryLikes,
  loadLocalTracks,
  loadPlaylists,
  openPlaylist,
  closePlaylist,
  setPlaylistSource,
  subscribe as storeSubscribe,
  toggleLibrarySource,
} from '../store.js';
import { toast } from '../toast.js';
import { dayKey, dayLabel, esc, humanizeError, plural, pluralTracks } from '../utils.js';

const TAB_KEY = 'player-library-tab';
let tab = 'likes';
let tabExplicit = false;
try {
  const saved = sessionStorage.getItem(TAB_KEY);
  if (saved === 'likes' || saved === 'history' || saved === 'local') {
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
  if (libraryTracks().length) {
    tab = 'likes';
    return;
  }
  tab = (app.local.items || []).length ? 'local' : 'history';
}

function allHistoryTracks() {
  return app.history.items.map((row) => row.track);
}

function currentList() {
  return tab === 'history' ? allHistoryTracks() : libraryTracks();
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
      <button type="button" role="tab" data-tab="likes" class="${tab === 'likes' ? 'on' : ''}" aria-selected="${tab === 'likes'}">
        Избранное <span class="chip__count">${libraryTracks().length}</span>
      </button>
      <button type="button" role="tab" data-tab="local" class="${tab === 'local' ? 'on' : ''}" aria-selected="${tab === 'local'}">
        Своя музыка <span class="chip__count">${(app.local.items || []).length}</span>
      </button>
      <button type="button" role="tab" data-tab="playlists" class="${tab === 'playlists' ? 'on' : ''}" aria-selected="${tab === 'playlists'}">
        Плейлисты <span class="chip__count">${(app.playlists?.items || []).length}</span>
      </button>
      <button type="button" role="tab" data-tab="history" class="${tab === 'history' ? 'on' : ''}" aria-selected="${tab === 'history'}">
        История <span class="chip__count">${app.history.items.length}</span>
      </button>
    </div>
    <div class="lib-toolbar__spacer"></div>
    <button class="btn btn--ghost btn--sm" type="button" data-lib="refresh">${icon('refresh')} Обновить</button>
    <button class="btn btn--ghost btn--sm" type="button" data-lib="queue-all">${icon('plus')} В очередь</button>
  </div>`;
}

/** Какой источник показывать в «Истории»: все или конкретный сервис. */
function historyFilterHtml() {
  const active = app.library.historySource || 'all';
  const options = [['all', 'Все источники'], ...LIB_SOURCE_META.map(({ key, label }) => [key, label])];
  return `<div class="lib-filter" role="group" aria-label="Источник прослушиваний">
    ${options.map(([key, label]) => `<button class="lib-filter__btn${active === key ? ' is-on' : ''}" type="button"
      data-hist-src="${key}" aria-pressed="${active === key}">${esc(label)}</button>`).join('')}
  </div>`;
}

/** Строки истории с учётом выбранного источника. */
function filteredHistoryRows() {
  const source = app.library.historySource || 'all';
  const items = app.history.items || [];
  if (source === 'all') return items;
  return items.filter((row) => row?.track && row.track.source === source);
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
    return `${historyFilterHtml()}<div class="lib-empty">${emptyState({
      iconName: 'library',
      title: 'История пока пуста',
      text: 'Включите Волну или найдите трек — прослушивания появятся здесь автоматически.',
      actions: `<button class="btn btn--accent btn--sm" type="button" data-route="wave">${icon('wave')} Открыть Волну</button>
        <button class="btn btn--ghost btn--sm" type="button" data-route="search">${icon('search')} Найти трек</button>`,
    })}</div>`;
  }

  const filteredRows = filteredHistoryRows();
  if (!filteredRows.length) {
    return `${historyFilterHtml()}<div class="lib-empty">${emptyState({
      iconName: 'library',
      title: 'В этом источнике пусто',
      text: 'Здесь пока нет прослушиваний из выбранного сервиса — выберите другой источник или «Все источники».',
    })}</div>`;
  }

  const likedIds = new Set(app.likes.map((track) => track.id));
  const currentId = player.getState().current?.id;
  const days = new Map();
  for (const row of filteredRows) {
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
  return historyFilterHtml() + chunks.join('');
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

/** Пометка, что часть избранного взята из локального кэша. */
function cachedNoteHtml() {
  const groups = (app.library.remote || []).filter((group) => group && group.cached);
  if (!groups.length) return '';
  const names = groups.map((group) => SOURCE_NAMES[group.source] || group.source).join(', ');
  return `<div class="lib-cached">${icon('cloud')}<span>Сервис недоступен — показаны сохранённые треки: ${esc(names)}</span></div>`;
}

function likesNotesHtml() {
  const errors = libraryErrors();
  if (!errors.length) return '';
  // для сервисов без доступа к избранному рядом с пояснением — ссылка в «Подключения»
  const FIXABLE = new Set(['NO_TOKEN', 'AUTH_FAILED', 'NO_CLIENT_ID', 'CLIENT_ID_REJECTED', 'NO_PROFILE', 'NOT_SUPPORTED']);
  return `<div class="lib-notes">${errors.map((entry) => {
    const name = SOURCE_NAMES[entry.source] || entry.source;
    const fix = FIXABLE.has(entry.error)
      ? ` <button class="lib-note__link" type="button" data-route="sources">настроить</button>`
      : '';
    const reason = entry.error === 'NOT_SUPPORTED'
      ? 'не отдаёт избранное без входа в аккаунт'
      : humanizeError(entry.message || entry.error);
    return `<div class="lib-note">${icon('alert')}<span><b>${esc(name)}</b> — ${esc(reason)}${fix}</span></div>`;
  }).join('')}</div>`;
}

function likesBody() {
  const tracks = libraryTracks();
  const strip = `${likesStripHtml()}${cachedNoteHtml()}${likesNotesHtml()}`;

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

/** Плейлисты сервисов: выбор источника, список, открытие, запуск. */
function playlistsBody() {
  // состояние может быть пустым в промежуточный момент (старый кэш, гонка событий)
  const state = app.playlists || { items: [], tracks: [], source: 'yandex', loading: false, error: null };
  const sources = [
    ['yandex', 'Яндекс.Музыка'],
    ['soundcloud', 'SoundCloud'],
    ['spotify', 'Spotify'],
  ];

  const items = Array.isArray(state.items) ? state.items : [];
  const head = `<div class="lib-filter" role="group" aria-label="Сервис плейлистов">
    ${sources.map(([key, label]) => `<button class="lib-filter__btn${state.source === key ? ' is-on' : ''}" type="button"
      data-pl-src="${key}" aria-pressed="${state.source === key}">${esc(label)}</button>`).join('')}
    <button class="lib-filter__btn lib-filter__btn--ghost" type="button" data-lib="pl-reload" title="Обновить список">Обновить</button>
  </div>`;

  if (state.loading) {
    return `${head}<div class="section">${skeletonRows(4)}</div>`;
  }

  if (state.error && !state.items.length) {
    const fixable = ['NO_TOKEN', 'AUTH_FAILED', 'NO_CLIENT_ID', 'CLIENT_ID_REJECTED', 'NO_PROFILE', 'NOT_SUPPORTED'].includes(state.error);
    return `${head}<div class="lib-empty">${emptyState({
      iconName: 'library',
      title: state.error === 'NOT_SUPPORTED' ? 'Этот сервис не отдаёт плейлисты' : 'Плейлисты недоступны',
      text: state.message || 'Проверьте подключение сервиса.',
      actions: fixable ? `<button class="btn btn--accent btn--sm" type="button" data-route="sources">${icon('key')} Настроить подключение</button>` : '',
    })}</div>`;
  }

  // открытый плейлист: треки
  if (state.openId) {
    const playlist = items.find((item) => item.id === state.openId);
    const likedIds = new Set(app.likes.map((track) => track.id));
    const currentId = player.getState().current?.id;
    const rows = (Array.isArray(state.tracks) ? state.tracks : []).map((track, index) => rowHtml(track, {
      index: index + 1,
      current: track.id === currentId,
      likedIds,
      mode: 'library',
    })).join('');

    return `${head}
      <div class="pl-head">
        <button class="pl-head__back" type="button" data-lib="pl-back">${icon('chev-left')} К списку</button>
        <div class="pl-head__meta">
          <b>${esc(playlist?.title || 'Плейлист')}</b>
          <span>${(Array.isArray(state.tracks) ? state.tracks.length : 0)} ${plural((Array.isArray(state.tracks) ? state.tracks.length : 0), ['трек', 'трека', 'треков'])}${playlist?.ownerName ? ' · ' + esc(playlist.ownerName) : ''}</span>
        </div>
        <button class="btn btn--accent btn--sm" type="button" data-lib="pl-play">${icon('play')} Слушать</button>
      </div>
      ${state.tracksLoading ? `<div class="section">${skeletonRows(5)}</div>` : rows || '<div class="lib-empty">' + emptyState({ iconName: 'music', title: 'Плейлист пуст', text: 'В этом плейлисте нет треков.' }) + '</div>'}`;
  }

  if (!items.length) {
    return `${head}<div class="lib-empty">${emptyState({
      iconName: 'library',
      title: 'Плейлистов пока нет',
      text: 'Здесь появятся ваши плейлисты из подключённых сервисов.',
    })}</div>`;
  }

  return `${head}<div class="pl-grid">${items.map((item) => `
    <button class="pl-card" type="button" data-pl-open="${esc(item.id)}">
      <span class="pl-card__art" style="background:linear-gradient(135deg,#2a2a33,#15151b)">
        ${item.cover ? `<img src="${esc(item.cover)}" alt="" loading="lazy">` : icon('music')}
      </span>
      <span class="pl-card__meta">
        <b>${esc(item.title)}</b>
        <span>${item.trackCount} ${plural(item.trackCount, ['трек', 'трека', 'треков'])}</span>
      </span>
    </button>`).join('')}</div>`;
}

function localDuration(seconds) {
  const value = Math.max(0, Math.round(Number(seconds) || 0));
  if (!value) return '—';
  return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, '0')}`;
}

/** Своя музыка: перетаскивание, путь и выбор файлов. */
function localBody() {
  const items = app.local.items || [];
  const importing = app.local.importing;

  const header = `
    <div class="local-add">
      <div class="local-drop" id="local-drop">
        ${icon('upload')}
        <b>Перетащите файлы или папки сюда</b>
        <span>mp3, flac, m4a, aac, ogg, opus, wav — или укажите путь ниже</span>
      </div>
      <div class="local-path">
        <input id="local-path" class="input" type="text" spellcheck="false"
          placeholder="C:\\Music\\Альбом — файл или папка" aria-label="Путь к файлу или папке">
        <button class="btn btn--ghost btn--sm" type="button" data-lib="add-path">Добавить по пути</button>
        <button class="btn btn--accent btn--sm" type="button" data-lib="pick"${importing ? ' disabled' : ''}>
          ${icon('plus')} Выбрать файлы…
        </button>
        <input id="local-file" type="file" accept="audio/*,.mp3,.flac,.m4a,.ogg,.opus,.wav" multiple hidden>
      </div>
      ${importing ? '<div class="local-hint">Добавляю файлы…</div>' : ''}
      ${app.local.error ? `<div class="local-hint local-hint--err">${esc(app.local.error)}</div>` : ''}
    </div>`;

  if (!items.length) {
    return `${header}<div class="lib-empty">${emptyState({
      iconName: 'music',
      title: 'Своей музыки пока нет',
      text: 'Перетащите аудиофайлы в это окно, вставьте путь к папке или выберите файлы кнопкой — треки останутся в библиотеке и играются без интернета.',
      actions: `<button class="btn btn--accent btn--sm" type="button" data-lib="pick">${icon('plus')} Добавить музыку</button>`,
    })}</div>`;
  }

  const currentId = player.getState().current?.id;
  return `${header}
    <div class="local-list">
      ${items.map((track, index) => `
        <div class="local-track${track.id === currentId ? ' is-current' : ''}" data-local-id="${esc(track.id)}">
          <button class="local-track__play" type="button" data-lib-play="${index}" title="Слушать" aria-label="Слушать">
            ${icon('play')}
          </button>
          <div class="local-track__info">
            <b>${esc(track.title)}</b>
            <span>${esc((track.artists || []).join(', '))}${track.album ? ` · ${esc(track.album)}` : ''}</span>
          </div>
          <span class="local-track__dur">${localDuration(track.duration)}</span>
          <button class="local-track__del" type="button" data-lib-del="${esc(track.sourceId)}"
            title="Убрать из библиотеки" aria-label="Убрать">${icon('trash')}</button>
        </div>`).join('')}
    </div>`;
}

function bodyHtml() {
  const history = historyBody();
  const likes = likesBody();
  const local = localBody();
  const playlists = playlistsBody();
  return `<div data-tab-body="history"${tab === 'history' ? '' : ' hidden'}>${history}</div>
    <div data-tab-body="likes"${tab === 'likes' ? '' : ' hidden'}>${likes}</div>
    <div data-tab-body="local"${tab === 'local' ? '' : ' hidden'}>${local}</div>
    <div data-tab-body="playlists"${tab === 'playlists' ? '' : ' hidden'}>${playlistsBody()}</div>`;
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
  let live = null;
  for (const row of screen.root.querySelectorAll('.row[data-row-id]')) {
    const isCurrent = row.dataset.rowId === currentId;
    row.classList.toggle('is-current', isCurrent);
    const num = row.querySelector('.row__num');
    if (!num) continue;
    if (isCurrent) {
      num.innerHTML = '<span class="row-eq" aria-hidden="true"><i></i><i></i><i></i><i></i></span>';
      live = num.querySelector('.row-eq');
    } else {
      const index = Number(row.dataset.rowIndex) || 0;
      num.textContent = index ? String(index).padStart(2, '0') : '';
    }
  }

  // подключаем ритмичный визуализатор к текущей строке
  if (live) bindVisualizer(live, getAnalyser());
  else releaseVisualizer();
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
  // плейлисты: сервис, открытие, назад, запуск, обновление
  const plSrc = event.target instanceof Element ? event.target.closest('[data-pl-src]') : null;
  if (plSrc) {
    setPlaylistSource(plSrc.dataset.plSrc);
    return;
  }

  const plOpen = event.target instanceof Element ? event.target.closest('[data-pl-open]') : null;
  if (plOpen) {
    openPlaylist(plOpen.dataset.plOpen);
    return;
  }

  const libAction = event.target instanceof Element ? event.target.closest('[data-lib]') : null;
  if (libAction && ['pl-back', 'pl-play', 'pl-reload'].includes(libAction.dataset.lib)) {
    const action = libAction.dataset.lib;
    if (action === 'pl-back') { closePlaylist(); return; }
    if (action === 'pl-reload') { loadPlaylists(); return; }
    if (action === 'pl-play') {
      const list = app.playlists.tracks;
      if (!list.length) { toast('Плейлист пуст', { type: 'warn' }); return; }
      player.playTracks(list, 0, { context: { type: 'playlist', id: app.playlists.openId } });
      toast('Играем плейлист', { icon: 'play' });
      return;
    }
  }

  // фильтр «Истории» по источнику
  const histButton = event.target instanceof Element ? event.target.closest('[data-hist-src]') : null;
  if (histButton) {
    setHistorySource(histButton.dataset.histSrc);
    return;
  }

  const sourceButton = event.target instanceof Element ? event.target.closest('[data-lib-src]') : null;
  if (sourceButton) {
    toggleLibrarySource(sourceButton.dataset.libSrc);
    return;
  }

  // своя музыка: слушать и удалить
  const playButton = event.target instanceof Element ? event.target.closest('[data-lib-play]') : null;
  if (playButton) {
    const index = Number(playButton.dataset.libPlay) || 0;
    const list = app.local.items || [];
    if (list.length) player.playTracks(list, Math.min(index, list.length - 1), { context: { type: 'local' } });
    return;
  }

  const delButton = event.target instanceof Element ? event.target.closest('[data-lib-del]') : null;
  if (delButton) {
    const id = delButton.dataset.libDel;
    deleteLocalTrack(id).then((ok) => {
      toast(ok ? 'Убрано из библиотеки' : 'Не удалось убрать трек', { type: ok ? 'ok' : 'err' });
    });
    return;
  }

  const tabButton = event.target instanceof Element ? event.target.closest('[data-tab]') : null;
  if (tabButton) {
    const raw = tabButton.dataset.tab;
    const next = ['likes', 'local', 'playlists'].includes(raw) ? raw : 'history';
    rememberTab(next);
    paint();
    if (next === 'likes') loadLibraryLikes();
    if (next === 'local') loadLocalTracks();
    if (next === 'playlists') loadPlaylists();
    return;
  }
  const action = event.target instanceof Element ? event.target.closest('[data-lib]') : null;
  if (!action) return;
  switch (action.dataset.lib) {
    case 'refresh': loadHistory(); loadLocalTracks({ force: true }); toast('Библиотека обновляется', { icon: 'refresh' }); break;
    case 'play-all': playAll(); break;
    case 'shuffle-all': playAll({ shuffle: true }); break;
    case 'queue-all': queueAll(); break;
    case 'pick': pickLocalMusic(); break;
    case 'add-path': addLocalByPath(); break;
    default: break;
  }
}

/** Кнопка «Выбрать файлы…»: в приложении — системный диалог, в браузере — выбор файлов. */
async function pickLocalMusic() {
  const bridge = window.playerDesktop;
  if (bridge && typeof bridge.pickMusic === 'function') {
    try {
      const result = await bridge.pickMusic();
      if (result && result.ok) {
        toast(
          `Добавлено: ${result.added}${result.skipped ? `, пропущено ${result.skipped}` : ''}`,
          { icon: 'check' },
        );
        await loadLocalTracks({ force: true });
      } else if (result && result.error) {
        toast(result.error, { type: 'err' });
      }
    } catch (err) {
      toast(err?.message || 'Не удалось открыть выбор файлов', { type: 'err' });
    }
    return;
  }
  const input = screen.root?.querySelector('#local-file');
  if (input) input.click();
}

/** Добавление по вставленному пути (файл или папка). */
async function addLocalByPath() {
  const input = screen.root?.querySelector('#local-path');
  const value = (input && input.value ? input.value : '').trim();
  if (!value) {
    toast('Укажите путь к файлу или папке', { type: 'warn' });
    return;
  }
  try {
    const result = await addLocalPaths([value]);
    if (result && result.ok !== false) {
      toast(
        `Добавлено: ${result.added}${result.skipped ? `, пропущено ${result.skipped}` : ''}`,
        { icon: 'check' },
      );
      if (input) input.value = '';
    } else {
      toast('Не удалось добавить по этому пути', { type: 'err' });
    }
  } catch (err) {
    toast(err?.message || 'Не удалось добавить по пути', { type: 'err' });
  }
}

/** Перетаскивание: в приложении берём настоящие пути, в браузере заливаем файлы. */
function bindDropzone(container) {
  const zone = () => container.querySelector('#local-drop');
  const onDragOver = (event) => {
    if (!event.dataTransfer) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    const el = zone();
    if (el) el.classList.add('is-over');
  };
  const onDragLeave = (event) => {
    const el = zone();
    if (el && !el.contains(event.relatedTarget)) el.classList.remove('is-over');
  };
  const onDrop = async (event) => {
    event.preventDefault();
    const el = zone();
    if (el) el.classList.remove('is-over');

    const files = Array.from(event.dataTransfer?.files || []);
    if (!files.length) return;

    const bridge = window.playerDesktop;
    const paths = files.map((file) => {
      if (bridge && typeof bridge.getPathForFile === 'function') return bridge.getPathForFile(file);
      return file.path || null;
    });

    try {
      if (paths.length && paths.every(Boolean)) {
        const result = await addLocalPaths(paths);
        toast(
          `Добавлено: ${result?.added || 0}${result?.skipped ? `, пропущено ${result.skipped}` : ''}`,
          { icon: 'check' },
        );
      } else {
        const result = await addLocalFiles(files);
        toast(
          `Добавлено: ${result?.added || 0}${result?.errors?.length ? `, ошибок: ${result.errors.length}` : ''}`,
          { icon: 'check' },
        );
      }
    } catch (err) {
      toast(err?.message || 'Не удалось добавить файлы', { type: 'err' });
    }
  };

  container.addEventListener('dragover', onDragOver);
  container.addEventListener('dragleave', onDragLeave);
  container.addEventListener('drop', onDrop);
  return () => {
    container.removeEventListener('dragover', onDragOver);
    container.removeEventListener('dragleave', onDragLeave);
    container.removeEventListener('drop', onDrop);
  };
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
    const unbindDrop = bindDropzone(container);

    const onChange = async (event) => {
      const input = event.target;
      if (!(input instanceof HTMLInputElement) || input.id !== 'local-file') return;
      const files = Array.from(input.files || []);
      input.value = '';
      if (!files.length) return;
      try {
        const result = await addLocalFiles(files);
        toast(
          `Добавлено: ${result?.added || 0}${result?.errors?.length ? `, ошибок: ${result.errors.length}` : ''}`,
          { icon: 'check' },
        );
      } catch (err) {
        toast(err?.message || 'Не удалось загрузить файлы', { type: 'err' });
      }
    };
    container.addEventListener('change', onChange);
    const unbindTracks = bindTrackActions(container, {
      getList: () => currentList(),
      feedback: false,
    });

    screen.unsubs.push(unbindTracks);
    screen.unsubs.push(storeSubscribe((_state, event) => {
      if (event === 'history') paint();
      if (event === 'likes' || event === 'library' || event === 'status' || event === 'local') paint();
      if (event === 'playlists') paint();
      if (event === 'net') {
        if (app.history.items.length === 0) loadHistory();
        loadLibraryLikes({ force: true });
        loadLocalTracks({ force: true });
      }
    }));
    screen.unsubs.push(player.subscribe((_snap, event) => {
      if (event === 'time') return;
      syncRows();
    }));
    screen.unsubs.push(() => container.removeEventListener('click', onClick));
    screen.unsubs.push(unbindDrop);
    screen.unsubs.push(() => container.removeEventListener('change', onChange));

    paint();
    if (!app.history.items.length && !app.history.loading) loadHistory();
    // избранное подтягиваем сразу: полоска сервисов должна показывать живые статусы
    loadLibraryLikes();
    loadLocalTracks();
  },

  destroy() {
    for (const off of screen.unsubs.splice(0)) {
      try { off(); } catch { /* ignore */ }
    }
    screen.root = null;
  },
};

export default libraryScreen;
