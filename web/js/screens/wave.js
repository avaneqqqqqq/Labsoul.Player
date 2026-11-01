/* =========================================================================
   labsoul — экран «Волна»: станция, полка обложек и бесконечная лента.
   ========================================================================= */

import { bindTrackActions } from '../actions.js';
import { isDemo } from '../api.js';
import { player } from '../audio.js';
import {
  coverCardHtml,
  coverImg,
  emptyState,
  eqBars,
  icon,
  rowHtml,
  skeletonRows,
  trackStyle,
} from '../components.js';
import {
  app,
  loadWaveMore,
  loadWaveStations,
  resetWave,
  setWaveCategory,
  setWaveStation,
  subscribe as storeSubscribe,
  toggleWaveSource,
} from '../store.js';
import { theme } from '../theme.js';
import { toast } from '../toast.js';
import { artistsLine, esc, plural, pluralTracks } from '../utils.js';

const screen = {
  root: null,
  observer: null,
  unsubs: [],
  autoFills: 0,
  aheadAt: 0,
};

function currentState() {
  return player.getState();
}

function likedSet() {
  return new Set(app.likes.map((track) => track.id));
}

function focusTrack() {
  const st = currentState();
  return st.current || app.wave.items[0] || null;
}

const WAVE_SOURCE_META = [
  { key: 'yandex', label: 'Яндекс.Музыка' },
  { key: 'soundcloud', label: 'SoundCloud' },
  { key: 'spotify', label: 'Spotify' },
];

/**
 * Выбор источников волны. Яндекс даёт настоящую «Мою волну», SoundCloud —
 * локальные рекомендации, Spotify — каталог для матчинга (там нет звука).
 */
function sourcesHtml() {
  const active = new Set(app.wave.sources || []);
  const status = app.status?.sources || {};
  const chips = WAVE_SOURCE_META.map(({ key, label }) => {
    const on = active.has(key);
    const ready = Boolean(status[key]?.connected);
    const hint = ready ? 'Подключено' : 'Не подключено — откройте «Подключения»';
    return `<button class="wsrc${on ? ' is-on' : ''}${ready ? '' : ' is-off'}" type="button"
        data-wave-source="${key}" aria-pressed="${on}" title="${hint}">
        <i aria-hidden="true"></i>${esc(label)}${ready ? '' : '<u aria-hidden="true"></u>'}
      </button>`;
  }).join('');

  return `
    <div class="wave-sources" role="group" aria-label="Из каких сервисов собирать волну">
      <span class="wave-sources__label">собирать из</span>
      ${chips}
    </div>`;
}

/** Категории станций и сами станции: жанры, настроения, занятия. */
function stationsHtml() {
  const categories = app.wave.stations || [];
  if (!categories.length) return '';

  const active = categories.find((c) => c.type === app.wave.category) || categories[0];
  const catChips = categories
    .map(
      (c) => `<button class="wcat${c.type === active.type ? ' is-on' : ''}" type="button"
        data-wave-cat="${esc(c.type)}" aria-pressed="${c.type === active.type}">${esc(c.label)}</button>`,
    )
    .join('');

  const stationChips = (active.stations || [])
    .map((station) => {
      const on = station.id === app.wave.station;
      return `<button class="wsrc${on ? ' is-on' : ''}" type="button" data-wave-station="${esc(station.id)}"
        aria-pressed="${on}" title="${esc(station.name)}"><i aria-hidden="true"></i>${esc(station.name)}</button>`;
    })
    .join('');

  return `<div class="wave-stations">
    <div class="wave-stations__row">
      <span class="wave-sources__label">категория</span>${catChips}
    </div>
    <div class="wave-stations__row">
      <span class="wave-sources__label">станция</span>${stationChips}
    </div>
  </div>`;
}

