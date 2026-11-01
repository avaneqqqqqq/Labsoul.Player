/* =========================================================================
   labsoul — движок воспроизведения.
   <audio> + Web Audio: createMediaElementSource → предусиление → 10 полос
   BiquadFilterNode → GainNode → выход. Очередь, shuffle/repeat, история.
   ========================================================================= */

import { isOnline, postHistory, streamUrl, waveFeedback } from './api.js';
import { subscribe as onThemeChange, theme } from './theme.js';
import { clamp, readJSON, writeJSON } from './utils.js';

export const EQ_HZ = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
export const EQ_LABELS = ['31', '62', '125', '250', '500', '1k', '2k', '4k', '8k', '16k'];

export const EQ_PRESETS = {
  flat: { name: 'Плоский', bands: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
  bass: { name: 'Басы', bands: [8, 7, 5, 3, 0, -1, -2, -2, -1, 0] },
  vocal: { name: 'Вокал', bands: [-2, -1, 0, 2, 4, 4, 4, 2, 0, -1] },
  rock: { name: 'Рок', bands: [5, 4, 2, 0, -1, 0, 2, 4, 5, 4] },
  pop: { name: 'Поп', bands: [-1, 1, 3, 4, 3, 1, -1, -1, 0, 1] },
  electro: { name: 'Электроника', bands: [6, 5, 2, 0, -2, -1, 2, 4, 5, 3] },
  jazz: { name: 'Джаз', bands: [3, 2, 1, 2, 3, 3, 2, 1, 1, 0] },
  night: { name: 'Ночной', bands: [2, 1, 0, -1, -2, -2, -3, -3, -3, -3] },
};

export const REASON_TEXT = {
  no_preview: 'Доступен только короткий фрагмент',
  go_plus: 'Трек доступен в Яндекс Плюсе',
  geo: 'Трек недоступен в вашем регионе',
  not_streamable: 'Этот трек нельзя воспроизвести',
};

const UI_KEY = 'player-ui';
const savedUi = readJSON(UI_KEY, {}) || {};

const audio = /** @type {HTMLAudioElement} */ (document.querySelector('#audio'));

const listeners = new Set();
const state = {
  queue: [],
  index: -1,
  current: null,
  playing: false,
  loading: false,
  time: 0,
  duration: 0,
  volume: clamp(Number(savedUi.volume ?? 0.8) || 0, 0, 1),
  muted: !!savedUi.muted,
  shuffle: !!savedUi.shuffle,
  repeat: ['off', 'all', 'one'].includes(savedUi.repeat) ? savedUi.repeat : 'off',
  simulated: false,
  error: null,
  context: null,
};

/* ------------------------------------------------------------------ */
/* Сеть состояния                                                      */
/* ------------------------------------------------------------------ */

function snapshot() {
  return {
    queue: state.queue,
    index: state.index,
    current: state.current,
    playing: state.playing,
    loading: state.loading,
    time: state.time,
    duration: state.duration,
    volume: state.volume,
    muted: state.muted,
    shuffle: state.shuffle,
    repeat: state.repeat,
    simulated: state.simulated,
    error: state.error,
    context: state.context,
  };
}

export function subscribe(fn) {
  listeners.add(fn);
  try { fn(snapshot(), 'init'); } catch { /* ignore */ }
  return () => listeners.delete(fn);
}

function emit(event = 'state') {
  const snap = snapshot();
  for (const fn of listeners) {
    try { fn(snap, event); } catch (err) { console.warn('[labsoul] player listener', err); }
  }
}

function persistUi() {
  writeJSON(UI_KEY, {
    volume: state.volume,
    muted: state.muted,
    shuffle: state.shuffle,
    repeat: state.repeat,
  });
}

/* ------------------------------------------------------------------ */
/* Web Audio: эквалайзер                                               */
/* ------------------------------------------------------------------ */

let audioCtx = null;
let sourceNode = null;
let preampNode = null;
let outNode = null;
/** Анализатор спектра: питает визуализатор «под бит». */
let analyserNode = null;
let eqNodes = [];
// если Web Audio не смог отдать звук — играем напрямую, без эквалайзера
let bypassGraph = false;

/* Два независимых плеера: нужны для настоящего кроссфейда.
   Пока один трек гаснет, второй уже звучит — как в Spotify. */
let masterNode = null;
let altAudio = null;
let altSourceNode = null;
let altPreampNode = null;
let altOutNode = null;
let altEqNodes = [];
/** Какая цепочка сейчас активна: 'main' | 'alt'. */
let activeChain = 'main';
/** Таймер кроссфейда. */
let crossfadeTimer = 0;
/** Ключ трека, для которого уже запускали автоматический переход. */
let crossfadeArmedFor = null;

const dbToGain = (db) => (db === 0 ? 1 : 10 ** (db / 20));

/**
 * Построить цепочку для одного аудиоэлемента:
 *   элемент → предусиление → 10 полос → выход (gain) → общий мастер.
 *
 * Два независимых плеера нужны для настоящего кроссфейда: старый трек
 * продолжает звучать и гаснет, пока новый уже набирает громкость — как в
 * Spotify и Яндекс.Музыке. Эквалайзер у каждого свой, чтобы кривая не
 * применялась дважды.
 */
function buildChain(el) {
  const source = audioCtx.createMediaElementSource(el);
  const preamp = audioCtx.createGain();
  const out = audioCtx.createGain();

  const bands = EQ_HZ.map((freq) => {
    const node = audioCtx.createBiquadFilter();
    node.type = 'peaking';
    node.frequency.value = freq;
    node.Q.value = 1.3;
    node.gain.value = 0;
    return node;
  });

  let cursor = preamp;
  source.connect(cursor);
  for (const node of bands) {
    cursor.connect(node);
    cursor = node;
  }
  cursor.connect(out);
  out.connect(masterNode);

  return { source, preamp, out, bands };
}

function ensureGraph() {
  if (bypassGraph) return false;
  if (audioCtx) return true;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return false;
  try {
    audioCtx = new Ctx();
    masterNode = audioCtx.createGain();
    masterNode.connect(audioCtx.destination);

    // основная цепочка — элемент из разметки
    const main = buildChain(audio);
    sourceNode = main.source;
    preampNode = main.preamp;
    outNode = main.out;
    eqNodes = main.bands;

    // вторая цепочка — только для кроссфейда, создаём заранее
    altAudio = document.createElement('audio');
    altAudio.preload = 'auto';
    altAudio.crossOrigin = 'anonymous';
    const second = buildChain(altAudio);
    altSourceNode = second.source;
    altPreampNode = second.preamp;
    altOutNode = second.out;
    altEqNodes = second.bands;
    altOutNode.gain.value = 0;

    // анализатор спектра для визуализатора «под бит»: подключаем параллельно,
    // на звук не влияет (он только читает данные)
    try {
      analyserNode = audioCtx.createAnalyser();
      analyserNode.fftSize = 256;
      analyserNode.smoothingTimeConstant = 0.72;
      masterNode.connect(analyserNode);
    } catch {
      analyserNode = null;
    }

    applyEq();
    return true;
  } catch (err) {
    console.warn('[labsoul] Web Audio недоступен, играем без эквалайзера:', err);
    audioCtx = null;
    return false;
  }
}

/** Эквалайзер применяется к обеим цепочкам. */
function applyEq() {
  const apply = (preamp, nodes) => {
    if (!preamp || !nodes.length) return;
    preamp.gain.value = theme.eq.on ? dbToGain(theme.eq.preamp) : 1;
    nodes.forEach((node, i) => {
      node.gain.value = theme.eq.on ? Number(theme.eq.bands[i] || 0) : 0;
    });
  };
  apply(preampNode, eqNodes);
  apply(altPreampNode, altEqNodes);
}

function resumeCtx() {
  if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
}

onThemeChange(() => applyEq());

/**
 * Страховка: если Web Audio почему-то не отдал звук (кросс-доменный поток,
 * упавший контекст), отключаем граф и повторяем без него — лучше без
 * эквалайзера, чем без музыки.
 */
function disableGraphAndRetry() {
  if (bypassGraph) return;
  bypassGraph = true;
  try {
    if (sourceNode) sourceNode.disconnect();
  } catch { /* уже отключён */ }
  sourceNode = null;
  try { audioCtx && audioCtx.close(); } catch { /* ignore */ }
  audioCtx = null;
  eqNodes = [];
  preampNode = null;
  outNode = null;
  const url = audio.src;
  if (!url) return;
  try {
    audio.crossOrigin = null;
    audio.src = url;
    audio.load();
    audio.play().catch(() => {});
  } catch { /* ignore */ }
}

/* ------------------------------------------------------------------ */
/* Симуляция (демо-режим): интерфейс живой без сервера                  */
/* ------------------------------------------------------------------ */

let simTimer = 0;
let simLast = 0;

function stopSimulation() {
  clearInterval(simTimer);
  simTimer = 0;
  state.simulated = false;
}

function startSimulation() {
  stopSimulation();
  state.simulated = true;
  state.duration = state.current?.duration || 180;
  state.time = 0;
  state.loading = false;
  state.playing = true;
  state.error = null;
  simLast = performance.now();
  simTimer = setInterval(simTick, 200);
  emit('state');
}

function simTick() {
  if (!state.playing || !state.simulated) { simLast = performance.now(); return; }
  const now = performance.now();
  const dt = Math.min(1, (now - simLast) / 1000);
  simLast = now;
  state.time = Math.min(state.duration, state.time + dt);
  if (state.time >= state.duration) {
    state.time = state.duration;
    handleEnded();
    return;
  }
  emit('time');
}

/* ------------------------------------------------------------------ */
/* История и фидбек волны                                              */
/* ------------------------------------------------------------------ */

async function commitHistory() {
  const track = state.current;
  if (!track) return;
  const played = Math.round(state.time || 0);
  state.time = 0;
  if (played < 5) return;
  try { await postHistory(track, played); } catch { /* история не критична */ }
  if (state.context?.type === 'wave') {
    waveFeedback({
      type: 'finished',
      trackId: track.id,
      batchId: state.context.batchId || null,
      position: state.context.position || 0,
    });
  }
  emit('history');
}

function feedbackStarted(track) {
  if (state.context?.type !== 'wave' || !track) return;
  waveFeedback({
    type: 'started',
    trackId: track.id,
    batchId: state.context.batchId || null,
    position: state.context.position || 0,
  });
}

/* ------------------------------------------------------------------ */
/* Media Session                                                       */
/* ------------------------------------------------------------------ */

function updateMediaSession(track) {
  if (!('mediaSession' in navigator) || typeof MediaMetadata === 'undefined') return;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: track.title,
      artist: (track.artists || []).join(', '),
      album: track.album || 'labsoul',
      artwork: track.cover ? [{ src: track.cover, sizes: '512x512' }] : [],
    });
  } catch { /* браузер может не поддерживать */ }
}

