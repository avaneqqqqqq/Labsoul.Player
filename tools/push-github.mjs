'use strict';

/**
 * Публикация labsoul в GitHub без git: содержимое папки player/ целиком
 * заменяет ветку репозитория одним коммитом через Git Data API.
 *
 *   node tools/push-github.mjs                     # dry-run: что изменится
 *   node tools/push-github.mjs --apply             # реально закоммитить
 *   node tools/push-github.mjs --apply --message "labsoul 0.1.0"
 *
 * Токен берётся из переменной окружения GH_TOKEN или из файла data/.github-token
 * (файл в .gitignore и никогда не попадает в репозиторий).
 * Нужны права Contents: Read and write на репозиторий.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OWNER = process.env.GH_OWNER || 'avaneqqqqqq';
let REPO = process.env.GH_REPO || 'Labsoul.Player';
// старое имя на случай, если репозиторий ещё не переименован
const REPO_FALLBACK = 'Ymuz.mod';
const BRANCH = process.env.GH_BRANCH || 'main';
const API = 'https://api.github.com';

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const messageIndex = args.indexOf('--message');
const COMMIT_MESSAGE =
  messageIndex >= 0 && args[messageIndex + 1] ? args[messageIndex + 1] : 'labsoul: свой музыкальный плеер вместо мода';

const SKIP_DIRS = new Set([
  'node_modules',
  'data',
  'dist',
  '.git',
  '.cache',
  '.csv',
  '.tmp',
  'logs',
  '.builder-cache',
]);
const SKIP_FILES = new Set(['.DS_Store', 'Thumbs.db']);
const MAX_FILE_BYTES = 30 * 1024 * 1024;

/* ------------------------------- токен ----------------------------------- */

function readToken() {
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN.trim();
  const file = path.join(ROOT, 'data', '.github-token');
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch {
    return null;
  }
}

const token = readToken();

function headers(needAuth = true) {
  const base = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'labsoul-publisher',
  };
  if (needAuth) {
    if (!token) throw new Error('Нет токена: задайте GH_TOKEN или положите его в data/.github-token');
    base.Authorization = `Bearer ${token}`;
  }
  return base;
}

