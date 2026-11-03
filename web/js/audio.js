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
    // Позиция и текущий трек: после обновления приложения плеер
    // продолжал с нуля, и счётчик времени сбивался.
    track: state.current ? {
      id: state.current.id,
      source: state.current.source,
      sourceId: state.current.sourceId,
      title: state.current.title,
      artists: state.current.artists,
      cover: state.current.cover,
      duration: state.current.duration,
      artistId: state.current.artistId || null,
      artistList: state.current.artistList || [],
    } : null,
    time: Number(state.time) || 0,
    savedAt: Date.now(),
  });
}

/* ------------------------------------------------------------------ */
/* Web Audio: эквалайзер                                               */
/* ------------------------------------------------------------------ */

let audioCtx = null;
let sourceNode = null;
let preampNode = null;
let outNode = null;
let eqNodes = [];
/** Узлы расширенной обработки (Spide: Audio Lab). */
let bassNode = null;
let stereoNode = null;
/** Узлы ширины стерео: расщепитель каналов, мержер и гейны L/R. */
let stereoMerge = null;
let widthGainL = null;
let widthGainR = null;
let normalizeNode = null;
let warmthNode = null;
let depthNode = null;
let reverbNode = null;
let reverbGain = null;
/** Анализатор спектра: питает визуализатор «под бит». */
let analyserNode = null;
// если Web Audio не смог отдать звук — играем напрямую, без эквалайзера
let bypassGraph = false;

/** Таймер плавного затухания к концу трека. */
let endFadeTimer = 0;

const dbToGain = (db) => (db === 0 ? 1 : 10 ** (db / 20));

