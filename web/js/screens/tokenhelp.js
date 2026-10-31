/**
 * labsoul — наглядные инструкции: где брать токены и ключи.
 *
 * Каждая карточка: почему нужен ключ, что нажать, что скопировать.
 * Значения, которые нужно вводить, оформлены кнопкой `copy()`:
 * один клик — и текст уже в буфере обмена.
 */

import { icon } from '../components.js';

const link = (url, text = url) =>
  `<a href="${url}" target="_blank" rel="noreferrer noopener">${text}</a>`;

const code = (text) => `<code>${text}</code>`;

/** Копируемое значение: клик — и текст в буфере обмена. */
const copy = (text, label = '') =>
  `<button class="tokens__copy" type="button" data-copy="${text}" title="Копировать">${label || text}${icon('copy')}</button>`;

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
    title: 'Где взять токен Яндекс.Музыки',
    items: [
      '<b>Проще всего:</b> нажмите «Войти в Яндекс.Музыку» выше — токен сохранится сам, копировать ничего не нужно.',
      `Вручную: войдите на ${link('https://music.yandex.ru/', 'music.yandex.ru')} и откройте инструменты разработчика (${copy('F12')}).`,
      `Вкладка Network, в поле фильтра вставьте ${copy('api.music.yandex.net')} и обновите страницу.`,
      `Щёлкните любой запрос → Request Headers → найдите строку ${copy('authorization: OAuth')}.`,
      `Скопируйте всё после ${copy('OAuth ')} — это токен (около 40 символов). Вставьте его в поле выше.`,
    ],
    note: 'Токен даёт доступ к вашему аккаунту — он хранится только на вашем компьютере и никуда не отправляется.',
  });
}

/** SoundCloud: постоянный client_id + профиль. */
export function soundcloudTokenHelp() {
  return steps({
    title: 'Ключ SoundCloud — только для лайков и приватных плейлистов',
    items: [
      'Поиск, волна и воспроизведение работают <b>без ключа</b> — labsoul берёт его сам.',
      `Откройте ${link('https://soundcloud.com/you/apps', 'soundcloud.com/you/apps')} и нажмите ${copy('Register a new application')}.`,
      `Название — любое (${copy('labsoul')}), Redirect URI — ${copy('http://127.0.0.1:5270/')}, подтвердите согласие.`,
      `На странице приложения найдите ${copy('Client ID')} — это 32 символа. Затем нажмите кнопку «Вставить из буфера» выше.`,
      `Ниже укажите ссылку на свой профиль, например ${copy('https://soundcloud.com/')} — по ней найдутся ваши лайки.`,
    ],
    note: 'Client ID — не пароль: он не даёт доступа к чужому аккаунту.',
  });
}

/** Spotify: только поиск и ссылки. */
export function spotifyTokenHelp() {
  return steps({
    title: 'Spotify: что работает без входа',
    items: [
      'Поиск и импорт по ссылкам работают <b>без ключей</b> — вводить ничего не нужно.',
      `Ключи из ${link('https://developer.spotify.com/dashboard', 'developer.spotify.com/dashboard')} нужны только если сервис начнёт отклонять анонимные запросы.`,
      'Избранное и плейлисты Spotify без входа в аккаунт недоступны — это ограничение самого Spotify.',
    ],
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