function initMediaSessionHandlers() {
  if (!('mediaSession' in navigator)) return;
  const set = (action, handler) => {
    try { navigator.mediaSession.setActionHandler(action, handler); } catch { /* ignore */ }
  };
  set('play', () => play());
  set('pause', () => pause());
  set('previoustrack', () => prev());
  set('nexttrack', () => next());
  set('seekbackward', () => seekBy(-10));
  set('seekforward', () => seekBy(10));
}

/* ------------------------------------------------------------------ */
/* Выбор следующего трека                                              */
/* ------------------------------------------------------------------ */

function randomIndexExcept(current) {
  if (state.queue.length < 2) return current;
  let next = current;
  let guard = 0;
  while (next === current && guard < 40) {
    next = Math.floor(Math.random() * state.queue.length);
    guard += 1;
  }
  return next;
}

function nextIndex(auto) {
  const len = state.queue.length;
  if (!len) return -1;
  if (auto && state.repeat === 'one') return state.index;
  if (state.shuffle) return randomIndexExcept(state.index);
  const candidate = state.index + 1;
  if (candidate < len) return candidate;
  if (state.repeat === 'all' || !auto) return 0;
  return -1;
}

/* ------------------------------------------------------------------ */
/* Воспроизведение                                                     */
/* ------------------------------------------------------------------ */

