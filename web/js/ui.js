/* =========================================================================
   labsoul — оболочка: шапка, сайдбар, нижний плеер, очередь, модалки, клавиши.
   Экраны живут в js/screens/* и сами рисуют только #content.
   ========================================================================= */

import { getUpdate, isDemo, net, ping } from './api.js';
import { player } from './audio.js';
import {
  coverImg,
  icon,
  SOURCE_NAMES,
  SOURCE_SHORT,
  trackStyle,
} from './components.js';
import { failedCovers } from './covers.js';
import { searchFromTopbar } from './screens/search.js';
import {
  app,
  go,
  isLiked,
  loadHistory,
  refreshStatus,
  setQueueOpen,
  subscribe as storeSubscribe,
  toggleLike,
} from './store.js';
import {
  cycleScheme,
  subscribe as themeSubscribe,
  theme,
  update,
} from './theme.js';
import { hideToast, toast } from './toast.js';
import { artistsLine, clamp, esc, fmtClock, isTypingTarget, pluralTracks } from './utils.js';

const ui = {
  playerHost: null,
  queueHost: null,
  scrim: null,
  banner: null,
  currentTrackId: null,
  seeking: false,
  modalOnOk: null,
  searchTimer: 0,
};

/* ------------------------------------------------------------------ */
/* Сайдбар и статус связи                                              */
/* ------------------------------------------------------------------ */

function sourceState(key) {
  if (isDemo()) return { state: 'warn', text: 'демо' };
  const src = app.status?.sources?.[key];
  if (!src) return { state: '', text: '…' };
  if (src.connected) return { state: 'ok', text: 'ок' };
  if (src.error) return { state: 'err', text: 'нет доступа' };
  return { state: 'warn', text: 'не подключено' };
}

function renderSources() {
  const host = document.getElementById('side-sources');
  if (!host) return;
  host.innerHTML = ['yandex', 'soundcloud', 'spotify'].map((key) => {
    const status = sourceState(key);
    return `<button class="src-row" type="button" data-route="sources" data-state="${status.state}" title="${esc(SOURCE_NAMES[key])} — ${esc(status.text)}">
      <i class="src-dot"></i>
      <span class="src-row__name">${esc(SOURCE_NAMES[key])}</span>
      <span class="src-row__state">${esc(status.text)}</span>
    </button>`;
  }).join('');

  const badge = document.getElementById('nav-src-badge');
  if (badge) {
    const disconnected = ['yandex', 'soundcloud', 'spotify']
      .filter((key) => sourceState(key).state === 'err' || sourceState(key).state === 'warn').length;
    const show = !isDemo() && disconnected > 0;
    badge.hidden = !show;
    badge.textContent = show ? String(disconnected) : '!';
  }
}

function modeChip() {
  const chip = document.getElementById('side-mode');
  if (!chip) return;
  chip.classList.remove('is-live', 'is-demo');
  if (net.mode === 'online') {
    chip.classList.add('is-live');
    chip.innerHTML = `${icon('dot')}<span>сервер на связи</span>`;
    chip.title = `Локальный сервер${net.version ? ` · v${net.version}` : ''}`;
  } else if (net.mode === 'demo') {
    chip.classList.add('is-demo');
    chip.innerHTML = `${icon('alert')}<span>демо-режим</span>`;
    chip.title = 'Сервер не запущен — используются локальные демо-треки';
  } else {
    chip.innerHTML = `${icon('dot')}<span>подключение…</span>`;
    chip.title = 'Проверяем локальный сервер';
  }
}

function syncBanner() {
  if (!ui.banner) return;
  const show = net.mode === 'demo';
  ui.banner.hidden = !show;
}

let updateChecked = false;

/** Проверяем обновления один раз за сессию (сервер кэширует ответ на час). */
async function loadUpdate() {
  if (updateChecked || isDemo()) return;
  updateChecked = true;
  let info = null;
  try {
    info = await getUpdate();
  } catch {
    return;
  }
  if (!info || !info.updateAvailable || !info.latest) return;

  const chip = document.getElementById('side-version');
  if (!chip) return;
  chip.classList.add('side-foot__chip--update');
  chip.setAttribute('role', 'link');
  chip.tabIndex = 0;
  chip.title = `Доступна версия ${info.latest.version} — открыть страницу релиза`;
  chip.innerHTML = `${icon('arrow-up')}<span>${String(info.latest.version)}</span>`;
  const open = () => window.open(info.latest.url, '_blank', 'noopener');
  chip.addEventListener('click', open);
  chip.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      open();
    }
  });
}

/**
 * Проверка внешнего вида полноэкранного плеера без запуска трека:
 * открыть labsoul с параметром ?np в адресе (используется для QA).
 */
function maybeOpenNowPlayingDemo() {
  try {
    if (!new URLSearchParams(location.search).has('np')) return;
    setTimeout(() => openNowPlaying(), 400);
  } catch { /* не критично */ }
}

function syncNetUi() {
  modeChip();
  syncBanner();
  renderSources();
  if (net.mode === 'online') loadUpdate();
}

