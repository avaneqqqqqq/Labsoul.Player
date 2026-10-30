'use strict';

/**
 * Сборка CSS и скриптов, которые накладываются на музыку.
 * Ничего не знает про DOM Яндекс.Музыки — только токены.
 */

const SCHEMES = {
  dark: {
    bg: '#0a0a0c', bg2: '#101015', text: '#f5f5f7', dim: '#a2a2ad', mute: '#6d6d78',
    panel: 'rgba(20,20,26,.58)', panelStrong: 'rgba(24,24,31,.82)',
    border: 'rgba(255,255,255,.085)', hover: 'rgba(255,255,255,.07)',
  },
  light: {
    bg: '#f3efe7', bg2: '#faf7f1', text: '#16150f', dim: '#5d584e', mute: '#8b8578',
    panel: 'rgba(255,255,255,.66)', panelStrong: 'rgba(255,255,255,.92)',
    border: 'rgba(22,21,15,.12)', hover: 'rgba(22,21,15,.06)',
  },
  amoled: {
    bg: '#000000', bg2: '#070709', text: '#f7f7fa', dim: '#9c9ca8', mute: '#63636f',
    panel: 'rgba(10,10,13,.72)', panelStrong: 'rgba(14,14,18,.9)',
    border: 'rgba(255,255,255,.1)', hover: 'rgba(255,255,255,.08)',
  },
};

const CARD_MIN = { auto: '172px', s: '150px', m: '172px', l: '196px' };

function vars(theme) {
  const s = SCHEMES[theme.scheme] || SCHEMES.dark;
  const t = theme || {};
  const out = {
    '--ym-scheme': t.scheme || 'dark',
    '--ym-variant': t.variant || 'glass',
    '--ym-bg': s.bg,
    '--ym-bg-2': s.bg2,
    '--ym-text': (t.txt || s.text),
    '--ym-heading': (t.heading || t.txt || s.text),
    '--ym-dim': (t.dimc || s.dim),
    '--ym-mute': s.mute,
    '--ym-panel': s.panel,
    '--ym-panel-strong': s.panelStrong,
    '--ym-border': s.border,
    '--ym-hover': s.hover,
    '--ym-radius': (Number(t.radius) || 0) + 'px',
    '--ym-blur': (Number(t.blur) || 0) + 'px',
    '--ym-density': t.density || 'normal',
    '--ym-card-min': CARD_MIN[t.cards] || CARD_MIN.m,
    '--ym-cols': t.cols === 'auto' || !t.cols ? 'auto-fill' : String(t.cols),
    '--ym-font': t.font === 'serif' ? 'Georgia, "Times New Roman", serif'
      : t.font === 'mono' ? '"Cascadia Code", Consolas, monospace'
        : '"Segoe UI Variable Text", "Inter", "Segoe UI", system-ui, sans-serif',
    '--ym-eq-on': t.eq && t.eq.on ? '1' : '0',
  };
  if (!t.accentAuto && t.accent) out['--ym-accent'] = t.accent;
  return out;
}

function buildThemeCss(theme) {
  if (!theme) return '';
  const map = vars(theme);
  const root = Object.entries(map).map(([k, v]) => `  ${k}: ${v};`).join('\n');
  const accent = map['--ym-accent'] || '#ffd23f';

  /* Только то, что не зависит от их разметки: переменные, скроллбар, выделение.
     Всё остальное — в patches.css, который калибруется по devtools. */
  return `/* ym-theme ${Date.now()} */
:root {
${root}
}
html { scrollbar-color: ${accent} transparent; }
::selection { background: ${accent}44; }
`;
}

function buildBlocksScript(blocks) {
  const list = Object.entries(blocks || {})
    .filter(([, c]) => c && c.selector)
    .map(([id, c]) => ({ id, selector: c.selector, mode: c.mode || 'hide' }));

  return `(() => {
  const list = ${JSON.stringify(list)};
  const report = { applied: [], missing: [], errors: [], fatal: null };
  try {
    let style = document.getElementById('ym-blocks');
    if (!style) {
      style = document.createElement('style');
      style.id = 'ym-blocks';
      document.head.appendChild(style);
    }
    const rules = [];
    for (const b of list) {
      try {
        const nodes = document.querySelectorAll(b.selector);
        if (!nodes.length) { report.missing.push(b.id); continue; }
        if (b.mode === 'hide') rules.push(b.selector + ' { display: none !important; }');
        report.applied.push(b.id);
      } catch (err) {
        report.errors.push(b.id);
      }
    }
    style.textContent = rules.join('\\n');
  } catch (err) {
    report.fatal = String((err && err.message) || err);
  }
  return report;
})()`;
}

module.exports = { SCHEMES, vars, buildThemeCss, buildBlocksScript };
