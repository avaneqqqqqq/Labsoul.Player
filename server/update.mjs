'use strict';

/**
 * Проверка обновлений через публичные релизы GitHub.
 *
 * Тонкость: в репозитории лежат старые релизы прежнего мода, и «самый свежий
 * по номеру» там может быть вообще про другое. Поэтому релиз считается нашим
 * только если в нём есть установщик `labsoul-*-setup.exe`. Токены не нужны:
 * репозиторий публичный, читается анонимно.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = process.env.LABSOUL_REPO || 'avaneqqqqqq/Labsoul.Player';
// старое имя репозитория: GitHub перенаправляет старые ссылки, поэтому клиенты
// на предыдущих сборках продолжают получать обновления
const REPO_LEGACY = 'avaneqqqqqq/Ymuz.mod';
const CACHE_TTL_MS = 60 * 60 * 1000; // час: не дёргаем GitHub на каждое открытие
const TIMEOUT_MS = 10000;

const HERE = path.dirname(fileURLToPath(import.meta.url));

export function currentVersion() {
  // 1) в упакованном приложении версию передаёт Electron (app.getVersion());
  // 2) в исходниках читаем package.json проекта;
  // 3) иначе считаем неизвестной.
  if (process.env.PLAYER_VERSION) return String(process.env.PLAYER_VERSION).trim();
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'package.json'), 'utf8'));
    return String(pkg.version || '0.0.0');
  } catch {
    return '0.0.0';
  }
}

function parseVersion(value) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(value || ''));
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function isNewer(candidate, current) {
  const a = parseVersion(candidate);
  const b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i += 1) {
    if (a[i] > b[i]) return true;
    if (a[i] < b[i]) return false;
  }
  return false;
}

/** Наш ли это релиз: в нём должен быть установщик labsoul (в репозитории лежат и старые релизы мода). */
export function isLabsoulRelease(release) {
  if (!release || release.draft || release.prerelease) return false;
  const assets = Array.isArray(release.assets) ? release.assets : [];
  return assets.some((asset) => /^labsoul-.*setup\.exe$/i.test(String((asset && asset.name) || '')));
}

let cache = { at: 0, data: null };

export async function checkForUpdate() {
  const current = currentVersion();
  if (cache.data && Date.now() - cache.at < CACHE_TTL_MS) {
    return { ...cache.data, current };
  }

  try {
    const load = async (repo) => {
      const response = await fetch(`https://api.github.com/repos/${repo}/releases?per_page=30`, {
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': 'labsoul-update-check',
        },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!response.ok) throw new Error(`GitHub ответил ${response.status}`);
      return response;
    };

    // после переименования репозитория старые сборки ходят по прежнему адресу
    let res;
    try {
      res = await load(REPO);
    } catch {
      res = await load(REPO_LEGACY);
    }

    const list = await res.json();
    const ours = (Array.isArray(list) ? list : [])
      .filter((release) => isLabsoulRelease(release))
      .map((release) => ({
        version: String(release.tag_name || '').replace(/^v/i, ''),
        url: release.html_url,
        title: release.name || release.tag_name,
        notes: String(release.body || '').slice(0, 600),
        publishedAt: release.published_at || null,
      }))
      .filter((release) => parseVersion(release.version));

    ours.sort((a, b) => {
      const av = parseVersion(a.version);
      const bv = parseVersion(b.version);
      for (let i = 0; i < 3; i += 1) {
        if (av[i] !== bv[i]) return bv[i] - av[i];
      }
      return 0;
    });

    const latest = ours[0] || null;
    const data = {
      current,
      latest,
      updateAvailable: Boolean(latest && isNewer(latest.version, current)),
      repo: REPO,
      checkedAt: new Date().toISOString(),
    };
    cache = { at: Date.now(), data };
    return data;
  } catch (err) {
    // Сеть/GitHub недоступны — это не ошибка для плеера, просто «не знаем»
    return {
      current,
      latest: null,
      updateAvailable: false,
      repo: REPO,
      error: err.message,
      checkedAt: new Date().toISOString(),
    };
  }
}

export { isNewer, parseVersion };
