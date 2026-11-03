/**
 * Discord Rich Presence для labsoul.
 *
 * Показывает в профиле Discord, что сейчас играет: название, исполнитель,
 * обложка и время трека — как это делает Liner.
 *
 * Реализовано без внешних зависимостей: собственный минимальный клиент
 * Discord IPC (локальный сокет `discord-ipc-N`). Если Discord не запущен,
 * модуль молча отключается — музыка от этого не страдает.
 */

const net = require('node:net');
const path = require('node:path');
const os = require('node:os');

/** ID приложения Discord (создаётся один раз владельцем проекта). */
const CLIENT_ID = '1345618743929315328';

const OP = {
  HANDSHAKE: 0,
  FRAME: 1,
  CLOSE: 2,
  PING: 3,
  PONG: 4,
};

const state = {
  socket: null,
  ready: false,
  connected: false,
  lastActivity: 0,
  error: null,
  pipeIndex: 0,
};

/** Путь к сокету Discord на текущей платформе. */
function pipePath(index) {
  if (process.platform === 'win32') return `\\\\?\\pipe\\discord-ipc-${index}`;
  const base = process.env.XDG_RUNTIME_DIR || process.env.TMPDIR || os.tmpdir();
  return path.join(base, `discord-ipc-${index}`);
}

/** Собрать пакет Discord IPC: 8 байт заголовок + JSON. */
function encode(op, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  const header = Buffer.alloc(8);
  header.writeInt32LE(op, 0);
  header.writeInt32LE(body.length, 4);
  return Buffer.concat([header, body]);
}

/** Разобрать поток пакетов (в одном чанке их может быть несколько). */
function decode(buffer) {
  const frames = [];
  let offset = 0;
  while (offset + 8 <= buffer.length) {
    const op = buffer.readInt32LE(offset);
    const length = buffer.readInt32LE(offset + 4);
    if (offset + 8 + length > buffer.length) break;
    const raw = buffer.subarray(offset + 8, offset + 8 + length).toString('utf8');
    try {
      frames.push({ op, data: JSON.parse(raw) });
    } catch {
      /* битый кадр пропускаем */
    }
    offset += 8 + length;
  }
  return { frames, rest: buffer.subarray(offset) };
}

/** Подключиться к Discord (перебираем discord-ipc-0…9). */
function connect() {
  return new Promise((resolve) => {
    const tryNext = (index) => {
      if (index > 9) {
        state.error = 'Discord не запущен';
        resolve(false);
        return;
      }
      const socket = net.createConnection(pipePath(index));
      let pending = Buffer.alloc(0);

      socket.once('error', () => {
        socket.destroy();
        tryNext(index + 1);
      });

      socket.once('connect', () => {
        state.socket = socket;
        state.connected = true;
        state.pipeIndex = index;

        socket.write(encode(OP.HANDSHAKE, { v: 1, client_id: CLIENT_ID }));

        socket.on('data', (chunk) => {
          pending = Buffer.concat([pending, chunk]);
          const { frames, rest } = decode(pending);
          pending = rest;
          for (const frame of frames) {
            if (frame.op === OP.PING) socket.write(encode(OP.PONG, frame.data));
            if (frame.op === OP.FRAME && frame.data?.evt === 'READY') {
              state.ready = true;
              resolve(true);
            }
          }
        });

        socket.on('error', () => {
          state.connected = false;
          state.ready = false;
        });

        socket.on('close', () => {
          state.connected = false;
          state.ready = false;
          state.socket = null;
        });

        // если READY не пришёл за секунду — не блокируем запуск
        setTimeout(() => resolve(state.ready), 1200);
      });
    };

    tryNext(0);
  });
}

/** Отправить активность. */
function setActivity(activity) {
  if (!state.ready || !state.socket) return false;

  // Discord не любит частые обновления: не чаще раза в 4 секунды
  const now = Date.now();
  if (now - state.lastActivity < 4000) return false;
  state.lastActivity = now;

  const payload = {
    cmd: 'SET_ACTIVITY',
    args: {
      pid: process.pid,
      activity: {
        details: activity.title ? String(activity.title).slice(0, 128) : undefined,
        state: activity.artist ? String(activity.artist).slice(0, 128) : undefined,
        assets: activity.cover
          ? { large_image: activity.cover, large_text: activity.artist || 'labsoul' }
          : { large_text: 'labsoul' },
        timestamps: activity.startedAt
          ? { start: Math.round(activity.startedAt) }
          : undefined,
        instance: false,
      },
    },
    nonce: `${now}`,
  };

  try {
    state.socket.write(encode(OP.FRAME, payload));
    return true;
  } catch {
    return false;
  }
}

/** Сбросить активность (пауза). */
function clearActivity() {
  if (!state.ready || !state.socket) return;
  try {
    state.socket.write(encode(OP.FRAME, {
      cmd: 'SET_ACTIVITY',
      args: { pid: process.pid, activity: null },
      nonce: `${Date.now()}`,
    }));
  } catch { /* ignore */ }
}

/** Текущее состояние для интерфейса. */
function status() {
  return {
    connected: state.connected,
    ready: state.ready,
    error: state.error,
    pipe: state.connected ? state.pipeIndex : null,
  };
}

/** Подключиться при старте (в фоне, не блокируя окно). */
async function start() {
  const ok = await connect();
  if (!ok) state.error = 'Discord не запущен';
  return ok;
}

module.exports = { start, setActivity, clearActivity, status };
