import { Tetris, COLS, ROWS, COLORS, getShape, filledColumns, filledRows } from './tetris.js';
import { analyzeHand, handToBoardT, handToBoardY, GestureController, CFG, angleDiff } from './gestures.js';
import { Coach, ADVICE } from './coach.js';
import { Calibration, loadCalibration } from './calibration.js';

const VISION = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14';
const MODEL =
  'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

const ANTI_MS = 7000;
const ANTI_MAX = 3;
const LINES_PER_CHARGE = 2;

const BONES = [
  [0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12], [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20], [0, 17],
];

const $ = (id) => document.getElementById(id);
const video = $('video');
const stage = $('stage');
const sctx = stage.getContext('2d');
const nextCtx = $('nextCanvas').getContext('2d');
const overlay = $('overlay');
const ovCard = $('ovCard');

const game = new Tetris();
const ctrl = new GestureController();
const helperCtrl = new GestureController();
const coach = new Coach();

let landmarker = null;
let landmarks = null;
let info = null;
let helperLandmarks = null;
let helperInfo = null;
let aspect = 4 / 3;
let lastMainX = null, lastHelperX = null, mainSeenAt = 0, helperSeenAt = 0;
let wheel = null;
let follow = { mode: null, offX: 0, offY: 0 };
let hist = [];
const REWIND_MS = 160;
let wheelHints = 0;
let pausedBy = null;
let pauseAt = 0;
let pauseToggledAt = 0;
let cross = { since: null, fired: false, progress: 0, at: null };
let lastVideoTime = -1;

let state = 'intro';
let lastT = performance.now();
let moveTimer = 0;
let blocked = false;
let pieceGrabbed = false;
let pieceNo = 0;
let noHandSince = null;
let handBackSince = null;
let overAt = 0;
let stats = null;
let palmProgress = 0;
let victoryProgress = 0;
let flash = 0;
let calib = null;
let calibStep = -1;
let anti = { charges: 1, until: 0, lines: 0 };
let wasAnti = false;
let particles = [];

const MODES = {
  easy: { name: 'Лёгкий', tag: 'лёгк.' },
  normal: { name: 'Средний', tag: 'сред.' },
  hard: { name: 'Хард', tag: 'хард' },
};
let mode = 'normal';
const MENU_HOLD_MS = 1800;
let menuHover = { el: null, since: 0 };
let cursorPos = null;
let lastGrabChange = 0;

const antiActive = (now) => now < anti.until;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const safeGet = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
const safeSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {  } };

let audio = null;
function beep(freq, ms = 70, type = 'square', vol = 0.05, slideTo = null) {
  if (!audio) return;
  const o = audio.createOscillator();
  const g = audio.createGain();
  o.type = type;
  o.frequency.value = freq;
  if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, audio.currentTime + ms / 1000);
  g.gain.value = vol;
  g.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + ms / 1000);
  o.connect(g).connect(audio.destination);
  o.start();
  o.stop(audio.currentTime + ms / 1000);
}

let voiceOn = safeGet('handtris-voice', true);
function speak(text) {
  if (!voiceOn || !('speechSynthesis' in window)) return;
  const clean = text
    .replace(/~/g, 'примерно ')
    .replace(/°/g, ' градусов')
    .replace(/знак ✌️/g, 'знак из двух пальцев').replace(/✌️/g, 'два пальца')
    .replace(/—/g, ',');
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(clean);
  u.lang = 'ru-RU';
  u.rate = 1.12;
  const ru = speechSynthesis.getVoices().find((v) => v.lang && v.lang.startsWith('ru'));
  if (ru) u.voice = ru;
  speechSynthesis.speak(u);
}
function renderVoiceBtn() {
  $('voiceBtn').textContent = voiceOn ? '🔊 Голос' : '🔇 Голос';
  $('voiceBtn').classList.toggle('off', !voiceOn);
}

function saveRecord(score, lines) {
  const list = safeGet('handtris-records', []);
  list.push({ score, lines, mode, date: new Date().toLocaleDateString('ru-RU') });
  list.sort((a, b) => b.score - a.score);
  safeSet('handtris-records', list.slice(0, 5));
  return list[0].score === score && score > 0;
}
function renderRecords() {
  const list = safeGet('handtris-records', []);
  $('records').innerHTML = list.length
    ? list.map((r) => `<li><b>${r.score}</b> <span>${r.lines} лин. · ${MODES[r.mode] ? MODES[r.mode].tag + ' · ' : ''}${r.date}</span></li>`).join('')
    : '<li class="muted">пока пусто</li>';
}

async function startCamera() {
  audio = audio || new (window.AudioContext || window.webkitAudioContext)();
  ovCard.innerHTML = '<h2>Загружаю распознавание руки…</h2><p class="muted">Первый раз может занять 5–10 секунд</p>';
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
      audio: false,
    });
    video.srcObject = stream;
    await video.play();
  } catch (e) {
    ovCard.innerHTML = `<h2>Нет доступа к камере</h2>
      <p>Разреши доступ к камере в адресной строке браузера и обнови страницу.</p>
      <p class="muted small">${e.name}</p>`;
    return;
  }

  try {
    const { HandLandmarker, FilesetResolver } = await import(`${VISION}/vision_bundle.mjs`);
    const fileset = await FilesetResolver.forVisionTasks(`${VISION}/wasm`);
    const opts = (delegate) => ({
      baseOptions: { modelAssetPath: MODEL, delegate },
      runningMode: 'VIDEO',
      numHands: 2,
      minHandDetectionConfidence: 0.6,
      minTrackingConfidence: 0.5,
    });
    try {
      landmarker = await HandLandmarker.createFromOptions(fileset, opts('GPU'));
    } catch {
      landmarker = await HandLandmarker.createFromOptions(fileset, opts('CPU'));
    }
  } catch (e) {
    ovCard.innerHTML = `<h2>Не удалось загрузить MediaPipe</h2>
      <p>Проверь интернет и обнови страницу.</p><p class="muted small">${e.message}</p>`;
    return;
  }

  sizeStage();
  $('calibBtn').hidden = false;

  if (loadCalibration()) showMenu();
  else startCalibration();
}