function heroHtml() {
  const st = currentState();
  const focus = focusTrack();
  const items = app.wave.items;
  const played = st.playing && !!st.current;
  const bars = Array.from({ length: 40 }, (_, i) => {
    const h = Math.min(100, Math.round(16 + 62 * Math.abs(Math.sin(i * 0.62)) + ((i * 17) % 16)));
    return `<i style="height:${h}%;animation-delay:${-i * 48}ms"></i>`;
  }).join('');

  return `
    <section class="wave-hero">
      <svg class="wave-hero__mark" viewBox="0 0 24 24" aria-hidden="true"><use href="#i-wave"></use></svg>
      <div class="wave-hero__art" style="${focus ? trackStyle(focus) : ''}">
        ${focus ? coverImg(focus, { eager: true }) : ''}
        <span class="wave-hero__vinyl-spin"></span>
      </div>
      <div class="wave-hero__info">
        <div class="wave-hero__top">
          <span class="wave-hero__live"><i></i>станция в эфире</span>
          <span class="badge badge--demo">Волна</span>
        </div>
        <h2>Моя волна</h2>
        <p class="wave-hero__desc">Бесконечный поток из трёх сервисов. Лайк — чаще, пропуск — реже: лента подстраивается под ваш вкус.</p>
        <div class="wave-hero__now">
          ${played ? eqBars('pl-eq') : ''}
          ${focus
            ? `<b>${esc(focus.title)}</b><span>— ${esc(artistsLine(focus))}</span>`
            : '<span>Волна готова — нажмите «Слушать»</span>'}
        </div>
        <div class="wave-bars" aria-hidden="true">${bars}</div>
        <div class="wave-hero__actions">
          <button class="btn btn--accent" type="button" data-wave="toggle">
            ${icon(st.playing ? 'pause' : 'play')} ${st.playing ? 'Пауза' : 'Слушать'}
          </button>
          <button class="btn btn--ghost" type="button" data-wave="queueall">
            ${icon('plus')} В очередь
          </button>
          <button class="btn btn--ghost" type="button" data-wave="refresh">
            ${icon('refresh')} Обновить
          </button>
        </div>
        ${sourcesHtml()}
        ${stationsHtml()}
      </div>
    </section>`;
}

function shelfHtml() {
  const items = app.wave.items;
  if (!items.length) return '';
  const picked = [];
  const seen = new Set();
  for (const track of items) {
    if (seen.has(track.id)) continue;
    seen.add(track.id);
    picked.push(track);
    if (picked.length >= 6) break;
  }
  return `
    <section class="section cover-shelf-section">
      <div class="section__head">
        <h2>Обложки потока</h2>
        <span class="sub">свежие обложки из ленты</span>
        <button class="more" type="button" data-wave="to-feed">Вся лента ${icon('chev-down')}</button>
      </div>
      <div class="grid grid--covers cover-shelf">
        ${picked.map(coverCardHtml).join('')}
      </div>
    </section>`;
}

function feedEmpty(error) {
  if (error) {
    return `<div class="failure">
      ${icon('alert')}
      <div><b>Волна не отвечает.</b> ${esc(error)}<br>
      Проверьте, что сервер запущен, и попробуйте ещё раз.
      <button class="btn btn--ghost btn--sm" type="button" data-wave="refresh" style="margin-top:8px">${icon('refresh')} Повторить</button></div>
    </div>`;
  }
  return emptyState({
    iconName: 'wave',
    title: 'Волна пока пуста',
    text: 'Сервер не вернул треки. Обновите поток или подключите источники.',
    actions: `<button class="btn btn--accent btn--sm" type="button" data-wave="refresh">${icon('refresh')} Обновить поток</button>`,
  });
}

