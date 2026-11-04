/**
 * labsoul — короткие пояснения: где брать токены и что нужно на самом деле.
 *
 * Правило: текст должен быть полезным, а не длинным. Если что-то работает
 * само — так и пишем одной строкой. Пошаговые инструкции прячем в
 * раскрывающийся блок, чтобы не загромождать карточку.
 */

import { icon } from '../components.js';

const link = (url, text = url) =>
  `<a href="${url}" target="_blank" rel="noreferrer noopener">${text}</a>`;

/** Копируемое значение: клик — и текст в буфере обмена. */
export const copy = (text, label = '') =>
  `<button class="tokens__copy" type="button" data-copy="${text}" title="Копировать">${label || text}${icon('copy')}</button>`;

/** Раскрывающийся блок с шагами. */
function steps({ title, items = [], note = '' }) {
  return `
    <details class="steps tokens">
      <summary>${icon('chev-down')} ${title}</summary>
      <ol>${items.map((item) => `<li>${item}</li>`).join('')}</ol>
      ${note ? `<p class="tokens__note">${note}</p>` : ''}
    </details>`;
}

/**
 * Яндекс.Музыка.
 *
 * Вход через окно приложения — основной путь. Ручной токен оставляем
 * только как запасной, и коротко: кому нужно, тот знает, что делает.
 */
export function yandexTokenHelp() {
  return steps({
    title: 'Токен вручную — если вход через окно не сработал',
    items: [
      `Откройте ${link('https://music.yandex.ru/', 'music.yandex.ru')}, нажмите F12.`,
      'Вкладка Network → фильтр <code>api.music.yandex.net</code> → обновите страницу.',
      'Любой запрос → Request Headers → строка <code>authorization: OAuth</code>.',
      'Скопируйте значение после <code>OAuth </code> и вставьте в поле выше.',
    ],
    note: 'Токен хранится только на вашем компьютере.',
  });
}

/**
 * SoundCloud.
 *
 * Главное, что должен понять человек: ключ НЕ нужен. Поиск, волна и
 * воспроизведение работают сами. Ключ нужен только для лайков и
 * приватных плейлистов — и то после входа через окно приложения.
 */
export function soundcloudTokenHelp() {
  return steps({
    title: 'Зачем ключ и когда он нужен',
    items: [
      '<b>Не нужен</b> для поиска, волны и воспроизведения — labsoul получает его сам.',
      'Нужен только для лайков и приватных плейлистов — но проще нажать «Войти в SoundCloud» выше: ключ подставится автоматически.',
      `Если вводите вручную: ${link('https://soundcloud.com/you/apps', 'soundcloud.com/you/apps')} → Register a new application → скопируйте Client ID.`,
    ],
    note: 'Client ID — публичный ключ приложения, не пароль.',
  });
}

/** Spotify: без своих ключей не работает, объясняем коротко. */
export function spotifyTokenHelp() {
  return steps({
    title: 'Spotify требует свои ключи',
    items: [
      'Своих ключей у labsoul нет: Spotify выдаёт их только владельцу приложения.',
      `Создайте приложение на ${link('https://developer.spotify.com/dashboard', 'developer.spotify.com/dashboard')} — это бесплатно.`,
      'Скопируйте Client ID и Client Secret в поля выше.',
      'Воспроизведение Spotify не отдаёт никому — только поиск и каталог.',
    ],
  });
}
