/* =========================================================================
   labsoul — общие компоненты разметки: иконки, обложки, строки, бейджи.
   Всё возвращает HTML-строки; события обрабатываются делегированием.
   ========================================================================= */

import { failedCovers, paletteFor } from './covers.js';
import { artistsLine, esc, fmtDuration, fmtTimeOfDay, plural } from './utils.js';

export const icon = (name, cls = '') => `<svg viewBox="0 0 24 24"${cls ? ` class="${cls}"` : ''} aria-hidden="true"><use href="#i-${name}"></use></svg>`;

export const SOURCE_NAMES = {
  yandex: 'Яндекс.Музыка',
  soundcloud: 'SoundCloud',
  spotify: 'Spotify',
};
export const SOURCE_SHORT = {
  yandex: 'Яндекс',
  soundcloud: 'SoundCloud',
  spotify: 'Spotify',
};
export const SOURCE_MARKS = {
  yandex: 'Я',
  soundcloud: 'SC',
  spotify: 'SP',
};
export const REASON_LABELS = {
  no_preview: 'только 30 сек',
  go_plus: 'нужен Plus',
  geo: 'недоступно',
  not_streamable: 'недоступно',
};
const REASON_SHORT = {
  no_preview: '30 сек',
  go_plus: 'Plus',
  geo: 'гео',
  not_streamable: 'недоступно',
};

export function trackStyle(track) {
  const p = paletteFor(track);
  return `--a:${p.a};--b:${p.b};--c:${p.c}`;
}

export function coverImg(track, opts = {}) {
  if (!track?.cover || failedCovers.has(track.cover)) return '';
  return `<img src="${esc(track.cover)}" alt="" data-cover="1" loading="${opts.eager ? 'eager' : 'lazy'}" decoding="async" referrerpolicy="no-referrer">`;
}

export function sourceBadge(source) {
  return `<span class="badge badge--${source}">${esc(SOURCE_SHORT[source] || source)}</span>`;
}

export function reasonBadge(track) {
  if (!track) return '';
  if (track.playable) {
    if (track.explicit) return '<span class="badge badge--mute" title="Ненормативная лексика">18+</span>';
    if (track.duration > 0 && track.duration <= 35) {
      return '<span class="badge badge--warn" title="Доступен только короткий фрагмент">30 сек</span>';
    }
    return '';
  }
  const label = REASON_SHORT[track.reason] || 'недоступно';
  const title = REASON_LABELS[track.reason] || 'недоступно';
  return `<span class="badge badge--warn" title="${esc(title)}">${esc(label)}</span>`;
}

export function eqBars(cls = 'pl-eq') {
  return `<span class="${cls}" aria-hidden="true"><i></i><i></i><i></i><i></i></span>`;
}

export function downloadBadge() {
  return `<span class="badge badge--warn" title="Доступен только короткий фрагмент">30 сек</span>`;
}

function actButton(act, id, iconName, label, cls = 'row__btn', on = false) {
  return `<button class="${cls}${on ? ' on' : ''}" type="button" data-act="${act}" data-id="${esc(id)}" title="${esc(label)}" aria-label="${esc(label)}">${icon(iconName)}</button>`;
}

/**
 * Строка трека.
 * @param {object} track
 * @param {{index?:number,current?:boolean,liked?:boolean,likedIds?:Set<string>,mode?:'wave'|'search'|'library'|'likes',historyAt?:string,playedSeconds?:number,highlight?:string}} opts
 */
