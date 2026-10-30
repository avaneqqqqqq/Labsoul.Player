'use strict';

/**
 * Своя музыка: локальные файлы на компьютере.
 *
 * Никаких зависимостей — теги читаем сами (ID3v2 у mp3, Vorbis-комментарии у flac,
 * заголовок у wav), длительность считаем по битрейту/семплам, а если не получилось —
 * оставляем 0: плеер возьмёт её из <audio> при загрузке метаданных.
 *
 * Индекс лежит в <data>/local-index.json, загруженные через браузер файлы
 * копируются в <data>/local/. Пути пользователя никуда не отправляются.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { paths as storePaths } from './store.mjs';

const AUDIO_EXT = new Map([
  ['.mp3', 'audio/mpeg'],
  ['.flac', 'audio/flac'],
  ['.m4a', 'audio/mp4'],
  ['.aac', 'audio/aac'],
  ['.ogg', 'audio/ogg'],
  ['.opus', 'audio/ogg'],
  ['.wav', 'audio/wav'],
  ['.webm', 'audio/webm'],
]);

const TAG_BYTES = 512 * 1024; // ID3-теги в начале файла, больше не нужно

const indexFile = () => path.join(storePaths.DATA, 'local-index.json');
const uploadDir = () => path.join(storePaths.DATA, 'local');

let cache = null;

/* ------------------------------ индекс ----------------------------------- */

function loadIndex() {
  if (cache) return cache;
  try {
    const raw = JSON.parse(fs.readFileSync(indexFile(), 'utf8'));
    cache = {
      tracks: Array.isArray(raw.tracks) ? raw.tracks : [],
      version: raw.version || 1,
    };
  } catch {
    cache = { tracks: [], version: 1 };
  }
  return cache;
}

