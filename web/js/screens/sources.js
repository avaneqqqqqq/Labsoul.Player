/* =========================================================================
   labsoul РІР‚вЂќ РЎРЊР С”РЎР‚Р В°Р Р… Р’В«Р СџР С•Р Т‘Р С”Р В»РЎР‹РЎвЂЎР ВµР Р…Р С‘РЎРЏР’В»: РЎвЂљР С•Р С”Р ВµР Р…РЎвЂ№ Р С‘ Р С”Р В»РЎР‹РЎвЂЎР С‘ РЎвЂљРЎР‚РЎвЂРЎвЂ¦ Р С‘РЎРѓРЎвЂљР С•РЎвЂЎР Р…Р С‘Р С”Р С•Р Р†.
   Р РЋР ВµР С”РЎР‚Р ВµРЎвЂљРЎвЂ№ Р С—РЎР‚Р С‘РЎвЂ¦Р С•Р Т‘РЎРЏРЎвЂљ РЎРѓ РЎРѓР ВµРЎР‚Р Р†Р ВµРЎР‚Р В° РЎвЂљР С•Р В»РЎРЉР С”Р С• Р СР В°РЎРѓР С”Р С•Р в„–; РЎвЂћР С•РЎР‚Р СРЎвЂ№ Р С•РЎвЂљР С—РЎР‚Р В°Р Р†Р В»РЎРЏРЎР‹РЎвЂљ PUT /api/settings.
   ========================================================================= */

import { isDemo, getNetwork, saveNetwork, testNetwork, findProxy, stopFindProxy } from '../api.js';
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
    title: 'Р Р‡Р Р…Р Т‘Р ВµР С”РЎРѓ.Р СљРЎС“Р В·РЎвЂ№Р С”Р В°',
    sub: 'Р С”Р В°РЎвЂљР В°Р В»Р С•Р С–, Р Р†Р С•Р В»Р Р…Р В° Р С‘ Р С—Р С•РЎвЂљР С•Р С”',
    logo: 'yandex',
  },
  soundcloud: {
    title: 'SoundCloud',
    sub: 'Р С‘Р Р…Р Т‘Р С‘, Р Т‘Р ВµР СР С• Р С‘ Р В¶Р С‘Р Р†РЎвЂ№Р Вµ Р В·Р В°Р С—Р С‘РЎРѓР С‘',
    logo: 'soundcloud',
  },
  spotify: {
    title: 'Spotify',
    sub: 'Р СР С‘РЎР‚Р С•Р Р†Р С•Р в„– Р С”Р В°РЎвЂљР В°Р В»Р С•Р С– Р С‘ Р С—Р В»Р ВµР в„–Р В»Р С‘РЎРѓРЎвЂљРЎвЂ№',
    logo: 'spotify',
  },
};

const screen = { root: null, unsubs: [], busy: null };

function stateOf(key) {
  if (isDemo()) {
    return { cls: 'warn', label: 'Р вЂќР ВµР СР С•', detail: 'РЎРѓР ВµРЎР‚Р Р†Р ВµРЎР‚ Р Р…Р Вµ Р В·Р В°Р С—РЎС“РЎвЂ°Р ВµР Р…' };
  }
  const src = app.status?.sources?.[key];
  if (!src) return { cls: '', label: 'Р СњР ВµРЎвЂљ Р Т‘Р В°Р Р…Р Р…РЎвЂ№РЎвЂ¦', detail: 'Р С—РЎР‚Р С•Р Р†Р ВµРЎР‚РЎРЏР ВµР С Р С—Р С•Р Т‘Р С”Р В»РЎР‹РЎвЂЎР ВµР Р…Р С‘Р ВµРІР‚В¦' };
  if (src.connected) {
    return { cls: 'ok', label: 'Р СџР С•Р Т‘Р С”Р В»РЎР‹РЎвЂЎР ВµР Р…Р С•', detail: src.user ? `Р В°Р С”Р С”Р В°РЎС“Р Р…РЎвЂљ ${src.user}` : 'Р С–Р С•РЎвЂљР С•Р Р†Р С• Р С” РЎР‚Р В°Р В±Р С•РЎвЂљР Вµ' };
  }
  // Р’В«РЎвЂљР С•Р С”Р ВµР Р…Р В° Р ВµРЎвЂ°РЎвЂ Р Р…Р ВµРЎвЂљР’В» РІР‚вЂќ РЎРЊРЎвЂљР С• Р Р…Р С•РЎР‚Р СР В°Р В»РЎРЉР Р…Р С•Р Вµ РЎР‚Р В°Р В±Р С•РЎвЂЎР ВµР Вµ РЎРѓР С•РЎРѓРЎвЂљР С•РЎРЏР Р…Р С‘Р Вµ, Р В° Р Р…Р Вµ Р С—Р С•Р В»Р С•Р СР С”Р В°:
  // Р С”РЎР‚Р В°РЎРѓР Р…РЎС“РЎР‹ Р С•РЎв‚¬Р С‘Р В±Р С”РЎС“ Р С—Р С•Р С”Р В°Р В·РЎвЂ№Р Р†Р В°Р ВµР С РЎвЂљР С•Р В»РЎРЉР С”Р С• Р С”Р С•Р С–Р Т‘Р В° РЎРѓР ВµРЎР‚Р Р†Р С‘РЎРѓ РЎР‚Р ВµР В°Р В»РЎРЉР Р…Р С• Р С•РЎвЂљР Р†Р ВµРЎР‚Р С– Р Т‘Р С•РЎРѓРЎвЂљРЎС“Р С—
  if (src.error === 'NO_TOKEN' || src.error === 'NOT_INSTALLED') {
    return {
      cls: 'warn',
      label: 'Р СњРЎС“Р В¶Р ВµР Р… РЎвЂљР С•Р С”Р ВµР Р…',
      detail: src.error === 'NOT_INSTALLED' ? 'Р С‘РЎРѓРЎвЂљР С•РЎвЂЎР Р…Р С‘Р С” Р Р…Р ВµР Т‘Р С•РЎРѓРЎвЂљРЎС“Р С—Р ВµР Р… Р Р† РЎРЊРЎвЂљР С•Р в„– РЎРѓР В±Р С•РЎР‚Р С”Р Вµ' : 'Р Р†РЎвЂ¦Р С•Р Т‘ Р ВµРЎвЂ°РЎвЂ Р Р…Р Вµ Р Р†РЎвЂ№Р С—Р С•Р В»Р Р…Р ВµР Р…',
    };
  }
  if (src.error) return { cls: 'err', label: 'Р С›РЎв‚¬Р С‘Р В±Р С”Р В°', detail: humanizeError(src.error) };
  return { cls: 'warn', label: 'Р СњР Вµ Р С—Р С•Р Т‘Р С”Р В»РЎР‹РЎвЂЎР ВµР Р…Р С•', detail: 'Р Р…РЎС“Р В¶Р ВµР Р… РЎвЂљР С•Р С”Р ВµР Р… Р С‘Р В»Р С‘ Р С”Р В»РЎР‹РЎвЂЎ' };
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
  if (!value) return '<span class="saved-hint">Р Р…Р Вµ РЎРѓР С•РЎвЂ¦РЎР‚Р В°Р Р…Р ВµР Р…Р С•</span>';
  return `<span class="saved-hint">${icon('lock')} РЎРѓР С•РЎвЂ¦РЎР‚Р В°Р Р…Р ВµР Р…Р С•: ${esc(value)}</span>`;
}

function desktopBridge() {
  return typeof window !== 'undefined' &&
    window.playerDesktop &&
    typeof window.playerDesktop.signInYandex === 'function'
    ? window.playerDesktop
    : null;
}

import { soundcloudTokenHelp, spotifyTokenHelp, yandexTokenHelp, copy } from './tokenhelp.js';

