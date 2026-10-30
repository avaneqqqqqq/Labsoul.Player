/* =========================================================================
   labsoul — действия над треком из любой строки/карточки.
   Делегирование: data-act="play|like|dislike|skip|queue" + data-id.
   ========================================================================= */

import { waveFeedback } from './api.js';
import { player } from './audio.js';
import { REASON_TEXT } from './audio.js';
import { batchOf, toggleLike, trackById } from './store.js';
import { toast } from './toast.js';
import { artistsLine } from './utils.js';

function sendFeedback(type, track) {
  waveFeedback({
    type,
    trackId: track.id,
    batchId: batchOf(track.id) || null,
    position: 0,
  });
}

function syncLikeButtons(trackId, liked) {
  const buttons = document.querySelectorAll('[data-act="like"]');
  for (const button of buttons) {
    if (button.dataset.id === trackId) button.classList.toggle('on', liked);
  }
}

/**
 * Навесить обработчик действий на контейнер экрана.
 * @param {HTMLElement} root
 * @param {{getList?:()=>object[], getContext?:()=>object|null, feedback?:boolean}} opts
 * @returns {() => void} отписка
 */
export function bindTrackActions(root, opts = {}) {
  const { getList, getContext, feedback = false } = opts;

  const onClick = (event) => {
    const target = event.target instanceof Element ? event.target.closest('[data-act]') : null;
    if (!target || !root.contains(target)) return;
    const act = target.dataset.act;
    if (!['play', 'like', 'dislike', 'skip', 'queue'].includes(act)) return;
    event.preventDefault();
    event.stopPropagation();

    const track = trackById(target.dataset.id);
    if (!track) return;
    const list = typeof getList === 'function' ? getList() : [];

    switch (act) {
      case 'play': {
        const items = Array.isArray(list) && list.length ? list : [track];
        const index = Math.max(0, items.findIndex((item) => item.id === track.id));
        if (!track.playable) {
          toast(REASON_TEXT[track.reason] || 'Трек недоступен', { type: 'warn' });
        }
        player.playTracks(items, index, { context: typeof getContext === 'function' ? getContext() : null });
        break;
      }
      case 'like': {
        const liked = toggleLike(track);
        syncLikeButtons(track.id, liked);
        if (liked) toast(`В избранном: ${track.title}`, { icon: 'heart' });
        else toast('Убрано из избранного', { icon: 'heart' });
        if (feedback && liked) sendFeedback('like', track);
        break;
      }
      case 'dislike': {
        if (feedback) sendFeedback('dislike', track);
        toast(`Волна запомнит: не понравилось «${track.title}»`, { type: 'warn', icon: 'thumb-down' });
        if (player.currentTrack()?.id === track.id) player.next();
        break;
      }
      case 'skip': {
        if (feedback) sendFeedback('skip', track);
        if (player.currentTrack()?.id === track.id) player.next();
        else toast('Пропущено', { icon: 'next', duration: 1500 });
        break;
      }
      case 'queue': {
        const result = player.enqueue(track);
        if (result.started) toast(`Играет: ${track.title}`, { icon: 'play' });
        else if (result.added) toast(`В очереди: ${track.title} — ${artistsLine(track)}`, { icon: 'queue' });
        else toast('Этот трек уже в очереди', { type: 'warn', icon: 'queue' });
        break;
      }
      default:
        break;
    }
  };

  root.addEventListener('click', onClick);
  return () => root.removeEventListener('click', onClick);
}