function stopReal() {
  try {
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
  } catch { /* ignore */ }
}

function playCurrent() {
  const track = state.queue[state.index] || null;
  if (!track) { stopAll(); return; }
  stopSimulation();
  commitHistory();

  // Настоящий кроссфейд: старый трек продолжает звучать и гаснет, пока новый
  // набирает громкость. Без него — короткое затухание и сразу новый.
  const wantCrossfade = crossfadeReady() && state.playing && !audio.paused;
  if (wantCrossfade) startCrossfade();
  else { try { audio.pause(); } catch { /* ignore */ } }

  // новый трек — сбрасываем метку автоматического перехода
  crossfadeArmedFor = null;

  state.current = track;
  state.time = 0;
  state.duration = track.duration || 0;
  state.error = null;
  state.loading = true;
  state.playing = false;
  state.context = state.context ? { ...state.context, position: state.index } : null;

  emit('track');
  updateMediaSession(track);
  feedbackStarted(track);

  if (!track.playable) {
    state.loading = false;
    state.playing = false;
    state.error = REASON_TEXT[track.reason] || 'Трек недоступен';
    emit('unplayable');
    emit('state');
    return;
  }

  if (!isOnline()) {
    startSimulation();
    return;
  }

  ensureGraph();
  resumeCtx();
  const url = streamUrl(track);
  if (!url) { startSimulation(); return; }

  // при кроссфейде новый трек грузится во второй элемент, пока первый гаснет
  const el = playbackElement();

  try {
    // элемент читает Web Audio: без crossOrigin поток считается кросс-доменным
    // и createMediaElementSource выдаёт тишину (эквалайзер «ломает» звук)
    if (el.crossOrigin !== 'anonymous') el.crossOrigin = 'anonymous';
    el.src = url;
    el.load();
  } catch {
    startSimulation();
    return;
  }

  emit('state');
  armStallWatchdog();
  // запускаем аудиоконтекст и только потом включаем плавное нарастание:
  // расписание громкости в приостановленном контексте не действует,
  // и плеер остался бы совершенно без звука
  ensureRunning(() => {
    fadeIn();
    const attempt = el.play();
    if (attempt && typeof attempt.then === 'function') {
      attempt.then(() => {
        state.playing = true;
        state.loading = false;
        emit('state');
      }).catch((err) => {
        state.loading = false;
        state.playing = false;
        state.error = err?.name === 'NotAllowedError'
          ? 'Браузер ждёт нажатия кнопки воспроизведения'
          : 'Не удалось получить звук с сервера';
        emit('error');
        emit('state');
      });
    }
  });
}

