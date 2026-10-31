/**
 * labsoul — наглядные инструкции: где брать токены и ключи.
 *
 * Каждая карточка: почему нужен ключ, пошагово где взять, что вставить
 * и что будет работать после подключения. Возвращают HTML-строку.
 */

import { icon } from '../components.js';

const link = (url, text = url) =>
  `<a href="${url}" target="_blank" rel="noreferrer noopener">${text}</a>`;

const code = (text) => `<code>${text}</code>`;

/** Общая обёртка шагов. */
function steps({ title = 'Где взять', items = [], note = '' }) {
  return `
    <details class="steps tokens">
      <summary>${icon('chev-down')} ${title}</summary>
      <ol>${items.map((item) => `<li>${item}</li>`).join('')}</ol>
      ${note ? `<p class="tokens__note">${note}</p>` : ''}
    </details>`;
}

/** Яндекс.Музыка: OAuth-токен. */
export function yandexTokenHelp() {
  return steps({
    title: 'Где взять OAuth-токен Яндекс.Музыки',
    items: [
      `<b>Проще всего:</b> нажмите кнопку «Войти в Яндекс.Музыку» выше — откроется окно Яндекса, после входа токен сохранится сам.`,
      `Вручную: откройте ${link('https://music.yandex.ru/', 'music.yandex.ru')} и войдите в свой аккаунт.`,
      `Нажмите ${code('F12')} → вкладка ${code('Network')} (Сеть) → в фильтре введите ${code('api.music.yandex.net')}.`,
      `Обновите страницу (${code('F5')}) — появятся запросы. Откройте любой, например ${code('/rotor/station')}.`,
      `В блоке ${code('Request Headers')} найдите строку ${code('authorization: OAuth ...')}.`,
      `Скопируйте всё после слова ${code('OAuth ')} — это и есть токен (около 40 символов).`,
      `Вставьте в поле выше и нажмите «Сохранить»: сервер сразу проверит доступ и покажет статус.`,
    ],
    note: `Токен даёт доступ к вашему аккаунту (лайки, волна) — держите его при себе. labsoul хранит его только на вашем компьютере и никуда не отправляет.`,
  });
}

/** SoundCloud: постоянный client_id + профиль. */
export function soundcloudTokenHelp() {
  return steps({
    title: 'Где взять client_id SoundCloud (и зачем профиль)',
    items: [
      `Обычные поиск и волна работают без ключа — labsoul сам берёт публичный ${code('client_id')} из веб-плеера.`,
      `Для <b>лайков</b> нужен постоянный ключ своего приложения: откройте ${link('https://soundcloud.com/you/apps', 'soundcloud.com/you/apps')} и войдите.`,
      `Нажмите ${code('Register a new application')}. Название любое, например ${code('labsoul')}; согласитесь с условиями.`,
      `На странице приложения найдите ${code('Client ID')} — строка из 32 символов. Скопируйте её.`,
      `Вставьте в поле ${code('client_id')} выше и сохраните.`,
      `Ниже укажите ссылку на свой профиль, например ${code('https://soundcloud.com/ваш-ник')} — по ней labsoul найдёт ваши лайки.`,
    ],
    note: `Client ID — не пароль: он не даёт доступа к чужому аккаунту. Public client_id из браузера лайки отдать не может (SoundCloud отвечает 401), поэтому нужен ключ своего приложения.`,
  });
}

/** Spotify: только поиск и ссылки, вход не поддерживается. */
export function spotifyTokenHelp() {
  return steps({
    title: 'О Spotify: что работает и чего не будет',
    items: [
      `Откройте ${link('https://developer.spotify.com/dashboard', 'developer.spotify.com/dashboard')} и войдите.`,
      `<b>Create app</b>: название любое, ${code('Redirect URI')} — ${code('http://127.0.0.1:5270/')}.`,
      `В настройках приложения нажмите ${code('View client secret')} и скопируйте ${code('Client ID')} и ${code('Client secret')}.`,
      `Вставьте их в карточку Spotify выше — после этого работает поиск и импорт по ссылкам.`,
    ],
    note: `<b>Честно:</b> «Мне нравится» и воспроизведение из Spotify без входа в ваш аккаунт недоступны. Spotify требует пользовательскую авторизацию (PKCE + подтверждение в браузере), а потоковое воспроизведение закрыто для сторонних приложений. labsoul умеет искать каталог Spotify, показывать превью (30 секунд, если сервис их отдаёт) и импортировать трек по ссылке.`,
  });
}

/** Краткая сводка «что заработает после подключения». */
export function likesSummary() {
  return `
    <div class="likes-summary">
      <div class="likes-summary__row">
        <span class="likes-summary__badge is-ok">Яндекс</span>
        <span>лайки, волна, воспроизведение — нужен только токен</span>
      </div>
      <div class="likes-summary__row">
        <span class="likes-summary__badge is-ok">SoundCloud</span>
        <span>поиск и волна — без ключа; лайки — нужен client_id и ссылка на профиль</span>
      </div>
      <div class="likes-summary__row">
        <span class="likes-summary__badge is-warn">Spotify</span>
        <span>поиск и ссылки; лайки без входа в аккаунт недоступны</span>
      </div>
    </div>`;
}
