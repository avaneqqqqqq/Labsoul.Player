'use strict';

/**
 * Утилиты для интеграционных тестов: свободный порт и ожидание условия.
 * Фиксированные порты в тестах — источник плавающих падений (TIME_WAIT,
 * параллельные прогоны), поэтому каждый тест берёт свой свободный порт.
 */

import net from 'node:net';

/** Возвращает свободный порт на 127.0.0.1 (ОС выдаёт сама). */
export function findFreePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/** Ждёт, пока условие станет истинным (без падений на таймауте — вернёт false). */
export async function waitUntil(predicate, timeoutMs = 3000, intervalMs = 50) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await predicate()) return true;
    } catch {
      /* условие может бросать — считаем «ещё не готово» */
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return false;
}