/**
 * Убедиться, что аудиоконтекст работает, и вызвать действие.
 *
 * Аудиоконтекст после сворачивания окна или смены вкладки переходит в
 * «suspended»: Web Audio при этом молчит, хотя элемент играет. Поэтому
 * запускаем контекст и только после этого включаем звук.
 */
function ensureRunning(action) {
  if (!audioCtx || bypassGraph) { action(); return; }
  if (audioCtx.state === 'running') { action(); return; }
  audioCtx.resume().then(action).catch(action);
}

/* ---------------------------- кроссфейд ---------------------------------- */

/** Готов ли движок к настоящему кроссфейду. */
function crossfadeReady() {
  return Boolean(
    theme.crossfadeFull &&
    audioCtx && audioCtx.state === 'running' &&
    altAudio && altOutNode && !bypassGraph,
  );
}

/** Активный элемент и его выход. */
function chainOf(name) {
  return name === 'alt'
    ? { el: altAudio, out: altOutNode }
    : { el: audio, out: outNode };
}

/**
 * Плавно погасить текущий трек и переключить воспроизведение на другой
 * элемент. Вызывается за crossfadeSec секунд до конца трека либо при
 * ручном переключении, если включён полный кроссфейд.
 */
function startCrossfade() {
  if (!crossfadeReady()) return false;

  const seconds = Math.max(1, Math.min(12, Number(theme.crossfadeSec) || 4));
  const from = chainOf(activeChain);
  const to = chainOf(activeChain === 'alt' ? 'main' : 'alt');

  // новый трек будет играть в другом элементе — готовим его заранее
  pendingChain = activeChain === 'alt' ? 'main' : 'alt';

  const now = audioCtx.currentTime;
  const end = now + seconds;

  try {
    // старый трек гаснет, новый появляется
    from.out.gain.cancelScheduledValues(now);
    from.out.gain.setValueAtTime(from.out.gain.value, now);
    from.out.gain.linearRampToValueAtTime(0, end);
  } catch { /* ignore */ }

  // гасим старый элемент после затухания
  clearTimeout(crossfadeTimer);
  crossfadeTimer = setTimeout(() => {
    try { from.el.pause(); } catch { /* ignore */ }
  }, seconds * 1000 + 120);

  return { from: activeChain, to: pendingChain, seconds };
}

/** Элемент, в который нужно загрузить следующий трек. */
let pendingChain = 'main';