function yandexCard() {
  const state = stateOf('yandex');
  const canSignIn = Boolean(desktopBridge());
  return `
    <form class="panel source-card" data-source-form="yandex" autocomplete="off">
      <div class="source-card__head">
        <span class="source-card__logo source-card__logo--yandex">Р Р‡</span>
        <span class="source-card__title">
          <h3>Р Р‡Р Р…Р Т‘Р ВµР С”РЎРѓ.Р СљРЎС“Р В·РЎвЂ№Р С”Р В°</h3>
          <p>${esc(SOURCE_META.yandex.sub)}</p>
        </span>
        ${pill('yandex')}
      </div>

      ${canSignIn ? `
      <div class="signin">
        <button class="btn btn--accent btn--sm" type="button" data-signin="yandex">
          ${icon('check')} Р вЂ™Р С•Р в„–РЎвЂљР С‘ Р Р† Р Р‡Р Р…Р Т‘Р ВµР С”РЎРѓ.Р СљРЎС“Р В·РЎвЂ№Р С”РЎС“
        </button>
        <span class="signin__hint">Р С›РЎвЂљР С”РЎР‚Р С•Р ВµРЎвЂљРЎРѓРЎРЏ Р С•Р С”Р Р…Р С• Р Р‡Р Р…Р Т‘Р ВµР С”РЎРѓР В°: Р С—Р С•РЎРѓР В»Р Вµ Р Р†РЎвЂ¦Р С•Р Т‘Р В° РЎвЂљР С•Р С”Р ВµР Р… Р С—Р С•Р Т‘РЎвЂ¦Р Р†Р В°РЎвЂљР С‘РЎвЂљРЎРѓРЎРЏ РЎРѓР В°Р С, Р С”Р С•Р С—Р С‘РЎР‚Р С•Р Р†Р В°РЎвЂљРЎРЉ Р Р…Р С‘РЎвЂЎР ВµР С–Р С• Р Р…Р Вµ Р Р…РЎС“Р В¶Р Р…Р С•.</span>
      </div>` : ''}

      <div class="field">
        <label for="yandex-token">OAuth-РЎвЂљР С•Р С”Р ВµР Р…</label>
        <div class="input-wrap">
          <input class="input input--secret" id="yandex-token" name="token" type="password" spellcheck="false"
            placeholder="${app.settings?.yandex?.token ? esc(app.settings.yandex.token) : 'Р вЂ™РЎРѓРЎвЂљР В°Р Р†РЎРЉРЎвЂљР Вµ РЎвЂљР С•Р С”Р ВµР Р… Р Р‡Р Р…Р Т‘Р ВµР С”РЎРѓ.Р СљРЎС“Р В·РЎвЂ№Р С”Р С‘'}">
          <button class="input-wrap__btn" type="button" data-reveal="yandex-token">Р СџР С•Р С”Р В°Р В·Р В°РЎвЂљРЎРЉ</button>
        </div>
        <span class="field__hint" data-hint="yandex:token">${savedHint('yandex', 'token')}${state.cls === 'err' ? ` Р’В· ${esc(state.detail)}` : ''}</span>
      </div>

      ${yandexTokenHelp()}

      <div class="source-card__actions">
        <span class="source-card__error" data-form-error="yandex"></span>
        <button class="btn btn--accent btn--sm" type="submit">${icon('check')} Р РЋР С•РЎвЂ¦РЎР‚Р В°Р Р…Р С‘РЎвЂљРЎРЉ</button>
      </div>
    </form>`;
}

/**
 * Р вЂ™РЎРѓРЎвЂљР В°Р Р†Р В»РЎРЏР ВµРЎвЂљ client_id Р С‘Р В· Р В±РЎС“РЎвЂћР ВµРЎР‚Р В° Р С‘ РЎРѓРЎР‚Р В°Р В·РЎС“ РЎРѓР С•РЎвЂ¦РЎР‚Р В°Р Р…РЎРЏР ВµРЎвЂљ Р Р…Р В°РЎРѓРЎвЂљРЎР‚Р С•Р в„–Р С”Р С‘.
 * Р В­Р С”Р С•Р Р…Р С•Р СР С‘РЎвЂљ РЎРѓР В°Р СР С•Р Вµ Р СРЎС“РЎвЂљР С•РЎР‚Р Р…Р С•Р Вµ РІР‚вЂќ Р С—Р С•Р С‘РЎРѓР С” 32-РЎРѓР С‘Р СР Р†Р С•Р В»РЎРЉР Р…Р С•Р в„– РЎРѓРЎвЂљРЎР‚Р С•Р С”Р С‘ РЎР‚РЎС“Р С”Р В°Р СР С‘.
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

  // Р С‘Р В· Р В±РЎС“РЎвЂћР ВµРЎР‚Р В° Р СР С•Р В¶Р ВµРЎвЂљ Р С—РЎР‚Р С‘Р в„–РЎвЂљР С‘ РЎвЂ Р ВµР В»Р В°РЎРЏ РЎРѓРЎвЂљРЎР‚Р С•Р С”Р В° Р Р†Р С‘Р Т‘Р В° client_id=РІР‚В¦ Р С‘Р В»Р С‘ URL РЎРѓ Р С—Р В°РЎР‚Р В°Р СР ВµРЎвЂљРЎР‚Р С•Р С
  const match = String(text || '').match(/[0-9a-zA-Z]{32}/);
  if (!match) {
    if (stateEl) stateEl.textContent = 'Р вЂ™ Р В±РЎС“РЎвЂћР ВµРЎР‚Р Вµ Р Р…Р ВµРЎвЂљ РЎРѓРЎвЂљРЎР‚Р С•Р С”Р С‘ Р С‘Р В· 32 РЎРѓР С‘Р СР Р†Р С•Р В»Р С•Р Р† РІР‚вЂќ РЎРѓР С”Р С•Р С—Р С‘РЎР‚РЎС“Р в„–РЎвЂљР Вµ Client ID Р Р…Р В° РЎРѓРЎвЂљРЎР‚Р В°Р Р…Р С‘РЎвЂ Р Вµ Р С—РЎР‚Р С‘Р В»Р С•Р В¶Р ВµР Р…Р С‘РЎРЏ.';
    return;
  }

  input.value = match[0];
  if (stateEl) stateEl.textContent = 'Р С™Р В»РЎР‹РЎвЂЎ Р Р†РЎРѓРЎвЂљР В°Р Р†Р В»Р ВµР Р…. Р СњР В°Р В¶Р СР С‘РЎвЂљР Вµ Р’В«Р РЋР С•РЎвЂ¦РЎР‚Р В°Р Р…Р С‘РЎвЂљРЎРЉР’В».';
  input.focus();
}

/**
 * Вставляет ключи Spotify из буфера.
 * Формат из dashboard: две строки (Client ID, затем Secret),
 * либо строка вида "SPOTIFY_CLIENT_ID=... SPOTIFY_CLIENT_SECRET=...".
 */