/* ------------------------------------------------------------------ */
/* Нижний плеер                                                        */
/* ------------------------------------------------------------------ */

function playerTemplate(snap) {
  const track = snap.current;
  const liked = track ? isLiked(track.id) : false;
  const duration = snap.duration || track?.duration || 0;
  const srcName = track ? (SOURCE_SHORT[track.source] || track.source) : '';
  const repeatIcon = snap.repeat === 'one' ? 'repeat-one' : 'repeat';
  const repeatTitle = snap.repeat === 'off' ? 'Повтор выключен' : snap.repeat === 'all' ? 'Повтор очереди' : 'Повтор трека';

  return `
    <div class="pl-now${track ? '' : ' is-empty'}">
      <div class="pl-now__art" style="${track ? trackStyle(track) : ''}">
        ${track ? coverImg(track, { eager: true }) : ''}
      </div>
      <div class="pl-now__meta">
        <span class="pl-now__t" title="${esc(track?.title || 'Ничего не играет')}">${esc(track?.title || 'Ничего не играет')}</span>
        <span class="pl-now__a">${track ? esc(artistsLine(track)) : 'Выберите трек в Волне или поиске'}</span>
      </div>
      ${track ? `<button class="row__btn pl-now__like${liked ? ' on' : ''}" type="button" data-pl="like" title="${liked ? 'Убрать из избранного' : 'В избранное'}" aria-label="${liked ? 'Убрать из избранного' : 'В избранное'}">${icon('heart')}</button>` : ''}
    </div>

    <div class="pl-center">
      <div class="pl-btns">
        <button class="pl-btn${snap.shuffle ? ' on' : ''}" type="button" data-pl="shuffle" title="Перемешать" aria-label="Перемешать" aria-pressed="${snap.shuffle}">${icon('shuffle')}</button>
        <button class="pl-btn" type="button" data-pl="prev" title="Предыдущий трек" aria-label="Предыдущий трек" ${track ? '' : 'disabled'}>${icon('prev')}</button>
        <button class="pl-btn pl-btn--main" type="button" data-pl="toggle" title="${snap.playing ? 'Пауза' : 'Играть'}" aria-label="${snap.playing ? 'Пауза' : 'Играть'}">${icon(snap.playing ? 'pause' : 'play')}</button>
        <button class="pl-btn" type="button" data-pl="next" title="Следующий трек" aria-label="Следующий трек" ${track ? '' : 'disabled'}>${icon('next')}</button>
        <button class="pl-btn${snap.repeat !== 'off' ? ' on' : ''}" type="button" data-pl="repeat" title="${repeatTitle}" aria-label="${repeatTitle}">${icon(repeatIcon)}</button>
      </div>
      <div class="pl-line${track ? '' : ' is-empty'}">
        <span class="pl-time" data-pl-time>${fmtClock(snap.time)}</span>
        <input class="rng pl-seek" type="range" min="0" max="1000" step="1" value="${duration ? Math.round((snap.time / duration) * 1000) : 0}"
          aria-label="Перемотка" ${track ? '' : 'disabled'}>
        <span class="pl-time pl-time--end" data-pl-dur>${fmtClock(duration)}</span>
      </div>
    </div>

    <div class="pl-right">
      <span class="pl-eq" title="Играет" aria-hidden="true"><i></i><i></i><i></i><i></i></span>
      ${srcName ? `<span class="pl-src" title="${esc(SOURCE_NAMES[track.source] || '')}">${esc(srcName)}</span>` : ''}
      <button class="pl-btn${theme.eq.on ? ' on' : ''}" type="button" data-pl="eq" title="Эквалайзер" aria-label="Эквалайзер">${icon('eq')}</button>
      <button class="pl-btn" type="button" data-pl="mute" title="Звук" aria-label="Выключить звук">${icon(snap.muted || snap.volume === 0 ? 'volume-mute' : 'volume')}</button>
      <div class="pl-vol">
        <input class="rng" type="range" min="0" max="100" step="1" value="${Math.round((snap.muted ? 0 : snap.volume) * 100)}" aria-label="Громкость">
      </div>
      <button class="pl-btn pl-queue" type="button" data-pl="queue" title="Очередь" aria-label="Очередь">
        ${icon('queue')}<i class="pl-queue__count" data-pl-queue-count>${snap.queue.length}</i>
      </button>
    </div>`;
}

function renderPlayer(snap) {
  if (!ui.playerHost) return;
  ui.playerHost.innerHTML = playerTemplate(snap);
  ui.currentTrackId = snap.current?.id || null;
  syncPlayer(snap);
}