function feedHtml() {
  const items = app.wave.items;
  const st = currentState();
  const liked = likedSet();
  const currentId = st.current?.id;
  const sub = items.length
    ? `${pluralTracks(items.length)} · ${new Set(items.map((t) => t.source)).size} ${plural(new Set(items.map((t) => t.source)).size, ['источник', 'источника', 'источников'])}`
    : 'поток собирается';

  const body = items.length
    ? `<div class="rows">${items
      .map((track, i) => rowHtml(track, {
        index: i + 1,
        current: track.id === currentId,
        likedIds: liked,
        mode: 'wave',
      }))
      .join('')}</div>`
    : (app.wave.loading ? skeletonRows(7) : feedEmpty(app.wave.error));

  return `
    <section class="section wave-feed" id="wave-feed">
      <div class="section__head">
        <h2>Дальше в потоке</h2>
        <span class="sub">${esc(sub)}</span>
        <button class="more" type="button" data-wave="refresh">${icon('refresh')} Обновить</button>
      </div>
      ${app.wave.error && items.length ? `<div class="failure">${icon('alert')}<div><b>Часть потока не загрузилась.</b> ${esc(app.wave.error)}</div></div>` : ''}
      ${body}
    </section>`;
}

function blocksHtml() {
  const order = Array.isArray(theme.blockOrder) && theme.blockOrder.length
    ? theme.blockOrder
    : ['hero', 'shelf', 'feed'];
  return order.map((id) => {
    if (!theme.blocks[id]) return '';
    if (id === 'hero') return `<div id="wave-hero">${heroHtml()}</div>`;
    if (id === 'shelf') return `<div id="wave-shelf">${shelfHtml()}</div>`;
    if (id === 'feed') return `<div id="wave-feed-wrap">${feedHtml()}</div>`;
    return '';
  }).join('');
}

function sentinelHtml() {
  const { loading, done, error, items } = app.wave;
  if (done) return `<span>Это пока вся волна</span>`;
  if (loading) return `<span class="spinner" role="status" aria-label="Загрузка"></span><span>Волна подбирает ещё…</span>`;
  if (error && !items.length) return `<span>${esc(error)}</span>`;
  return `<button class="btn btn--ghost btn--sm" type="button" data-wave="more">${icon('chev-down')} Показать ещё</button>
    <span class="wave-load__hint">или просто прокрутите вниз</span>`;
}

let paintQueued = false;

/** Перерисовка в ближайшем кадре: события волны приходят пачками. */
function schedulePaint() {
  if (paintQueued || !screen.root) return;
  paintQueued = true;
  requestAnimationFrame(() => {
    paintQueued = false;
    paint();
  });
}

function paint() {
  if (!screen.root) return;
  const blocks = screen.root.querySelector('#wave-blocks');
  if (blocks) blocks.innerHTML = blocksHtml();
  const sentinel = screen.root.querySelector('#wave-sentinel');
  if (sentinel) {
    sentinel.innerHTML = sentinelHtml();
    sentinel.classList.toggle('is-loading', app.wave.loading);
  }
}

function paintHero() {
  if (!screen.root) return;
  const host = screen.root.querySelector('#wave-hero');
  if (host) host.innerHTML = heroHtml();
}

function syncCurrentRows() {
  if (!screen.root) return;
  const currentId = currentState().current?.id;
  const rows = screen.root.querySelectorAll('.row[data-row-id]');
  for (const row of rows) {
    const isCurrent = row.dataset.rowId === currentId;
    row.classList.toggle('is-current', isCurrent);
    const num = row.querySelector('.row__num');
    if (!num) continue;
    if (isCurrent) {
      num.innerHTML = eqBars('row-eq');
    } else {
      const index = Number(row.dataset.rowIndex) || 0;
      num.textContent = index ? String(index).padStart(2, '0') : '';
    }
  }
}

/** Волна играет: держим впереди минимум 5 треков, догружая в фоне. */
/**
 * Очередь волны пополняется из ленты: держим впереди не меньше 12 треков,
 * чтобы воспроизведение не упиралось в первую партию из 5–20.
 */
