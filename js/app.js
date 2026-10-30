/* =========================================================
   Яндекс Музыка — редизайн: прототип
   Логика: состояние темы, страницы, плеер
   ========================================================= */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const icon = (n) => `<svg viewBox="0 0 24 24" aria-hidden="true"><use href="#i-${n}"></use></svg>`;

/* ---------------- данные (демо) ---------------- */

const TRACKS = [
  { id: 't1', title: 'Северный ветер', artist: 'Мельница', album: 'Зов крови', dur: '4:12', src: 'ya', art: ['#6ea8ff', '#2b4b8f', '#ffd23f'] },
  { id: 't2', title: 'Ночной эфир', artist: 'Дельфин', album: 'Юность', dur: '3:48', src: 'ya', art: ['#ff8a5c', '#7a2e3d', '#ffd23f'] },
  { id: 't3', title: 'Тишина', artist: 'Каспийский груз', album: '18+', dur: '3:21', src: 'ya', art: ['#12e0c8', '#0b3d3d', '#9ff3e0'] },
  { id: 't4', title: 'Glass Horizon', artist: 'Nuera', album: 'After Hours', dur: '5:04', src: 'sp', art: ['#b46bff', '#2a1040', '#ff4d6d'] },
  { id: 't5', title: 'Paper Planes (live)', artist: 'lowkey', album: 'Bedroom Tapes', dur: '2:57', src: 'sc', art: ['#ffd23f', '#8a5a10', '#fff3c4'] },
  { id: 't6', title: 'Город спит', artist: 'Пасош', album: 'Лондон', dur: '3:33', src: 'ya', art: ['#4be08b', '#0f3a2a', '#c9ffdf'] },
  { id: 't7', title: 'Slow Motion', artist: 'Три дня дождя', album: 'Байполар', dur: '4:41', src: 'ya', art: ['#5c7cff', '#1b1b3a', '#d8b4ff'] },
  { id: 't8', title: 'Amber Room', artist: 'Kamila', album: 'Rooms', dur: '3:12', src: 'sp', art: ['#ffb36b', '#5a2d10', '#ffe3b0'] },
];

const COLLECTION = [
  { id: 'p1', title: 'Для ночной дороги', sub: 'Плейлист · 42 трека', art: ['#6ea8ff', '#1b2340', '#ffd23f'] },
  { id: 'p2', title: 'Инди 2026', sub: 'Плейлист · 84 трека', art: ['#ff8a5c', '#3a1a2e', '#ffd23f'] },
  { id: 'p3', title: 'Фокус', sub: 'Плейлист · 116 треков', art: ['#12e0c8', '#062a2a', '#9ff3e0'] },
  { id: 'p4', title: 'Русский рэп', sub: 'Плейлист · 208 треков', art: ['#b46bff', '#241038', '#ff4d6d'] },
  { id: 'p5', title: 'Спокойное утро', sub: 'Плейлист · 61 трек', art: ['#ffd23f', '#4a3a0e', '#fff3c4'] },
  { id: 'p6', title: 'Электроника', sub: 'Плейлист · 133 трека', art: ['#4be08b', '#0c3324', '#c9ffdf'] },
];

const ALBUMS = [
  { id: 'a1', title: 'After Hours', sub: 'Nuera · 2026', art: ['#b46bff', '#1c0f2e', '#ff4d6d'] },
  { id: 'a2', title: 'Зов крови', sub: 'Мельница · 2006', art: ['#6ea8ff', '#16233f', '#ffd23f'] },
  { id: 'a3', title: 'Bedroom Tapes', sub: 'lowkey · 2025', art: ['#ffd23f', '#6a4a10', '#fff3c4'] },
  { id: 'a4', title: 'Юность', sub: 'Дельфин · 2007', art: ['#ff8a5c', '#401a22', '#ffd25c'] },
  { id: 'a5', title: 'Rooms', sub: 'Kamila · 2026', art: ['#ffb36b', '#4a2410', '#ffe3b0'] },
  { id: 'a6', title: 'Лондон', sub: 'Пасош · 2024', art: ['#4be08b', '#0b2e22', '#c9ffdf'] },
];

const SC_RESULTS = [
  { id: 's1', title: 'Paper Planes (live)', artist: 'lowkey', dur: '2:57', plays: '1.2M', found: true, art: ['#ffd23f', '#7a4a10', '#fff3c4'] },
  { id: 's2', title: 'Tokyo Rain', artist: 'Miya', dur: '4:08', plays: '640K', found: true, art: ['#6ea8ff', '#22304f', '#cfe3ff'] },
  { id: 's3', title: 'unreleased demo #4', artist: 'nobody', dur: '1:44', plays: '2.1K', found: false, art: ['#12e0c8', '#0a2b2b', '#9ff3e0'] },
  { id: 's4', title: 'Cold Bloom', artist: 'Static Youth', dur: '3:36', plays: '88K', found: true, art: ['#b46bff', '#2a1040', '#ff4d6d'] },
  { id: 's5', title: 'Haze (bootleg)', artist: 'kirill', dur: '5:12', plays: '14K', found: false, art: ['#ff8a5c', '#3a1620', '#ffd25c'] },
];

const WALLS = [
  { id: 'cover', name: 'Из обложки', cls: 'wp--cover' },
  { id: 'aurora', name: 'Аврора', cls: 'wp--aurora' },
  { id: 'sunset', name: 'Закат', cls: 'wp--sunset' },
  { id: 'ocean', name: 'Океан', cls: 'wp--ocean' },
  { id: 'solid', name: 'Цвет темы', cls: 'wp--solid' },
  { id: 'none', name: 'Без фона', cls: 'wp--none' },
];

const ACCENTS = ['#ffd23f', '#ff8a5c', '#ff4d6d', '#b46bff', '#6ea8ff', '#12e0c8', '#4be08b', '#f3efe7'];

const VARIANTS = {
  glass: { radius: 22, blur: 24 },
  vinyl: { radius: 6, blur: 0 },
  neon: { radius: 14, blur: 14 },
  paper: { radius: 26, blur: 8 },
};

const PRESETS = [
  { id: 'midnight', name: 'Полночь', variant: 'glass', scheme: 'dark', accent: '#ffd23f', wallpaper: 'cover', radius: 22, blur: 24, swatch: 'linear-gradient(135deg,#ffd23f,#6ea8ff)' },
  { id: 'vinyl', name: 'Пластинка', variant: 'vinyl', scheme: 'dark', accent: '#d8a24a', wallpaper: 'solid', radius: 6, blur: 0, swatch: 'linear-gradient(135deg,#d8a24a,#2a1f14)' },
  { id: 'club', name: 'Клуб', variant: 'neon', scheme: 'dark', accent: '#b46bff', wallpaper: 'solid', radius: 14, blur: 14, swatch: 'linear-gradient(135deg,#b46bff,#12e0c8)' },
  { id: 'paper', name: 'Бумага', variant: 'paper', scheme: 'light', accent: '#ff5a5f', wallpaper: 'solid', radius: 26, blur: 8, swatch: 'linear-gradient(135deg,#ff5a5f,#f3efe7)' },
  { id: 'amoled', name: 'AMOLED', variant: 'glass', scheme: 'amoled', accent: '#00e0a4', wallpaper: 'none', radius: 16, blur: 20, swatch: 'linear-gradient(135deg,#00e0a4,#000)' },
];