function syncPlayer(snap) {
  if (!ui.playerHost) return;
  const host = ui.playerHost;
  document.body.dataset.playing = snap.playing ? 'true' : 'false';

  const main = host.querySelector('[data-pl="toggle"]');
  if (main) {
    main.innerHTML = icon(snap.playing ? 'pause' : 'play');
    main.classList.toggle('is-loading', !!snap.loading && !snap.playing);
    const label = snap.playing ? 'Пауза' : 'Играть';
    main.title = label;
    main.setAttribute('aria-label', label);
  }

  const shuffle = host.querySelector('[data-pl="shuffle"]');
  if (shuffle) {
    shuffle.classList.toggle('on', snap.shuffle);
    shuffle.setAttribute('aria-pressed', String(snap.shuffle));
  }

  const repeat = host.querySelector('[data-pl="repeat"]');
  if (repeat) {
    repeat.classList.toggle('on', snap.repeat !== 'off');
    repeat.innerHTML = icon(snap.repeat === 'one' ? 'repeat-one' : 'repeat');
    const title = snap.repeat === 'off' ? 'Повтор выключен' : snap.repeat === 'all' ? 'Повтор очереди' : 'Повтор трека';
    repeat.title = title;
    repeat.setAttribute('aria-label', title);
  }

  const like = host.querySelector('[data-pl="like"]');
  if (like && snap.current) {
    const liked = isLiked(snap.current.id);
    like.classList.toggle('on', liked);
    like.title = liked ? 'Убрать из избранного' : 'В избранное';
  }

  const duration = snap.duration || snap.current?.duration || 0;
  const seek = host.querySelector('.pl-seek');
  if (seek) {
    if (!ui.seeking) {
      seek.value = duration ? String(Math.round((snap.time / duration) * 1000)) : '0';
    }
    seek.disabled = !snap.current;
    // заполнение полосы считаем здесь же: без этого слайдер висел на дефолтном 50%
    const percent = duration ? Math.min(100, Math.max(0, (snap.time / duration) * 100)) : 0;
    seek.style.setProperty('--p', `${percent}%`);
  }
  const line = host.querySelector('.pl-line');
  if (line) line.classList.toggle('is-empty', !snap.current);
  const time = host.querySelector('[data-pl-time]');
  if (time) time.textContent = fmtClock(snap.time);
  const dur = host.querySelector('[data-pl-dur]');
  if (dur) dur.textContent = fmtClock(duration);

  const count = host.querySelector('[data-pl-queue-count]');
  if (count) count.textContent = String(snap.queue.length);

  const vol = host.querySelector('.pl-vol input');
  if (vol && document.activeElement !== vol) {
    vol.value = String(Math.round((snap.muted ? 0 : snap.volume) * 100));
    vol.style.setProperty('--p', `${vol.value}%`);
  }
  const mute = host.querySelector('[data-pl="mute"]');
  if (mute) {
    mute.innerHTML = icon(snap.muted || snap.volume === 0 ? 'volume-mute' : 'volume');
    mute.title = snap.muted ? 'Включить звук' : 'Выключить звук';
  }

  const eq = host.querySelector('[data-pl="eq"]');
  if (eq) eq.classList.toggle('on', theme.eq.on);
}

function onPlayerEvent(snap, event) {
  if (event === 'time') {
    syncPlayer(snap);
    return;
  }
  if (event === 'init' || event === 'track' || snap.current?.id !== ui.currentTrackId) {
    renderPlayer(snap);
  } else {
    syncPlayer(snap);
  }

  if (event === 'unplayable' && snap.current) {
    toast(snap.error || 'Трек недоступен', { type: 'warn', icon: 'alert' });
  }
  if (event === 'error' && snap.error) {
    toast(snap.error, { type: 'err' });
  }
  if (event === 'history') {
    if (app.route === 'library') loadHistory();
  }
  if (app.ui.queueOpen) renderQueue(snap);
}

function onPlayerClick(event) {
  const target = event.target instanceof Element ? event.target.closest('[data-pl]') : null;
  if (!target) {
    // обложка открывает полноэкранный плеер, название/исполнитель — пауза/воспроизведение
    const art = event.target instanceof Element ? event.target.closest('.pl-now__art') : null;
    if (art) {
      if (player.currentTrack()) openNowPlaying();
      return;
    }
    const meta = event.target instanceof Element ? event.target.closest('.pl-now__meta') : null;
    if (meta) player.toggle();
    return;
  }
  const action = target.dataset.pl;
  switch (action) {
    case 'toggle': player.toggle(); break;
    case 'next': player.next(); break;
    case 'prev': player.prev(); break;
    case 'shuffle': {
      const on = player.toggleShuffle();
      toast(on ? 'Перемешивание включено' : 'Перемешивание выключено', { icon: 'shuffle', duration: 1600 });
      break;
    }
    case 'repeat': {
      const mode = player.cycleRepeat();
      toast(mode === 'off' ? 'Повтор выключен' : mode === 'all' ? 'Повтор очереди' : 'Повтор одного трека', { icon: 'repeat', duration: 1600 });
      break;
    }
    case 'mute': player.toggleMute(); break;
    case 'like': {
      const track = player.currentTrack();
      if (!track) break;
      const liked = toggleLike(track);
      toast(liked ? `В избранном: ${track.title}` : 'Убрано из избранного', { icon: 'heart' });
      break;
    }
    case 'queue': toggleQueue(); break;
    case 'eq': {
      go('design');
      setTimeout(() => document.getElementById('eq-section')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 280);
      break;
    }
    default: break;
  }
}

