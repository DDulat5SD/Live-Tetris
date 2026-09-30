export const CFG = {
  PINCH_ON: 0.35,
  PINCH_OFF: 0.55,
  HALF_PINCH_MAX: 0.75,
  ROTATE_DEG: 45,
  ROTATE_REARM_DEG: 20,
  ROTATE_HINT_DEG: 22,
  TOO_FAR: 0.09,
  TOO_CLOSE: 0.42,
  EDGE: 0.07,
  PALM_HOLD_MS: 1200,
  VICTORY_HOLD_MS: 700,
  FIST_HOLD_MS: 900,
  WHEEL_DEG: 40,
  CROSS_HOLD_MS: 1000,
  COL_RANGE: [0.28, 0.72],
  EDGE_SNAP: 0.07,
  COL_HYST: 0.65,
  ROW_RANGE: [0.25, 0.75],
  PALM_CM: 9.5,
};

const dist = (a, b, aspect) => Math.hypot((a.x - b.x) * aspect, a.y - b.y);

const FINGERS = [[8, 6], [12, 10], [16, 14], [20, 18]];

export function analyzeHand(lm, aspect = 4 / 3) {
  const wrist = lm[0], midBase = lm[9];
  const size = dist(wrist, midBase, 1);
  const pinchRatio = dist(lm[4], lm[8], aspect) / Math.max(size, 1e-6);

  const dx = -(midBase.x - wrist.x) * aspect;
  const dy = midBase.y - wrist.y;
  const angle = (Math.atan2(dx, -dy) * 180) / Math.PI;

  const ext = FINGERS.map(([tip, pip]) => dist(lm[tip], wrist, aspect) > dist(lm[pip], wrist, aspect) * 1.12);
  const fold = FINGERS.map(([tip, pip]) => dist(lm[tip], wrist, aspect) < dist(lm[pip], wrist, aspect));
  const extended = ext.filter(Boolean).length;
  const palmOpen = extended === 4 && pinchRatio > 0.6;

  const fist = fold.every(Boolean) && dist(lm[8], wrist, aspect) < dist(lm[5], wrist, aspect);

  const straight = (tip, pip) => dist(lm[tip], wrist, aspect) > dist(lm[pip], wrist, aspect) * 1.2;
  const earsUp = straight(8, 6) && straight(12, 10);
  const spread = dist(lm[8], lm[12], aspect) / Math.max(size, 1e-6) > 0.3;
  const thumbIn = dist(lm[4], lm[13], aspect) / Math.max(size, 1e-6) < 0.8;
  const victory = earsUp && spread && fold[2] && fold[3] && thumbIn && pinchRatio > 0.6;

  let victoryHint = null;
  if (!victory && ext[0] && pinchRatio > 0.6) {
    if (!ext[1] && fold[2] && fold[3]) victoryHint = 'middle';
    else if (ext[1] && (!fold[2] || !fold[3]) && extended < 4) victoryHint = 'ring';
    else if (earsUp && fold[2] && fold[3] && !thumbIn) victoryHint = 'thumb';
    else if (earsUp && fold[2] && fold[3] && !spread) victoryHint = 'spread';
  }

  const cx = 1 - (lm[4].x + lm[8].x) / 2;
  const cy = (lm[4].y + lm[8].y) / 2;
  const allX = lm.map((p) => 1 - p.x), allY = lm.map((p) => p.y);

  let edge = null;
  if (Math.min(...allX) < CFG.EDGE) edge = 'left';
  else if (Math.max(...allX) > 1 - CFG.EDGE) edge = 'right';
  else if (Math.min(...allY) < CFG.EDGE) edge = 'top';
  else if (Math.max(...allY) > 1 - CFG.EDGE) edge = 'bottom';

  return { x: cx, y: cy, wx: 1 - wrist.x, ext, size, pinchRatio, angle, palmOpen, fist, extended, victory, victoryHint, edge };
}

const clamp01 = (v) => Math.min(1, Math.max(0, v));

export function handToBoardT(x) {
  const [a, b] = CFG.COL_RANGE;
  return clamp01((x - a) / (b - a));
}

export function handToBoardY(y) {
  const [a, b] = CFG.ROW_RANGE;
  return clamp01((y - a) / (b - a));
}

class OneEuro {
  constructor(minCutoff = 1.2, beta = 6, dCutoff = 1) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
    this.reset();
  }
  reset() {
    this.x = null;
    this.dx = 0;
    this.t = null;
  }
  static alpha(cutoff, dt) {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
  }
  filter(v, now) {
    if (this.x === null) {
      this.x = v;
      this.t = now;
      return v;
    }
    const dt = Math.max(1e-3, (now - this.t) / 1000);
    this.t = now;
    const dv = (v - this.x) / dt;
    this.dx += OneEuro.alpha(this.dCutoff, dt) * (dv - this.dx);
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dx);
    this.x += OneEuro.alpha(cutoff, dt) * (v - this.x);
    return this.x;
  }
}

export const angleDiff = (a, b) => {
  let d = a - b;
  while (d > 180) d -= 360;
  while (d < -180) d += 360;
  return d;
};