/** Вернуть цепочку к жизни после кроссфейда. */
function takeChain(name) {
  activeChain = name;
  const target = chainOf(name);
  try {
    const now = audioCtx ? audioCtx.currentTime : 0;
    target.out.gain.cancelScheduledValues(now);
    target.out.gain.setValueAtTime(1, now);
  } catch { /* ignore */ }
  return target.el;
}

/** Элемент, в который следует грузить трек прямо сейчас. */
function playbackElement() {
  if (pendingChain !== activeChain && crossfadeReady()) {
    const name = pendingChain;
    pendingChain = activeChain;
    return takeChain(name);
  }
  return audio;
}

/** Элемент, который сейчас звучит (с учётом кроссфейда). */
function activeEl() {
  return activeChain === 'alt' && altAudio ? altAudio : audio;
}

function handleEnded() {
  if (state.repeat === 'one') {
    commitHistory();
    seek(0);
    play();
    return;
  }
  const idx = nextIndex(true);
  if (idx === -1) {
    state.playing = false;
    state.time = state.duration;
    commitHistory();
    emit('state');
    return;
  }
  state.index = idx;
  playCurrent();
}

function stopAll() {
  stopSimulation();
  stopReal();
  commitHistory();
  state.queue = [];
  state.index = -1;
  state.current = null;
  state.playing = false;
  state.loading = false;
  state.time = 0;
  state.duration = 0;
  state.error = null;
  state.context = null;
  emit('queue');
  emit('state');
}

/* ------------------------------------------------------------------ */
/* Публичные операции                                                  */
/* ------------------------------------------------------------------ */

/**
 * Заменить очередь и начать играть.
 * @param {object[]} tracks
 * @param {number} startIndex
 * @param {{context?:object}} opts
 */
export function playTracks(tracks, startIndex = 0, opts = {}) {
  const list = (Array.isArray(tracks) ? tracks : []).filter(Boolean);
  if (!list.length) return;
  const index = clamp(Math.round(startIndex) || 0, 0, list.length - 1);
  state.queue = list.slice();
  state.index = index;
  state.context = opts.context || null;
  playCurrent();
  emit('queue');
}

export function playAt(index) {
  if (index < 0 || index >= state.queue.length) return;
  state.index = index;
  playCurrent();
  emit('queue');
}

/** Играть конкретный трек (найдёт в очереди или вставит после текущего). */
export function playTrack(track) {
  if (!track) return;
  const found = state.queue.findIndex((item) => item.id === track.id);
  if (found >= 0) {
    playAt(found);
    return;
  }
  state.queue.push(track);
  state.index = state.queue.length - 1;
  playCurrent();
  emit('queue');
}

export function enqueue(tracks) {
  const list = (Array.isArray(tracks) ? tracks : [tracks]).filter(Boolean);
  if (!list.length) return { added: 0, started: false };
  if (!state.queue.length) {
    playTracks(list, 0);
    return { added: list.length, started: true };
  }
  let added = 0;
  for (const track of list) {
    if (state.queue.some((item) => item.id === track.id)) continue;
    state.queue.push(track);
    added += 1;
  }
  persistUi();
  emit('queue');
  emit('state');
  return { added, started: false };
}

export function play() {
  if (!state.current) {
    if (state.queue.length) { playAt(0); }
    return;
  }
  if (!state.current.playable) { emit('unplayable'); return; }
  if (state.simulated) {
    state.playing = true;
    simLast = performance.now();
    emit('state');
    return;
  }
  resumeCtx();
  const el = activeEl();
  if (!el.src) { playCurrent(); return; }
  el.play().then(() => {
    state.playing = true;
    emit('state');
  }).catch(() => {
    // сервер пропал — доигрываем демо-симуляцией, чтобы интерфейс не «залипал»
    startSimulation();
  });
}

export function pause() {
  if (state.simulated) {
    state.playing = false;
    emit('state');
    return;
  }
  try { audio.pause(); } catch { /* ignore */ }
  try { altAudio?.pause(); } catch { /* ignore */ }
  state.playing = false;
  emit('state');
}

export function toggle() {
  if (state.playing) pause();
  else play();
}

export function next(auto = false) {
  const idx = nextIndex(auto);
  if (idx === -1) {
    fadeOut();
    pause();
    state.time = state.duration;
    commitHistory();
    emit('state');
    return;
  }
  if (idx === state.index) {
    seek(0);
    play();
    return;
  }
  state.index = idx;
  playCurrent();
  emit('queue');
}

