/* =========================================================================
   labsoul — экран «Оформление»: тема, блоки, предпросмотр и эквалайзер.
   ========================================================================= */

import { player } from '../audio.js';
import { EQ_LABELS, EQ_PRESETS } from '../audio.js';
import { icon } from '../components.js';
import { paletteFor } from '../covers.js';
import {
  applyPreset,
  BLOCK_DEFS,
  exportTheme,
  importTheme,
  PRESETS,
  resetTheme,
  resetThemeSection,
  setCustomWallpaper,
  subscribe as themeSubscribe,
  theme,
  update,
} from '../theme.js';
import { toast } from '../toast.js';
import { clamp, esc } from '../utils.js';
import { openModal } from '../ui.js';

const ACCENTS = ['#ffd23f', '#ff8a5c', '#ff4d6d', '#b46bff', '#6ea8ff', '#12e0c8', '#4be0a0', '#f3efe7'];
const WALLS = [
  { id: 'cover', name: 'Из обложки', cls: 'wp--cover' },
  { id: 'aurora', name: 'Аврора', cls: 'wp--aurora' },
  { id: 'sunset', name: 'Закат', cls: 'wp--sunset' },
  { id: 'ocean', name: 'Океан', cls: 'wp--ocean' },
  { id: 'solid', name: 'Цвет темы', cls: 'wp--solid' },
  { id: 'none', name: 'Без фона', cls: 'wp--none' },
];

const screen = { root: null, unsubs: [], lastOrder: '' };

/* ------------------------------------------------------------------ */
/* Разметка                                                            */
/* ------------------------------------------------------------------ */

function segButtons(key, options) {
  return options.map(([value, label]) => `
    <button type="button" data-t="${key}" data-v="${esc(value)}">${esc(label)}</button>`).join('');
}

function presetButtons() {
  return PRESETS.map((preset) => `
    <button class="preset" type="button" data-preset="${preset.id}" title="${esc(preset.name)}">
      <i style="background:${preset.swatch}"></i>${esc(preset.name)}
    </button>`).join('');
}

function swatches() {
  const auto = theme.accentAuto;
  return `
    <button class="sw sw--auto${auto ? ' on' : ''}" type="button" data-t="accent-auto" title="Авто из обложки" aria-label="Акцент из обложки">
      ${icon('spark')}
    </button>
    ${ACCENTS.map((color) => `
      <button class="sw${!auto && theme.accent.toLowerCase() === color ? ' on' : ''}" type="button"
        data-t="accent" data-v="${color}" style="background:${color}" title="${color}" aria-label="Акцент ${color}"></button>`).join('')}
    <label class="sw sw--custom" title="Свой цвет">
      <input type="color" value="${esc(theme.accent)}" data-color="accent" aria-label="Свой цвет акцента">
    </label>`;
}

function wallpaperTiles() {
  // у каждого варианта своя иконка-подсказка: раньше у «Без фона» и
  // «Цвет темы» были одинаковые пустые плитки и было непонятно, что к чему
  const glyph = {
    cover: 'music',
    aurora: 'spark',
    sunset: 'spark',
    ocean: 'wave',
    solid: 'palette',
    none: 'x',
  };
  return `
    ${WALLS.map((wall) => `
      <button class="wp ${wall.cls}${theme.wallpaper === wall.id ? ' on' : ''}" type="button" data-wall="${wall.id}" title="${esc(wall.name)}">
        <i class="wp__glyph">${icon(glyph[wall.id] || 'spark')}</i>
        <span>${esc(wall.name)}</span>
      </button>`).join('')}
    <button class="wp wp--upload${theme.wallpaper === 'custom' ? ' on' : ''}" type="button" data-wall="upload" title="Своя картинка">
      ${icon('plus')}<span>Своя</span>
    </button>`;
}

function blockRows() {
  const order = theme.blockOrder.filter((id) => BLOCK_DEFS.some((block) => block.id === id && block.order));
  const ordered = [...order];
  const rest = BLOCK_DEFS.filter((block) => !block.order);
  const defs = [...ordered.map((id) => BLOCK_DEFS.find((block) => block.id === id)), ...rest].filter(Boolean);
  return defs.map((block) => {
    const orderIndex = theme.blockOrder.indexOf(block.id);
    const orderable = block.order;
    return `<div class="blockrow" data-block-row="${block.id}">
      <div class="blockrow__name">${esc(block.name)}${block.sub ? `<small>${esc(block.sub)}</small>` : ''}</div>
      ${orderable ? `
        <button class="arrowbtn" type="button" data-block-move="${block.id}" data-dir="-1"
          title="Выше" aria-label="Выше" ${orderIndex <= 0 ? 'disabled' : ''}>${icon('arrow-up')}</button>
        <button class="arrowbtn" type="button" data-block-move="${block.id}" data-dir="1"
          title="Ниже" aria-label="Ниже" ${orderIndex === theme.blockOrder.length - 1 ? 'disabled' : ''}>${icon('arrow-down')}</button>` : ''}
      <label class="toggle" title="Показывать блок">
        <input type="checkbox" data-block="${block.id}" ${theme.blocks[block.id] ? 'checked' : ''}>
        <span class="toggle__track"></span>
      </label>
    </div>`;
  }).join('');
}