function ensureGraph() {
  if (bypassGraph) return false;
  if (audioCtx) return true;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return false;
  try {
    audioCtx = new Ctx();
    sourceNode = audioCtx.createMediaElementSource(audio);
    preampNode = audioCtx.createGain();
    eqNodes = EQ_HZ.map((freq) => {
      const node = audioCtx.createBiquadFilter();
      node.type = 'peaking';
      node.frequency.value = freq;
      node.Q.value = 1.3;
      node.gain.value = 0;
      return node;
    });

    // Усиление баса — отдельная полка на низких частотах, как в Spide:
    // поднимает «тело» трека, не трогая середину.
    bassNode = audioCtx.createBiquadFilter();
    bassNode.type = 'lowshelf';
    bassNode.frequency.value = 120;
    bassNode.gain.value = 0;

    // Ширина стерео: раскидываем каналы через расщепитель и обратный
    // инверсивный сигнал — так расширяется стерео-поле, а не просто баланс.
    stereoNode = audioCtx.createChannelSplitter(2);
    stereoMerge = audioCtx.createChannelMerger(2);
    widthGainL = audioCtx.createGain();
    widthGainR = audioCtx.createGain();
    widthGainL.gain.value = 1;
    widthGainR.gain.value = 1;

    // Нормализация громкости: выравнивает тихие и громкие треки.
    normalizeNode = audioCtx.createDynamicsCompressor();
    normalizeNode.threshold.value = -24;
    normalizeNode.knee.value = 30;
    normalizeNode.ratio.value = 3;
    normalizeNode.attack.value = 0.01;
    normalizeNode.release.value = 0.25;

    // Теплота: мягкое поднятие низа и снижение верха.
    warmthNode = audioCtx.createBiquadFilter();
    warmthNode.type = 'highshelf';
    warmthNode.frequency.value = 6000;
    warmthNode.gain.value = 0;

    // Глубина: дополнительная полка на самых низах.
    depthNode = audioCtx.createBiquadFilter();
    depthNode.type = 'peaking';
    depthNode.frequency.value = 60;
    depthNode.Q.value = 0.9;
    depthNode.gain.value = 0;

    // Реверберация: короткий хвост, чтобы звук не был «сухим».
    reverbNode = audioCtx.createConvolver();
    reverbNode.buffer = buildReverbImpulse(audioCtx, 1.6);
    reverbGain = audioCtx.createGain();
    reverbGain.gain.value = 0;

    outNode = audioCtx.createGain();

    // Цепочка: преамп → бас → 10 полос → теплота → глубина → ширина стерео →
    // нормализация → выход (+ параллельный реверб).
    sourceNode.connect(preampNode);
    preampNode.connect(bassNode);

    let tail = bassNode;
    for (const node of eqNodes) {
      tail.connect(node);
      tail = node;
    }
    tail.connect(warmthNode);
    warmthNode.connect(depthNode);

    // Ширина стерео: левый и правый каналы идут в общий мержер через
    // собственные гейны. width=100 % — как есть, >100 — расширение,
    // <100 — сужение к моно.
    depthNode.connect(stereoNode);
    stereoNode.connect(widthGainL, 0);
    stereoNode.connect(widthGainR, 1);
    widthGainL.connect(stereoMerge, 0, 0);
    widthGainR.connect(stereoMerge, 0, 1);
    stereoMerge.connect(normalizeNode);

    normalizeNode.connect(outNode);

    // параллельная ветка реверберации
    normalizeNode.connect(reverbNode);
    reverbNode.connect(reverbGain);
    reverbGain.connect(outNode);

    outNode.connect(audioCtx.destination);

    // анализатор спектра для визуализатора «под бит»: подключаем параллельно,
    // на звук не влияет (он только читает данные)
    try {
      analyserNode = audioCtx.createAnalyser();
      analyserNode.fftSize = 256;
      analyserNode.smoothingTimeConstant = 0.72;
      outNode.connect(analyserNode);
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

/**
 * Короткий импульс для реверберации: затухающий шум.
 * Строится один раз при создании графа.
 */
function buildReverbImpulse(ctx, seconds) {
  const rate = ctx.sampleRate;
  const length = Math.floor(rate * seconds);
  const impulse = ctx.createBuffer(2, length, rate);
  for (let channel = 0; channel < 2; channel += 1) {
    const data = impulse.getChannelData(channel);
    for (let i = 0; i < length; i += 1) {
      // экспоненциальное затухание, чтобы хвост был коротким и естественным
      data[i] = (Math.random() * 2 - 1) * (1 - i / length) ** 2.6;
    }
  }
  return impulse;
}

function applyEq() {
  if (!preampNode || !eqNodes.length) return;
  preampNode.gain.value = theme.eq.on ? dbToGain(theme.eq.preamp) : 1;
  eqNodes.forEach((node, i) => {
    node.gain.value = theme.eq.on ? Number(theme.eq.bands[i] || 0) : 0;
  });

  // расширенная обработка (Spide: Audio Lab)
  const on = theme.eq.on;
  const lab = theme.lab || {};
  if (bassNode) bassNode.gain.value = on ? Number(lab.bass || 0) : 0;
  if (warmthNode) warmthNode.gain.value = on ? -Number(lab.warmth || 0) * 1.5 : 0;
  if (depthNode) depthNode.gain.value = on ? Number(lab.depth || 0) : 0;
  // Ширина стерео: 100 % — исходное поле. Больше — каналы расходятся
  // (разность громкая), меньше — стягиваются к моно.
  const width = clamp(Number(lab.width ?? 100) / 100, 0, 2);
  if (widthGainL && widthGainR) {
    widthGainL.gain.value = clamp(1 + (width - 1) * 0.8, 0, 2);
    widthGainR.gain.value = clamp(1 - (width - 1) * 0.2, 0, 2);
  }
  if (reverbGain) reverbGain.gain.value = on ? clamp(Number(lab.reverb || 0) / 200, 0, 0.35) : 0;

  // нормализация громкости: включается отдельно, чтобы не «жевать» динамику
  if (normalizeNode) {
    normalizeNode.ratio.value = theme.normalize ? 3 : 1;
    normalizeNode.threshold.value = theme.normalize ? -24 : 0;
  }
}

function resumeCtx() {
  if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
}

onThemeChange(() => {
  applyEq();
  applySoundMode();
});

/**
 * Готовые звуковые режимы (идея из Spide): Studio, Lo-Fi, Nightcore,
 * Slowed, Vaporwave. Каждый — набор полос эквалайзера, скорости и
 * дополнительной обработки; применяется к текущему треку сразу.
 */
const SOUND_MODES = {
  studio: {
    label: 'Студия',
    bands: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    lab: { bass: 0, warmth: 0, depth: 0, reverb: 0, speed: 100, pitch: 0 },
  },
  lofi: {
    label: 'Lo-Fi',
    // мягкие верха, тёплая середина, немного реверба
    bands: [2, 3, 2, 0, -1, -3, -5, -7, -8, -9],
    lab: { bass: 3, warmth: 4, depth: 2, reverb: 22, speed: 96, pitch: 0 },
  },
  nightcore: {
    label: 'Nightcore',
    // быстрее и выше, подчёркнутые верха
    bands: [-2, -1, 0, 1, 2, 3, 4, 5, 5, 4],
    lab: { bass: 0, warmth: 0, depth: 0, reverb: 0, speed: 125, pitch: 3 },
  },
  slowed: {
    label: 'Slowed',
    // медленнее и ниже, больше низа и хвоста
    bands: [4, 5, 4, 2, 0, -1, -2, -3, -3, -2],
    lab: { bass: 5, warmth: 2, depth: 4, reverb: 15, speed: 85, pitch: -2 },
  },
  vaporwave: {
    label: 'Vaporwave',
    bands: [3, 4, 3, 0, -2, -4, -5, -6, -6, -5],
    lab: { bass: 4, warmth: 5, depth: 3, reverb: 34, speed: 80, pitch: -3 },
  },
};

/** Применить выбранный режим к графу и плееру. */
function applySoundMode() {
  const mode = SOUND_MODES[theme.soundMode] || SOUND_MODES.studio;

  // Скорость воспроизведения (rate) — элемент, а не узел графа.
  try {
    const rate = clamp((Number(theme.lab?.speed) || 100) / 100, 0.5, 1.5);
    if (audio.playbackRate !== rate) audio.playbackRate = rate;
  } catch { /* ignore */ }

  // Высота тона: доступна там, где браузер поддерживает preservesPitch.
  try {
    const semitones = Number(theme.lab?.pitch) || 0;
    if ('preservesPitch' in audio) audio.preservesPitch = semitones === 0;
  } catch { /* ignore */ }

  // Полосы эквалайзера из режима применяются ТОЛЬКО при смене режима.
  // Раньше они перезаписывались при каждом вызове и затирали ручную
  // настройку пользователя: пресет «custom» и его полосы терялись.
  const modeAligns = theme.eq.preset !== 'custom';
  if (modeAligns && theme.soundMode === 'studio') {
    eqNodes.forEach((node, i) => {
      node.gain.value = theme.eq.on ? Number(theme.eq.bands[i] || 0) : 0;
    });
  }
}

/** Список режимов для интерфейса. */
export function soundModes() {
  return Object.entries(SOUND_MODES).map(([id, mode]) => ({ id, label: mode.label }));
}

/** Применить режим звука по идентификатору. */
/**
 * Применить режим звука по идентификатору.
 *
 * Перед сменой режима запоминаем текущую ручную настройку полос и Audio Lab,
 * чтобы её можно было вернуть при выборе «Студии». Раньше режим затирал
 * эквалайзер безвозвратно — после Nightcore своя кривая терялась.
 */
export function setSoundMode(id) {
  if (!SOUND_MODES[id]) return;

  const previous = theme.soundMode;
  // Уходим с «Студии» — сохраняем то, что настроено руками.
  if (previous === 'studio' || !previous) {
    theme.savedEq = {
      bands: Array.isArray(theme.eq.bands) ? [...theme.eq.bands] : null,
      lab: { ...theme.lab },
      preset: theme.eq.preset || 'custom',
      preamp: theme.eq.preamp,
    };
  }

  theme.soundMode = id;
  const mode = SOUND_MODES[id];

  if (id === 'studio' && theme.savedEq?.bands) {
    // назад в студию — возвращаем прежнюю ручную кривую
    theme.eq.bands = [...theme.savedEq.bands];
    theme.lab = { ...theme.savedEq.lab };
    theme.eq.preset = theme.savedEq.preset || 'custom';
    theme.eq.preamp = theme.savedEq.preamp ?? theme.eq.preamp;
  } else {
    theme.eq.bands = [...mode.bands];
    theme.lab = { ...theme.lab, ...mode.lab };
    theme.eq.preset = id === 'studio' ? theme.eq.preset : 'custom';
  }

  applyEq();
  applySoundMode();
}

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
  try { audio.pause(); } catch { /* ignore */ }

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

  try {
    // элемент читает Web Audio: без crossOrigin поток считается кросс-доменным
    // и createMediaElementSource выдаёт тишину (эквалайзер «ломает» звук)
    if (audio.crossOrigin !== 'anonymous') audio.crossOrigin = 'anonymous';
    audio.src = url;
    audio.load();
  } catch {
    startSimulation();
    return;
  }

  // Интерфейс показывает «пауза» сразу: иначе кнопка ждёт загрузки
  // потока и кажется, что нажатие не сработало.
  state.playing = true;
  emit('state');
  armStallWatchdog();
  // планируем плавное затухание к концу трека
  armEndFade();
  // запускаем аудиоконтекст и только потом включаем плавное нарастание:
  // расписание громкости в приостановленном контексте не действует,
  // и плеер остался бы совершенно без звука
  ensureRunning(() => {
    fadeIn();
    const attempt = audio.play();
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
  if (!audio.src) { playCurrent(); return; }

  // Интерфейс переключаем СРАЗУ, не дожидаясь ответа браузера: audio.play()
  // возвращает промис, и до его завершения кнопка не реагировала —
  // отсюда «пауза срабатывает не сразу». Если браузер откажет,
  // состояние вернём обратно.
  state.playing = true;
  emit('state');

  audio.play().then(() => {
    if (!state.playing) { try { audio.pause(); } catch { /* ignore */ } }
  }).catch(() => {
    state.playing = false;
    emit('state');
    // сервер пропал — доигрываем демо-симуляцией, чтобы интерфейс не «залипал»
    startSimulation();
  });
}

export function pause() {
  clearEndFade();
  if (state.simulated) {
    state.playing = false;
    emit('state');
    return;
  }
  try { audio.pause(); } catch { /* ignore */ }
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
  if (!state.simulated && audio.src) {
    try { audio.currentTime = value; } catch { /* ignore */ }
    // после перемотки план затухания нужно пересчитать
    armEndFade();
  }
  emit('time');
}

export function seekBy(delta) {
  const total = state.duration || state.current?.duration || 0;
  seek(clamp(state.time + Number(delta || 0), 0, total));
}

export function setVolume(value) {
  const v = clamp(Number(value) || 0, 0, 1);
  state.volume = v;
  state.muted = v === 0 ? true : false;
  audio.volume = v;
  audio.muted = state.muted;
  persistUi();
  emit('state');
}

export function toggleMute() {
  state.muted = !state.muted;
  audio.muted = state.muted;
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

audio.addEventListener('loadedmetadata', () => {
  if (Number.isFinite(audio.duration) && audio.duration > 0) {
    state.duration = audio.duration;
    emit('time');
  }
});
audio.addEventListener('timeupdate', () => {
  if (state.simulated) return;
  state.time = audio.currentTime || 0;
  emit('time');
});

/*
 * Плавное время для текста.
 *
 * Событие timeupdate приходит всего 4 раза в секунду, а текст с послоговой
 * подсветкой должен двигаться без рывков. Здесь время берётся напрямую из
 * audio.currentTime каждый кадр — оно точнее и совпадает со звуком.
 * Отдельное событие 'tick', чтобы не перерисовывать весь плеер 60 раз в секунду.
 */
let clockFrame = 0;
function startClock() {
  if (clockFrame) return;
  const step = () => {
    if (!state.simulated && !audio.paused) {
      state.time = audio.currentTime || 0;
      emit('tick');
    }
    clockFrame = requestAnimationFrame(step);
  };
  clockFrame = requestAnimationFrame(step);
}
function stopClock() {
  if (clockFrame) cancelAnimationFrame(clockFrame);
  clockFrame = 0;
}
startClock();
audio.addEventListener('play', () => {
  if (state.simulated) return;
  state.playing = true;
  state.loading = false;
  emit('state');
});
audio.addEventListener('pause', () => {
  if (state.simulated) return;
  state.playing = false;
  emit('state');
});
audio.addEventListener('waiting', () => {
  if (state.simulated) return;
  state.loading = true;
  emit('state');
});
audio.addEventListener('playing', () => {
  if (state.simulated) return;
  state.loading = false;
  state.playing = true;
  state.error = null;
  emit('state');
});
audio.addEventListener('playing', () => {
  clearStallWatchdog();
  state.loading = false;
});

audio.addEventListener('ended', () => {
  clearStallWatchdog();
  if (state.simulated) return;
  handleEnded();
});
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

audio.addEventListener('error', () => {
  clearStallWatchdog();
  if (state.simulated || !audio.src) return;
  state.loading = false;
  state.playing = false;
  state.error = 'Не удалось получить поток. Проверьте подключение источника.';
  emit('error');
  emit('state');
});

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

/**
 * Плавное затухание в конце трека — без наложения двух треков.
 *
 * Это компромисс: звучит как плавный уход в тишину перед следующим треком.
 * Настоящий кроссфейд (два трека одновременно) требует второго плеера и
 * оказался нестабильным, поэтому оставлен только безопасный вариант.
 */
function armEndFade() {
  clearEndFade();
  if (!crossfadeOn()) return;
  if (bypassGraph || !audioCtx || !outNode) return;

  const seconds = Math.max(1, Math.min(12, Number(theme.crossfadeSec) || 4));
  // срабатываем чуть раньше конца, чтобы затухание успело пройти
  const trigger = () => {
    const duration = Number(audio.duration) || 0;
    if (!duration) return;
    const remaining = duration - audio.currentTime;
    if (remaining > seconds) {
      // ещё рано: проверим позже
      endFadeTimer = setTimeout(trigger, Math.max(200, (remaining - seconds) * 1000));
      return;
    }
    if (remaining > 0 && audio.currentTime > 1) fadeOut();
  };

  endFadeTimer = setTimeout(trigger, 250);
}

/** Снять запланированное затухание (смена трека вручную, пауза). */
function clearEndFade() {
  clearTimeout(endFadeTimer);
  endFadeTimer = 0;
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

export const player = {  preloadTrack,
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
