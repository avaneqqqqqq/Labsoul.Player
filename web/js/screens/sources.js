/* =========================================================================
   labsoul — экран «Подключения»: токены и ключи трёх источников.
   Секреты приходят с сервера только маской; формы отправляют PUT /api/settings.
   ========================================================================= */

import { isDemo } from '../api.js';
import { icon, SOURCE_MARKS } from '../components.js';
import {
  app,
  commitSettings,
  loadSettings,
  refreshStatus,
  subscribe as storeSubscribe,
} from '../store.js';
import { toast } from '../toast.js';
import { esc, humanizeError } from '../utils.js';

const SOURCE_META = {
  yandex: {
    title: 'Яндекс.Музыка',
    sub: 'каталог, волна и поток',
    logo: 'yandex',
  },
  soundcloud: {
    title: 'SoundCloud',
    sub: 'инди, демо и живые записи',
    logo: 'soundcloud',
  },
  spotify: {
    title: 'Spotify',
    sub: 'мировой каталог и плейлисты',
    logo: 'spotify',
  },
};

const screen = { root: null, unsubs: [], busy: null };

function stateOf(key) {
  if (isDemo()) {
    return { cls: 'warn', label: 'Демо', detail: 'сервер не запущен' };
  }
  const src = app.status?.sources?.[key];
  if (!src) return { cls: '', label: 'Нет данных', detail: 'проверяем подключение…' };
  if (src.connected) {
    return { cls: 'ok', label: 'Подключено', detail: src.user ? `аккаунт ${src.user}` : 'готово к работе' };
  }
  // «токена ещё нет» — это нормальное рабочее состояние, а не поломка:
  // красную ошибку показываем только когда сервис реально отверг доступ
  if (src.error === 'NO_TOKEN' || src.error === 'NOT_INSTALLED') {
    return {
      cls: 'warn',
      label: 'Нужен токен',
      detail: src.error === 'NOT_INSTALLED' ? 'источник недоступен в этой сборке' : 'вход ещё не выполнен',
    };
  }
  if (src.error) return { cls: 'err', label: 'Ошибка', detail: humanizeError(src.error) };
  return { cls: 'warn', label: 'Не подключено', detail: 'нужен токен или ключ' };
}

function pill(key) {
  const state = stateOf(key);
  return `<span class="pill${state.cls ? ` pill--${state.cls}` : ''}" title="${esc(state.detail)}"><i></i>${esc(state.label)}</span>`;
}

function overviewHtml() {
  return ['yandex', 'soundcloud', 'spotify'].map((key) => {
    const meta = SOURCE_META[key];
    const state = stateOf(key);
    return `<div class="ov" data-state="${state.cls}" data-ov="${key}">
      <span class="ov__logo ov__logo--${meta.logo}">${SOURCE_MARKS[key]}</span>
      <span class="ov__main">
        <span class="ov__name">${esc(meta.title)}</span>
        <span class="ov__state">${esc(state.detail)}</span>
      </span>
      <i class="ov__dot" aria-hidden="true"></i>
    </div>`;
  }).join('');
}

function savedHint(key, field) {
  const value = app.settings?.[key]?.[field];
  if (!value) return '<span class="saved-hint">не сохранено</span>';
  return `<span class="saved-hint">${icon('lock')} сохранено: ${esc(value)}</span>`;
}

function desktopBridge() {
  return typeof window !== 'undefined' &&
    window.playerDesktop &&
    typeof window.playerDesktop.signInYandex === 'function'
    ? window.playerDesktop
    : null;
}

import { soundcloudTokenHelp, spotifyTokenHelp, yandexTokenHelp } from './tokenhelp.js';