function eqChart(bands) {
  const W = 940;
  const H = 128;
  const pad = 10;
  const points = bands.map((value, i) => [
    pad + (i * (W - 2 * pad)) / 9,
    H / 2 - (value / 12) * (H / 2 - pad),
  ]);
  let path = `M ${points[0][0].toFixed(1)} ${points[0][1].toFixed(1)}`;
  for (let i = 1; i < points.length; i += 1) {
    const [x0, y0] = points[i - 1];
    const [x1, y1] = points[i];
    const mx = (x0 + x1) / 2;
    path += ` C ${mx.toFixed(1)} ${y0.toFixed(1)}, ${mx.toFixed(1)} ${y1.toFixed(1)}, ${x1.toFixed(1)} ${y1.toFixed(1)}`;
  }
  const area = `${path} L ${points[9][0].toFixed(1)} ${(H / 2).toFixed(1)} L ${points[0][0].toFixed(1)} ${(H / 2).toFixed(1)} Z`;
  return `<svg class="eq-chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">
    <line class="gridline" x1="0" y1="${H / 4}" x2="${W}" y2="${H / 4}"/>
    <line class="gridline" x1="0" y1="${(H * 3) / 4}" x2="${W}" y2="${(H * 3) / 4}"/>
    <line class="zero" x1="0" y1="${H / 2}" x2="${W}" y2="${H / 2}"/>
    <path class="area" d="${area}" vector-effect="non-scaling-stroke"/>
    <path class="line" d="${path}" vector-effect="non-scaling-stroke"/>
    ${points.map(([x, y]) => `<circle class="dot" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="2.6"/>`).join('')}
  </svg>`;
}

function bandHtml(value, index) {
  const label = value > 0 ? `+${value}` : String(value);
  return `<div class="eq-band" data-band-wrap="${index}">
    <span class="eq-band__val${value < 0 ? ' is-neg' : ''}" data-band-val="${index}">${label}</span>
    <div class="eq-band__track">
      <span class="eq-band__rail" aria-hidden="true"></span>
      <span class="eq-band__fill" data-band-fill="${index}" aria-hidden="true"></span>
      <input class="rng--v" type="range" min="-12" max="12" step="1" value="${value}"
        data-eq-band="${index}" aria-label="Полоса ${EQ_LABELS[index]} герц" aria-valuetext="${label} дБ">
    </div>
    <span class="eq-band__hz">${EQ_LABELS[index]}</span>
  </div>`;
}

function eqSection() {
  return `<section class="eq-wrap${theme.eq.on ? '' : ' is-off'}" id="eq-section" data-section="eq">
    <div class="panel__head">
      ${icon('eq')}<h3>Эквалайзер</h3>
      <span class="hint">10 полос · Web Audio</span>
      <label class="toggle" title="Включить эквалайзер" style="margin-left:12px">
        <input type="checkbox" data-eq-on ${theme.eq.on ? 'checked' : ''}>
        <span class="toggle__track"></span>
      </label>
    </div>
    <div class="eq-top">
      <span class="eq-label">Профили</span>
      <div class="eq-presets">
        ${Object.entries(EQ_PRESETS).map(([id, preset]) => `
          <button class="eq-preset${theme.eq.preset === id ? ' on' : ''}" type="button" data-eq-preset="${id}">${esc(preset.name)}</button>`).join('')}
      </div>
      <div style="margin-left:auto;display:flex;gap:8px">
        <button class="btn btn--ghost btn--sm" type="button" data-eq-flat>${icon('repeat')} Плоский</button>
        <button class="btn btn--ghost btn--sm" type="button" data-eq-save>${icon('download')} Сохранить в тему</button>
      </div>
    </div>
    <p class="eq-hint">Профиль выставляет полосы автоматически, но каждую можно поправить руками.
      Настройки сразу применяются к звуку через Web Audio и сохраняются в теме.
      <span class="eq-off-note">Эквалайзер выключен — звук идёт напрямую.</span></p>
    ${eqChart(theme.eq.bands)}
    <div class="eq-bands">
      ${theme.eq.bands.map(bandHtml).join('')}
    </div>
    <div class="eq-foot">
      <span class="eq-label">Предусиление</span>
      <div class="eq-foot__preamp">
        <input class="rng is-accent" type="range" min="-6" max="6" step="1" value="${theme.eq.preamp}" data-eq-preamp aria-label="Предусиление">
        <span class="rng-val" id="eq-preamp-val">${theme.eq.preamp > 0 ? '+' : ''}${theme.eq.preamp} dB</span>
      </div>
      <span class="eq-foot__state" id="eq-state">${theme.eq.preset === 'custom' ? 'Своя настройка' : `Профиль: ${(EQ_PRESETS[theme.eq.preset] || {}).name || 'Плоский'}`}</span>
    </div>
  </section>`;
}

function previewCode() {
  const accent = theme.accentAuto ? 'из обложки' : theme.accent;
  const presetName = theme.eq.preset === 'custom' ? 'своя' : ((EQ_PRESETS[theme.eq.preset] || {}).name || 'Плоский');
  return `
    <div class="code-line"><span>--accent</span><b>${esc(accent)}</b></div>
    <div class="code-line"><span>--variant</span><b>${esc(theme.variant)}</b></div>
    <div class="code-line"><span>--scheme</span><b>${esc(theme.scheme)}</b></div>
    <div class="code-line"><span>--radius</span><b>${theme.radius}px</b></div>
    <div class="code-line"><span>--blur</span><b>${theme.blur}px</b></div>
    <div class="code-line"><span>--wallpaper</span><b>${esc(theme.wallpaper)}</b></div>
    <div class="code-line"><span>eq.preset</span><b>${esc(presetName)}</b></div>`;
}

function previewHtml() {
  const track = player.getState().current;
  const palette = paletteFor(track || { id: 'labsoul-preview', title: 'preview' });
  return `
    <div class="mini">
      <div class="mini__wall"></div>
      <div class="mini__body">
        <div class="mini__row">
          <div class="mini__art" style="--a:${palette.a};--b:${palette.b};--c:${palette.c}"></div>
          <div style="min-width:0">
            <p class="mini__t">${esc(track?.title || 'Проверка темы')}</p>
            <p class="mini__a">${esc(track ? (track.artists || []).join(', ') : 'labsoul · предпросмотр')}</p>
          </div>
          <span class="pl-src" style="margin-left:auto">${esc(track?.source === 'soundcloud' ? 'SC' : track?.source === 'spotify' ? 'SP' : track ? 'Я' : 'LS')}</span>
        </div>
        <div class="mini__bar"><i></i></div>
        <div class="mini__cards"><div class="mini__card"></div><div class="mini__card"></div><div class="mini__card"></div></div>
      </div>
    </div>

`;
}