function saveIndex() {
  const data = loadIndex();
  try {
    fs.mkdirSync(path.dirname(indexFile()), { recursive: true });
    fs.writeFileSync(indexFile(), JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    console.warn('[local] индекс не сохранён:', err.message);
  }
}

const trackId = (filePath) => 'local:' + crypto.createHash('sha1').update(String(filePath)).digest('hex').slice(0, 12);

/* ------------------------------- теги ------------------------------------ */

function decodeText(buffer, encoding) {
  try {
    if (encoding === 1) {
      // UTF-16 с BOM
      const little = buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe;
      const body = buffer.length >= 2 && (buffer[0] === 0xff || buffer[0] === 0xfe) ? buffer.subarray(2) : buffer;
      return (little || buffer[0] === 0xff ? body.toString('utf16le') : body.toString('utf16le')).replace(/\0+$/, '').trim();
    }
    if (encoding === 2) return buffer.toString('utf16be').replace(/\0+$/, '').trim();
    if (encoding === 3) return buffer.toString('utf8').replace(/\0+$/, '').trim();
    return buffer.toString('latin1').replace(/\0+$/, '').trim();
  } catch {
    return '';
  }
}

function parseId3v2(buffer) {
  if (buffer.length < 10 || buffer.toString('latin1', 0, 3) !== 'ID3') return null;
  const version = buffer[3];
  const size =
    ((buffer[6] & 0x7f) << 21) | ((buffer[7] & 0x7f) << 14) | ((buffer[8] & 0x7f) << 7) | (buffer[9] & 0x7f);

  const end = Math.min(10 + size, buffer.length);
  const tags = {};
  let pos = 10;

  while (pos + 10 <= end) {
    const frameId = buffer.toString('latin1', pos, pos + 4);
    if (!/^[A-Z0-9]{4}$/.test(frameId)) break;

    const frameSize =
      version === 4
        ? ((buffer[pos + 4] & 0x7f) << 21) |
          ((buffer[pos + 5] & 0x7f) << 14) |
          ((buffer[pos + 6] & 0x7f) << 7) |
          (buffer[pos + 7] & 0x7f)
        : buffer.readUInt32BE(pos + 4);

    const dataStart = pos + 10;
    if (frameSize <= 0 || dataStart + frameSize > end) break;

    if (frameId === 'TIT2' || frameId === 'TPE1' || frameId === 'TALB') {
      const frame = buffer.subarray(dataStart, dataStart + frameSize);
      const value = decodeText(frame.subarray(1), frame[0]);
      if (value) tags[frameId] = value;
    }
    pos = dataStart + frameSize;
  }
  return tags;
}

function parseId3v1(buffer) {
  if (buffer.length < 128) return null;
  const tail = buffer.subarray(buffer.length - 128);
  if (tail.toString('latin1', 0, 3) !== 'TAG') return null;
  const read = (start, len) => tail.toString('latin1', start, start + len).replace(/\0+$/, '').trim();
  return { TIT2: read(3, 30), TPE1: read(33, 30), TALB: read(63, 30) };
}

function parseFlac(buffer) {
  if (buffer.length < 8 || buffer.toString('latin1', 0, 4) !== 'fLaC') return null;
  let pos = 4;
  const tags = {};
  let duration = 0;

  while (pos + 4 <= buffer.length) {
    const header = buffer[pos];
    const type = header & 0x7f;
    const last = (header & 0x80) !== 0;
    const length = (buffer[pos + 1] << 16) | (buffer[pos + 2] << 8) | buffer[pos + 3];
    const start = pos + 4;
    if (start + length > buffer.length) break;

    if (type === 0 && length >= 34) {
      // STREAMINFO: sample rate (20 бит) и всего сэмплов (36 бит)
      const data = buffer.subarray(start, start + 34);
      const sampleRate = (data[10] << 12) | (data[11] << 4) | ((data[12] >> 4) & 0x0f);
      const totalSamples = (data[13] & 0x0f) * 2 ** 32 + data.readUInt32BE(14);
      if (sampleRate > 0 && totalSamples > 0) duration = totalSamples / sampleRate;
    }

    if (type === 4) {
      const text = buffer.subarray(start, start + length).toString('utf8');
      const readField = (name) => {
        const match = text.match(new RegExp(`${name}=([^\\u0000\\n]*)`, 'i'));
        return match ? match[1].trim() : '';
      };
      const title = readField('TITLE');
      const artist = readField('ARTIST');
      const album = readField('ALBUM');
      if (title) tags.TIT2 = title;
      if (artist) tags.TPE1 = artist;
      if (album) tags.TALB = album;
    }

    pos = start + length;
    if (last) break;
  }
  return { tags, duration };
}

function parseWav(buffer) {
  if (buffer.length < 44) return null;
  if (buffer.toString('latin1', 0, 4) !== 'RIFF' || buffer.toString('latin1', 8, 12) !== 'WAVE') return null;
  let duration = 0;
  let pos = 12;
  while (pos + 8 <= buffer.length) {
    const chunkId = buffer.toString('latin1', pos, pos + 4);
    const size = buffer.readUInt32LE(pos + 4);
    if (chunkId === 'fmt ' && size >= 12) {
      const byteRate = buffer.readUInt32LE(pos + 16);
      const dataStart = pos + 8 + size;
      if (dataStart + 8 <= buffer.length && buffer.toString('latin1', dataStart, dataStart + 4) === 'data' && byteRate > 0) {
        const dataSize = buffer.readUInt32LE(dataStart + 4);
        duration = dataSize / byteRate;
      }
      break;
    }
    pos += 8 + size + (size % 2);
  }
  return { duration };
}

/** mp3: считаем длительность по первому фрейму (битрейт) и размеру файла. */
function mp3Duration(buffer, fileSize) {
  const audioStart = (() => {
    const tags = parseId3v2(buffer);
    if (!tags) return 0;
    const size =
      ((buffer[6] & 0x7f) << 21) | ((buffer[7] & 0x7f) << 14) | ((buffer[8] & 0x7f) << 7) | (buffer[9] & 0x7f);
    return 10 + size;
  })();

  const bitrates = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
  for (let i = audioStart; i + 4 < Math.min(buffer.length, audioStart + 64 * 1024); i += 1) {
    if (buffer[i] !== 0xff || (buffer[i + 1] & 0xe0) !== 0xe0) continue;
    const versionBits = (buffer[i + 1] >> 3) & 0x03;
    const layerBits = (buffer[i + 1] >> 1) & 0x03;
    if (layerBits !== 0x01) continue; // Layer III
    const bitrateIndex = (buffer[i + 2] >> 4) & 0x0f;
    const bitrate = bitrates[bitrateIndex];
    if (!bitrate) continue;
    const isMpeg1 = versionBits === 0x03;
    const sampleRateTable = isMpeg1 ? [44100, 48000, 32000] : [22050, 24000, 16000];
    const sampleRate = sampleRateTable[(buffer[i + 2] >> 2) & 0x03] || 44100;
    const padding = (buffer[i + 2] >> 1) & 0x01;
    const frameSize = Math.floor((isMpeg1 ? 144000 : 72000) * (bitrate / sampleRate)) + padding;
    if (frameSize <= 0) return 0;
    const frames = Math.max(0, (fileSize - i) / frameSize);
    return (frames * (isMpeg1 ? 1152 : 576)) / sampleRate;
  }
  return 0;
}

function readHead(filePath) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const stats = fs.fstatSync(fd);
    const size = Math.min(stats.size, TAG_BYTES);
    const buffer = Buffer.alloc(size);
    fs.readSync(fd, buffer, 0, size, 0);
    return { buffer, fileSize: stats.size };
  } finally {
    fs.closeSync(fd);
  }
}

