/**
 * Netlify — точка входа.
 *
 * Netlify Functions принимают запрос и должны вернуть Response.
 * Разместить в netlify/functions/relay.mjs и указать редирект
 * /p/* → /.netlify/functions/relay/p/*
 */

import { handleRequest } from '../relay.mjs';

export default async (request) => handleRequest(request);
