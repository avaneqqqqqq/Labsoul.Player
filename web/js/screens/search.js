/* =========================================================================
   labsoul — экран «Поиск»: один запрос по трём каталогам, фильтры источников.
   ========================================================================= */

import { bindTrackActions } from '../actions.js';
import { isDemo, linkLookup } from '../api.js';
import { DEMO_QUERIES } from '../demo.js';
import {
  emptyState,
  icon,
  rowHtml,
  skeletonRows,
  SOURCE_MARKS,
  SOURCE_NAMES,
} from '../components.js';
import {
  app,
  emit,
  runSearch,
  setSearchQuery,
  setSearchSources,
  subscribe as storeSubscribe,
  toggleSearchSource,
} from '../store.js';
import { esc, humanizeError, plural } from '../utils.js';
import { toast } from '../toast.js';

const SUGGESTIONS_ONLINE = ['Кино', 'The Weeknd', 'lo-fi', 'Molchat Doma', 'phonk'];
const screen = { root: null, unsubs: [], timer: 0 };

function suggestions() {
  return isDemo() ? DEMO_QUERIES : SUGGESTIONS_ONLINE;
}

function pageHtml() {
  return `
    <div class="page-head">
      <div class="page-head__main">
        <div class="kicker">три каталога сразу</div>
        <h1>Поиск</h1>
        <p>Один запрос — Яндекс.Музыка, SoundCloud и Spotify. Источники можно отключать по одному.</p>
      </div>
    </div>

    <form class="search-page__bar" id="search-form" role="search">
      <div class="search-page__field">
        ${icon('search')}
        <input id="search-page-input" type="search" name="q" placeholder="Что послушаем? Трек, исполнитель или альбом"
          autocomplete="off" spellcheck="false" aria-label="Поисковый запрос">
        <kbd class="search-page__kbd">Enter</kbd>
      </div>
      <button class="btn btn--accent" type="submit">${icon('search')} Найти</button>
    </form>

    <form class="link-import" id="link-form" autocomplete="off">
      <span class="link-import__label">${icon('external')} или вставьте ссылку</span>
      <input class="link-import__input" id="link-input" type="url" name="url" spellcheck="false"
        placeholder="open.spotify.com/track/… · music.yandex.ru/… · soundcloud.com/…"
        aria-label="Ссылка на трек">
      <button class="btn btn--ghost btn--sm" type="submit">${icon('search')} Найти версию</button>
    </form>

    <div class="filters" id="search-filters"></div>
    <div id="search-results"></div>
  `;
}

function filtersHtml() {
  const counts = {};
  for (const group of app.search.groups) counts[group.source] = group.items.length;
  const allOn = app.search.sources.length === 3;
  return `
    <span class="filters__label">Источники</span>
    <button class="chip${allOn ? ' on' : ''}" type="button" data-search-act="all-sources">Все</button>
    ${['yandex', 'soundcloud', 'spotify'].map((source) => {
      const on = app.search.sources.includes(source);
      return `<button class="chip chip--${source === 'spotify' ? 'sp' : source === 'soundcloud' ? 'sc' : 'ya'}${on ? ' on' : ''}"
        type="button" data-source="${source}" aria-pressed="${on}">
        <i class="dot"></i>${esc(SOURCE_NAMES[source])}
        ${counts[source] ? `<span class="chip__count">${counts[source]}</span>` : ''}
      </button>`;
    }).join('')}`;
}

function hintsHtml() {
  return `
    ${suggestions().length ? `<div class="query-chips">
      <span class="query-chips__label">Попробуйте</span>
      ${suggestions().map((q) => `<button class="chip" type="button" data-query="${esc(q)}">${esc(q)}</button>`).join('')}
    </div>` : ''}
    <div class="search-hint">
      <div class="hint-card">
        ${icon('spark')}
        <b>Один запрос — три сервиса</b>
        <p>labsoul опрашивает включённые источники параллельно и группирует результаты. Если один сервис молчит, остальные всё равно ответят.</p>
        <span class="badge badge--mute">группировка по источнику</span>
      </div>
      <div class="hint-card">
        ${icon('connection')}
        <b>Короткие фрагменты и ограничения</b>
        <p>У недоступных треков стоит бейдж: «30 сек» — только превью, «недоступно» — регион, Plus или запрет стриминга.</p>
        <span class="badge badge--warn">честные бейджи</span>
      </div>
      <div class="hint-card">
        ${icon(isDemo() ? 'alert' : 'check')}
        <b>${isDemo() ? 'Сейчас демо-набор' : 'Каталоги подключены'}</b>
        <p>${isDemo()
          ? 'Сервер не запущен, поэтому поиск идёт по локальному демо-набору из 21 трека. Запустите сервер — и запросы уйдут в настоящие каталоги.'
          : 'Поиск идёт в живые каталоги. Подключить аккаунты и ключи можно в разделе «Подключения».'}</p>
        <span class="badge ${isDemo() ? 'badge--demo' : 'badge--ok'}">${isDemo() ? 'демо-режим' : 'live'}</span>
      </div>
    </div>`;
}