/* ---------------- состояние ---------------- */

const DEFAULTS = {
  variant: 'glass', scheme: 'dark', accent: '#ffd23f', accentAuto: true,
  wallpaper: 'cover', density: 'normal', radius: 22, blur: 24,
  grain: true, anim: true, font: 'ui', cards: 'm',
  heading: null, txt: null, dimc: null,
  cols: 'auto',
  blocks: {
    hero: true, shelf1: true, shelf2: true, trend: true,
    sbLib: true, plLike: true, plProgress: true, plVol: true,
  },
  blockOrder: ['hero', 'shelf1', 'shelf2', 'trend'],
  eq: { on: true, preamp: 0, preset: 'flat', bands: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
  quality: 'best',
  page: 'home', track: 0, playing: true, liked: ['t2'],
  scAdded: [], progress: 38,
};

const BLOCKS_UI = [
  { id: 'hero', name: 'Блок «Моя волна»', sub: 'главный экран', order: true },
  { id: 'shelf1', name: 'Полка «Снова в строю»', sub: 'плейлисты', order: true },
  { id: 'shelf2', name: 'Полка «Новые релизы»', sub: 'альбомы', order: true },
  { id: 'trend', name: 'Чарт «Сейчас в тренде»', sub: 'треки', order: true },
  { id: 'sbLib', name: 'Библиотека в сайдбаре' },
  { id: 'plLike', name: 'Кнопка «Нравится» в плеере' },
  { id: 'plProgress', name: 'Полоса прогресса' },
  { id: 'plVol', name: 'Громкость и источник' },
];

let S = { ...DEFAULTS };
let customWall = null;

/* параметры URL для скриншотов: ?v=vinyl&page=theme */
const qp = new URLSearchParams(location.search);
if (qp.get('v')) { S.variant = qp.get('v'); Object.assign(S, VARIANTS[qp.get('v')] || {}); }
if (qp.get('page')) S.page = qp.get('page');
if (qp.get('scheme')) S.scheme = qp.get('scheme');
if (qp.get('wall')) S.wallpaper = qp.get('wall');
if (qp.get('preset')) {
  const p = PRESETS.find((x) => x.id === qp.get('preset'));
  if (p) Object.assign(S, { variant: p.variant, scheme: p.scheme, accent: p.accent, accentAuto: false, wallpaper: p.wallpaper, radius: p.radius, blur: p.blur });
}

if (!qp.get('v') && !qp.get('preset')) {
  try {
    const saved = JSON.parse(localStorage.getItem('ym-theme') || 'null');
    if (saved) {
      S = {
        ...S, ...saved, page: 'home',
        blocks: { ...DEFAULTS.blocks, ...(saved.blocks || {}) },
        eq: { ...DEFAULTS.eq, ...(saved.eq || {}) },
        blockOrder: Array.isArray(saved.blockOrder) && saved.blockOrder.length ? saved.blockOrder : DEFAULTS.blockOrder,
      };
    }
  } catch (e) { /* ignore */ }
}

const save = () => { try { localStorage.setItem('ym-theme', JSON.stringify({ ...S, page: 'home' })); } catch (e) {} };

/* режим встраивания в отдельное окно настроек Electron */
const EMBED = qp.get('embed') === '1';

const getPath = (obj, path) => path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
function setPath(obj, path, val) {
  const keys = path.split('.');
  const last = keys.pop();
  const target = keys.reduce((o, k) => (o[k] ??= {}), obj);
  target[last] = val;
}

/* ---------------- утилиты ---------------- */

function hexToRgb(hex) {
  const h = hex.replace('#', '');
  const n = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const v = parseInt(n, 16);
  return { r: (v >> 16) & 255, g: (v >> 8) & 255, b: v & 255 };
}
function luminance(hex) {
  const { r, g, b } = hexToRgb(hex);
  const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
const onAccent = (hex) => (luminance(hex) > 0.42 ? '#14130f' : '#ffffff');
const mix = (hex, pct, withColor = 'transparent') => `color-mix(in srgb, ${hex} ${pct}%, ${withColor})`;

function wallpaperCss() {
  const t = TRACKS[S.track];
  const [a, b] = t.art;
  const veil = S.scheme === 'light'
    ? 'linear-gradient(rgba(252,248,240,.55), rgba(252,248,240,.70))'
    : 'linear-gradient(rgba(5,5,9,.46), rgba(5,5,9,.66))';
  let layers;
  switch (S.wallpaper) {
    case 'cover':
      layers = `radial-gradient(70% 55% at 14% 6%, ${mix(a, 70)} 0%, transparent 62%),
              radial-gradient(60% 60% at 88% 18%, ${mix(b, 80)} 0%, transparent 65%),
              linear-gradient(165deg, ${mix(a, 24)}, transparent 55%)`;
      break;
    case 'aurora':
      layers = 'radial-gradient(80% 60% at 20% 0%, rgba(27,107,90,.9), transparent 60%), radial-gradient(70% 60% at 80% 10%, rgba(216,255,107,.35), transparent 60%), linear-gradient(160deg,#050816,#071a19 60%,#0b2c26)';
      break;
    case 'sunset':
      layers = 'radial-gradient(70% 60% at 15% 0%, rgba(255,95,109,.6), transparent 60%), radial-gradient(60% 70% at 90% 15%, rgba(255,195,113,.45), transparent 65%), linear-gradient(160deg,#1a0b23,#3d1430 55%,#5a2038)';
      break;
    case 'ocean':
      layers = 'radial-gradient(70% 60% at 18% 0%, rgba(11,110,122,.85), transparent 62%), radial-gradient(60% 60% at 85% 12%, rgba(159,243,224,.3), transparent 60%), linear-gradient(160deg,#021019,#032430 60%,#04313a)';
      break;
    case 'custom':
      return customWall ? `linear-gradient(rgba(0,0,0,.35), rgba(0,0,0,.35)), url("${customWall}")` : 'none';
    case 'none':
    case 'solid':
    default:
      return 'none';
  }
  return `${veil}, ${layers}`;
}

/* ---------------- тема ---------------- */

function applyTheme() {
  const b = document.body;
  b.dataset.variant = S.variant;
  b.dataset.scheme = S.scheme;
  b.dataset.density = S.density;
  b.dataset.font = S.font;
  b.dataset.anim = S.anim ? 'on' : 'off';
  b.dataset.playing = S.playing ? 'true' : 'false';

  b.style.setProperty('--radius', S.radius + 'px');
  b.style.setProperty('--blur', S.blur + 'px');
  b.style.setProperty('--grain', S.grain ? '' : '0');
  b.style.setProperty('--card-min', ({ s: '150px', m: '172px', l: '196px' })[S.cards] || '172px');

  const t = TRACKS[S.track];
  const accent = S.accentAuto ? t.art[2] : S.accent;
  b.style.setProperty('--accent', accent);
  b.style.setProperty('--on-accent', onAccent(accent));
  b.style.setProperty('--wp', wallpaperCss());
  b.style.setProperty('--art-a', t.art[0]);
  b.style.setProperty('--art-b', t.art[1]);
  b.style.setProperty('--art-c', t.art[2]);

  b.style.setProperty('--cols', S.cols === 'auto' ? 'auto-fill' : String(S.cols));
  if (S.heading) b.style.setProperty('--heading', S.heading); else b.style.removeProperty('--heading');
  if (S.txt) b.style.setProperty('--text', S.txt); else b.style.removeProperty('--text');
  if (S.dimc) b.style.setProperty('--dim', S.dimc); else b.style.removeProperty('--dim');

  b.classList.toggle('hide-sb-lib', !S.blocks.sbLib);
  b.classList.toggle('hide-pl-like', !S.blocks.plLike);
  b.classList.toggle('hide-pl-progress', !S.blocks.plProgress);
  b.classList.toggle('hide-pl-vol', !S.blocks.plVol);
  b.dataset.embed = EMBED ? '1' : '0';
}

function syncControls() {
  $$('[data-key]').forEach((el) => {
    const key = el.dataset.key;
    const val = el.dataset.val;
    const isOn = String(S[key]) === String(val);
    if (el.classList.contains('sw')) el.classList.toggle('on', isOn || (key === 'accent' && S.accentAuto && val === 'auto'));
    else el.classList.toggle('on', isOn);
  });
  $$('[data-range]').forEach((el) => {
    const key = el.dataset.range;
    if (document.activeElement !== el) el.value = S[key];
    const out = el.parentElement.querySelector('.rng-val');
    if (out) out.textContent = el.value + 'px';
  });
  $$('[data-toggle]').forEach((el) => {
    el.checked = !!getPath(S, el.dataset.toggle);
  });
  $$('[data-color]').forEach((el) => {
    const v = S[el.dataset.color];
    if (v && document.activeElement !== el) el.value = v;
  });
  $$('[data-block]').forEach((el) => { el.checked = !!S.blocks[el.dataset.block]; });
  $$('.eq-preset').forEach((b) => b.classList.toggle('on', S.eq.preset === b.dataset.val));
  const auto = $('.sw--auto');
  if (auto) auto.classList.toggle('on', S.accentAuto);
  const code = $('[data-code]');
  if (code) {
    code.innerHTML = `
      <div class="code-line"><span>--accent</span><b>${(S.accentAuto ? TRACKS[S.track].art[2] : S.accent)}</b></div>
      <div class="code-line"><span>--variant</span><b>${S.variant}</b></div>
      <div class="code-line"><span>--scheme</span><b>${S.scheme}</b></div>
      <div class="code-line"><span>--radius</span><b>${S.radius}px</b></div>
      <div class="code-line"><span>--blur</span><b>${S.blur}px</b></div>
      <div class="code-line"><span>--wallpaper</span><b>${S.wallpaper}</b></div>`;
  }
}

/* ---------------- общая оболочка ---------------- */

function renderShell() {
  const b = document.body;
  b.style.setProperty('--art-a', '#6ea8ff');

  $('#app').innerHTML = `
    <aside class="sidebar">
      <div class="brand">
        <div class="brand__mark">${icon('wave')}</div>
        <div class="brand__name">Яндекс<br><span>Музыка</span></div>
      </div>
      <nav class="nav" data-act="navwrap">
        ${[
          ['home', 'home', 'Главная'],
          ['wave', 'wave', 'Моя волна'],
          ['collection', 'library', 'Коллекция'],
          ['soundcloud', 'cloud', 'SoundCloud', 'soon'],
        ].map(([p, ic, name, tag]) => `
          <button class="nav__item${S.page === p ? ' is-active' : ''}" data-act="page" data-val="${p}">
            ${icon(ic)}<span>${name}</span>${tag ? `<i class="nav__badge">new</i>` : ''}
          </button>`).join('')}
        <button class="nav__item${S.page === 'theme' ? ' is-active' : ''}" data-act="page" data-val="theme">
          ${icon('palette')}<span>Оформление</span>
        </button>
        <button class="nav__item${S.page === 'eq' ? ' is-active' : ''}" data-act="page" data-val="eq">
          ${icon('eq')}<span>Эквалайзер</span>${S.eq.on ? '<i class="nav__badge">on</i>' : ''}
        </button>
      </nav>
      <div class="side-sep"></div>
      <div class="side-title">Библиотека</div>
      <div class="side-list">
        ${TRACKS.slice(0, 4).map((t) => `
          <button class="side-list__item" data-act="play" data-id="${t.id}" style="--a:${t.art[0]};--b:${t.art[1]}">
            <i class="side-list__dot"></i>${t.title}
          </button>`).join('')}
      </div>
      <div class="side-foot">
        <span class="side-foot__chip">${icon('spark')}Plus</span>
        <span class="side-foot__chip">${icon('cloud')}2 источника</span>
      </div>
    </aside>

    <section class="main">
      <header class="topbar">
        <div class="topbar__nav">
          <button class="iconbtn" title="Назад">${icon('chev-left')}</button>
          <button class="iconbtn" title="Вперёд">${icon('chev-right')}</button>
        </div>
        <label class="search">
          ${icon('search')}
          <input type="text" placeholder="Треки, альбомы, исполнители" aria-label="Поиск">
          <kbd>Ctrl K</kbd>
        </label>
        <div class="topbar__right">
          <div class="stylepick" title="Стиль интерфейса">
            ${Object.keys(VARIANTS).map((v) => `<button class="sp-${'abcd'[Object.keys(VARIANTS).indexOf(v)]}${S.variant === v ? ' on' : ''}" data-act="variant" data-val="${v}" title="${{ glass: 'Стекло', vinyl: 'Пластинка', neon: 'Неон', paper: 'Бумага' }[v]}"></button>`).join('')}
          </div>
          <button class="iconbtn" data-act="scheme" title="Схема: тёмная / светлая / AMOLED">${icon(S.scheme === 'light' ? 'sun' : 'moon')}</button>
          <button class="iconbtn" data-act="page" data-val="theme" title="Оформление">${icon('settings')}</button>
          <div class="avatar">Е</div>
        </div>
      </header>
      <div class="content" id="content"></div>
    </section>

    <footer class="player" id="player"></footer>
    <div class="toast" id="toast"></div>
  `;
}

function renderPlayer() {
  const t = TRACKS[S.track];
  const srcName = { ya: 'Яндекс', sc: 'SoundCloud', sp: 'Spotify' }[t.src];
  $('#player').innerHTML = `
    <div class="pl-now">
      <div class="pl-now__art" style="--a:${t.art[0]};--b:${t.art[1]};--c:${t.art[2]}"></div>
      <div style="min-width:0">
        <p class="pl-now__t">${t.title}</p>
        <p class="pl-now__a">${t.artist}</p>
      </div>
      <button class="row__like${S.liked.includes(t.id) ? ' on' : ''}" data-act="like" data-id="${t.id}" title="Нравится">${icon('heart')}</button>
    </div>
    <div class="pl-center">
      <div class="pl-btns">
        <button class="pl-btn" title="Перемешать">${icon('shuffle')}</button>
        <button class="pl-btn" data-act="prev" title="Предыдущий">${icon('prev')}</button>
        <button class="pl-btn pl-btn--main" data-act="toggle" title="Пуск">${icon(S.playing ? 'pause' : 'play')}</button>
        <button class="pl-btn" data-act="next" title="Следующий">${icon('next')}</button>
        <button class="pl-btn" title="Повтор">${icon('repeat')}</button>
      </div>
      <div class="pl-line">
        <span class="pl-time">${S.playing ? clock(S.progress) : clock(0)}</span>
        <div class="pl-track"><div class="pl-track__fill" id="fill" style="width:${S.progress}%"></div></div>
        <span class="pl-time">${t.dur}</span>
      </div>
    </div>
    <div class="pl-right">
      <div class="pl-eq" title="Играет"><i></i><i></i><i></i><i></i></div>
      <span class="pl-src">${srcName}</span>
      <button class="pl-btn${S.eq.on ? ' on' : ''}" data-act="page" data-val="eq" title="Эквалайзер">${icon('eq')}</button>
      <div class="pl-vol"><div class="pl-vol__fill"></div></div>
      <button class="pl-btn" title="Громкость">${icon('volume')}</button>
    </div>
  `;
}

function clock(pct) {
  const t = TRACKS[S.track].dur.split(':').map(Number);
  const total = t[0] * 60 + t[1];
  const cur = Math.round(total * pct / 100);
  return `${Math.floor(cur / 60)}:${String(cur % 60).padStart(2, '0')}`;
}

/* ---------------- страницы ---------------- */

const HOME_BLOCKS = {
  hero: () => `
  <div class="hero" style="--a:${TRACKS[S.track].art[0]};--b:${TRACKS[S.track].art[1]};--c:${TRACKS[S.track].art[2]}">
    <div class="hero__art"></div>
    <div class="hero__info">
      <div class="hero__kicker">Персонально для вас</div>
      <h2>Моя волна</h2>
      <p class="hero__desc">Бесконечный поток, который подстраивается под настроение. Сегодня: инди, электроника и немного пост-панка.</p>
      <div class="hero__actions">
        <button class="btn btn--accent" data-act="toggle">${icon(S.playing ? 'pause' : 'play')} ${S.playing ? 'Пауза' : 'Слушать'}</button>
        <button class="btn btn--ghost">${icon('shuffle')} Перемешать</button>
        <button class="btn btn--ghost">${icon('heart')} В коллекцию</button>
      </div>
    </div>
  </div>`,
  shelf1: () => `
  <div class="section">
    <div class="section__head"><h3>Снова в строю</h3><button class="more">Все подборки</button></div>
    <div class="grid">${COLLECTION.slice(0, 5).map(cardHtml).join('')}</div>
  </div>`,
  shelf2: () => `
  <div class="section">
    <div class="section__head"><h3>Новые релизы</h3><button class="more">Смотреть все</button></div>
    <div class="grid">${ALBUMS.slice(0, 6).map(cardHtml).join('')}</div>
  </div>`,
  trend: () => `
  <div class="section">
    <div class="section__head"><h3>Сейчас в тренде</h3><button class="more">Чарт</button></div>
    ${rowsHtml(TRACKS.slice(0, 5))}
  </div>`,
};

const pageHome = () => S.blockOrder
  .map((id) => `<div id="blk-${id}"${S.blocks[id] ? '' : ' hidden'}>${HOME_BLOCKS[id] ? HOME_BLOCKS[id]() : ''}</div>`)
  .join('');

function cardHtml(x) {
  return `
    <article class="card" data-act="play" data-id="${(TRACKS.find((t) => t.title === x.title) || {}).id || 't1'}"
             style="--a:${x.art[0]};--b:${x.art[1]};--c:${x.art[2]}">
      <div class="card__art">
        <button class="card__play" tabindex="-1">${icon('play')}</button>
      </div>
      <div>
        <p class="card__title">${x.title}</p>
        <p class="card__sub">${x.sub}</p>
      </div>
    </article>`;
}

function rowsHtml(list) {
  return `<div class="rows">
    ${list.map((t, i) => `
      <div class="row${t.id === TRACKS[S.track].id ? ' is-playing' : ''}" data-act="play" data-id="${t.id}">
        <span class="row__num">${i + 1}</span>
        <div class="row__art" style="--a:${t.art[0]};--b:${t.art[1]};--c:${t.art[2]}"></div>
        <div style="min-width:0">
          <p class="row__title">${t.title}</p>
          <p class="row__artist">${t.artist}</p>
        </div>
        <span class="row__album">${t.album}</span>
        <span class="row__src ${t.src}">${t.src === 'ya' ? 'Яндекс' : t.src === 'sc' ? 'SoundCloud' : 'Spotify'}</span>
        <span class="row__dur">${t.dur}</span>
        <button class="row__like${S.liked.includes(t.id) ? ' on' : ''}" data-act="like" data-id="${t.id}">${icon('heart')}</button>
      </div>`).join('')}
  </div>`;
}

const pageCollection = () => `
  <div class="page-head">
    <div>
      <h1>Коллекция</h1>
      <p>6 плейлистов · 644 трека · 2 источника</p>
    </div>
    <div style="margin-left:auto;display:flex;gap:8px">
      <button class="btn btn--ghost btn--sm">${icon('plus')} Плейлист</button>
      <button class="btn btn--accent btn--sm" data-act="page" data-val="soundcloud">${icon('cloud')} Импорт</button>
    </div>
  </div>
  <div class="grid" style="margin-bottom:30px">
    ${COLLECTION.map(cardHtml).join('')}
  </div>
  <div class="section">
    <div class="section__head"><h3>Недавно добавлено</h3></div>
    ${rowsHtml(TRACKS.slice(2))}
  </div>
`;

const pageWave = () => `
  <div class="page-head"><div><h1>Моя волна</h1><p>Персональный поток · настройка под настроение</p></div></div>
  <div class="wave-stage">
    <div class="wave-art"></div>
    <div>
      <div class="hero__kicker">Сейчас играет</div>
      <h2 style="font-family:var(--font-display);font-size:26px;margin:6px 0 4px;letter-spacing:-.03em">${TRACKS[S.track].title}</h2>
      <p style="color:var(--dim);font-size:13px;margin:0">${TRACKS[S.track].artist} · ${TRACKS[S.track].album}</p>
      <div class="wave-bars">${Array.from({ length: 34 }).map((_, i) => `<i style="animation-delay:${-i * 60}ms;height:${20 + ((i * 37) % 80)}%"></i>`).join('')}</div>
      <div class="hero__actions">
        <button class="btn btn--accent" data-act="toggle">${icon(S.playing ? 'pause' : 'play')} ${S.playing ? 'Пауза' : 'Слушать'}</button>
        <button class="btn btn--ghost">${icon('heart')} Нравится</button>
        <button class="btn btn--ghost">${icon('x')} Не очень</button>
      </div>
    </div>
  </div>
  <div style="height:26px"></div>
  <div class="section">
    <div class="section__head"><h3>Дальше в потоке</h3></div>
    ${rowsHtml(TRACKS.slice(4))}
  </div>
`;

const pageSoundCloud = () => `
  <div class="page-head">
    <div>
      <h1>SoundCloud</h1>
      <p>Поиск по стороннему каталогу · одна кнопка «В Яндекс»</p>
    </div>
    <div style="margin-left:auto;display:flex;gap:8px">
      <button class="btn btn--accent btn--sm" data-act="spimport">${icon('spark')} Импорт из Spotify</button>
    </div>
  </div>

  <div class="notice">
    ${icon('cloud')}
    <div><b>Как это работает.</b> Официальный Widget API играет треки прямо здесь — без скачивания и без обхода защиты. Кнопка «В Яндекс» переносит метаданные в вашу библиотеку, если трек нашёлся в каталоге Яндекса; иначе остаётся играть из SoundCloud.</div>
  </div>

  <div class="sc-search">
    <input type="text" value="lowkey" aria-label="Поиск в SoundCloud">
    <button class="btn btn--ghost">${icon('search')} Найти</button>
  </div>
  <div class="chips">
    <button class="chip on">Всё</button><button class="chip">Треки</button><button class="chip">Плейлисты</button><button class="chip">Лейблы</button>
  </div>

  <div class="section">
    <div class="section__head"><h3>Результаты</h3><span class="more" style="color:var(--mute)">5 из 1 240</span></div>
    <div class="rows">
      ${SC_RESULTS.map((t, i) => `
        <div class="row" style="grid-template-columns:34px 44px minmax(0,1fr) 110px 80px 90px 30px">
          <span class="row__num">${i + 1}</span>
          <div class="row__art" style="--a:${t.art[0]};--b:${t.art[1]};--c:${t.art[2]}"></div>
          <div style="min-width:0">
            <p class="row__title">${t.title}</p>
            <p class="row__artist">${t.artist} · ${t.plays} прослушиваний</p>
          </div>
          <span class="row__src sc">SoundCloud</span>
          <span class="row__dur">${t.dur}</span>
          <button class="btn btn--ghost btn--sm" data-act="scadd" data-id="${t.id}" ${S.scAdded.includes(t.id) ? 'disabled' : ''}>
            ${S.scAdded.includes(t.id) ? icon('check') + ' Добавлено' : icon('plus') + (t.found ? ' В Яндекс' : ' Скачать')}
          </button>
          <button class="row__play">${icon('play')}</button>
        </div>`).join('')}
    </div>
  </div>

  <p class="footnote">Скачивание доступно только тому, что автор сам выложил под свободной лицензией. Импорт стриминговых ссылок и обход DRM не поддерживаются намеренно.</p>
`;

const pageTheme = () => `
  <div class="page-head">
    <div><h1>Оформление</h1><p>Цвета, обои, плотность и всё остальное — меняется на лету</p></div>
    <div style="margin-left:auto"><button class="btn btn--ghost btn--sm" data-act="reset">${icon('x')} Сбросить</button></div>
  </div>

  <div class="theme-grid">
    <div>
      <div class="panel">
        <div class="panel__head">${icon('spark')}<h3>Пресеты</h3><span class="hint">быстрый старт</span></div>
        <div class="presets" style="padding-bottom:12px">
          ${PRESETS.map((p) => `<button class="preset" data-act="preset" data-val="${p.id}"><i style="background:${p.swatch}"></i>${p.name}</button>`).join('')}
        </div>
      </div>

      <div class="panel" style="margin-top:14px">
        <div class="panel__head">${icon('image')}<h3>Обои</h3><span class="hint">фон рабочей области</span></div>
        <div class="wallpapers" style="padding-bottom:6px">
          ${WALLS.map((w) => `<button class="wp ${w.id === 'cover' ? '' : w.cls}${S.wallpaper === w.id ? ' on' : ''}" data-act="wall" data-val="${w.id}"
             ${w.id === 'cover' ? `style="background:linear-gradient(140deg,${TRACKS[S.track].art[0]},${TRACKS[S.track].art[2]} 55%,${TRACKS[S.track].art[1]})"` : ''}><span>${w.name}</span></button>`).join('')}
          <button class="wp wp--upload" data-act="upload"><svg viewBox="0 0 24 24"><use href="#i-plus"></use></svg><span>Своя</span></button>
        </div>
        <div class="ctl">
          <div class="ctl__label">Размытие панелей<small>стекло, карточки, плеер</small></div>
          <div class="ctl__body"><input class="rng" type="range" min="0" max="48" data-range="blur"><span class="rng-val">${S.blur}px</span></div>
        </div>
        <div class="ctl">
          <div class="ctl__label">Зерно<small>плёночная текстура поверх</small></div>
          <label class="toggle"><input type="checkbox" data-toggle="grain"><span class="toggle__track"></span></label>
        </div>
      </div>

      <div class="panel" style="margin-top:14px" id="ctl-color">
        <div class="panel__head">${icon('palette')}<h3>Цветовая гамма</h3><span class="hint">акцент интерфейса</span></div>
        <div class="ctl" style="border-top:0">
          <div class="ctl__label">Акцент<small>${S.accentAuto ? 'автоматически из обложки' : 'свой цвет'}</small></div>
          <div class="ctl__body">
            <div class="swatches">
              <button class="sw sw--auto" data-act="accent-auto" title="Авто из обложки">${icon('spark')}</button>
              ${ACCENTS.map((c) => `<button class="sw${!S.accentAuto && S.accent.toLowerCase() === c.toLowerCase() ? ' on' : ''}" style="background:${c}" data-act="accent" data-val="${c}"></button>`).join('')}
              <label class="sw" style="background:conic-gradient(red,yellow,lime,aqua,blue,magenta,red);cursor:pointer" title="Свой цвет">
                <input type="color" value="${S.accent}" data-act="accent-custom" style="opacity:0;width:100%;height:100%;border:0;padding:0;cursor:pointer">
              </label>
            </div>
          </div>
        </div>
        <div class="ctl">
          <div class="ctl__label">Схема<small>тёмная / светлая / AMOLED</small></div>
          <div class="seg">
            <button data-key="scheme" data-val="dark" data-act="set">Тёмная</button>
            <button data-key="scheme" data-val="light" data-act="set">Светлая</button>
            <button data-key="scheme" data-val="amoled" data-act="set">AMOLED</button>
          </div>
        </div>
        <div class="ctl">
          <div class="ctl__label">Стиль<small>характер интерфейса</small></div>
          <div class="seg">
            <button data-key="variant" data-val="glass" data-act="set">Стекло</button>
            <button data-key="variant" data-val="vinyl" data-act="set">Пластинка</button>
            <button data-key="variant" data-val="neon" data-act="set">Неон</button>
            <button data-key="variant" data-val="paper" data-act="set">Бумага</button>
          </div>
        </div>
      </div>

      <div class="panel" style="margin-top:14px" id="ctl-text">
        <div class="panel__head">${icon('type')}<h3>Цвет текста</h3><span class="hint">свои цвета вместо схемы</span></div>
        ${[['heading', 'Заголовки', '#f2f2f5'], ['txt', 'Основной текст', '#d8d8e0'], ['dimc', 'Второстепенный', '#9a9aa5']].map(([key, label, def]) => `
          <div class="ctl">
            <div class="ctl__label">${label}<small>${S[key] || 'по схеме'}</small></div>
            <div class="ctl__body">
              <button class="chip${S[key] ? '' : ' on'}" data-act="autocolor" data-key="${key}">Авто</button>
              <label class="sw" style="background:${S[key] || def}">
                <input type="color" value="${S[key] || def}" data-color="${key}" style="opacity:0;width:100%;height:100%;border:0;padding:0;cursor:pointer">
              </label>
            </div>
          </div>`).join('')}
      </div>

      <div class="panel" style="margin-top:14px" id="ctl-blocks">
        <div class="panel__head">${icon('library')}<h3>Блоки</h3><span class="hint">скрыть, убрать, переставить</span></div>
        <div class="ctl" style="border-top:0">
          <div class="ctl__label">Карточек в ряд<small>сетка карточек</small></div>
          <div class="seg">
            ${[['auto', 'Авто'], ['3', '3'], ['4', '4'], ['5', '5'], ['6', '6']].map(([v, l]) => `<button data-key="cols" data-val="${v}" data-act="set">${l}</button>`).join('')}
          </div>
        </div>
        ${BLOCKS_UI.map((b) => `
          <div class="blockrow">
            <div class="blockrow__name">${b.name}${b.sub ? `<small>${b.sub}</small>` : ''}</div>
            ${b.order ? `
              <button class="arrowbtn" data-act="move" data-val="${b.id}" data-dir="-1" title="Выше" ${S.blockOrder.indexOf(b.id) === 0 ? 'disabled' : ''}>↑</button>
              <button class="arrowbtn" data-act="move" data-val="${b.id}" data-dir="1" title="Ниже" ${S.blockOrder.indexOf(b.id) === S.blockOrder.length - 1 ? 'disabled' : ''}>↓</button>` : ''}
            <label class="toggle"><input type="checkbox" data-block="${b.id}" ${S.blocks[b.id] ? 'checked' : ''}><span class="toggle__track"></span></label>
          </div>`).join('')}
      </div>

      <div class="panel" style="margin-top:14px">
        <div class="panel__head">${icon('type')}<h3>Форма и текст</h3></div>
        <div class="ctl" style="border-top:0">
          <div class="ctl__label">Плотность<small>сколько воздуха между строками</small></div>
          <div class="seg">
            <button data-key="density" data-val="compact" data-act="set">Компакт</button>
            <button data-key="density" data-val="normal" data-act="set">Обычно</button>
            <button data-key="density" data-val="roomy" data-act="set">Просторно</button>
          </div>
        </div>
        <div class="ctl">
          <div class="ctl__label">Обложки<small>размер карточек</small></div>
          <div class="seg">
            <button data-key="cards" data-val="s" data-act="set">S</button>
            <button data-key="cards" data-val="m" data-act="set">M</button>
            <button data-key="cards" data-val="l" data-act="set">L</button>
          </div>
        </div>
        <div class="ctl">
          <div class="ctl__label">Скругления<small>радиус панелей</small></div>
          <div class="ctl__body"><input class="rng" type="range" min="0" max="34" data-range="radius"><span class="rng-val">${S.radius}px</span></div>
        </div>
        <div class="ctl">
          <div class="ctl__label">Шрифт<small>система / с засечками / моно</small></div>
          <div class="seg">
            <button data-key="font" data-val="ui" data-act="set">Обычный</button>
            <button data-key="font" data-val="serif" data-act="set">Сериф</button>
            <button data-key="font" data-val="mono" data-act="set">Моно</button>
          </div>
        </div>
        <div class="ctl">
          <div class="ctl__label">Анимации<small>переходы и hover-эффекты</small></div>
          <label class="toggle"><input type="checkbox" data-toggle="anim"><span class="toggle__track"></span></label>
        </div>
      </div>
    </div>

    <div class="preview">
      <div class="mini">
        <div class="mini__wall"></div>
        <div class="mini__body">
          <div class="mini__row">
            <div class="mini__art" style="--a:${TRACKS[S.track].art[0]};--b:${TRACKS[S.track].art[1]};--c:${TRACKS[S.track].art[2]}"></div>
            <div><p class="mini__t">${TRACKS[S.track].title}</p><p class="mini__a">${TRACKS[S.track].artist}</p></div>
            <span class="pl-src" style="margin-left:auto">${TRACKS[S.track].src === 'ya' ? 'Яндекс' : TRACKS[S.track].src === 'sc' ? 'SoundCloud' : 'Spotify'}</span>
          </div>
          <div class="mini__bar"><i></i></div>
          <div class="mini__cards"><div class="mini__card"></div><div class="mini__card"></div><div class="mini__card"></div></div>
        </div>
      </div>

      <div class="panel" style="padding:16px 18px 14px">
        <div class="panel__head" style="padding:0 0 10px"><h3>Тема как файл</h3><span class="hint">JSON</span></div>
        <div class="palette-preview">
          <i style="background:var(--accent)"></i>
          <i style="background:${TRACKS[S.track].art[0]}"></i>
          <i style="background:${TRACKS[S.track].art[1]}"></i>
          <i style="background:var(--bg-2)"></i>
          <i style="background:var(--text)"></i>
        </div>
        <div data-code style="display:flex;flex-direction:column;gap:6px;padding:12px 0"></div>
        <div class="theme-actions">
          <button class="btn btn--ghost btn--sm" data-act="export">${icon('download')} Экспорт</button>
          <button class="btn btn--ghost btn--sm" data-act="import">${icon('plus')} Импорт</button>
        </div>
      </div>

      <p class="footnote">В реальном приложении эти же токены уезжают CSS-переменными в слой поверх веб-версии. Обои, шрифты и палитры хранятся локально; «авто из обложки» считает палитру из текущего трека (квантование по canvas).</p>
    </div>
  </div>
`;

/* ---------------- эквалайзер ---------------- */

const EQ_HZ = ['31', '62', '125', '250', '500', '1k', '2k', '4k', '8k', '16k'];
const EQ_PRESETS = {
  flat: { name: 'Плоский', bands: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
  bass: { name: 'Басы', bands: [8, 7, 5, 3, 0, -1, -2, -2, -1, 0] },
  vocal: { name: 'Вокал', bands: [-2, -1, 0, 2, 4, 4, 4, 2, 0, -1] },
  rock: { name: 'Рок', bands: [5, 4, 2, 0, -1, 0, 2, 4, 5, 4] },
  pop: { name: 'Поп', bands: [-1, 1, 3, 4, 3, 1, -1, -1, 0, 1] },
  jazz: { name: 'Джаз', bands: [3, 2, 1, 2, 3, 3, 2, 1, 1, 0] },
  classic: { name: 'Классика', bands: [2, 1, 0, 0, 0, 0, -1, -1, 0, 1] },
  electro: { name: 'Электроника', bands: [6, 5, 2, 0, -2, -1, 2, 3, 4, 3] },
  night: { name: 'Ночной', bands: [2, 1, 0, -1, -2, -2, -3, -3, -3, -3] },
};

const dbLabel = (v) => (v > 0 ? `+${v}` : String(v));

function eqChartSvg() {
  const W = 940, H = 130, pad = 8;
  const pts = S.eq.bands.map((v, i) => [pad + i * (W - 2 * pad) / 9, H / 2 - (v / 12) * (H / 2 - pad)]);
  let d = `M ${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)}`;
  for (let i = 1; i < pts.length; i++) {
    const [x0, y0] = pts[i - 1];
    const [x1, y1] = pts[i];
    const mx = (x0 + x1) / 2;
    d += ` C ${mx.toFixed(1)} ${y0.toFixed(1)}, ${mx.toFixed(1)} ${y1.toFixed(1)}, ${x1.toFixed(1)} ${y1.toFixed(1)}`;
  }
  const area = `${d} L ${pts[9][0].toFixed(1)} ${(H / 2).toFixed(1)} L ${pts[0][0].toFixed(1)} ${(H / 2).toFixed(1)} Z`;
  return `<svg class="eq-chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
    <line class="gridline" x1="0" y1="${H / 4}" x2="${W}" y2="${H / 4}"/>
    <line class="gridline" x1="0" y1="${H * 3 / 4}" x2="${W}" y2="${H * 3 / 4}"/>
    <line class="zero" x1="0" y1="${H / 2}" x2="${W}" y2="${H / 2}"/>
    <path class="area" d="${area}" vector-effect="non-scaling-stroke"/>
    <path class="line" d="${d}" vector-effect="non-scaling-stroke"/>
  </svg>`;
}

const pageEq = () => `
  <div class="page-head">
    <div>
      <h1>Эквалайзер</h1>
      <p>Панель из плеера: 10 полос, профили, качество звука</p>
    </div>
    <div style="margin-left:auto;display:flex;gap:10px;align-items:center">
      <span style="font-size:12px;color:var(--dim)">${S.eq.on ? 'Включён' : 'Выключен'}</span>
      <label class="toggle"><input type="checkbox" data-toggle="eq.on"><span class="toggle__track"></span></label>
    </div>
  </div>

  <div class="eq-wrap">
    <div class="eq-top">
      <span class="eq-label">Профили</span>
      <div class="eq-presets">
        ${Object.entries(EQ_PRESETS).map(([id, p]) => `<button class="eq-preset${S.eq.preset === id ? ' on' : ''}" data-act="eqpreset" data-val="${id}">${p.name}</button>`).join('')}
      </div>
      <div style="margin-left:auto;display:flex;gap:8px">
        <button class="btn btn--ghost btn--sm" data-act="eqflat">${icon('repeat')} Сбросить</button>
        <button class="btn btn--accent btn--sm" data-act="eqsave">${icon('check')} Сохранить в тему</button>
      </div>
    </div>

    <p class="eq-hint">Профиль выставляет полосы автоматически, но их можно поправить руками — как в плеере Яндекс.Музыки.</p>

    ${eqChartSvg()}

    <div class="eq-bands">
      ${S.eq.bands.map((v, i) => `
        <div class="eq-band">
          <span class="eq-band__val">${dbLabel(v)}</span>
          <div class="eq-band__track">
            <input type="range" min="-12" max="12" step="1" value="${v}" data-eqband="${i}" ${S.eq.on ? '' : 'disabled'}>
          </div>
          <span class="eq-band__hz">${EQ_HZ[i]}</span>
        </div>`).join('')}
    </div>

    <div class="eq-foot">
      <span style="font-size:12px;color:var(--dim)">Предусиление</span>
      <input class="rng" type="range" min="-6" max="6" step="1" value="${S.eq.preamp}" data-eqpreamp style="width:150px">
      <span class="rng-val">${dbLabel(S.eq.preamp)} dB</span>
      <span style="margin-left:auto;font-size:11px;color:var(--mute)">${S.eq.preset === 'custom' ? 'Своя настройка' : `Пресет: ${(EQ_PRESETS[S.eq.preset] || {}).name || '—'}`}</span>
    </div>

    <div class="eq-quality">
      <div>
        <div class="eq-label">Качество звука</div>
        <p class="eq-hint" style="margin:4px 0 0">В плеере Яндекс.Музыки переключается в той же панели, что и эквалайзер</p>
      </div>
      <div class="seg">
        ${[['best', 'Превосходное'], ['high', 'Оптимальное'], ['low', 'Экономичное']].map(([v, l]) => `<button data-act="eqquality" data-val="${v}" class="${S.quality === v ? 'on' : ''}">${l}</button>`).join('')}
      </div>
    </div>

    <p class="footnote">В обёртке эквалайзер — это настройка, а не обработка чужого аудиопотока: звук идёт через их плеер внутри веб-вью, и перехватить его нельзя. Реальная обработка возможна для нашего собственного аудио-слоя (SoundCloud-виджет, локальные файлы) или через экспорт пресета в системный Equalizer APO — оба варианта описаны в THEME-SPEC.md.</p>
  </div>
`;

const PAGES = { home: pageHome, wave: pageWave, collection: pageCollection, soundcloud: pageSoundCloud, theme: pageTheme, eq: pageEq };

/* ---------------- рендер ---------------- */

function render() {
  applyTheme();
  if (!document.getElementById('content')) renderShell();
  $$('.nav__item').forEach((el) => el.classList.toggle('is-active', el.dataset.val === S.page));
  $('#content').innerHTML = (PAGES[S.page] || pageHome)();
  renderPlayer();
  syncControls();
  const sp = $$('.stylepick button');
  sp.forEach((b) => b.classList.toggle('on', b.dataset.val === S.variant));
}

/* ---------------- события ---------------- */

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const act = el.dataset.act;

  switch (act) {
    case 'page':
      S.page = el.dataset.val; save(); render(); $('#content').scrollTop = 0; break;
    case 'variant':
      S.variant = el.dataset.val;
      Object.assign(S, VARIANTS[S.variant]);
      if (S.variant === 'paper' && S.scheme === 'dark') S.scheme = 'light';
      save(); render(); break;
    case 'scheme':
      S.scheme = S.scheme === 'dark' ? 'light' : S.scheme === 'light' ? 'amoled' : 'dark';
      save(); render(); break;
    case 'set':
      S[el.dataset.key] = el.dataset.val;
      save(); applyTheme(); syncControls(); renderPlayer();
      if (S.page === 'theme') { $('#content').innerHTML = pageTheme(); syncControls(); }
      break;
    case 'wall':
      S.wallpaper = el.dataset.val; save(); applyTheme(); syncControls(); break;
    case 'upload': {
      const inp = document.createElement('input');
      inp.type = 'file'; inp.accept = 'image/*';
      inp.onchange = () => {
        const f = inp.files[0]; if (!f) return;
        const r = new FileReader();
        r.onload = () => { customWall = r.result; S.wallpaper = 'custom'; save(); applyTheme(); render(); toast('Обои установлены'); };
        r.readAsDataURL(f);
      };
      inp.click(); break;
    }
    case 'accent':
      S.accent = el.dataset.val; S.accentAuto = false; save(); applyTheme(); syncControls();
      if (S.page === 'theme') { $('#content').innerHTML = pageTheme(); syncControls(); }
      break;
    case 'accent-auto':
      S.accentAuto = true; save(); applyTheme(); syncControls();
      if (S.page === 'theme') { $('#content').innerHTML = pageTheme(); syncControls(); }
      toast('Акцент берётся из обложки'); break;
    case 'preset': {
      const p = PRESETS.find((x) => x.id === el.dataset.val);
      Object.assign(S, { variant: p.variant, scheme: p.scheme, accent: p.accent, accentAuto: false, wallpaper: p.wallpaper, radius: p.radius, blur: p.blur });
      save(); render(); toast(`Тема «${p.name}»`); break;
    }
    case 'play': {
      const t = TRACKS.find((x) => x.id === el.dataset.id);
      if (!t) break;
      S.track = TRACKS.indexOf(t); S.playing = true; S.progress = 0;
      save(); applyTheme(); renderPlayer();
      $$('.row').forEach((r) => r.classList.toggle('is-playing', r.dataset.id === t.id));
      toast(`${t.title} — ${t.artist}`);
      break;
    }
    case 'like': {
      e.stopPropagation();
      const id = el.dataset.id;
      S.liked = S.liked.includes(id) ? S.liked.filter((x) => x !== id) : [...S.liked, id];
      save(); renderPlayer();
      el.classList.toggle('on');
      break;
    }
    case 'toggle':
      S.playing = !S.playing; save(); applyTheme(); renderPlayer();
      if (S.page === 'home' || S.page === 'wave') $('#content').innerHTML = (PAGES[S.page])();
      break;
    case 'next':
      S.track = (S.track + 1) % TRACKS.length; S.progress = 0; save(); applyTheme(); renderPlayer(); break;
    case 'prev':
      S.track = (S.track - 1 + TRACKS.length) % TRACKS.length; S.progress = 0; save(); applyTheme(); renderPlayer(); break;
    case 'scadd': {
      const id = el.dataset.id;
      if (S.scAdded.includes(id)) break;
      S.scAdded = [...S.scAdded, id]; save();
      el.disabled = true;
      el.innerHTML = icon('check') + ' Добавлено';
      const t = SC_RESULTS.find((x) => x.id === id);
      toast(t.found ? `Найдено в Яндексе: ${t.title}` : `Ушло в загрузки: ${t.title}`);
      break;
    }
    case 'spimport': {
      toast('Spotify → Яндекс: 87 из 100 треков найдено');
      break;
    }
    case 'export': {
      const data = JSON.stringify({ ...S, page: 'home' }, null, 2);
      const a = document.createElement('a');
      a.href = 'data:application/json;charset=utf-8,' + encodeURIComponent(data);
      a.download = 'yandex-music-theme.json';
      a.click();
      toast('Тема сохранена в файл');
      break;
    }
    case 'import': {
      const raw = prompt('Вставьте JSON темы:');
      if (!raw) break;
      try {
        const obj = JSON.parse(raw);
        S = { ...S, ...obj, page: S.page };
        save(); render(); toast('Тема импортирована');
      } catch (err) { toast('Не удалось разобрать JSON'); }
      break;
    }
    case 'autocolor':
      S[el.dataset.key] = null;
      save(); applyTheme(); $('#content').innerHTML = pageTheme(); syncControls();
      toast('Цвет снова из схемы');
      break;
    case 'move': {
      const id = el.dataset.val;
      const dir = Number(el.dataset.dir);
      const i = S.blockOrder.indexOf(id);
      const j = i + dir;
      if (j < 0 || j >= S.blockOrder.length) break;
      const next = [...S.blockOrder];
      [next[i], next[j]] = [next[j], next[i]];
      S.blockOrder = next; save();
      $('#content').innerHTML = pageTheme(); syncControls();
      toast('Порядок блоков сохранён');
      break;
    }
    case 'eqpreset': {
      const p = EQ_PRESETS[el.dataset.val];
      if (!p) break;
      S.eq.bands = [...p.bands]; S.eq.preset = el.dataset.val; save();
      $('#content').innerHTML = pageEq(); syncControls();
      break;
    }
    case 'eqflat':
      S.eq.bands = [...EQ_PRESETS.flat.bands]; S.eq.preset = 'flat'; S.eq.preamp = 0; save();
      $('#content').innerHTML = pageEq(); syncControls();
      break;
    case 'eqquality':
      S.quality = el.dataset.val; save();
      $('#content').innerHTML = pageEq(); syncControls();
      break;
    case 'eqsave':
      save(); toast('Настройки эквалайзера сохранены в теме'); break;
    case 'reset':
      S = structuredClone(DEFAULTS);
      S.page = 'theme';
      customWall = null; save(); render(); toast('Настройки сброшены'); break;
  }
});

document.addEventListener('input', (e) => {
  const el = e.target;
  if (el.dataset.range) {
    S[el.dataset.range] = Number(el.value);
    const out = el.parentElement.querySelector('.rng-val');
    if (out) out.textContent = el.value + 'px';
    applyTheme(); save();
    return;
  }
  if (el.dataset.toggle !== undefined && el.type === 'checkbox') {
    setPath(S, el.dataset.toggle, el.checked); save(); applyTheme(); return;
  }
  if (el.dataset.block !== undefined && el.type === 'checkbox') {
    S.blocks[el.dataset.block] = el.checked; save(); applyTheme();
    const box = document.getElementById('blk-' + el.dataset.block);
    if (box) box.toggleAttribute('hidden', !el.checked);
    return;
  }
  if (el.dataset.color) {
    S[el.dataset.color] = el.value; save(); applyTheme();
    const small = el.closest('.ctl')?.querySelector('.ctl__label small');
    if (small) small.textContent = el.value;
    return;
  }
  if (el.dataset.eqband !== undefined) {
    const i = Number(el.dataset.eqband);
    S.eq.bands[i] = Number(el.value); S.eq.preset = 'custom'; save();
    const band = el.closest('.eq-band');
    if (band) band.querySelector('.eq-band__val').textContent = dbLabel(Number(el.value));
    const chart = document.querySelector('.eq-chart');
    if (chart) chart.outerHTML = eqChartSvg();
    $$('.eq-preset').forEach((b) => b.classList.remove('on'));
    return;
  }
  if (el.dataset.eqpreamp !== undefined) {
    S.eq.preamp = Number(el.value); save();
    const out = el.parentElement.querySelector('.rng-val');
    if (out) out.textContent = dbLabel(Number(el.value)) + ' dB';
    return;
  }
  if (el.dataset.act === 'accent-custom') {
    S.accent = el.value; S.accentAuto = false; save(); applyTheme(); syncControls();
    return;
  }
});

/* прогресс-бар: живёт отдельно, чтобы не перерисовывать всё */
setInterval(() => {
  if (!S.playing) return;
  S.progress = (S.progress + 0.35) % 100;
  const fill = document.getElementById('fill');
  if (fill) {
    fill.style.width = S.progress + '%';
    const t = $('.pl-time');
    if (t) t.textContent = clock(S.progress);
  }
}, 250);

let toastTimer;
function toast(msg) {
  const el = $('#toast');
  if (!el) return;
  el.innerHTML = icon('check') + `<span>${msg}</span>`;
  el.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('on'), 2200);
}

document.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && e.target.tagName !== 'INPUT') { e.preventDefault(); S.playing = !S.playing; applyTheme(); renderPlayer(); }
  if (e.key === 'Escape') $('#toast')?.classList.remove('on');
});

/* ---------------- старт ---------------- */

render();

if (qp.get('scroll')) {
  requestAnimationFrame(() => {
    const el = document.getElementById(qp.get('scroll'));
    if (el) $('#content').scrollTop = el.offsetTop - 12;
  });
}
