/**
 * Автоматическое обновление токена SoundCloud.
 *
 * Проблема, ради которой это написано: токен SoundCloud живёт сутки.
 * Через сутки профиль ещё открывается (у него другой срок), а звук
 * перестаёт идти — сервер отвечает 429 или 401. Пользователь видел
 * «не удалось получить поток» и должен был входить заново вручную.
 *
 * Решение: SoundCloud вместе с токеном отдаёт oauth_refresh_token —
 * ключ, которым токен можно обновлять БЕЗ участия человека. Нужен только
 * client_id, который подписал токен, и он... записан внутри самого токена
 * (поле client_id в JWT). Ничего скрейпить не нужно.
 *
 * Проверено на живом аккаунте:
 *   POST secure.soundcloud.com/oauth/token
 *   grant_type=refresh_token&refresh_token=<...>&client_id=<из JWT>
 *   → 200, новый access_token на 24 часа и новый refresh_token
 */

const TOKEN_ENDPOINT = 'https://secure.soundcloud.com/oauth/token';

/** Обновляем за пять минут до конца срока: запас на сбитые часы. */
const REFRESH_BEFORE_MS = 5 * 60 * 1000;

/**
 * Разобрать JWT без проверки подписи.
 *
 * Подпись проверять бессмысленно: токен выдан самим SoundCloud, а нам
 * нужны только срок действия и client_id, чтобы вовремя обновить.
 */
export function decodeToken(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return {
      exp: Number(payload.exp) * 1000 || 0,
      iat: Number(payload.iat) * 1000 || 0,
      clientId: String(payload.client_id || ''),
      userId: String(payload.sub || ''),
    };
  } catch {
    return null;
  }
}

/** Нужно ли обновить токен прямо сейчас. */
export function needsRefresh(token) {
  const info = decodeToken(token);
  if (!info) return false; // старый формат токена — обновлять нечем
  if (!info.exp) return false;
  return Date.now() > info.exp - REFRESH_BEFORE_MS;
}

/** Токен уже истёк. */
export function isExpired(token) {
  const info = decodeToken(token);
  if (!info?.exp) return false;
  return Date.now() > info.exp;
}

/** Сколько осталось до конца жизни токена (мс), 0 если не JWT. */
export function timeLeft(token) {
  const info = decodeToken(token);
  if (!info?.exp) return 0;
  return Math.max(0, info.exp - Date.now());
}

/**
 * Обменять refresh_token на новую пару токенов.
 *
 * @param {{refreshToken: string, accessToken: string}} params
 *   accessToken нужен, чтобы достать из него client_id.
 * @returns {Promise<{accessToken: string, refreshToken: string, expiresIn: number}>}
 */
export async function refreshTokens({ refreshToken, accessToken }) {
  if (!refreshToken) throw new Error('нет refresh_token — нужен повторный вход');

  const info = decodeToken(accessToken);
  const clientId = info?.clientId || '';
  if (!clientId) throw new Error('в токене нет client_id — нужен повторный вход');

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId,
  });

  const response = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/136.0.0.0 Safari/537.36',
    },
    body,
    signal: AbortSignal.timeout(15_000),
  });

  const text = await response.text();

  if (!response.ok) {
    let reason = `HTTP ${response.status}`;
    try {
      const data = JSON.parse(text);
      if (data?.error) reason = data.error;
    } catch { /* не JSON */ }
    throw new Error(`SoundCloud не обновил токен: ${reason}`);
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('SoundCloud вернул не-JSON при обновлении токена');
  }

  if (!data?.access_token) throw new Error('SoundCloud не вернул новый токен');

  return {
    accessToken: String(data.access_token),
    refreshToken: String(data.refresh_token || refreshToken),
    expiresIn: Number(data.expires_in) || 0,
  };
}