export class GestureController {
  constructor() {
    this.reset();
  }

  reset() {
    this.grabbed = false;
    this.smoothX = null;
    this.smoothY = null;
    this.fx = new OneEuro();
    this.fy = new OneEuro();
    this.neutralAngle = 0;
    this.rotateArmed = true;
    this.rotatePeak = 0;
    this.openFrames = 0;
    this.palmSince = null;
    this.victorySince = null;
    this.victoryFired = false;
    this.fistSince = null;
    this.fistFired = false;
    this.palmProgress = 0;
    this.victoryProgress = 0;
    this.fistProgress = 0;
    this.grabbedAt = 0;
    this.approachMin = null;
    this.needOpen = false;
    this.last = null;
  }

  update(info, now) {
    const events = [];
    this.last = info;

    if (!info) {
      if (this.grabbed) {
        this.grabbed = false;
        events.push({ type: 'lost' });
      }
      this.palmSince = null;
      this.victorySince = null;
      this.victoryFired = false;
      this.fistSince = null;
      this.fistFired = false;
      this.palmProgress = this.victoryProgress = this.fistProgress = 0;
      this.smoothX = this.smoothY = null;
      this.fx.reset();
      this.fy.reset();
      this.approachMin = null;
      return events;
    }

    if (this.smoothX === null) { this.fx.reset(); this.fy.reset(); }
    this.smoothX = this.fx.filter(info.x, now);
    this.smoothY = this.fy.filter(info.y, now);
    const r = info.pinchRatio;

    if (!this.grabbed && r < CFG.PINCH_ON) {
      this.grabbed = true;
      this.grabbedAt = now;
      this.openFrames = 0;
      this.neutralAngle = info.angle;
      this.rotateArmed = true;
      this.rotatePeak = 0;
      this.approachMin = null;
      events.push({ type: 'grab' });
    } else if (this.grabbed) {
      this.openFrames = r > CFG.PINCH_OFF ? this.openFrames + 1 : 0;
      if (this.openFrames >= 2) {
        this.grabbed = false;
        this.needOpen = true;
        events.push({ type: 'release', heldMs: now - this.grabbedAt });
      }
    }

    if (!this.grabbed) {
      if (this.needOpen) {
        if (r > CFG.HALF_PINCH_MAX) this.needOpen = false;
      } else if (r < CFG.HALF_PINCH_MAX) {
        this.approachMin = Math.min(this.approachMin ?? Infinity, r);
      } else if (this.approachMin !== null && r > CFG.HALF_PINCH_MAX + 0.05) {
        events.push({ type: 'pinchFail', min: this.approachMin });
        this.approachMin = null;
      }
    }

    if (this.grabbed) {
      const d = angleDiff(info.angle, this.neutralAngle);
      const ad = Math.abs(d);
      if (this.rotateArmed) {
        this.rotatePeak = Math.max(this.rotatePeak, ad);
        if (ad >= CFG.ROTATE_DEG) {
          this.rotateArmed = false;
          this.rotatePeak = 0;
          events.push({ type: 'rotate', dir: d > 0 ? 1 : -1 });
        } else if (ad < CFG.ROTATE_REARM_DEG && this.rotatePeak >= CFG.ROTATE_HINT_DEG) {
          events.push({ type: 'rotateFail', peak: this.rotatePeak });
          this.rotatePeak = 0;
        }
      } else if (ad < CFG.ROTATE_REARM_DEG) {
        this.rotateArmed = true;
      }
    }

    if (info.palmOpen && !this.grabbed) {
      if (this.palmSince === null) this.palmSince = now;
      this.palmProgress = Math.min(1, (now - this.palmSince) / CFG.PALM_HOLD_MS);
      events.push({ type: 'palm', progress: this.palmProgress });
    } else {
      this.palmSince = null;
      this.palmProgress = 0;
    }

    if (info.victory && !this.grabbed) {
      if (this.victorySince === null) this.victorySince = now;
      const progress = Math.min(1, (now - this.victorySince) / CFG.VICTORY_HOLD_MS);
      this.victoryProgress = progress;
      events.push({ type: 'victoryProgress', progress });
      if (progress >= 1 && !this.victoryFired) {
        this.victoryFired = true;
        events.push({ type: 'victory' });
      }
    } else {
      this.victorySince = null;
      this.victoryFired = false;
      this.victoryProgress = 0;
    }

    if (info.fist) {
      if (this.fistSince === null) this.fistSince = now;
      this.fistProgress = Math.min(1, (now - this.fistSince) / CFG.FIST_HOLD_MS);
      if (this.fistProgress >= 1 && !this.fistFired) {
        this.fistFired = true;
        events.push({ type: 'fist' });
      }
    } else {
      this.fistSince = null;
      this.fistFired = false;
      this.fistProgress = 0;
    }

    return events;
  }

  get rotationDelta() {
    if (!this.last || !this.grabbed) return 0;
    return angleDiff(this.last.angle, this.neutralAngle);
  }
}