function detect(now) {
  if (!landmarker || video.readyState < 2 || video.currentTime === lastVideoTime) return false;
  lastVideoTime = video.currentTime;
  const res = landmarker.detectForVideo(video, now);
  aspect = video.videoWidth / video.videoHeight || 4 / 3;
  const hands = (res.landmarks || []).slice(0, 2).map((lm) => ({ lm, info: analyzeHand(lm, aspect) }));

  if (now - mainSeenAt > 800) lastMainX = null;
  if (now - helperSeenAt > 800) lastHelperX = null;
  let main = null, helper = null;
  if (hands.length === 1) {
    const h = hands[0];
    const dMain = lastMainX === null ? Infinity : Math.abs(h.info.wx - lastMainX);
    const dHelp = lastHelperX === null ? Infinity : Math.abs(h.info.wx - lastHelperX);
    if (dHelp < dMain) helper = h;
    else main = h;
  } else if (hands.length === 2) {
    const [a, b] = hands;
    let aMain = a.info.wx > b.info.wx;
    if (lastMainX !== null && lastHelperX !== null) {
      aMain =
        Math.abs(a.info.wx - lastMainX) + Math.abs(b.info.wx - lastHelperX) <=
        Math.abs(b.info.wx - lastMainX) + Math.abs(a.info.wx - lastHelperX);
    } else if (lastMainX !== null) {
      aMain = Math.abs(a.info.wx - lastMainX) <= Math.abs(b.info.wx - lastMainX);
    }
    if (!ctrl.grabbed) {
      const aP = a.info.pinchRatio < CFG.PINCH_ON, bP = b.info.pinchRatio < CFG.PINCH_ON;
      if (aP !== bP) {
        const pincherIsHelper = aP !== aMain;

        if (!(pincherIsHelper && helperCtrl.grabbed)) {
          if (pincherIsHelper) { ctrl.smoothX = ctrl.smoothY = null; helperCtrl.smoothX = helperCtrl.smoothY = null; }
          aMain = aP;
        }
      }
    }
    main = aMain ? a : b;
    helper = aMain ? b : a;
  }
  landmarks = main ? main.lm : null;
  info = main ? main.info : null;
  helperLandmarks = helper ? helper.lm : null;
  helperInfo = helper ? helper.info : null;
  if (info) { lastMainX = info.wx; mainSeenAt = now; }
  if (helperInfo) { lastHelperX = helperInfo.wx; helperSeenAt = now; }
  return true;
}

function startCalibration() {
  if (!landmarker) return;
  calib = new Calibration();
  calibStep = -1;
  state = 'calib';
  overlay.hidden = false;
  overlay.classList.remove('full', 'menu-mode');
}

function renderCalibStep() {
  const s = calib.current;
  ovCard.innerHTML = `
    <div class="k">Калибровка под твою руку</div>
    <h2>${s.title}</h2>
    <div class="cal-icon">${s.icon}</div>
    <p>${s.text}</p>
    <div class="bar"><div class="bar-fill" id="calBar"></div></div>
    <p class="cal-hint" id="calHint">&nbsp;</p>
    <p class="muted small">Смотри на скелет руки слева — так видит тебя камера</p>`;
  speak(s.text);
}

function updateCalibration(now) {
  const { progress, hint } = calib.update(info, now);
  if (calib.done) {
    const r = calib.result;
    beep(660, 90, 'triangle');
    setTimeout(() => beep(990, 140, 'triangle'), 100);
    showMenu(`
      <div class="cal-result">
        <div><span class="k">Твой щипок</span><b>до ${r.closedCm} см</b><span class="muted small">порог: ${r.pinchOnCm} см</span></div>
        <div><span class="k">Поворот кисти</span><b>→ ${r.right}° · ← ${r.left}°</b><span class="muted small">порог: ${r.rotate}°</span></div>
      </div>`, 'Калибровка готова!');
    speak('Калибровка готова. Покажи ладонь, чтобы начать');
    return;
  }
  if (calib.step !== calibStep) {
    if (calibStep >= 0) beep(880, 80, 'triangle');
    calibStep = calib.step;
    renderCalibStep();
  }
  $('calBar').style.width = `${Math.round(progress * 100)}%`;
  $('calHint').textContent = hint || ' ';
}

function showMenu(extra = '', title = 'Выбери сложность') {
  state = 'menu';
  overlay.hidden = false;
  overlay.classList.remove('full');
  overlay.classList.add('menu-mode');
  menuHover = { el: null, since: 0 };
  ovCard.innerHTML = `
    <div class="menu-card">
      <div class="k">Handtris · тетрис руками</div>
      <h1>${title}</h1>
      ${extra}
      <div class="modes">
        <button class="mode-btn" data-mode="easy">
          <span class="mode-ico easy"><i></i><i></i><i></i><i></i></span>
          <b>Лёгкий</b>
          <span class="desc">Спокойная скорость и антигравитация без ограничений — знак мира ✌️ в любой момент</span>
          <span class="fill"></span>
        </button>
        <button class="mode-btn" data-mode="normal">
          <span class="mode-ico normal"><i></i><i></i><i></i><i></i></span>
          <b>Средний</b>
          <span class="desc">Чуть быстрее, антигравитация — заряды за собранные линии</span>
          <span class="fill"></span>
        </button>
        <button class="mode-btn" data-mode="hard">
          <span class="mode-ico hard"><i></i><i></i><i></i><i></i></span>
          <b>Хард</b>
          <span class="desc">Быстро, без антигравитации, и каждая фигура разгоняет следующую</span>
          <span class="fill"></span>
        </button>
      </div>
      <p class="muted small">Наведи указательный палец на кнопку и держи ${(MENU_HOLD_MS / 1000).toFixed(1).replace('.', ',')} с. Можно кликнуть мышкой или нажать 1 · 2 · 3.</p>
    </div>`;
  ovCard.querySelectorAll('.mode-btn').forEach((b) => b.addEventListener('click', () => startGame(b.dataset.mode)));
}

function updateMenuPointer(now) {
  const cur = $('cursor');
  const hand = landmarks ? { lm: landmarks, info } : helperLandmarks ? { lm: helperLandmarks, info: helperInfo } : null;
  if (state !== 'menu' || !hand) {
    cur.hidden = true;
    cursorPos = null;
    setMenuHover(null, now);
    return;
  }
  const [sx, sy] = toStage(1 - hand.lm[8].x, hand.lm[8].y);
  cursorPos = cursorPos ? [cursorPos[0] * 0.5 + sx * 0.5, cursorPos[1] * 0.5 + sy * 0.5] : [sx, sy];
  const k = stage.clientWidth / stage.width;
  const x = cursorPos[0] * k, y = cursorPos[1] * k;
  cur.hidden = false;
  cur.style.transform = `translate(${x}px, ${y}px)`;

  const r = stage.getBoundingClientRect();
  const cx = r.left + x, cy = r.top + y;
  let over = null;
  ovCard.querySelectorAll('.mode-btn').forEach((b) => {
    const q = b.getBoundingClientRect();
    if (cx >= q.left && cx <= q.right && cy >= q.top && cy <= q.bottom) over = b;
  });

  if (!hand.info.ext[0]) over = null;
  setMenuHover(over, now);
  cur.classList.toggle('active', !!over);
  if (over) {
    const p = Math.min(1, (now - menuHover.since) / MENU_HOLD_MS);
    over.style.setProperty('--p', p);
    if (p >= 1) {
      cur.hidden = true;
      startGame(over.dataset.mode);
    }
  }
}

function setMenuHover(el, now) {
  if (menuHover.el === el) return;
  if (menuHover.el) {
    menuHover.el.classList.remove('hover');
    menuHover.el.style.setProperty('--p', 0);
  }
  menuHover = { el, since: now };
  if (el) {
    el.classList.add('hover');
    beep(520, 40, 'triangle');
  }
}

