/**
 * Ритмичный визуализатор «под бит».
 *
 * Раньше полоски дёргались по CSS-анимации с фиксированной скоростью —
 * они не попадали в ритм музыки. Теперь берём настоящий спектр из Web Audio
 * (AnalyserNode) и двигаем столбики по низам, середине и верхам:
 * на «бочке» столбики прыгают, на тихом месте опускаются.
 *
 * Если анализатор недоступен (граф отключён, демо-режим), остаётся
 * плавная CSS-анимация — она выглядит мягче и не притворяется ритмом.
 */

export class BeatVisualizer {
  /**
   * @param {HTMLElement} root — контейнер со столбиками
   * @param {{bands?: number}} [opts]
   */
  constructor(root, { bands = 4 } = {}) {
    this.root = root;
    this.bars = [...root.querySelectorAll('i')];
    this.bands = Math.max(this.bars.length, bands);
    this.frame = 0;
    this.levels = new Array(this.bars.length).fill(0);
    this.smooth = new Array(this.bars.length).fill(0);
    this.running = false;
    this.loop = this.loop.bind(this);
  }

  /** Подключить анализатор из аудиографа плеера. */
  attach(analyser) {
    this.analyser = analyser || null;
    if (this.analyser) {
      this.data = new Uint8Array(this.analyser.frequencyBinCount);
      this.root.classList.add('is-live');
    } else {
      this.root.classList.remove('is-live');
    }
    this.start();
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.frame = requestAnimationFrame(this.loop);
  }

  stop() {
    this.running = false;
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = 0;
  }

  loop() {
    if (!this.running) return;

    if (this.analyser && this.data) {
      this.analyser.getByteFrequencyData(this.data);
      const count = this.bars.length;
      const bins = this.data.length;

      for (let i = 0; i < count; i += 1) {
        // Распределяем частоты по столбикам: слева низа, справа верха.
        // Кривая 1.6 растягивала низ — на музыке верх почти не двигался.
        const from = Math.floor((i / count) ** 1.25 * bins);
        const to = Math.max(from + 1, Math.floor(((i + 1) / count) ** 1.25 * bins));

        let peak = 0;
        for (let j = from; j < to; j += 1) if (this.data[j] > peak) peak = this.data[j];
        const raw = peak / 255;

        // Падение медленнее подъёма, но заметно быстрее прежнего: столбики
        // успевают отыгрывать удар, а не тянутся плавной волной.
        const prev = this.smooth[i] || 0;
        this.smooth[i] = raw > prev ? raw : prev * 0.55 + raw * 0.45;

        // Нижние полосы усиливаем сильнее — они дают ощущение бита
        const boost = 1.35 - (i / count) * 0.35;
        const height = Math.max(0.12, Math.min(1, this.smooth[i] * boost * 1.9));
        this.bars[i].style.setProperty('--lvl', height.toFixed(3));
      }
    }

    this.frame = requestAnimationFrame(this.loop);
  }
}

/** Глобальный визуализатор для строки текущего трека. */
let active = null;

/** Подключить визуализатор к контейнеру. */
export function bindVisualizer(root, analyser) {
  if (active) active.stop();
  active = new BeatVisualizer(root);
  active.attach(analyser);
  return active;
}

/** Отключить визуализатор (при смене экрана). */
export function releaseVisualizer() {
  if (active) active.stop();
  active = null;
}