function onPlayerInput(event) {
  const target = event.target;
  if (!(target instanceof HTMLInputElement)) return;
  if (target.classList.contains('pl-seek')) {
    const snap = player.getState();
    const duration = snap.duration || snap.current?.duration || 0;
    const seconds = (Number(target.value) / 1000) * duration;
    player.seek(seconds);
    return;
  }
  if (target.closest('.pl-vol')) {
    player.setVolume(Number(target.value) / 100);
    target.style.setProperty('--p', `${target.value}%`);
  }
}

/* ------------------------------------------------------------------ */
/* Полноэкранный плеер                                                 */
/* ------------------------------------------------------------------ */

const nowPlaying = { el: null, unsub: null, onKey: null };

function npTemplate() {
  return `
    <div class="np__bg" data-np-bg></div>
    <div class="np__inner">
      <button class="np__close" type="button" data-np="close" title="Закрыть (Esc)" aria-label="Закрыть">${icon('x')}</button>
      <div class="np__art" data-np-art></div>
      <div class="np__side">
        <span class="np__src" data-np-src></span>
        <h2 class="np__title" data-np-title>Ничего не играет</h2>
        <div class="np__artist" data-np-artist></div>
        <div class="np__album" data-np-album></div>
        <div class="np__line">
          <span class="np__time" data-np-time>0:00</span>
          <input class="rng np__seek" type="range" min="0" max="1000" step="1" value="0" aria-label="Перемотка">
          <span class="np__time" data-np-dur>0:00</span>
        </div>
        <div class="np__btns">
          <button class="pl-btn" type="button" data-np="shuffle" title="Перемешать" aria-label="Перемешать">${icon('shuffle')}</button>
          <button class="pl-btn" type="button" data-np="prev" title="Предыдущий" aria-label="Предыдущий">${icon('prev')}</button>
          <button class="pl-btn pl-btn--main np__play" type="button" data-np="toggle" title="Играть" aria-label="Играть">${icon('play')}</button>
          <button class="pl-btn" type="button" data-np="next" title="Следующий" aria-label="Следующий">${icon('next')}</button>
          <button class="pl-btn" type="button" data-np="repeat" title="Повтор" aria-label="Повтор">${icon('repeat')}</button>
        </div>
        <div class="np__extra">
          <button class="np__chip" type="button" data-np="like">${icon('heart')}<span>В избранное</span></button>
          <button class="np__chip" type="button" data-np="queue">${icon('queue')}<span>Очередь</span></button>
        </div>
      </div>
    </div>`;
}

function syncNowPlaying() {
  if (!nowPlaying.el) return;
  const snap = player.getState();
  const track = snap.current;
  const el = nowPlaying.el;
  const duration = snap.duration || track?.duration || 0;

  const setText = (selector, value) => {
    const node = el.querySelector(selector);
    if (node) node.textContent = value;
  };

  el.classList.toggle('is-empty', !track);
  if (!track) {
    setText('[data-np-title]', 'Ничего не играет');
    setText('[data-np-artist]', 'Выберите трек в Волне или поиске');
    setText('[data-np-album]', '');
    setText('[data-np-src]', '');
    const bg = el.querySelector('[data-np-bg]');
    if (bg) bg.style.backgroundImage = 'none';
    return;
  }

  setText('[data-np-title]', track.title || 'Без названия');
  setText('[data-np-artist]', artistsLine(track));
  setText('[data-np-album]', track.album || '');
  setText('[data-np-src]', SOURCE_NAMES[track.source] || track.source);

  const art = el.querySelector('[data-np-art]');
  if (art) {
    art.setAttribute('style', trackStyle(track));
    art.innerHTML = coverImg(track, { eager: true });
  }
  const bg = el.querySelector('[data-np-bg]');
  if (bg && track.cover) bg.style.backgroundImage = `url("${track.cover}")`;

  setText('[data-np-time]', fmtClock(snap.time));
  setText('[data-np-dur]', fmtClock(duration));

  const seek = el.querySelector('.np__seek');
  if (seek) {
    seek.disabled = !track;
    if (!ui.seeking) seek.value = String(duration ? Math.round((snap.time / duration) * 1000) : 0);
    const percent = duration ? Math.min(100, Math.max(0, (snap.time / duration) * 100)) : 0;
    seek.style.setProperty('--p', `${percent}%`);
  }

  const toggle = el.querySelector('[data-np="toggle"]');
  if (toggle) {
    toggle.innerHTML = icon(snap.playing ? 'pause' : 'play');
    toggle.title = snap.playing ? 'Пауза' : 'Играть';
  }
  const shuffle = el.querySelector('[data-np="shuffle"]');
  if (shuffle) shuffle.classList.toggle('on', !!snap.shuffle);
  const repeat = el.querySelector('[data-np="repeat"]');
  if (repeat) {
    repeat.innerHTML = icon(snap.repeat === 'one' ? 'repeat-one' : 'repeat');
    repeat.classList.toggle('on', snap.repeat !== 'off');
  }
  const like = el.querySelector('[data-np="like"]');
  if (like) {
    const liked = isLiked(track.id);
    like.classList.toggle('is-on', liked);
    const label = like.querySelector('span');
    if (label) label.textContent = liked ? 'В избранном' : 'В избранное';
  }
}