async function pasteSpotifyKey() {
  const form = screen.root?.querySelector('[data-source-form="spotify"]');
  const idInput = form?.querySelector('#spotify-id');
  const secretInput = form?.querySelector('#spotify-secret');
  const errorHint = form?.querySelector('[data-form-error]');
  if (!idInput || !secretInput) return;

  let text = '';
  try {
    text = await navigator.clipboard.readText();
  } catch {
    text = '';
  }

  const raw = String(text || '').trim();
  if (!raw) {
    if (errorHint) errorHint.textContent = 'Буфер пуст — скопируйте ключи из dashboard.';
    return;
  }

  // Client ID — 32 hex-символа; Secret — тоже 32 hex
  const ids = raw.match(/[0-9a-f]{32}/gi) || [];

  // вариант с подписями
  const idMatch = /SPOTIFY_CLIENT_IDs*=s*([0-9a-f]{32})/i.exec(raw);
  const secretMatch = /SPOTIFY_CLIENT_SECRETs*=s*([0-9a-f]{32})/i.exec(raw);

  const clientId = idMatch ? idMatch[1] : ids[0] || '';
  const clientSecret = secretMatch ? secretMatch[1] : ids[1] || '';

  if (!clientId) {
    if (errorHint) errorHint.textContent = 'В буфере нет Client ID (32 символа) — скопируйте его из dashboard.';
    return;
  }

  idInput.value = clientId;
  if (clientSecret) {
    secretInput.value = clientSecret;
  }
  const hint = clientSecret
    ? 'Ключи вставлены. Нажмите «Сохранить».'
    : 'Client ID вставлен. Client Secret скопируйте из dashboard отдельно.';
  if (errorHint) errorHint.textContent = hint;
  (clientSecret ? idInput : secretInput).focus();
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
          ${icon('check')} Р вЂ™Р С•Р в„–РЎвЂљР С‘ Р Р† SoundCloud
        </button>
        <span class="signin__hint">Р С›Р Т‘Р С‘Р Р… РЎР‚Р В°Р В· Р Р†Р С•РЎв‚¬Р В»Р С‘ РІР‚вЂќ Р Т‘Р В°Р В»РЎРЉРЎв‚¬Р Вµ Р В»Р В°Р в„–Р С”Р С‘ Р С‘ Р С—Р В»Р ВµР в„–Р В»Р С‘РЎРѓРЎвЂљРЎвЂ№ Р С—Р С•Р Т‘РЎвЂљРЎРЏР С–Р С‘Р Р†Р В°РЎР‹РЎвЂљРЎРѓРЎРЏ РЎРѓР В°Р СР С‘, Р С”Р В»РЎР‹РЎвЂЎ Р Р…Р Вµ Р Р…РЎС“Р В¶Р ВµР Р….</span>
      </div>` : ''}

      <div class="sc-helper">
        <div class="sc-helper__text">
          <b>Р С™Р В»РЎР‹РЎвЂЎ Р Р…РЎС“Р В¶Р ВµР Р… РЎвЂљР С•Р В»РЎРЉР С”Р С• Р Т‘Р В»РЎРЏ Р Р†Р В°РЎв‚¬Р С‘РЎвЂ¦ Р В»Р В°Р в„–Р С”Р С•Р Р† Р С‘ Р С—РЎР‚Р С‘Р Р†Р В°РЎвЂљР Р…РЎвЂ№РЎвЂ¦ Р С—Р В»Р ВµР в„–Р В»Р С‘РЎРѓРЎвЂљР С•Р Р†.</b>
          Р СџР С•Р С‘РЎРѓР С”, Р Р†Р С•Р В»Р Р…Р В° Р С‘ Р Р†Р С•РЎРѓР С—РЎР‚Р С•Р С‘Р В·Р Р†Р ВµР Т‘Р ВµР Р…Р С‘Р Вµ РЎР‚Р В°Р В±Р С•РЎвЂљР В°РЎР‹РЎвЂљ Р С‘ Р В±Р ВµР В· Р Р…Р ВµР С–Р С•.
        </div>
        <div class="sc-helper__actions">
          <button class="btn btn--accent btn--sm" type="button" data-sc-open-apps>
            ${icon('external')} Р С›РЎвЂљР С”РЎР‚РЎвЂ№РЎвЂљРЎРЉ Р Р…Р В°РЎРѓРЎвЂљРЎР‚Р С•Р в„–Р С”Р С‘ Р С—РЎР‚Р С‘Р В»Р С•Р В¶Р ВµР Р…Р С‘РЎРЏ
          </button>
          <button class="btn btn--ghost btn--sm" type="button" data-sc-paste>
            ${icon('key')} Р вЂ™РЎРѓРЎвЂљР В°Р Р†Р С‘РЎвЂљРЎРЉ Р С‘Р В· Р В±РЎС“РЎвЂћР ВµРЎР‚Р В°
          </button>
        </div>
        <div class="sc-helper__hint" data-sc-state></div>
      </div>

      <div class="field">
        <label for="soundcloud-key">client_id <span style="text-transform:none;letter-spacing:0;color:var(--mute)">РІР‚вЂќ Р Р…Р ВµР С•Р В±РЎРЏР В·Р В°РЎвЂљР ВµР В»РЎРЉР Р…Р С•</span></label>
        <div class="input-wrap">
          <input class="input input--secret" id="soundcloud-key" name="clientId" type="text" spellcheck="false"
            placeholder="${app.settings?.soundcloud?.clientId ? esc(app.settings.soundcloud.clientId) : 'Р вЂўРЎРѓР В»Р С‘ Р С—РЎС“РЎРѓРЎвЂљР С• РІР‚вЂќ РЎРѓР ВµРЎР‚Р Р†Р ВµРЎР‚ Р С—Р С•Р В»РЎС“РЎвЂЎР С‘РЎвЂљ Р С”Р В»РЎР‹РЎвЂЎ РЎРѓР В°Р С'}">
          <button class="input-wrap__btn" type="button" data-reveal="soundcloud-key">Р СџР С•Р С”Р В°Р В·Р В°РЎвЂљРЎРЉ</button>
        </div>
        <span class="field__hint" data-hint="soundcloud:clientId">${savedHint('soundcloud', 'clientId')} Р’В· Р С—РЎС“Р В±Р В»Р С‘РЎвЂЎР Р…РЎвЂ№Р в„– Р С”Р В»РЎР‹РЎвЂЎ, Р Р…Р Вµ РЎРѓР ВµР С”РЎР‚Р ВµРЎвЂљ</span>
        <div class="sc-auto">
          <button class="btn btn--ghost btn--sm" type="button" data-sc-auto>${icon('refresh')} Р СџРЎР‚Р С•Р Р†Р ВµРЎР‚Р С‘РЎвЂљРЎРЉ Р В°Р Р†РЎвЂљР С•Р С”Р В»РЎР‹РЎвЂЎ</button>
          <span class="sc-auto__state" data-sc-auto-state>Р С—Р С•Р С‘РЎРѓР С” Р С‘ Р Р†Р С•Р В»Р Р…Р В° РЎР‚Р В°Р В±Р С•РЎвЂљР В°РЎР‹РЎвЂљ Р В±Р ВµР В· РЎРѓР Р†Р С•Р ВµР С–Р С• Р С”Р В»РЎР‹РЎвЂЎР В°</span>
        </div>
      </div>
      <div class="field">
        <label for="soundcloud-profile">Р РЋРЎРѓРЎвЂ№Р В»Р С”Р В° Р Р…Р В° Р Р†Р В°РЎв‚¬ Р С—РЎР‚Р С•РЎвЂћР С‘Р В»РЎРЉ <span style="text-transform:none;letter-spacing:0;color:var(--mute)">РІР‚вЂќ Р Т‘Р В»РЎРЏ Р В»Р В°Р в„–Р С”Р С•Р Р† Р В±Р ВµР В· Р Р†РЎвЂ¦Р С•Р Т‘Р В°</span></label>
        <input class="input" id="soundcloud-profile" name="profileUrl" type="url" spellcheck="false"
          placeholder="https://soundcloud.com/Р Р†Р В°РЎв‚¬-Р Р…Р С‘Р С”"
          value="${esc(app.settings?.soundcloud?.profileUrl || '')}">
        <span class="field__hint">РЎС“Р С”Р В°Р В·Р В°Р Р† Р С—РЎР‚Р С•РЎвЂћР С‘Р В»РЎРЉ, Р Р†РЎвЂ№ Р Р†Р С”Р В»РЎР‹РЎвЂЎР В°Р ВµРЎвЂљР Вµ Р В·Р В°Р С–РЎР‚РЎС“Р В·Р С”РЎС“ Р В»Р В°Р в„–Р С”Р С•Р Р† Р С—Р С• Р Р…Р ВµР СРЎС“ РІР‚вЂќ client_id Р Р…Р Вµ Р Р…РЎС“Р В¶Р ВµР Р…; Р С—РЎР‚Р С‘Р Р†РЎвЂ№РЎвЂЎР Р…Р ВµР Вµ Р С‘ Р Р…Р В°Р Т‘РЎвЂР В¶Р Р…Р ВµР Вµ Р С—РЎР‚Р С•РЎРѓРЎвЂљР С• Р Р…Р В°Р В¶Р В°РЎвЂљРЎРЉ Р’В«Р вЂ™Р С•Р в„–РЎвЂљР С‘ Р Р† SoundCloudР’В»</span>
      </div>

      ${soundcloudTokenHelp()}

      <div class="source-card__actions">
        <span class="source-card__error" data-form-error="soundcloud"></span>
        <button class="btn btn--accent btn--sm" type="submit">${icon('check')} Р РЋР С•РЎвЂ¦РЎР‚Р В°Р Р…Р С‘РЎвЂљРЎРЉ</button>
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
            placeholder="${app.settings?.spotify?.clientId ? esc(app.settings.spotify.clientId) : 'client id Р С—РЎР‚Р С‘Р В»Р С•Р В¶Р ВµР Р…Р С‘РЎРЏ'}">
          <span class="field__hint" data-hint="spotify:clientId">${savedHint('spotify', 'clientId')}</span>
        </div>
        <div class="field">
          <label for="spotify-secret">Client Secret</label>
          <div class="input-wrap">
            <input class="input input--secret" id="spotify-secret" name="clientSecret" type="password" spellcheck="false"
              placeholder="${app.settings?.spotify?.clientSecret ? esc(app.settings.spotify.clientSecret) : 'client secret'}">
            <button class="input-wrap__btn" type="button" data-reveal="spotify-secret">Р СџР С•Р С”Р В°Р В·Р В°РЎвЂљРЎРЉ</button>
          </div>
          <span class="field__hint" data-hint="spotify:clientSecret">${savedHint('spotify', 'clientSecret')}</span>
        </div>
      </div>

      <div class="sc-helper">
        <b>Р С™Р В»РЎР‹РЎвЂЎР С‘ Р Р…РЎС“Р В¶Р Р…РЎвЂ№ Р Т‘Р В»РЎРЏ Р С—Р С•Р С‘РЎРѓР С”Р В° Р Р† Spotify.</b>
        <span class="sc-helper__sub">Р В Р ВµР С–Р С‘РЎРѓРЎвЂљРЎР‚Р В°РЎвЂ Р С‘РЎРЏ Р В±Р ВµРЎРѓР С—Р В»Р В°РЎвЂљР Р…Р В°РЎРЏ РІР‚вЂќ Artist Pro Р Р…Р Вµ РЎвЂљРЎР‚Р ВµР В±РЎС“Р ВµРЎвЂљРЎРѓРЎРЏ.</span>
        <div class="sc-helper__row">
          <button class="btn btn--accent btn--sm" type="button" data-sp-open-dash>
            ${icon('external')} Р С›РЎвЂљР С”РЎР‚РЎвЂ№РЎвЂљРЎРЉ dashboard
          </button>
          <button class="btn btn--ghost btn--sm" type="button" data-sp-paste>
            ${icon('key')} Р вЂ™РЎРѓРЎвЂљР В°Р Р†Р С‘РЎвЂљРЎРЉ Р С‘Р В· Р В±РЎС“РЎвЂћР ВµРЎР‚Р В°
          </button>
        </div>
        <ol class="sc-helper__steps">
          <li>Р вЂ™Р С•Р в„–Р Т‘Р С‘РЎвЂљР Вµ Р Р† Spotify РІвЂ вЂ™ <b>Create app</b></li>
          <li>Р вЂєРЎР‹Р В±Р С•Р Вµ Р С‘Р СРЎРЏ; Redirect URI РІР‚вЂќ ${copy('http://127.0.0.1:8888/callback', 'URI')}</li>
          <li>Р С›РЎвЂљР СР ВµРЎвЂљРЎРЉРЎвЂљР Вµ <b>Web API</b>, РЎРѓР С•РЎвЂ¦РЎР‚Р В°Р Р…Р С‘РЎвЂљР Вµ</li>
          <li>Р РЋР С”Р С•Р С—Р С‘РЎР‚РЎС“Р в„–РЎвЂљР Вµ <b>Client ID</b> Р С‘ <b>Client Secret</b> Р Р† Р С—Р С•Р В»РЎРЏ Р Р†РЎвЂ№РЎв‚¬Р Вµ</li>
        </ol>
      </div>

      ${spotifyTokenHelp()}

      <div class="source-card__actions">
        <span class="source-card__error" data-form-error="spotify"></span>
        <button class="btn btn--accent btn--sm" type="submit">${icon('check')} Р РЋР С•РЎвЂ¦РЎР‚Р В°Р Р…Р С‘РЎвЂљРЎРЉ</button>
      </div>
    </form>`;
}

