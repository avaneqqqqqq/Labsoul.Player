/* =========================================================================
   labsoul — всплывающие сообщения.
   ========================================================================= */

import { esc } from './utils.js';

const ICONS = {
  ok: 'check',
  warn: 'alert',
  err: 'alert',
  info: 'spark',
};

let timer = 0;

/**
 * @param {string} message
 * @param {{type?:'ok'|'warn'|'err'|'info', icon?:string, duration?:number}} opts
 */
export function toast(message, opts = {}) {
  const el = document.getElementById('toast');
  if (!el) return;
  const type = opts.type || 'ok';
  const iconName = opts.icon || ICONS[type] || 'check';
  const duration = opts.duration ?? (type === 'err' ? 4200 : 2600);
  el.className = `toast on${type === 'warn' ? ' toast--warn' : type === 'err' ? ' toast--err' : ''}`;
  el.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><use href="#i-${iconName}"></use></svg><span>${esc(message)}</span>`;
  clearTimeout(timer);
  timer = setTimeout(() => {
    el.classList.remove('on');
  }, duration);
}

export function hideToast() {
  const el = document.getElementById('toast');
  if (el) el.classList.remove('on');
}