function openNowPlaying() {
  if (nowPlaying.el) return;

  const el = document.createElement('div');
  el.className = 'np';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-modal', 'true');
  el.setAttribute('aria-label', 'Сейчас играет');
  el.innerHTML = npTemplate();
  document.body.appendChild(el);
  document.body.classList.add('np-open');
  nowPlaying.el = el;

  syncNowPlaying();

  el.addEventListener('click', (event) => {
    const button = event.target instanceof Element ? event.target.closest('[data-np]') : null;
    if (!button) {
      // клик по фону закрывает
      if (event.target === el) closeNowPlaying();
      return;
    }
    const action = button.dataset.np;
    if (action === 'close') { closeNowPlaying(); return; }
    if (action === 'toggle') { player.toggle(); syncNowPlaying(); return; }
    if (action === 'next') { player.next(); syncNowPlaying(); return; }
    if (action === 'prev') { player.prev(); syncNowPlaying(); return; }
    if (action === 'shuffle') { player.toggleShuffle(); syncNowPlaying(); return; }
    if (action === 'repeat') { player.cycleRepeat(); syncNowPlaying(); return; }
    if (action === 'queue') { closeNowPlaying(); if (!app.ui.queueOpen) toggleQueue(); return; }
    if (action === 'like') {
      const track = player.currentTrack();
      if (!track) return;
      const liked = toggleLike(track);
      toast(liked ? `В избранном: ${track.title}` : 'Убрано из избранного', { icon: 'heart' });
      syncNowPlaying();
    }
  });

  el.addEventListener('input', (event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement) || !target.classList.contains('np__seek')) return;
    const snap = player.getState();
    const duration = snap.duration || snap.current?.duration || 0;
    player.seek((Number(target.value) / 1000) * duration);
  });

  nowPlaying.onKey = (event) => {
    if (event.key === 'Escape') { closeNowPlaying(); return; }
    if (event.key === ' ' && !(event.target instanceof HTMLInputElement)) {
      event.preventDefault();
      player.toggle();
    }
  };
  document.addEventListener('keydown', nowPlaying.onKey);

  nowPlaying.unsub = player.subscribe((_snap, event) => {
    if (event === 'time') {
      const snap = player.getState();
      const duration = snap.duration || snap.current?.duration || 0;
      const time = nowPlaying.el?.querySelector('[data-np-time]');
      if (time) time.textContent = fmtClock(snap.time);
      const seek = nowPlaying.el?.querySelector('.np__seek');
      if (seek && !ui.seeking && duration) {
        seek.value = String(Math.round((snap.time / duration) * 1000));
        seek.style.setProperty('--p', `${(snap.time / duration) * 100}%`);
      }
      return;
    }
    syncNowPlaying();
  });
}

function closeNowPlaying() {
  if (!nowPlaying.el) return;
  if (nowPlaying.unsub) { nowPlaying.unsub(); nowPlaying.unsub = null; }
  if (nowPlaying.onKey) { document.removeEventListener('keydown', nowPlaying.onKey); nowPlaying.onKey = null; }
  nowPlaying.el.remove();
  nowPlaying.el = null;
  document.body.classList.remove('np-open');
}

/* ------------------------------------------------------------------ */
/* Очередь                                                             */
/* ------------------------------------------------------------------ */

function queueItemHtml(track, index, { current = false } = {}) {
  return `<div class="qitem${current ? ' is-current' : ''}" data-q-index="${index}" draggable="true">
    <span class="qitem__grip">${icon('drag')}</span>
    <span class="qitem__art" style="${trackStyle(track)}">${coverImg(track)}</span>
    <span class="qitem__meta">
      <span class="qitem__t">${esc(track.title)}</span>
      <span class="qitem__a">${esc(artistsLine(track))}</span>
    </span>
    <button class="qitem__x" type="button" data-q-remove="${index}" title="Убрать из очереди" aria-label="Убрать из очереди">${icon('x')}</button>
  </div>`;
}