/** Достаём из файла всё, что можем, без сторонних библиотек. */
export async function readMetadata(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const fallbackTitle = path.basename(filePath, ext);
  const result = { title: fallbackTitle, artists: [], album: null, duration: 0 };

  try {
    const { buffer, fileSize } = readHead(filePath);
    let tags = null;

    if (ext === '.flac') {
      const parsed = parseFlac(buffer);
      if (parsed) {
        tags = parsed.tags;
        result.duration = Math.round(parsed.duration) || 0;
      }
    } else if (ext === '.wav') {
      const parsed = parseWav(buffer);
      if (parsed) result.duration = Math.round(parsed.duration) || 0;
    } else {
      tags = parseId3v2(buffer);
      if (!tags) {
        try {
          const tail = Buffer.alloc(128);
          const fd = fs.openSync(filePath, 'r');
          fs.readSync(fd, tail, 0, 128, Math.max(0, fileSize - 128));
          fs.closeSync(fd);
          tags = parseId3v1(tail);
        } catch { /* без тегов */ }
      }
      if (ext === '.mp3') result.duration = Math.round(mp3Duration(buffer, fileSize)) || 0;
    }

    if (tags) {
      if (tags.TIT2) result.title = tags.TIT2;
      if (tags.TPE1) result.artists = tags.TPE1.split(/[;,/]\s*/).filter(Boolean);
      if (tags.TALB) result.album = tags.TALB;
    }
  } catch (err) {
    console.warn('[local] не удалось прочитать теги:', path.basename(filePath), err.message);
  }

  // если тегов нет — пробуем разобрать «Исполнитель - Название.mp3»
  if (!result.artists.length) {
    const match = fallbackTitle.match(/^(.{2,60}?)\s+[-–—]\s+(.{2,120})$/);
    if (match) {
      result.artists = [match[1].trim()];
      result.title = match[2].trim();
    }
  }
  return result;
}

function toTrack(entry) {
  return {
    id: entry.id,
    source: 'local',
    sourceId: entry.id.replace(/^local:/, ''),
    title: entry.title,
    artists: Array.isArray(entry.artists) && entry.artists.length ? entry.artists : ['Своя музыка'],
    album: entry.album || null,
    cover: entry.cover || null,
    duration: entry.duration || 0,
    playable: true,
    reason: null,
    explicit: false,
  };
}

/* --------------------------- публичный API -------------------------------- */

export function count() {
  return loadIndex().tracks.length;
}

export function listTracks() {
  return loadIndex()
    .tracks.slice()
    .sort((a, b) => String(a.title || '').localeCompare(String(b.title || ''), 'ru'))
    .map(toTrack);
}

export function findEntry(id) {
  const wanted = String(id || '').startsWith('local:') ? String(id) : `local:${id}`;
  return loadIndex().tracks.find((t) => t.id === wanted) || null;
}

export function streamInfo(id) {
  const entry = findEntry(id);
  if (!entry) {
    const err = new Error('Файл не найден в локальной библиотеке');
    err.code = 'NOT_FOUND';
    throw err;
  }
  if (!fs.existsSync(entry.path)) {
    const err = new Error('Файл переехал или удалён с диска');
    err.code = 'NOT_FOUND';
    throw err;
  }
  const ext = path.extname(entry.path).toLowerCase();
  return {
    filePath: entry.path,
    contentType: AUDIO_EXT.get(ext) || 'application/octet-stream',
    name: path.basename(entry.path),
  };
}