/** Р СњР В°РЎРѓРЎвЂљРЎР‚Р С•Р в„–Р С”Р С‘ РЎРѓР ВµРЎвЂљР С‘: Р С—РЎР‚Р С•Р С”РЎРѓР С‘ Р Т‘Р В»РЎРЏ Р Т‘Р С•РЎРѓРЎвЂљРЎС“Р С—Р В° Р С” SoundCloud Р С‘Р В· Р В Р В¤. */
function networkCard() {
  const net = app.settings?.network || {};
  const proxy = net.proxy || '';
  const useSystem = Boolean(net.useSystemProxy);
  const state = app.networkState || null;
  const active = Boolean(state?.active);

  const statusText = active
    ? `Р С’Р С”РЎвЂљР С‘Р Р†Р ВµР Р…: ${esc(state.activeMasked)}${state.activeSource === 'system' ? ' (РЎРѓР С‘РЎРѓРЎвЂљР ВµР СР Р…РЎвЂ№Р в„–)' : ''}`
    : 'Р СџРЎР‚Р С•Р С”РЎРѓР С‘ Р Р†РЎвЂ№Р С”Р В»РЎР‹РЎвЂЎР ВµР Р… РІР‚вЂќ Р В·Р В°Р С—РЎР‚Р С•РЎРѓРЎвЂ№ Р С‘Р Т‘РЎС“РЎвЂљ Р Р…Р В°Р С—РЎР‚РЎРЏР СРЎС“РЎР‹';

  return `<form class="source-card" data-source-form="network" novalidate>
      <header class="source-card__head">
        <div class="source-card__logo source-card__logo--net">${icon('connection')}</div>
        <div class="source-card__title">
          <h2>Р РЋР ВµРЎвЂљРЎРЉ Р С‘ Р С—РЎР‚Р С•Р С”РЎРѓР С‘</h2>
          <p>Р СњРЎС“Р В¶Р Р…Р С•, Р ВµРЎРѓР В»Р С‘ SoundCloud Р Р…Р Вµ Р С–РЎР‚РЎС“Р В·Р С‘РЎвЂљРЎРѓРЎРЏ Р В±Р ВµР В· VPN</p>
        </div>
        <span class="pill ${active ? 'pill--ok' : 'pill--idle'}">${active ? 'Р В°Р С”РЎвЂљР С‘Р Р†Р ВµР Р…' : 'Р Р†РЎвЂ№Р С”Р В»РЎР‹РЎвЂЎР ВµР Р…'}</span>
      </header>

      <p class="source-card__note">
        Р ВР В· Р В Р С•РЎРѓРЎРѓР С‘Р С‘ Р СР ВµР Т‘Р С‘Р В°-РЎРѓР ВµРЎР‚Р Р†Р ВµРЎР‚РЎвЂ№ SoundCloud РЎвЂЎР В°РЎРѓРЎвЂљР С• Р Р…Р ВµР Т‘Р С•РЎРѓРЎвЂљРЎС“Р С—Р Р…РЎвЂ№ Р Р…Р В°Р С—РЎР‚РЎРЏР СРЎС“РЎР‹: Р Р†Р С•Р В»Р Р…Р В° Р С‘ Р В»Р В°Р в„–Р С”Р С‘ Р С—РЎР‚Р С‘РЎвЂ¦Р С•Р Т‘РЎРЏРЎвЂљ,
        Р В° Р СРЎС“Р В·РЎвЂ№Р С”Р В° Р Р…Р Вµ Р С‘Р С–РЎР‚Р В°Р ВµРЎвЂљ. Р Р€Р С”Р В°Р В¶Р С‘РЎвЂљР Вµ Р В°Р Т‘РЎР‚Р ВµРЎРѓ РЎРѓР Р†Р С•Р ВµР С–Р С• Р С—РЎР‚Р С•Р С”РЎРѓР С‘ РІР‚вЂќ РЎвЂЎР ВµРЎР‚Р ВµР В· Р Р…Р ВµР С–Р С• Р С—Р С•Р в„–Р Т‘РЎС“РЎвЂљ Р Р†РЎРѓР Вµ Р В·Р В°Р С—РЎР‚Р С•РЎРѓРЎвЂ№,
        Р Р†Р С”Р В»РЎР‹РЎвЂЎР В°РЎРЏ Р В·Р Р†РЎС“Р С”.
      </p>

      <label class="field">
        <span class="field__label">Р С’Р Т‘РЎР‚Р ВµРЎРѓ Р С—РЎР‚Р С•Р С”РЎРѓР С‘</span>
        <input class="input" id="network-proxy" name="proxy" type="text" spellcheck="false"
          autocomplete="off" placeholder="socks5://127.0.0.1:1080"
          value="${esc(proxy)}">
        <span class="field__hint">Р СџР С•Р Т‘Р С•Р в„–Р Т‘РЎвЂРЎвЂљ socks5:// Р С‘Р В»Р С‘ http:// РІР‚вЂќ Р Р…Р В°Р С—РЎР‚Р С‘Р СР ВµРЎР‚ Р С—Р С•РЎР‚РЎвЂљ Р Р†Р В°РЎв‚¬Р ВµР С–Р С• VPN-Р С”Р В»Р С‘Р ВµР Р…РЎвЂљР В°</span>
      </label>

      <label class="switch-row">
        <input type="checkbox" id="network-system" name="useSystemProxy" ${useSystem ? 'checked' : ''}>
        <span>Р вЂРЎР‚Р В°РЎвЂљРЎРЉ Р С—РЎР‚Р С•Р С”РЎРѓР С‘ Р С‘Р В· Р Р…Р В°РЎРѓРЎвЂљРЎР‚Р С•Р ВµР С” Windows</span>
      </label>

      <div class="net-status ${active ? 'net-status--ok' : ''}" data-net-status>${statusText}</div>

      <div class="source-card__actions">
        <span class="source-card__error" data-form-error="network"></span>
        <button class="btn btn--ghost btn--sm" type="button" data-net-find>${icon('spark')} Р СњР В°Р в„–РЎвЂљР С‘ РЎР‚Р В°Р В±Р С•РЎвЂЎР С‘Р в„–</button>
        <button class="btn btn--ghost btn--sm" type="button" data-net-test>${icon('refresh')} Р СџРЎР‚Р С•Р Р†Р ВµРЎР‚Р С‘РЎвЂљРЎРЉ</button>
        <button class="btn btn--accent btn--sm" type="submit">${icon('check')} Р РЋР С•РЎвЂ¦РЎР‚Р В°Р Р…Р С‘РЎвЂљРЎРЉ</button>
      </div>
    </form>`;
}

