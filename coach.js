import { CFG } from './gestures.js';

export const CATEGORY = {
  noHand: 'Рука не в кадре',
  distance: 'Неудобное расстояние до камеры',
  edge: 'Рука у края кадра',
  pinch: 'Неполный щипок',
  rotate: 'Слабый поворот кисти',
  rearm: 'Кисть не вернули прямо',
  blocked: 'Фигура упёрлась в блоки',
  autoDrop: 'Фигура упала сама',
  holes: 'Дыры под фигурой',
  lost: 'Рука пропала с фигурой',
  victory: 'Неточный знак ✌️',
};

const EDGE_TEXT = {
  left: 'Рука у левого края кадра — сдвинь её к центру, иначе камера её потеряет',
  right: 'Рука у правого края кадра — сдвинь её к центру, иначе камера её потеряет',
  top: 'Рука у верхнего края кадра — опусти её до уровня груди',
  bottom: 'Рука у нижнего края кадра — подними её до уровня груди',
};

export class Coach {
  constructor() {
    this.reset();
  }

  reset() {
    this.current = null;
    this.counts = {};
    this.timers = {};
    this.lastShown = {};
  }

  held(id, active, now, holdMs) {
    if (!active) {
      delete this.timers[id];
      return false;
    }
    if (this.timers[id] === undefined) this.timers[id] = now;
    return now - this.timers[id] >= holdMs;
  }

  say(id, text, now, kind = 'warn', showMs = 2600) {
    const cooldown = kind === 'warn' ? 3500 : 0;
    const sameAsNow = this.current && this.current.id === id && now < this.current.until;
    if (sameAsNow) {
      this.current.text = text;
      this.current.until = now + showMs;
      return;
    }
    if (this.lastShown[id] && now - this.lastShown[id] < cooldown) return;

    if (kind !== 'warn' && this.current?.kind === 'warn' && now < this.current.until) return;
    this.lastShown[id] = now;
    if (kind === 'warn') this.counts[id] = (this.counts[id] || 0) + 1;
    this.current = { id, text, kind, until: now + showMs };
  }

  announce(id, text, now, kind = 'good', showMs = 2200) {
    this.current = { id, text, kind, until: now + showMs };
  }

  checkFrame({ info, helper, ctrl, blocked, canAnti }, now) {
    if (this.held('noHand', !info, now, 900)) {
      this.say('noHand', 'Не вижу руку — подними ладонь перед камерой на уровень груди', now);
      return;
    }
    if (!info) return;

    if (this.held('far', info.size < CFG.TOO_FAR, now, 700)) {
      const cm = Math.round((CFG.TOO_FAR / info.size - 1) * 60 + 30);
      this.say('distance', `Рука слишком далеко — подойди к камере примерно на ${cm} см`, now);
    } else if (this.held('close', info.size > CFG.TOO_CLOSE, now, 700)) {
      this.say('distance', 'Рука слишком близко — отодвинь её, чтобы все пальцы были в кадре', now);
    }

    if (this.held('edge', !!info.edge, now, 400)) {
      this.say('edge', EDGE_TEXT[info.edge], now);
    }

    const halfPinch =
      !ctrl.grabbed && info.pinchRatio >= CFG.PINCH_ON && info.pinchRatio < CFG.HALF_PINCH_MAX;
    if (this.held('pinch', halfPinch, now, 450)) {
      const gapCm = (info.pinchRatio * CFG.PALM_CM).toFixed(1);
      const needCm = (CFG.PINCH_ON * CFG.PALM_CM).toFixed(1);
      this.say(
        'pinch',
        `Щипок не сработал: между пальцами ~${gapCm} см. Сомкни большой и указательный плотнее (меньше ${needCm} см)`,
        now
      );
    }

    const vHint = (helper && helper.victoryHint) || (!ctrl.grabbed && info.victoryHint) || null;
    if (this.held('victory', canAnti && !!vHint, now, 900)) {
      this.say(
        'victory',
        vHint === 'middle'
          ? 'Для антигравитации выпрями ещё и средний палец — нужен знак ✌️'
          : vHint === 'thumb'
            ? 'Почти знак мира: прижми большим пальцем безымянный и мизинец'
            : vHint === 'spread'
              ? 'Почти знак мира: разведи указательный и средний буквой V'
              : 'Для антигравитации прижми безымянный палец и мизинец — оставь только два пальца ✌️',
        now
      );
    }

    if (ctrl.grabbed && !helper) {
      const d = Math.abs(ctrl.rotationDelta);
      const weak = ctrl.rotateArmed && d >= CFG.ROTATE_HINT_DEG && d < CFG.ROTATE_DEG;
      if (this.held('rotate', weak, now, 500)) {
        this.say(
          'rotate',
          `Поверни кисть сильнее: сейчас ${Math.round(d)}°, нужно ${CFG.ROTATE_DEG}°`,
          now
        );
      }
      if (this.held('rearm', !ctrl.rotateArmed, now, 1600)) {
        this.say('rearm', 'Фигура уже повернулась — верни кисть прямо, чтобы повернуть ещё раз', now);
      }
    } else {
      this.held('rotate', false, now);
      this.held('rearm', false, now);
    }
    if (this.held('blocked', ctrl.grabbed && blocked, now, 500)) {
      this.say(
        'blocked',
        'Фигура упирается в блоки или стену — поверни её или веди в другой столбец',
        now
      );
    }
  }

