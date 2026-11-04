/**
 * Cloudflare Worker — точка входа.
 *
 * Разворачивается как есть: вставить содержимое relay.mjs и этот файл
 * в один воркер, либо использовать готовую сборку из RELAY.md.
 */

import { handleRequest } from './relay.mjs';

export default {
  async fetch(request) {
    return handleRequest(request);
  },
};