function startGame(m = mode) {
  mode = MODES[m] ? m : 'normal';
  safeSet('handtris-mode', mode);

  game.speedMul = mode === 'easy' ? 1 : mode === 'normal' ? 0.85 / 1.5 : 0.5 / 1.5;
  game.speedPerPiece = mode === 'hard' ? 0.02 : 0;
  $('cursor').hidden = true;
  game.reset();
  ctrl.reset();
  helperCtrl.reset();
  coach.reset();
  wheel = null;
  wheelHints = 0;
  pausedBy = null;
  const now = performance.now();
  pieceNo = game.pieces;
  pieceGrabbed = false;
  anti = { charges: mode === 'normal' ? 1 : 0, until: 0, lines: 0 };
  particles = [];
  stats = {
    start: now, spawnAt: now, reacted: false, reactions: [],
    grabs: 0, pinchFails: 0, rotations: 0, rotateFails: 0,
    grabbedPieces: 0, holes: 0, antiUsed: 0,
  };
  state = 'playing';
  overlay.hidden = true;
  coach.announce('mode', `Режим «${MODES[mode].name}». Поехали!`, now, 'good', 1800);
  beep(660, 120, 'triangle');
}

function pause(reason, now) {
  state = 'paused';
  pausedBy = reason;
  pauseAt = now;
  pauseToggledAt = now;
  wheel = null;
  overlay.hidden = false;
  overlay.classList.remove('full', 'menu-mode');
  if (reason === 'user') {
    ovCard.innerHTML = `<h2>Пауза</h2>
      <p>Сожми кулак или подержи открытую ладонь секунду, чтобы продолжить.</p>
      <div class="ring"><div class="ring-fill" id="ring"></div><span>✋</span></div>
      <p class="muted small">Клавиша P — тоже пауза</p>`;
    speak('Пауза');
    beep(440, 120, 'triangle');
  } else {
    ovCard.innerHTML = `<h2>Пауза</h2><p>Не вижу руки. Подними ладонь перед камерой — игра продолжится сама.</p>`;
  }
}

function resume(now) {

  const d = now - pauseAt;
  if (anti.until > pauseAt) anti.until += d;
  stats.start += d;
  stats.spawnAt += d;
  state = 'playing';
  pausedBy = null;
  pauseToggledAt = now;
  noHandSince = null;
  handBackSince = null;
  overlay.hidden = true;
  beep(660, 90, 'triangle');
}

function analyzeMotion() {
  const avg = (a) => a.reduce((s, v) => s + v, 0) / a.length;
  const r = stats.reactions;
  const react = r.length ? avg(r) / 1000 : null;
  const pct = (ok, bad) => (ok + bad ? (ok / (ok + bad)) * 100 : null);
  const pinchAcc = pct(stats.grabs, stats.pinchFails);
  const rotAcc = pct(stats.rotations, stats.rotateFails);
  const handPct = game.pieces ? (stats.grabbedPieces / game.pieces) * 100 : 0;
  const reactScore = react === null ? null : clamp(100 - (react - 0.8) * 40, 0, 100);

  const parts = [[pinchAcc, 0.3], [rotAcc, 0.25], [handPct, 0.25], [reactScore, 0.2]].filter(
    ([v]) => v !== null
  );
  const w = parts.reduce((s, [, k]) => s + k, 0);
  const score = Math.round(parts.reduce((s, [v, k]) => s + v * k, 0) / w);

  let trend = null;
  if (r.length >= 6) {
    const half = Math.floor(r.length / 2);
    const diff = (avg(r.slice(0, half)) - avg(r.slice(half))) / 1000;
    if (Math.abs(diff) >= 0.15)
      trend = diff > 0
        ? `К концу игры ты хватал фигуры быстрее на ${diff.toFixed(1)} с 🚀`
        : `К концу игры реакция замедлилась на ${(-diff).toFixed(1)} с — рука устала?`;
  }

  const prev = safeGet('handtris-technique', null);
  safeSet('handtris-technique', score);
  const grade = score >= 85 ? 'Мастер' : score >= 70 ? 'Уверенно' : score >= 50 ? 'Неплохо' : 'Новичок';
  return { score, grade, react, pinchAcc, rotAcc, handPct, trend, prev };
}

function showResults() {
  state = 'over';
  overAt = performance.now();
  const seconds = Math.round((performance.now() - stats.start) / 1000);
  const isBest = saveRecord(game.score, game.lines);
  renderRecords();
  const sum = coach.summary();
  const m = analyzeMotion();
  const fmt = (v) => (v === null ? '—' : `${Math.round(v)}%`);
  const mm = String(Math.floor(seconds / 60)).padStart(2, '0');
  const ss = String(seconds % 60).padStart(2, '0');
  const progress =
    m.prev === null ? '' :
    m.score > m.prev ? `<span class="up">▲ +${m.score - m.prev} к прошлой игре</span>` :
    m.score < m.prev ? `<span class="down">▼ ${m.score - m.prev} к прошлой игре</span>` :
    '<span class="muted">как в прошлой игре</span>';
  const errors = sum.top.length
    ? `<ul class="err-list">${sum.top.map((t) => `<li>${t.label} <b>×${t.n}</b></li>`).join('')}</ul>
       <p class="advice">Совет: ${ADVICE[sum.top[0].id]}</p>`
    : '<p class="advice">Ни одной ошибки — чистая техника!</p>';

  overlay.hidden = false;
  overlay.classList.remove('menu-mode');
  overlay.classList.add('full');
  ovCard.innerHTML = `
    <h2>${isBest ? 'Новый рекорд! 🏆' : 'Игра окончена'}</h2>
    <div class="result-grid four">
      <div><span class="k">Счёт</span><span class="v">${game.score}</span></div>
      <div><span class="k">Линии</span><span class="v">${game.lines}</span></div>
      <div><span class="k">Время</span><span class="v">${mm}:${ss}</span></div>
      <div><span class="k">Антигравитация</span><span class="v">×${stats.antiUsed}</span></div>
    </div>

    <div class="res-cols">
      <div class="res-col">
        <h3>Анализ движения</h3>
        <div class="tech">
          <div class="tech-score">${m.score}<small>/100</small></div>
          <div><b>${m.grade}</b><br>${progress}</div>
        </div>
        <ul class="metrics">
          <li><span>Точность щипка</span><b>${fmt(m.pinchAcc)}</b></li>
          <li><span>Точность поворота</span><b>${fmt(m.rotAcc)}</b></li>
          <li><span>Фигур поставлено руками</span><b>${fmt(m.handPct)}</b></li>
          <li><span>Средняя реакция</span><b>${m.react === null ? '—' : m.react.toFixed(1) + ' с'}</b></li>
        </ul>
        <span class="k">Время реакции по фигурам</span>
        <canvas id="resChart" width="460" height="90"></canvas>
        ${m.trend ? `<p class="muted small">${m.trend}</p>` : ''}
      </div>
      <div class="res-col">
        <h3>Разбор ошибок (${sum.total})</h3>
        ${errors}
      </div>
    </div>

    <div class="ring"><div class="ring-fill" id="ring"></div><span>✋</span></div>
    <p class="muted small">Ладонь 1 секунду — ещё раз в режиме «${MODES[mode].name}» · указательные крестиком — в меню</p>`;
  drawReactionChart($('resChart'), stats.reactions);
  speak(`Игра окончена. Оценка техники ${m.score} из 100. ${sum.top.length ? 'Совет: ' + ADVICE[sum.top[0].id] : ''}`);
  beep(220, 400, 'sawtooth', 0.04);
}