  checkLock({ cleared, holesAdded, wasGrabbed }, now) {
    if (cleared > 0) {
      const words = ['', 'Линия', 'Две линии', 'Три линии', 'ТЕТРИС'];
      this.say('good', `${words[cleared]}! Отличная укладка`, now, 'good', 1600);
      return;
    }
    if (!wasGrabbed) {
      this.say('autoDrop', 'Фигура упала сама — возьми её щипком сразу, как она появится', now);
      return;
    }
    if (holesAdded > 0) {
      this.say(
        'holes',
        `Под фигурой осталось пустых клеток: ${holesAdded}. Поверни её перед тем, как отпустить, чтобы легла плоской стороной вниз`,
        now
      );
    }
  }

  onPinchFail(min, now) {
    this.say(
      'pinch',
      `Щипок не засчитан: пальцы сошлись только до ~${(min * CFG.PALM_CM).toFixed(1)} см, нужно меньше ${(CFG.PINCH_ON * CFG.PALM_CM).toFixed(1)} см`,
      now
    );
  }

  onRotateFail(peak, now) {
    this.say(
      'rotate',
      `Поворот не засчитан: ты повернул кисть на ${Math.round(peak)}°, нужно ${CFG.ROTATE_DEG}°. Поворачивай увереннее`,
      now
    );
  }

  onLost(now) {
    this.say('lost', 'Рука ушла из кадра вместе с фигурой — держи руку в центре, пока ведёшь фигуру', now);
  }

  hint(now) {
    return this.current && now < this.current.until ? this.current : null;
  }

  summary() {
    const entries = Object.entries(this.counts)
      .filter(([id]) => CATEGORY[id])
      .sort((a, b) => b[1] - a[1]);
    const total = entries.reduce((s, [, n]) => s + n, 0);
    return {
      total,
      top: entries.slice(0, 3).map(([id, n]) => ({ label: CATEGORY[id], n, id })),
    };
  }
}

export const ADVICE = {
  noHand: 'Держи руку на уровне груди, в центре кадра.',
  distance: 'Встань так, чтобы ладонь занимала примерно пятую часть высоты кадра.',
  edge: 'Поле растянуто почти на весь кадр — не уводи руку к самому краю, камера её теряет.',
  pinch: 'Касайся подушечками большого и указательного пальца до конца.',
  rotate: 'Возьми фигуру щипком двумя руками и поверни их, как руль — это проще, чем кистью.',
  rearm: 'После поворота сразу возвращай кисть в прямое положение.',
  blocked: 'Сначала поверни фигуру наверху, потом веди к месту.',
  autoDrop: 'Хватай фигуру сразу, пока она наверху.',
  holes: 'Перед тем как отпустить, смотри на полупрозрачную тень внизу.',
  lost: 'Держи обе руки в кадре, пока ведёшь фигуру.',
  victory: 'Держи фигуру одной рукой, а другой показывай знак мира ✌️: указательный и средний прямо, остальные прижми.',
};
