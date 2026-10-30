'use strict';

/**
 * Интеграционный тест звука: `node server/streamtest.mjs`
 *
 * Поднимает настоящий сервер (server/index.mjs) с двумя отладочными
 * провайдерами и проверяет то, что нельзя увидеть в интерфейсе:
 *   - /api/stream отдаёт файл целиком с корректными заголовками;
 *   - Range-запросы дают 206 и ровно запрошенные байты (перемотка в <audio>);
 *   - зашифрованный поток (AES-128-CTR, как у Яндекс.Музыки) расшифровывается
 *     сервером до исходных байт, включая запрос со смещения.
 *
 * Сеть и токены не нужны. Код выхода 1, если хоть одна проверка провалилась.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { testWav } from './devtest/plain.mjs';
import { testPlain } from './devtest/encrypted.mjs';
import { findFreePort } from './devtest/ports.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
let PORT = 0;
let BASE = '';

let passed = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures.push(name);
    console.log(`  FAIL ${name}\n       ${err.message}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message || 'условие не выполнено');
}

function equal(actual, expected, message) {
  if (actual !== expected) throw new Error(`${message || 'не совпало'}: получено ${actual}, ожидалось ${expected}`);
}

async function waitForHealth(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(1500) });
      if (res.ok) return true;
    } catch { /* сервер поднимается */ }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return false;
}

async function main() {
  PORT = await findFreePort();
  BASE = `http://127.0.0.1:${PORT}`;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'labsoul-streamtest-'));
  const child = spawn(process.execPath, [path.join(HERE, 'index.mjs'), `--port=${PORT}`], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), PLAYER_DATA_DIR: dataDir, PLAYER_TEST_PROVIDERS: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  child.stdout.on('data', (chunk) => { serverLog += String(chunk); });
  child.stderr.on('data', (chunk) => { serverLog += String(chunk); });

  const stop = () => {
    try { child.kill(); } catch { /* уже остановлен */ }
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* не критично */ }
  };

  try {
    const healthy = await waitForHealth();
    if (!healthy) {
      console.error('Сервер не поднялся. Лог:\n' + serverLog.slice(-1500));
      process.exit(1);
    }

    console.log('\n1. Обычный поток (pipeUpstream)');

    const full = await fetch(`${BASE}/api/stream/__plain/tone.wav`);
    const fullBody = Buffer.from(await full.arrayBuffer());
    check('200 и тип audio/wav', () => {
      equal(full.status, 200, 'код ответа');
      assert(String(full.headers.get('content-type')).includes('audio/wav'), 'тип содержимого');
    });
    check('полный файл совпадает с апстримом', () => {
      equal(fullBody.length, testWav.length, 'длина тела');
      assert(fullBody.subarray(0, 4).toString('latin1') === 'RIFF', 'заголовок WAV');
      assert(fullBody.equals(testWav), 'байты отличаются от исходных');
    });

    console.log('\n2. Range на обычном потоке');

    const ranged = await fetch(`${BASE}/api/stream/__plain/tone.wav`, {
      headers: { Range: 'bytes=100-199' },
    });
    const rangedBody = Buffer.from(await ranged.arrayBuffer());
    check('206 и корректный Content-Range', () => {
      equal(ranged.status, 206, 'код ответа');
      equal(ranged.headers.get('content-range'), `bytes 100-199/${testWav.length}`, 'Content-Range');
      equal(Number(ranged.headers.get('content-length')), 100, 'длина');
    });
    check('байты диапазона совпадают с исходными', () => {
      assert(rangedBody.equals(testWav.subarray(100, 200)), 'диапазон отдан неверно');
    });

    const tail = await fetch(`${BASE}/api/stream/__plain/tone.wav`, {
      headers: { Range: 'bytes=-500' },
    });
    const tailBody = Buffer.from(await tail.arrayBuffer());
    check('суффиксный диапазон bytes=-500', () => {
      equal(tail.status, 206, 'код ответа');
      equal(tailBody.length, 500, 'длина хвоста');
      assert(tailBody.equals(testWav.subarray(testWav.length - 500)), 'хвост отдан неверно');
    });

    console.log('\n3. Зашифрованный поток (расшифровка на сервере)');

    const enc = await fetch(`${BASE}/api/stream/__enc/secret.wav`);
    const encBody = Buffer.from(await enc.arrayBuffer());
    check('шифротекст расшифрован в исходный WAV', () => {
      equal(enc.status, 200, 'код ответа');
      equal(encBody.length, testPlain.length, 'длина после расшифровки');
      assert(encBody.subarray(0, 4).toString('latin1') === 'RIFF', 'заголовок WAV после расшифровки');
      assert(encBody.equals(testPlain), 'байты после расшифровки не совпали');
    });

    const encRange = await fetch(`${BASE}/api/stream/__enc/secret.wav`, {
      headers: { Range: 'bytes=44-143' },
    });
    const encRangeBody = Buffer.from(await encRange.arrayBuffer());
    check('Range по расшифрованному потоку', () => {
      equal(encRange.status, 206, 'код ответа');
      equal(encRange.headers.get('content-range'), `bytes 44-143/${testPlain.length}`, 'Content-Range');
      assert(encRangeBody.equals(testPlain.subarray(44, 144)), 'диапазон расшифрованного потока неверен');
    });

    console.log('\n4. Ошибки');

    const missing = await fetch(`${BASE}/api/stream/nope/1`);
    const missingBody = await missing.json().catch(() => null);
    check('неизвестный источник → 400 с телом ошибки', () => {
      equal(missing.status, 400, 'код ответа');
      assert(missingBody && missingBody.error && missingBody.error.code, 'ожидался {error:{code}}');
    });
  } finally {
    stop();
  }

  console.log('');
  if (failures.length) {
    console.log(`Провалено: ${failures.length} из ${passed + failures.length}`);
    process.exit(1);
  }
  console.log(`Все проверки пройдены: ${passed}`);
}

main().catch((err) => {
  console.error('Тест упал:', err.message);
  process.exit(1);
});