async function addFile(filePath) {
  const abs = path.resolve(filePath);
  const ext = path.extname(abs).toLowerCase();
  if (!AUDIO_EXT.has(ext)) return { skipped: 'не аудио' };
  const data = loadIndex();
  const existing = data.tracks.find((t) => t.path === abs);
  if (existing) return { skipped: 'уже в библиотеке' };

  const meta = await readMetadata(abs);
  const entry = {
    id: trackId(abs),
    path: abs,
    title: meta.title || path.basename(abs, ext),
    artists: meta.artists,
    album: meta.album,
    duration: meta.duration,
    addedAt: new Date().toISOString(),
  };
  data.tracks.push(entry);
  return { added: toTrack(entry) };
}

/** Импорт файлов и папок (папки обходим рекурсивно, но без символических ссылок). */
export async function importPaths(inputPaths) {
  const list = Array.isArray(inputPaths) ? inputPaths : [inputPaths];
  const result = { added: 0, skipped: 0, errors: [], tracks: [] };

  const walk = async (target, depth = 0) => {
    if (depth > 6) return;
    let stat;
    try {
      stat = await fsp.stat(target);
    } catch (err) {
      result.errors.push(`${path.basename(target)}: ${err.code || err.message}`);
      return;
    }
    if (stat.isDirectory()) {
      let entries = [];
      try {
        entries = await fsp.readdir(target, { withFileTypes: true });
      } catch (err) {
        result.errors.push(`${path.basename(target)}: ${err.code || err.message}`);
        return;
      }
      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue;
        await walk(path.join(target, entry.name), depth + 1);
      }
      return;
    }
    if (!stat.isFile()) return;

    const outcome = await addFile(target);
    if (outcome.added) {
      result.added += 1;
      result.tracks.push(outcome.added);
    } else {
      result.skipped += 1;
    }
  };

  for (const target of list) {
    if (!target) continue;
    await walk(String(target));
  }

  if (result.added) saveIndex();
  return result;
}

/** Файл, загруженный из браузера (потоком), сохраняем в <data>/local. */
export async function addUpload(originalName, stream) {
  const safeName = String(originalName || 'track.mp3').replace(/[\\/:*?"<>|]/g, '_').slice(-120);
  const dir = uploadDir();
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, `${Date.now()}-${safeName}`);

  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(target);
    stream.pipe(out);
    stream.on('error', reject);
    out.on('error', reject);
    out.on('finish', resolve);
  });

  const ext = path.extname(target).toLowerCase();
  if (!AUDIO_EXT.has(ext)) {
    try { fs.unlinkSync(target); } catch { /* ignore */ }
    const err = new Error('Поддерживаются mp3, flac, m4a, aac, ogg, opus, wav, webm');
    err.code = 'BAD_REQUEST';
    throw err;
  }

  const meta = await readMetadata(target);
  const data = loadIndex();
  const entry = {
    id: trackId(target),
    path: target,
    title: meta.title,
    artists: meta.artists,
    album: meta.album,
    duration: meta.duration,
    uploaded: true,
    addedAt: new Date().toISOString(),
  };
  data.tracks.push(entry);
  saveIndex();
  return toTrack(entry);
}

export function removeTrack(id) {
  const data = loadIndex();
  const index = data.tracks.findIndex((t) => t.id === (String(id).startsWith('local:') ? id : `local:${id}`));
  if (index < 0) return false;
  const [entry] = data.tracks.splice(index, 1);
  // копии, загруженные через браузер, удаляем с диска; чужие файлы не трогаем
  if (entry.uploaded) {
    try { fs.unlinkSync(entry.path); } catch { /* уже нет */ }
  }
  saveIndex();
  return true;
}

export function searchTracks(query, limit = 20) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return [];
  return listTracks()
    .filter((track) =>
      [track.title, ...(track.artists || []), track.album || '']
        .join(' ')
        .toLowerCase()
        .includes(q),
    )
    .slice(0, limit);
}