async function api(method, endpoint, body) {
  const res = await fetch(API + endpoint, {
    method,
    headers: {
      ...headers(true),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(60000),
  });
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`${method} ${endpoint} → ${res.status}: ${text.slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
  return text ? JSON.parse(text) : {};
}

async function apiPublic(endpoint) {
  const res = await fetch(API + endpoint, {
    headers: headers(false),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`GET ${endpoint} → ${res.status}`);
  return res.json();
}

/* --------------------------- локальные файлы ------------------------------ */

function collectFiles(dir, relative = '', out = []) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (SKIP_FILES.has(entry.name)) continue;
    const rel = relative ? `${relative}/${entry.name}` : entry.name;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      collectFiles(full, rel, out);
      continue;
    }
    if (!entry.isFile()) continue;
    if (SKIP_FILES.has(entry.name)) continue;
    const stat = fs.statSync(full);
    if (stat.size > MAX_FILE_BYTES) {
      console.warn(`  пропуск (слишком большой): ${rel} — ${(stat.size / 1024 / 1024).toFixed(1)} МБ`);
      continue;
    }
    out.push({
      path: rel,
      full,
      size: stat.size,
      mode: rel.endsWith('.cmd') || rel.endsWith('.bat') ? '100755' : '100644',
    });
  }
  return out;
}

const isBinary = (buffer) => buffer.includes(0);

/* --------------------------------- main ---------------------------------- */

async function main() {
  // автовыбор имени репозитория
  // репозиторий мог быть переименован: пробуем новое имя, иначе старое
  try {
    await apiPublic(`/repos/${OWNER}/${REPO}`);
  } catch {
    console.log(`  репозиторий ${REPO} недоступен, пробую ${REPO_FALLBACK}`);
    REPO = REPO_FALLBACK;
  }

  console.log(`\nlabsoul → github.com/${OWNER}/${REPO} (${BRANCH})`);

  let headSha = null;
  let remoteFiles = new Map();
  try {
    const ref = await apiPublic(`/repos/${OWNER}/${REPO}/git/ref/heads/${BRANCH}`);
    headSha = ref.object.sha;
    const commit = await apiPublic(`/repos/${OWNER}/${REPO}/git/commits/${headSha}`);
    const tree = await apiPublic(`/repos/${OWNER}/${REPO}/git/trees/${commit.tree.sha}?recursive=1`);
    remoteFiles = new Map(
      tree.tree.filter((n) => n.type === 'blob').map((n) => [n.path, { sha: n.sha, size: n.size }]),
    );
    console.log(`Удалённый HEAD: ${headSha.slice(0, 7)} — файлов в репозитории: ${remoteFiles.size}`);
  } catch (err) {
    console.log(`Не удалось прочитать репозиторий: ${err.message}`);
    console.log('Проверьте название репозитория и доступ в сеть.');
    process.exit(1);
  }

  const localFiles = collectFiles(ROOT).sort((a, b) => a.path.localeCompare(b.path));
  const localPaths = new Set(localFiles.map((f) => f.path));

  const toAdd = localFiles.filter((f) => !remoteFiles.has(f.path));
  const toUpdate = localFiles.filter((f) => remoteFiles.has(f.path));
  const toDelete = [...remoteFiles.keys()].filter((p) => !localPaths.has(p));

  console.log(`Файлов локально: ${localFiles.length}`);
  console.log(`  новых: ${toAdd.length}, обновляемых: ${toUpdate.length}, удаляемых: ${toDelete.length}`);

  if (toDelete.length) {
    console.log('\nБудут удалены:');
    for (const p of toDelete.slice(0, 50)) console.log('  − ' + p);
    if (toDelete.length > 50) console.log(`  … и ещё ${toDelete.length - 50}`);
  }
  if (toAdd.length) {
    console.log('\nБудут добавлены:');
    for (const f of toAdd.slice(0, 50)) console.log('  + ' + f.path);
  }

  if (!APPLY) {
    console.log('\nЭто dry-run. Чтобы опубликовать: --apply\n');
    return;
  }

  // 1. проверяем токен и права
  const me = await api('GET', '/user');
  const repo = await api('GET', `/repos/${OWNER}/${REPO}`);
  const canPush = Boolean(repo.permissions && repo.permissions.push);
  console.log(`\nТокен: ${me.login}. Права на запись: ${canPush ? 'да' : 'нет'}`);
  if (!canPush) {
    console.error('Токен не имеет права Contents: Read and write на этот репозиторий.');
    process.exit(1);
  }

  // 2. загружаем блобы
  const entries = [];
  let uploaded = 0;
  const concurrency = 4;
  const queue = localFiles.slice();
  const uploader = async () => {
    while (queue.length) {
      const file = queue.shift();
      const buffer = fs.readFileSync(file.full);
      const body = {
        content: buffer.toString('base64'),
        encoding: 'base64',
      };
      const blob = await api('POST', `/repos/${OWNER}/${REPO}/git/blobs`, body);
      entries.push({ path: file.path, mode: file.mode, type: 'blob', sha: blob.sha });
      uploaded += 1;
      if (uploaded % 10 === 0) process.stdout.write(`  загружено ${uploaded}/${localFiles.length}\r`);
      if (isBinary(buffer) && file.size > 1024 * 1024) console.log(`  (двоичный файл: ${file.path})`);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, uploader));
  console.log(`  загружено ${uploaded}/${localFiles.length}`);

  // 3. дерево и коммит
  const tree = await api('POST', `/repos/${OWNER}/${REPO}/git/trees`, { tree: entries });

  /**
   * Коммит поверх актуального HEAD. GitHub может отдать устаревший ref
   * (кэш чтения), из-за чего новый коммит окажется «сбоку» — тогда ref
   * нельзя обновить без force (422 fast-forward). В этом случае перечитываем
   * HEAD и делаем коммит ещё раз, деревом пользуемся тем же.
   */
  async function commitAndPush(parentSha, attempt = 0) {
    const commit = await api('POST', `/repos/${OWNER}/${REPO}/git/commits`, {
      message: COMMIT_MESSAGE,
      tree: tree.sha,
      parents: [parentSha],
    });
    try {
      await api('PATCH', `/repos/${OWNER}/${REPO}/git/refs/heads/${BRANCH}`, {
        sha: commit.sha,
        force: false,
      });
      return commit;
    } catch (err) {
      if (attempt >= 1 || !/fast forward|422/i.test(err.message)) throw err;
      const fresh = await api('GET', `/repos/${OWNER}/${REPO}/git/ref/heads/${BRANCH}`);
      console.log(`  ветка ушла вперёд (${String(parentSha).slice(0, 7)} → ${String(fresh.object.sha).slice(0, 7)}), повторяю коммит`);
      return commitAndPush(fresh.object.sha, attempt + 1);
    }
  }

  const commit = await commitAndPush(headSha);

  console.log(`\nГотово: https://github.com/${OWNER}/${REPO}/commit/${commit.sha}`);
}

main().catch((err) => {
  console.error('\nОшибка:', err.message);
  process.exit(1);
});