function cardsHtml() {
  return yandexCard() + soundcloudCard() + spotifyCard() + networkCard();
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
        if (state.cls === 'err') text += ` Р’В· ${esc(state.detail)}`;
        else if (state.cls === 'ok') text += ' Р’В· Р Т‘Р С•РЎРѓРЎвЂљРЎС“Р С— Р С—РЎР‚Р С•Р Р†Р ВµРЎР‚Р ВµР Р…';
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
      toast(connected ? `Р СџР С•Р Т‘Р С”Р В»РЎР‹РЎвЂЎР ВµР Р…Р С• Р С‘РЎРѓРЎвЂљР С•РЎвЂЎР Р…Р С‘Р С”Р С•Р Р†: ${connected}` : 'Р РЋРЎвЂљР В°РЎвЂљРЎС“РЎРѓРЎвЂ№ Р С•Р В±Р Р…Р С•Р Р†Р В»Р ВµР Р…РЎвЂ№ РІР‚вЂќ Р С—Р С•Р С”Р В° Р В±Р ВµР В· Р С—Р С•Р Т‘Р С”Р В»РЎР‹РЎвЂЎР ВµР Р…Р С‘Р в„–', {
        type: connected ? 'ok' : 'warn',
        icon: connected ? 'check' : 'alert',
      });
    }
  } catch (err) {
    toast(err?.message || 'Р СњР Вµ РЎС“Р Т‘Р В°Р В»Р С•РЎРѓРЎРЉ Р С—Р С•Р В»РЎС“РЎвЂЎР С‘РЎвЂљРЎРЉ РЎРѓРЎвЂљР В°РЎвЂљРЎС“РЎРѓ', { type: 'err' });
  }
}

function reveal(inputId) {
  const input = screen.root?.querySelector(`#${inputId}`);
  if (!input) return;
  const button = screen.root?.querySelector(`[data-reveal="${inputId}"]`);
  const show = input.type === 'password';
  input.type = show ? 'text' : 'password';
  if (button) button.textContent = show ? 'Р РЋР С”РЎР‚РЎвЂ№РЎвЂљРЎРЉ' : 'Р СџР С•Р С”Р В°Р В·Р В°РЎвЂљРЎРЉ';
}

function setBusy(form, busy) {
  const button = form.querySelector('button[type="submit"]');
  const errorHint = form.querySelector('[data-form-error]');
  if (button) {
    button.disabled = busy;
    if (busy) button.dataset.label = button.innerHTML;
    button.innerHTML = busy ? '<span class="spinner" style="width:12px;height:12px;margin:0"></span> Р РЋР С•РЎвЂ¦РЎР‚Р В°Р Р…РЎРЏР ВµР СРІР‚В¦' : (button.dataset.label || button.innerHTML);
  }
  if (errorHint && busy) errorHint.textContent = '';
}

/**
 * Р С’Р Р†РЎвЂљР С•Р С—Р С•Р Т‘Р В±Р С•РЎР‚ Р С—РЎР‚Р С•Р С”РЎРѓР С‘: РЎРѓР ВµРЎР‚Р Р†Р ВµРЎР‚ Р С—Р ВµРЎР‚Р ВµР В±Р С‘РЎР‚Р В°Р ВµРЎвЂљ Р С—РЎС“Р В±Р В»Р С‘РЎвЂЎР Р…РЎвЂ№Р Вµ Р С—РЎР‚Р С•Р С”РЎРѓР С‘ Р С‘ Р С—РЎР‚Р С•Р Р†Р ВµРЎР‚РЎРЏР ВµРЎвЂљ РЎР‚Р ВµР В°Р В»РЎРЉР Р…Р С•Р Вµ
 * Р В°РЎС“Р Т‘Р С‘Р С• SoundCloud, Р Р…Р В°Р в„–Р Т‘Р ВµР Р…Р Р…РЎвЂ№Р в„– РЎРѓРЎР‚Р В°Р В·РЎС“ Р С—РЎР‚Р С‘Р СР ВµР Р…РЎРЏР ВµРЎвЂљРЎРѓРЎРЏ Р С‘ Р С—Р С•Р Т‘РЎРѓРЎвЂљР В°Р Р†Р В»РЎРЏР ВµРЎвЂљРЎРѓРЎРЏ Р Р† Р С—Р С•Р В»Р Вµ.
 */