function yandexCard() {
  const state = stateOf('yandex');
  const canSignIn = Boolean(desktopBridge());
  return `
    <form class="panel source-card" data-source-form="yandex" autocomplete="off">
      <div class="source-card__head">
        <span class="source-card__logo source-card__logo--yandex">Я</span>
        <span class="source-card__title">
          <h3>Яндекс.Музыка</h3>
          <p>${esc(SOURCE_META.yandex.sub)}</p>
        </span>
        ${pill('yandex')}
      </div>

      ${canSignIn ? `
      <div class="signin">
        <button class="btn btn--accent btn--sm" type="button" data-signin="yandex">
          ${icon('check')} Войти в Яндекс.Музыку
        </button>
        <span class="signin__hint">Откроется окно Яндекса: после входа токен подхватится сам, копировать ничего не нужно.</span>
      </div>` : ''}

      <div class="field">
        <label for="yandex-token">OAuth-токен</label>
        <div class="input-wrap">
          <input class="input input--secret" id="yandex-token" name="token" type="password" spellcheck="false"
            placeholder="${app.settings?.yandex?.token ? esc(app.settings.yandex.token) : 'Вставьте токен Яндекс.Музыки'}">
          <button class="input-wrap__btn" type="button" data-reveal="yandex-token">Показать</button>
        </div>
        <span class="field__hint" data-hint="yandex:token">${savedHint('yandex', 'token')}${state.cls === 'err' ? ` · ${esc(state.detail)}` : ''}</span>
      </div>

      ${yandexTokenHelp()}

      <div class="source-card__actions">
        <span class="source-card__error" data-form-error="yandex"></span>
        <button class="btn btn--accent btn--sm" type="submit">${icon('check')} Сохранить</button>
      </div>
    </form>`;
}

/**
 * Вставляет client_id из буфера и сразу сохраняет настройки.
 * Экономит самое муторное — поиск 32-символьной строки руками.
 */
async function pasteSoundCloudKey() {
  const form = screen.root?.querySelector('[data-source-form="soundcloud"]');
  const input = form?.querySelector('#soundcloud-key');
  const stateEl = form?.querySelector('[data-sc-state]');
  if (!input) return;

  let text = '';
  try {
    text = await navigator.clipboard.readText();
  } catch {
    text = '';
  }

  // из буфера может прийти целая строка вида client_id=… или URL с параметром
  const match = String(text || '').match(/[0-9a-zA-Z]{32}/);
  if (!match) {
    if (stateEl) stateEl.textContent = 'В буфере нет строки из 32 символов — скопируйте Client ID на странице приложения.';
    return;
  }

  input.value = match[0];
  if (stateEl) stateEl.textContent = 'Ключ вставлен. Нажмите «Сохранить».';
  input.focus();
}

function soundcloudCard() {
  return `
    <form class="panel source-card" data-source-form="soundcloud" autocomplete="off">
      <div class="source-card__head">
        <span class="source-card__logo source-card__logo--soundcloud">SC</span>
        <span class="source-card__title">
          <h3>SoundCloud</h3>
          <p>${esc(SOURCE_META.soundcloud.sub)}</p>
        </span>
        ${pill('soundcloud')}
      </div>

      ${desktopBridge() ? `<div class="signin">
        <button class="btn btn--accent btn--sm" type="button" data-signin="soundcloud">
          ${icon('check')} Войти в SoundCloud
        </button>
        <span class="signin__hint">Один раз вошли — дальше лайки и плейлисты подтягиваются сами, ключ не нужен.</span>
      </div>` : ''}

      <div class="sc-helper">
        <div class="sc-helper__text">
          <b>Ключ нужен только для ваших лайков и приватных плейлистов.</b>
          Поиск, волна и воспроизведение работают и без него.
        </div>
        <div class="sc-helper__actions">
          <button class="btn btn--accent btn--sm" type="button" data-sc-open-apps>
            ${icon('external')} Открыть настройки приложения
          </button>
          <button class="btn btn--ghost btn--sm" type="button" data-sc-paste>
            ${icon('key')} Вставить из буфера
          </button>
        </div>
        <div class="sc-helper__hint" data-sc-state></div>
      </div>

      <div class="field">
        <label for="soundcloud-key">client_id <span style="text-transform:none;letter-spacing:0;color:var(--mute)">— необязательно</span></label>
        <div class="input-wrap">
          <input class="input input--secret" id="soundcloud-key" name="clientId" type="text" spellcheck="false"
            placeholder="${app.settings?.soundcloud?.clientId ? esc(app.settings.soundcloud.clientId) : 'Если пусто — сервер получит ключ сам'}">
          <button class="input-wrap__btn" type="button" data-reveal="soundcloud-key">Показать</button>
        </div>
        <span class="field__hint" data-hint="soundcloud:clientId">${savedHint('soundcloud', 'clientId')} · публичный ключ, не секрет</span>
        <div class="sc-auto">
          <button class="btn btn--ghost btn--sm" type="button" data-sc-auto>${icon('refresh')} Проверить автоключ</button>
          <span class="sc-auto__state" data-sc-auto-state>поиск и волна работают без своего ключа</span>
        </div>
      </div>
      <div class="field">
        <label for="soundcloud-profile">Ссылка на ваш профиль <span style="text-transform:none;letter-spacing:0;color:var(--mute)">— для лайков без входа</span></label>
        <input class="input" id="soundcloud-profile" name="profileUrl" type="url" spellcheck="false"
          placeholder="https://soundcloud.com/ваш-ник"
          value="${esc(app.settings?.soundcloud?.profileUrl || '')}">
        <span class="field__hint">указав профиль, вы включаете загрузку лайков по нему — client_id не нужен; привычнее и надёжнее просто нажать «Войти в SoundCloud»</span>
      </div>

      ${soundcloudTokenHelp()}

      <div class="source-card__actions">
        <span class="source-card__error" data-form-error="soundcloud"></span>
        <button class="btn btn--accent btn--sm" type="submit">${icon('check')} Сохранить</button>
      </div>
    </form>`;
}

