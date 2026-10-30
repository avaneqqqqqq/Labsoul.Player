'use strict';

/**
 * Провайдер «своей музыки»: локальные файлы пользователя.
 *
 * Отдаёт стандартный интерфейс провайдера (см. server/providers/yandex.mjs),
 * но данные берёт не из сети, а из индекса server/local.mjs.
 * Поток описывается не URL, а путём к файлу — index.mjs умеет раздавать его
 * с поддержкой Range (перемотка в <audio>).
 */

import * as local from '../local.mjs';

export const id = 'local';

export function configure() {}

export async function status() {
  const total = local.count();
  return { connected: true, user: total ? `файлов в библиотеке: ${total}` : 'файлов пока нет' };
}

export async function search(query, limit = 20) {
  return local.searchTracks(query, limit);
}

export async function track(sourceId) {
  const wanted = String(sourceId || '');
  const found = local
    .listTracks()
    .find((entry) => entry.sourceId === wanted || entry.id === wanted || entry.id === `local:${wanted}`);
  if (!found) {
    const err = new Error('Трек не найден в локальной библиотеке');
    err.code = 'NOT_FOUND';
    throw err;
  }
  return found;
}

export async function stream(sourceId) {
  const info = local.streamInfo(sourceId);
  return {
    filePath: info.filePath,
    contentType: info.contentType,
    repeatable: true,
  };
}

export async function wave() {
  const err = new Error('Для своей музыки нет станции рекомендаций');
  err.code = 'NOT_SUPPORTED';
  throw err;
}