function renderQueue(snap = player.getState()) {
  if (!ui.queueHost) return;
  const list = ui.queueHost.querySelector('#queue-list');
  const title = ui.queueHost.querySelector('#queue-title');
  const total = ui.queueHost.querySelector('#queue-total');
  if (!list) return;

  const { queue, index, current } = snap;
  const totalSeconds = queue.reduce((sum, track) => sum + (track.duration || 0), 0);

  if (title) title.textContent = queue.length ? `${pluralTracks(queue.length)}` : 'Пусто';
  if (total) total.textContent = queue.length ? `≈ ${Math.round(totalSeconds / 60)} мин` : '0 треков';

  if (!queue.length) {
    list.innerHTML = `<div class="queue__empty">${icon('queue')}<div>Очередь пуста.<br>Нажмите «+» у трека или запустите Волну.</div></div>`;
    return;
  }

  const currentTrack = current && index >= 0 ? current : null;
  const parts = [];
  if (currentTrack) {
    parts.push('<div class="queue__sec">Сейчас играет</div>');
    parts.push(queueItemHtml(currentTrack, index, { current: true }));
  }
  const upcoming = queue.map((track, i) => ({ track, i })).filter(({ i }) => i !== index);
  if (upcoming.length) {
    parts.push('<div class="queue__sec">Дальше</div>');
    parts.push(upcoming.map(({ track, i }) => queueItemHtml(track, i)).join(''));
  }
  list.innerHTML = parts.join('');
}

function toggleQueue(force) {
  const open = typeof force === 'boolean' ? force : !app.ui.queueOpen;
  setQueueOpen(open);
}

function syncQueueUi() {
  if (!ui.queueHost) return;
  const open = app.ui.queueOpen;
  ui.queueHost.classList.toggle('is-open', open);
  ui.queueHost.setAttribute('aria-hidden', String(!open));
  if (ui.scrim) {
    ui.scrim.hidden = !open;
    ui.scrim.classList.toggle('is-open', open);
  }
  document.body.classList.toggle('queue-open', open);
  if (open) renderQueue();
}

function onQueueClick(event) {
  const target = event.target instanceof Element ? event.target.closest('[data-q], [data-q-remove], .qitem') : null;
  if (!target) return;
  if (target.dataset.q === 'close') { toggleQueue(false); return; }
  if (target.dataset.q === 'clear') {
    player.clearQueue();
    renderQueue();
    toast('Очередь очищена', { icon: 'trash' });
    return;
  }
  if (target.dataset.q === 'shuffle') {
    player.shuffleQueue();
    renderQueue();
    toast('Очередь перемешана', { icon: 'shuffle' });
    return;
  }
  if (target.dataset.qRemove !== undefined) {
    event.stopPropagation();
    player.removeQueueItem(Number(target.dataset.qRemove));
    renderQueue();
    return;
  }
  if (target.classList.contains('qitem')) {
    const index = Number(target.dataset.qIndex);
    if (Number.isInteger(index)) {
      player.playAt(index);
      renderQueue();
    }
  }
}

function setupQueueDrag() {
  const host = ui.queueHost;
  if (!host) return;
  host.addEventListener('dragstart', (event) => {
    const item = event.target instanceof Element ? event.target.closest('.qitem') : null;
    if (!item) return;
    item.classList.add('is-drag');
    event.dataTransfer.effectAllowed = 'move';
    try { event.dataTransfer.setData('text/plain', item.dataset.qIndex); } catch { /* ignore */ }
  });
  host.addEventListener('dragend', () => {
    host.querySelectorAll('.qitem').forEach((item) => item.classList.remove('is-drag', 'is-over'));
  });
  host.addEventListener('dragover', (event) => {
    const item = event.target instanceof Element ? event.target.closest('.qitem') : null;
    if (!item) return;
    event.preventDefault();
    host.querySelectorAll('.qitem.is-over').forEach((el) => el.classList.remove('is-over'));
    item.classList.add('is-over');
  });
  host.addEventListener('drop', (event) => {
    const item = event.target instanceof Element ? event.target.closest('.qitem') : null;
    if (!item) return;
    event.preventDefault();
    const to = Number(item.dataset.qIndex);
    let from = -1;
    try { from = Number(event.dataTransfer.getData('text/plain')); } catch { from = -1; }
    const dragged = host.querySelector('.qitem.is-drag');
    if (Number.isNaN(from) && dragged) from = Number(dragged.dataset.qIndex);
    host.querySelectorAll('.qitem.is-over').forEach((el) => el.classList.remove('is-over'));
    if (Number.isInteger(from) && Number.isInteger(to) && from !== to) {
      player.moveQueueItem(from, to);
      renderQueue();
    }
  });
}

/* ------------------------------------------------------------------ */
/* Модалка                                                             */
/* ------------------------------------------------------------------ */

export function openModal({ title = 'Готово', body = '', okLabel = 'Применить', cancelLabel = 'Отмена', onOk = null } = {}) {
  const dialog = document.getElementById('modal');
  const form = document.getElementById('modal-card');
  if (!dialog || !form) return;
  const titleEl = dialog.querySelector('#modal-title');
  const bodyEl = dialog.querySelector('#modal-body');
  const okBtn = dialog.querySelector('#modal-ok');
  const cancelBtn = form.querySelector('button[value="cancel"].btn');
  if (titleEl) titleEl.textContent = title;
  if (bodyEl) bodyEl.innerHTML = body;
  if (okBtn) okBtn.textContent = okLabel;
  if (cancelBtn) cancelBtn.textContent = cancelLabel;
  ui.modalOnOk = onOk;
  if (dialog.open) dialog.close();
  dialog.showModal();
  const focusTarget = dialog.querySelector('textarea, input');
  if (focusTarget) requestAnimationFrame(() => focusTarget.focus());
}