function groupHtml(group) {
  const count = group.items.length;
  const head = `
    <div class="group__head">
      <span class="group__logo group__logo--${group.source}">${SOURCE_MARKS[group.source]}</span>
      <span class="group__name">${esc(SOURCE_NAMES[group.source] || group.source)}</span>
      ${count ? `<span class="group__count">${count} ${plural(count, ['трек', 'трека', 'треков'])}</span>` : ''}
      <span class="group__spacer"></span>
      ${group.error
        ? `<span class="group__err">${icon('alert')} ${esc(humanizeError(group.error))}</span>`
        : ''}
    </div>`;

  if (!count) {
    return `<section class="group panel">${head}<div class="group__empty">${group.error ? 'Источник не ответил.' : 'В этом источнике совпадений нет.'}</div></section>`;
  }

  const rows = group.items
    .map((track, i) => rowHtml(track, {
      index: i + 1,
      current: false,
      likedIds: new Set(app.likes.map((t) => t.id)),
      mode: 'search',
      highlight: app.search.query,
    }))
    .join('');

  return `<section class="group panel" style="padding-bottom:8px">${head}<div class="group__list">${rows}</div></section>`;
}

function resultsHtml() {
  const { loading, ran, error, query, groups } = app.search;

  if (!String(query).trim()) return hintsHtml();

  if (loading && !groups.length) {
    return `
      <div class="search-summary"><h2>Ищем «${esc(query)}»</h2><p>опрашиваем источники</p></div>
      <section class="group panel">${skeletonRows(4)}</section>
      <section class="group panel">${skeletonRows(3)}</section>`;
  }

  if (error) {
    return `<div class="failure">${icon('alert')}
      <div><b>Поиск не удался.</b> ${esc(error)}<br>
      <button class="btn btn--ghost btn--sm" type="button" data-search-act="retry" style="margin-top:8px">${icon('refresh')} Повторить</button></div>
    </div>`;
  }

  if (!ran) return hintsHtml();

  const visible = groups.filter((group) => app.search.sources.includes(group.source));
  const total = visible.reduce((sum, group) => sum + group.items.length, 0);
  const usedSources = visible.filter((group) => group.items.length).length;
  const withItems = visible.filter((group) => group.items.length);
  const failed = visible.filter((group) => !group.items.length && group.error);
  const quiet = visible.filter((group) => !group.items.length && !group.error);

  const summary = `
    <div class="search-summary">
      <h2>Результаты по запросу «${esc(query)}»</h2>
      <p>${total ? `${total} ${plural(total, ['трек', 'трека', 'треков'])} в ${usedSources} ${plural(usedSources, ['источнике', 'источниках', 'источниках'])}` : 'совпадений нет'}</p>
      ${loading ? `<span class="load-more" style="min-height:0;margin-left:auto"><span class="spinner" style="width:12px;height:12px;margin:0"></span></span>` : ''}
    </div>`;

  const problems = failed.length
    ? `<div class="search-problems">${failed.map((group) => `
        <span class="group__err">${icon('alert')} ${esc(SOURCE_NAMES[group.source])}: ${esc(humanizeError(group.error))}</span>`).join('')}</div>`
    : '';

  if (!visible.length) {
    return summary + emptyState({
      iconName: 'connection',
      title: 'Все источники выключены',
      text: 'Включите хотя бы один сервис в фильтрах выше — запрос сразу повторится.',
      actions: '<button class="btn btn--accent btn--sm" type="button" data-search-act="all-sources">Включить все</button>',
    });
  }

  if (!total) {
    return summary + problems + emptyState({
      iconName: 'search',
      title: 'Ничего не нашлось',
      text: `По запросу «${esc(query)}» ни один источник не дал совпадений. Попробуйте короче или включите все сервисы.`,
      actions: '<button class="btn btn--ghost btn--sm" type="button" data-search-act="all-sources">Искать везде</button>',
    });
  }

  const skipped = quiet.length
    ? `<p class="search-skipped">Без совпадений: ${quiet.map((group) => esc(SOURCE_NAMES[group.source])).join(', ')}.</p>`
    : '';

  return summary + withItems.map(groupHtml).join('') + problems + skipped;
}

function paintFilters() {
  const host = screen.root?.querySelector('#search-filters');
  if (host) host.innerHTML = filtersHtml();
}

function paintResults() {
  const host = screen.root?.querySelector('#search-results');
  if (host) host.innerHTML = resultsHtml();
}

function syncInput() {
  const input = screen.root?.querySelector('#search-page-input');
  if (!input) return;
  if (document.activeElement !== input && input.value !== app.search.query) {
    input.value = app.search.query;
  }
}

function scheduleSearch(value, immediate = false) {
  clearTimeout(screen.timer);
  const q = String(value ?? '').trim();
  if (!q) {
    app.search.groups = [];
    app.search.ran = false;
    app.search.error = null;
    app.search.loading = false;
    emit('search');
    return;
  }
  const run = () => { runSearch(q); };
  if (immediate) { clearTimeout(screen.timer); run(); return; }
  screen.timer = setTimeout(run, q.length < 2 ? 650 : 380);
}