function spotifyCard() {
  return `
    <form class="panel source-card" data-source-form="spotify" autocomplete="off">
      <div class="source-card__head">
        <span class="source-card__logo source-card__logo--spotify">SP</span>
        <span class="source-card__title">
          <h3>Spotify</h3>
          <p>${esc(SOURCE_META.spotify.sub)}</p>
        </span>
        ${pill('spotify')}
      </div>

      <div class="field-grid">
        <div class="field">
          <label for="spotify-id">Client ID</label>
          <input class="input input--secret" id="spotify-id" name="clientId" type="text" spellcheck="false"
            placeholder="${app.settings?.spotify?.clientId ? esc(app.settings.spotify.clientId) : 'client id приложения'}">
          <span class="field__hint" data-hint="spotify:clientId">${savedHint('spotify', 'clientId')}</span>
        </div>
        <div class="field">
          <label for="spotify-secret">Client Secret</label>
          <div class="input-wrap">
            <input class="input input--secret" id="spotify-secret" name="clientSecret" type="password" spellcheck="false"
              placeholder="${app.settings?.spotify?.clientSecret ? esc(app.settings.spotify.clientSecret) : 'client secret'}">
            <button class="input-wrap__btn" type="button" data-reveal="spotify-secret">Показать</button>
          </div>
          <span class="field__hint" data-hint="spotify:clientSecret">${savedHint('spotify', 'clientSecret')}</span>
        </div>
      </div>

      ${spotifyTokenHelp()}

      <div class="source-card__actions">
        <span class="source-card__error" data-form-error="spotify"></span>
        <button class="btn btn--accent btn--sm" type="submit">${icon('check')} Сохранить</button>
      </div>
    </form>`;
}

function cardsHtml() {
  return yandexCard() + soundcloudCard() + spotifyCard();
}

function paintOverview() {
  const host = screen.root?.querySelector('#sources-overview');
  if (host) host.innerHTML = overviewHtml();
}

function paintStates() {
  if (!screen.root) return;
  for (const key of ['yandex', 'soundcloud', 'spotify']) {
    const card = screen.root.querySelector(`[data-source-form="${key}"]`);
    if (!card) continue;
    const state = stateOf(key);
    const oldPill = card.querySelector('.pill');
    if (oldPill) oldPill.outerHTML = pill(key);
    const primaryField = key === 'yandex' ? 'token' : 'clientId';
    for (const hint of card.querySelectorAll('[data-hint]')) {
      const [src, field] = String(hint.dataset.hint || '').split(':');
      let text = savedHint(src, field);
      if (field === primaryField) {
        if (state.cls === 'err') text += ` · ${esc(state.detail)}`;
        else if (state.cls === 'ok') text += ' · доступ проверен';
      }
      hint.innerHTML = text;
    }
    const placeholders = {
      yandex: { 'yandex-token': app.settings?.yandex?.token },
      soundcloud: { 'soundcloud-key': app.settings?.soundcloud?.clientId },
      spotify: {
        'spotify-id': app.settings?.spotify?.clientId,
        'spotify-secret': app.settings?.spotify?.clientSecret,
      },
    }[key] || {};
    for (const [id, masked] of Object.entries(placeholders)) {
      const input = card.querySelector(`#${id}`);
      if (!input) continue;
      if (input.type === 'password' && masked) input.placeholder = masked;
      else if (masked) input.placeholder = masked;
    }
  }
  const refresh = screen.root.querySelector('[data-src="refresh"]');
  if (refresh) refresh.disabled = !!app.statusLoading;
}