function shellHtml() {
  return `
    <div class="page-head">
      <div class="page-head__main">
        <div class="kicker">тема и звук</div>
        <h1>Оформление</h1>
        <p>Цвета, обои, плотность, блоки и эквалайзер — всё меняется на лету и сохраняется в браузере.</p>
      </div>
      <div class="page-head__actions">
        <button class="btn btn--ghost btn--sm" type="button" data-theme-action="export">${icon('download')} Экспорт темы</button>
        <button class="btn btn--ghost btn--sm" type="button" data-theme-action="import">${icon('upload')} Импорт</button>
        <button class="btn btn--ghost btn--sm" type="button" data-theme-action="reset">${icon('x')} Сбросить</button>
      </div>
    </div>

    <nav class="design-tabs" id="design-tabs">
      <button class="design-tab is-on" type="button" data-tab-section="look">${icon('palette')} <span>Внешний вид</span></button>
      <button class="design-tab" type="button" data-tab-section="form">${icon('type')} <span>Форма</span></button>
      <button class="design-tab" type="button" data-tab-section="grid">${icon('grid')} <span>Карточки</span></button>
      <button class="design-tab" type="button" data-tab-section="lyrics">${icon('type')} <span>Блок текста</span></button>
      <button class="design-tab" type="button" data-tab-section="blocks">${icon('library')} <span>Блоки</span></button>
      <button class="design-tab" type="button" data-tab-section="motion">${icon('spark')} <span>Анимации</span></button>
      <button class="design-tab" type="button" data-tab-section="eq">${icon('eq')} <span>Эквалайзер</span></button>
    </nav>

    <div class="theme-grid">
      <div class="design-controls">
        <div class="panel" data-section="look">
          <div class="panel__head">${icon('spark')}<h3>Пресеты</h3><span class="hint">быстрый старт</span></div>
          <div class="presets" style="padding-bottom:12px">${presetButtons()}</div>
        </div>

        <div class="panel" data-section="look">
          <div class="panel__head">${icon('palette')}<h3>Внешний вид</h3><span class="hint">схема, стиль, акцент</span><button class="panel__reset" type="button" data-reset-section="look" title="Сбросить раздел">Сброс</button></div>
          <div class="ctl">
            <div class="ctl__label">Схема<small>тёмная, светлая или AMOLED</small></div>
            <div class="seg" id="seg-scheme">${segButtons('scheme', [['dark', 'Тёмная'], ['light', 'Светлая'], ['amoled', 'AMOLED'], ['sepia', 'Сепия'], ['midnight', 'Полночь']])}</div>
          </div>
          <div class="ctl">
            <div class="ctl__label">Стиль<small>характер интерфейса</small></div>
            <div class="seg" id="seg-variant">${segButtons('variant', [['glass', 'Стекло'], ['vinyl', 'Пластинка'], ['neon', 'Неон'], ['paper', 'Бумага'], ['minimal', 'Минимал'], ['retro', 'Ретро'], ['soft', 'Мягкий']])}</div>
          </div>
          <div class="ctl">
            <div class="ctl__label">Акцент<small id="accent-hint">${theme.accentAuto ? 'автоматически из обложки' : 'свой цвет'}</small></div>
            <div class="ctl__body"><div class="swatches" id="accent-swatches">${swatches()}</div></div>
          </div>
          <div class="ctl ctl--stack">
            <div class="ctl__label">Обои<small>фон рабочей области</small></div>
            <div class="ctl__body ctl__body--wide">
              <input type="file" id="wall-upload" accept="image/*" hidden>
              <div class="wallpapers" id="wallpapers">${wallpaperTiles()}</div>
            </div>
          </div>
          <div class="wallpaper-note">Своя картинка хранится локально. Если она слишком тяжёлая для localStorage, остаётся на эту сессию.</div>
          <div class="ctl">
            <div class="ctl__label">Размытие панелей<small>стекло, плеер, панели</small></div>
            <div class="ctl__body">
              <input class="rng" type="range" min="0" max="48" step="1" value="${theme.blur}" data-range="blur" aria-label="Размытие панелей">
              <span class="rng-val" data-val-for="blur">${theme.blur}px</span>
            </div>
          </div>
          <div class="ctl">
            <div class="ctl__label">Акцент из обложки<small>подстраивать цвет под текущий трек</small></div>
            <label class="toggle"><input type="checkbox" data-toggle="accentAuto" ${theme.accentAuto ? 'checked' : ''}><span class="toggle__track"></span></label>
          </div>
          <div class="ctl">
            <div class="ctl__label">Зерно<small>плёночная текстура поверх</small></div>
            <label class="toggle"><input type="checkbox" data-toggle="grain" ${theme.grain ? 'checked' : ''}><span class="toggle__track"></span></label>
          </div>
          <div class="ctl">
            <div class="ctl__label">Перемотка в панели<small>полоса прогресса внизу</small></div>
            <label class="toggle"><input type="checkbox" data-toggle="barSeek" ${theme.barSeek ? 'checked' : ''}><span class="toggle__track"></span></label>
          </div>
        </div>

        <div class="panel" data-section="form">
          <div class="panel__head">${icon('type')}<h3>Форма</h3><span class="hint">плотность, радиусы, масштаб</span><button class="panel__reset" type="button" data-reset-section="form" title="Сбросить раздел">Сброс</button></div>
          <div class="ctl">
            <div class="ctl__label">Плотность<small>сколько воздуха между строками</small></div>
            <div class="seg" id="seg-density">${segButtons('density', [['compact', 'Компакт'], ['normal', 'Обычно'], ['roomy', 'Просторно']])}</div>
          </div>
          <div class="ctl">
            <div class="ctl__label">Скругления<small>радиус панелей и карточек</small></div>
            <div class="ctl__body">
              <input class="rng" type="range" min="0" max="34" step="1" value="${theme.radius}" data-range="radius" aria-label="Скругления">
              <span class="rng-val" data-val-for="radius">${theme.radius}px</span>
            </div>
          </div>
          <div class="ctl">
            <div class="ctl__label">Шрифт<small>характер подписей и заголовков</small></div>
            <div class="seg" id="seg-font">${segButtons('font', [['ui', 'Обычный'], ['serif', 'Сериф'], ['mono', 'Моно'], ['rounded', 'Округлый'], ['condensed', 'Узкий']])}</div>
          </div>
          <div class="ctl">
            <div class="ctl__label">Размер интерфейса<small>масштаб всего окна</small></div>
            <div class="ctl__body">
              <input class="rng" type="range" min="85" max="120" step="5" value="${theme.uiScale}" data-range="uiScale" aria-label="Размер интерфейса">
              <span class="rng-val" data-val-for="uiScale">${theme.uiScale}%</span>
            </div>
          </div>
        </div>

        <div class="panel" data-section="grid">
          <div class="panel__head">${icon('grid')}<h3>Карточки и обложки</h3><span class="hint">сетка, размер, форма</span><button class="panel__reset" type="button" data-reset-section="grid" title="Сбросить раздел">Сброс</button></div>
          <div class="ctl">
            <div class="ctl__label">Обложки<small>размер карточек</small></div>
            <div class="seg" id="seg-cards">${segButtons('cards', [['s', 'S'], ['m', 'M'], ['l', 'L']])}</div>
          </div>
          <div class="ctl">
            <div class="ctl__label">Карточек в ряд<small>сетка на широком экране</small></div>
            <div class="seg" id="seg-cols">${segButtons('cols', [['auto', 'Авто'], ['3', '3'], ['4', '4'], ['5', '5'], ['6', '6']])}</div>
          </div>
          <div class="ctl">
            <div class="ctl__label">Скругление обложки<small>только у картинки трека</small></div>
            <div class="ctl__body">
              <input class="rng" type="range" min="0" max="34" step="1" value="${theme.coverRadius}" data-range="coverRadius" aria-label="Скругление обложки">
              <span class="rng-val" data-val-for="coverRadius">${theme.coverRadius}px</span>
            </div>
          </div>
        </div>

        <div class="panel" data-section="lyrics">
          <div class="panel__head">${icon('type')}<h3>Блок текста песни</h3><span class="hint">панель в полноэкранном</span><button class="panel__reset" type="button" data-reset-section="lyrics" title="Сбросить раздел">Сброс</button></div>
          <div class="ctl">
            <div class="ctl__label">Размер текста<small>кегль самих строк</small></div>
            <div class="ctl__body">
              <input class="rng" type="range" min="85" max="150" step="5" value="${theme.lyricsSize}" data-range="lyricsSize" aria-label="Размер текста песни">
              <span class="rng-val" data-val-for="lyricsSize">${theme.lyricsSize}%</span>
            </div>
          </div>
          <div class="ctl">
            <div class="ctl__label">Текст сразу<small>открывать при входе в полноэкранный</small></div>
            <label class="toggle"><input type="checkbox" data-toggle="lyricsAuto" ${theme.lyricsAuto ? 'checked' : ''}><span class="toggle__track"></span></label>
          </div>
          <div class="ctl">
            <div class="ctl__label">Ширина блока<small>сколько места занимает панель</small></div>
            <div class="ctl__body">
              <input class="rng" type="range" min="40" max="100" step="5" value="${theme.lyricsBox?.width ?? 100}" data-lyrbox="width" aria-label="Ширина блока текста">
              <span class="rng-val" data-val-for="lyrbox-width">${theme.lyricsBox?.width ?? 100}%</span>
            </div>
          </div>
          <div class="ctl">
            <div class="ctl__label">Высота блока<small>предел высоты панели</small></div>
            <div class="ctl__body">
              <input class="rng" type="range" min="30" max="90" step="5" value="${theme.lyricsBox?.height ?? 72}" data-lyrbox="height" aria-label="Высота блока текста">
              <span class="rng-val" data-val-for="lyrbox-height">${theme.lyricsBox?.height ?? 72}%</span>
            </div>
          </div>
          <div class="ctl">
            <div class="ctl__label">Скругление панели<small>форма самого блока</small></div>
            <div class="ctl__body">
              <input class="rng" type="range" min="0" max="40" step="2" value="${theme.lyricsBox?.radius ?? 22}" data-lyrbox="radius" aria-label="Скругление панели текста">
              <span class="rng-val" data-val-for="lyrbox-radius">${theme.lyricsBox?.radius ?? 22}px</span>
            </div>
          </div>
          <div class="ctl">
            <div class="ctl__label">Размытие подложки<small>стекло за текстом</small></div>
            <div class="ctl__body">
              <input class="rng" type="range" min="0" max="40" step="2" value="${theme.lyricsBox?.blur ?? 0}" data-lyrbox="blur" aria-label="Размытие подложки текста">
              <span class="rng-val" data-val-for="lyrbox-blur">${theme.lyricsBox?.blur ?? 0}px</span>
            </div>
          </div>
          <div class="ctl">
            <div class="ctl__label">Прозрачность фона<small>насколько виден фон под панелью</small></div>
            <div class="ctl__body">
              <input class="rng" type="range" min="0" max="100" step="5" value="${theme.lyricsBox?.opacity ?? 100}" data-lyrbox="opacity" aria-label="Прозрачность фона панели">
              <span class="rng-val" data-val-for="lyrbox-opacity">${theme.lyricsBox?.opacity ?? 100}%</span>
            </div>
          </div>
          <div class="ctl">
            <div class="ctl__label">Внутренние отступы<small>плотность текста внутри</small></div>
            <div class="ctl__body">
              <input class="rng" type="range" min="0" max="48" step="2" value="${theme.lyricsBox?.pad ?? 18}" data-lyrbox="pad" aria-label="Отступы панели текста">
              <span class="rng-val" data-val-for="lyrbox-pad">${theme.lyricsBox?.pad ?? 18}px</span>
            </div>
          </div>
          <div class="ctl">
            <div class="ctl__label">Межстрочный интервал<small>расстояние между строками</small></div>
            <div class="ctl__body">
              <input class="rng" type="range" min="100" max="220" step="5" value="${theme.lyricsBox?.lineHeight ?? 140}" data-lyrbox="lineHeight" aria-label="Межстрочный интервал">
              <span class="rng-val" data-val-for="lyrbox-lineHeight">${theme.lyricsBox?.lineHeight ?? 140}%</span>
            </div>
          </div>
          <div class="ctl">
            <div class="ctl__label">Рамка<small>тонкая обводка вокруг панели</small></div>
            <label class="toggle"><input type="checkbox" data-lyrbox-toggle="border" ${theme.lyricsBox?.border !== false ? 'checked' : ''}><span class="toggle__track"></span></label>
          </div>
          <div class="ctl">
            <div class="ctl__label">Тень<small>мягкая тень под панелью</small></div>
            <label class="toggle"><input type="checkbox" data-lyrbox-toggle="shadow" ${theme.lyricsBox?.shadow !== false ? 'checked' : ''}><span class="toggle__track"></span></label>
          </div>
          <div class="ctl">
            <div class="ctl__label">Выравнивание текста<small>по центру или слева</small></div>
            <div class="seg" id="seg-lyrbox-align">${segButtons('lyrbox-align', [['center', 'Центр'], ['left', 'Слева']])}</div>
          </div>
        </div>

        <div class="panel" data-section="motion">
          <div class="panel__head">${icon('spark')}<h3>Анимации</h3><span class="hint">движение и плавность</span><button class="panel__reset" type="button" data-reset-section="motion" title="Сбросить раздел">Сброс</button></div>

          <div class="ctl">
            <div class="ctl__label">Включить анимации<small>главный выключатель движения</small></div>
            <label class="toggle"><input type="checkbox" data-toggle="anim" ${theme.anim ? 'checked' : ''}><span class="toggle__track"></span></label>
          </div>

          <div class="ctl">
            <div class="ctl__label">Плавный звук<small>нарастание в начале трека</small></div>
            <label class="toggle"><input type="checkbox" data-toggle="crossfade" ${theme.crossfade !== false ? 'checked' : ''}><span class="toggle__track"></span></label>
          </div>

          <div class="ctl">
            <div class="ctl__label">Затухание в конце<small>трек плавно уходит, следующий начинается с нарастания</small></div>
            <div class="ctl__range">
              <input class="rng" type="range" min="1" max="12" step="1" value="${theme.crossfadeSec || 4}" data-range="crossfadeSec" aria-label="Длина затухания">
              <span class="rng-val" data-val-for="crossfadeSec">${theme.crossfadeSec || 4} с</span>
            </div>
          </div>

          <div class="ctl">
            <div class="ctl__label">Визуализатор под бит<small>полоски двигаются по спектру трека</small></div>
            <label class="toggle"><input type="checkbox" data-toggle="beat" ${theme.beat !== false ? 'checked' : ''}><span class="toggle__track"></span></label>
          </div>

          <div class="ctl">
            <div class="ctl__label">Переходы экранов<small>как появляется новый экран</small></div>
            <select class="select" data-select="screenAnim">
              ${['slide', 'fade', 'zoom', 'none'].map((id) => `<option value="${id}" ${(theme.screenAnim || 'slide') === id ? 'selected' : ''}>${{ slide: 'Сдвиг', fade: 'Растворение', zoom: 'Приближение', none: 'Без' }[id]}</option>`).join('')}
            </select>
          </div>

          <div class="ctl">
            <div class="ctl__label">Скорость<small>быстро или спокойно</small></div>
            <select class="select" data-select="speed">
              ${['slow', 'normal', 'fast'].map((id) => `<option value="${id}" ${(theme.speed || 'normal') === id ? 'selected' : ''}>${{ slow: 'Спокойно', normal: 'Обычно', fast: 'Быстро' }[id]}</option>`).join('')}
            </select>
          </div>

          <div class="ctl">
            <div class="ctl__label">Наведение на строки<small>подъём и подсветка</small></div>
            <select class="select" data-select="hover">
              ${['lift', 'glow', 'none'].map((id) => `<option value="${id}" ${(theme.hover || 'lift') === id ? 'selected' : ''}>${{ lift: 'Подъём', glow: 'Свечение', none: 'Без' }[id]}</option>`).join('')}
            </select>
          </div>

          <div class="ctl">
            <div class="ctl__label">Обложка при смене трека<small>как появляется новая обложка</small></div>
            <select class="select" data-select="coverAnim">
              ${['fade', 'scale', 'none'].map((id) => `<option value="${id}" ${(theme.coverAnim || 'fade') === id ? 'selected' : ''}>${{ fade: 'Растворение', scale: 'Масштаб', none: 'Без' }[id]}</option>`).join('')}
            </select>
          </div>

          <div class="ctl">
            <div class="ctl__label">Пульсация обложки<small>реагирует на музыку</small></div>
            <label class="toggle"><input type="checkbox" data-toggle="coverPulse" ${theme.coverPulse ? 'checked' : ''}><span class="toggle__track"></span></label>
          </div>

          <p class="footnote">Движение отключается целиком, если в Windows включено «Уменьшение движения».</p>
        </div>

        <div class="panel" data-section="blocks">
          <div class="panel__head">${icon('library')}<h3>Блоки</h3><span class="hint">скрыть и переставить</span><button class="panel__reset" type="button" data-reset-section="blocks" title="Сбросить раздел">Сброс</button></div>
          <div id="block-rows">${blockRows()}</div>
          <p class="footnote">Порядок блоков меняет ленту «Волны»; переключатели скрывают элементы интерфейса целиком.</p>
        </div>
      </div>

    </div>

    ${eqSection()}
  `;
}

