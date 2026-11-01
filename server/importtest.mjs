/**
 * Проверка связности модулей интерфейса.
 *
 * Ловит класс ошибок, из-за которых экран оставался пустым: если файл
 * импортирует имя, которого в целевом модуле нет, браузер не загружает
 * весь модуль — интерфейс просто не рисуется, и никакой ошибки не видно.
 *
 * Так уже случилось с `getAnalyser` после откатa кроссфейда.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.resolve(HERE, '..', 'web', 'js');

let passed = 0;
const failures = [];

function check(name, ok, detail = '') {
  if (ok) passed += 1;
  else failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

/** Все экспортируемые имена модуля. */
function exportedNames(source) {
  const names = new Set();
  for (const m of source.matchAll(/export\s+(?:async\s+)?(?:function|const|let|var|class)\s+(\w+)/g)) {
    names.add(m[1]);
  }
  for (const m of source.matchAll(/export\s*\{([^}]+)\}/g)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop()?.trim();
      if (name) names.add(name);
    }
  }
  if (/export\s+default/.test(source)) names.add('default');
  return names;
}

const files = walk(WEB);
check('найдены файлы интерфейса', files.length > 10, `всего ${files.length}`);

let importCount = 0;
for (const file of files) {
  const source = fs.readFileSync(file, 'utf8');
  const rel = path.relative(WEB, file);

  for (const match of source.matchAll(/import\s*\{([^}]+)\}\s*from\s*'(\.[^']+)'/g)) {
    importCount += 1;
    const names = match[1]
      .split(',')
      .map((part) => part.trim().split(/\s+as\s+/)[0]?.trim())
      .filter(Boolean);

    let target = path.resolve(path.dirname(file), match[2]);
    if (!target.endsWith('.js')) target += '.js';

    if (!fs.existsSync(target)) {
      check(`${rel}: файл ${match[2]} существует`, false);
      continue;
    }

    const available = exportedNames(fs.readFileSync(target, 'utf8'));
    for (const name of names) {
      check(
        `${rel}: ${name} экспортируется из ${match[2]}`,
        available.has(name),
      );
    }
  }

  // проверяем и относительные пути без фигурных скобок (подключаемые модули)
  for (const match of source.matchAll(/from\s*'(\.[^']+)'/g)) {
    let target = path.resolve(path.dirname(file), match[1]);
    if (!target.endsWith('.js')) target += '.js';
    check(`${rel}: путь ${match[1]} существует`, fs.existsSync(target));
  }
}

check('импорты найдены', importCount > 20, `всего ${importCount}`);

if (failures.length) {
  console.error('Провалено проверок:', failures.length);
  for (const failure of failures) console.error('  ✗', failure);
  process.exit(1);
}

console.log(`Все проверки пройдены: ${passed}`);
