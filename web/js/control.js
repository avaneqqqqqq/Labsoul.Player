/**
 * Единая точка переключения воспроизведения.
 *
 * Проблема, которую это решает: кнопка плей/пауза в разных местах
 * вела себя по-разному. Где-то вызывала player.toggle() и не обновляла
 * интерфейс, где-то ждала ответа плеера. В итоге нажатие «не срабатывало
 * с первого раза» и «не во всех местах».
 *
 * Теперь все места зовут эту функцию — она и переключает, и обновляет
 * обе панели (нижний бар и полноэкранный), и сама проверяет результат.
 */

import * as player from './audio.js';
import { trace } from './trace.js';

/** Колбэки обновления интерфейса — их подключает ui.js при инициализации. */
let refreshBar = () => {};
let refreshFullscreen = () => {};

export function setRefreshers({ bar, fullscreen }) {
  if (typeof bar === 'function') refreshBar = bar;
  if (typeof fullscreen === 'function') refreshFullscreen = fullscreen;
}

/**
 * Переключить воспроизведение и обновить интерфейс.
 *
 * @param {string} origin — откуда пришло нажатие (для журнала)
 * @returns {boolean} стало ли играть
 */
export function toggle(origin = 'unknown') {
  const before = player.getState().playing;

  try {
    player.toggle();
  } catch (error) {
    trace('player', `toggle ошибся (${origin})`, { message: error?.message });
  }

  // обновляем обе панели сразу и ещё раз через кадр:
  // состояние может дойти до слушателей не мгновенно
  const apply = () => {
    try { refreshBar(); } catch { /* панель может быть не открыта */ }
    try { refreshFullscreen(); } catch { /* полноэкранный может быть закрыт */ }
  };

  apply();
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(apply);

  const after = player.getState().playing;
  trace('player', `toggle из «${origin}»`, { before, after });

  return after;
}

/** Явно поставить паузу или воспроизведение. */
export function setPlaying(playing, origin = 'unknown') {
  const state = player.getState().playing;
  if (state === playing) {
    // уже в нужном состоянии — всё равно обновим интерфейс
    try { refreshBar(); } catch { /* ignore */ }
    try { refreshFullscreen(); } catch { /* ignore */ }
    return playing;
  }
  return toggle(origin) === playing;
}