function extendQueue() {
  const snap = player.getState();
  if (snap.context?.type !== 'wave') return;
  if (!snap.queue.length) return;

  const total = snap.queue.length;
  const index = Number.isFinite(snap.index) ? snap.index : 0;
  if (total - index - 1 >= 12) return;

  const inQueue = new Set(snap.queue.map((track) => track.id));
  const fresh = app.wave.items.filter((track) => track && !inQueue.has(track.id));
  if (fresh.length) player.enqueue(fresh);

  // в ленте тоже пусто — просим следующую партию
  if (fresh.length < 12 && !app.wave.loading) loadWaveMore();
}

/** Прогрев ближайших треков: к переходу звук уже готов, паузы нет. */
function warmNext(count = 2) {
  const snap = player.getState();
  if (snap.context?.type !== 'wave') return;
  if (!Array.isArray(snap.queue) || !snap.queue.length) return;
  const index = Number.isFinite(snap.index) ? snap.index : 0;
  for (let step = 1; step <= count; step += 1) {
    const upcoming = snap.queue[index + step];
    if (upcoming && upcoming.playable !== false) player.preloadTrack(upcoming);
  }
}

function ensureAhead() {
  if (!screen.root) return;
  const snap = player.getState();
  if (snap.context?.type !== 'wave') return;

  // прогреваем следующие два трека — переключение становится мгновенным
  warmNext(2);

  const total = Array.isArray(snap.queue) ? snap.queue.length : 0;
  const index = Number.isFinite(snap.index) ? snap.index : -1;
  const remaining = total - index - 1;
  if (remaining >= 12) return;
  if (app.wave.loading) return;
  if (Date.now() - (screen.aheadAt || 0) < 4000) return;

  screen.aheadAt = Date.now();
  loadWaveMore({ force: true });
}

function checkFill() {
  if (!screen.root) return;
  if (app.wave.loading || app.wave.done) return;
  if (screen.autoFills > 40) return;
  const content = document.getElementById('content');
  const sentinel = screen.root.querySelector('#wave-sentinel');
  if (!content || !sentinel) return;
  const contentRect = content.getBoundingClientRect();
  const sentinelRect = sentinel.getBoundingClientRect();
  if (sentinelRect.top < contentRect.bottom + 900) {
    screen.autoFills += 1;
    loadWaveMore().then(() => checkFill());
  }
}

function refreshFlow() {
  // кнопка не должна «залипать» из-за фоновой загрузки: сбрасываем ленту и грузим заново
  resetWave();
  screen.autoFills = 0;
  screen.aheadAt = 0;
  paint();
  const reload = () => loadWaveMore({ force: true });
  if (app.wave.loading) {
    setTimeout(reload, 400);
  } else {
    reload();
  }
  toast('Волна обновляется', { icon: 'wave' });
}

function setupObserver() {
  const content = document.getElementById('content');
  const sentinel = screen.root?.querySelector('#wave-sentinel');
  if (!content || !sentinel || typeof IntersectionObserver === 'undefined') return;
  screen.observer = new IntersectionObserver((entries) => {
    if (entries.some((entry) => entry.isIntersecting)) checkFill();
  }, { root: content, rootMargin: '560px 0px', threshold: 0.01 });
  screen.observer.observe(sentinel);
}

let scrollFrame = 0;
function onContentScroll() {
  if (scrollFrame) return;
  scrollFrame = requestAnimationFrame(() => {
    scrollFrame = 0;
    checkFill();
  });
}