export function prev() {
  if (state.time > 3) { seek(0); return; }
  if (!state.queue.length) return;
  const idx = state.shuffle
    ? randomIndexExcept(state.index)
    : (state.index - 1 + state.queue.length) % state.queue.length;
  state.index = idx;
  playCurrent();
  emit('queue');
}

export function seek(seconds) {
  const total = state.duration || state.current?.duration || 0;
  const value = clamp(Number(seconds) || 0, 0, total);
  state.time = value;
  const seekEl = activeEl();
  if (!state.simulated && seekEl.src) {
    try { seekEl.currentTime = value; } catch { /* ignore */ }
  }
  emit('time');
}

export function seekBy(delta) {
  const total = state.duration || state.current?.duration || 0;
  seek(clamp(state.time + Number(delta || 0), 0, total));
}

/** Громкость и mute применяем к обоим элементам (кроссфейд). */
function applyVolume() {
  for (const el of [audio, altAudio]) {
    if (!el) continue;
    el.volume = state.volume;
    el.muted = state.muted;
  }
}

export function setVolume(value) {
  const v = clamp(Number(value) || 0, 0, 1);
  state.volume = v;
  state.muted = v === 0;
  applyVolume();
  persistUi();
  emit('state');
}

export function toggleMute() {
  state.muted = !state.muted;
  applyVolume();
  persistUi();
  emit('state');
}

export function setShuffle(value) {
  state.shuffle = !!value;
  persistUi();
  emit('state');
}

export function toggleShuffle() {
  setShuffle(!state.shuffle);
  return state.shuffle;
}

export function cycleRepeat() {
  const order = ['off', 'all', 'one'];
  state.repeat = order[(order.indexOf(state.repeat) + 1) % order.length];
  persistUi();
  emit('state');
  return state.repeat;
}

export function removeQueueItem(index) {
  if (index < 0 || index >= state.queue.length) return;
  if (index === state.index) {
    commitHistory();
    state.queue.splice(index, 1);
    if (!state.queue.length) { stopAll(); return; }
    state.index = Math.min(index, state.queue.length - 1);
    playCurrent();
    emit('queue');
    return;
  }
  state.queue.splice(index, 1);
  if (index < state.index) state.index -= 1;
  emit('queue');
  emit('state');
}

export function moveQueueItem(from, to) {
  if (from === to || from < 0 || to < 0 || from >= state.queue.length || to >= state.queue.length) return;
  const [item] = state.queue.splice(from, 1);
  state.queue.splice(to, 0, item);
  if (state.index === from) state.index = to;
  else if (from < state.index && to >= state.index) state.index -= 1;
  else if (from > state.index && to <= state.index) state.index += 1;
  emit('queue');
  emit('state');
}

export function shuffleQueue() {
  if (state.queue.length < 2) return;
  const current = state.queue[state.index];
  for (let i = state.queue.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [state.queue[i], state.queue[j]] = [state.queue[j], state.queue[i]];
  }
  state.index = Math.max(0, state.queue.findIndex((t) => t.id === current?.id));
  emit('queue');
  emit('state');
}

export function clearQueue() {
  const current = state.current;
  commitHistory();
  stopSimulation();
  stopReal();
  state.queue = current ? [current] : [];
  state.index = current ? 0 : -1;
  state.playing = false;
  state.loading = false;
  state.time = 0;
  state.context = null;
  emit('queue');
  emit('state');
}

export function stop() {
  pause();
  seek(0);
}

/** Закрыть музыку: остановить звук и очистить текущий трек с очередью. */
export function closeTrack() {
  commitHistory();
  stopSimulation();
  stopReal();
  state.queue = [];
  state.index = -1;
  state.current = null;
  state.playing = false;
  state.loading = false;
  state.time = 0;
  state.duration = 0;
  state.context = null;
  emit('queue');
  emit('state');
}

export function getState() {
  return snapshot();
}

export function currentTrack() {
  return state.current;
}

/**
 * Обратная связь по треку: сервер узнаёт о лайке/дизлайке/скипе из волны.
 * @param {'like'|'dislike'|'skip'} type
 * @param {object} track
 */
