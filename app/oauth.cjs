'use strict';

/**
 * Вход в Яндекс.Музыку прямо из приложения (без ручного копирования токена).
 *
 * Схема: OAuth implicit flow. Открываем окно на oauth.yandex.ru, после логина
 * Яндекс возвращает управление на music.yandex.ru с параметрами в hash-части:
 *   https://music.yandex.ru/#access_token=AQAA…&token_type=bearer&expires_in=…
 * Hash не уходит на сервер, поэтому токен читаем из location.href окна.
 *
 * Модуль намеренно без зависимостей от Electron — так его можно тестировать
 * обычным node (см. oauth.test.cjs).
 */

// Публичный client_id веб-клиента Яндекс.Музыки: используется открытыми
// клиентами для authorization-code/implicit flow. Секрета у него нет.
const OAUTH_CLIENTS = [
  { id: '23cabbbdc6cd418abb4b39c32c41195d', label: 'Яндекс.Музыка' },
];

function buildAuthUrl(clientId) {
  const params = new URLSearchParams({
    response_type: 'token',
    client_id: clientId,
  });
  return `https://oauth.yandex.ru/authorize?${params.toString()}`;
}

/** Достаёт access_token из URL возврата (hash или query). null, если его нет. */
function extractToken(url) {
  const text = String(url || '');
  if (!text) return null;

  const candidates = [];
  const hashAt = text.indexOf('#');
  if (hashAt >= 0) candidates.push(text.slice(hashAt + 1));
  const queryAt = text.indexOf('?');
  if (queryAt >= 0) {
    const end = hashAt >= 0 ? hashAt : text.length;
    candidates.push(text.slice(queryAt + 1, end));
  }

  for (const chunk of candidates) {
    let params;
    try {
      params = new URLSearchParams(chunk);
    } catch {
      continue;
    }
    const token = params.get('access_token');
    // Токены Яндекса бывают короткими (тестовые) и длинными (y0_…, AQAA…).
    // Раньше здесь стояло требование не короче 20 символов, из-за чего реальные
    // токены отбрасывались и вход «молча не срабатывал». Теперь проверяем только
    // алфавит (никаких пробелов и символов разметки) и разумную длину.
    if (token && /^[A-Za-z0-9_.\-]{8,}$/.test(token)) return token;
  }
  return null;
}

/** Ошибка авторизации из URL возврата, если она есть. */function extractError(url) {
  const text = String(url || '');
  const hashAt = text.indexOf('#');
  const queryAt = text.indexOf('?');
  const chunks = [];
  if (queryAt >= 0) chunks.push(text.slice(queryAt + 1, hashAt >= 0 ? hashAt : undefined));
  if (hashAt >= 0) chunks.push(text.slice(hashAt + 1));
  for (const chunk of chunks) {
    let params;
    try {
      params = new URLSearchParams(chunk);
    } catch {
      continue;
    }
    const error = params.get('error');
    if (error) {
      return {
        code: error,
        description: params.get('error_description') || '',
      };
    }
  }
  return null;
}

/**
 * Достаёт токен из заголовка `Authorization: OAuth <token>` — так Яндекс.Музыка
 * сама обращается к api.music.yandex.net, и так мы забираем токен, когда
 * пользователь просто входит в сервис в открытом окне.
 */
function tokenFromAuthorizationHeader(value) {
  if (typeof value !== 'string') return null;
  const match = /^OAuth\s+(\S+)$/i.exec(value.trim());
  if (!match) return null;
  // та же проверка, что и для адреса возврата: реальные токены бывают короче
  // 20 символов, из-за старого требования вход через окно не срабатывал
  return /^[A-Za-z0-9_.\-]{8,}$/.test(match[1]) ? match[1] : null;
}

/** Понятный текст для диалога, когда Яндекс вернул ошибку. */
function describeError(error) {
  if (!error) return 'Не удалось войти. Попробуйте ещё раз или вставьте токен вручную.';
  const map = {
    access_denied: 'Вход отменён в окне Яндекса.',
    invalid_client: 'Этот client_id больше не принимается Яндексом — нужен ручной токен.',
    unauthorized_client: 'Приложение не имеет доступа к Яндекс.Музыке — нужен ручной токен.',
    invalid_request: 'Яндекс отклонил запрос авторизации.',
  };
  return map[error.code] || `Яндекс вернул ошибку: ${error.code}`;
}

module.exports = {
  OAUTH_CLIENTS,
  buildAuthUrl,
  extractToken,
  extractError,
  describeError,
  tokenFromAuthorizationHeader,
};