/* ------------------------------------------------------------------ */
/* Синхронизация контролов                                             */
/* ------------------------------------------------------------------ */

function bandFill(index) {
  const input = screen.root?.querySelector(`[data-eq-band="${index}"]`);
  const fill = screen.root?.querySelector(`[data-band-fill="${index}"]`);
  if (!input || !fill) return;
  const value = Number(input.value) || 0;
  const percent = Math.min(50, (Math.abs(value) / 12) * 50);
  fill.style.height = `${percent}%`;
  if (value >= 0) {
    fill.style.bottom = '50%';
    fill.style.top = 'auto';
  } else {
    fill.style.top = '50%';
    fill.style.bottom = 'auto';
  }
}

function syncEqChart() {
  const chart = screen.root?.querySelector('.eq-wrap .eq-chart');
  if (!chart) return;
  chart.outerHTML = eqChart(theme.eq.bands);
}

function sync() {
  if (!screen.root) return;
  const root = screen.root;

  // сегменты
  for (const button of root.querySelectorAll('[data-t]')) {
    const key = button.dataset.t;
    if (key === 'accent-auto') {
      button.classList.toggle('on', theme.accentAuto);
      continue;
    }
    if (key === 'accent') {
      button.classList.toggle('on', !theme.accentAuto && button.dataset.v?.toLowerCase() === theme.accent.toLowerCase());
      continue;
    }
    // вложенная настройка выравнивания текста
    if (key === 'lyrbox-align') {
      button.classList.toggle('on', (theme.lyricsBox?.align || 'center') === button.dataset.v);
      continue;
    }
    button.classList.toggle('on', String(theme[key]) === String(button.dataset.v));
  }

  // диапазоны темы
  for (const input of root.querySelectorAll('[data-range]')) {
    const key = input.dataset.range;
    if (document.activeElement !== input) input.value = theme[key];
    const out = root.querySelector(`[data-val-for="${key}"]`);
    if (out) out.textContent = key === 'lyricsSize' ? `${theme[key]}%` : `${theme[key]}px`;
    input.style.setProperty('--p', `${((Number(theme[key]) - Number(input.min)) / (Number(input.max) - Number(input.min))) * 100}%`);
  }

  // переключатели и цвет
  for (const input of root.querySelectorAll('[data-toggle]')) {
    const key = input.dataset.toggle;
    input.checked = !!theme[key];
  }
  for (const input of root.querySelectorAll('[data-color="accent"]')) {
    if (document.activeElement !== input) input.value = theme.accent;
  }

  // акцент-подпись и обои
  const accentHint = root.querySelector('#accent-hint');
  if (accentHint) accentHint.textContent = theme.accentAuto ? 'автоматически из обложки' : 'свой цвет';
  for (const tile of root.querySelectorAll('[data-wall]')) {
    const active = tile.dataset.wall === 'upload' ? theme.wallpaper === 'custom' : tile.dataset.wall === theme.wallpaper;
    tile.classList.toggle('on', active);
  }
  for (const presetButton of root.querySelectorAll('[data-preset]')) {
    const preset = PRESETS.find((item) => item.id === presetButton.dataset.preset);
    const matches = !!preset
      && preset.variant === theme.variant
      && preset.scheme === theme.scheme
      && !theme.accentAuto
      && preset.accent.toLowerCase() === theme.accent.toLowerCase()
      && preset.wallpaper === theme.wallpaper;
    presetButton.classList.toggle('on', matches);
  }

  // блоки
  for (const input of root.querySelectorAll('[data-block]')) {
    input.checked = !!theme.blocks[input.dataset.block];
  }
  const orderKey = theme.blockOrder.join(',');
  if (screen.lastOrder !== orderKey) {
    const rows = root.querySelector('#block-rows');
    if (rows) rows.innerHTML = blockRows();
    screen.lastOrder = orderKey;
  } else {
    for (const button of root.querySelectorAll('[data-block-move]')) {
      const index = theme.blockOrder.indexOf(button.dataset.blockMove);
      button.disabled = button.dataset.dir === '-1' ? index <= 0 : index === theme.blockOrder.length - 1;
    }
  }

  // предпросмотр
  const preview = root.querySelector('#theme-preview');
  if (preview) preview.innerHTML = previewHtml();

  // эквалайзер
  const wrap = root.querySelector('#eq-section');
  if (wrap) wrap.classList.toggle('is-off', !theme.eq.on);
  for (const input of root.querySelectorAll('[data-eq-band]')) {
    const index = Number(input.dataset.eqBand);
    const value = theme.eq.bands[index] ?? 0;
    if (document.activeElement !== input) input.value = value;
    const label = root.querySelector(`[data-band-val="${index}"]`);
    if (label) {
      label.textContent = value > 0 ? `+${value}` : String(value);
      label.classList.toggle('is-neg', value < 0);
    }
    bandFill(index);
  }
  const preamp = root.querySelector('[data-eq-preamp]');
  if (preamp) {
    if (document.activeElement !== preamp) preamp.value = theme.eq.preamp;
    preamp.style.setProperty('--p', `${((Number(preamp.value) - Number(preamp.min)) / (Number(preamp.max) - Number(preamp.min))) * 100}%`);
  }
  const preampVal = root.querySelector('#eq-preamp-val');
  if (preampVal) preampVal.textContent = `${theme.eq.preamp > 0 ? '+' : ''}${theme.eq.preamp} dB`;
  for (const button of root.querySelectorAll('[data-eq-preset]')) {
    button.classList.toggle('on', button.dataset.eqPreset === theme.eq.preset);
  }
  const eqState = root.querySelector('#eq-state');
  if (eqState) {
    eqState.textContent = theme.eq.preset === 'custom'
      ? 'Своя настройка'
      : `Профиль: ${(EQ_PRESETS[theme.eq.preset] || {}).name || 'Плоский'}`;
  }
  const eqToggle = root.querySelector('[data-eq-on]');
  if (eqToggle) eqToggle.checked = theme.eq.on;

  syncEqChart();
}