export function sendWaveFeedback(type, track) {
  if (!track) return;
  if (type === 'skip') {
    waveFeedback({
      type: 'skip',
      trackId: track.id,
      batchId: state.context?.batchId || null,
      position: state.index,
    });
  } else {
    waveFeedback({
      type,
      trackId: track.id,
      batchId: state.context?.batchId || null,
      position: state.index,
    });
  }
}

/* ------------------------------------------------------------------ */
/* Реальные события <audio>                                            */
/* ------------------------------------------------------------------ */

/** Подписать события на элемент (основной и второй для кроссфейда). */
function wireElement(el, isAlt) {
  // события второго элемента актуальны только когда он звучит
  const relevant = () => !isAlt || activeChain === 'alt';

  el.addEventListener('loadedmetadata', () => {
    if (!relevant()) return;
    if (Number.isFinite(el.duration) && el.duration > 0) {
      state.duration = el.duration;
      emit('time');
    }
  });

  el.addEventListener('timeupdate', () => {
    if (state.simulated || !relevant()) return;
    state.time = el.currentTime || 0;
    emit('time');
    // за N секунд до конца — плавно переходим на следующий трек
    maybeCrossfade();
  });

  el.addEventListener('play', () => {
    if (state.simulated || !relevant()) return;
    state.playing = true;
    state.loading = false;
    emit('state');
  });

  el.addEventListener('pause', () => {
    if (state.simulated || !relevant()) return;
    // пауза от кроссфейда не должна останавливать интерфейс
    if (state.loading) return;
    state.playing = false;
    emit('state');
  });

  el.addEventListener('waiting', () => {
    if (state.simulated || !relevant()) return;
    state.loading = true;
    emit('state');
  });

  el.addEventListener('playing', () => {
    if (state.simulated || !relevant()) return;
    state.loading = false;
    state.playing = true;
    state.error = null;
    emit('state');
  });

  el.addEventListener('playing', () => {
    if (!relevant()) return;
    clearStallWatchdog();
    state.loading = false;
  });

  el.addEventListener('ended', () => {
    if (!relevant()) return;
    clearStallWatchdog();
    if (state.simulated) return;
    handleEnded();
  });

  el.addEventListener('error', () => {
    if (!relevant()) return;
    clearStallWatchdog();
    if (state.simulated || !el.src) return;
    state.loading = false;
    state.playing = false;
    state.error = 'Не удалось получить поток. Проверьте подключение источника.';
    emit('error');
    emit('state');
  });
}

wireElement(audio, false);
if (altAudio) wireElement(altAudio, true);

/**
 * Плавный переход ровно за crossfadeSec до конца трека — как в Spotify:
 * текущий трек уходит, следующий уже звучит.
 */
function maybeCrossfade() {
  if (!crossfadeReady() || !theme.crossfadeFull) return;
  if (!state.playing || state.repeat === 'one') return;
  if (!state.duration || state.duration < 12) return;

  const seconds = Math.max(1, Math.min(12, Number(theme.crossfadeSec) || 4));
  const remaining = state.duration - state.currentTime;
  if (remaining > seconds) return;
  if (remaining <= 0) return;

  // не запускаем переход дважды для одного трека
  const key = `${state.current?.id}:${state.index}`;
  if (crossfadeArmedFor === key) return;
  crossfadeArmedFor = key;

  const idx = nextIndex(true);
  if (idx === -1 || idx === state.index) return;

  startCrossfade();
  state.lastFade = { from: state.index, at: Date.now() };
  state.index = idx;
  playCurrent();
  emit('queue');
}
/* Сторож загрузки: поток может «зависнуть» (сервер отдал 409, сеть оборвалась) —
   элемент при этом не присылает error, и плеер выглядит застывшим. */
let stallWatchdog = 0;

function armStallWatchdog() {
  clearTimeout(stallWatchdog);
  stallWatchdog = setTimeout(() => {
    if (!state.loading) return;
    state.loading = false;
    state.playing = false;
    state.error = 'Трек не загрузился. Пробуем следующий.';
    emit('error');
    emit('state');
    // пропускаем зависший трек, чтобы очередь не стояла
    if (state.queue.length > 1) next();
  }, 20000);
}

function clearStallWatchdog() {
  clearTimeout(stallWatchdog);
  stallWatchdog = 0;
}

/* ------------------------------------------------------------------ */
/* Инициализация                                                       */
/* ------------------------------------------------------------------ */

