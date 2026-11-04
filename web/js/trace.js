/**
 * Отправка событий диагностики на сервер.
 *
 * Нужно, чтобы увидеть, что происходит внутри упакованного приложения:
 * там нет консоли, а проблема именно в поведении. Журнал всегда включён,
 * но ничего не замедляет — события копятся в буфере и уходят пачками.
 */

const buffer = [];
let timer = 0;

/**
 * Записать событие.
 *
 * @param {string} category — группа: click, player, lyrics, api
 * @param {string} message — что произошло
 * @param {*} [data] — подробности
 */
export function trace(category, message, data) {
  try {
    buffer.push({ category, message: String(message), data });
    if (!timer) timer = setTimeout(flush, 600);
  } catch { /* диагностика не должна ломать интерфейс */ }
}

/** Отправить накопленное прямо сейчас. */
export async function flush() {
  timer = 0;
  if (!buffer.length) return;
  const events = buffer.splice(0, buffer.length);
  try {
    await fetch('/api/debug', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ events }),
      keepalive: true,
    });
  } catch { /* нет связи — теряются */ }
}

// не терять хвост при закрытии окна
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => { flush(); });
  window.addEventListener('beforeunload', () => { flush(); });
}