async function reload({ withToast = false } = {}) {
  try {
    await Promise.all([refreshStatus(), loadSettings()]);
    paintOverview();
    paintStates();
    if (withToast) {
      const connected = ['yandex', 'soundcloud', 'spotify'].filter((key) => stateOf(key).cls === 'ok').length;
      toast(connected ? `Подключено источников: ${connected}` : 'Статусы обновлены — пока без подключений', {
        type: connected ? 'ok' : 'warn',
        icon: connected ? 'check' : 'alert',
      });
    }
  } catch (err) {
    toast(err?.message || 'Не удалось получить статус', { type: 'err' });
  }
}

function reveal(inputId) {
  const input = screen.root?.querySelector(`#${inputId}`);
  if (!input) return;
  const button = screen.root?.querySelector(`[data-reveal="${inputId}"]`);
  const show = input.type === 'password';
  input.type = show ? 'text' : 'password';
  if (button) button.textContent = show ? 'Скрыть' : 'Показать';
}

function setBusy(form, busy) {
  const button = form.querySelector('button[type="submit"]');
  const errorHint = form.querySelector('[data-form-error]');
  if (button) {
    button.disabled = busy;
    if (busy) button.dataset.label = button.innerHTML;
    button.innerHTML = busy ? '<span class="spinner" style="width:12px;height:12px;margin:0"></span> Сохраняем…' : (button.dataset.label || button.innerHTML);
  }
  if (errorHint && busy) errorHint.textContent = '';
}

async function submitForm(form) {
  const source = form.dataset.sourceForm;
  const data = new FormData(form);
  const values = {
    token: String(data.get('token') || '').trim(),
    clientId: String(data.get('clientId') || '').trim(),
    clientSecret: String(data.get('clientSecret') || '').trim(),
  };
  const errorHint = form.querySelector('[data-form-error]');

  let payload = null;
  if (source === 'yandex') {
    if (!values.token) {
      if (errorHint) errorHint.textContent = 'Вставьте токен';
      toast('Вставьте OAuth-токен Яндекса', { type: 'warn' });
      return;
    }
    payload = { yandex: { token: values.token } };
  } else if (source === 'soundcloud') {
    if (!values.clientId) {
      if (errorHint) errorHint.textContent = 'Введите client_id';
      toast('Введите client_id SoundCloud или оставьте поле пустым', { type: 'warn' });
      return;
    }
    payload = { soundcloud: { clientId: values.clientId } };
  } else {
    if (!values.clientId && !values.clientSecret) {
      if (errorHint) errorHint.textContent = 'Нужен client id или secret';
      toast('Заполните Client ID и Client Secret', { type: 'warn' });
      return;
    }
    payload = {
      spotify: {
        ...(values.clientId ? { clientId: values.clientId } : {}),
        ...(values.clientSecret ? { clientSecret: values.clientSecret } : {}),
      },
    };
  }

  setBusy(form, true);
  try {
    await commitSettings(payload);
    form.reset();
    toast('Настройки сохранены — проверяем подключение', { icon: 'check' });
    await reload();
  } catch (err) {
    const message = err?.message || 'Сервер не принял настройки';
    if (errorHint) errorHint.textContent = message;
    toast(message, { type: 'err', duration: 4600 });
  } finally {
    setBusy(form, false);
  }
}

function onClick(event) {
  const target = event.target instanceof Element ? event.target : null;

  // помощник SoundCloud: открыть страницу приложений и вставить ключ из буфера
  // копируемое значение из инструкции
  const copyBtn = target?.closest('[data-copy]');
  if (copyBtn) {
    const value = copyBtn.dataset.copy;
    navigator.clipboard.writeText(value).then(() => {
      copyBtn.classList.add('is-done');
      setTimeout(() => copyBtn.classList.remove('is-done'), 1200);
    }).catch(() => {});
    return;
  }

  if (target?.closest('[data-sc-open-apps]')) {
    window.open('https://soundcloud.com/you/apps', '_blank', 'noopener');
    return;
  }

  if (target?.closest('[data-sc-paste]')) {
    pasteSoundCloudKey();
    return;
  }

  const clicked = event.target instanceof Element
    ? event.target.closest('[data-src], [data-reveal], [data-signin]')
    : null;
  if (!clicked) return;
  if (clicked.dataset.signin === 'soundcloud') { signInSoundCloud(); return; }
  if (clicked.dataset.signin) { signInYandex(); return; }
  if (clicked.dataset.reveal) { reveal(clicked.dataset.reveal); return; }
  if (clicked.dataset.src === 'refresh') reload({ withToast: true });
}