function drawReactionChart(c, data) {
  const ctx = c.getContext('2d');
  const W = c.width, H = c.height;
  ctx.clearRect(0, 0, W, H);
  if (!data.length) {
    ctx.fillStyle = '#6E675C';
    ctx.font = '12px IBM Plex Mono, monospace';
    ctx.fillText('нет данных — фигуры не брали рукой', 8, H / 2);
    return;
  }
  const d = data.slice(-40).map((v) => v / 1000);
  const max = Math.max(3, ...d);
  const bw = W / d.length;
  d.forEach((v, i) => {
    const h = (v / max) * (H - 14);
    ctx.fillStyle = v < 1.2 ? '#8DB580' : v < 2.2 ? '#F2C14E' : '#E4572E';
    ctx.fillRect(i * bw + 1, H - h, Math.max(2, bw - 2), h);
  });
  ctx.fillStyle = '#6E675C';
  ctx.font = '10px IBM Plex Mono, monospace';
  ctx.fillText(`${max.toFixed(0)} с`, 2, 10);
}

function tryAntigravity(now) {
  if (state !== 'playing') return;
  if (mode === 'hard') {
    coach.say('antiEmpty', 'В режиме «Хард» антигравитации нет — только ловкость рук', now);
    return;
  }
  if (antiActive(now)) return;
  if (mode === 'normal' && anti.charges <= 0) {
    coach.say('antiEmpty', `Антигравитация не заряжена — собери ещё ${LINES_PER_CHARGE - anti.lines} лин., чтобы получить заряд`, now);
    return;
  }
  if (mode === 'normal') anti.charges--;
  anti.until = now + ANTI_MS;
  stats.antiUsed++;
  coach.announce('anti', 'Антигравитация! Фигура невесома 7 секунд — возьми её и подними рукой куда угодно', now, 'good', 3000);
  speak('Антигравитация!');
  beep(300, 500, 'sine', 0.07, 1200);
}

function afterLock(res) {
  if (!res) return;
  const now = performance.now();
  coach.checkLock({ ...res, wasGrabbed: pieceGrabbed }, now);
  if (pieceGrabbed) stats.grabbedPieces++;
  stats.holes += res.holesAdded;
  if (res.cleared) {
    flash = 1;
    beep(880, 160, 'triangle');
    if (mode === 'normal') anti.lines += res.cleared;
    while (anti.lines >= LINES_PER_CHARGE) {
      anti.lines -= LINES_PER_CHARGE;
      if (anti.charges < ANTI_MAX) {
        anti.charges++;
        coach.announce('charge', '+1 заряд антигравитации! Покажи второй рукой знак мира ✌️', now);
      }
    }
  } else {
    beep(140, 60);
  }
  if (game.over) showResults();
}

function handleEvents(events, now, role) {
  for (const ev of events) {
    if (ev.type === 'palm') {
      if (ev.progress < 1) continue;
      const canRestart = state === 'over' && now - overAt > 1500;
      if (canRestart) startGame(mode);
      else if (state === 'paused' && pausedBy === 'user' && now - pauseToggledAt > 800) resume(now);
      continue;
    }
    if (ev.type === 'victoryProgress') continue;

    if (ev.type === 'fist') {
      if (now - pauseToggledAt < 800) continue;
      if (state === 'paused' && pausedBy === 'user') resume(now);
      else if (state === 'playing' && role === 'helper' && !wheel) pause('user', now);
      continue;
    }
    if (state !== 'playing') continue;

    if (role === 'helper') {
      if (ev.type === 'victory' && now - lastGrabChange > 700) tryAntigravity(now);
      continue;
    }

    switch (ev.type) {
      case 'grab':
        lastGrabChange = now;
        pieceGrabbed = true;
        stats.grabs++;
        if (!stats.reacted) {
          stats.reacted = true;
          stats.reactions.push(now - stats.spawnAt);
        }
        beep(520, 50);
        break;
      case 'rotate':
        if (helperInfo) break;
        if (game.rotate(ev.dir)) {
          stats.rotations++;
          beep(740, 50);
        } else {
          coach.say('blocked', 'Здесь фигуре не хватает места для поворота — сдвинь её от стены или блоков', now);
        }
        break;
      case 'release':
        lastGrabChange = now;
        rewindPiece(now);
        afterLock(game.hardDrop());
        break;
      case 'lost':
        coach.onLost(now);
        break;
      case 'pinchFail':
        stats.pinchFails++;
        coach.onPinchFail(ev.min, now);
        break;
      case 'rotateFail':
        if (helperInfo) break;
        stats.rotateFails++;
        coach.onRotateFail(ev.peak, now);
        break;
      case 'victory':

        if (!helperInfo && now - lastGrabChange > 700) tryAntigravity(now);
        break;
    }
  }
}

function segCross(p1, p2, p3, p4) {
  const d = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const d1 = d(p3, p4, p1), d2 = d(p3, p4, p2), d3 = d(p1, p2, p3), d4 = d(p1, p2, p4);
  if (!(d1 * d2 < 0 && d3 * d4 < 0)) return null;
  const t = d1 / (d1 - d2);
  return [p1[0] + (p2[0] - p1[0]) * t, p1[1] + (p2[1] - p1[1]) * t];
}

function updateCross(now) {
  let hit = null;
  if (landmarks && helperLandmarks && info && helperInfo && info.ext[0] && helperInfo.ext[0]) {
    const pt = (lm, i) => [(1 - lm[i].x) * aspect, lm[i].y];
    const a1 = pt(landmarks, 5), a2 = pt(landmarks, 8);
    const b1 = pt(helperLandmarks, 5), b2 = pt(helperLandmarks, 8);
    const ang = (u, v) => Math.atan2(v[1] - u[1], v[0] - u[0]);
    let diff = Math.abs(ang(a1, a2) - ang(b1, b2)) % Math.PI;
    if (diff > Math.PI / 2) diff = Math.PI - diff;
    const x = segCross(a1, a2, b1, b2);
    if (x && diff > (35 * Math.PI) / 180) hit = [x[0] / aspect, x[1]];
  }
  if (!hit) {
    cross = { since: null, fired: false, progress: 0, at: null };
    return;
  }
  if (cross.since === null) cross.since = now;
  cross.at = hit;
  cross.progress = Math.min(1, (now - cross.since) / CFG.CROSS_HOLD_MS);
  if (cross.progress >= 1 && !cross.fired) {
    cross.fired = true;
    restartGame(now);
  }
}

