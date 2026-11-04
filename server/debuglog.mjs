/**
 * Журнал диагностики плеера.
 *
 * Клиент шлёт события на сервер, сервер пишет их в файл. По журналу видно,
 * доходит ли клик до обработчика, меняется ли состояние, приходит ли текст.
 * Это единственный способ увидеть, что происходит внутри упакованного
 * приложения: консоль пользователю недоступна.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const ROOT = path.join(process.env.APPDATA || os.homedir(), 'labsoul', 'logs');
const FILE = path.join(ROOT, 'debug-player.log');
const MAX_BYTES = 2_000_000;

let ready = false;

function ensure() {
  if (ready) return true;
  try {
    fs.mkdirSync(ROOT, { recursive: true });
    ready = true;
    return true;
  } catch {
    return false;
  }
}

/** Записать событие. Никогда не бросает. */
export function write(category, message, data) {
  if (!ensure()) return;
  try {
    // не даём файлу расти бесконечно
    try {
      const stat = fs.statSync(FILE);
      if (stat.size > MAX_BYTES) fs.writeFileSync(FILE, '');
    } catch { /* файла ещё нет */ }

    const parts = [new Date().toISOString(), `[${category}]`, String(message)];
    if (data !== undefined) {
      parts.push(typeof data === 'string' ? data : JSON.stringify(data));
    }
    fs.appendFileSync(FILE, parts.join(' ') + '\n');
  } catch { /* журнал не должен мешать работе */ }
}

/** Начать новую сессию: отделяем блоки друг от друга. */
export function beginSession(version) {
  if (!ensure()) return;
  try {
    fs.appendFileSync(FILE, `\n${'='.repeat(70)}\n=== labsoul ${version} — ${new Date().toISOString()} ===\n${'='.repeat(70)}\n`);
  } catch { /* ignore */ }
}

/** Путь к файлу — показываем пользователю. */
export function filePath() {
  return FILE;
}

/** Последние строки — для показа в интерфейсе. */
export function tail(lines = 120) {
  try {
    return fs.readFileSync(FILE, 'utf8').split('\n').slice(-lines).join('\n');
  } catch {
    return '';
  }
}