export function closeModal() {
  const dialog = document.getElementById('modal');
  if (dialog?.open) dialog.close();
  ui.modalOnOk = null;
}

function setupModal() {
  const dialog = document.getElementById('modal');
  const form = document.getElementById('modal-card');
  if (!dialog || !form) return;
  form.addEventListener('submit', (event) => {
    const submitter = event.submitter;
    if (submitter && submitter.value === 'ok') {
      const handler = ui.modalOnOk;
      let result = true;
      try { result = handler ? handler() : true; } catch (err) {
        console.warn('[labsoul] modal action', err);
        result = false;
      }
      if (result === false) {
        event.preventDefault();
        return;
      }
      ui.modalOnOk = null;
      return;
    }
    ui.modalOnOk = null;
  });
  dialog.addEventListener('close', () => { ui.modalOnOk = null; });
}

/* ------------------------------------------------------------------ */
/* Верхняя панель                                                      */
/* ------------------------------------------------------------------ */

function syncSchemeIcon() {
  const iconHost = document.getElementById('scheme-icon');
  const button = document.getElementById('btn-scheme');
  if (!iconHost || !button) return;
  const name = theme.scheme === 'light' ? 'sun' : theme.scheme === 'amoled' ? 'spark' : 'moon';
  iconHost.innerHTML = `<use href="#i-${name}"></use>`;
  button.title = `Схема: ${theme.scheme === 'light' ? 'светлая' : theme.scheme === 'amoled' ? 'AMOLED' : 'тёмная'}`;
}

function syncQuickTheme() {
  document.querySelectorAll('.stylepick [data-variant]').forEach((button) => {
    button.classList.toggle('on', button.dataset.variant === theme.variant);
  });
  syncSchemeIcon();
}

function focusSearch() {
  if (app.route === 'search') {
    const field = document.getElementById('search-page-input');
    if (field) { field.focus(); field.select?.(); }
    return;
  }
  go('search');
  setTimeout(() => {
    const field = document.getElementById('search-page-input') || document.getElementById('global-search');
    field?.focus();
  }, 90);
}

function setupSearch() {
  const input = document.getElementById('global-search');
  if (!input) return;
  const trigger = () => {
    const value = input.value;
    if (!value.trim()) return;
    searchFromTopbar(value);
    if (app.route !== 'search') go('search');
  };
  input.addEventListener('input', () => {
    clearTimeout(ui.searchTimer);
    if (!input.value.trim()) {
      if (app.route === 'search') searchFromTopbar('');
      return;
    }
    if (app.route !== 'search') go('search');
    const value = input.value;
    ui.searchTimer = setTimeout(() => searchFromTopbar(value), 320);
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      clearTimeout(ui.searchTimer);
      trigger();
    }
    if (event.key === 'Escape') {
      input.value = '';
      searchFromTopbar('');
      input.blur();
    }
  });
}

/* ------------------------------------------------------------------ */
/* Клавиатура                                                          */
/* ------------------------------------------------------------------ */

function setupKeyboard() {
  document.addEventListener('keydown', (event) => {
    const dialog = document.getElementById('modal');
    if (dialog?.open) return;

    const mod = event.ctrlKey || event.metaKey;
    if (mod && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      focusSearch();
      return;
    }
    if (isTypingTarget(event.target)) return;

    const snap = player.getState();
    const key = event.key;

    if (event.code === 'Space') {
      event.preventDefault();
      player.toggle();
      return;
    }
    if (key === 'Escape') {
      toggleQueue(false);
      hideToast();
      return;
    }
    if (key === 'ArrowRight') { event.preventDefault(); player.seekBy(5); return; }
    if (key === 'ArrowLeft') { event.preventDefault(); player.seekBy(-5); return; }
    if (key === 'ArrowUp') {
      event.preventDefault();
      player.setVolume(clamp(snap.volume + 0.05, 0, 1));
      return;
    }
    if (key === 'ArrowDown') {
      event.preventDefault();
      player.setVolume(clamp(snap.volume - 0.05, 0, 1));
      return;
    }
    if (key === '/') {
      event.preventDefault();
      focusSearch();
      return;
    }
    const lower = key.toLowerCase();
    if (lower === 'm') { player.toggleMute(); return; }
    if (lower === 'n') { player.next(); return; }
    if (lower === 'p') { player.prev(); return; }
    if (lower === 's') { player.toggleShuffle(); return; }
    if (lower === 'r') { player.cycleRepeat(); return; }
    if (lower === 'l' && snap.current) {
      const liked = toggleLike(snap.current);
      toast(liked ? 'В избранном' : 'Убрано из избранного', { icon: 'heart', duration: 1500 });
    }
  });
}

/* ------------------------------------------------------------------ */
/* Маршруты                                                            */
/* ------------------------------------------------------------------ */