function restartGame(now) {
  if (state === 'intro' || state === 'calib' || state === 'menu') return;
  showMenu();
  speak('Меню');
  beep(440, 120, 'triangle');
}

function updateWheel(now) {
  const on =
    ctrl.grabbed && helperCtrl.grabbed && helperInfo && !helperInfo.fist &&
    ctrl.smoothX !== null && helperCtrl.smoothX !== null;
  if (!on) {
    wheel = null;
    return;
  }
  const ang =
    (Math.atan2(helperCtrl.smoothY - ctrl.smoothY, (helperCtrl.smoothX - ctrl.smoothX) * aspect) * 180) / Math.PI;
  if (!wheel) {
    wheel = { anchor: ang, delta: 0 };
    if (wheelHints < 2) {
      wheelHints++;
      coach.announce('wheel', 'Держишь двумя руками — поверни их, как руль', now, 'info', 1800);
    }
    beep(600, 40);
    return;
  }

  if (opening()) {
    wheel.anchor = ang;
    wheel.delta = 0;
    return;
  }
  wheel.delta = angleDiff(ang, wheel.anchor);
  if (Math.abs(wheel.delta) >= CFG.WHEEL_DEG) {
    const dir = wheel.delta > 0 ? 1 : -1;
    if (game.rotate(dir)) {
      stats.rotations++;
      beep(740, 50);
    } else {
      coach.say('blocked', 'Здесь фигуре не хватает места для поворота — сдвинь её от стены или блоков', now);
    }
    wheel.anchor = ang;
    wheel.delta = 0;
  }
}

function opening() {
  const loose = CFG.PINCH_ON + 0.06;
  if (info && info.pinchRatio > loose) return true;
  if (wheel && helperInfo && helperInfo.pinchRatio > loose) return true;
  return false;
}

function rewindPiece(now) {
  if (!hist.length) return;
  let snap = hist[0];
  for (const h of hist) if (h.t <= now - REWIND_MS) snap = h;
  const p = game.piece;
  if (!game.collides(snap.shape, snap.x, snap.y)) {
    p.x = snap.x;
    p.y = snap.y;
    p.shape = snap.shape;
  }
  hist = [];
}

const rawT = (v, [a, b]) => (v - a) / (b - a);
const clamp01 = (v) => Math.min(1, Math.max(0, v));

function stickyTarget(t, span, cur) {
  const e = CFG.EDGE_SNAP;
  const u = clamp01((t - e) / (1 - 2 * e));
  const want = u * span;
  if (Math.abs(want - cur) < CFG.COL_HYST) return cur;
  return Math.round(want);
}

function followHand(dt, now) {
  blocked = false;
  if (!ctrl.grabbed || ctrl.smoothX === null || !info) {
    follow.mode = null;
    return;
  }
  const two = !!wheel && helperCtrl.smoothX !== null;
  const isAnti = antiActive(now);
  const hx = two ? (ctrl.smoothX + helperCtrl.smoothX) / 2 : ctrl.smoothX;
  const hy = two ? (ctrl.smoothY + helperCtrl.smoothY) / 2 : ctrl.smoothY;
  const p = game.piece;
  const cols = filledColumns(p.shape);
  const rows = filledRows(p.shape);
  const spanX = COLS - (cols.max - cols.min + 1);
  const spanY = ROWS - (rows.max - rows.min + 1);
  const rx = rawT(hx, CFG.COL_RANGE);
  const ry = rawT(hy, CFG.ROW_RANGE);

  const mode = (two ? 'two' : 'one') + (isAnti ? '+anti' : '');
  if (follow.mode !== mode) {
    const tx = spanX ? (p.x + cols.min) / spanX : 0;
    const ty = spanY ? (p.y + rows.min) / spanY : 0;

    follow.offX = follow.mode === null ? 0 : tx - rx;
    follow.offY = ty - ry;
    follow.mode = mode;
  }
  if (opening()) return;

  moveTimer += dt;
  if (moveTimer < 40) return;
  moveTimer = 0;

  const targetX = stickyTarget(rx + follow.offX, spanX, p.x + cols.min) - cols.min;

  for (let i = 0; i < 2 && p.x !== targetX; i++) {
    if (!game.move(Math.sign(targetX - p.x))) { blocked = true; break; }
  }
  if (isAnti) {
    const targetY = stickyTarget(ry + follow.offY, spanY, p.y + rows.min) - rows.min;
    for (let i = 0; i < 2 && p.y !== targetY; i++) {
      if (!game.moveY(Math.sign(targetY - p.y))) break;
    }
  }
}

function tick(now) {
  const dt = Math.min(100, now - lastT);
  lastT = now;

  if (detect(now)) {
    const evMain = ctrl.update(info, now);
    const evHelper = helperCtrl.update(helperInfo, now);
    palmProgress = Math.max(ctrl.palmProgress, helperCtrl.palmProgress);
    victoryProgress = Math.max(ctrl.victoryProgress, helperCtrl.victoryProgress);
    handleEvents(evMain, now, 'main');
    handleEvents(evHelper, now, 'helper');
    updateCross(now);
  }

  if (state === 'calib') updateCalibration(now);
  updateMenuPointer(now);

  if (state === 'playing') {
    if (game.pieces !== pieceNo) {
      pieceNo = game.pieces;
      pieceGrabbed = ctrl.grabbed;
      hist = [];
      follow.mode = null;
      stats.spawnAt = now;
      stats.reacted = ctrl.grabbed;
    }
    followHand(dt, now);
    updateWheel(now);
    if (ctrl.grabbed) {
      const p = game.piece;
      hist.push({ t: now, x: p.x, y: p.y, shape: p.shape });
      while (hist.length && hist[0].t < now - 500) hist.shift();
    } else hist = [];
    const isAnti = antiActive(now);
    if (wasAnti && !isAnti && mode !== 'easy') {
      coach.announce('antiEnd', 'Гравитация вернулась', now, 'info', 1400);
      beep(900, 400, 'sine', 0.06, 250);
    }
    wasAnti = isAnti;
    if (landmarker) coach.checkFrame({ info, helper: helperInfo, ctrl, blocked, canAnti: (mode === 'easy' || (mode === 'normal' && anti.charges > 0)) && !isAnti }, now);

    const fall = isAnti ? 0 : ctrl.grabbed ? dt * 0.7 : dt;
    afterLock(game.update(fall));

    if (state === 'playing' && landmarker && !info && !helperInfo) {
      noHandSince = noHandSince ?? now;
      if (now - noHandSince > 1800) pause('noHand', now);
    } else noHandSince = null;
  } else if (state === 'paused' && pausedBy === 'noHand') {
    if (info || helperInfo) {
      handBackSince = handBackSince ?? now;
      if (now - handBackSince > 600) resume(now);
    } else handBackSince = null;
  }

  const ring = $('ring');
  if (ring) ring.parentElement.style.setProperty('--p', palmProgress);

  drawStage(now, dt);
  drawNext();
  updateHud(now);
  flash = Math.max(0, flash - dt / 400);
  requestAnimationFrame(tick);
}

