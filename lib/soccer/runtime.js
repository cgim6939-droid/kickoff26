// 게임 루프 + 입력 + HUD. React 컴포넌트는 메뉴/오버레이만 담당하고 실제 게임은 여기서 돌아감
import { Soccer, SWEET_LO, SWEET_HI } from './engine';
import { Scene3D, P_COLORS } from './scene3d';
import { Sound } from './sound';
import { BINDINGS, CONTROL_GUIDE } from './teams';
import { hostRoom, joinRoom } from './net';
import { matchTeams, CLUBS } from './clubs';
import { FORMATIONS, STYLES, STYLE_ORDER } from './formations';

const { Game, W, H, BOX_DEPTH, BOX_HALF } = Soccer;
const STEP = 1 / 60;
const BLOCK = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'Tab']);

export function createRuntime({ glCanvas, hudCanvas, onPauseChange, onResult, onOnline }) {
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
    if (opts.mode === 'guest') return;
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
    } else if (opts.mode === 'host') {
      game.setInput(0, merge(readKeys(BINDINGS.single), readPad(0)));
      const ri = remoteIn || { mx: 0, my: 0 };
      const inp = { ...ri };
      for (const k of BTN) inp[k] = !!(ri[k] || remoteTap[k]);
      remoteTap = {};
      game.setInput(1, inp);
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
  function togglePause() { if (isOnline()) { showToast('온라인 경기에서는 일시정지할 수 없어요'); return; } setPaused(!paused); }

  // ================= 온라인 (방 코드로 1대1) =================
  // 방장: 경기를 계산해서 상태를 보내 줌 / 손님: 키 입력만 보내고 받은 상태를 그림
  let net = null, remoteIn = null, remoteTap = {}, netSnaps = [], guestEvents = [], hostEvents = [];
  let lastSend = 0, lastInSend = 0, lastInJson = '', lastBtnJson = '';
  // 지연 줄이기: 일련번호(오래된 패킷 버림), 핑 측정, 적응형 보간 지연, 손님 선수 예측
  let seqOut = 0, lastInSeq = -1, lastSnapSeq = -1, rtt = 0, peerRtt = 0, lastPing = 0;
  let gap = 33, jit = 4, lastArrive = 0, bufDelay = 80;
  let pred = null, predIdx = -2, guestInput = { mx: 0, my: 0 };
  const CLUB_COUNT = CLUBS.length;
  const isOnline = () => !!opts && (opts.mode === 'host' || opts.mode === 'guest');
  const BTN = ['pass', 'shoot', 'through', 'lob', 'sprint', 'switch', 'fin', 'chip', 'drive', 'skill'];
  const r1 = v => Math.round(v * 10) / 10, r2 = v => Math.round(v * 100) / 100;
  const SETUP_KEYS = ['team', 'size', 'time', 'diff', 'rules', 'tod', 'weather', 'lineup'];

  function closeNet() { if (net) { try { net.close(); } catch (e) { /* 이미 닫힘 */ } } net = null; remoteIn = null; netSnaps = []; guestEvents = []; hostEvents = []; }

  async function hostOnline(o) {
    closeNet();
    const setup = {};
    for (const k of SETUP_KEYS) setup[k] = o[k];
    guestSel = null;
    // 손님이 고른(또는 보고 있던) 팀으로 경기를 시작
    const beginMatch = (ti, lineupIn) => {
      if (!(ti >= 0) || ti === o.team[0] || !net) return;
      const team = [o.team[0], ti];
      const lineup = { ...(o.lineup || {}) };
      if (lineupIn) lineup[ti] = lineupIn;
      net.send({ t: 'start', setup: { ...setup, team, lineup } });
      lastInSeq = -1; seqOut = 0;
      start({ ...o, team, lineup, mode: 'host' });
      onOnline && onOnline({ phase: 'playing' });
    };
    // 방장이 먼저 시작: 손님이 고르던 팀이 있으면 그 팀으로, 없으면 무작위 팀
    hostStartNowFn = () => {
      let ti = guestSel && guestSel.team >= 0 && guestSel.team !== o.team[0] ? guestSel.team : -1;
      let lu = ti >= 0 ? guestSel.lineup : null;
      if (ti < 0) { do { ti = Math.floor(Math.random() * CLUB_COUNT); } while (ti === o.team[0]); lu = null; }
      net && net.send({ t: 'force', team: ti });
      beginMatch(ti, lu);
    };
    try {
      net = await hostRoom({
        onOpen: () => {
          // 손님이 들어오면 방장 팀과 경기 설정을 알려 주고, 손님이 자기 팀을 고를 때까지 기다림
          net.send({ t: 'lobby', hostTeam: o.team[0], setup });
          lastInSeq = -1; seqOut = 0; peerRtt = 0;
          onOnline && onOnline({ phase: 'lobby' });
        },
        onMsg: (m) => {
          if (m.t === 'in') {
            if (m.q <= lastInSeq) return;               // 늦게 도착한 옛 입력은 버림
            lastInSeq = m.q;
            remoteIn = m.i;
            if (m.r) peerRtt = m.r;
            for (const k of BTN) if (m.i[k]) remoteTap[k] = true;     // 눌렀다 뗀 짧은 입력도 놓치지 않게
          } else if (m.t === 'ping') {
            net && net.send({ t: 'pong', ts: m.ts });
          } else if (m.t === 'sel') {
            guestSel = { team: Number(m.team), lineup: m.lineup || null };      // 손님이 지금 보고 있는 팀 (방장이 먼저 시작할 때 사용)
          } else if (m.t === 'pick') {
            beginMatch(Number(m.team), m.lineup);
          }
        },
        onClose: () => { if (net) { onOnline && onOnline({ phase: 'closed' }); } },
      });
      onOnline && onOnline({ phase: 'waiting', code: net.code });
    } catch (e) {
      onOnline && onOnline({ phase: 'error', message: '방을 만들지 못했어요. 인터넷 연결을 확인해 주세요.' });
    }
  }

  async function joinOnline(code, local) {
    closeNet();
    try {
      net = await joinRoom(code, {
        onOpen: () => onOnline && onOnline({ phase: 'connected' }),
        onFail: () => { closeNet(); onOnline && onOnline({ phase: 'error', message: '방을 찾지 못했어요. 코드를 다시 확인해 주세요.' }); },
        onMsg: (m) => {
          if (m.t === 'lobby') {
            onOnline && onOnline({ phase: 'pick', hostTeam: m.hostTeam, setup: m.setup });
          } else if (m.t === 'start') {
            netSnaps = []; guestEvents = []; lastSnapSeq = -1; seqOut = 0; lastArrive = 0; pred = null; predIdx = -2; rtt = 0;
            start({ ...m.setup, ...local, mode: 'guest' });
            onOnline && onOnline({ phase: 'playing' });
          } else if (m.t === 'snap') {
            if (m.q <= lastSnapSeq) return;             // 순서가 뒤바뀐 옛 상태는 버림
            lastSnapSeq = m.q;
            const at = performance.now();
            if (lastArrive) {
              const d = at - lastArrive;
              gap += (d - gap) * 0.1; jit += (Math.abs(d - gap) - jit) * 0.1;
              bufDelay = Math.max(45, Math.min(170, gap * 1.6 + jit * 3));   // 네트워크가 불안정하면 보간 지연을 늘림
            }
            lastArrive = at;
            netSnaps.push({ at, s: m });
            if (netSnaps.length > 16) netSnaps.shift();
          } else if (m.t === 'pong') {
            const r = performance.now() - m.ts;
            rtt = rtt ? rtt + (r - rtt) * 0.25 : r;
          } else if (m.t === 'ev') {
            for (const e of m.e) guestEvents.push(e);
          } else if (m.t === 'end') {
            resultTimer = 1.5; netEnd = m;
          }
        },
        onClose: () => { if (net) onOnline && onOnline({ phase: 'closed' }); },
      });
    } catch (e) {
      onOnline && onOnline({ phase: 'error', message: '연결하지 못했어요. 인터넷 연결을 확인해 주세요.' });
    }
  }
  let netEnd = null, guestSel = null, hostStartNowFn = null;
  const hostStartNow = () => { if (hostStartNowFn) hostStartNowFn(); };
  function sendSel(team, lineup) { if (net) net.send({ t: 'sel', team, lineup: lineup || null }); }
  function sendPick(team, lineup) { if (net) net.send({ t: 'pick', team, lineup: lineup || null }); }

  // 방장 → 손님: 현재 경기 상태 (선수/공/점수/시계)
  function netSnapshot() {
    const g = game, b = g.ball, P = g.players;
    const ix = p => (p ? P.indexOf(p) : -1);
    return {
      t: 'snap', q: ++seqOut, time: g.time, clock: g.clock, half: g.half, state: g.state,
      p: P.map(p => [r1(p.x), r1(p.y), r2(p.fx), r2(p.fy), r1(p.vx), r1(p.vy), r2(p.stun),
        p.tackle ? p.tackle.kind : 0, p.tackle ? r2(p.tackle.dx) : 0, p.tackle ? r2(p.tackle.dy) : 0,
        p.out ? 1 : 0, p.charging ? 1 : 0, r2(p.charge || 0), p.kickWind ? 1 : 0, p.locked ? 1 : 0,
        p.header ? [r1(p.header.x), r1(p.header.y)] : 0, p.shotKind || 0, p.feet ? 1 : 0]),
      b: [r1(b.x), r1(b.y), r1(b.z), r1(b.vx), r1(b.vy), ix(b.owner), ix(b.lastKicker)],
      sc: g.teams.map(t => t.score), ctl: g.teams.map(t => ix(t.controlled)), hint: g.teams.map(t => ix(t.passHint)),
      st: g.teams.map(t => ({ ...t.stats })),
      msg: g.message ? { text: g.message.text, t: g.message.t, max: g.message.max, big: g.message.big } : null,
      goals: g.goals.map(x => ({ team: x.team, minute: x.minute, scorer: x.scorer, name: x.name, own: x.own })),
      aim: g.aim ? { y: g.aim.y, kind: g.aim.kind, t: g.aim.t, tk: ix(g.aim.taker) } : null,
      rs: g.restart ? { team: g.restart.team.id, kind: g.restart.kind, x: g.restart.x, y: g.restart.y } : null,
    };
  }

  function netEvent(e) {
    const o = {};
    for (const k of Object.keys(e)) {
      const v = e[k];
      if (v && typeof v === 'object' && 'idx' in v && v.team) o[k] = { __p: game.players.indexOf(v) };
      else if (v === undefined || typeof v === 'function' || (v && typeof v === 'object')) continue;
      else o[k] = v;
    }
    return o;
  }

  // 손님: 받아 둔 상태 두 장 사이를 보간해서 게임 객체에 반영
  function applyNet(dt) {
    if (!netSnaps.length) return;
    const now = performance.now() - bufDelay;
    let a = netSnaps[0], b = netSnaps[netSnaps.length - 1];
    for (let i = 0; i < netSnaps.length - 1; i++) {
      if (netSnaps[i].at <= now && netSnaps[i + 1].at >= now) { a = netSnaps[i]; b = netSnaps[i + 1]; break; }
    }
    let k = b.at > a.at ? Math.min(1, Math.max(0, (now - a.at) / (b.at - a.at))) : 1;
    if (a === b) k = 1;
    const A = a.s, B = b.s, g = game, P = g.players;
    P.forEach((p, i) => {
      const x = A.p[i], y = B.p[i];
      const far = Math.hypot(x[0] - y[0], x[1] - y[1]) > 220;
      const kk = far ? 1 : k;
      p.x = x[0] + (y[0] - x[0]) * kk; p.y = x[1] + (y[1] - x[1]) * kk;
      p.vx = x[4] + (y[4] - x[4]) * kk; p.vy = x[5] + (y[5] - x[5]) * kk;
      p.fx = y[2]; p.fy = y[3]; p.stun = y[6];
      p.tackle = y[7] ? { kind: y[7], dx: y[8], dy: y[9], t: 0.2 } : null;
      p.out = !!y[10]; p.charging = !!y[11]; p.charge = y[12]; p.kickWind = y[13] ? { t: 0.1 } : null; p.locked = !!y[14];
      p.header = y[15] ? { x: y[15][0], y: y[15][1] } : null; p.shotKind = y[16] || null; p.feet = !!y[17];
    });
    const ba = A.b, bb = B.b, bl = g.ball;
    const bfar = Math.hypot(ba[0] - bb[0], ba[1] - bb[1]) > 300 ? 1 : k;
    bl.x = ba[0] + (bb[0] - ba[0]) * bfar; bl.y = ba[1] + (bb[1] - ba[1]) * bfar; bl.z = ba[2] + (bb[2] - ba[2]) * bfar;
    bl.vx = bb[3]; bl.vy = bb[4];
    bl.owner = bb[5] >= 0 ? P[bb[5]] : null; bl.lastKicker = bb[6] >= 0 ? P[bb[6]] : null;
    g.time = B.time; g.clock = B.clock; g.half = B.half; g.state = B.state;
    g.teams.forEach((t, i) => {
      t.score = B.sc[i]; t.stats = B.st[i];
      t.controlled = B.ctl[i] >= 0 ? P[B.ctl[i]] : null; t.passHint = B.hint[i] >= 0 ? P[B.hint[i]] : null;
    });
    g.message = B.msg; g.goals = B.goals;
    g.aim = B.aim ? { y: B.aim.y, kind: B.aim.kind, t: B.aim.t, taker: P[B.aim.tk] } : null;
    g.restart = B.rs ? { team: g.teams[B.rs.team], kind: B.rs.kind, x: B.rs.x, y: B.rs.y } : null;
    predictGuest(dt, A, B, k);
  }

  // 손님 자신이 조작하는 선수는 입력을 바로 반영해서 움직이고(예측), 방장이 알려 준 실제 위치로 부드럽게 맞춤
  function predictGuest(dt, A, B, k) {
    const g = game, P = g.players;
    const ci = B.ctl[1];
    const p = ci >= 0 ? P[ci] : null;
    const free = p && g.state === 'play' && !(p.stun > 0) && !p.tackle && !p.kickWind && !g.aim && !p.locked;
    if (ci !== predIdx || !free) { predIdx = ci; pred = null; if (!free) return; }
    const dtt = Math.min(0.05, dt || 0.016);
    const lat = Math.min(0.25, rtt / 2000 + bufDelay / 1000);     // 방장 상태가 지금보다 얼마나 과거인지
    const ax = A.p[ci], bx = B.p[ci];
    const ix = p.x, iy = p.y;                                       // 보간된(과거) 위치
    const authX = ix + p.vx * lat, authY = iy + p.vy * lat;         // 지연만큼 앞으로 내다본 실제 위치
    if (!pred) pred = { x: authX, y: authY, vx: p.vx, vy: p.vy };
    const m = Math.hypot(guestInput.mx, guestInput.my);
    const ux = m > 0.15 ? guestInput.mx / Math.max(1, m) : 0, uy = m > 0.15 ? guestInput.my / Math.max(1, m) : 0;
    const sp = 140 * (p.pace || 1) * (guestInput.sprint ? 1.42 : 1) * (g.ball.owner === p ? 0.9 : 1);
    const tv = m > 0.15 ? 1 : 0;
    pred.vx += (ux * sp * tv - pred.vx) * Math.min(1, dtt * 9);
    pred.vy += (uy * sp * tv - pred.vy) * Math.min(1, dtt * 9);
    pred.x += pred.vx * dtt; pred.y += pred.vy * dtt;
    const ex = authX - pred.x, ey = authY - pred.y;
    if (Math.hypot(ex, ey) > 80) { pred.x = authX; pred.y = authY; }
    else { const c = Math.min(1, dtt * 5); pred.x += ex * c; pred.y += ey * c; }
    // 공을 가진 선수라면 공도 같이 따라오게
    const bl = g.ball;
    if (bl.owner === p) { bl.x += pred.x - ix; bl.y += pred.y - iy; }
    p.x = pred.x; p.y = pred.y; p.vx = pred.vx; p.vy = pred.vy;
    if (tv && Math.hypot(pred.vx, pred.vy) > 30) { const l = Math.hypot(pred.vx, pred.vy); p.fx = pred.vx / l; p.fy = pred.vy / l; }
  }

  // 손님: 내 키 입력을 방장에게 (바뀔 때마다 + 0.05초마다). 버튼이 바뀐 순간은 신뢰 길로도 보내 놓치지 않게 함
  function sendGuestInput(now) {
    if (!net) return;
    const i = merge(readKeys(BINDINGS.single), readPad(0));
    latch.clear();                                   // 한 번 눌린 키가 계속 눌린 것처럼 남지 않게
    i.mx = -i.mx; i.my = -i.my;                      // 손님 화면은 180도 돌아가 있음
    guestInput = i;
    const js = JSON.stringify(i);
    const btn = JSON.stringify(BTN.map(k => i[k]));
    if (js !== lastInJson || now - lastInSend > 50) {
      lastInJson = js; lastInSend = now;
      const msg = { t: 'in', q: ++seqOut, i, r: Math.round(rtt) };
      net.sendFast(msg);
      if (btn !== lastBtnJson) { lastBtnJson = btn; net.send(msg); }
    }
    if (now - lastPing > 500) { lastPing = now; net.send({ t: 'ping', ts: performance.now() }); }
  }

  function start(o) {
    opts = o; qLevel = null; avgMs = 16.7; fastT = 0; resCool = 4;
    const humans = o.mode === '1p' ? [true, false] : (o.mode === '2p' || o.mode === 'host') ? [true, true] : o.mode === 'guest' ? [false, true] : [false, false];
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
    scene.flip = o.mode === 'guest';
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
    closeNet(); netEnd = null; scene.flip = false;
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
  // 렌더 보간: 엔진은 60Hz 고정 간격으로 계산하므로, 모니터 주사율(90/120/144Hz)과 어긋나면 움직임이 끊겨 보여요.
  // 직전 계산 상태와 현재 상태 사이를 화면 시각에 맞춰 섞어서 그리고, 그린 뒤에는 원래 값으로 되돌려요.
  let prevPos = null, curPos = null;
  function savePrev() {
    const n = game.players.length * 2 + 3;
    if (!prevPos || prevPos.length !== n) { prevPos = new Float32Array(n); curPos = new Float32Array(n); }
    game.players.forEach((p, i) => { prevPos[i * 2] = p.x; prevPos[i * 2 + 1] = p.y; });
    const b = game.ball, o = game.players.length * 2;
    prevPos[o] = b.x; prevPos[o + 1] = b.y; prevPos[o + 2] = b.z;
  }
  let lerpOn = false;
  function lerpApply(alpha) {
    if (!prevPos) return;
    const P = game.players, b = game.ball, o = P.length * 2;
    P.forEach((p, i) => { curPos[i * 2] = p.x; curPos[i * 2 + 1] = p.y; });
    curPos[o] = b.x; curPos[o + 1] = b.y; curPos[o + 2] = b.z;
    const mix = (a, c, d) => (Math.abs(c - a) > d ? c : a + (c - a) * alpha);     // 순간이동(재시작 등)은 보간하지 않음
    P.forEach((p, i) => { p.x = mix(prevPos[i * 2], curPos[i * 2], 90); p.y = mix(prevPos[i * 2 + 1], curPos[i * 2 + 1], 90); });
    b.x = mix(prevPos[o], curPos[o], 160); b.y = mix(prevPos[o + 1], curPos[o + 1], 160); b.z = mix(prevPos[o + 2], curPos[o + 2], 120);
    lerpOn = true;
  }
  function lerpRestore() {
    if (!lerpOn) return;
    lerpOn = false;
    const P = game.players, b = game.ball, o = P.length * 2;
    P.forEach((p, i) => { p.x = curPos[i * 2]; p.y = curPos[i * 2 + 1]; });
    b.x = curPos[o]; b.y = curPos[o + 1]; b.z = curPos[o + 2];
  }

  const PROF = typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('prof');
  if (PROF) window.__prof = [];
  function frame(now) {
    const T0 = PROF ? performance.now() : 0;
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
    } else if (game && !paused && opts.mode === 'guest') {
      sendGuestInput(now);
      applyNet(dt);
      for (const raw of guestEvents) {
        const e = { ...raw };
        for (const k of Object.keys(e)) if (e[k] && typeof e[k] === 'object' && '__p' in e[k]) e[k] = game.players[e[k].__p];
        Sound.play(e);
        scene.onEvent(e);
        if (e.type === 'goal') {
          const g = game.goals[game.goals.length - 1] || {};
          showBanner('⚽  ' + (g.name || '') + (g.own ? ' (자책골)' : '') + '  ' + (g.minute || '') + "'", game.teams[e.team].info.color, 5.5);
        }
      }
      guestEvents.length = 0;
      if (resultTimer > 0) {
        resultTimer -= dt;
        if (resultTimer <= 0 && netEnd) onResult && onResult(netEnd.summary, game.teams.map(t => t.info));
      }
      const d = Math.min(Math.abs(game.ball.x), Math.abs(W - game.ball.x));
      Sound.setCrowd(0.035 + Math.max(0, Math.min(1, 1 - (d - 150) / 450)) * 0.09);
    } else if (game && !paused) {
      feedInputs();
      acc += dt;
      let steps = 0;
      while (acc >= STEP && steps < 6) { savePrev(); game.update(STEP); acc -= STEP; steps++; }
      if (steps === 6) acc = 0;                      // 너무 밀렸으면 따라잡지 않고 버림
      if (steps > 0) latch.clear();
      for (const e of game.events) {
        if (opts.mode === 'host') hostEvents.push(netEvent(e));
        Sound.play(e);
        scene.onEvent(e);
        if (e.type === 'fulltime') resultTimer = 2.2;
        if (e.type === 'goal') {
          goalTime = game.time;
          goalX = game.ball.x < W / 2 ? 0 : W;
          if (!isOnline()) pendingReplay = 1.4;
          const g = game.goals[game.goals.length - 1];
          const t = game.teams[e.team];
          showBanner('⚽  ' + (g.name || '') + (g.own ? ' (자책골)' : '') + '  ' + g.minute + "'", t.info.color, 5.5);
        }
      }
      game.events.length = 0;
      if (opts.mode === 'host' && net) {
        if (hostEvents.length) { net.send({ t: 'ev', e: hostEvents }); hostEvents = []; }
        if (now - lastSend > 30) { lastSend = now; net.sendFast(netSnapshot()); }
      }
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
        if (resultTimer <= 0) {
          if (opts.mode === 'host' && net) net.send({ t: 'end', summary: game.summary() });
          onResult && onResult(game.summary(), game.teams.map(t => t.info));
        }
      }
    } else {
      latch.clear();
    }
    const T1 = PROF ? performance.now() : 0;
    const controlled = game && !replay ? controlledList() : [];
    if (game && !paused && !replay && opts.mode !== 'guest' && game.state !== 'goal') lerpApply(Math.min(1, acc / STEP));
    const T2 = PROF ? performance.now() : 0;
    scene.update(paused ? 0 : dt, controlled, { replay: !!replay, goalX });
    const T3 = PROF ? performance.now() : 0;
    drawHud(controlled);
    lerpRestore();
    if (PROF) window.__prof.push([Math.round(rawMs * 10) / 10, +(T1 - T0).toFixed(2), +(T3 - T2).toFixed(2), +(performance.now() - T3).toFixed(2)]);
    raf = requestAnimationFrame(frame);
  }
  raf = requestAnimationFrame(frame);

  function controlledList() {
    if (game.state === 'fulltime') return [];
    if (opts.mode === '1p') return [game.teams[0].controlled];
    if (opts.mode === '2p') return [game.teams[0].controlled, game.teams[1].controlled];
    if (opts.mode === 'host') return [game.teams[0].controlled];
    if (opts.mode === 'guest') return [game.teams[1].controlled];
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
    drawNetStat();
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

  function drawNetStat() {
    if (!isOnline()) return;
    const ms = opts.mode === 'guest' ? Math.round(rtt) : Math.round(peerRtt);
    if (!ms) return;
    const col = ms < 60 ? '#4ade80' : ms < 120 ? '#facc15' : '#f87171';
    hud.font = '700 12px system-ui, sans-serif'; hud.textAlign = 'right'; hud.textBaseline = 'top';
    hud.fillStyle = 'rgba(0,0,0,0.55)'; hud.fillRect(cssW - 96, 10, 84, 22);
    hud.fillStyle = col; hud.fillText('● 핑 ' + ms + 'ms', cssW - 18, 15);
  }

  function drawPlayerHud(p, slot) {
    const s = scene.project(p.x, p.y, 4.9);
    if (!s.visible) return;
    hud.font = '800 13px system-ui, sans-serif';
    hud.textAlign = 'center'; hud.textBaseline = 'bottom';
    hud.lineWidth = 3; hud.strokeStyle = 'rgba(0,0,0,0.6)';
    const label = (opts.mode === '2p' ? `${slot + 1}P` : isOnline() ? '나' : '1P') + (p.name ? ' ' + p.name : '');
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
    const fx = (v) => (opts.mode === 'guest' ? W - v : v), fy = (v) => (opts.mode === 'guest' ? H - v : v);
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
        hud.beginPath(); hud.arc(x + fx(p.x) * k, y + fy(p.y) * k, ci >= 0 ? 4.5 : 3.2, 0, Math.PI * 2); hud.fill();
        hud.strokeStyle = ci >= 0 ? P_COLORS[ci] : 'rgba(255,255,255,0.6)';
        hud.lineWidth = ci >= 0 ? 2 : 0.8; hud.stroke();
      }
    }
    hud.fillStyle = '#ffffff';
    hud.beginPath(); hud.arc(x + fx(game.ball.x) * k, y + fy(game.ball.y) * k, 2.5, 0, Math.PI * 2); hud.fill();
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
    start, toMenu, setPaused, setVisual, hostOnline, joinOnline, sendPick, sendSel, hostStartNow, closeNet,
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