function onScreenClick(event) {
  const target = event.target instanceof Element
    ? event.target.closest('[data-wave], [data-wave-source], [data-wave-cat], [data-wave-station]')
    : null;
  if (!target) return;
  event.preventDefault();

  // категория и станция «Моей волны»
  if (target.dataset.waveCat) {
    setWaveCategory(target.dataset.waveCat);
    return;
  }
  if (target.dataset.waveStation) {
    setWaveStation(target.dataset.waveStation);
    return;
  }

  // переключатель источника волны
  if (target.dataset.waveSource) {
    toggleWaveSource(target.dataset.waveSource);
    return;
  }

  const act = target.dataset.wave;

  if (act === 'refresh') { refreshFlow(); return; }
  if (act === 'more') { loadWaveMore().then(() => checkFill()); return; }
  if (act === 'to-feed') {
    screen.root?.querySelector('#wave-feed')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    return;
  }
  if (act === 'toggle') {
    const st = currentState();
    if (st.playing) { player.pause(); return; }
    if (st.current) { player.play(); return; }
    if (app.wave.items.length) {
      player.playTracks(app.wave.items, 0, { context: { type: 'wave', batchId: app.wave.batchId } });
    } else {
      loadWaveMore().then(() => {
        if (app.wave.items.length) {
          player.playTracks(app.wave.items, 0, { context: { type: 'wave', batchId: app.wave.batchId } });
        }
      });
    }
    return;
  }
  if (act === 'queueall') {
    const items = app.wave.items.slice(0, 12);
    if (!items.length) { toast('Лента ещё пуста', { type: 'warn' }); return; }
    const result = player.enqueue(items);
    toast(`В очереди ${items.length} ${plural(items.length, ['трек', 'трека', 'треков'])}`, { icon: 'queue' });
    if (result.started) toast('Поток запущен', { icon: 'play' });
  }
}

export const waveScreen = {
  id: 'wave',
  title: 'Волна',

  render(container) {
    container.innerHTML = `
      <div class="page-head">
        <div class="page-head__main">
          <div class="kicker">персональная станция</div>
          <h1>Волна</h1>
          <p>Лента рекомендаций из Яндекс.Музыки, SoundCloud и Spotify — в одном потоке.</p>
        </div>
      </div>
      <div id="wave-blocks"></div>
      <div class="wave-load" id="wave-sentinel" aria-live="polite"></div>
    `;
  },

  mount(container) {
    screen.root = container;
    screen.autoFills = 0;
    container.addEventListener('click', onScreenClick);
    const unbindTracks = bindTrackActions(container, {
      getList: () => app.wave.items,
      getContext: () => ({ type: 'wave', batchId: app.wave.batchId }),
      feedback: true,
    });

    screen.unsubs.push(unbindTracks);
    screen.unsubs.push(storeSubscribe((_state, event) => {
      if (event === 'wave-stations') {
        paint();
        return;
      }
      if (event === 'wave') {
        schedulePaint();
        checkFill();
        extendQueue();
      }
      if (event === 'likes') {
        paint();
      }
      if (event === 'net') {
        if (isDemo()) {
          if (!app.wave.items.length && !app.wave.loading) {
            resetWave();
            paint();
            loadWaveMore();
          }
        } else if (String(app.wave.batchId || '').startsWith('demo-')) {
          resetWave();
          screen.autoFills = 0;
          paint();
          loadWaveMore();
        }
      }
    }));
    screen.unsubs.push(player.subscribe((_snap, event) => {
      if (event === 'time') return;
      extendQueue();
      ensureAhead();
      paintHero();
      syncCurrentRows();
    }));
    screen.unsubs.push(() => container.removeEventListener('click', onScreenClick));

    paint();
    setupObserver();
    loadWaveStations();
    const content = document.getElementById('content');
    content?.addEventListener('scroll', onContentScroll, { passive: true });
    screen.unsubs.push(() => content?.removeEventListener('scroll', onContentScroll));
    if (!app.wave.items.length && !app.wave.loading) {
      // быстрый старт: сервер отдаёт уже собранную ленту, свежая придёт следом
      loadWaveMore({ quick: true });
    } else {
      checkFill();
    }
    requestAnimationFrame(() => checkFill());
  },

  destroy() {
    if (screen.observer) { screen.observer.disconnect(); screen.observer = null; }
    for (const off of screen.unsubs.splice(0)) {
      try { off(); } catch { /* ignore */ }
    }
    screen.root = null;
    screen.autoFills = 0;
  },};

export default waveScreen;
