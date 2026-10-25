// 화면 그리기, 입력, 사운드, 메뉴
(function () {
  'use strict';
  const S = window.Soccer;
  const { W, H, PR, BR } = S;

  // ================= 팀 목록 =================
  const TEAMS = [
    { name: '레드 드래곤즈', color: '#dc2626', color2: '#ffffff', gk: '#facc15' },
    { name: '블루 타이거즈', color: '#2563eb', color2: '#ffffff', gk: '#f97316' },
    { name: '그린 이글스', color: '#15803d', color2: '#fef08a', gk: '#e879f9' },
    { name: '골드 라이온즈', color: '#eab308', color2: '#1c1917', gk: '#22d3ee' },
    { name: '블랙 팬서스', color: '#18181b', color2: '#facc15', gk: '#a3e635' },
    { name: '오렌지 피닉스', color: '#ea580c', color2: '#ffffff', gk: '#38bdf8' },
    { name: '화이트 울브스', color: '#f1f5f9', color2: '#0f172a', gk: '#fb7185' },
    { name: '퍼플 나이츠', color: '#7c3aed', color2: '#ffffff', gk: '#bef264' },
  ];

  const opts = { mode: '1p', size: '7', time: '240', diff: 'normal', team: [0, 1] };

  // ================= 입력 =================
  const BINDINGS = {
    single: {
      up: ['KeyW', 'ArrowUp'], down: ['KeyS', 'ArrowDown'], left: ['KeyA', 'ArrowLeft'], right: ['KeyD', 'ArrowRight'],
      pass: ['KeyJ', 'KeyF'], shoot: ['KeyK', 'KeyG'], sprint: ['ShiftLeft', 'ShiftRight'], switch: ['KeyL', 'KeyQ'],
    },
    p1: {
      up: ['KeyW'], down: ['KeyS'], left: ['KeyA'], right: ['KeyD'],
      pass: ['KeyF'], shoot: ['KeyG'], sprint: ['ShiftLeft'], switch: ['KeyQ'],
    },
    p2: {
      up: ['ArrowUp'], down: ['ArrowDown'], left: ['ArrowLeft'], right: ['ArrowRight'],
      pass: ['KeyK', 'Numpad1'], shoot: ['KeyL', 'Numpad2'], sprint: ['KeyJ', 'ShiftRight', 'Numpad0'], switch: ['KeyI', 'Numpad3'],
    },
  };
  const keys = new Set(), latch = new Set();
  const held = c => keys.has(c) || latch.has(c);
  const anyHeld = arr => arr.some(held);
  const BLOCK = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space']);

  addEventListener('keydown', e => {
    if (BLOCK.has(e.code)) e.preventDefault();
    Sound.init();
    if (e.repeat) return;
    keys.add(e.code); latch.add(e.code);
    if (e.code === 'Escape' || e.code === 'KeyP') togglePause();
    if (e.code === 'KeyM') Sound.toggleMute();
  });
  addEventListener('keyup', e => keys.delete(e.code));
  addEventListener('blur', () => keys.clear());

  function readKeys(b) {
    return {
      mx: (anyHeld(b.right) ? 1 : 0) - (anyHeld(b.left) ? 1 : 0),
      my: (anyHeld(b.down) ? 1 : 0) - (anyHeld(b.up) ? 1 : 0),
      pass: anyHeld(b.pass), shoot: anyHeld(b.shoot), sprint: anyHeld(b.sprint), switch: anyHeld(b.switch),
    };
  }

  // 게임패드: A 패스 / B 슛 / RT·RB 스프린트 / LB 선수 전환 / Start 일시정지
  let padStartPrev = [];
  function readPad(index) {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    const gp = pads && pads[index];
    if (!gp) return null;
    const btn = i => !!(gp.buttons[i] && gp.buttons[i].pressed);
    let mx = gp.axes[0] || 0, my = gp.axes[1] || 0;
    if (Math.hypot(mx, my) < 0.25) { mx = 0; my = 0; }
    if (btn(14)) mx = -1; if (btn(15)) mx = 1; if (btn(12)) my = -1; if (btn(13)) my = 1;
    const start = btn(9);
    if (start && !padStartPrev[index]) togglePause();
    padStartPrev[index] = start;
    return { mx, my, pass: btn(0), shoot: btn(1), sprint: btn(7) || btn(5), switch: btn(4) };
  }

  function merge(a, b) {
    if (!b) return a;
    return {
      mx: Math.abs(b.mx) > Math.abs(a.mx) ? b.mx : a.mx,
      my: Math.abs(b.my) > Math.abs(a.my) ? b.my : a.my,
      pass: a.pass || b.pass, shoot: a.shoot || b.shoot, sprint: a.sprint || b.sprint, switch: a.switch || b.switch,
    };
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

  // ================= 사운드 (Web Audio로 직접 합성) =================
  const Sound = {
    ctx: null, master: null, muted: false, noise: null, crowd: null,
    init() {
      if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.6;
      this.master.connect(this.ctx.destination);
      const len = this.ctx.sampleRate * 2;
      this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const d = this.noise.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      // 관중 소음 (배경)
      const src = this.ctx.createBufferSource();
      src.buffer = this.noise; src.loop = true;
      const f = this.ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 500; f.Q.value = 0.6;
      this.crowd = this.ctx.createGain(); this.crowd.gain.value = 0;
      src.connect(f); f.connect(this.crowd); this.crowd.connect(this.master);
      src.start();
    },
    toggleMute() {
      this.muted = !this.muted;
      if (this.master) this.master.gain.value = this.muted ? 0 : 0.6;
      showToast(this.muted ? '소리 끔' : '소리 켬');
    },
    setCrowd(v) { if (this.crowd) this.crowd.gain.setTargetAtTime(v, this.ctx.currentTime, 0.5); },
    noiseBurst(dur, freq, q, vol, type) {
      if (!this.ctx) return;
      const t = this.ctx.currentTime;
      const s = this.ctx.createBufferSource(); s.buffer = this.noise;
      const f = this.ctx.createBiquadFilter(); f.type = type || 'bandpass'; f.frequency.value = freq; f.Q.value = q;
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
      s.connect(f); f.connect(g); g.connect(this.master);
      s.start(t, Math.random()); s.stop(t + dur + 0.05);
    },
    tone(freq, dur, vol, type, slideTo) {
      if (!this.ctx) return;
      const t = this.ctx.currentTime;
      const o = this.ctx.createOscillator(); o.type = type || 'sine';
      o.frequency.setValueAtTime(freq, t);
      if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
      o.connect(g); g.connect(this.master);
      o.start(t); o.stop(t + dur + 0.05);
    },
    kick(power) {
      const v = Math.min(1, power / 1000);
      this.tone(150, 0.12, 0.25 + v * 0.35, 'sine', 50);
      this.noiseBurst(0.05, 1200, 1, 0.15 + v * 0.25);
    },
    whistle(n, short) {
      if (!this.ctx) return;
      for (let i = 0; i < n; i++) {
        const t = this.ctx.currentTime + i * 0.45;
        const dur = short ? 0.22 : (i === n - 1 && n > 1 ? 0.7 : 0.35);
        const o = this.ctx.createOscillator(); o.type = 'sine'; o.frequency.value = 2900;
        const lfo = this.ctx.createOscillator(); lfo.frequency.value = 32;
        const lg = this.ctx.createGain(); lg.gain.value = 140;
        lfo.connect(lg); lg.connect(o.frequency);
        const g = this.ctx.createGain();
        g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.12, t + 0.02);
        g.gain.setValueAtTime(0.12, t + dur - 0.05); g.gain.linearRampToValueAtTime(0, t + dur);
        o.connect(g); g.connect(this.master);
        o.start(t); lfo.start(t); o.stop(t + dur + 0.05); lfo.stop(t + dur + 0.05);
      }
    },
    roar(dur, vol) {
      if (!this.ctx) return;
      const t = this.ctx.currentTime;
      const s = this.ctx.createBufferSource(); s.buffer = this.noise; s.loop = true;
      const f = this.ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 700; f.Q.value = 0.5;
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.001, t); g.gain.exponentialRampToValueAtTime(vol, t + 0.3);
      g.gain.exponentialRampToValueAtTime(0.001, t + dur);
      s.connect(f); f.connect(g); g.connect(this.master);
      s.start(t); s.stop(t + dur + 0.1);
    },
  };

  // ================= 캔버스 =================
  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');
  let dpr = 1, cssW = 0, cssH = 0;
  function resize() {
    dpr = Math.min(2, window.devicePixelRatio || 1);
    cssW = innerWidth; cssH = innerHeight;
    canvas.width = Math.round(cssW * dpr); canvas.height = Math.round(cssH * dpr);
  }
  addEventListener('resize', resize);
  resize();

  const cam = { x: W / 2, y: H / 2, scale: 1 };
  const P_COLORS = ['#38bdf8', '#f472b6'];
  let toast = null;
  function showToast(text) { toast = { text, t: 1.2 }; }

  function updateCamera(dt) {
    let scale = cssH / 660;
    if (cssW / scale > W + 220) scale = cssW / (W + 220);
    cam.scale = scale;
    const vw = cssW / scale, vh = cssH / scale;
    let tx = W / 2, ty = H / 2;
    if (game) {
      const b = game.ball;
      tx = b.x + b.vx * 0.15; ty = b.y + b.vy * 0.15;
    }
    const k = Math.min(1, dt * 4);
    cam.x += (tx - cam.x) * k; cam.y += (ty - cam.y) * k;
    const mx = 90, my = 70;
    cam.x = vw >= W + mx * 2 ? W / 2 : Math.max(vw / 2 - mx, Math.min(W + mx - vw / 2, cam.x));
    cam.y = vh >= H + my * 2 ? H / 2 : Math.max(vh / 2 - my, Math.min(H + my - vh / 2, cam.y));
  }

  function worldTransform() {
    const s = cam.scale * dpr;
    ctx.setTransform(s, 0, 0, s, canvas.width / 2 - cam.x * s, canvas.height / 2 - cam.y * s);
  }

  // ----- 경기장 -----
  function drawPitch() {
    ctx.fillStyle = '#1f5f2a';
    ctx.fillRect(-400, -400, W + 800, H + 800);
    const stripe = 100;
    for (let x = 0, i = 0; x < W; x += stripe, i++) {
      ctx.fillStyle = i % 2 ? '#2f8a3b' : '#349640';
      ctx.fillRect(x, 0, Math.min(stripe, W - x), H);
    }
    ctx.strokeStyle = 'rgba(255,255,255,0.88)';
    ctx.lineWidth = 3;
    ctx.strokeRect(0, 0, W, H);
    ctx.beginPath(); ctx.moveTo(W / 2, 0); ctx.lineTo(W / 2, H); ctx.stroke();
    ctx.beginPath(); ctx.arc(W / 2, H / 2, S.CIRCLE_R, 0, Math.PI * 2); ctx.stroke();
    dot(W / 2, H / 2, 4);
    for (const side of [0, 1]) {
      const x0 = side ? W : 0, d = side ? -1 : 1;
      ctx.strokeRect(side ? W - S.BOX_DEPTH : 0, H / 2 - S.BOX_HALF, S.BOX_DEPTH, S.BOX_HALF * 2);
      ctx.strokeRect(side ? W - S.SIX_DEPTH : 0, H / 2 - S.SIX_HALF, S.SIX_DEPTH, S.SIX_HALF * 2);
      const px = x0 + d * S.PEN_SPOT;
      dot(px, H / 2, 3.5);
      // 페널티 아크
      const r = 95, dx = S.BOX_DEPTH - S.PEN_SPOT;
      const a = Math.acos(dx / r);
      ctx.beginPath();
      if (side) ctx.arc(px, H / 2, r, Math.PI - a, Math.PI + a);
      else ctx.arc(px, H / 2, r, -a, a);
      ctx.stroke();
      // 코너 아크
      for (const cy of [0, H]) {
        ctx.beginPath();
        const st = side ? (cy ? Math.PI : Math.PI / 2) : (cy ? -Math.PI / 2 : 0);
        ctx.arc(x0, cy, 14, st, st + Math.PI / 2);
        ctx.stroke();
      }
    }
  }
  function dot(x, y, r) { ctx.fillStyle = 'rgba(255,255,255,0.9)'; ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill(); }

  function drawGoal(side) {
    const gx = side ? W : 0, d = side ? 1 : -1;
    const y0 = H / 2 - S.GOAL_HALF, y1 = H / 2 + S.GOAL_HALF;
    const x1 = gx + d * S.GOAL_DEPTH;
    ctx.fillStyle = 'rgba(255,255,255,0.12)';
    ctx.fillRect(Math.min(gx, x1), y0, S.GOAL_DEPTH, y1 - y0);
    ctx.strokeStyle = 'rgba(255,255,255,0.28)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let y = y0; y <= y1; y += 10) { ctx.moveTo(gx, y); ctx.lineTo(x1, y); }
    for (let k = 0; k <= S.GOAL_DEPTH; k += 10) { ctx.moveTo(gx + d * k, y0); ctx.lineTo(gx + d * k, y1); }
    ctx.stroke();
    ctx.strokeStyle = '#f8fafc'; ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(gx, y0); ctx.lineTo(x1, y0); ctx.lineTo(x1, y1); ctx.lineTo(gx, y1);
    ctx.stroke();
    ctx.fillStyle = '#ffffff';
    for (const y of [y0, y1]) { ctx.beginPath(); ctx.arc(gx, y, S.POST_R + 1, 0, Math.PI * 2); ctx.fill(); }
  }

  // ----- 선수 -----
  function drawPlayer(p) {
    const info = p.team.info;
    const body = p.isGK ? info.gk : info.color;
    const trim = p.isGK ? '#111827' : info.color2;
    ctx.save();
    ctx.translate(p.x, p.y);
    if (p.stun > 0 && !p.tackle) ctx.globalAlpha = 0.75;

    ctx.fillStyle = 'rgba(0,0,0,0.28)';
    ctx.beginPath(); ctx.ellipse(3, 5, PR, PR * 0.65, 0, 0, Math.PI * 2); ctx.fill();

    const sliding = p.tackle && (p.tackle.kind === 'slide' || p.tackle.kind === 'dive');
    const ang = Math.atan2(sliding ? p.tackle.dy : p.fy, sliding ? p.tackle.dx : p.fx);
    ctx.rotate(ang);
    if (sliding) {
      ctx.fillStyle = 'rgba(255,255,255,0.25)';
      ctx.fillRect(-PR * 2.6, -PR * 0.5, PR * 1.6, PR);
      ctx.scale(1.35, 0.8);
    }
    ctx.fillStyle = body;
    ctx.strokeStyle = trim;
    ctx.lineWidth = 2.5;
    ctx.beginPath(); ctx.arc(0, 0, PR, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    // 방향 표시
    ctx.fillStyle = trim;
    ctx.beginPath(); ctx.moveTo(PR + 4, 0); ctx.lineTo(PR - 2, -4.5); ctx.lineTo(PR - 2, 4.5); ctx.closePath(); ctx.fill();
    ctx.restore();

    ctx.save();
    if (p.stun > 0 && !p.tackle) ctx.globalAlpha = 0.75;
    ctx.fillStyle = trim;
    ctx.font = 'bold 11px system-ui, sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(p.num, p.x, p.y + 0.5);
    ctx.restore();
  }

  // 발밑 링 (선수보다 먼저 그림)
  function drawMarkerRing(p, slot) {
    ctx.strokeStyle = P_COLORS[slot]; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.ellipse(p.x, p.y + 4, PR + 7, (PR + 7) * 0.7, 0, 0, Math.PI * 2); ctx.stroke();
  }

  // 머리 위 표시, 게이지 (선수보다 나중에 그림)
  function drawMarker(p, slot) {
    const c = P_COLORS[slot];
    ctx.save();
    const y = p.y - PR - 14;
    ctx.fillStyle = c;
    ctx.beginPath(); ctx.moveTo(p.x, y + 6); ctx.lineTo(p.x - 6, y - 3); ctx.lineTo(p.x + 6, y - 3); ctx.closePath(); ctx.fill();
    ctx.font = 'bold 11px system-ui, sans-serif'; ctx.textAlign = 'center';
    ctx.fillText(slot === 0 ? '1P' : '2P', p.x, y - 7);
    // 스태미나
    if (p.stamina < 0.99) {
      ctx.fillStyle = 'rgba(0,0,0,0.5)'; ctx.fillRect(p.x - 14, p.y + PR + 10, 28, 4);
      ctx.fillStyle = p.stamina > 0.3 ? '#a3e635' : '#f87171';
      ctx.fillRect(p.x - 14, p.y + PR + 10, 28 * p.stamina, 4);
    }
    // 슛 파워 게이지
    if (p.charging) {
      const w = 44, x = p.x - w / 2, yy = p.y - PR - 46;
      ctx.fillStyle = 'rgba(0,0,0,0.6)'; ctx.fillRect(x - 2, yy - 2, w + 4, 10);
      const g = ctx.createLinearGradient(x, 0, x + w, 0);
      g.addColorStop(0, '#facc15'); g.addColorStop(0.7, '#f97316'); g.addColorStop(1, '#ef4444');
      ctx.fillStyle = g; ctx.fillRect(x, yy, w * p.charge, 6);
    }
    ctx.restore();
  }

  function drawBall(b) {
    const s = 1 + b.z / 220;
    ctx.fillStyle = `rgba(0,0,0,${Math.max(0.12, 0.35 - b.z / 400)})`;
    ctx.beginPath(); ctx.ellipse(b.x + 2 + b.z * 0.15, b.y + 3 + b.z * 0.1, BR * (1 + b.z / 300), BR * 0.6, 0, 0, Math.PI * 2); ctx.fill();
    const by = b.y - b.z * 0.6;
    ctx.fillStyle = '#ffffff'; ctx.strokeStyle = '#111827'; ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.arc(b.x, by, BR * s, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#111827';
    ctx.beginPath(); ctx.arc(b.x, by, BR * s * 0.38, 0, Math.PI * 2); ctx.fill();
  }

  // ----- HUD -----
  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }

  function drawScoreboard() {
    const t0 = game.teams[0], t1 = game.teams[1];
    const narrow = cssW < 560;
    ctx.font = `700 ${narrow ? 12 : 15}px system-ui, sans-serif`;
    const n0 = t0.info.name, n1 = t1.info.name;
    const w0 = ctx.measureText(n0).width, w1 = ctx.measureText(n1).width;
    const scoreW = narrow ? 52 : 64, timeW = narrow ? 56 : 68, pad = 12, sw = 10;
    const h = narrow ? 30 : 36, x = 16, y = 16;
    const total = pad + sw + 8 + w0 + 12 + scoreW + 12 + w1 + 8 + sw + pad + timeW;
    ctx.fillStyle = 'rgba(10,18,14,0.88)';
    roundRect(x, y, total, h, 8); ctx.fill();
    let cx = x + pad;
    ctx.textBaseline = 'middle';
    const mid = y + h / 2;
    const chip = (c) => { ctx.fillStyle = c; roundRect(cx, mid - 7, sw, 14, 3); ctx.fill(); };
    chip(t0.info.color); cx += sw + 8;
    ctx.fillStyle = '#f1f5f9'; ctx.textAlign = 'left'; ctx.fillText(n0, cx, mid); cx += w0 + 12;
    ctx.fillStyle = '#f8fafc'; ctx.fillRect(cx, y + 4, scoreW, h - 8);
    ctx.fillStyle = '#0f172a'; ctx.textAlign = 'center';
    ctx.font = `900 ${narrow ? 15 : 19}px system-ui, sans-serif`;
    ctx.fillText(`${t0.score} - ${t1.score}`, cx + scoreW / 2, mid + 1); cx += scoreW + 12;
    ctx.font = `700 ${narrow ? 12 : 15}px system-ui, sans-serif`;
    ctx.fillStyle = '#f1f5f9'; ctx.textAlign = 'left'; ctx.fillText(n1, cx, mid); cx += w1 + 8;
    chip(t1.info.color); cx += sw + pad;
    ctx.fillStyle = '#22c55e'; ctx.fillRect(cx, y, timeW, h);
    roundRect(cx, y, timeW, h, 8); ctx.fill();
    ctx.fillRect(cx, y, 8, h);
    const tm = game.displayTime;
    ctx.fillStyle = '#052e16'; ctx.textAlign = 'center';
    ctx.font = `800 ${narrow ? 13 : 16}px ui-monospace, Consolas, monospace`;
    ctx.fillText(`${String(tm.m).padStart(2, '0')}:${String(tm.s).padStart(2, '0')}`, cx + timeW / 2, mid + 1);
  }

  function drawRadar() {
    const rw = Math.min(250, cssW * 0.4), rh = rw * H / W;
    const x = (cssW - rw) / 2, y = cssH - rh - 14;
    const k = rw / W;
    ctx.fillStyle = 'rgba(10,30,18,0.88)';
    roundRect(x - 4, y - 4, rw + 8, rh + 8, 6); ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.35)'; ctx.lineWidth = 1;
    ctx.strokeRect(x, y, rw, rh);
    ctx.beginPath(); ctx.moveTo(x + rw / 2, y); ctx.lineTo(x + rw / 2, y + rh); ctx.stroke();
    ctx.strokeRect(x, y + (H / 2 - S.BOX_HALF) * k, S.BOX_DEPTH * k, S.BOX_HALF * 2 * k);
    ctx.strokeRect(x + rw - S.BOX_DEPTH * k, y + (H / 2 - S.BOX_HALF) * k, S.BOX_DEPTH * k, S.BOX_HALF * 2 * k);
    // 화면에 보이는 영역
    const vw = cssW / cam.scale, vh = cssH / cam.scale;
    ctx.strokeStyle = 'rgba(255,255,255,0.18)';
    ctx.strokeRect(x + Math.max(0, cam.x - vw / 2) * k, y + Math.max(0, cam.y - vh / 2) * k,
      Math.min(W, vw) * k, Math.min(H, vh) * k);
    for (const t of game.teams) {
      for (const p of t.players) {
        const ctrl = t.human && t.controlled === p;
        ctx.fillStyle = p.isGK ? t.info.gk : t.info.color;
        ctx.beginPath(); ctx.arc(x + p.x * k, y + p.y * k, ctrl ? 4.5 : 3.2, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = ctrl ? P_COLORS[t.id] : 'rgba(255,255,255,0.6)';
        ctx.lineWidth = ctrl ? 2 : 0.8; ctx.stroke();
      }
    }
    ctx.fillStyle = '#ffffff';
    ctx.beginPath(); ctx.arc(x + game.ball.x * k, y + game.ball.y * k, 2.5, 0, Math.PI * 2); ctx.fill();
  }

  function drawMessage() {
    const m = game.message;
    if (!m) return;
    const age = m.max - m.t;
    const alpha = Math.min(1, age * 5, m.t * 3);
    const pop = m.big ? 1 + Math.max(0, 0.25 - age) * 1.6 : 1;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(cssW / 2, cssH * 0.3);
    ctx.scale(pop, pop);
    const size = m.big ? Math.min(84, cssW / 8) : Math.min(36, cssW / 14);
    ctx.font = `900 ${size}px system-ui, sans-serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.lineWidth = m.big ? 8 : 5; ctx.strokeStyle = 'rgba(0,0,0,0.7)';
    ctx.strokeText(m.text, 0, 0);
    ctx.fillStyle = m.text === 'GOAL!' ? '#facc15' : '#ffffff';
    ctx.fillText(m.text, 0, 0);
    ctx.restore();
  }

  function drawHints() {
    ctx.font = '12px system-ui, sans-serif';
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.fillText('Esc 일시정지 · M 소리', 16, cssH - 16);
    if (toast) {
      ctx.textAlign = 'right';
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.fillText(toast.text, cssW - 16, cssH - 16);
    }
  }

  function render(dt) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#0b1a10';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    updateCamera(dt);
    worldTransform();
    drawPitch();
    drawGoal(0); drawGoal(1);
    if (!game) return;
    const list = game.players.slice().sort((a, b) => a.y - b.y);
    const marked = game.teams.filter(t => t.human && t.controlled && game.state !== 'fulltime');
    const slot = t => (opts.mode === '2p' ? t.id : 0);
    for (const t of marked) drawMarkerRing(t.controlled, slot(t));
    for (const p of list) drawPlayer(p);
    drawBall(game.ball);
    for (const t of marked) drawMarker(t.controlled, slot(t));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawScoreboard();
    drawRadar();
    drawMessage();
    drawHints();
  }

  // ================= 게임 진행 =================
  let game = null, paused = false, resultTimer = -1;

  function newGame() {
    const humans = opts.mode === '1p' ? [true, false] : opts.mode === '2p' ? [true, true] : [false, false];
    game = new S.Game({
      teamSize: +opts.size, matchSeconds: +opts.time, difficulty: opts.diff, humans,
      teams: [TEAMS[opts.team[0]], TEAMS[opts.team[1]]],
    });
    paused = false; resultTimer = -1;
    cam.x = W / 2; cam.y = H / 2;
    hide('menu'); hide('pause'); hide('result');
    Sound.init();
    Sound.setCrowd(0.05);
  }

  function togglePause() {
    if (!game || game.state === 'fulltime' || !document.getElementById('menu').classList.contains('hidden')) return;
    paused = !paused;
    if (paused) {
      document.getElementById('pauseControls').innerHTML = controlsHTML(opts.mode);
      show('pause');
    } else hide('pause');
  }

  function handleEvents() {
    for (const e of game.events) {
      switch (e.type) {
        case 'kick': Sound.kick(e.power); break;
        case 'whistle': Sound.whistle(e.n, e.short); break;
        case 'goal': Sound.roar(3.2, 0.5); Sound.whistle(1, true); break;
        case 'save': Sound.roar(1.2, 0.18); Sound.tone(90, 0.15, 0.4); break;
        case 'post': Sound.tone(1250, 0.4, 0.2, 'triangle'); Sound.tone(1870, 0.3, 0.12, 'triangle'); Sound.roar(1.2, 0.2); break;
        case 'miss': Sound.roar(1.0, 0.12); break;
        case 'tackle': Sound.noiseBurst(0.08, 400, 1, 0.3); break;
        case 'slide': Sound.noiseBurst(0.25, 2500, 0.5, 0.08, 'highpass'); break;
        case 'fulltime': resultTimer = 2.2; break;
      }
    }
    game.events.length = 0;
  }

  const STEP = 1 / 60;
  let last = performance.now(), acc = 0;
  function frame(now) {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    if (toast) { toast.t -= dt; if (toast.t <= 0) toast = null; }
    if (game && !paused) {
      feedInputs();
      acc += dt;
      let steps = 0;
      while (acc >= STEP && steps < 6) { game.update(STEP); acc -= STEP; steps++; }
      if (steps > 0) latch.clear();
      handleEvents();
      if (resultTimer > 0) {
        resultTimer -= dt;
        if (resultTimer <= 0) showResult();
      }
    } else {
      latch.clear();
      if (!game) readPad(0);
    }
    render(paused ? 0 : dt);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  // ================= 메뉴 / UI =================
  const show = id => document.getElementById(id).classList.remove('hidden');
  const hide = id => document.getElementById(id).classList.add('hidden');

  document.querySelectorAll('.seg').forEach(seg => {
    seg.addEventListener('click', e => {
      const b = e.target.closest('button');
      if (!b) return;
      seg.querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
      opts[seg.dataset.opt] = b.dataset.v;
      refreshMenu();
    });
  });

  document.querySelectorAll('.team-pick').forEach(el => {
    const side = +el.dataset.side;
    el.querySelectorAll('.arrow').forEach(a => a.addEventListener('click', () => {
      const d = +a.dataset.d;
      let i = opts.team[side];
      do { i = (i + d + TEAMS.length) % TEAMS.length; } while (i === opts.team[1 - side]);
      opts.team[side] = i;
      refreshMenu();
    }));
  });

  function refreshMenu() {
    document.querySelectorAll('.team-pick').forEach(el => {
      const t = TEAMS[opts.team[+el.dataset.side]];
      el.querySelector('.tname').textContent = t.name;
      const sw = el.querySelector('.swatch');
      sw.style.background = t.color; sw.style.borderColor = t.color2;
    });
    const labels = { '1p': ['HOME · 1P', 'AWAY · AI'], '2p': ['HOME · 1P', 'AWAY · 2P'], cpu: ['HOME · AI', 'AWAY · AI'] }[opts.mode];
    document.getElementById('sideLabel0').textContent = labels[0];
    document.getElementById('sideLabel1').textContent = labels[1];
    document.getElementById('diffRow').style.visibility = opts.mode === '1p' ? 'visible' : 'hidden';
    document.getElementById('controls').innerHTML = controlsHTML(opts.mode);
  }

  function controlsHTML(mode) {
    const k = s => s.split('/').map(x => `<kbd>${x.trim()}</kbd>`).join(' / ');
    const box = (title, r) => `<div class="box"><h3>${title}</h3><table>
      <tr><td>이동</td><td>${r[0]}</td></tr>
      <tr><td>패스 · 태클</td><td>${r[1]}</td></tr>
      <tr><td>슛(꾹 눌러 파워) · 슬라이딩</td><td>${r[2]}</td></tr>
      <tr><td>스프린트</td><td>${r[3]}</td></tr>
      <tr><td>선수 전환 (수비 시)</td><td>${r[4]}</td></tr></table></div>`;
    if (mode === '1p') {
      return box('조작법', [k('WASD / 방향키'), k('J / F'), k('K / G'), k('Shift'), k('L / Q')]) +
        `<div class="box"><h3>팁</h3>패스는 누르고 있는 방향의 동료에게 갑니다.<br>슛할 때 위/아래 방향키로 골문 구석을 노리세요.<br>게임패드: A 패스, B 슛, RT 스프린트, LB 전환</div>`;
    }
    if (mode === '2p') {
      return box('1P (왼쪽 팀)', [k('WASD'), k('F'), k('G'), k('왼쪽 Shift'), k('Q')]) +
        box('2P (오른쪽 팀)', [k('방향키'), k('K / Num1'), k('L / Num2'), k('J / Num0'), k('I / Num3')]) +
        `<div class="note">게임패드 2개를 연결하면 각각 1P/2P로 쓸 수 있어요. (A 패스, B 슛, RT 스프린트, LB 전환)</div>`;
    }
    return `<div class="box"><h3>관전 모드</h3>AI끼리 경기합니다. Esc로 일시정지할 수 있어요.</div>`;
  }

  function showResult() {
    const s = game.summary();
    const t = game.teams;
    const scorers = i => s[i].goals.map(g => `⚽ ${g.minute}' ${g.own ? '자책골' : g.scorer ? g.scorer + '번' : ''}`).join('<br>') || '-';
    const row = (label, a, b) => `<tr><td>${a}</td><td class="k">${label}</td><td>${b}</td></tr>`;
    let headline = '무승부';
    if (s[0].score !== s[1].score) headline = `${s[s[0].score > s[1].score ? 0 : 1].name} 승리!`;
    document.getElementById('resultBody').innerHTML = `
      <div class="final-score">
        <div class="team left"><span class="swatch" style="background:${t[0].info.color};border-color:${t[0].info.color2}"></span>${s[0].name}</div>
        <div class="num">${s[0].score} : ${s[1].score}</div>
        <div class="team right">${s[1].name}<span class="swatch" style="background:${t[1].info.color};border-color:${t[1].info.color2}"></span></div>
      </div>
      <h2 style="color:#facc15">${headline}</h2>
      <table class="stats">
        ${row('점유율', s[0].possession + '%', s[1].possession + '%')}
        ${row('슈팅', s[0].shots, s[1].shots)}
        ${row('유효 슈팅', s[0].onTarget, s[1].onTarget)}
        ${row('패스', s[0].passes, s[1].passes)}
      </table>
      <div class="scorers"><div>${scorers(0)}</div><div>${scorers(1)}</div></div>`;
    show('result');
  }

  document.getElementById('startBtn').onclick = newGame;
  document.getElementById('resumeBtn').onclick = togglePause;
  document.getElementById('restartBtn').onclick = newGame;
  document.getElementById('againBtn').onclick = newGame;
  const toMenu = () => { game = null; paused = false; Sound.setCrowd(0); hide('pause'); hide('result'); show('menu'); };
  document.getElementById('quitBtn').onclick = toMenu;
  document.getElementById('menuBtn').onclick = toMenu;

  refreshMenu();
})();
