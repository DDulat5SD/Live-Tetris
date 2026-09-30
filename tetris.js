export const COLS = 10;
export const ROWS = 20;

const SHAPES = {
  I: [[0, 0, 0, 0], [1, 1, 1, 1], [0, 0, 0, 0], [0, 0, 0, 0]],
  O: [[1, 1], [1, 1]],
  T: [[0, 1, 0], [1, 1, 1], [0, 0, 0]],
  S: [[0, 1, 1], [1, 1, 0], [0, 0, 0]],
  Z: [[1, 1, 0], [0, 1, 1], [0, 0, 0]],
  J: [[1, 0, 0], [1, 1, 1], [0, 0, 0]],
  L: [[0, 0, 1], [1, 1, 1], [0, 0, 0]],
};

export const COLORS = {
  I: '#7FB7BE', O: '#F2C14E', T: '#B8A1D9', S: '#8DB580',
  Z: '#E4572E', J: '#5C80BC', L: '#F28F3B',
};

export function getShape(type) {
  return SHAPES[type].map((row) => row.slice());
}

function rotateMatrix(m, dir) {
  const n = m.length;
  const r = Array.from({ length: n }, () => Array(n).fill(0));
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (dir > 0) r[x][n - 1 - y] = m[y][x];
      else r[n - 1 - x][y] = m[y][x];
    }
  }
  return r;
}

export function filledColumns(shape) {
  let min = Infinity, max = -Infinity;
  shape.forEach((row) => row.forEach((v, x) => {
    if (v) { min = Math.min(min, x); max = Math.max(max, x); }
  }));
  return { min, max };
}

export function filledRows(shape) {
  let min = Infinity, max = -Infinity;
  shape.forEach((row, y) => {
    if (row.some(Boolean)) { min = Math.min(min, y); max = Math.max(max, y); }
  });
  return { min, max };
}

function countHoles(board) {
  let holes = 0;
  for (let x = 0; x < COLS; x++) {
    let roof = false;
    for (let y = 0; y < ROWS; y++) {
      if (board[y][x]) roof = true;
      else if (roof) holes++;
    }
  }
  return holes;
}

const LINE_SCORES = [0, 100, 300, 500, 800];

export class Tetris {
  constructor() {
    this.speedPerPiece = 0;
    this.speedMul = 1;
    this.reset();
  }

  reset() {
    this.board = Array.from({ length: ROWS }, () => Array(COLS).fill(null));
    this.score = 0;
    this.lines = 0;
    this.level = 1;
    this.pieces = 0;
    this.over = false;
    this.bag = [];
    this.dropTimer = 0;
    this.next = this.takeFromBag();
    this.spawn();
  }

  takeFromBag() {
    if (this.bag.length === 0) {
      this.bag = Object.keys(SHAPES);
      for (let i = this.bag.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [this.bag[i], this.bag[j]] = [this.bag[j], this.bag[i]];
      }
    }
    return this.bag.pop();
  }

  spawn() {
    const type = this.next;
    this.next = this.takeFromBag();
    const shape = getShape(type);
    this.piece = {
      type,
      shape,
      x: Math.floor((COLS - shape.length) / 2),
      y: type === 'I' ? -1 : 0,
    };
    if (this.collides(shape, this.piece.x, this.piece.y)) this.over = true;
  }

  collides(shape, px, py) {
    for (let y = 0; y < shape.length; y++) {
      for (let x = 0; x < shape[y].length; x++) {
        if (!shape[y][x]) continue;
        const bx = px + x, by = py + y;
        if (bx < 0 || bx >= COLS || by >= ROWS) return true;
        if (by >= 0 && this.board[by][bx]) return true;
      }
    }
    return false;
  }

  move(dx) {
    const p = this.piece;
    if (this.collides(p.shape, p.x + dx, p.y)) return false;
    p.x += dx;
    return true;
  }

  moveY(dy) {
    const p = this.piece;
    if (this.collides(p.shape, p.x, p.y + dy)) return false;
    p.y += dy;
    return true;
  }

  rotate(dir) {
    const p = this.piece;
    const rotated = rotateMatrix(p.shape, dir);
    for (const kick of [0, -1, 1, -2, 2]) {
      if (!this.collides(rotated, p.x + kick, p.y)) {
        p.shape = rotated;
        p.x += kick;
        return true;
      }
    }
    return false;
  }

  ghostY() {
    const p = this.piece;
    let y = p.y;
    while (!this.collides(p.shape, p.x, y + 1)) y++;
    return y;
  }

  softStep() {
    const p = this.piece;
    if (!this.collides(p.shape, p.x, p.y + 1)) {
      p.y++;
      return null;
    }
    return this.lock();
  }

  hardDrop() {
    const target = this.ghostY();
    this.score += (target - this.piece.y) * 2;
    this.piece.y = target;
    return this.lock();
  }

  lock() {
    const p = this.piece;
    const holesBefore = countHoles(this.board);
    for (let y = 0; y < p.shape.length; y++) {
      for (let x = 0; x < p.shape[y].length; x++) {
        if (!p.shape[y][x]) continue;
        const by = p.y + y;
        if (by < 0) { this.over = true; continue; }
        this.board[by][p.x + x] = p.type;
      }
    }
    const holesAdded = Math.max(0, countHoles(this.board) - holesBefore);

    let cleared = 0;
    for (let y = ROWS - 1; y >= 0; y--) {
      if (this.board[y].every(Boolean)) {
        this.board.splice(y, 1);
        this.board.unshift(Array(COLS).fill(null));
        cleared++;
        y++;
      }
    }
    this.lines += cleared;
    this.score += LINE_SCORES[cleared] * this.level;
    this.level = 1 + Math.floor(this.lines / 10);
    this.pieces++;

    if (!this.over) this.spawn();
    return { cleared, holesAdded: cleared > 0 ? 0 : holesAdded };
  }

  get interval() {
    const base = Math.max(150, 1000 - (this.level - 1) * 85);
    return Math.max(70, base * this.speedMul * Math.pow(1 - this.speedPerPiece, this.pieces));
  }

  update(dt) {
    if (this.over) return null;
    this.dropTimer += dt;
    if (this.dropTimer >= this.interval) {
      this.dropTimer = 0;
      return this.softStep();
    }
    return null;
  }
}
