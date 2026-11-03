/* =========================================================================
   labsoul — оболочка: шапка, сайдбар, нижний плеер, очередь, модалки, клавиши.
   Экраны живут в js/screens/* и сами рисуют только #content.
   ========================================================================= */

import { getLyrics, getUpdate, getArtist, isDemo, net, ping } from './api.js';
import { bindTrackActions } from './actions.js';
import { player, EQ_HZ, EQ_LABELS, EQ_PRESETS, soundModes, setSoundMode } from './audio.js';
import {
  coverImg,
  icon,
  rowsHtml,
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
  PRESETS,
  applyPreset,
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

function syncVersionChip() {
  const chip = document.getElementById('side-version');
  if (!chip) return;
  // чип занят плашкой обновления — не перетираем
  if (chip.classList.contains('side-foot__chip--update')) return;
  const raw = String(net.version || '').trim();
  if (!raw) return;
  chip.textContent = `v${raw.replace(/^v/i, '')}`;
  chip.title = `Версия labsoul ${raw}`;
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
async function loadUpdate(force = false) {
  if (!force && (updateChecked || isDemo())) return;
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
 *   ?np       — открыть плеер;
 *   ?np&lyrics — ещё и панель текста с демонстрационными строками.
 */
function maybeOpenNowPlayingDemo() {
  try {
    const params = new URLSearchParams(location.search);
    if (!params.has('np')) return;
    setTimeout(() => {
      openNowPlaying();
      if (!params.has('lyrics')) return;

      const state = lyricsState();
      state.open = true;
      state.status = 'ready';
      state.key = 'demo';
      state.provider = 'demo';

      if (params.get('lyrics') === 'plain') {
        // проверка вида «текст без синхронизации»: длинный список с прокруткой
        const demoLines = Array.from({ length: 18 }, (_, i) => `Строка текста номер ${i + 1} — для проверки прокрутки`);
        state.synced = [];
        state.plain = demoLines.join('\n');
        renderLyrics();
        return;
      }

      state.synced = [
        { time: 0, text: 'Тёплое место, но улицы ждут' },
        { time: 6, text: 'отпечатков наших ног' },
        { time: 12, text: 'Звёздная пыль — на сапогах' },
        { time: 18, text: 'Мягкое кресло, клетчатый плед' },
        { time: 24, text: 'Не нажатый вовремя курок' },
        { time: 30, text: 'Солнечный день — в окне' },
        { time: 36, text: 'И мы с тобой наедине' },
      ];
      renderLyrics();
    }, 400);
  } catch { /* не критично */ }
}

/* ------------------------------------------------------------------ */
/* Меню в шапке (аватар)                                               */
/* ------------------------------------------------------------------ */

function toggleAvatarMenu(force) {
  const menu = document.getElementById('avatar-menu');
  const button = document.getElementById('avatar-btn');
  if (!menu || !button) return;
  const next = typeof force === 'boolean' ? force : menu.hidden;
  menu.hidden = !next;
  button.setAttribute('aria-expanded', String(next));

  const version = document.getElementById('avatar-version');
  if (version) version.textContent = net.version ? `v${String(net.version).replace(/^v/i, '')}` : 'v—';
}

function onAvatarMenuClick(event) {
  const item = event.target instanceof Element ? event.target.closest('[data-menu-route], [data-menu-update], [data-menu-about]') : null;
  if (!item) return;
  toggleAvatarMenu(false);

  if (item.dataset.menuRoute) {
    go(item.dataset.menuRoute);
    return;
  }

  if (item.hasAttribute('data-menu-update')) {
    toast('Проверяем обновления…', { icon: 'refresh', duration: 1600 });
    loadUpdate(true);
    return;
  }

  if (item.hasAttribute('data-menu-about')) {
    const version = net.version ? `v${String(net.version).replace(/^v/i, '')}` : 'версия неизвестна';
    toast(`labsoul ${version} · свой плеер`, { icon: 'spark', duration: 3200 });
  }
}

function syncNetUi() {
  modeChip();
  syncVersionChip();
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
        ${track && track.artistId
          ? `<button class="pl-now__a pl-now__a--link" type="button" data-pl="artist" title="Открыть страницу исполнителя">${esc(artistsLine(track))}</button>`
          : `<span class="pl-now__a">${track ? esc(artistsLine(track)) : 'Выберите трек в Волне или поиске'}</span>`}
      </div>
      ${track ? `<button class="row__btn pl-now__like${liked ? ' on' : ''}" type="button" data-pl="like" title="${liked ? 'Убрать из избранного' : 'В избранное'}" aria-label="${liked ? 'Убрать из избранного' : 'В избранное'}">${icon('heart')}</button>` : ''}
      ${track ? `<button class="row__btn pl-now__close" type="button" data-pl="close" title="Закрыть плеер" aria-label="Закрыть плеер">${icon('x')}</button>` : ''}
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
      <span class="pl-eq" data-visualizer title="Играет" aria-hidden="true"><i></i><i></i><i></i><i></i></span>
      ${srcName ? `<span class="pl-src" title="${esc(SOURCE_NAMES[track.source] || '')}">${esc(srcName)}</span>` : ''}
      <button class="pl-btn${theme.eq.on ? ' on' : ''}" type="button" data-pl="eq" title="Эквалайзер" aria-label="Эквалайзер">${icon('eq')}</button>
      <button class="pl-btn" type="button" data-pl="mute" title="Звук" aria-label="Выключить звук">${icon(snap.muted || snap.volume === 0 ? 'volume-mute' : 'volume')}</button>
      <div class="pl-vol">
        <input class="rng" type="range" min="0" max="100" step="1" value="${Math.round((snap.muted ? 0 : snap.volume) * 100)}" aria-label="Громкость">
      </div>
      <button class="pl-btn pl-queue" type="button" data-pl="queue" title="Очередь" aria-label="Очередь">
        ${icon('queue')}<i class="pl-queue__count" data-pl-queue-count>${snap.queue.length}</i>
      </button>
      <button class="pl-btn pl-overlay" type="button" data-pl="overlay" title="Мини-плеер поверх окон" aria-label="Мини-плеер поверх окон">
        ${icon('pip')}
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

/**
 * Отправить текущий трек в Discord и оверлей-плеер.
 *
 * Работает только в настольной версии: в браузере окна playerDesktop нет,
 * поэтому вызовы просто пропускаются.
 */
let presenceTrackId = null;

function syncPresence(snap) {
  const bridge = window.playerDesktop;
  if (!bridge) return;

  const track = snap?.current;
  if (!track) {
    try { bridge.discordActivity(null); } catch { /* ignore */ }
    return;
  }

  // не спамим Discord: обновляем при смене трека или паузе, не каждый тик
  const key = `${track.id}:${snap.playing ? 'play' : 'pause'}`;
  if (key === presenceTrackId) return;
  presenceTrackId = key;

  const payload = {
    title: track.title || '',
    artist: (track.artists || []).join(', '),
    cover: track.cover || null,
    startedAt: snap.playing ? Date.now() - (Number(snap.time) || 0) * 1000 : null,
  };

  try {
    if (snap.playing) bridge.discordActivity(payload);
    else bridge.discordActivity(null);
  } catch { /* Discord не запущен — не мешаем музыке */ }

  try {
    bridge.sendOverlayState({
      ...payload,
      playing: Boolean(snap.playing),
      time: Number(snap.time) || 0,
      duration: Number(snap.duration) || 0,
    });
  } catch { /* оверлей закрыт */ }
}

function onPlayerEvent(snap, event) {
  if (event === 'time') {
    syncPlayer(snap);
    return;
  }
  // Discord Rich Presence и оверлей: обновляем при смене трека и паузе
  if (event === 'track' || event === 'init' || event === 'state') {
    syncPresence(snap);
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
    case 'artist': openArtistPage(); break;
    case 'close': {
      player.closeTrack();
      toast('Плеер закрыт', { icon: 'x', duration: 1600 });
      break;
    }
    case 'like': {
      const track = player.currentTrack();
      if (!track) break;
      const liked = toggleLike(track);
      toast(liked ? `В избранном: ${track.title}` : 'Убрано из избранного', { icon: 'heart' });
      break;
    }
    case 'queue': toggleQueue(); break;
    case 'overlay': {
      // мини-плеер поверх всех окон (только в настольной версии)
      const bridge = window.playerDesktop;
      if (bridge?.toggleOverlay) {
        bridge.toggleOverlay().then((open) => {
          toast(open ? 'Мини-плеер открыт поверх окон' : 'Мини-плеер скрыт', { icon: 'check' });
        }).catch(() => {});
      } else {
        toast('Мини-плеер доступен только в настольном приложении', { type: 'warn' });
      }
      break;
    }
    case 'eq': toggleEqPopover(target); break;
    default: break;
  }
}

/* --------------------- мини-окно эквалайзера ---------------------- */

let eqPopover = null;

/**
 * Открыть/закрыть эквалайзер всплывающим окном над мини-плеером.
 *
 * Раньше кнопка уводила на экран «Оформление» и прокручивала к блоку
 * эквалайзера — приходилось возвращаться назад к музыке. Теперь настройка
 * открывается рядом с плеером, не меняя экран.
 */
function toggleEqPopover(button) {
  if (eqPopover) { closeEqPopover(); return; }

  const chip = button.closest('.pl-right') || button;
  const rect = chip.getBoundingClientRect();

  const pop = document.createElement('div');
  pop.className = 'eq-pop';
  pop.innerHTML = `
    <div class="eq-pop__head">
      <b>Эквалайзер</b>
      <button class="eq-pop__close" type="button" aria-label="Закрыть">✕</button>
    </div>
    <label class="switch-row">
      <input type="checkbox" id="eq-pop-on" ${theme.eq.on ? 'checked' : ''}>
      <span>Включить</span>
    </label>
    <div class="eq-pop__section">Пресеты</div>
    <div class="eq-pop__presets" data-eq-presets></div>
    <div class="eq-pop__gains" data-eq-gains></div>
    <div class="eq-pop__section">Режимы звука</div>
    <div class="eq-pop__presets" data-eq-modes></div>
    <div class="eq-pop__section">Тонкая настройка</div>
    <div class="eq-pop__lab" data-eq-lab></div>
    <label class="switch-row">
      <input type="checkbox" id="eq-pop-normalize" ${theme.normalize ? 'checked' : ''}>
      <span>Выравнивать громкость</span>
    </label>
    <p class="eq-pop__hint">Настройка сохраняется и не сбрасывается при обновлении.</p>
  `;
  document.body.appendChild(pop);

  // ставим окно над кнопкой
  // окно шире эквалайзера: 10 ползунков должны помещаться целиком
  const left = Math.max(12, Math.min(window.innerWidth - 532, rect.right - 520));
  pop.style.left = `${left}px`;
  pop.style.bottom = `${window.innerHeight - rect.top + 12}px`;

  buildEqControls(pop);
  eqPopover = pop;

  const onDocClick = (event) => {
    if (!pop.contains(event.target) && event.target !== button) closeEqPopover();
  };
  // закрываем по клику мимо; подписку снимаем при закрытии
  setTimeout(() => document.addEventListener('mousedown', onDocClick), 0);
  pop.addEventListener('click', (event) => {
    if (event.target.closest('.eq-pop__close')) closeEqPopover();
  });
  pop._onDocClick = onDocClick;

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeEqPopover();
  });
}

function closeEqPopover() {
  if (!eqPopover) return;
  if (eqPopover._onDocClick) document.removeEventListener('mousedown', eqPopover._onDocClick);
  eqPopover.remove();
  eqPopover = null;
}

/** Заполнить окно ползунками и пресетами. */
function buildEqControls(pop) {
  const presetsBox = pop.querySelector('[data-eq-presets]');
  const gainsBox = pop.querySelector('[data-eq-gains]');
  if (!presetsBox || !gainsBox) return;

  // пресеты берём из плеера: это те же профили, что в «Оформлении»
  presetsBox.innerHTML = Object.entries(EQ_PRESETS).map(([id, preset]) => (
    `<button class="eq-pop__preset${theme.eq.preset === id ? ' on' : ''}" type="button" data-preset="${id}">${preset.name}</button>`
  )).join('');

  // ползунки по полосам: EQ_HZ — реальные частоты, bands — усиление в дБ
  gainsBox.innerHTML = EQ_HZ.map((freq, index) => {
    const value = Number(theme.eq.bands?.[index]) || 0;
    return `<label class="eq-pop__band">
      <span>${EQ_LABELS[index]}</span>
      <input class="rng rng--vert" type="range" min="-12" max="12" step="1"
        value="${value}" data-band="${index}" aria-label="${freq} Гц">
      <b>${value > 0 ? '+' : ''}${value}</b>
    </label>`;
  }).join('');

  presetsBox.addEventListener('click', (event) => {
    const btn = event.target.closest('[data-preset]');
    if (!btn) return;
    const preset = EQ_PRESETS[btn.dataset.preset];
    if (!preset) return;
    update('eq.bands', [...preset.bands], { save: true, apply: true });
    update('eq.preset', btn.dataset.preset, { save: true, apply: false });
    for (const item of presetsBox.querySelectorAll('.eq-pop__preset')) {
      item.classList.toggle('on', item === btn);
    }
    refreshEqBands(pop);
  });

  gainsBox.addEventListener('input', (event) => {
    const input = event.target.closest('[data-band]');
    if (!input) return;
    const index = Number(input.dataset.band);
    const value = Number(input.value);
    const label = input.parentElement?.querySelector('b');
    if (label) label.textContent = `${value > 0 ? '+' : ''}${value}`;
    const bands = Array.isArray(theme.eq.bands) ? [...theme.eq.bands] : new Array(EQ_HZ.length).fill(0);
    bands[index] = value;
    update('eq.bands', bands, { save: true, apply: true });
    // своя настройка: ни один пресет больше не подходит
    update('eq.preset', 'custom', { save: true, apply: false });
    for (const item of presetsBox.querySelectorAll('.eq-pop__preset')) item.classList.remove('on');
  });

  pop.querySelector('#eq-pop-on')?.addEventListener('change', (event) => {
    update('eq.on', event.target.checked, { save: true, apply: true });
    const chip = document.querySelector('[data-pl="eq"]');
    if (chip) chip.classList.toggle('on', event.target.checked);
  });

  // ---- режимы звука (Spide: Studio / Lo-Fi / Nightcore / Slowed / Vaporwave)
  const modesBox = pop.querySelector('[data-eq-modes]');
  if (modesBox) {
    modesBox.innerHTML = soundModes().map((mode) => (
      `<button class="eq-pop__preset${theme.soundMode === mode.id ? ' on' : ''}" type="button" data-mode="${mode.id}">${mode.label}</button>`
    )).join('');

    modesBox.addEventListener('click', (event) => {
      const btn = event.target.closest('[data-mode]');
      if (!btn) return;
      setSoundMode(btn.dataset.mode);
      update('soundMode', btn.dataset.mode, { save: true, apply: true });
      for (const item of modesBox.querySelectorAll('.eq-pop__preset')) {
        item.classList.toggle('on', item === btn);
      }
      refreshEqBands(pop);
      refreshLab(pop);
    });
  }

  // ---- Audio Lab: бас, теплота, глубина, ширина, скорость
  const labBox = pop.querySelector('[data-eq-lab]');
  if (labBox) {
    const labControls = [
      { key: 'bass', label: 'Бас', min: 0, max: 12, unit: ' дБ' },
      { key: 'depth', label: 'Глубина', min: 0, max: 12, unit: ' дБ' },
      { key: 'warmth', label: 'Теплота', min: 0, max: 6, unit: '' },
      { key: 'width', label: 'Стерео', min: 0, max: 200, unit: '%' },
      { key: 'reverb', label: 'Реверб', min: 0, max: 100, unit: '%' },
      { key: 'speed', label: 'Скорость', min: 50, max: 150, unit: '%' },
    ];
    labBox.innerHTML = labControls.map((ctl) => {
      const value = Number(theme.lab?.[ctl.key] ?? 0);
      return `<label class="eq-pop__lab-row">
        <span>${ctl.label}</span>
        <input class="rng" type="range" min="${ctl.min}" max="${ctl.max}" step="1"
          value="${value}" data-lab="${ctl.key}" aria-label="${ctl.label}">
        <b>${value}${ctl.unit}</b>
      </label>`;
    }).join('');

    labBox.addEventListener('input', (event) => {
      const input = event.target.closest('[data-lab]');
      if (!input) return;
      const key = input.dataset.lab;
      const value = Number(input.value);
      const ctl = labControls.find((item) => item.key === key);
      const label = input.parentElement?.querySelector('b');
      if (label) label.textContent = `${value}${ctl?.unit || ''}`;
      update(`lab.${key}`, value, { save: true, apply: true });
    });
  }

  // ---- нормализация громкости
  pop.querySelector('#eq-pop-normalize')?.addEventListener('change', (event) => {
    update('normalize', event.target.checked, { save: true, apply: true });
  });
}

/** Обновить подписи ползунков Audio Lab после смены режима. */
function refreshLab(pop) {
  for (const input of pop.querySelectorAll('[data-lab]')) {
    const key = input.dataset.lab;
    const value = Number(theme.lab?.[key] ?? 0);
    input.value = String(value);
    const unit = { bass: ' дБ', depth: ' дБ', width: '%', reverb: '%', speed: '%' }[key] || '';
    const label = input.parentElement?.querySelector('b');
    if (label) label.textContent = `${value}${unit}`;
  }
}

/** Перерисовать ползунки после выбора пресета. */
function refreshEqBands(pop) {
  for (const input of pop.querySelectorAll('[data-band]')) {
    const value = Number(theme.eq.bands?.[Number(input.dataset.band)]) || 0;
    input.value = String(value);
    const label = input.parentElement?.querySelector('b');
    if (label) label.textContent = `${value > 0 ? '+' : ''}${value}`;
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

const nowPlaying = { el: null, unsub: null, onKey: null, lyrics: null };

/* ------------------------------------------------------------------ */
/* Текст песни в полноэкранном плеере                                   */
/* ------------------------------------------------------------------ */

/**
 * Разметка строки текста.
 *
 * Если пришли послоговые тайминги (провайдер lrcmux), каждое слово
 * оборачиваем в отдельный span с временем начала/конца — тогда подсветка
 * идёт по слову, как в караоке, а не по всей строке сразу.
 */
function lyricWordsHtml(line) {
  const words = Array.isArray(line?.words) ? line.words : null;
  if (!words || words.length < 2) return esc(line?.text ?? '');

  return words
    .map((word) => {
      const start = Number(word.start);
      const end = Number(word.end);
      const startAttr = Number.isFinite(start) ? start : '';
      const endAttr = Number.isFinite(end) ? end : '';
      return `<span class="np__lyric-word" data-word-start="${startAttr}" data-word-end="${endAttr}">${esc(word.text)}</span>`;
    })
    .join('');
}

function lyricsState() {
  if (!nowPlaying.lyrics) {
    nowPlaying.lyrics = { key: null, status: 'idle', synced: [], plain: '', provider: null, instrumental: false, open: false, index: -1 };
  }
  return nowPlaying.lyrics;
}

const lyricsKeyOf = (track) => (track ? `${track.source}:${track.sourceId}` : null);

function renderLyrics() {
  const el = nowPlaying.el;
  if (!el) return;
  const box = el.querySelector('[data-np-lyrics]');
  const trackBox = el.querySelector('[data-np-lyrics-track]');
  const scrollBox = el.querySelector('[data-np-lyrics-scroll]');
  if (!box || !trackBox) return;

  const state = lyricsState();
  box.hidden = !state.open;
  el.classList.toggle('is-lyrics', state.open);

  const toggle = el.querySelector('[data-np="lyrics"]');
  if (toggle) {
    toggle.classList.toggle('is-on', state.open);
    toggle.setAttribute('aria-pressed', String(state.open));
  }

  const badge = el.querySelector('[data-np-lyrics-badge]');
  if (badge) {
    const source = state.provider === 'lrclib' ? 'lrclib' : state.provider === 'netease' ? 'netease' : '';
    badge.textContent = state.status === 'ready' ? source : '';
  }

  if (!state.open) return;

  // служебные пометки («纯音乐，请欣赏» и подобное) не показываем никогда
  const isPlaceholder = (value) => /(纯音乐|此歌曲为没有填词的纯音乐|没有填词|instrumental|no lyrics)/i.test(String(value || ''));
  const notable = (lines) => (lines || []).filter((line) => !isPlaceholder(typeof line === 'string' ? line : line.text));

  if (state.status === 'loading') {
    trackBox.innerHTML = '<div class="np__lyrics-note">Ищем текст…</div>';
    return;
  }

  if (state.status === 'ready' && state.synced.length) {
    const lines = notable(state.synced);
    if (!lines.length) {
      scrollBox?.classList.remove('is-plain');
      trackBox.innerHTML = '<div class="np__lyrics-note">Инструментальная композиция</div>';
      return;
    }
    scrollBox?.classList.remove('is-plain');
    trackBox.style.transform = '';
    trackBox.innerHTML = state.synced
      .map((line, index) => ({ line, index }))
      .filter(({ line }) => !isPlaceholder(line.text))
      .map(({ line, index }) => `<div class="np__lyric" data-lyric="${index}" data-lyric-time="${line.time}" title="Перейти к строке">
        <span class="np__lyric-text">${lyricWordsHtml(line)}</span>
        <button class="np__lyric-share" type="button" data-np-share="${index}" title="Поделиться строкой" aria-label="Поделиться строкой">${icon('external')}</button>
      </div>`)
      .join('');
    state.index = -1;
    state.hasWords = state.synced.some((line) => line.words?.length > 1);
    syncLyrics(player.getState().time, true);
    return;
  }

  if (state.status === 'ready' && state.plain) {
    const lines = notable(state.plain.split('\n').map((line) => line.trim()).filter(Boolean)).filter(Boolean);
    state.plainLines = lines;
    if (!lines.length) {
      scrollBox?.classList.remove('is-plain');
      trackBox.style.transform = '';
      trackBox.innerHTML = '<div class="np__lyrics-note">Инструментальная композиция</div>';
      return;
    }
    // текст без таймингов — обычная прокрутка, как в Яндекс.Музыке
    scrollBox?.classList.add('is-plain');
    trackBox.style.transform = '';
    if (scrollBox) scrollBox.scrollTop = 0;
    trackBox.innerHTML = `<div class="np__lyrics-note np__lyrics-note--small">без синхронизации · можно листать</div>
      ${lines.map((line, index) => `<div class="np__lyric np__lyric--plain" data-plain-line="${index}">
        <span class="np__lyric-text">${esc(line)}</span>
        <button class="np__lyric-share" type="button" data-np-share-plain="${index}" title="Поделиться строкой" aria-label="Поделиться строкой">${icon('external')}</button>
      </div>`).join('')}`;
    return;
  }

  trackBox.innerHTML = `<div class="np__lyrics-note">${state.instrumental ? 'Инструментальная композиция' : 'Текст не найден'}</div>`;
}

/** Подсвечивает текущую строку и плавно подводит её к центру. */
/**
 * Караоке-подсветка: слово получает класс, когда до него дошло время.
 *
 * Классы ставятся только при изменении состояния — иначе на каждом
 * тике браузер пересчитывал бы стили у десятков элементов.
 */
function highlightWords(trackBox, synced, at) {
  const activeLine = synced.find((line, i) => {
    const next = synced[i + 1];
    return line.time <= at && (!next || next.time > at);
  });
  if (!activeLine?.words?.length) return;

  const node = [...trackBox.children].find(
    (child) => child instanceof HTMLElement && Number(child.dataset.lyricTime) === Number(activeLine.time),
  );
  if (!node) return;

  for (const word of node.querySelectorAll('.np__lyric-word')) {
    const start = Number(word.dataset.wordStart);
    const end = Number(word.dataset.wordEnd);
    const started = Number.isFinite(start) && at >= start;
    const passed = Number.isFinite(end) && at >= end;
    word.classList.toggle('is-sung', passed);
    word.classList.toggle('is-singing', started && !passed);
  }
}

function syncLyrics(time, force = false) {
  const state = lyricsState();
  if (!state.open || state.status !== 'ready' || !state.synced.length) return;

  const el = nowPlaying.el;
  if (!el) return;
  const trackBox = el.querySelector('[data-np-lyrics-track]');
  const scroll = el.querySelector('[data-np-lyrics-scroll]');
  if (!trackBox || !scroll) return;

  const at = Number(time) || 0;
  let index = -1;
  for (let i = 0; i < state.synced.length; i += 1) {
    if (state.synced[i].time <= at + 0.25) index = i;
    else break;
  }

  // Послоговая подсветка идёт внутри строки, поэтому её надо обновлять
  // на каждом тике, а не только при смене строки.
  if (state.hasWords) highlightWords(trackBox, state.synced, at);

  if (!force && index === state.index) return;
  state.index = index;

  // строки могли быть отфильтрованы — ориентируемся на data-lyric, а не на порядок
  const nodes = Array.from(trackBox.children).filter((node) => node instanceof HTMLElement && node.hasAttribute('data-lyric'));
  let active = null;
  for (const node of nodes) {
    const lineIndex = Number(node.dataset.lyric);
    node.classList.toggle('is-active', lineIndex === index);
    node.classList.toggle('is-past', lineIndex < index);
    if (lineIndex === index) active = node;
  }

  if (active) {
    const offset = active.offsetTop + active.offsetHeight / 2 - scroll.clientHeight / 2;
    trackBox.style.transform = `translateY(${-Math.max(0, offset)}px)`;
  }
}

async function loadLyrics(track) {
  const state = lyricsState();
  const key = lyricsKeyOf(track);

  if (!track) {
    state.key = null;
    state.status = 'none';
    state.synced = [];
    state.plain = '';
    renderLyrics();
    return;
  }

  if (state.key === key && (state.status === 'ready' || state.status === 'none')) {
    renderLyrics();
    return;
  }

  state.key = key;
  state.status = 'loading';
  state.synced = [];
  state.plain = '';
  state.instrumental = false;
  renderLyrics();

  try {
    const data = await getLyrics(track.source, track.sourceId);
    if (state.key !== key) return; // трек успел смениться

    if (data?.available && Array.isArray(data.synced) && data.synced.length) {
      state.status = 'ready';
      state.synced = data.synced;
      state.plain = data.plain || '';
      state.provider = data.provider || null;
    } else if (data?.available && data.plain) {
      state.status = 'ready';
      state.synced = [];
      state.plain = data.plain;
      state.provider = data.provider || null;
    } else {
      state.status = 'none';
      state.instrumental = Boolean(data?.instrumental);
    }
  } catch {
    if (state.key === key) state.status = 'none';
  }

  renderLyrics();
}

function toggleLyrics() {
  const state = lyricsState();
  state.open = !state.open;
  if (state.open) {
    loadLyrics(player.getState().current);
    return;
  }
  renderLyrics();
}

/** Клик по строке — перемотка на её время. */
function seekToLyric(index) {
  const state = lyricsState();
  const line = state.synced[index];
  if (!line) return;
  player.seek(Math.max(0, line.time + 0.05));
  syncLyrics(line.time + 0.05, true);
}

async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch { /* нет разрешения — пробуем старый способ */ }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  } catch {
    return false;
  }
}

/** «Поделиться строкой»: копируем строку с треком в буфер. */
async function shareLyric(index, plain = false) {
  const state = lyricsState();
  const track = player.getState().current;
  const line = plain ? state.plainLines?.[index] : state.synced[index];
  const text = typeof line === 'string' ? line : line?.text;
  if (!text) return;

  const meta = track ? `${artistsLine(track)} — ${track.title}` : '';
  const payload = meta ? `«${text}»\n${meta} · labsoul` : `«${text}» · labsoul`;
  const copied = await copyToClipboard(payload);
  toast(copied ? 'Строка скопирована' : 'Не удалось скопировать строку', {
    type: copied ? 'ok' : 'err',
    icon: copied ? 'check' : 'alert',
  });
}

function npTemplate() {
  return `
    <div class="np__bg" data-np-bg></div>
    <div class="np__inner">
      <button class="np__close" type="button" data-np="close" title="Закрыть (Esc)" aria-label="Закрыть">${icon('x')}</button>
      <div class="np__left">
        <div class="np__art" data-np-art></div>
      </div>
      <div class="np__side">
        <span class="np__eyebrow" data-np-eyebrow>Сейчас играет</span>
        <span class="np__src" data-np-src></span>
        <h2 class="np__title" data-np-title>Ничего не играет</h2>
        <div class="np__artist" data-np-artist></div>        <div class="np__album" data-np-album></div>
        <div class="np__context" data-np-context></div>
        <div class="np__extra">
          <button class="np__chip" type="button" data-np="like">${icon('heart')}<span>В избранное</span></button>
          <button class="np__chip" type="button" data-np="queue">${icon('queue')}<span>Очередь</span></button>
          <button class="np__chip np__chip--lyrics" type="button" data-np="lyrics" aria-pressed="false">${icon('type')}<span>Текст</span></button>
        </div>
      </div>
      <div class="np__transport">
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

          <div class="np__vol" title="Громкость">
            <button class="pl-btn" type="button" data-np="vol-mute" aria-label="Выключить звук">${icon('volume')}</button>
            <input class="rng np__vol-range" type="range" min="0" max="100" step="1"
              value="${Math.round((player.getState().muted ? 0 : player.getState().volume) * 100)}"
              aria-label="Громкость">
          </div>
        </div>
      </div>
      <div class="np__lyrics" data-np-lyrics hidden>
        <div class="np__lyrics-head">
          <span class="np__lyrics-title">текст песни</span>
          <span class="np__lyrics-badge" data-np-lyrics-badge></span>
        </div>
        <div class="np__lyrics-scroll" data-np-lyrics-scroll>
          <div class="np__lyrics-rail" aria-hidden="true"></div>
          <div class="np__lyrics-track" data-np-lyrics-track></div>
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
    setText('[data-np-context]', '');
    setText('[data-np-eyebrow]', 'Плеер');
    const bg = el.querySelector('[data-np-bg]');
    if (bg) bg.style.backgroundImage = 'none';
    return;
  }

  setText('[data-np-title]', track.title || 'Без названия');

  // Имя исполнителя — кнопка: клик открывает страницу с его треками
  // (работает для источников, у которых есть artistId, сейчас это Яндекс)
  const artistBox = el.querySelector('[data-np-artist]');
  if (artistBox) {
    const name = artistsLine(track);
    if (track.artistId) {
      artistBox.innerHTML = `<button class="np__artist-btn" type="button" data-np="artist" title="Открыть страницу исполнителя">${esc(name)}</button>`;
    } else {
      artistBox.textContent = name;
    }
  }

  setText('[data-np-album]', track.album || '');
  setText('[data-np-src]', SOURCE_NAMES[track.source] || track.source);
  setText('[data-np-eyebrow]', snap.playing ? 'Сейчас играет' : 'Пауза');

  // «играет из» — как в Spotify: откуда запущена очередь
  const contextLabels = { wave: 'Волна', local: 'Своя музыка', queue: 'Очередь', search: 'Поиск', library: 'Библиотека' };
  const routeLabels = { wave: 'Волна', search: 'Поиск', library: 'Библиотека', sources: 'Подключения', design: 'Оформление' };
  const from = contextLabels[snap.context?.type] || routeLabels[app.route] || null;
  setText('[data-np-context]', from ? `Играет из: ${from}` : '');

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

  // текст песни: панель открыта — подгружаем текст для нового трека
  const lyricsPanel = nowPlaying.lyrics;
  if (lyricsPanel?.open && lyricsPanel.key !== lyricsKeyOf(track)) {
    loadLyrics(track);
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
  // каждый раз открываем с закрытой панелью текста
  nowPlaying.lyrics = null;

  syncNowPlaying();

  // настройка «текст сразу»: открываем панель, если включена
  if (theme.lyricsAuto && player.currentTrack()) {
    setTimeout(() => toggleLyrics(), 120);
  }

  el.addEventListener('click', (event) => {
    // строка текста: кнопка «поделиться» или перемотка на её время
    const shareButton = event.target instanceof Element
      ? event.target.closest('[data-np-share], [data-np-share-plain]')
      : null;
    if (shareButton) {
      if (shareButton.dataset.npShare !== undefined && shareButton.dataset.npShare !== '') {
        shareLyric(Number(shareButton.dataset.npShare));
      } else {
        shareLyric(Number(shareButton.dataset.npSharePlain), true);
      }
      return;
    }

    const lyricLine = event.target instanceof Element ? event.target.closest('[data-lyric]') : null;
    if (lyricLine) {
      seekToLyric(Number(lyricLine.dataset.lyric));
      return;
    }

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
    if (action === 'lyrics') { toggleLyrics(); return; }
    if (action === 'vol-mute') { player.toggleMute(); syncNowPlaying(); return; }
    if (action === 'artist') { openArtistPage(); return; }
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
    if (!(target instanceof HTMLInputElement)) return;

    // ползунок громкости в полноэкранном плеере
    if (target.classList.contains('np__vol-range')) {
      player.setVolume(Number(target.value) / 100);
      return;
    }

    if (!target.classList.contains('np__seek')) return;
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
      syncLyrics(snap.time);
      return;
    }
    syncNowPlaying();
  });
}

/**
 * Открыть страницу исполнителя с его треками.
 *
 * Вызывается кликом по имени в полноэкранном плеере. Работает для
 * источников, отдающих artistId (сейчас Яндекс): по одному имени
 * страницу не построить.
 */
async function openArtistPage() {
  const track = player.currentTrack();
  if (!track?.artistId) {
    toast('У этого трека нет страницы исполнителя', { type: 'warn' });
    return;
  }

  // закрываем полноэкранный режим ДО перехода: он тоже меняет экран,
  // и ссылка на #content успела бы устареть
  closeNowPlaying();
  await new Promise((resolve) => setTimeout(resolve, 0));

  go('search');
  // ждём, пока экран поиска отрисуется, и только потом берём актуальный контейнер
  await new Promise((resolve) => requestAnimationFrame(() => resolve()));

  const host = document.getElementById('content');
  if (!host) return;

  host.innerHTML = '<div class="empty" style="margin-top:40px"><b>Загружаем исполнителя…</b></div>';

  try {
    const data = await getArtist(track.source, track.artistId, 50);
    const tracks = Array.isArray(data?.tracks) ? data.tracks : [];

    if (!tracks.length) {
      host.innerHTML = '<div class="empty"><b>Треков не найдено</b></div>';
      return;
    }

    host.innerHTML = `<div class="artist-page">
      <header class="artist-page__head">
        ${data.cover ? `<img class="artist-page__cover" src="${esc(data.cover)}" alt="">` : ''}
        <div>
          <span class="artist-page__label">Исполнитель</span>
          <h1 class="artist-page__name">${esc(data.name || track.artists[0] || '')}</h1>
          <span class="artist-page__count">${tracks.length} треков</span>
        </div>
      </header>
      <div class="artist-page__list"></div>
    </div>`;

    // треки рисуем общим списком и подключаем те же действия, что и везде
    const list = host.querySelector('.artist-page__list');
    if (list) {
      list.innerHTML = rowsHtml(tracks, { index: true });
      bindTrackActions(host, {
        getList: () => tracks,
        getContext: () => ({ type: 'artist', artistId: track.artistId }),
        feedback: false,
      });
    }
  } catch (err) {
    host.innerHTML = `<div class="empty"><b>Не удалось открыть исполнителя</b><span>${esc(err?.message || '')}</span></div>`;
  }
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
  document.querySelectorAll('.stylepick [data-preset-id]').forEach((button) => {
    const preset = PRESETS.find((item) => item.id === button.dataset.presetId);
    const on = Boolean(preset) && theme.variant === preset.variant && theme.scheme === preset.scheme;
    button.classList.toggle('is-on', on);
    button.style.setProperty('--swatch', preset ? preset.swatch : 'transparent');
  });

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

  // Команды из мини-плеера: работают, даже когда окно свёрнуто
  window.playerDesktop?.onMiniCommand?.((action) => {
    if (action === 'toggle') player.toggle();
    else if (action === 'next') player.next();
    else if (action === 'prev') player.prev();
    if (action === 'toggle' || action === 'next' || action === 'prev') {
      syncPresence(player.getState());
    }
  });

  renderSources();
  modeChip();
  syncVersionChip();
  syncBanner();
  syncQuickTheme();
  maybeOpenNowPlayingDemo();
  // версия подтягивается после проверки сервера
  ping().then(() => { modeChip(); syncVersionChip(); }).catch(() => {});

  // меню профиля в шапке
  document.getElementById('avatar-btn')?.addEventListener('click', (event) => {
    event.stopPropagation();
    toggleAvatarMenu();
  });
  document.getElementById('avatar-menu')?.addEventListener('click', onAvatarMenuClick);
  document.addEventListener('click', (event) => {
    const menu = document.getElementById('avatar-menu');
    if (!menu || menu.hidden) return;
    if (event.target instanceof Element && event.target.closest('.avatar-wrap')) return;
    toggleAvatarMenu(false);
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') toggleAvatarMenu(false);
  });

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
    const presetEl = event.target instanceof Element ? event.target.closest('.stylepick [data-preset-id]') : null;
  if (presetEl) {
    applyPreset(presetEl.dataset.presetId);
    renderSources();
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