/**
 * Вход в Яндекс через окно OAuth (доступно только в десктопной оболочке:
 * в обычном браузере такого моста нет, и мы честно об этом говорим).
 */
/** Вход в SoundCloud через окно приложения: сессия сохраняется, лайки тянутся сами. */
async function signInSoundCloud() {
  const bridge = desktopBridge();
  if (!bridge || typeof bridge.signInSoundCloud !== 'function') {
    toast('Вход в SoundCloud доступен в приложении labsoul', { type: 'warn' });
    return;
  }
  try {
    const result = await bridge.signInSoundCloud();
    if (result && result.ok) {
      toast('SoundCloud подключён — лайки подтянутся автоматически', { icon: 'check' });
      reload({ withToast: false });
    } else if (result && result.error) {
      toast('Не удалось войти: ' + result.error, { type: 'err' });
    }
  } catch (err) {
    toast(err?.message || 'Окно входа не открылось', { type: 'err' });
  }
}

async function signInYandex() {
  const bridge = desktopBridge();
  if (!bridge) {
    toast('Вход в Яндекс доступен в приложении labsoul — здесь вставьте токен вручную', { type: 'warn' });
    return;
  }

  const card = screen.root?.querySelector('[data-source-form="yandex"]');
  const errorHint = card?.querySelector('[data-form-error]');
  const button = card?.querySelector('[data-signin="yandex"]');
  if (errorHint) errorHint.textContent = '';
  if (button) button.disabled = true;

  try {
    const result = await bridge.signInYandex();
    if (result && result.ok) {
      toast(result.user ? `Вы вошли как ${result.user}` : 'Яндекс.Музыка подключена', { icon: 'check' });
      await reload();
      return;
    }
    if (result && result.error === 'closed') return; // пользователь сам закрыл окно
    const message = (result && result.message) || 'Не удалось войти в Яндекс';
    if (errorHint) errorHint.textContent = message;
    toast(message, { type: 'err', duration: 5000 });
  } catch (err) {
    toast(err?.message || 'Не удалось открыть окно входа', { type: 'err' });
  } finally {
    if (button) button.disabled = false;
  }
}

function onSubmit(event) {
  const form = event.target instanceof Element ? event.target.closest('[data-source-form]') : null;
  if (!form) return;
  event.preventDefault();
  submitForm(form);
}

const screenModule = {
  id: 'sources',
  title: 'Подключения',

  render(container) {
    container.innerHTML = `
      <div class="page-head">
        <div class="page-head__main">
          <div class="kicker">источники звука</div>
          <h1>Подключения</h1>
          <p>Токены и ключи хранятся локально на сервере и никогда не отдаются в браузер целиком — только маска.</p>
        </div>
        <div class="page-head__actions">
          <button class="btn btn--ghost btn--sm" type="button" data-src="refresh">${icon('refresh')} Проверить связь</button>
        </div>
      </div>

      <div class="sources-overview" id="sources-overview">${overviewHtml()}</div>
      <div class="source-grid">${cardsHtml()}</div>

      <div class="sources-note">
        <div class="notice">
          ${icon('lock')}
          <div><b>Как это устроено.</b> PUT /api/settings сохраняет ключи в локальных настройках сервера, GET /api/settings возвращает только маску вида <code>••••1234</code>.
          Токены не пишутся в localStorage браузера и не уходят третьим лицам. Отключить источник можно, не сохраняя новый токен.</div>
        </div>
        <div class="about-card">
          <span class="brand__mark">${icon('wave')}</span>
          <div><b>labsoul</b> — свой плеер: Яндекс.Музыка, SoundCloud, Spotify. Локальный сервер на Node без зависимостей, ванильный интерфейс, ноль внешних CDN.</div>
          <span class="meta" style="margin-left:auto">v0.1</span>
        </div>
      </div>
    `;
  },

  mount(container) {
    screen.root = container;
    container.addEventListener('click', onClick);
    container.addEventListener('submit', onSubmit);

    const unsub = storeSubscribe((_state, event) => {
      if (event === 'status' || event === 'settings' || event === 'net') {
        paintOverview();
        paintStates();
      }
    });
    screen.unsubs.push(unsub, () => {
      container.removeEventListener('click', onClick);
      container.removeEventListener('submit', onSubmit);
    });

    paintOverview();
    paintStates();
    reload();
  },

  destroy() {
    for (const off of screen.unsubs.splice(0)) {
      try { off(); } catch { /* ignore */ }
    }
    screen.root = null;
  },
};

export default screenModule;
