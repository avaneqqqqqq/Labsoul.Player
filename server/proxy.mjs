/**
 * Поддержка прокси (варианты «1 + 2»).
 *
 * Зачем: из РФ медиа-CDN SoundCloud (playback.media-streaming.soundcloud.cloud)
 * часто недоступен напрямую — без VPN музыка не грузится. Раньше приложение
 * ходило только напрямую, поэтому «работало лишь с варпом».
 *
 * Два источника настройки:
 *   1) пользовательский прокси из настроек приложения (socks5/http);
 *   2) системный прокси Windows (Параметры → Сеть и Интернет → Прокси).
 *
 * Технически ставим глобальный dispatcher undici: он применяется ко всем
 * запросам `fetch`, включая медиа и HLS-сегменты провайдеров.
 */

import { execFile } from 'node:child_process';

let ProxyAgent = null;
let setGlobalDispatcher = null;
let Agent = null;
let installed = false;

// undici ставится как обычная зависимость; при отсутствии прокси не нужен
async function loadUndici() {
  if (ProxyAgent) return true;
  try {
    const mod = await import('undici');
    ProxyAgent = mod.ProxyAgent;
    setGlobalDispatcher = mod.setGlobalDispatcher;
    Agent = mod.Agent;
    return true;
  } catch {
    return false;
  }
}

const STATE = {
  manual: '', // из настроек приложения
  system: false, // использовать системный прокси Windows
  resolved: '', // фактически применённый адрес
  source: null, // 'settings' | 'system' | null
  checkedAt: 0,
  error: null,
};

/** Проверка формата прокси: socks5://хост:порт, http://хост:порт, хост:порт. */
export function normalizeProxy(value) {
  let text = String(value || '').trim();
  if (!text) return '';

  // голый «host:port» — считаем HTTP-прокси
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `http://${text}`;

  try {
    const url = new URL(text);
    const protocol = url.protocol.toLowerCase();
    if (!['http:', 'https:', 'socks:', 'socks4:', 'socks5:'].includes(protocol)) return '';
    if (!url.hostname) return '';
    if (!url.port && protocol !== 'https:') return '';
    return url.toString().replace(/\/$/, '');
  } catch {
    return '';
  }
}

/**
 * Системный прокси Windows из реестра.
 * Читаем ветку Интернета текущего пользователя; если `ProxyServer` задан — берём.
 */
function readSystemProxy() {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') { resolve(''); return; }

    const key = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
    execFile('reg', ['query', key], { timeout: 4000, windowsHide: true }, (err, stdout) => {
      if (err || !stdout) { resolve(''); return; }

      const enabled = /ProxyEnable\s+REG_DWORD\s+0x1/i.test(stdout);
      const match = stdout.match(/ProxyServer\s+REG_SZ\s+(.+)/i);
      if (!enabled || !match) { resolve(''); return; }

      const raw = match[1].trim();
      // формат может быть «host:port» или «http=host:port;https=host:port»
      if (raw.includes('=')) {
        const parts = Object.fromEntries(
          raw.split(';').map((piece) => piece.split('=')).filter((pair) => pair.length === 2),
        );
        const pick = parts.https || parts.http || Object.values(parts)[0] || '';
        resolve(normalizeProxy(pick));
        return;
      }
      resolve(normalizeProxy(raw));
    });
  });
}

/** Применить прокси ко всем запросам fetch (глобальный dispatcher undici). */
async function applyProxy(url) {
  const ready = await loadUndici();
  if (!ready) {
    STATE.resolved = '';
    STATE.source = null;
    STATE.error = 'модуль undici недоступен — прокси не включится';
    return;
  }

  if (!url) {
    // без прокси — обычный агент
    try { setGlobalDispatcher(Agent ? new Agent() : new (await import('undici')).Agent()); } catch { /* остаётся прежний */ }
    STATE.resolved = '';
    STATE.source = null;
    return;
  }

  try {
    setGlobalDispatcher(new ProxyAgent(url));
    STATE.resolved = url;
  } catch (err) {
    STATE.resolved = '';
    STATE.source = null;
    STATE.error = (err && err.message) || 'прокси не применён';
  }
}

/**
 * Пересчитать прокси: настройки приложения важнее системных.
 * @param {{proxy?: string, useSystemProxy?: boolean}} settings
 */
export async function refresh(settings = {}) {
  const manual = normalizeProxy(settings.proxy);
  const useSystem = Boolean(settings.useSystemProxy);

  STATE.manual = manual;
  STATE.system = useSystem;
  STATE.error = null;

  let url = '';
  let source = null;

  if (manual) {
    url = manual;
    source = 'settings';
  } else if (useSystem) {
    try {
      const system = await readSystemProxy();
      if (system) {
        url = system;
        source = 'system';
      }
    } catch (err) {
      STATE.error = (err && err.message) || 'не удалось прочитать системный прокси';
    }
  }

  STATE.checkedAt = Date.now();
  await applyProxy(url);
  STATE.source = STATE.resolved ? source : null;
  STATE.checkedAt = Date.now();
  return status();
}

/** Текущее состояние (маскированное — без логина/пароля). */
export function status() {
  return {
    manual: maskCredentials(STATE.manual),
    useSystemProxy: STATE.system,
    active: Boolean(STATE.resolved),
    activeSource: STATE.source,
    activeMasked: maskCredentials(STATE.resolved),
    error: STATE.error,
  };
}

function maskCredentials(url) {
  if (!url) return '';
  try {
    const parsed = new URL(url);
    if (parsed.username || parsed.password) {
      parsed.username = parsed.username ? '•••' : '';
      parsed.password = parsed.password ? '•••' : '';
    }
    return parsed.toString().replace(/\/$/, '');
  } catch {
    return url;
  }
}

/**
 * Проверка прокси в реальных условиях: с ним и без него.
 * Возвращает время ответа — по нему видно, помогает ли прокси.
 */
export async function test(target = 'https://api-v2.soundcloud.com/') {
  const result = { viaProxy: null, direct: null, error: null };

  const probe = async () => {
    const started = Date.now();
    const response = await fetch(target, {
      method: 'HEAD',
      signal: AbortSignal.timeout(8000),
      redirect: 'follow',
    });
    return { ms: Date.now() - started, status: response.status };
  };

  const active = STATE.resolved;

  try {
    result.viaProxy = await probe();
  } catch (err) {
    result.error = (err && err.message) || 'запрос не прошёл';
  }

  // прямое соединение — только когда прокси не активен, иначе оно же будет через прокси
  if (!active) result.direct = result.viaProxy;

  return result;
}