export function rowHtml(track, opts = {}) {
  const {
    index = 0,
    current = false,
    likedIds = null,
    mode = 'library',
    historyAt = null,
    playedSeconds = 0,
    highlight = '',
  } = opts;
  const liked = likedIds ? likedIds.has(track.id) : !!opts.liked;

  const title = highlight ? highlightText(track.title, highlight) : esc(track.title);
  const artist = esc(artistsLine(track) || 'Неизвестный исполнитель');
  const acts = [];

  acts.push(actButton('like', track.id, 'heart', liked ? 'Убрать из избранного' : 'В избранное', 'row__btn', liked));
  if (mode === 'wave') {
    acts.push(actButton('dislike', track.id, 'thumb-down', 'Не очень'));
    acts.push(actButton('skip', track.id, 'next', 'Пропустить'));
  }
  acts.push(actButton('queue', track.id, 'plus', 'В очередь'));

  const flagExtra = [];
  if (historyAt) {
    flagExtra.push(`<span class="badge badge--mute" title="Время прослушивания">${esc(fmtTimeOfDay(historyAt))}</span>`);
  }

  return `
    <div class="row${current ? ' is-current' : ''}" data-row-id="${esc(track.id)}" data-row-index="${index}">
      <span class="row__num">${current ? `<span class="row-eq" data-visualizer aria-hidden="true"><i></i><i></i><i></i><i></i></span>` : (index ? String(index).padStart(2, '0') : '')}</span>
      <button class="row__art" type="button" data-act="play" data-id="${esc(track.id)}" style="${trackStyle(track)}" aria-label="Играть: ${esc(track.title)} — ${artist}">
        ${coverImg(track)}
        <span class="row__play">${icon('play')}</span>
      </button>
      <div class="row__meta">
        <button class="row__title" type="button" data-act="play" data-id="${esc(track.id)}" title="${esc(track.title)}">${title}</button>
        <p class="row__artist">${artist}</p>
      </div>
      <span class="row__album" title="${esc(track.album || '')}">${esc(track.album || '—')}</span>
      <div class="row__flags">${sourceBadge(track.source)}${reasonBadge(track)}${flagExtra.join('')}</div>
      <span class="row__dur">${fmtDuration(track.duration)}</span>
      <div class="row__acts">${acts.join('')}</div>
    </div>`;
}

export function rowsHtml(items, opts = {}) {
  return `<div class="rows">${items.map((track, i) => rowHtml(track, { ...opts, index: i + 1 })).join('')}</div>`;
}

/** Карточка-обложка для ленты «Волна». */
export function coverCardHtml(track) {
  return `
    <button class="cover-card" type="button" data-act="play" data-id="${esc(track.id)}"
      style="${trackStyle(track)}" aria-label="Играть: ${esc(track.title)} — ${esc(artistsLine(track))}">
      ${coverImg(track)}
      <span class="cover-card__badge">${esc(SOURCE_SHORT[track.source] || track.source)}</span>
      <span class="cover-card__info">
        <span class="cover-card__title">${esc(track.title)}</span>
        <span class="cover-card__artist">${esc(artistsLine(track))}</span>
      </span>
    </button>`;
}

export function highlightText(text, query) {
  const src = String(text ?? '');
  if (!query) return esc(src);
  const safe = String(query).trim();
  if (!safe) return esc(src);
  const rx = new RegExp(`(${safe.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'ig');
  return src
    .split(rx)
    .map((chunk) => (chunk.toLowerCase() === safe.toLowerCase() ? `<mark class="hit">${esc(chunk)}</mark>` : esc(chunk)))
    .join('');
}

export function sectionHead(title, { sub = '', more = '', moreAttr = '' } = {}) {
  return `<div class="section__head">
    <h2>${esc(title)}</h2>
    ${sub ? `<span class="sub">${esc(sub)}</span>` : ''}
    ${more ? `<button class="more" type="button" ${moreAttr}>${esc(more)}${icon('chev-right')}</button>` : ''}
  </div>`;
}

export function emptyState({ iconName = 'music', title = 'Пока пусто', text = '', actions = '' } = {}) {
  return `<div class="empty">
    ${icon(iconName)}
    <b>${esc(title)}</b>
    <span>${text}</span>
    ${actions ? `<div class="empty__actions">${actions}</div>` : ''}
  </div>`;
}

export function skeletonRows(count = 6) {
  return `<div class="rows" aria-hidden="true">${Array.from({ length: count })
    .map(() => '<span class="skel skel--row"></span>')
    .join('')}</div>`;
}

export function skeletonCards(count = 6) {
  return `<div class="grid" aria-hidden="true">${Array.from({ length: count })
    .map(() => '<span class="skel skel--card"></span>')
    .join('')}</div>`;
}

export function spinner(label = '') {
  return `<div class="load-more"><span class="spinner" role="status" aria-label="Загрузка"></span>${label ? `<span>${esc(label)}</span>` : ''}</div>`;
}

export function trackCount(n) {
  return `${n} ${plural(n, ['трек', 'трека', 'треков'])}`;
}
