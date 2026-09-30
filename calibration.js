import { CFG, angleDiff } from './gestures.js';

const KEY = 'handtris-calibration';
const STEP_MS = 2000;
const MIN_TURN = 25;

const STEPS = [
  { id: 'open', title: 'Шаг 1 из 4 · Ладонь', icon: '🖐',
    text: 'Покажи камере открытую ладонь, пальцы вверх и врозь' },
  { id: 'pinch', title: 'Шаг 2 из 4 · Щипок', icon: '🤏',
    text: 'Сомкни большой и указательный пальцы, как будто берёшь кубик' },
  { id: 'right', title: 'Шаг 3 из 4 · Поворот вправо', icon: '↻',
    text: 'Поверни кисть вправо, как ключ в замке, насколько удобно' },
  { id: 'left', title: 'Шаг 4 из 4 · Поворот влево', icon: '↺',
    text: 'Теперь поверни кисть влево, насколько удобно' },
];

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const avg = (a) => a.reduce((s, v) => s + v, 0) / a.length;

function apply(d) {
  CFG.PINCH_ON = d.pinchOn;
  CFG.PINCH_OFF = d.pinchOff;
  CFG.HALF_PINCH_MAX = d.halfPinch;
  CFG.ROTATE_DEG = d.rotate;
  CFG.ROTATE_REARM_DEG = d.rearm;
  CFG.ROTATE_HINT_DEG = d.hint;
}

export function loadCalibration() {
  try {
    const d = JSON.parse(localStorage.getItem(KEY));
    if (d && typeof d.pinchOn === 'number' && typeof d.rotate === 'number') {
      apply(d);
      return d;
    }
  } catch {  }
  return null;
}

export class Calibration {
  constructor() {
    this.step = 0;
    this.held = 0;
    this.lastT = null;
    this.done = false;
    this.result = null;
    this.openRatios = [];
    this.openAngles = [];
    this.neutral = 0;
    this.closed = Infinity;
    this.turn = { right: 0, left: 0 };
  }

  get current() {
    return STEPS[Math.min(this.step, STEPS.length - 1)];
  }

  update(info, now) {
    if (this.done) return { progress: 1, hint: null };
    const dt = this.lastT === null ? 0 : Math.min(100, now - this.lastT);
    this.lastT = now;

    if (!info) {
      return {
        progress: this.held / STEP_MS,
        hint: 'Не вижу руку — подними ладонь перед камерой на уровень груди',
      };
    }

    let ok = false;
    let hint = null;
    const id = this.current.id;

    if (id === 'open') {
      ok = info.extended === 4 && info.pinchRatio > 0.6;
      if (ok) {
        this.openRatios.push(info.pinchRatio);
        this.openAngles.push(info.angle);
      } else if (info.extended < 4) {
        hint = `Выпрями все пальцы: сейчас ${info.extended} из 4`;
      } else {
        hint = 'Отведи большой палец от указательного';
      }
    } else if (id === 'pinch') {
      const r = info.pinchRatio;
      ok = r < 0.5;
      if (ok) this.closed = Math.min(this.closed, r);
      else if (r < 0.9) hint = `Сомкни плотнее: между пальцами ~${(r * CFG.PALM_CM).toFixed(1)} см`;
      else hint = 'Сведи большой и указательный пальцы вместе';
    } else {
      const sign = id === 'right' ? 1 : -1;
      const d = angleDiff(info.angle, this.neutral) * sign;
      ok = d >= MIN_TURN;
      if (ok) this.turn[id] = Math.max(this.turn[id], d);
      else if (d < -10) hint = `Это ${sign > 0 ? 'влево' : 'вправо'} — поверни в другую сторону`;
      else hint = `Поверни дальше: сейчас ${Math.max(0, Math.round(d))}°, нужно хотя бы ${MIN_TURN}°`;
    }

    if (ok) this.held += dt;
    const progress = Math.min(1, this.held / STEP_MS);
    if (progress >= 1) this.next();
    return { progress, hint };
  }

  next() {
    if (this.step === 0) this.neutral = this.openAngles.length ? avg(this.openAngles) : 0;
    this.step++;
    this.held = 0;
    if (this.step >= STEPS.length) this.finish();
  }

  finish() {
    const open = this.openRatios.length ? avg(this.openRatios) : 1;
    const closed = Number.isFinite(this.closed) ? this.closed : 0.2;

    const pinchOn = clamp(closed + (open - closed) * 0.25, 0.2, 0.5);
    const pinchOff = clamp(pinchOn + 0.2, pinchOn + 0.1, 0.8);
    const halfPinch = Math.max(pinchOff + 0.1, pinchOn + 0.35);

    const right = Math.round(this.turn.right);
    const left = Math.round(this.turn.left);
    const rotate = clamp(Math.round(Math.min(right, left) * 0.6), 30, 50);

    const data = {
      pinchOn, pinchOff, halfPinch,
      rotate,
      rearm: Math.round(rotate * 0.45),
      hint: Math.round(rotate * 0.5),
      closedCm: (closed * CFG.PALM_CM).toFixed(1),
      pinchOnCm: (pinchOn * CFG.PALM_CM).toFixed(1),
      right, left,
    };

    apply(data);
    try { localStorage.setItem(KEY, JSON.stringify(data)); } catch {  }
    this.result = data;
    this.done = true;
  }
}