/* ------------------------------------------------------------------ */
/* Действия                                                            */
/* ------------------------------------------------------------------ */

function applyAccent(color) {
  theme.accentAuto = false;
  update('accent', color);
}

function exportFile() {
  const data = JSON.stringify(exportTheme(), null, 2);
  const blob = new Blob([data], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'labsoul-theme.json';
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  toast('Тема выгружена в labsoul-theme.json', { icon: 'download' });
}

function openImport() {
  openModal({
    title: 'Импорт темы',
    body: `<p>Вставьте JSON, полученный из «Экспорта темы». Порядок блоков, эквалайзер и обои тоже перенесутся.</p>
      <p style="margin-top:10px"><textarea id="theme-import-text" placeholder='{"variant":"glass","scheme":"dark",...}' spellcheck="false"></textarea></p>`,
    okLabel: 'Применить',
    onOk: () => {
      const area = document.getElementById('theme-import-text');
      const raw = area ? area.value.trim() : '';
      if (!raw) { toast('Вставьте JSON темы', { type: 'warn' }); return false; }
      try {
        importTheme(raw);
        sync();
        toast('Тема импортирована', { icon: 'check' });
        return true;
      } catch (err) {
        toast(`Не удалось разобрать JSON: ${err?.message || 'ошибка'}`, { type: 'err', duration: 5000 });
        return false;
      }
    },
  });
}

function openReset() {
  openModal({
    title: 'Сбросить оформление',
    body: `<p>Вернуть пресет «Полночь», стандартные радиусы, шрифт, блоки и плоский эквалайзер?</p>
      <p>Избранное и история не пострадают — это только настройки внешнего вида.</p>`,
    okLabel: 'Сбросить',
    onOk: () => {
      resetTheme();
      sync();
      toast('Настройки оформления сброшены', { icon: 'refresh' });
      return true;
    },
  });
}

function applyPresetById(id) {
  if (!applyPreset(id)) return;
  sync();
  const preset = PRESETS.find((p) => p.id === id);
  toast(`Тема «${preset?.name || id}»`, { icon: 'spark' });
}

function moveBlock(id, dir) {
  const index = theme.blockOrder.indexOf(id);
  const target = index + dir;
  if (index < 0 || target < 0 || target >= theme.blockOrder.length) return;
  const next = [...theme.blockOrder];
  [next[index], next[target]] = [next[target], next[index]];
  update('blockOrder', next);
  sync();
}

function handleWallUpload(file) {
  if (!file) return;
  if (file.size > 6 * 1024 * 1024) {
    toast('Картинка больше 6 МБ — выберите файл поменьше', { type: 'warn' });
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    const result = setCustomWallpaper(String(reader.result || ''));
    sync();
    toast(result.persisted
      ? 'Свои обои установлены'
      : 'Обои применены на эту сессию — не поместились в localStorage', {
      type: result.persisted ? 'ok' : 'warn',
      icon: 'image',
    });
  };
  reader.onerror = () => toast('Не удалось прочитать файл', { type: 'err' });
  reader.readAsDataURL(file);
}

/** Активный раздел оформления — один, чтобы не листать длинную страницу. */
let activeSection = 'look';

function applySection() {
  const root = screen.root;
  if (!root) return;
  for (const block of root.querySelectorAll('[data-section]')) {
    block.hidden = block.dataset.section !== activeSection;
  }
  for (const tab of root.querySelectorAll('[data-tab-section]')) {
    const on = tab.dataset.tabSection === activeSection;
    tab.classList.toggle('is-on', on);
    tab.setAttribute('aria-selected', String(on));
  }
}

function onClick(event) {
  const tab = event.target instanceof Element ? event.target.closest('[data-tab-section]') : null;
  if (tab) {
    activeSection = tab.dataset.tabSection;
    applySection();
    return;
  }

  const target = event.target instanceof Element
    ? event.target.closest('[data-preset], [data-t], [data-wall], [data-theme-action], [data-block-move], [data-eq-preset], [data-eq-flat], [data-eq-save]')
    : null;
  if (!target) return;

  if (target.dataset.preset) { applyPresetById(target.dataset.preset); return; }

  if (target.dataset.wall) {
    const wall = target.dataset.wall;
    if (wall === 'upload') {
      screen.root?.querySelector('#wall-upload')?.click();
      return;
    }
    update('wallpaper', wall);
    return;
  }

  if (target.dataset.resetSection) {
    const section = target.dataset.resetSection;
    resetThemeSection(section);
    sync();
    const names = { look: 'Внешний вид', form: 'Форма', grid: 'Карточки', lyrics: 'Блок текста', motion: 'Анимации', blocks: 'Блоки' };
    toast(`Сброшен раздел: ${names[section] || section}`, { icon: 'refresh' });
    return;
  }

  if (target.dataset.themeAction) {
    const act = target.dataset.themeAction;
    if (act === 'export') exportFile();
    else if (act === 'import') openImport();
    else if (act === 'reset') openReset();
    return;
  }

  if (target.dataset.blockMove) {
    moveBlock(target.dataset.blockMove, Number(target.dataset.dir) || 0);
    return;
  }

  if (target.dataset.eqPreset) {
    const preset = EQ_PRESETS[target.dataset.eqPreset];
    if (!preset) return;
    theme.eq.bands = [...preset.bands];
    theme.eq.preset = target.dataset.eqPreset;
    update('eq.preset', target.dataset.eqPreset);
    sync();
    return;
  }
  if (target.hasAttribute('data-eq-flat')) {
    theme.eq.bands = [...EQ_PRESETS.flat.bands];
    theme.eq.preset = 'flat';
    theme.eq.preamp = 0;
    update('eq.preset', 'flat');
    sync();
    toast('Эквалайзер сброшен в «Плоский»', { icon: 'repeat' });
    return;
  }
  if (target.hasAttribute('data-eq-save')) {
    update('eq.preset', theme.eq.preset);
    toast('Настройки эквалайзера сохранены в теме', { icon: 'check' });
    return;
  }

  if (target.dataset.t === 'accent-auto') {
    update('accentAuto', true);
    sync();
    toast('Акцент снова берётся из обложки', { icon: 'spark' });
    return;
  }
  if (target.dataset.t === 'accent') {
    applyAccent(target.dataset.v);
    return;
  }
  // выравнивание текста в блоке хранится во вложенном объекте
  if (target.dataset.t === 'lyrbox-align') {
    update(`lyricsBox.align`, target.dataset.v);
    sync();
    return;
  }
  if (target.dataset.t) {
    update(target.dataset.t, target.dataset.v);
    sync();
  }
}

function onInput(event) {
  const input = event.target;
  if (!(input instanceof HTMLInputElement)) return;

  // Оформление блока текста: ползунки двигаются событием input, поэтому
  // ветка должна быть здесь, а не только в onChange — иначе при
  // перетаскивании ничего не менялось.
  if (input.dataset.lyrbox) {
    const key = input.dataset.lyrbox;
    const value = clamp(Number(input.value), Number(input.min), Number(input.max));
    update(`lyricsBox.${key}`, value);
    const out = screen.root?.querySelector(`[data-val-for="lyrbox-${key}"]`);
    if (out) out.textContent = key === 'width' ? `${value}%` : `${value}px`;
    return;
  }

  if (input.dataset.range) {
    const key = input.dataset.range;
    update(key, clamp(Number(input.value), Number(input.min), Number(input.max)));
    const out = screen.root?.querySelector(`[data-val-for="${key}"]`);
    // у каждого параметра своя единица: пиксели, проценты или секунды
    if (out) out.textContent = rangeLabel(key, input.value);
    input.style.setProperty('--p', `${((Number(input.value) - Number(input.min)) / (Number(input.max) - Number(input.min))) * 100}%`);
    return;
  }

  if (input.dataset.color === 'accent') {
    theme.accentAuto = false;
    update('accent', input.value);
    sync();
    return;
  }

  if (input.dataset.eqBand !== undefined) {
    const index = Number(input.dataset.eqBand);
    if (!Number.isInteger(index) || index < 0 || index > 9) return;
    theme.eq.bands[index] = clamp(Number(input.value), -12, 12);
    theme.eq.preset = 'custom';
    update('eq.preset', 'custom');
    const label = screen.root?.querySelector(`[data-band-val="${index}"]`);
    if (label) {
      label.textContent = Number(input.value) > 0 ? `+${input.value}` : input.value;
      label.classList.toggle('is-neg', Number(input.value) < 0);
    }
    bandFill(index);
    syncEqChart();
    for (const button of screen.root?.querySelectorAll('[data-eq-preset]') || []) button.classList.remove('on');
    const eqState = screen.root?.querySelector('#eq-state');
    if (eqState) eqState.textContent = 'Своя настройка';
    return;
  }

  if (input.dataset.eqPreamp !== undefined) {
    update('eq.preamp', clamp(Number(input.value), -6, 6));
    const out = screen.root?.querySelector('#eq-preamp-val');
    if (out) out.textContent = `${Number(input.value) > 0 ? '+' : ''}${input.value} dB`;
    input.style.setProperty('--p', `${((Number(input.value) - Number(input.min)) / (Number(input.max) - Number(input.min))) * 100}%`);
  }
}

/** Подпись значения ползунка с правильной единицей измерения. */
function rangeLabel(key, value) {
  if (key === 'lyricsSize' || key === 'uiScale') return `${value}%`;
  if (key === 'crossfadeSec') return `${value} с`;
  return `${value}px`;
}

function onChange(event) {
  const input = event.target;

  // выпадающие списки раздела «Анимации»: раньше они отсекались проверкой
  // на HTMLInputElement и настройка не применялась вовсе
  if (input instanceof HTMLSelectElement && input.dataset.select) {
    update(input.dataset.select, input.value);
    return;
  }

  if (!(input instanceof HTMLInputElement)) return;

  if (input.id === 'wall-upload' && input.files?.[0]) {
    handleWallUpload(input.files[0]);
    input.value = '';
    return;
  }
  if (input.dataset.toggle) {
    update(input.dataset.toggle, input.checked);
    return;
  }
  // оформление панели текста: ширина, скругление, размытие, отступы, рамка, тень
  if (input.dataset.lyrbox) {
    const key = input.dataset.lyrbox;
    const value = clamp(Number(input.value), Number(input.min), Number(input.max));
    update(`lyricsBox.${key}`, value);
    const label = document.querySelector(`[data-val-for="lyrbox-${key}"]`);
    if (label) label.textContent = key === 'width' ? `${value}%` : `${value}px`;
    return;
  }
  if (input.dataset.lyrboxToggle) {
    update(`lyricsBox.${input.dataset.lyrboxToggle}`, input.checked);
    return;
  }
  if (input.dataset.block) {
    update(`blocks.${input.dataset.block}`, input.checked);
    return;
  }
  if (input.hasAttribute('data-eq-on')) {
    update('eq.on', input.checked);
    toast(input.checked ? 'Эквалайзер включён' : 'Эквалайзер выключен', { icon: 'eq' });
  }
}

/* ------------------------------------------------------------------ */
/* Экран                                                               */
/* ------------------------------------------------------------------ */

export const designScreen = {
  id: 'design',
  title: 'Оформление',

  render(container) {
    container.innerHTML = shellHtml();
  },

  mount(container) {
    screen.root = container;
    screen.lastOrder = theme.blockOrder.join(',');
    applySection();
    container.addEventListener('click', onClick);
    container.addEventListener('input', onInput);
    container.addEventListener('change', onChange);

    const unsubTheme = themeSubscribe(() => sync());
    const unsubPlayer = player.subscribe((_snap, event) => {
      if (event === 'track' || event === 'init') sync();
    });
    screen.unsubs.push(unsubTheme, unsubPlayer, () => {
      container.removeEventListener('click', onClick);
      container.removeEventListener('input', onInput);
      container.removeEventListener('change', onChange);
    });

    sync();
    for (let i = 0; i < 10; i += 1) bandFill(i);
  },

  destroy() {
    for (const off of screen.unsubs.splice(0)) {
      try { off(); } catch { /* ignore */ }
    }
    screen.root = null;
  },
};

export default designScreen;