async function autoFindProxy() {
  const host = screen.root?.querySelector('[data-net-status]');
  const button = screen.root?.querySelector('[data-net-find]');
  if (button) button.disabled = true;
  if (host) host.textContent = 'Р ВРЎвЂ°РЎС“ РЎР‚Р В°Р В±Р С•РЎвЂЎР С‘Р в„– Р С—РЎР‚Р С•Р С”РЎРѓР С‘РІР‚В¦ РЎРЊРЎвЂљР С• Р СР С•Р В¶Р ВµРЎвЂљ Р В·Р В°Р Р…РЎРЏРЎвЂљРЎРЉ Р Т‘Р С• Р СР С‘Р Р…РЎС“РЎвЂљРЎвЂ№';

  const result = await findProxy();

  if (button) button.disabled = false;

  if (!result?.ok) {
    const message = result?.cancelled ? 'Р СџР С•Р С‘РЎРѓР С” Р С•РЎРѓРЎвЂљР В°Р Р…Р С•Р Р†Р В»Р ВµР Р…' : (result?.message || 'Р В Р В°Р В±Р С•РЎвЂЎР С‘РЎвЂ¦ Р С—РЎР‚Р С•Р С”РЎРѓР С‘ Р Р…Р Вµ Р Р…Р В°РЎв‚¬Р В»Р С•РЎРѓРЎРЉ');
    if (host) host.textContent = message;
    toast(message, { type: 'warn' });
    return;
  }

  const input = screen.root?.querySelector('#network-proxy');
  if (input) input.value = result.proxy;
  const systemToggle = screen.root?.querySelector('#network-system');
  if (systemToggle) systemToggle.checked = false;

  const text = `Р СњР В°Р в„–Р Т‘Р ВµР Р… РЎР‚Р В°Р В±Р С•РЎвЂЎР С‘Р в„– Р С—РЎР‚Р С•Р С”РЎРѓР С‘: ${result.proxy} РІР‚вЂќ Р В°РЎС“Р Т‘Р С‘Р С• SoundCloud Р С”Р В°РЎвЂЎР В°Р ВµРЎвЂљРЎРѓРЎРЏ`;
  if (host) host.textContent = text;
  toast(text, { icon: 'check' });
  app.networkState = await getNetwork();
}

/** Р СџРЎР‚Р С•Р Р†Р ВµРЎР‚Р С”Р В° РЎРѓР С•Р ВµР Т‘Р С‘Р Р…Р ВµР Р…Р С‘РЎРЏ РЎРѓ SoundCloud: Р С‘Р Т‘РЎвЂРЎвЂљ Р В»Р С‘ РЎвЂљРЎР‚Р В°РЎвЂћР С‘Р С” РЎвЂЎР ВµРЎР‚Р ВµР В· Р С—РЎР‚Р С•Р С”РЎРѓР С‘. */
async function runNetworkTest() {
  const host = screen.root?.querySelector('[data-net-status]');
  if (host) host.textContent = 'Р СџРЎР‚Р С•Р Р†Р ВµРЎР‚РЎРЏРЎР‹ РЎРѓР С•Р ВµР Т‘Р С‘Р Р…Р ВµР Р…Р С‘Р ВµРІР‚В¦';

  const result = await testNetwork();
  if (result?.error) {
    if (host) host.textContent = 'Р СњР Вµ РЎС“Р Т‘Р В°Р В»Р С•РЎРѓРЎРЉ: ' + result.error;
    toast('Р СџРЎР‚Р С•Р Р†Р ВµРЎР‚Р С”Р В° Р Р…Р Вµ Р С—РЎР‚Р С•РЎв‚¬Р В»Р В°: ' + result.error, { type: 'err' });
    return;
  }

  const via = result.viaProxy;
  const text = via
    ? `SoundCloud Р С•РЎвЂљР Р†Р ВµРЎвЂЎР В°Р ВµРЎвЂљ Р В·Р В° ${via.ms} Р СРЎРѓ (Р С”Р С•Р Т‘ ${via.status})`
    : 'SoundCloud Р Р…Р Вµ Р С•РЎвЂљР Р†Р ВµРЎвЂЎР В°Р ВµРЎвЂљ';
  if (host) host.textContent = text;
  toast(text, { icon: via ? 'check' : 'alert' });
}