function applyQuery(value, { immediate = true, source = 'screen' } = {}) {
  const q = String(value ?? '');
  const input = screen.root?.querySelector('#search-page-input');
  if (input && source !== 'screen') input.value = q;
  setSearchQuery(q);
  scheduleSearch(q, immediate);
}

function onClick(event) {
  const target = event.target instanceof Element ? event.target.closest('[data-search-act], [data-source], [data-query]') : null;
  if (!target) return;

  if (target.dataset.source) {
    toggleSearchSource(target.dataset.source);
    paintFilters();
    if (app.search.query.trim()) runSearch(app.search.query);
    return;
  }
  if (target.dataset.query) {
    applyQuery(target.dataset.query, { immediate: true });
    return;
  }
  const act = target.dataset.searchAct;
  if (act === 'retry') {
    if (app.search.query.trim()) runSearch(app.search.query);
    return;
  }
  if (act === 'all-sources') {
    setSearchSources(['yandex', 'soundcloud', 'spotify']);
    paintFilters();
    if (app.search.query.trim()) runSearch(app.search.query);
    else emit('search');
  }
}

export const searchScreen = {
  id: 'search',
  title: 'Поиск',

  render(container) {
    container.innerHTML = pageHtml();
    const input = container.querySelector('#search-page-input');
    if (input) input.value = app.search.query;
  },

  mount(container) {
    screen.root = container;

    const form = container.querySelector('#search-form');
    const input = container.querySelector('#search-page-input');

    const onSubmit = (event) => {
      event.preventDefault();
      const value = input ? input.value : app.search.query;
      applyQuery(value, { immediate: true });
    };
    const onInput = () => {
      if (!input) return;
      applyQuery(input.value, { immediate: false });
    };

    if (form) form.addEventListener('submit', onSubmit);
    if (input) {
      input.addEventListener('input', onInput);
      input.addEventListener('search', onInput);
    }
    container.addEventListener('click', onClick);

    // импорт по ссылке: сервер разберёт Spotify/Яндекс/SoundCloud и найдёт играбельную версию
    const linkForm = container.querySelector('#link-form');
    const linkInput = container.querySelector('#link-input');

    const onLinkSubmit = async (event) => {
      event.preventDefault();
      const value = (linkInput && linkInput.value ? linkInput.value : '').trim();
      if (!value) {
        toast('Вставьте ссылку на трек', { type: 'warn' });
        return;
      }
      const button = linkForm ? linkForm.querySelector('button[type="submit"]') : null;
      if (button) button.disabled = true;
      try {
        const data = await linkLookup(value);
        const query = [data?.artists?.[0], data?.title].filter(Boolean).join(' ').trim();
        const candidates = Array.isArray(data?.candidates) ? data.candidates : [];

        if (candidates.length) {
          const best = candidates[0];
          toast(`Нашли версию: ${best.artists.join(', ')} — ${best.title}`, { icon: 'check' });
        } else if (data?.note) {
          toast(data.note, { type: 'warn', duration: 4600 });
        }

        if (linkInput) linkInput.value = '';
        if (query) applyQuery(query, { immediate: true });
      } catch (err) {
        toast(err?.message || 'Не удалось разобрать ссылку', { type: 'err' });
      } finally {
        if (button) button.disabled = false;
      }
    };

    if (linkForm) linkForm.addEventListener('submit', onLinkSubmit);

    const unbindTracks = bindTrackActions(container, {
      getList: () => app.search.groups.flatMap((group) => group.items),
      feedback: false,
    });

    const unsub = storeSubscribe((_state, event) => {
      if (event === 'search' || event === 'search-query') {
        paintFilters();
        paintResults();
        syncInput();
      }
      if (event === 'search-sources') paintFilters();
      if (event === 'likes') paintResults();
      if (event === 'net' && app.search.query.trim()) {
        runSearch(app.search.query);
      }
    });

    screen.unsubs.push(unbindTracks, unsub, () => {
      clearTimeout(screen.timer);
      if (form) form.removeEventListener('submit', onSubmit);
      if (linkForm) linkForm.removeEventListener('submit', onLinkSubmit);
      if (input) {
        input.removeEventListener('input', onInput);
        input.removeEventListener('search', onInput);
      }
      container.removeEventListener('click', onClick);
    });

    paintFilters();
    paintResults();
    if (app.search.query.trim() && !app.search.ran) runSearch(app.search.query);
    if (app.search.query.trim()) input?.focus({ preventScroll: true });
  },

  destroy() {
    for (const off of screen.unsubs.splice(0)) {
      try { off(); } catch { /* ignore */ }
    }
    screen.root = null;
    clearTimeout(screen.timer);
  },
};

export default searchScreen;

/* Экспорт для главного модуля: верхняя строка ищет через тот же стор. */
export function searchFromTopbar(value) {
  const q = String(value ?? '');
  setSearchQuery(q);
  if (screen.root) {
    applyQuery(q, { immediate: false });
  } else if (q.trim()) {
    runSearch(q);
  }
}
