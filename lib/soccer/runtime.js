// 게임 루프 + 입력 + HUD. React 컴포넌트는 메뉴/오버레이만 담당하고 실제 게임은 여기서 돌아감
import { Soccer, SWEET_LO, SWEET_HI } from './engine';
import { Scene3D, P_COLORS } from './scene3d';
import { Sound } from './sound';
import { BINDINGS, CONTROL_GUIDE } from './teams';
import { matchTeams } from './clubs';
import { FORMATIONS, STYLES, STYLE_ORDER } from './formations';

const { Game, W, H, BOX_DEPTH, BOX_HALF } = Soccer;
const STEP = 1 / 60;
const BLOCK = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'Tab']);

export function createRuntime({ glCanvas, hudCanvas, onPauseChange, onResult }) {
  const scene = new Scene3D(glCanvas);
  const hud = hudCanvas.getContext('2d');
  let game = null, opts = null, paused = false, resultTimer = -1, toast = null, raf = 0;
  let cssW = 0, cssH = 0, dpr = 1, crestImgs = [];

  // ================= 크기 =================
  function resize() {
    const el = glCanvas.parentElement;
    cssW = el.clientWidth; cssH = el.clientHeight;
    dpr = Math.min(1.5, window.devicePixelRatio || 1);
    scene.resize(cssW, cssH);
    hudCanvas.width = Math.round(cssW * dpr); hudCanvas.height = Math.round(cssH * dpr);
  }
  resize();
  window.addEventListener('resize', resize);

  // ================= 입력 =================
  const keys = new Set(), latch = new Set();
  const held = c => keys.has(c) || latch.has(c);
  const anyHeld = arr => arr.some(held);

  function onKeyDown(e) {
    if (!game) return;
    if (BLOCK.has(e.code)) e.preventDefault();
    Sound.init();
    if (e.repeat) return;
    keys.add(e.code); latch.add(e.code);
    if (e.code === 'Escape' || e.code === 'KeyP') togglePause();
    if (e.code === 'KeyM') showToast(Sound.toggleMute() ? '소리 끔' : '소리 켬');
    if (e.code === 'KeyC') showToast(scene.cycleCamera());
    if (!paused) tacticKey(e.code);
  }
  // 경기 중 전술 변경 (1P 팀): 1~6 스타일, B 포메이션, 7/8 압박, 9/0 수비 라인
  const lvl = v => (v < 0.35 ? '낮음' : v < 0.65 ? '보통' : '높음');
  function tacticKey(code) {
    if (!game || replay) return;
    const t = game.teams[0];
    if (!t.human) return;
    const tac = t.tactics;
    const m = /^Digit([0-9])$/.exec(code);
    if (m) {
      const d = +m[1];
      if (d >= 1 && d <= 6) {
        const st = STYLE_ORDER[d - 1];
        game.setTactics(0, { style: st });
        showToast(`전술: ${STYLES[st].label}`);
      } else if (d === 7 || d === 8) {
        game.setTactics(0, { press: Math.max(0.05, Math.min(1, tac.press + (d === 8 ? 0.2 : -0.2))) });
        showToast(`압박: ${lvl(tac.press)}`);
      } else if (d === 9 || d === 0) {
        game.setTactics(0, { line: Math.max(0.05, Math.min(1, tac.line + (d === 0 ? 0.2 : -0.2))) });
        showToast(`수비 라인: ${lvl(tac.line)}`);
      }
    } else if (code === 'KeyB') {
      const list = Object.keys(FORMATIONS[t.size]);
      const next = list[(list.indexOf(tac.formation) + 1) % list.length];
      game.setTactics(0, { formation: next });
      showToast(`포메이션: ${next}`);
    }
  }
  const onKeyUp = e => keys.delete(e.code);
  const onBlur = () => keys.clear();
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', onBlur);

  function readKeys(b) {
    return {
      mx: (anyHeld(b.right) ? 1 : 0) - (anyHeld(b.left) ? 1 : 0),
      my: (anyHeld(b.down) ? 1 : 0) - (anyHeld(b.up) ? 1 : 0),
      pass: anyHeld(b.pass), shoot: anyHeld(b.shoot), through: anyHeld(b.through), lob: anyHeld(b.lob),
      sprint: anyHeld(b.sprint), switch: anyHeld(b.switch),
      fin: anyHeld(b.fin || []), chip: anyHeld(b.chip || []), drive: anyHeld(b.drive || []), skill: anyHeld(b.skill || []),
    };
  }

  // 게임패드: A 패스 / B 슛 / Y 스루패스 / RT·RB 질주 / LB 전환 / Start 일시정지 / Back 카메라
  const padPrev = [];
  function readPad(index) {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    const gp = pads && pads[index];
    if (!gp) return null;
    const btn = i => !!(gp.buttons[i] && gp.buttons[i].pressed);
    let mx = gp.axes[0] || 0, my = gp.axes[1] || 0;
    if (Math.hypot(mx, my) < 0.25) { mx = 0; my = 0; }
    if (btn(14)) mx = -1; if (btn(15)) mx = 1; if (btn(12)) my = -1; if (btn(13)) my = 1;
    const prev = padPrev[index] || {};
    if (btn(9) && !prev.start) togglePause();
    if (btn(8) && !prev.back) showToast(scene.cycleCamera());
    padPrev[index] = { start: btn(9), back: btn(8) };
    return { mx, my, pass: btn(0), shoot: btn(1), through: btn(3), lob: btn(2), sprint: btn(7) || btn(5), switch: btn(4), fin: btn(6), chip: btn(10), drive: btn(11) };
  }

  function merge(a, b) {
    if (!b) return a;
    const out = {};
    for (const k of Object.keys(a)) out[k] = (k === 'mx' || k === 'my') ? (Math.abs(b[k]) > Math.abs(a[k]) ? b[k] : a[k]) : a[k] || b[k];
    return out;
  }

  function feedInputs() {
    if (opts.mode === '1p') {
      game.setInput(0, merge(readKeys(BINDINGS.single), readPad(0)));
    } else if (opts.mode === '2p') {
      game.setInput(0, merge(readKeys(BINDINGS.p1), readPad(0)));
      game.setInput(1, merge(readKeys(BINDINGS.p2), readPad(1)));
    } else {
      readPad(0);
    }
  }

  // ================= 진행 제어 =================
  function showToast(text) { toast = { text, t: 1.4 }; }

  function setPaused(v) {
    if (!game || game.state === 'fulltime') return;
    paused = v;
    keys.clear();
    onPauseChange && onPauseChange(paused);
  }
  function togglePause() { setPaused(!paused); }

  function start(o) {
    opts = o; qLevel = null; avgMs = 16.7; fastT = 0; resCool = 4;
    const humans = o.mode === '1p' ? [true, false] : o.mode === '2p' ? [true, true] : [false, false];
    // 사람이 고른 포메이션/전술 ('auto'면 AI가 팀 능력치에 맞춰 정함)
    // (팀 선택 화면의 라인업 편집 결과: o.lineup[클럽번호] = { formation, style, order })
    const tactics = [0, 1].map(i => {
      const L = (o.lineup && o.lineup[o.team[i]]) || {};
      return { formation: L.formation, style: L.style, order: +o.size === 11 ? L.order : undefined };
    });
    game = new Game({
      teamSize: +o.size, matchSeconds: +o.time, difficulty: o.diff, realistic: o.rules !== 'arcade', humans, tactics,
      teams: matchTeams(o.team[0], o.team[1]),
    });
    rec = []; replay = null; pendingReplay = -1; banner = null;
    // 점수판용 엠블럼 이미지
    crestImgs = game.teams.map(t => { const im = new Image(); im.src = t.info.crest || ''; return im; });
    showBanner(`${game.teams[0].info.name}  vs  ${game.teams[1].info.name}`, null, 4);
    // 개발 모드에서만: 콘솔/테스트에서 경기 상태 확인용
    if (new URLSearchParams(window.location.search).has('debug')) window.__soccer = { game, scene, isReplay: () => !!replay };
    setVisual(o);
    scene.setGame(game);
    paused = false; resultTimer = -1;
    keys.clear(); latch.clear();
    Sound.init();
    Sound.setCrowd(0.05);
  }

  function setVisual(o) {
    if (o.quality) scene.setQuality(o.quality);
    if (o.tod) scene.setTimeOfDay(o.tod);
    if (o.weather) { scene.setWeather(o.weather); Sound.setRain(o.weather === 'rain' && game ? 1 : 0); }
  }

  function toMenu() {
    Sound.setRain(0);
    game = null; paused = false; replay = null; pendingReplay = -1;
    scene.setGame(null);
    Sound.setCrowd(0);
  }

  // ================= 리플레이 =================
  // 최근 몇 초의 선수/공 위치를 기록해 두었다가 골이 들어가면 다른 카메라로 다시 보여줌
  let rec = [], replay = null, pendingReplay = -1, goalTime = 0, goalX = 0, banner = null;

  function snapshot() {
    const b = game.ball;
    return {
      t: game.time,
      p: game.players.map(p => [p.x, p.y, p.fx, p.fy, p.vx, p.vy, p.stun, p.tackle ? { ...p.tackle } : null]),
      b: [b.x, b.y, b.z, b.vx, b.vy], owner: b.owner, kicker: b.lastKicker,
    };
  }
  function applySnap(sn) {
    game.players.forEach((p, i) => {
      const a = sn.p[i];
      p.x = a[0]; p.y = a[1]; p.fx = a[2]; p.fy = a[3]; p.vx = a[4]; p.vy = a[5]; p.stun = a[6];
      p.tackle = a[7] ? { ...a[7] } : null;
    });
    const b = game.ball;
    [b.x, b.y, b.z, b.vx, b.vy] = sn.b;
    b.owner = sn.owner; b.lastKicker = sn.kicker;
  }
  function startReplay() {
    const frames = rec.filter(f => f.t >= goalTime - 4.5);
    if (frames.length < 10) return;
    replay = { frames, i: 0, clock: frames[0].t, saved: snapshot(), age: 0 };
  }
  function endReplay() {
    if (!replay) return;
    applySnap(replay.saved);
    replay = null;
    scene.endReplay();
    keys.clear(); latch.clear();
  }
  function stepReplay(dt) {
    const r = replay;
    r.age += dt;
    // 골 직전은 슬로모션
    const slow = r.clock > goalTime - 1.1 && r.clock < goalTime + 0.4;
    r.clock += dt * (slow ? 0.4 : 1);
    while (r.i < r.frames.length - 1 && r.frames[r.i + 1].t <= r.clock) r.i++;
    applySnap(r.frames[r.i]);
    if (r.i >= r.frames.length - 1) endReplay();
  }

  function showBanner(text, color, t) { banner = { text, color, t, max: t }; }

  // ================= 루프 =================
  let last = performance.now(), acc = 0;
  // 렉 방지: 프레임 시간을 재서 해상도를 부드럽게 낮추고/올림. 해상도가 바닥이면 그래픽 단계를 낮춤
  let avgMs = 16.7, fastT = 0, resCool = 3, qLevel = null;
  function adaptQuality(rawMs, dt) {
    if (!game || paused || replay || document.hidden) { resCool = Math.max(resCool, 1.5); return; }
    avgMs += (Math.min(rawMs, 100) - avgMs) * 0.08;
    resCool -= dt;
    if (resCool > 0) return;
    if (avgMs > 21.5) {
      // 50fps 아래: 해상도를 낮춤 (심하면 더 많이)
      fastT = 0;
      const next = scene.resScale - (avgMs > 32 ? 0.18 : 0.09);
      if (next >= 0.55) { scene.setResScale(next); resCool = 1.4; return; }
      const order = ['ultra', 'high', 'medium', 'low'];
      const cur = order.indexOf(scene.quality);
      if (cur >= 0 && cur < order.length - 1) {
        qLevel = order[cur + 1];
        scene.setQuality(qLevel);
        scene.setResScale(0.9);
        resCool = 2.5; avgMs = 16.7;
        showToast('렉 감지: 그래픽을 ' + { high: '높음', medium: '보통', low: '낮음' }[qLevel] + '으로 낮췄어요');
      }
    } else if (avgMs < 17.9 && scene.resScale < 1) {
      // 여유가 있으면 해상도를 천천히 되돌림
      fastT += dt;
      if (fastT > 5) { fastT = 0; scene.setResScale(scene.resScale + 0.06); resCool = 2; }
    } else fastT = 0;
  }
  function frame(now) {
    const rawMs = now - last;
    const dt = Math.min(0.1, rawMs / 1000);
    last = now;
    adaptQuality(rawMs, dt);
    if (toast) { toast.t -= dt; if (toast.t <= 0) toast = null; }
    if (banner && !replay) { banner.t -= dt; if (banner.t <= 0) banner = null; }
    if (game && !paused && replay) {
      // 아무 키나 누르면 리플레이 건너뛰기
      if (replay.age > 0.4 && latch.size) endReplay(); else stepReplay(dt);
      latch.clear();
    } else if (game && !paused) {
      feedInputs();
      acc += dt;
      let steps = 0;
      while (acc >= STEP && steps < 6) { game.update(STEP); acc -= STEP; steps++; }
      if (steps > 0) latch.clear();
      for (const e of game.events) {
        Sound.play(e);
        scene.onEvent(e);
        if (e.type === 'fulltime') resultTimer = 2.2;
        if (e.type === 'goal') {
          goalTime = game.time;
          goalX = game.ball.x < W / 2 ? 0 : W;
          pendingReplay = 1.4;
          const g = game.goals[game.goals.length - 1];
          const t = game.teams[e.team];
          showBanner('⚽  ' + (g.name || '') + (g.own ? ' (자책골)' : '') + '  ' + g.minute + "'", t.info.color, 5.5);
        }
      }
      game.events.length = 0;
      rec.push(snapshot());
      while (rec.length && rec[0].t < game.time - 7) rec.shift();
      if (pendingReplay > 0) {
        pendingReplay -= dt;
        if (pendingReplay <= 0) { pendingReplay = -1; startReplay(); }
      }
      // 공이 골문에 가까울수록 관중 함성이 커짐
      const d = Math.min(Math.abs(game.ball.x), Math.abs(W - game.ball.x));
      Sound.setCrowd(0.035 + Math.max(0, Math.min(1, 1 - (d - 150) / 450)) * 0.09);
      if (resultTimer > 0) {
        resultTimer -= dt;
        if (resultTimer <= 0) onResult && onResult(game.summary(), game.teams.map(t => t.info));
      }
    } else {
      latch.clear();
    }
    const controlled = game && !replay ? controlledList() : [];
    scene.update(paused ? 0 : dt, controlled, { replay: !!replay, goalX });
    drawHud(controlled);
    raf = requestAnimationFrame(frame);
  }
  raf = requestAnimationFrame(frame);

  function controlledList() {
    if (game.state === 'fulltime') return [];
    if (opts.mode === '1p') return [game.teams[0].controlled];
    if (opts.mode === '2p') return [game.teams[0].controlled, game.teams[1].controlled];
    return [];
  }

  // ================= HUD =================
  function roundRect(x, y, w, h, r) {
    hud.beginPath();
    hud.moveTo(x + r, y); hud.arcTo(x + w, y, x + w, y + h, r); hud.arcTo(x + w, y + h, x, y + h, r);
    hud.arcTo(x, y + h, x, y, r); hud.arcTo(x, y, x + w, y, r); hud.closePath();
  }

  function drawHud(controlled) {
    hud.setTransform(1, 0, 0, 1, 0, 0);
    hud.clearRect(0, 0, hudCanvas.width, hudCanvas.height);
    if (!game) return;
    hud.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (replay) { drawReplay(); return; }
    drawCarrierName(controlled);
    controlled.forEach((p, i) => p && drawPlayerHud(p, i));
    drawScoreboard();
    drawRadar(controlled);
    drawMessage();
    drawBanner();
    drawGuide();
    if (toast) {
      hud.font = '600 14px system-ui, sans-serif';
      hud.textAlign = 'center'; hud.textBaseline = 'middle';
      const w = hud.measureText(toast.text).width + 28;
      hud.globalAlpha = Math.min(1, toast.t * 3);
      hud.fillStyle = 'rgba(10,18,14,0.85)';
      roundRect(cssW / 2 - w / 2, 70, w, 32, 16); hud.fill();
      hud.fillStyle = '#fff'; hud.fillText(toast.text, cssW / 2, 86);
      hud.globalAlpha = 1;
    }
  }

  function drawPlayerHud(p, slot) {
    const s = scene.project(p.x, p.y, 4.9);
    if (!s.visible) return;
    hud.font = '800 13px system-ui, sans-serif';
    hud.textAlign = 'center'; hud.textBaseline = 'bottom';
    hud.lineWidth = 3; hud.strokeStyle = 'rgba(0,0,0,0.6)';
    const label = (opts.mode === '2p' ? `${slot + 1}P` : '1P') + (p.name ? ' ' + p.name : '');
    hud.strokeText(label, s.x, s.y);
    hud.fillStyle = P_COLORS[slot]; hud.fillText(label, s.x, s.y);
    let y = s.y - 24;
    if (p.charging) {
      const w = 54, x = s.x - w / 2;
      hud.fillStyle = 'rgba(0,0,0,0.65)'; hud.fillRect(x - 2, y - 2, w + 4, 10);
      const g = hud.createLinearGradient(x, 0, x + w, 0);
      g.addColorStop(0, '#facc15'); g.addColorStop(0.7, '#f97316'); g.addColorStop(1, '#ef4444');
      const sw = p.charge >= SWEET_LO && p.charge <= SWEET_HI;
      hud.fillStyle = 'rgba(74,222,128,0.4)'; hud.fillRect(x + w * SWEET_LO, y - 1, w * (SWEET_HI - SWEET_LO), 8);   // 스위트 스팟
      hud.fillStyle = sw ? '#4ade80' : g; hud.fillRect(x, y, w * p.charge, 6);
      if (sw) { hud.shadowColor = '#4ade80'; hud.shadowBlur = 10; hud.fillRect(x, y, w * p.charge, 6); hud.shadowBlur = 0; }
      y -= 12;
      const kn = { finesse: '감아차기', chip: '칩슛', drive: '강슛' }[p.shotKind];
      if (kn) {
        hud.font = '800 12px system-ui, sans-serif'; hud.fillStyle = '#facc15';
        hud.lineWidth = 3; hud.strokeStyle = 'rgba(0,0,0,0.7)';
        hud.strokeText(kn, s.x, y + 2); hud.fillText(kn, s.x, y + 2);
        y -= 14;
      }
    }
    if (p.stamina < 0.99) {
      const w = 34, x = s.x - w / 2;
      hud.fillStyle = 'rgba(0,0,0,0.55)'; hud.fillRect(x, y + 2, w, 4);
      hud.fillStyle = p.stamina > 0.3 ? '#a3e635' : '#f87171';
      hud.fillRect(x, y + 2, w * p.stamina, 4);
    }
  }

  // 공을 가진 선수 이름 (조작 중인 선수는 이미 표시되므로 제외)
  function drawCarrierName(controlled) {
    const o = game.ball.owner;
    if (!o || !o.name || controlled.includes(o) || game.state !== 'play') return;
    const s = scene.project(o.x, o.y, 4.3);
    if (!s.visible) return;
    hud.font = '700 12px system-ui, sans-serif';
    hud.textAlign = 'center'; hud.textBaseline = 'bottom';
    const w = hud.measureText(o.name).width + 14;
    hud.fillStyle = 'rgba(8,14,24,0.75)';
    roundRect(s.x - w / 2, s.y - 19, w, 19, 5); hud.fill();
    hud.fillStyle = o.team.info.color;
    hud.fillRect(s.x - w / 2 + 4, s.y - 3, w - 8, 2);
    hud.fillStyle = '#fff';
    hud.fillText(o.name, s.x, s.y - 4);
  }

  // 화면 아래 자막 (경기 소개, 득점자)
  function drawBanner() {
    if (!banner) return;
    const age = banner.max - banner.t;
    const a = Math.min(1, age * 4, banner.t * 2);
    hud.save();
    hud.globalAlpha = a;
    hud.font = '800 22px system-ui, sans-serif';
    const w = hud.measureText(banner.text).width + 60;
    const x = cssW / 2 - w / 2 + (1 - Math.min(1, age * 3)) * -40;
    const y = cssH * 0.62;
    hud.fillStyle = 'rgba(8,14,24,0.9)';
    roundRect(x, y, w, 48, 10); hud.fill();
    if (banner.color) { hud.fillStyle = banner.color; hud.fillRect(x, y, 8, 48); }
    hud.fillStyle = '#fff'; hud.textAlign = 'center'; hud.textBaseline = 'middle';
    hud.fillText(banner.text, x + w / 2 + 4, y + 25);
    hud.restore();
  }

  // 리플레이 화면: 위아래 검은 띠 + REPLAY 표시
  function drawReplay() {
    const bar = cssH * 0.09;
    hud.fillStyle = '#000';
    hud.fillRect(0, 0, cssW, bar); hud.fillRect(0, cssH - bar, cssW, bar);
    const blink = (Math.sin(performance.now() / 250) + 1) / 2;
    hud.fillStyle = `rgba(239,68,68,${0.5 + blink * 0.5})`;
    hud.beginPath(); hud.arc(28, bar / 2, 7, 0, Math.PI * 2); hud.fill();
    hud.font = 'italic 900 24px system-ui, sans-serif';
    hud.fillStyle = '#fff'; hud.textAlign = 'left'; hud.textBaseline = 'middle';
    hud.fillText('REPLAY', 44, bar / 2 + 1);
    hud.font = '13px system-ui, sans-serif'; hud.textAlign = 'right';
    hud.fillStyle = 'rgba(255,255,255,0.7)';
    hud.fillText('아무 키나 누르면 건너뛰기', cssW - 20, cssH - bar / 2);
    if (banner) {
      hud.font = '800 20px system-ui, sans-serif'; hud.textAlign = 'center';
      hud.fillStyle = '#fff';
      hud.fillText(banner.text, cssW / 2, cssH - bar / 2);
    }
  }

  function drawScoreboard() {
    const t0 = game.teams[0], t1 = game.teams[1];
    const narrow = cssW < 600;
    const font = `700 ${narrow ? 12 : 15}px system-ui, sans-serif`;
    hud.font = font;
    const n0 = t0.info.name, n1 = t1.info.name;
    const w0 = hud.measureText(n0).width, w1 = hud.measureText(n1).width;
    const scoreW = narrow ? 52 : 66, timeW = narrow ? 58 : 70, pad = 12, sw = narrow ? 20 : 26;
    const h = narrow ? 30 : 38, x = 16, y = 16;
    const total = pad + sw + 8 + w0 + 12 + scoreW + 12 + w1 + 8 + sw + pad + timeW;
    hud.fillStyle = 'rgba(8,14,24,0.88)';
    roundRect(x, y, total, h, 8); hud.fill();
    let cx = x + pad;
    const mid = y + h / 2;
    hud.textBaseline = 'middle';
    // 엠블럼 (이미지가 없으면 팀 색 칩)
    const chip = (c, i) => {
      const im = crestImgs[i];
      if (im && im.complete && im.naturalWidth) {
        const r = Math.min(sw / im.naturalWidth, sw / im.naturalHeight);
        const w = im.naturalWidth * r, hh = im.naturalHeight * r;
        hud.fillStyle = 'rgba(255,255,255,0.92)';
        hud.beginPath(); hud.arc(cx + sw / 2, mid, sw / 2 + 2, 0, Math.PI * 2); hud.fill();
        const k = 0.78;
        hud.drawImage(im, cx + (sw - w * k) / 2, mid - hh * k / 2, w * k, hh * k);
      } else { hud.fillStyle = c; roundRect(cx, mid - 7, sw, 14, 3); hud.fill(); }
    };
    chip(t0.info.color, 0); cx += sw + 8;
    hud.fillStyle = '#f1f5f9'; hud.textAlign = 'left'; hud.fillText(n0, cx, mid); cx += w0 + 12;
    hud.fillStyle = '#f8fafc'; hud.fillRect(cx, y + 5, scoreW, h - 10);
    hud.fillStyle = '#0f172a'; hud.textAlign = 'center';
    hud.font = `900 ${narrow ? 15 : 20}px system-ui, sans-serif`;
    hud.fillText(`${t0.score} - ${t1.score}`, cx + scoreW / 2, mid + 1); cx += scoreW + 12;
    hud.font = font;
    hud.fillStyle = '#f1f5f9'; hud.textAlign = 'left'; hud.fillText(n1, cx, mid); cx += w1 + 8;
    chip(t1.info.color, 1); cx += sw + pad;
    hud.fillStyle = '#22c55e';
    roundRect(cx, y, timeW, h, 8); hud.fill();
    hud.fillRect(cx, y, 8, h);
    const tm = game.displayTime;
    hud.fillStyle = '#052e16'; hud.textAlign = 'center';
    hud.font = `800 ${narrow ? 13 : 16}px ui-monospace, Consolas, monospace`;
    hud.fillText(`${String(tm.m).padStart(2, '0')}:${String(tm.s).padStart(2, '0')}`, cx + timeW / 2, mid + 1);
  }

  function drawRadar(controlled) {
    const rw = Math.min(230, cssW * 0.36), rh = rw * H / W;
    const x = (cssW - rw) / 2, y = cssH - rh - 14;
    const k = rw / W;
    hud.fillStyle = 'rgba(10,30,18,0.82)';
    roundRect(x - 4, y - 4, rw + 8, rh + 8, 6); hud.fill();
    hud.strokeStyle = 'rgba(255,255,255,0.35)'; hud.lineWidth = 1;
    hud.strokeRect(x, y, rw, rh);
    hud.beginPath(); hud.moveTo(x + rw / 2, y); hud.lineTo(x + rw / 2, y + rh); hud.stroke();
    hud.strokeRect(x, y + (H / 2 - BOX_HALF) * k, BOX_DEPTH * k, BOX_HALF * 2 * k);
    hud.strokeRect(x + rw - BOX_DEPTH * k, y + (H / 2 - BOX_HALF) * k, BOX_DEPTH * k, BOX_HALF * 2 * k);
    for (const t of game.teams) {
      for (const p of t.players) {
        const ci = controlled.indexOf(p);
        hud.fillStyle = p.isGK ? t.info.gk : t.info.color;
        hud.beginPath(); hud.arc(x + p.x * k, y + p.y * k, ci >= 0 ? 4.5 : 3.2, 0, Math.PI * 2); hud.fill();
        hud.strokeStyle = ci >= 0 ? P_COLORS[ci] : 'rgba(255,255,255,0.6)';
        hud.lineWidth = ci >= 0 ? 2 : 0.8; hud.stroke();
      }
    }
    hud.fillStyle = '#ffffff';
    hud.beginPath(); hud.arc(x + game.ball.x * k, y + game.ball.y * k, 2.5, 0, Math.PI * 2); hud.fill();
  }

  function drawMessage() {
    const m = game.message;
    if (!m) return;
    const age = m.max - m.t;
    const alpha = Math.min(1, age * 5, m.t * 3);
    const pop = m.big ? 1 + Math.max(0, 0.25 - age) * 1.6 : 1;
    hud.save();
    hud.globalAlpha = alpha;
    hud.translate(cssW / 2, cssH * 0.3);
    hud.scale(pop, pop);
    const size = m.big ? Math.min(92, cssW / 8) : Math.min(38, cssW / 14);
    hud.font = `italic 900 ${size}px system-ui, sans-serif`;
    hud.textAlign = 'center'; hud.textBaseline = 'middle';
    hud.lineWidth = m.big ? 9 : 5; hud.strokeStyle = 'rgba(0,0,0,0.7)';
    hud.strokeText(m.text, 0, 0);
    hud.fillStyle = m.text === 'GOAL!' ? '#facc15' : '#ffffff';
    hud.fillText(m.text, 0, 0);
    hud.restore();
  }

  // 왼쪽 아래 키 안내
  function drawGuide() {
    const sets = opts.mode === '1p' ? [['', CONTROL_GUIDE.single]]
      : opts.mode === '2p' ? [['1P', CONTROL_GUIDE.p1], ['2P', CONTROL_GUIDE.p2]] : [];
    if (cssW < 700) return;
    hud.textBaseline = 'middle';
    let baseX = 16;
    for (const [title, rows] of sets) {
      const lineH = 22, h = rows.length * lineH + (title ? 24 : 10) + 8;
      const y0 = cssH - h - 16, w = 232;
      hud.fillStyle = 'rgba(8,14,24,0.72)';
      roundRect(baseX, y0, w, h, 10); hud.fill();
      let y = y0 + 14;
      if (title) {
        hud.font = '800 12px system-ui, sans-serif'; hud.textAlign = 'left';
        hud.fillStyle = P_COLORS[title === '1P' ? 0 : 1]; hud.fillText(title, baseX + 12, y);
        y += 20;
      } else y += 2;
      for (const [label, ks] of rows) {
        hud.font = '700 11px system-ui, sans-serif'; hud.textAlign = 'center';
        let kx = baseX + 12;
        for (const k of ks) {
          const kw = Math.max(20, hud.measureText(k).width + 10);
          hud.fillStyle = '#e2e8f0'; roundRect(kx, y - 9, kw, 18, 4); hud.fill();
          hud.fillStyle = '#0f172a'; hud.fillText(k, kx + kw / 2, y + 1);
          kx += kw + 3;
        }
        hud.font = '12px system-ui, sans-serif'; hud.textAlign = 'left';
        hud.fillStyle = 'rgba(255,255,255,0.85)';
        hud.fillText(label, Math.max(kx + 8, baseX + 112), y + 1);
        y += lineH;
      }
      baseX += w + 10;
    }
    hud.font = '12px system-ui, sans-serif'; hud.textAlign = 'right';
    hud.fillStyle = 'rgba(255,255,255,0.6)';
    hud.fillText('Esc 일시정지 · C 카메라 · M 소리', cssW - 16, cssH - 18);
  }

  // 개발/테스트용: ?debug 로 열면 콘솔에서 경기를 바로 시작할 수 있음
  if (new URLSearchParams(window.location.search).has('debug')) window.__rt = { start, scene, getGame: () => game };

  return {
    start, toMenu, setPaused, setVisual,
    destroy() {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', resize);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
      Sound.setCrowd(0);
      Sound.setRain(0);
      scene.dispose();
    },
  };
}