async function submitForm(form) {
  const source = form.dataset.sourceForm;
  const data = new FormData(form);
  const values = {
    token: String(data.get('token') || '').trim(),
    clientId: String(data.get('clientId') || '').trim(),
    clientSecret: String(data.get('clientSecret') || '').trim(),
    proxy: String(data.get('proxy') || '').trim(),
    useSystemProxy: Boolean(data.get('useSystemProxy')),
  };
  const errorHint = form.querySelector('[data-form-error]');

  // РЎРѓР ВµРЎвЂљРЎРЉ Р С‘ Р С—РЎР‚Р С•Р С”РЎРѓР С‘ РІР‚вЂќ Р С•РЎвЂљР Т‘Р ВµР В»РЎРЉР Р…Р В°РЎРЏ Р Р†Р ВµРЎвЂљР С”Р В°, Р С•РЎРѓРЎвЂљР В°Р В»РЎРЉР Р…Р С•Р в„– Р С”Р С•Р Т‘ Р Р…Р Вµ РЎвЂљРЎР‚Р С•Р С–Р В°Р ВµР С
  if (source === 'network') {
    const result = await saveNetwork({ proxy: values.proxy, useSystemProxy: values.useSystemProxy });
    if (!result.ok) {
      if (errorHint) errorHint.textContent = result.error || 'Р СњР Вµ РЎС“Р Т‘Р В°Р В»Р С•РЎРѓРЎРЉ РЎРѓР С•РЎвЂ¦РЎР‚Р В°Р Р…Р С‘РЎвЂљРЎРЉ';
      toast(result.error || 'Р СњР Вµ РЎС“Р Т‘Р В°Р В»Р С•РЎРѓРЎРЉ РЎРѓР С•РЎвЂ¦РЎР‚Р В°Р Р…Р С‘РЎвЂљРЎРЉ Р С—РЎР‚Р С•Р С”РЎРѓР С‘', { type: 'err' });
      return;
    }
    app.networkState = result;
    if (errorHint) errorHint.textContent = '';
    toast(result.active ? 'Р СџРЎР‚Р С•Р С”РЎРѓР С‘ Р Р†Р С”Р В»РЎР‹РЎвЂЎРЎвЂР Р…' : 'Р СџРЎР‚Р С•Р С”РЎРѓР С‘ Р Р†РЎвЂ№Р С”Р В»РЎР‹РЎвЂЎР ВµР Р…', { icon: 'check' });
    paintStates();
    reload({ withToast: false });
    return;
  }

  let payload = null;
  if (source === 'yandex') {
    if (!values.token) {
      if (errorHint) errorHint.textContent = 'Р вЂ™РЎРѓРЎвЂљР В°Р Р†РЎРЉРЎвЂљР Вµ РЎвЂљР С•Р С”Р ВµР Р…';
      toast('Р вЂ™РЎРѓРЎвЂљР В°Р Р†РЎРЉРЎвЂљР Вµ OAuth-РЎвЂљР С•Р С”Р ВµР Р… Р Р‡Р Р…Р Т‘Р ВµР С”РЎРѓР В°', { type: 'warn' });
      return;
    }
    payload = { yandex: { token: values.token } };
  } else if (source === 'soundcloud') {
    if (!values.clientId) {
      if (errorHint) errorHint.textContent = 'Р вЂ™Р Р†Р ВµР Т‘Р С‘РЎвЂљР Вµ client_id';
      toast('Р вЂ™Р Р†Р ВµР Т‘Р С‘РЎвЂљР Вµ client_id SoundCloud Р С‘Р В»Р С‘ Р С•РЎРѓРЎвЂљР В°Р Р†РЎРЉРЎвЂљР Вµ Р С—Р С•Р В»Р Вµ Р С—РЎС“РЎРѓРЎвЂљРЎвЂ№Р С', { type: 'warn' });
      return;
    }
    payload = { soundcloud: { clientId: values.clientId } };
  } else {
    if (!values.clientId && !values.clientSecret) {
      if (errorHint) errorHint.textContent = 'Р СњРЎС“Р В¶Р ВµР Р… client id Р С‘Р В»Р С‘ secret';
      toast('Р вЂ”Р В°Р С—Р С•Р В»Р Р…Р С‘РЎвЂљР Вµ Client ID Р С‘ Client Secret', { type: 'warn' });
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
    toast('Р СњР В°РЎРѓРЎвЂљРЎР‚Р С•Р в„–Р С”Р С‘ РЎРѓР С•РЎвЂ¦РЎР‚Р В°Р Р…Р ВµР Р…РЎвЂ№ РІР‚вЂќ Р С—РЎР‚Р С•Р Р†Р ВµРЎР‚РЎРЏР ВµР С Р С—Р С•Р Т‘Р С”Р В»РЎР‹РЎвЂЎР ВµР Р…Р С‘Р Вµ', { icon: 'check' });
    await reload();
  } catch (err) {
    const message = err?.message || 'Р РЋР ВµРЎР‚Р Р†Р ВµРЎР‚ Р Р…Р Вµ Р С—РЎР‚Р С‘Р Р…РЎРЏР В» Р Р…Р В°РЎРѓРЎвЂљРЎР‚Р С•Р в„–Р С”Р С‘';
    if (errorHint) errorHint.textContent = message;
    toast(message, { type: 'err', duration: 4600 });
  } finally {
    setBusy(form, false);
  }
}

function onClick(event) {
  const target = event.target instanceof Element ? event.target : null;

  // Р С—Р С•Р СР С•РЎвЂ°Р Р…Р С‘Р С” SoundCloud: Р С•РЎвЂљР С”РЎР‚РЎвЂ№РЎвЂљРЎРЉ РЎРѓРЎвЂљРЎР‚Р В°Р Р…Р С‘РЎвЂ РЎС“ Р С—РЎР‚Р С‘Р В»Р С•Р В¶Р ВµР Р…Р С‘Р в„– Р С‘ Р Р†РЎРѓРЎвЂљР В°Р Р†Р С‘РЎвЂљРЎРЉ Р С”Р В»РЎР‹РЎвЂЎ Р С‘Р В· Р В±РЎС“РЎвЂћР ВµРЎР‚Р В°
  // Р С”Р С•Р С—Р С‘РЎР‚РЎС“Р ВµР СР С•Р Вµ Р В·Р Р…Р В°РЎвЂЎР ВµР Р…Р С‘Р Вµ Р С‘Р В· Р С‘Р Р…РЎРѓРЎвЂљРЎР‚РЎС“Р С”РЎвЂ Р С‘Р С‘
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

  if (target?.closest('[data-sp-open-dash]')) {
    window.open('https://developer.spotify.com/dashboard', '_blank', 'noopener');
    return;
  }

  if (target?.closest('[data-sp-paste]')) {
    pasteSpotifyKey();
    return;
  }

  if (target?.closest('[data-net-find]')) {
    autoFindProxy();
    return;
  }

  if (target?.closest('[data-net-test]')) {
    runNetworkTest();
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
 * Р вЂ™РЎвЂ¦Р С•Р Т‘ Р Р† Р Р‡Р Р…Р Т‘Р ВµР С”РЎРѓ РЎвЂЎР ВµРЎР‚Р ВµР В· Р С•Р С”Р Р…Р С• OAuth (Р Т‘Р С•РЎРѓРЎвЂљРЎС“Р С—Р Р…Р С• РЎвЂљР С•Р В»РЎРЉР С”Р С• Р Р† Р Т‘Р ВµРЎРѓР С”РЎвЂљР С•Р С—Р Р…Р С•Р в„– Р С•Р В±Р С•Р В»Р С•РЎвЂЎР С”Р Вµ:
 * Р Р† Р С•Р В±РЎвЂ№РЎвЂЎР Р…Р С•Р С Р В±РЎР‚Р В°РЎС“Р В·Р ВµРЎР‚Р Вµ РЎвЂљР В°Р С”Р С•Р С–Р С• Р СР С•РЎРѓРЎвЂљР В° Р Р…Р ВµРЎвЂљ, Р С‘ Р СРЎвЂ№ РЎвЂЎР ВµРЎРѓРЎвЂљР Р…Р С• Р С•Р В± РЎРЊРЎвЂљР С•Р С Р С–Р С•Р Р†Р С•РЎР‚Р С‘Р С).
 */
/** Р вЂ™РЎвЂ¦Р С•Р Т‘ Р Р† SoundCloud РЎвЂЎР ВµРЎР‚Р ВµР В· Р С•Р С”Р Р…Р С• Р С—РЎР‚Р С‘Р В»Р С•Р В¶Р ВµР Р…Р С‘РЎРЏ: РЎРѓР ВµРЎРѓРЎРѓР С‘РЎРЏ РЎРѓР С•РЎвЂ¦РЎР‚Р В°Р Р…РЎРЏР ВµРЎвЂљРЎРѓРЎРЏ, Р В»Р В°Р в„–Р С”Р С‘ РЎвЂљРЎРЏР Р…РЎС“РЎвЂљРЎРѓРЎРЏ РЎРѓР В°Р СР С‘. */
async function signInSoundCloud() {
  const bridge = desktopBridge();
  if (!bridge || typeof bridge.signInSoundCloud !== 'function') {
    toast('Р вЂ™РЎвЂ¦Р С•Р Т‘ Р Р† SoundCloud Р Т‘Р С•РЎРѓРЎвЂљРЎС“Р С—Р ВµР Р… Р Р† Р С—РЎР‚Р С‘Р В»Р С•Р В¶Р ВµР Р…Р С‘Р С‘ labsoul', { type: 'warn' });
    return;
  }
  try {
    const result = await bridge.signInSoundCloud();
    if (result && result.ok) {
      toast('SoundCloud Р С—Р С•Р Т‘Р С”Р В»РЎР‹РЎвЂЎРЎвЂР Р… РІР‚вЂќ Р В»Р В°Р в„–Р С”Р С‘ Р С—Р С•Р Т‘РЎвЂљРЎРЏР Р…РЎС“РЎвЂљРЎРѓРЎРЏ Р В°Р Р†РЎвЂљР С•Р СР В°РЎвЂљР С‘РЎвЂЎР ВµРЎРѓР С”Р С‘', { icon: 'check' });
      reload({ withToast: false });
    } else if (result && result.error) {
      toast('Р СњР Вµ РЎС“Р Т‘Р В°Р В»Р С•РЎРѓРЎРЉ Р Р†Р С•Р в„–РЎвЂљР С‘: ' + result.error, { type: 'err' });
    }
  } catch (err) {
    toast(err?.message || 'Р С›Р С”Р Р…Р С• Р Р†РЎвЂ¦Р С•Р Т‘Р В° Р Р…Р Вµ Р С•РЎвЂљР С”РЎР‚РЎвЂ№Р В»Р С•РЎРѓРЎРЉ', { type: 'err' });
  }
}

async function signInYandex() {
  const bridge = desktopBridge();
  if (!bridge) {
    toast('Р вЂ™РЎвЂ¦Р С•Р Т‘ Р Р† Р Р‡Р Р…Р Т‘Р ВµР С”РЎРѓ Р Т‘Р С•РЎРѓРЎвЂљРЎС“Р С—Р ВµР Р… Р Р† Р С—РЎР‚Р С‘Р В»Р С•Р В¶Р ВµР Р…Р С‘Р С‘ labsoul РІР‚вЂќ Р В·Р Т‘Р ВµРЎРѓРЎРЉ Р Р†РЎРѓРЎвЂљР В°Р Р†РЎРЉРЎвЂљР Вµ РЎвЂљР С•Р С”Р ВµР Р… Р Р†РЎР‚РЎС“РЎвЂЎР Р…РЎС“РЎР‹', { type: 'warn' });
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
      toast(result.user ? `Р вЂ™РЎвЂ№ Р Р†Р С•РЎв‚¬Р В»Р С‘ Р С”Р В°Р С” ${result.user}` : 'Р Р‡Р Р…Р Т‘Р ВµР С”РЎРѓ.Р СљРЎС“Р В·РЎвЂ№Р С”Р В° Р С—Р С•Р Т‘Р С”Р В»РЎР‹РЎвЂЎР ВµР Р…Р В°', { icon: 'check' });
      await reload();
      return;
    }
    if (result && result.error === 'closed') return; // Р С—Р С•Р В»РЎРЉР В·Р С•Р Р†Р В°РЎвЂљР ВµР В»РЎРЉ РЎРѓР В°Р С Р В·Р В°Р С”РЎР‚РЎвЂ№Р В» Р С•Р С”Р Р…Р С•
    const message = (result && result.message) || 'Р СњР Вµ РЎС“Р Т‘Р В°Р В»Р С•РЎРѓРЎРЉ Р Р†Р С•Р в„–РЎвЂљР С‘ Р Р† Р Р‡Р Р…Р Т‘Р ВµР С”РЎРѓ';
    if (errorHint) errorHint.textContent = message;
    toast(message, { type: 'err', duration: 5000 });
  } catch (err) {
    toast(err?.message || 'Р СњР Вµ РЎС“Р Т‘Р В°Р В»Р С•РЎРѓРЎРЉ Р С•РЎвЂљР С”РЎР‚РЎвЂ№РЎвЂљРЎРЉ Р С•Р С”Р Р…Р С• Р Р†РЎвЂ¦Р С•Р Т‘Р В°', { type: 'err' });
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
  title: 'Р СџР С•Р Т‘Р С”Р В»РЎР‹РЎвЂЎР ВµР Р…Р С‘РЎРЏ',

  render(container) {
    container.innerHTML = `
      <div class="page-head">
        <div class="page-head__main">
          <div class="kicker">Р С‘РЎРѓРЎвЂљР С•РЎвЂЎР Р…Р С‘Р С”Р С‘ Р В·Р Р†РЎС“Р С”Р В°</div>
          <h1>Р СџР С•Р Т‘Р С”Р В»РЎР‹РЎвЂЎР ВµР Р…Р С‘РЎРЏ</h1>
          <p>Р СћР С•Р С”Р ВµР Р…РЎвЂ№ Р С‘ Р С”Р В»РЎР‹РЎвЂЎР С‘ РЎвЂ¦РЎР‚Р В°Р Р…РЎРЏРЎвЂљРЎРѓРЎРЏ Р В»Р С•Р С”Р В°Р В»РЎРЉР Р…Р С• Р Р…Р В° РЎРѓР ВµРЎР‚Р Р†Р ВµРЎР‚Р Вµ Р С‘ Р Р…Р С‘Р С”Р С•Р С–Р Т‘Р В° Р Р…Р Вµ Р С•РЎвЂљР Т‘Р В°РЎР‹РЎвЂљРЎРѓРЎРЏ Р Р† Р В±РЎР‚Р В°РЎС“Р В·Р ВµРЎР‚ РЎвЂ Р ВµР В»Р С‘Р С”Р С•Р С РІР‚вЂќ РЎвЂљР С•Р В»РЎРЉР С”Р С• Р СР В°РЎРѓР С”Р В°.</p>
        </div>
        <div class="page-head__actions">
          <button class="btn btn--ghost btn--sm" type="button" data-src="refresh">${icon('refresh')} Р СџРЎР‚Р С•Р Р†Р ВµРЎР‚Р С‘РЎвЂљРЎРЉ РЎРѓР Р†РЎРЏР В·РЎРЉ</button>
        </div>
      </div>

      <div class="sources-overview" id="sources-overview">${overviewHtml()}</div>
      <div class="source-grid">${cardsHtml()}</div>

      <div class="sources-note">
        <div class="notice">
          ${icon('lock')}
          <div><b>Р С™Р В°Р С” РЎРЊРЎвЂљР С• РЎС“РЎРѓРЎвЂљРЎР‚Р С•Р ВµР Р…Р С•.</b> PUT /api/settings РЎРѓР С•РЎвЂ¦РЎР‚Р В°Р Р…РЎРЏР ВµРЎвЂљ Р С”Р В»РЎР‹РЎвЂЎР С‘ Р Р† Р В»Р С•Р С”Р В°Р В»РЎРЉР Р…РЎвЂ№РЎвЂ¦ Р Р…Р В°РЎРѓРЎвЂљРЎР‚Р С•Р в„–Р С”Р В°РЎвЂ¦ РЎРѓР ВµРЎР‚Р Р†Р ВµРЎР‚Р В°, GET /api/settings Р Р†Р С•Р В·Р Р†РЎР‚Р В°РЎвЂ°Р В°Р ВµРЎвЂљ РЎвЂљР С•Р В»РЎРЉР С”Р С• Р СР В°РЎРѓР С”РЎС“ Р Р†Р С‘Р Т‘Р В° <code>РІР‚СћРІР‚СћРІР‚СћРІР‚Сћ1234</code>.
          Р СћР С•Р С”Р ВµР Р…РЎвЂ№ Р Р…Р Вµ Р С—Р С‘РЎв‚¬РЎС“РЎвЂљРЎРѓРЎРЏ Р Р† localStorage Р В±РЎР‚Р В°РЎС“Р В·Р ВµРЎР‚Р В° Р С‘ Р Р…Р Вµ РЎС“РЎвЂ¦Р С•Р Т‘РЎРЏРЎвЂљ РЎвЂљРЎР‚Р ВµРЎвЂљРЎРЉР С‘Р С Р В»Р С‘РЎвЂ Р В°Р С. Р С›РЎвЂљР С”Р В»РЎР‹РЎвЂЎР С‘РЎвЂљРЎРЉ Р С‘РЎРѓРЎвЂљР С•РЎвЂЎР Р…Р С‘Р С” Р СР С•Р В¶Р Р…Р С•, Р Р…Р Вµ РЎРѓР С•РЎвЂ¦РЎР‚Р В°Р Р…РЎРЏРЎРЏ Р Р…Р С•Р Р†РЎвЂ№Р в„– РЎвЂљР С•Р С”Р ВµР Р….</div>
        </div>
        <div class="about-card">
          <span class="brand__mark">${icon('wave')}</span>
          <div><b>labsoul</b> РІР‚вЂќ РЎРѓР Р†Р С•Р в„– Р С—Р В»Р ВµР ВµРЎР‚: Р Р‡Р Р…Р Т‘Р ВµР С”РЎРѓ.Р СљРЎС“Р В·РЎвЂ№Р С”Р В°, SoundCloud, Spotify. Р вЂєР С•Р С”Р В°Р В»РЎРЉР Р…РЎвЂ№Р в„– РЎРѓР ВµРЎР‚Р Р†Р ВµРЎР‚ Р Р…Р В° Node Р В±Р ВµР В· Р В·Р В°Р Р†Р С‘РЎРѓР С‘Р СР С•РЎРѓРЎвЂљР ВµР в„–, Р Р†Р В°Р Р…Р С‘Р В»РЎРЉР Р…РЎвЂ№Р в„– Р С‘Р Р…РЎвЂљР ВµРЎР‚РЎвЂћР ВµР в„–РЎРѓ, Р Р…Р С•Р В»РЎРЉ Р Р†Р Р…Р ВµРЎв‚¬Р Р…Р С‘РЎвЂ¦ CDN.</div>
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

    // РЎРѓР С•РЎРѓРЎвЂљР С•РЎРЏР Р…Р С‘Р Вµ Р С—РЎР‚Р С•Р С”РЎРѓР С‘ Р С—Р С•Р Т‘РЎвЂљРЎРЏР С–Р С‘Р Р†Р В°Р ВµР С Р С•РЎвЂљР Т‘Р ВµР В»РЎРЉР Р…Р С•: Р С”Р В°РЎР‚РЎвЂљР С•РЎвЂЎР С”Р В° РЎРѓР ВµРЎвЂљР С‘ РЎР‚Р С‘РЎРѓРЎС“Р ВµРЎвЂљРЎРѓРЎРЏ Р Т‘Р С• Р В·Р В°Р С–РЎР‚РЎС“Р В·Р С”Р С‘
    getNetwork().then((state) => {
      app.networkState = state;
      paintStates();
    });
  },

  destroy() {
    for (const off of screen.unsubs.splice(0)) {
      try { off(); } catch { /* ignore */ }
    }
    screen.root = null;
  },
};

export default screenModule;