audio.volume = state.volume;
audio.muted = state.muted;
initMediaSessionHandlers();

/* ------------------------ плавные переходы и прогрев ----------------------- */
/**
 * Плавное появление звука в начале трека.
 *
 * Spotify и Яндекс.Музыка стартуют трек с короткого нарастания, а не с
 * резкого удара. Делаем то же через выходной узел эквалайзера: громкость
 * пользователя не затрагивается.
 */
const FADE_IN_MS = 220;
const FADE_OUT_MS = 320;

/** Включены ли плавные переходы (настройка оформления). */
const crossfadeOn = () => theme.crossfade !== false;

/** Таймер страховки громкости: плеер не должен оставаться немым. */
let gainSafety = 0;

function fadeIn() {
  if (!crossfadeOn()) {
    safeGain(1);
    return;
  }
  if (bypassGraph || !audioCtx || !outNode) return;
  // контекст ещё не запущен: расписание начнёт действовать только после
  // resume, а до этого громкость осталась бы нулевой — звука вообще не будет
  if (audioCtx.state !== 'running') {
    safeGain(1);
    return;
  }
  try {
    const now = audioCtx.currentTime;
    outNode.gain.cancelScheduledValues(now);
    outNode.gain.setValueAtTime(0, now);
    outNode.gain.linearRampToValueAtTime(1, now + FADE_IN_MS / 1000);
    // страховка: через 1,5 с гарантированно возвращаем полную громкость
    clearTimeout(gainSafety);
    gainSafety = setTimeout(() => safeGain(1), 1500);
  } catch { safeGain(1); }
}

/** Принудительно полная громкость — страховка от «немого» плеера. */
function safeGain(value) {
  if (bypassGraph || !audioCtx || !outNode) return;
  try {
    const now = audioCtx.currentTime;
    outNode.gain.cancelScheduledValues(now);
    outNode.gain.setValueAtTime(value, now);
  } catch { /* ignore */ }
}

/** Плавное затухание перед сменой трека. */
function fadeOut() {
  if (!crossfadeOn()) return;
  if (bypassGraph || !audioCtx || !outNode) return;
  if (audioCtx.state !== 'running') return;
  try {
    const now = audioCtx.currentTime;
    outNode.gain.cancelScheduledValues(now);
    outNode.gain.setValueAtTime(outNode.gain.value, now);
    outNode.gain.linearRampToValueAtTime(0, now + FADE_OUT_MS / 1000);
  } catch { /* ignore */ }
}

/** Элемент для прогрева следующего трека. */
let warmAudio = null;
let warmUrl = '';

/**
 * Предзагрузка следующего трека.
 *
 * Основной аудиоэлемент нельзя наполнить заранее, поэтому тянем поток
 * отдельным объектом: сервер успевает собрать и закешировать результат
 * (HLS, конвертация в MP3), и переход происходит без паузы.
 */
export function preloadTrack(track) {
  if (!track || !track.id || !isOnline()) return;
  const url = streamUrl(track);
  if (!url || url === warmUrl) return;
  warmUrl = url;
  try {
    if (!warmAudio) {
      warmAudio = new Audio();
      warmAudio.preload = 'auto';
      warmAudio.crossOrigin = 'anonymous';
    }
    warmAudio.src = url;
    warmAudio.load();
  } catch { /* прогрев не критичен */ }
}

/** Сбросить прогрев. */
export function clearPreload() {
  warmUrl = '';
  if (warmAudio) {
    try { warmAudio.removeAttribute('src'); warmAudio.load(); } catch { /* ignore */ }
  }
}

/**
 * Анализатор спектра для визуализатора «под бит».
 * null, если граф отключён (демо-режим или аудио недоступно).
 */
export function getAnalyser() {
  if (bypassGraph || !audioCtx || !analyserNode) return null;
  return analyserNode;
}

export const player = {
  preloadTrack,
  clearPreload,
  playTracks,
  playAt,
  playTrack,
  enqueue,
  play,
  pause,
  toggle,
  next,
  prev,
  seek,
  seekBy,
  setVolume,
  toggleMute,
  setShuffle,
  toggleShuffle,
  cycleRepeat,
  removeQueueItem,
  moveQueueItem,
  shuffleQueue,
  clearQueue,
  stop,
  closeTrack,
  getState,
  currentTrack,
  sendWaveFeedback,
  subscribe,
};

export default player;