function syncRouteUi() {
  document.querySelectorAll('.nav__item[data-route]').forEach((item) => {
    item.classList.toggle('is-active', item.dataset.route === app.route);
  });
  document.body.dataset.route = app.route;
  const title = {
    wave: 'Волна',
    search: 'Поиск',
    library: 'Библиотека',
    sources: 'Подключения',
    design: 'Оформление',
  }[app.route] || 'Волна';
  document.title = `labsoul — ${title}`;
  toggleQueue(false);
}

/* ------------------------------------------------------------------ */
/* Инициализация                                                       */
/* ------------------------------------------------------------------ */

export function initShell() {
  ui.playerHost = document.getElementById('player');
  ui.queueHost = document.getElementById('queue');
  ui.scrim = document.getElementById('scrim');
  ui.banner = document.getElementById('banner');

  renderSources();
  modeChip();
  syncBanner();
  syncQuickTheme();
  maybeOpenNowPlayingDemo();

  // битые обложки убираем, чтобы остался аккуратный градиент и не проступал alt-текст
  document.addEventListener('error', (event) => {
    const target = event.target;
    if (target instanceof HTMLImageElement && target.dataset.cover === '1') {
      const src = target.getAttribute('src');
      if (src) failedCovers.add(src);
      target.remove();
    }
  }, true);

  // общие клики по маршрутам/панели
  document.addEventListener('click', (event) => {
    const routeEl = event.target instanceof Element ? event.target.closest('[data-route]') : null;
    if (routeEl && routeEl !== document.body && routeEl.tagName !== 'A') {
      event.preventDefault();
      go(routeEl.dataset.route);
      return;
    }
    const variantEl = event.target instanceof Element ? event.target.closest('.stylepick [data-variant]') : null;
    if (variantEl) {
      update('variant', variantEl.dataset.variant);
      toast(`Стиль: ${{ glass: 'Стекло', vinyl: 'Пластинка', neon: 'Неон', paper: 'Бумага' }[variantEl.dataset.variant]}`, {
        icon: 'spark',
        duration: 1600,
      });
    }
  });

  document.getElementById('btn-scheme')?.addEventListener('click', () => {
    const scheme = cycleScheme();
    syncSchemeIcon();
    toast(scheme === 'light' ? 'Светлая схема' : scheme === 'amoled' ? 'AMOLED — чистый чёрный' : 'Тёмная схема', { icon: 'palette', duration: 1600 });
  });
  document.getElementById('btn-queue-top')?.addEventListener('click', () => toggleQueue());
  document.getElementById('btn-back')?.addEventListener('click', () => history.back());
  document.getElementById('btn-forward')?.addEventListener('click', () => history.forward());

  setupSearch();
  setupKeyboard();
  setupModal();

  if (ui.playerHost) ui.playerHost.addEventListener('click', onPlayerClick);
  if (ui.playerHost) {
    ui.playerHost.addEventListener('input', onPlayerInput);
    ui.playerHost.addEventListener('pointerdown', (event) => {
      if (event.target instanceof Element && event.target.classList.contains('pl-seek')) ui.seeking = true;
    });
    window.addEventListener('pointerup', () => { ui.seeking = false; });
    ui.playerHost.addEventListener('change', () => { ui.seeking = false; });
  }

  if (ui.scrim) ui.scrim.addEventListener('click', () => toggleQueue(false));
  const queueHost = ui.queueHost;
  if (queueHost) {
    queueHost.addEventListener('click', onQueueClick);
    setupQueueDrag();
  }

  document.getElementById('btn-retry')?.addEventListener('click', async () => {
    const button = document.getElementById('btn-retry');
    if (button) button.disabled = true;
    const ok = await ping(2200);
    if (button) button.disabled = false;
    if (ok) {
      toast('Сервер на связи', { icon: 'check' });
      refreshStatus();
    } else {
      toast('Сервер всё ещё не отвечает — остаёмся в демо-режиме', { type: 'warn' });
    }
  });

  player.subscribe(onPlayerEvent);
  renderQueue();

  storeSubscribe((_state, event) => {
    if (event === 'status') {
      renderSources();
      syncNetUi();
    }
    if (event === 'net') {
      syncNetUi();
      if (net.mode === 'online') {
        refreshStatus();
        toast('Сервер на связи — данные обновятся автоматически', { icon: 'check' });
      }
    }
    if (event === 'likes') {
      syncPlayer(player.getState());
      const count = document.getElementById('nav-lib-count');
      if (count) count.textContent = app.likes.length ? String(app.likes.length) : '';
    }
    if (event === 'search-query') {
      const input = document.getElementById('global-search');
      if (input && document.activeElement !== input) input.value = app.search.query;
    }
    if (event === 'queue-ui') syncQueueUi();
    if (event === 'route') syncRouteUi();
  });

  themeSubscribe(() => {
    syncQuickTheme();
    syncPlayer(player.getState());
  });

  const likesCount = document.getElementById('nav-lib-count');
  if (likesCount) likesCount.textContent = app.likes.length ? String(app.likes.length) : '';
  syncRouteUi();
}

export default { initShell, openModal, closeModal };
