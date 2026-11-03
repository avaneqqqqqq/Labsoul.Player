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

/*
 * Модули Electron тоже должны попадать в сборку.
 *
 * electron-builder берёт только файлы, перечисленные в `build.files`
 * в app/package.json. Новый require('./discord.cjs') без этой записи
 * молча выпадает из установщика, и приложение падает при запуске.
 */
try {
  const appPackage = JSON.parse(fs.readFileSync(path.resolve(HERE, '..', 'app', 'package.json'), 'utf8'));
  const packaged = new Set(appPackage.build?.files || []);
  const mainSource = fs.readFileSync(path.resolve(HERE, '..', 'app', 'main.cjs'), 'utf8');

  for (const match of mainSource.matchAll(/require\('\.\/([\w.-]+\.cjs)'\)/g)) {
    const name = match[1];
    check(`app/package.json включает ${name} в сборку`, packaged.has(name));
  }
} catch (error) {
  check('проверка списка файлов сборки', false, error.message);
}

/*
 * Каждый модуль, который подключает main.cjs, должен существовать и
 * экспортировать то, что вызывается.
 *
 * Так уже случилось: в проект попал старый overlay.cjs без handleActions,
 * приложение падало на старте с «handleActions is not a function».
 */
try {
  const appDir = path.resolve(HERE, '..', 'app');
  const mainSource = fs.readFileSync(path.join(appDir, 'main.cjs'), 'utf8');

  for (const match of mainSource.matchAll(/const\s+(\w+)\s*=\s*require\('\.\/([\w.-]+\.cjs)'\)/g)) {
    const [, alias, file] = match;
    const full = path.join(appDir, file);

    check(`модуль ${file} существует`, fs.existsSync(full));
    if (!fs.existsSync(full)) continue;

    const source = fs.readFileSync(full, 'utf8');

    // имена из module.exports = { ... } — их и видно снаружи
    const exportBlock = source.match(/module\.exports\s*=\s*\{([^}]*)\}/s)?.[1] || '';
    const exported = new Set(
      exportBlock
        .split(',')
        .map((part) => part.split(':')[0].trim())
        .filter(Boolean),
    );

    // ищем вызовы вида overlay.handleActions() и проверяем имя в экспорте
    const callRe = new RegExp(`${alias}\\.(\\w+)\\s*\\(`, 'g');
    const called = new Set([...mainSource.matchAll(callRe)].map((m) => m[1]));

    for (const method of called) {
      check(`${file} экспортирует ${method}`, exported.has(method));
    }
  }
} catch (error) {
  check('проверка API модулей Electron', false, error.message);
}

if (failures.length) {
  console.error('Провалено проверок:', failures.length);
  for (const failure of failures) console.error('  ✗', failure);
  process.exit(1);
}

console.log(`Все проверки пройдены: ${passed}`);
