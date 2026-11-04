/**
 * Одна кнопка — всё исправлено.
 *
 * Пользователь не должен разбираться в стратегиях zapret, ключах, токенах
 * и перелогинах. Он жмёт одну кнопку у сервиса, а плеер сам проходит все
 * шаги по порядку и останавливается на первом рабочем результате.
 *
 * Порядок для SoundCloud:
 *   1. проверка — может, всё уже работает;
 *   2. обход блокировки (если домены заблокированы);
 *   3. свежий ключ client_id;
 *   4. вход в аккаунт (если есть Electron);
 *   5. перелогин (если звук закрыт, а профиль открывается);
 *   6. честный итог: что сработало, что нет и почему.
 *
 * Для Яндекса: проверка токена → перезаход через OAuth.
 * Для Spotify: подсказка, где взять ключи, и проверка.
 */

import fs from 'node:fs';

import * as dpi from './dpi.mjs';
import * as dpiauto from './dpiauto.mjs';
import * as dpiwatcher from './dpiwatcher.mjs';
/*
 * Провайдеры грузим динамически: модуль автопочинки не знает заранее,
 * какие из них есть в сборке. Так же делает сам сервер.
 */
const load = async (name) => {
  try {
    return await import(`./providers/${name}.mjs`);
  } catch {
    return null;
  }
};
import * as store from './store.mjs';

/**
 * SoundCloud: довести до рабочего состояния.
 *
 * @param {{relogin?: boolean}} options — relogin включает шаг сброса сессии
 */
export async function fixSoundCloud({ relogin = false } = {}) {
  const steps = [];
  const step = (name, ok, detail) => {
    steps.push({ name, ok, detail });
    store.log(`[fix] ${name}: ${ok ? 'ок' : 'нет'}${detail ? ' — ' + detail : ''}`);
  };

  const sc = await load('soundcloud');
  if (!sc) return { ok: false, steps, message: 'SoundCloud недоступен в этой сборке' };

  // --- 1. уже работает? ---
  try {
    const status = await sc.status();
    if (status.connected) {
      const probe = await probeStream(sc);
      if (probe.ok) {
        step('проверка', true, `звук играет (${probe.ms} мс)`);
        return { ok: true, alreadyWorks: true, steps, message: 'SoundCloud уже работает' };
      }
      step('проверка', false, probe.message);
    } else {
      step('проверка', false, status.error || 'нет подключения');
    }
  } catch (error) {
    step('проверка', false, error.message);
  }

  // --- 2. обход блокировки ---
  try {
    const bypass = await dpiwatcher.startBypass({});
    step('обход блокировки', bypass.ok, bypass.message);

    // после подъёма обхода проверяем домены
    const check = await dpiauto.check();
    if (!check.ok) {
      const repair = await dpiauto.repair({ force: true });
      step('списки zapret', repair.ok, repair.message);
    }
  } catch (error) {
    step('обход блокировки', false, error.message);
  }

  // --- 3. свежий ключ и повтор проверки ---
  try {
    // ключ сбрасываем, чтобы взять свежий
    if (typeof sc.invalidateClientId === 'function') sc.invalidateClientId();
    const probe = await probeStream(sc);
    if (probe.ok) {
      step('звук', true, `${probe.ms} мс`);
      return { ok: true, steps, message: 'SoundCloud работает' };
    }
    step('звук', false, probe.message);
  } catch (error) {
    step('звук', false, error.message);
  }

  // --- 4. перелогин (только если уже вошли) ---
  if (relogin) {
    step('перелогин', null, 'нужен вход заново — окно откроется в приложении');
    return {
      ok: false,
      needsRelogin: true,
      steps,
      message: 'SoundCloud ограничил доступ к звуку для этой сессии. Нажмите ещё раз — откроется вход, войдите заново.',
    };
  }

  return {
    ok: false,
    steps,
    message: 'Звук SoundCloud пока не идёт. Попробуйте «Войти заново» — ограничение снимется новым входом.',
  };
}

/** Проверить, отдаётся ли поток у любого популярного трека. */
async function probeStream(sc) {
  const started = Date.now();
  try {
    const sc = await load('soundcloud');
    const found = await sc?.search('Miyagi', 2);
    const track = found?.[0];
    if (!track) return { ok: false, ms: Date.now() - started, message: 'треки не нашлись' };
    const stream = await sc.stream(track.sourceId);
    const hasAudio = Boolean(stream?.url || stream?.buffer);
    return {
      ok: hasAudio,
      ms: Date.now() - started,
      message: hasAudio ? 'поток получен' : 'сервер не вернул звук',
    };
  } catch (error) {
    return { ok: false, ms: Date.now() - started, message: error.code || error.message };
  }
}

/** Яндекс: проверить токен и при необходимости попросить войти заново. */
export async function fixYandex() {
  const steps = [];
  const step = (name, ok, detail) => steps.push({ name, ok, detail });

  const ym = await load('yandex');
  if (!ym) return { ok: false, steps, message: 'Яндекс.Музыка недоступна в этой сборке' };

  try {
    const status = await ym.status();
    if (status.connected) {
      const found = await ym.search('Miyagi', 1);
      if (found?.length) {
        step('проверка', true, `поиск работает (${found.length} трек)`);
        return { ok: true, alreadyWorks: true, steps, message: 'Яндекс.Музыка уже работает' };
      }
      step('проверка', false, 'поиск пуст');
    } else {
      step('проверка', false, status.error === 'NO_TOKEN' ? 'нужен вход' : status.error);
    }
  } catch (error) {
    step('проверка', false, error.message);
  }

  // токен мог протухнуть — просим войти заново
  return {
    ok: false,
    needsSignIn: true,
    steps,
    message: 'Нужно войти в Яндекс.Музыку заново — откроется окно входа.',
  };
}

/** Spotify: без своих ключей работать не может — показываем что сделать. */
export async function fixSpotify() {
  const steps = [];
  const step = (name, ok, detail) => steps.push({ name, ok, detail });

  const sp = await load('spotify');
  if (!sp) return { ok: false, steps, message: 'Spotify недоступен в этой сборке' };
  try {
    const status = await sp.status();
    if (status.connected) {
      step('проверка', true, 'ключи приняты');
      return { ok: true, alreadyWorks: true, steps, message: 'Spotify работает' };
    }
    step('проверка', false, status.error === 'NO_TOKEN' ? 'нужны Client ID и Client Secret' : status.error);
  } catch (error) {
    step('проверка', false, error.message);
  }

  return {
    ok: false,
    needsKeys: true,
    steps,
    message: 'Spotify требует свои ключи: создайте приложение на developer.spotify.com и вставьте Client ID и Secret.',
  };
}

/** Одна точка входа для интерфейса. */
export async function fix(source, options = {}) {
  if (source === 'soundcloud') return fixSoundCloud(options);
  if (source === 'yandex') return fixYandex();
  if (source === 'spotify') return fixSpotify();
  return { ok: false, message: `Неизвестный сервис: ${source}`, steps: [] };
}