const INK = '#1D1B18';
const PAPER = '#FFFDF8';
let U = 1;
let geo = { W: 0, H: 0, s: 20, ox: 0, oy: 0 };

function sizeStage() {

  const col = stage.closest('.stage-col');
  const cssW = Math.floor(Math.max(240, col.clientWidth - 8));
  const cssH = Math.floor(Math.max(240, col.clientHeight - 8));
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  stage.style.width = `${cssW}px`;
  stage.style.height = `${cssH}px`;
  stage.width = Math.round(cssW * dpr);
  stage.height = Math.round(cssH * dpr);
  const W = stage.width, H = stage.height;
  U = W / 900;
  const s = Math.floor((H * 0.96) / ROWS);
  geo = { W, H, s, ox: Math.round((W - s * COLS) / 2), oy: Math.round((H - s * ROWS) / 2) };
  fitVideo();
}

function fitVideo() {
  const { W, H } = geo;
  const vw = video.videoWidth || 4, vh = video.videoHeight || 3;
  const k = Math.max(W / vw, H / vh);
  geo.dw = vw * k;
  geo.dh = vh * k;
  geo.dx = (W - geo.dw) / 2;
  geo.dy = (H - geo.dh) / 2;
}

const toStage = (nx, ny) => [geo.dx + nx * geo.dw, geo.dy + ny * geo.dh];

function drawStage(now, dt) {
  const { W, H } = geo;
  if (video.readyState >= 2 && video.videoWidth) {

    sctx.save();
    sctx.translate(W, 0);
    sctx.scale(-1, 1);
    if (!geo.dw || Math.abs(geo.dw / geo.dh - video.videoWidth / video.videoHeight) > 0.01) fitVideo();
    sctx.drawImage(video, geo.dx, geo.dy, geo.dw, geo.dh);
    sctx.restore();
  } else {
    sctx.fillStyle = '#EDE7DB';
    sctx.fillRect(0, 0, W, H);
  }
  drawBoard(now, dt);
  if (helperLandmarks) drawHand(helperLandmarks, helperCtrl, helperInfo, 'helper', now);
  if (landmarks) drawHand(landmarks, ctrl, info, 'main', now);
  drawTethers();
  if (wheel) drawWheel();
  if (cross.at && cross.progress > 0) {
    const [cx, cy] = toStage(cross.at[0], cross.at[1]);
    progressRing(cx, cy, 26 * U, cross.progress, '#E4572E');
    sctx.font = `700 ${13 * U}px IBM Plex Mono, monospace`;
    sctx.fillStyle = INK;
    sctx.textAlign = 'center';
    sctx.fillText('ЗАНОВО', cx, cy - 40 * U);
    sctx.textAlign = 'left';
  }
}

function rr(ctx, x, y, w, h, r) {
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(x, y, w, h, r);
  else ctx.rect(x, y, w, h);
}

function cell(ctx, x, y, s, color, alpha = 1, lift = 0) {
  const pad = Math.max(1, s * 0.06);
  const size = s - pad * 2;
  const r = Math.max(2, s * 0.16);
  const bx = x * s + pad, by = y * s + pad;
  ctx.globalAlpha = alpha;
  if (lift) {
    ctx.fillStyle = 'rgba(29,27,24,0.22)';
    rr(ctx, bx + lift * 0.4, by + lift * 0.5, size, size, r);
    ctx.fill();
  } else {
    const sh = Math.max(1.5, s * 0.08);
    ctx.fillStyle = INK;
    rr(ctx, bx + sh, by + sh, size, size, r);
    ctx.fill();
  }
  const ox = lift ? -lift * 0.3 : 0, oy = lift ? -lift * 0.7 : 0;
  ctx.fillStyle = color;
  rr(ctx, bx + ox, by + oy, size, size, r);
  ctx.fill();
  ctx.lineWidth = Math.max(1.5, s * 0.07);
  ctx.strokeStyle = INK;
  ctx.stroke();
  ctx.globalAlpha = 1;
}

function ghostCell(ctx, x, y, s) {
  const pad = Math.max(1, s * 0.06);
  ctx.globalAlpha = 0.55;
  ctx.setLineDash([Math.max(3, s * 0.14), Math.max(3, s * 0.12)]);
  ctx.lineWidth = Math.max(1.5, s * 0.07);
  ctx.strokeStyle = INK;
  rr(ctx, x * s + pad, y * s + pad, s - pad * 2, s - pad * 2, Math.max(2, s * 0.16));
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;
}

function drawBoard(now, dt) {
  const { s, ox, oy } = geo;
  const BW = s * COLS, BH = s * ROWS;
  const isAnti = (state === 'playing' || state === 'paused') && antiActive(now);
  const active = state === 'playing' || state === 'paused';
  const ctx = sctx;
  ctx.save();
  ctx.translate(ox, oy);

  const fp = Math.max(4, s * 0.15);
  ctx.fillStyle = isAnti ? 'rgba(237,230,247,0.6)' : 'rgba(255,253,248,0.5)';
  rr(ctx, -fp, -fp, BW + fp * 2, BH + fp * 2, s * 0.5);
  ctx.fill();
  ctx.lineWidth = Math.max(2, 3 * U);
  ctx.strokeStyle = INK;
  ctx.stroke();

  if (active && ctrl.grabbed) {
    const { min, max } = filledColumns(game.piece.shape);
    ctx.fillStyle = 'rgba(242,193,78,0.25)';
    ctx.fillRect((game.piece.x + min) * s, 0, (max - min + 1) * s, BH);
  }

  const pad = Math.max(1, s * 0.06);
  ctx.fillStyle = 'rgba(246,241,231,0.45)';
  for (let y = 0; y < ROWS; y++)
    for (let x = 0; x < COLS; x++)
      if (!game.board[y][x]) {
        rr(ctx, x * s + pad, y * s + pad, s - pad * 2, s - pad * 2, Math.max(2, s * 0.16));
        ctx.fill();
      }

  if (isAnti && Math.random() < 0.35) {
    particles.push({ x: Math.random() * BW, y: BH + 6, v: 0.03 + Math.random() * 0.06, r: (3 + Math.random() * 4) * U, a: Math.random() * Math.PI });
  }
  particles = particles.filter((p) => p.y > -12);
  for (const p of particles) {
    p.y -= p.v * dt * U;
    p.a += 0.001 * dt;
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(p.a);
    ctx.globalAlpha = Math.min(0.9, p.y / BH + 0.25);
    ctx.fillStyle = '#B8A1D9';
    ctx.strokeStyle = INK;
    ctx.lineWidth = 1.5 * U;
    ctx.fillRect(-p.r, -p.r, p.r * 2, p.r * 2);
    ctx.strokeRect(-p.r, -p.r, p.r * 2, p.r * 2);
    ctx.restore();
  }

  for (let y = 0; y < ROWS; y++)
    for (let x = 0; x < COLS; x++)
      if (game.board[y][x]) {
        const bob = isAnti ? Math.sin(now / 300 + x * 0.7 + y) * s * 0.06 : 0;
        ctx.save();
        ctx.translate(0, bob);
        cell(ctx, x, y, s, COLORS[game.board[y][x]]);
        ctx.restore();
      }

  if (active) {
    const p = game.piece;
    const gy = game.ghostY();
    p.shape.forEach((row, y) =>
      row.forEach((v, x) => {
        if (v && gy + y >= 0) ghostCell(ctx, p.x + x, gy + y, s);
      })
    );

    const lift = ctrl.grabbed || isAnti ? s * 0.3 : 0;
    p.shape.forEach((row, y) =>
      row.forEach((v, x) => {
        if (v && p.y + y >= 0) cell(ctx, p.x + x, p.y + y, s, COLORS[p.type], 1, lift);
      })
    );

    if (isAnti) {
      const left = (anti.until - now) / ANTI_MS;
      ctx.fillStyle = INK;
      rr(ctx, 0, -fp * 0.6, BW, fp * 0.8, fp * 0.4);
      ctx.fill();
      ctx.fillStyle = '#B8A1D9';
      rr(ctx, 0, -fp * 0.6, BW * left, fp * 0.8, fp * 0.4);
      ctx.fill();
      ctx.fillStyle = INK;
      ctx.font = `900 ${Math.max(11, s * 0.5)}px Archivo, sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillText(`АНТИГРАВИТАЦИЯ ${((anti.until - now) / 1000).toFixed(1)}`, BW / 2, s * 0.9);
      ctx.textAlign = 'left';
    }
  }
  if (flash > 0) {
    ctx.fillStyle = `rgba(242,193,78,${flash * 0.35})`;
    ctx.fillRect(0, 0, BW, BH);
  }
  ctx.restore();
}

function drawHand(lm, gc, hi, role, now) {
  const { W, H } = geo;
  const c = sctx;
  const P = (i) => toStage(1 - lm[i].x, lm[i].y);
  const isAnti = antiActive(now);
  const idle = role === 'main' ? PAPER : '#C9D8F0';
  const boneColor = gc.grabbed ? (isAnti ? '#B8A1D9' : '#8DB580') : idle;
  c.lineCap = 'round';
  c.lineJoin = 'round';

  for (const [lw, color] of [[8 * U, INK], [4 * U, boneColor]]) {
    c.lineWidth = lw;
    c.strokeStyle = color;
    c.beginPath();
    for (const [i, j] of BONES) {
      const [x1, y1] = P(i), [x2, y2] = P(j);
      c.moveTo(x1, y1);
      c.lineTo(x2, y2);
    }
    c.stroke();
  }

  const [tx, ty] = P(4), [ix, iy] = P(8);
  const r = hi ? hi.pinchRatio : 1;
  const pinchColor = gc.grabbed ? '#8DB580' : r < CFG.HALF_PINCH_MAX ? '#F2C14E' : '#E4572E';
  for (const [lw, color] of [[8 * U, INK], [4 * U, pinchColor]]) {
    c.setLineDash(gc.grabbed ? [] : [8 * U, 8 * U]);
    c.lineWidth = lw;
    c.strokeStyle = color;
    c.beginPath();
    c.moveTo(tx, ty);
    c.lineTo(ix, iy);
    c.stroke();
  }
  c.setLineDash([]);

  c.lineWidth = 2.5 * U;
  c.strokeStyle = INK;
  for (let i = 0; i < 21; i++) {
    const [x, y] = P(i);
    const tip = i === 4 || i === 8;
    c.fillStyle = tip ? (role === 'main' ? '#F2C14E' : '#5C80BC') : PAPER;
    c.beginPath();
    c.arc(x, y, (tip ? 8 : 4.5) * U, 0, Math.PI * 2);
    c.fill();
    c.stroke();
  }

  const [wx, wy] = P(0);
  const tag = role === 'main' ? (gc.grabbed ? 'ДЕРЖИТ' : 'ГЛАВНАЯ') : 'ВТОРАЯ';
  c.font = `600 ${13 * U}px IBM Plex Mono, monospace`;
  const tw = c.measureText(tag).width + 14 * U;
  c.fillStyle = role === 'main' ? '#F2C14E' : '#C9D8F0';
  c.lineWidth = 2 * U;
  rr(c, wx - tw / 2, wy + 14 * U, tw, 22 * U, 6 * U);
  c.fill();
  c.stroke();
  c.fillStyle = INK;
  c.textAlign = 'center';
  c.fillText(tag, wx, wy + 30 * U);
  c.textAlign = 'left';

  if (gc.victoryProgress > 0) progressRing(P(12)[0], P(12)[1] - 30 * U, 18 * U, gc.victoryProgress, '#B8A1D9');

  if (gc.fistProgress > 0 && role === 'helper') progressRing(P(9)[0], P(9)[1], 30 * U, gc.fistProgress, '#E4572E');

  if (role === 'main' && gc.grabbed && !helperLandmarks) {
    const R = 50 * U;
    const base = -Math.PI / 2 + (-gc.neutralAngle * Math.PI) / 180;
    const need = (CFG.ROTATE_DEG * Math.PI) / 180;
    const cur = (gc.rotationDelta * Math.PI) / 180;
    c.lineWidth = 11 * U;
    c.strokeStyle = INK;
    c.beginPath();
    c.arc(wx, wy, R, base - need, base + need);
    c.stroke();
    c.lineWidth = 7 * U;
    c.strokeStyle = PAPER;
    c.stroke();
    c.strokeStyle = Math.abs(gc.rotationDelta) >= CFG.ROTATE_DEG ? '#8DB580' : '#F2C14E';
    c.beginPath();

    c.arc(wx, wy, R, Math.min(base, base - cur), Math.max(base, base - cur));
    c.stroke();
  }
}

function progressRing(x, y, R, p, color) {
  const c = sctx;
  c.lineWidth = 10 * U;
  c.strokeStyle = INK;
  c.beginPath();
  c.arc(x, y, R, 0, Math.PI * 2);
  c.stroke();
  c.lineWidth = 6 * U;
  c.strokeStyle = PAPER;
  c.stroke();
  c.strokeStyle = color;
  c.beginPath();
  c.arc(x, y, R, -Math.PI / 2, -Math.PI / 2 + p * Math.PI * 2);
  c.stroke();
}

function drawTethers() {
  if (!(state === 'playing' || state === 'paused') || !ctrl.grabbed || ctrl.smoothX === null) return;
  const { s, ox, oy, W, H } = geo;
  const p = game.piece;
  const cols = filledColumns(p.shape), rows = filledRows(p.shape);
  const lift = s * 0.3;
  const left = ox + (p.x + cols.min) * s - lift * 0.3;
  const right = ox + (p.x + cols.max + 1) * s - lift * 0.3;
  const cy = oy + (p.y + (rows.min + rows.max + 1) / 2) * s - lift * 0.7;
  const rope = (gc) => {
    const [hx, hy] = toStage(gc.smoothX, gc.smoothY);
    const ex = hx > (left + right) / 2 ? right : left;
    for (const [lw, color] of [[7 * U, INK], [3.5 * U, '#F2C14E']]) {
      sctx.lineWidth = lw;
      sctx.strokeStyle = color;
      sctx.beginPath();
      sctx.moveTo(hx, hy);
      sctx.lineTo(ex, cy);
      sctx.stroke();
    }
    sctx.fillStyle = '#F2C14E';
    sctx.lineWidth = 2.5 * U;
    sctx.strokeStyle = INK;
    sctx.beginPath();
    sctx.arc(ex, cy, 6 * U, 0, Math.PI * 2);
    sctx.fill();
    sctx.stroke();
  };
  rope(ctrl);
  if (wheel && helperCtrl.smoothX !== null) rope(helperCtrl);
}

function drawWheel() {
  const { W, H } = geo;
  const [mx, my] = toStage((ctrl.smoothX + helperCtrl.smoothX) / 2, (ctrl.smoothY + helperCtrl.smoothY) / 2);
  const p = Math.min(1, Math.abs(wheel.delta) / CFG.WHEEL_DEG);
  progressRing(mx, my - 50 * U, 20 * U, p, '#8DB580');
  sctx.font = `600 ${13 * U}px IBM Plex Mono, monospace`;
  sctx.fillStyle = INK;
  sctx.textAlign = 'center';
  sctx.fillText(`${Math.round(Math.abs(wheel.delta))}°/${CFG.WHEEL_DEG}°`, mx, my - 82 * U);
  sctx.textAlign = 'left';
}

function drawNext() {
  const c = nextCtx.canvas;
  nextCtx.clearRect(0, 0, c.width, c.height);
  const shape = getShape(game.next);
  const s = c.width / 5;

  const cols = filledColumns(shape), rows = filledRows(shape);
  const offX = (c.width - (cols.max - cols.min + 1) * s) / 2 - cols.min * s;
  const offY = (c.height - (rows.max - rows.min + 1) * s) / 2 - rows.min * s;
  nextCtx.save();
  nextCtx.translate(offX, offY);
  shape.forEach((row, y) => row.forEach((v, x) => v && cell(nextCtx, x, y, s, COLORS[game.next])));
  nextCtx.restore();
}

let lastHintId = null;
function updateHud(now) {
  $('score').textContent = game.score;
  $('lines').textContent = game.lines;
  $('level').textContent = game.level;

  const handsN = (info ? 1 : 0) + (helperInfo ? 1 : 0);
  $('chipHand').textContent = `руки: ${handsN} из 2`;
  $('chipHand').className = 'chip ' + (handsN === 2 ? 'ok' : handsN === 0 ? 'bad' : '');
  $('chipPinch').textContent = ctrl.grabbed ? 'щипок: держу' : info ? `щипок: ${Math.round(info.pinchRatio * 100)}%` : 'щипок: —';
  $('chipPinch').className = 'chip ' + (ctrl.grabbed ? 'ok' : '');
  $('chipAngle').textContent = wheel
    ? `руль: ${Math.round(wheel.delta)}° / ${CFG.WHEEL_DEG}°`
    : ctrl.grabbed ? `кисть: ${Math.round(ctrl.rotationDelta)}° / ${CFG.ROTATE_DEG}°` : 'поворот: —';

  const isAnti = (state === 'playing' || state === 'paused') && antiActive(now);
  $('antiCells').innerHTML = mode === 'normal'
    ? Array.from({ length: ANTI_MAX }, (_, i) => `<span class="cell ${i < anti.charges ? 'on' : ''}"></span>`).join('')
    : mode === 'easy' ? '<b class="inf">∞</b>' : '';
  $('antiText').textContent =
    mode === 'hard' ? 'В режиме «Хард» её нет'
    : isAnti
      ? `Действует ещё ${((anti.until - now) / 1000).toFixed(1)} с — фигура следует за рукой вверх и вниз`
      : mode === 'easy' || anti.charges > 0
        ? `Держи фигуру одной рукой, а другой покажи знак мира ✌️${mode === 'easy' ? ' — сколько угодно раз' : ''}`
        : `Собери ещё ${LINES_PER_CHARGE - anti.lines} лин. для заряда`;
  $('chipMode').textContent = `режим: ${MODES[mode].name}`;
  $('anti').classList.toggle('active', isAnti);
  $('anti').style.setProperty('--vp', victoryProgress);

  const box = $('coach');
  const hint = state === 'playing' ? coach.hint(now) : null;
  if (hint) {
    if (hint.id !== lastHintId && hint.kind === 'warn') {
      beep(300, 90, 'sine', 0.06);
      speak(hint.text);
    }
    $('coachText').textContent = hint.text;
    box.className = 'coach ' + hint.kind;
    lastHintId = hint.id;
  } else {
    lastHintId = null;
    box.className = 'coach';
    $('coachText').textContent =
      state === 'playing'
        ? wheel
          ? 'Крути руки, как руль, — фигура повернётся'
          : ctrl.grabbed
            ? 'Фигура в руке. Щипок второй рукой — руль, знак мира ✌️ — антигравитация. Разожми пальцы — упадёт'
            : 'Сделай щипок любой рукой, чтобы взять фигуру'
        : state === 'calib'
          ? 'Калибровка: следуй шагам на экране'
          : 'Встань так, чтобы рука была видна в кадре';
  }
}

window.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && state !== 'playing' && state !== 'paused' && state !== 'calib') startGame(mode);
  if (state === 'menu' && ['1', '2', '3'].includes(e.key)) startGame(['easy', 'normal', 'hard'][+e.key - 1]);
  if ((e.key === 'r' || e.key === 'к') && state !== 'intro' && state !== 'calib') {
    restartGame(performance.now());
    return;
  }
  if (e.key === 'p' || e.key === 'з') {
    if (state === 'playing') pause('user', performance.now());
    else if (state === 'paused') resume(performance.now());
    return;
  }
  if (state !== 'playing') return;
  if (e.key === 'ArrowLeft') game.move(-1);
  if (e.key === 'ArrowRight') game.move(1);
  if (e.key === 'ArrowUp') game.rotate(1);
  if (e.key === 'ArrowDown') afterLock(game.softStep());
  if (e.key === ' ') afterLock(game.hardDrop());
  if (e.key === 'a' || e.key === 'ф') tryAntigravity(performance.now());
});

$('startBtn').addEventListener('click', startCamera);
$('calibBtn').addEventListener('click', () => {
  if (state !== 'playing') startCalibration();
});
$('voiceBtn').addEventListener('click', () => {
  voiceOn = !voiceOn;
  safeSet('handtris-voice', voiceOn);
  if (!voiceOn && 'speechSynthesis' in window) speechSynthesis.cancel();
  renderVoiceBtn();
});
if ('speechSynthesis' in window) speechSynthesis.getVoices();
window.addEventListener('resize', sizeStage);
mode = MODES[safeGet('handtris-mode', 'normal')] ? safeGet('handtris-mode', 'normal') : 'normal';
renderVoiceBtn();
sizeStage();
renderRecords();
requestAnimationFrame(tick);
