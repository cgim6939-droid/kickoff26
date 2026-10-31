// 팀 AI: 대형 유지, 공격 지원/침투, 수비 압박/마킹, 공 가진 선수의 판단, 골키퍼 위치
// 엔진(Game)이 이 모듈의 함수에 자신(g)을 넘겨서 씀. 화면/입력과는 무관해서 Node에서도 돌아감.
import { W, H, GOAL_HALF, BOX_DEPTH, BOX_HALF, SIX_DEPTH, DRAG, clamp, dist, segDist, segParam, randn, rotate } from './consts';
import { POS, STYLES, FORMATIONS, DEFAULT_FORMATION, autoOrder } from './formations';

// ================= 도우미 =================
// 땅볼 패스는 kickTo에서 처음 속도 = d*DRAG+140 으로 나가고 마찰로 줄어듦 → 도착 시간 계산
const C0 = 140 / DRAG;
const passTime = d => Math.log((d + C0) / C0) / DRAG;
const passTimeAt = (s, d) => { const f = 1 - s / (d + C0); return f <= 0.002 ? 9 : -Math.log(f) / DRAG; };

const norm = (x, y) => { const l = Math.hypot(x, y) || 1; return [x / l, y / l]; };

export function makeTactics(size, formation, style, over = {}) {
  const list = FORMATIONS[size] || FORMATIONS[11];
  const f = list[formation] ? formation : DEFAULT_FORMATION[size] || '4-4-2';
  const st = STYLES[style] ? style : 'balanced';
  return { formation: f, style: st, ...STYLES[st], ...over };
}

// 팀 초기화 (점유 상태, 계획 주기 등)
export function initTeamAI(t) {
  t.poss = 0.5; t.planT = Math.random() * 0.1; t.lostT = 9; t.wonT = 9; t._hadBall = false; t.pressMode = 0;
}

// 슬롯 정보를 선수에게 입힘
export function applySlots(t, size, formation) {
  const list = FORMATIONS[size] || FORMATIONS[11];
  const slots = list[formation] || list[DEFAULT_FORMATION[size]];
  // 선수마다 본래 자리(명단 번호)에 맞는 대형 자리를 줌 (3백일 때 미드필더가 센터백이 되는 일 방지)
  const idxs = t.players.map((_, i) => i);
  const roster = t.info && t.info.players;
  let slotFor = idxs;
  if (roster && !t.customOrder && t.players.length === slots.length && t.players.every(p => p.ri !== undefined)) {
    const pool = t.players.map(p => p.ri);
    const ordered = autoOrder(roster, slots, pool, t.info.tags);                       // 자리 순서대로의 명단 번호
    slotFor = t.players.map(p => ordered.indexOf(p.ri));                  // 선수 → 자리 번호
  }
  t.players.forEach((p, i) => {
    const s = slots[Math.min(slotFor[i], slots.length - 1)];
    const info = POS[s[0]] || POS.CM;
    p.slot = { pos: s[0], x: s[1], y: s[2], role: info.role, push: info.push || 0, follow: info.follow || 0.6, wide: !!info.wide };
    p.role = info.role === 'GK' ? 'GK' : info.role;
    p.hx = s[1]; p.hy = s[2];
    p.isGK = p.role === 'GK';
    p.ax = p.ay = undefined; p.plan = null;
  });
}

// ================= 대형 위치(anchor) =================
function anchorOf(g, t, p, ctx) {
  const s = p.slot, tac = t.tactics;
  const men = (tac.mentality + 1) / 2;
  const poss = t.poss;
  let nx = s.x + (ctx.ballProg - 0.45) * s.follow;
  nx += poss * s.push * (0.55 + 0.9 * men);
  if (s.role === 'DF') nx += (tac.line - 0.5) * 0.14;
  nx -= (1 - poss) * 0.03 * (1 - tac.press);
  const lo = s.role === 'DF' ? 0.07 : s.role === 'MF' ? 0.12 : 0.28;
  const hi = s.role === 'DF' ? 0.28 + 0.36 * tac.line : s.role === 'MF' ? 0.84 : 0.92;
  nx = clamp(nx, lo, hi);
  const wid = 1 + 0.28 * poss * tac.width;
  let ny = 0.5 + (s.y - 0.5) * (s.wide ? wid : 1 + 0.1 * poss);
  const bY = ctx.ballY / H - 0.5;
  const lat = (s.wide ? 0.2 : 0.3) * (1 - 0.5 * poss);
  ny += bY * lat;
  // 공 반대편 측면 선수는 수비 때 안쪽으로 좁힘
  if (s.wide && (s.y - 0.5) * bY < 0) ny = 0.5 + (ny - 0.5) * (1 - 0.35 * (1 - poss));
  ny = clamp(ny, 0.05, 0.95);
  return [nx, ny];
}

// 모든 선수의 대형 위치를 계산하고, 팀이 너무 늘어나지 않게 모음
function computeAnchors(g, t, ctx, players) {
  const tac = t.tactics;
  const nxs = [];
  for (const p of players) {
    const [nx, ny] = anchorOf(g, t, p, ctx);
    p._nx = nx; p._ny = ny;
    nxs.push(nx);
  }
  const outfield = players.filter(p => p.slot.role !== 'GK');
  if (outfield.length > 2) {
    let lo = 1, hi = 0;
    for (const p of outfield) { lo = Math.min(lo, p._nx); hi = Math.max(hi, p._nx); }
    const cap = 0.42 + 0.14 * (1 - tac.press);
    if (hi - lo > cap) {
      const k = cap / (hi - lo);
      for (const p of outfield) p._nx = lo + (p._nx - lo) * k;
    }
  }
  for (const p of players) {
    const ax = t.toWorldX(p._nx), ay = p._ny * H;
    if (p.ax === undefined) { p.ax = ax; p.ay = ay; }
    else { const k = 0.5; p.ax += (ax - p.ax) * k; p.ay += (ay - p.ay) * k; }
  }
}

// ================= 공격 지원 =================
// 후보 위치(팀 앞쪽 오프셋, 옆 오프셋)
const OFFSETS = [[0, 0], [80, 0], [-80, 0], [0, 90], [0, -90], [80, 80], [80, -80], [-80, 80], [-80, -80],
  [170, 0], [170, 100], [170, -100], [260, 0], [260, 130], [260, -130]];
// 포지션별 공과의 선호 거리
const PREF = { CB: [110, 320], LB: [150, 480], RB: [150, 480], LWB: [170, 540], RWB: [170, 540], DM: [120, 340], CM: [140, 400],
  AM: [160, 470], LM: [180, 540], RM: [180, 540], LW: [220, 680], RW: [220, 680], ST: [260, 720] };
// 포지션별 "앞으로 나가는" 가치
const PW = { CB: 0.5, LB: 0.9, RB: 0.9, LWB: 1.1, RWB: 1.1, DM: 0.8, CM: 1.1, AM: 1.6, LM: 1.4, RM: 1.4, LW: 1.7, RW: 1.7, ST: 2.2 };

function planAttack(g, t, ctx, players) {
  const opp = t.opp.players;
  const car = ctx.carrier;
  const cx = car.x, cy = car.y;
  const sp = Math.hypot(car.vx, car.vy);
  let fx = t.dir, fy = 0;
  if (sp > 40) { fx = fx * 0.6 + (car.vx / sp) * 0.4; fy = (car.vy / sp) * 0.4; [fx, fy] = norm(fx, fy); }
  const offLim = g.realistic ? g.offsideLine(t) - 0.02 : 1.2;
  // 공을 가진 선수가 압박받고 있는가
  let pressure = 1e9;
  for (const o of opp) pressure = Math.min(pressure, dist(o.x, o.y, cx, cy));
  const underPress = pressure < 70;
  const quick = t.wonT < 2.5 ? 1.35 : 1;       // 공을 막 되찾았으면 빠른 침투
  const order = players.filter(p => p !== car && p !== ctx.ctrl && p.stun <= 0)
    .sort((a, b) => dist(a.ax, a.ay, cx, cy) - dist(b.ax, b.ay, cx, cy));
  const taken = [];
  let near = 0;
  for (const p of order) {
    const A = { x: p.ax, y: p.ay };
    const dA = dist(A.x, A.y, cx, cy);
    const pos = p.slot.pos;
    if (dA > 1000) { p.plan = { x: A.x, y: A.y, sprint: false, mode: 'hold' }; taken.push(A); continue; }
    const pref = PREF[pos] || [140, 420];
    const pw = (PW[pos] || 1) * quick * (0.7 + 0.6 * t.tactics.direct);
    let best = null, bs = -1e9;
    for (const [ox, oy] of OFFSETS) {
      let x = A.x + ox * t.dir, y = A.y + oy;
      y = clamp(y, 60, H - 60);
      x = clamp(x, 50, W - 50);
      // 오프사이드가 되지 않는 선까지만
      if (t.prog(x) > offLim && p.slot.role !== 'DF') x = t.toWorldX(offLim);
      const dC = dist(x, y, cx, cy);
      let sc = 0;
      let nearest = 1e9;
      for (const o of opp) nearest = Math.min(nearest, dist(o.x, o.y, x, y));
      sc += 1.1 * clamp(nearest, 0, 150) / 150;
      if (dC > 60) {
        let lane = 1e9;
        for (const o of opp) lane = Math.min(lane, segDist(o.x, o.y, cx, cy, x, y));
        sc += (underPress ? 1.9 : 1.3) * clamp(lane / 50, 0, 1);
      }
      if (dC < pref[0]) sc -= (pref[0] - dC) / 190; else if (dC > pref[1]) sc -= (dC - pref[1]) / 520;
      const prog = t.prog(x) - t.prog(cx);
      sc += clamp(prog * pw, -0.5, 0.95);
      sc -= 0.9 * dist(x, y, A.x, A.y) / 270;
      for (const q of taken) { const d = dist(q.x, q.y, x, y); if (d < 130) sc -= 0.75 * (1 - d / 130); }
      if (dC < 120) sc -= 0.45;
      if (dC < 220 && near >= 2) sc -= 0.5;       // 공 근처에 너무 많이 몰리지 않게
      if (sc > bs) { bs = sc; best = { x, y }; }
    }
    if (dist(best.x, best.y, cx, cy) < 220) near++;
    const run = t.prog(best.x) - t.prog(p.x) > 0.05;
    p.plan = { x: best.x, y: best.y, sprint: (run && dist(p.x, p.y, best.x, best.y) > 110) || dist(p.x, p.y, best.x, best.y) > 260, mode: run ? 'run' : 'support', urgent: run };
    taken.push(best);
  }
}

// ================= 수비 =================
function planDefend(g, t, ctx, players) {
  const b = g.ball, O = b.owner;
  const tac = t.tactics;
  const gx = t.ownX, gy = H / 2;
  const opp = t.opp.players;
  const free = players.filter(p => p !== ctx.ctrl && p.stun <= 0 && !p.tackle);
  const toBall = p => dist(p.x, p.y, O.x, O.y) / g.maxSpeed(p, true);
  free.sort((a, c) => toBall(a) - toBall(c));
  let first = free[0] || null;
  // 사람이 더 가깝거나 비슷하면 AI는 1차 압박을 사람에게 맡기고 커버로
  if (t.human && ctx.ctrl && first && toBall(ctx.ctrl) < toBall(first) * 1.15 + 0.15) first = null;
  const bp = ctx.ballProg;
  let nPress = 1 + (tac.press > 0.6 ? 1 : 0) + (tac.press > 0.85 && bp > 0.5 ? 1 : 0);
  if (bp < 0.15 && tac.press > 0.4) nPress++;
  if (t.lostT < 1.5 && tac.press > 0.7) nPress++;
  const pressers = [];
  if (first) pressers.push(first);
  for (const p of free) {
    if (pressers.length >= nPress) break;
    if (p === first) continue;
    if (dist(p.x, p.y, O.x, O.y) < 380) pressers.push(p);
  }
  const [gdx, gdy] = norm(gx - O.x, gy - O.y);
  const dGoal = dist(O.x, O.y, gx, gy);
  // 가장 위험한 상대 패스 옵션 (공 소유자 앞쪽에 있는 상대 선수)
  let threat = null, ts = -1;
  for (const o of opp) {
    if (o === O || o.isGK) continue;
    const dO = dist(o.x, o.y, O.x, O.y);
    if (dO < 60 || dO > 520) continue;
    const adv = (dist(O.x, O.y, gx, gy) - dist(o.x, o.y, gx, gy)) / 300;
    const s = adv + 0.4 * (1 - dO / 520);
    if (s > ts) { ts = s; threat = o; }
  }
  pressers.forEach((p, i) => {
    let x, y, sprint = true, mode = 'press';
    const d = dist(p.x, p.y, O.x, O.y);
    if (i === 0 && first) {
      // 1차 수비수: 공과 골문 사이에서 거리를 두고 압박 (뛰어드는 것보다 길목 차단)
      const stand = 56 - 10 * tac.press;
      x = O.x + O.vx * 0.15 + gdx * stand; y = O.y + O.vy * 0.15 + gdy * stand;
      sprint = d > 120; mode = 'first';
    } else if (i === 1 || (i === 0 && !first)) {
      // 커버: 패스 길목 또는 1차 수비수 뒤
      if (threat && ts > 0.1) {
        const [tx, ty] = norm(threat.x - O.x, threat.y - O.y);
        x = O.x + tx * 95; y = O.y + ty * 95;
      } else {
        const k = clamp(dGoal * 0.42, 80, 150);
        x = O.x + gdx * k; y = O.y + gdy * k;
      }
      sprint = d > 160; mode = 'cover';
    } else {
      const side = Math.sign(p.y - O.y) || 1;
      const k = clamp(dGoal * 0.6, 120, 210);
      x = O.x + gdx * k - gdy * side * 55; y = O.y + gdy * k + gdx * side * 55;
      sprint = d > 200; mode = 'cover2';
    }
    p.plan = { x: clamp(x, 40, W - 40), y: clamp(y, 50, H - 50), sprint, mode, urgent: true };
  });
  // 나머지 수비: 위험한 상대를 한 명씩 마크 (골문 쪽에서 막음)
  const rest = free.filter(p => !pressers.includes(p));
  const R = 340 + 140 * tac.press;
  const threats = [];
  for (const o of opp) {
    if (o === O || o.isGK || o.out) continue;
    const dg = dist(o.x, o.y, gx, gy);
    threats.push({ o, danger: 1 - dg / (W * 0.95) + (t.prog(o.x) < 0.55 ? 0.25 : 0) });
  }
  threats.sort((a, c) => c.danger - a.danger);
  const pairs = [];
  for (const p of rest) {
    if (p.slot.role === 'FW' && bp < 0.5) continue;
    for (const th of threats) {
      const d = dist(p.ax, p.ay, th.o.x, th.o.y);
      if (d < R) pairs.push({ p, th, w: d - th.danger * 120 });
    }
  }
  pairs.sort((a, c) => a.w - c.w);
  const usedP = new Set(), usedT = new Set();
  for (const pr of pairs) {
    if (usedP.has(pr.p) || usedT.has(pr.th)) continue;
    usedP.add(pr.p); usedT.add(pr.th);
    const o = pr.th.o;
    const [ux, uy] = norm(gx - o.x, gy - o.y);
    const [bx, by] = norm(O.x - o.x, O.y - o.y);
    const x = o.x + ux * 34 + bx * 10, y = o.y + uy * 34 + by * 10;
    const d = dist(pr.p.x, pr.p.y, x, y);
    pr.p.plan = { x: clamp(x, 40, W - 40), y: clamp(y, 50, H - 50), sprint: d > 180, mode: 'mark', mark: o, urgent: d > 120 };
  }
  for (const p of rest) {
    if (usedP.has(p)) continue;
    p.plan = { x: p.ax, y: p.ay, sprint: dist(p.x, p.y, p.ax, p.ay) > 240, mode: 'hold' };
  }
}

// 공이 아무도 안 가졌을 때
function planLoose(g, t, ctx, players) {
  const b = g.ball;
  const free = players.filter(p => p !== ctx.ctrl && p.stun <= 0 && !p.tackle);
  const own = b.lastTouch === t.id;
  const cand = free.map(p => ({ p, t: g.intercept(p).t })).sort((a, c) => a.t - c.t);
  let chasers = 0;
  const maxChase = t.human ? 1 : 2;
  const ctrlT = ctx.ctrl ? g.intercept(ctx.ctrl).t : 1e9;
  for (const { p, t: tt } of cand) {
    const ic = g.intercept(p);
    // 사람 팀의 AI는 사람보다 확실히 가까울 때만 쫓음
    const ok = !t.human || tt < ctrlT * 0.7 - 0.1;
    if (chasers < maxChase && ok && (chasers === 0 || tt < cand[0].t * 1.6 + 0.2)) {
      p.plan = { x: ic.x, y: ic.y, sprint: true, mode: 'chase', urgent: true };
      chasers++;
    } else {
      p.plan = { x: p.ax, y: p.ay, sprint: dist(p.x, p.y, p.ax, p.ay) > 240, mode: 'hold' };
    }
  }
  void own;
}

// ================= 팀 계획 갱신 =================
function planTeam(g, t, hasBall, oppHasBall) {
  const b = g.ball, owner = b.owner;
  const ctrl = t.human ? t.controlled : null;
  const players = t.players.filter(p => !p.isGK && !p.out && p.slot);
  const ctx = { ballProg: clamp(t.prog(b.x), 0, 1), ballY: b.y, hasBall, oppHasBall, ctrl, carrier: null };
  computeAnchors(g, t, ctx, players);
  if (hasBall) { ctx.carrier = owner; planAttack(g, t, ctx, players); }
  else if (oppHasBall) {
    // 골키퍼가 공을 잡고 있으면 압박하지 않고 물러남
    if (owner.isGK && owner.team.inOwnBox(owner.x, owner.y)) {
      for (const p of players) {
        if (p === ctrl) continue;
        const d = dist(p.x, p.y, b.x, b.y);
        if (d < 150) { const [ux, uy] = norm(p.x - b.x, p.y - b.y); p.plan = { x: b.x + ux * 160, y: b.y + uy * 160, sprint: false, mode: 'hold' }; }
        else p.plan = { x: p.ax, y: p.ay, sprint: false, mode: 'hold' };
      }
    } else planDefend(g, t, ctx, players);
  } else if (b.passTarget && b.passTarget.team === t && !b.passTarget.out) {
    ctx.carrier = b.passTarget; planAttack(g, t, ctx, players);
  } else planLoose(g, t, ctx, players);
}

// ================= 선수 행동 =================
function followPlan(g, p, dt) {
  const pl = p.plan;
  if (!pl) { pl0(g, p); return; }
  if (p.tx === undefined) { p.tx = pl.x; p.ty = pl.y; }
  const k = Math.min(1, dt * (pl.urgent ? 10 : 5));
  p.tx += (pl.x - p.tx) * k; p.ty += (pl.y - p.ty) * k;
  const d = dist(p.x, p.y, p.tx, p.ty);
  if (d < (pl.urgent ? 6 : 11)) { p.dvx = p.dvy = 0; p.sprint = false; return; }
  g.moveToward(p, p.tx, p.ty, pl.sprint || d > 340, true);
  if (!pl.urgent && !p.sprint) { p.dvx *= 0.82; p.dvy *= 0.82; }
}
function pl0(g, p) {
  if (p.ax === undefined) { p.dvx = p.dvy = 0; return; }
  g.moveToward(p, p.ax, p.ay, false, true);
}

// 공을 막 향해 오는 패스를 받으러 감
function receive(g, p) {
  const ic = g.intercept(p);
  g.moveToward(p, ic.x, ic.y, ic.t > 0.4, true);
}

// 1차 수비수의 태클 시도 (AI 팀만)
function tackleTry(g, p, dt) {
  const b = g.ball, O = b.owner;
  if (!O || O.team === p.team || p.team.human || O.protect > 0 || O.isGK || p.tackleCd > 0) return;
  const sk = p.team.skill;
  const d = dist(p.x, p.y, b.x, b.y);
  const aggr = 0.6 + 0.8 * p.team.tactics.press;
  if (d < 34 && Math.random() < dt * 0.7 * sk.tackle * aggr) {
    g.startTackle(p, 'stand', b.x - p.x, b.y - p.y); p.tackleCd = 0.8;
  } else if (d > 38 && d < 78 && Math.random() < dt * 0.14 * sk.tackle * aggr) {
    g.startTackle(p, 'slide', b.x - p.x, b.y - p.y); p.tackleCd = 1.2;
  }
}

// ================= 가치 계산: "이 자리에서 공을 가지면 결국 득점할 확률" =================
// 슛 각도(골문이 보이는 각)와 거리로 계산. 공을 가진 선수의 판단은 모두 이 값을 기준으로 비교함.
function geoXg(t, x, y) {
  const dx = Math.max(8, Math.abs(t.attackX - x)), dy = y - H / 2;
  const d = Math.hypot(dx, dy);
  const ang = Math.abs(Math.atan2(dy + GOAL_HALF, dx) - Math.atan2(dy - GOAL_HALF, dx));
  return ang * 0.55 * Math.exp(-d / 500);
}
function pvAt(t, x, y) {
  const pr = clamp(t.prog(x), 0, 1);
  return 0.9 * geoXg(t, x, y) + 0.05 * pr * pr;
}

// 슛 기대 득점: 위치 가치에서 수비수가 막고 있으면 깎음
export function xgAt(g, p, x = p.x, y = p.y) {
  const t = p.team, gx = t.attackX, gy = H / 2;
  const dx = Math.abs(gx - x);
  if (dx < 3) return 0;
  let xg = geoXg(t, x, y);
  let blocks = 0;
  for (const o of t.opp.players) {
    if (o.isGK || o.out) continue;
    if (Math.abs(o.x - gx) > dx) continue;           // 슈터 뒤쪽 수비수는 제외
    if (segDist(o.x, o.y, x, y, gx, gy) < 26) blocks++;
  }
  xg *= Math.pow(0.7, Math.min(2, blocks));
  // 슈팅이 좋은 선수일수록 높음
  xg *= clamp(1.15 - (p.shotErr - 0.5) * 0.57, 0.75, 1.15);
  return xg;
}

// 슛 종류/조준 선택
function chooseShot(g, p) {
  const t = p.team, gk = t.opp.gk;
  const dG = dist(p.x, p.y, t.attackX, H / 2);
  const sk = t.skill;
  const side = gk.y > H / 2 ? -1 : 1;                   // 키퍼 반대쪽 구석
  const s = Math.random() < 0.78 ? side : -side;
  const aimY = H / 2 + s * GOAL_HALF * (0.45 + Math.random() * 0.4);
  const gkOff = Math.abs(gk.x - t.attackX);
  let kind = 'normal';
  const r = Math.random();
  if (gkOff > 85 && dG < 380 && r < 0.55) kind = 'chip';
  else if (dG > 240 && dG < 560 && Math.abs(p.y - H / 2) > 60 && r < 0.55) kind = 'finesse';
  else if (dG < 230 && r < 0.4) kind = 'drive';
  const power = clamp(0.5 + dG / 800, 0.55, 1) * (0.88 + Math.random() * 0.12);
  // 골대 앞에서는 오차를 크게 줄이고, 상단 구석(위쪽 모서리) 또는 낮은 구석으로 정확히 찔러 넣음
  let err = sk.error * 1.1 * (dG < 420 ? 0.6 : 1) * (dG < 250 ? 0.6 : 1);
  let aimH, aimYf = aimY;
  if (kind === 'normal' || kind === 'drive') {
    const bins = Math.random() < 0.62;
    const sgn = Math.sign(aimY - H / 2) || 1;
    aimYf = H / 2 + sgn * GOAL_HALF * (bins ? 0.72 + Math.random() * 0.1 : 0.55 + Math.random() * 0.25);
    aimH = bins ? 44 + Math.random() * 14 : 6 + Math.random() * 16;
  }
  if (kind === 'finesse') {
    // 감아차기: 키퍼 반대쪽(먼 쪽) 포스트 상단으로 휘어 넣음
    aimYf = H / 2 + side * GOAL_HALF * (0.74 + Math.random() * 0.1);
    aimH = 42 + Math.random() * 14;
    err *= 0.8;
  } else if (kind === 'chip') {
    err *= 0.7;
  }
  return { kind, aimY: aimYf, aimH, power, err };
}

// ================= 패스 옵션 평가 =================
// 각 옵션의 점수 = 기대 가치: 성공하면 받는 자리의 가치, 실패(빼앗김)하면 상대가 그 자리에서 얻는 가치만큼 손해
// 반환: { mate, score, lofted, tx, ty, kind, risk, free, d }  (kind: short/long/through/cross/back)
export function evalPasses(g, p, opts = {}) {
  const t = p.team, opp = t.opp.players;
  const sk = t.skill, tac = t.tactics;
  const out = [];
  let pressure = 1e9;
  for (const o of opp) pressure = Math.min(pressure, dist(o.x, o.y, p.x, p.y));
  const offLine = g.realistic ? g.offsideLine(t) : 9;
  const fromGK = !!opts.fromGK;
  const oppT = t.opp;
  for (const m of t.players) {
    if (m === p || m.out) continue;
    if (m.isGK && (fromGK || t.prog(p.x) > 0.4)) continue;
    const d0 = dist(p.x, p.y, m.x, m.y);
    if (d0 < 55 || d0 > 900) continue;
    // 받는 선수가 도착할 위치(달리는 방향 반영)
    const lead = clamp(0.2 + d0 / 900, 0.25, 0.8);
    const ax = clamp(m.x + m.vx * lead, 30, W - 30), ay = clamp(m.y + m.vy * lead, 30, H - 30);
    if (g.realistic && !m.isGK && t.prog(ax) > offLine + 0.004 && t.prog(ax) > t.prog(p.x)) continue;   // 오프사이드 위치로는 안 줌
    const d = dist(p.x, p.y, ax, ay);
    // 땅볼 패스 위험도: 중간에 상대가 먼저 도착할 수 있는가
    const tr = passTime(d);
    let risk = 0;
    for (const o of opp) {
      if (o.out) continue;
      const u = segParam(o.x, o.y, p.x, p.y, ax, ay);
      const px = p.x + (ax - p.x) * u, py = p.y + (ay - p.y) * u;
      const tb = passTimeAt(u * d, d);
      const to = Math.max(0, dist(o.x, o.y, px, py) - 16) / (BASE_O * o.pace * 1.05) + 0.1;
      if (to < tb) risk = Math.max(risk, clamp((tb - to) / 0.5 + 0.3, 0, 1));
    }
    // 받는 선수 주변 여유 공간
    let nearOpp = 1e9;
    for (const o of opp) nearOpp = Math.min(nearOpp, dist(o.x, o.y, ax, ay) - 130 * Math.min(tr, 1));
    const freeSp = clamp((nearOpp + 20) / 130, 0, 1);
    const prog = t.prog(ax) - t.prog(p.x);
    let lofted = false, kind = prog > 0.03 ? 'short' : prog < -0.03 ? 'back' : 'side';
    if (d > 420) kind = 'long';
    // 길이 막혔지만 받는 선수가 비어 있으면 띄워서 넘김
    let rk = risk;
    if (risk > 0.5 && freeSp > 0.55 && d > 260) { lofted = true; rk = risk * 0.45; }
    else if (d > 420 && risk > 0.35) { lofted = true; rk = risk * 0.6; }
    const P = (1 - rk) * (0.45 + 0.55 * freeSp) * (1 - clamp((d - 500) / 1500, 0, 0.3));
    let ev = P * pvAt(t, ax, ay) - (1 - P) * 0.5 * pvAt(oppT, ax, ay);
    if (d < 85) ev -= 0.004;
    ev += (1 - tac.direct) * 0.012 * P;                       // 점유 선호
    if (m.isGK) ev -= pressure < 60 ? 0.0 : 0.03;
    if (m.slot && m.slot.wide) ev += (tac.width - 0.5) * 0.01 * P;
    out.push({ mate: m, score: ev, lofted, tx: ax, ty: ay, kind, risk: rk, free: freeSp, d, P });

    // 스루패스: 수비 뒤 공간으로 침투하는 선수
    const sp = Math.hypot(m.vx, m.vy);
    if (!m.isGK && !fromGK && (sk.vision ?? 0.7) * Math.random() > 0.22 && (sp > 70 || (m.slot && m.slot.role === 'FW')) && prog > 0.02) {
      const [fx, fy] = sp > 30 ? norm(m.vx, m.vy) : [t.dir, 0];
      const run = clamp(70 + sp * 0.5, 70, 190);
      let tx = clamp(m.x + fx * run + (m.vx * 0.4), 40, W - 40), ty = clamp(m.y + fy * run * 0.6, 50, H - 50);
      if (g.realistic && t.prog(tx) > offLine) tx = t.toWorldX(offLine - 0.006);
      const dT = dist(p.x, p.y, tx, ty);
      if (dT > 140 && dT < 640) {
        let risk2 = 0, oppTime = 1e9;
        for (const o of opp) {
          if (o.out) continue;
          const u = segParam(o.x, o.y, p.x, p.y, tx, ty);
          const px = p.x + (tx - p.x) * u, py = p.y + (ty - p.y) * u;
          const tb = passTimeAt(u * dT, dT);
          const to = Math.max(0, dist(o.x, o.y, px, py) - 16) / (BASE_O * 1.05) + 0.1;
          if (to < tb) risk2 = Math.max(risk2, clamp((tb - to) / 0.5 + 0.3, 0, 1));
          oppTime = Math.min(oppTime, Math.max(0, dist(o.x, o.y, tx, ty) - 16) / (BASE_O * 1.05));
        }
        const mT = dist(m.x, m.y, tx, ty) / (BASE_O * m.pace * 1.35);
        const win = oppTime - mT;
        if (win > 0.1 && risk2 < 0.5) {
          const P2 = (1 - risk2) * clamp(0.4 + win * 0.8, 0.4, 1);
          const ev2 = P2 * pvAt(t, tx, ty) * 1.08 - (1 - P2) * 0.5 * pvAt(oppT, tx, ty) + (tac.direct - 0.45) * 0.01;
          out.push({ mate: m, score: ev2, lofted: false, tx, ty, kind: 'through', risk: risk2, free: 1, d: dT, P: P2 });
        }
      }
    }
    // 크로스: 측면에서 박스 안 동료에게
    if (!m.isGK && !fromGK && t.prog(p.x) > 0.66 && Math.abs(p.y - H / 2) > 230 && dist(ax, ay, t.attackX, H / 2) < BOX_DEPTH + 90 && d0 > 180) {
      let crowd = 1e9;
      for (const o of opp) crowd = Math.min(crowd, dist(o.x, o.y, ax, ay));
      const P3 = 0.25 + 0.35 * clamp(crowd / 110, 0, 1);
      const ev3 = P3 * pvAt(t, ax, ay) * 0.85 - (1 - P3) * 0.2 * pvAt(oppT, ax, ay) + (tac.width - 0.5) * 0.012;
      out.push({ mate: m, score: ev3, lofted: true, tx: ax, ty: ay, kind: 'cross', risk: 0.3, free: clamp(crowd / 110, 0, 1), d, P: P3 });
    }
  }
  out.sort((a, c) => c.score - a.score);
  return out;
}
const BASE_O = 128;   // 상대 수비수 기본 속도 추정치 (엔진 BASE_SPEED와 같게)

export function bestPass(g, p, fromGK) {
  const list = evalPasses(g, p, { fromGK });
  return list[0] || null;
}

// ================= 드리블 방향 =================
function dribbleDir(g, p) {
  const t = p.team, opp = t.opp.players;
  const gx = t.attackX, gy = H / 2;
  const base = Math.atan2(gy - p.y, gx - p.x);
  let best = null, bs = -1e9;
  for (let k = -4; k <= 4; k++) {
    const a = base + k * 0.3;
    const dx = Math.cos(a), dy = Math.sin(a);
    let free = 220;
    for (const o of opp) {
      const rx = o.x - p.x, ry = o.y - p.y;
      const along = rx * dx + ry * dy;
      if (along < 0 || along > 220) continue;
      const lat = Math.abs(rx * -dy + ry * dx);
      if (lat < 42) free = Math.min(free, Math.max(0, along - 18));
    }
    // 경기장 가장자리 피하기
    const ex = p.x + dx * 140, ey = p.y + dy * 140;
    let edge = 0;
    if (ey < 70 || ey > H - 70) edge = 0.6;
    if (ex < 40 || ex > W - 40) edge = 0.8;
    const v = pvAt(t, p.x + dx * Math.min(free, 130), p.y + dy * Math.min(free, 130));
    const sc = v * 10 + free / 220 * 0.9 - Math.abs(k) * 0.05 - edge;
    if (sc > bs) { bs = sc; best = { dx, dy, free, sc, v }; }
  }
  return best;
}

// ================= 공을 가진 AI 선수 =================
export function carrierThink(g, p, dt) {
  const t = p.team, sk = t.skill, tac = t.tactics;
  p.holdT += dt;
  p.aiT -= dt;
  p.carryT = Math.max(0, (p.carryT || 0) - dt);
  const gx = t.attackX, gy = H / 2;
  let press = 1e9;
  for (const o of t.opp.players) { const d = dist(o.x, o.y, p.x, p.y); if (d < press) press = d; }

  // 페널티/프리킥 직접 슛
  if (p.forceShot) {
    p.dvx = p.dvy = 0;
    if (p.aiT <= 0) {
      const pen = p.forceShot === 'penalty';
      p.forceShot = null;
      if (pen) g.shoot(p, 0.75 + Math.random() * 0.2, H / 2 + (Math.random() < 0.5 ? -1 : 1) * GOAL_HALF * (0.45 + Math.random() * 0.4), 0.5);
      else { const sh = chooseShot(g, p); g.shoot(p, sh.power, sh.aimY, sh.err, sh.kind === 'chip' ? 'normal' : sh.kind, false, sh.kind === 'chip' ? undefined : sh.aimH); }
    }
    return;
  }
  if (p.locked) p.dvx = p.dvy = 0;

  // 코너킥: 박스 안 동료에게 크로스
  if (g.setPieceKind === 'corner' && p.mustPass) {
    p.dvx = p.dvy = 0;
    if (p.aiT <= 0) cornerCross(g, p);
    return;
  }

  if (p.aiT <= 0 || (press < 40 && p.aiT < sk.decide * 0.5)) {
    p.aiT = sk.decide * (0.6 + Math.random() * 0.8);
    const passes = evalPasses(g, p);
    const best = passes[0];
    const noise = 0.003 + 0.02 * (sk.decide - 0.12);
    // ① 슛: 이 자리에서 쏠 때의 기대 득점
    const xg = xgAt(g, p);
    let evShoot = -1;
    if (!p.mustPass && Math.abs(gx - p.x) > 40 && xg > 0.025) evShoot = xg - 0.01 * (1 - xg);
    // ② 드리블: 앞으로 치고 나갈 때의 가치 (압박받을수록 빼앗길 확률이 커짐)
    const dr = dribbleDir(g, p);
    p.dribDir = dr;
    let evDrib = -1;
    if (dr && !p.mustPass && !p.locked) {
      const Pd = clamp(0.93 - 0.55 * clamp((80 - press) / 80, 0, 1) - 0.1 * (1 - p.dribble / 100) - (dr.free < 90 ? 0.25 : 0), 0.2, 0.95);
      const adv = Math.min(dr.free, 130);
      evDrib = Pd * pvAt(t, p.x + dr.dx * adv, p.y + dr.dy * adv) - (1 - Pd) * 0.5 * pvAt(t.opp, p.x, p.y) + 0.004;
      // 방금 막 드리블을 시작했으면 잠깐 이어서 몰고 감
      if (p.carryT > 0) evDrib += 0.012;
    }
    // ③ 패스
    const evPass = best ? best.score + randn() * noise : -1;
    // 선택
    let act = 'drib', v = evDrib;
    if (best && evPass > v + (press < 55 ? -0.004 : 0.004)) { act = 'pass'; v = evPass; }
    if (evShoot > v * 0.97 && (xg > 0.05 || press < 46 || p.holdT > 2.4)) { act = 'shoot'; }
    if (p.mustPass && best) act = 'pass';
    if (act === 'drib' && (!dr || evDrib < -0.5)) act = best ? 'pass' : 'drib';
    if (g.debugAI) g.debugAI.push({ t: +g.clock.toFixed(1), team: t.id, pos: p.slot && p.slot.pos, prog: +t.prog(p.x).toFixed(2), xg: +xg.toFixed(3), press: Math.round(press), hold: +p.holdT.toFixed(1),
      evS: +evShoot.toFixed(3), evD: +evDrib.toFixed(3), evP: +evPass.toFixed(3), bestKind: best && best.kind, act });
    if (act === 'shoot') {
      const sh = chooseShot(g, p);
      g.shoot(p, sh.power, sh.aimY, sh.err, sh.kind, false, sh.aimH);
      return;
    }
    if (act === 'pass' && best) {
      doPassAction(g, p, best);
      return;
    }
    p.carryT = 0.7;
    if (!p.mustPass && press < 62 && press > 24 && p.dribble > 68 && Math.random() < 0.22) g.doFeint(p);
    if (p.mustPass && p.holdT > 1.5) {
      g.kickTo(p, t.toWorldX(clamp(t.prog(p.x) + 0.25, 0, 0.85)), H * (0.3 + Math.random() * 0.4), true, sk.error, {});
      return;
    }
    // 수비 쪽에서 압박이 심한데 줄 곳이 없으면 걷어냄
    if (t.prog(p.x) < 0.2 && press < 50 && !best) {
      const side = p.y < H / 2 ? 0.12 : 0.88;
      g.kickTo(p, t.toWorldX(0.55), H * side, true, 1.3, {});
      return;
    }
  }
  if (p.locked) return;

  // 드리블 이동
  const dr = p.dribDir || dribbleDir(g, p);
  if (!dr) { g.moveToward(p, gx, gy, false, false); return; }
  const open = press > 75 && p.stamina > 0.3 && dr.free > 120;
  g.moveToward(p, p.x + dr.dx * 120, p.y + dr.dy * 120, open, false);
}

function doPassAction(g, p, best) {
  const t = p.team, sk = t.skill;
  const err = sk.error * (1.35 - (p.pass || 70) / 100 * 0.95);
  t.stats.passes++;
  if (best.kind === 'through') {
    g.kickTo(p, best.tx, best.ty, false, err * 1.1, { passTarget: best.mate });
  } else if (best.kind === 'cross') {
    const k = g.kickTo(p, best.tx + t.dir * 8, best.ty, true, err * 1.2, { passTarget: best.mate });
    void k;
  } else {
    g.passTo(p, best.mate, best.lofted, err);
  }
}

function cornerCross(g, p) {
  const t = p.team;
  // 박스 안에서 가장 비어 있는 동료
  let best = null, bs = -1e9;
  for (const m of t.players) {
    if (m === p || m.isGK) continue;
    const dg = dist(m.x, m.y, t.attackX, H / 2);
    if (dg > BOX_DEPTH + 40) continue;
    let nearest = 1e9;
    for (const o of t.opp.players) nearest = Math.min(nearest, dist(o.x, o.y, m.x, m.y));
    const s = clamp(nearest, 0, 120) / 120 - dg / 600;
    if (s > bs) { bs = s; best = m; }
  }
  t.stats.passes++;
  if (best) {
    g.kickTo(p, best.x + best.vx * 0.5, best.y + best.vy * 0.5, true, t.skill.error, { passTarget: best });
  } else {
    g.kickTo(p, t.attackX - t.dir * 150, H / 2 + (Math.random() - 0.5) * 120, true, t.skill.error * 1.3, {});
  }
}

// ================= 팀 전체 사고 =================
export function thinkTeam(g, t, dt) {
  const b = g.ball, owner = b.owner;
  const hasBall = !!owner && owner.team === t;
  const oppHasBall = !!owner && owner.team !== t;
  const ctrl = t.human ? t.controlled : null;
  const target = hasBall ? 1 : oppHasBall ? 0 : (b.lastTouch === t.id ? 0.7 : 0.3);
  t.poss += (target - t.poss) * Math.min(1, dt * (target > t.poss ? 2.2 : 3.2));
  if (t._hadBall !== hasBall) {
    if (!hasBall && t._hadBall) t.lostT = 0;
    if (hasBall && !t._hadBall) t.wonT = 0;
    t._hadBall = hasBall;
  }
  t.lostT += dt; t.wonT += dt;
  t.planT -= dt;
  if (t.planT <= 0) {
    t.planT = 0.09 + (1 - (t.skill.react || 0.7)) * 0.2 + Math.random() * 0.03;
    planTeam(g, t, hasBall, oppHasBall);
  }
  for (const p of t.players) {
    if (p === ctrl || p.out) continue;
    p.sprint = false;
    if (p.stun > 0 || p.tackle) continue;
    if (p.isGK) { g.thinkGK(p, dt); continue; }
    if (owner === p) { carrierThink(g, p, dt); continue; }
    if (p.header) { g.moveToward(p, p.header.x, p.header.y, true, false); continue; }
    if (!owner && b.passTarget === p) { receive(g, p); continue; }
    if (p.plan && p.plan.mode === 'first') tackleTry(g, p, dt);
    followPlan(g, p, dt);
  }
}

// ================= 경기가 멈춰 있을 때(재시작 준비 / 골 세리머니) =================
// 스로인/골킥/프리킥: 공을 차는 팀은 받을 자리를 만들고, 수비팀은 대형을 유지. 코너킥은 박스 안 자리를 나눠 맡음
function cornerAttack(g, t, r, players, taker) {
  const ax = t.attackX, d = t.dir;
  const sg = r.y < H / 2 ? -1 : 1;
  const slots = [
    [ax - d * 70, H / 2 + sg * 60], [ax - d * 190, H / 2 + sg * 15], [ax - d * 90, H / 2 - sg * 75],
    [ax - d * 300, H / 2 - sg * 30], [ax - d * 120, H / 2 + sg * 130],
  ];
  const cand = players.filter(p => p !== taker && p.slot.role !== 'DF' || p.slot.pos === 'CB').filter(p => p !== taker)
    .sort((a1, c1) => (c1.physical + (c1.slot.role === 'FW' ? 8 : 0)) - (a1.physical + (a1.slot.role === 'FW' ? 8 : 0)));
  const picked = cand.slice(0, slots.length);
  picked.forEach((p, i) => { p.plan = { x: slots[i][0], y: slots[i][1], sprint: dist(p.x, p.y, slots[i][0], slots[i][1]) > 160, mode: 'run', urgent: true }; });
  for (const p of players) if (!picked.includes(p) && p !== taker) {
    // 나머지는 역습에 대비해 중앙선 근처에서 대기
    p.plan = { x: p.ax, y: p.ay, sprint: false, mode: 'hold' };
    if (p.slot.role === 'DF') p.plan = { x: t.toWorldX(0.52), y: p.ay, sprint: false, mode: 'hold' };
  }
}
function cornerDefend(g, t, r, players) {
  const ox = t.ownX, d = t.dir;
  const sg = r.y < H / 2 ? -1 : 1;
  const posts = [[ox + d * 16, H / 2 - 66], [ox + d * 16, H / 2 + 66]];
  const free = players.slice();
  // 골대 양쪽 기둥 옆에 두 명
  for (const [px, py] of posts) {
    free.sort((a1, c1) => dist(a1.ax, a1.ay, px, py) - dist(c1.ax, c1.ay, px, py));
    const p = free.shift();
    if (p) p.plan = { x: px, y: py, sprint: true, mode: 'mark', urgent: true };
  }
  // 나머지는 박스 안 상대를 한 명씩 맡음 (골문 쪽에 서서)
  const att = t.opp.players.filter(o => !o.isGK && !o.out && dist(o.x, o.y, ox, H / 2) < BOX_DEPTH + 160);
  free.sort((a1, c1) => dist(a1.ax, a1.ay, ox, H / 2) - dist(c1.ax, c1.ay, ox, H / 2));
  for (const p of free) {
    let best = null, bd = 1e9;
    for (const o of att) { if (o._cm) continue; const dd = dist(p.x, p.y, o.x, o.y); if (dd < bd) { bd = dd; best = o; } }
    if (best) {
      best._cm = true;
      const [ux, uy] = norm(ox - best.x, H / 2 - best.y);
      p.plan = { x: best.x + ux * 28, y: best.y + uy * 28, sprint: bd > 140, mode: 'mark', urgent: true };
    } else {
      p.plan = { x: t.toWorldX(0.34), y: p.ay, sprint: false, mode: 'hold' };
    }
  }
  for (const o of att) o._cm = false;
  void sg;
}

export function thinkRest(g, t, r, dt) {
  t.planT -= dt;
  const players = t.players.filter(p => !p.isGK && !p.out && p.slot);
  const attacking = !!r && t === r.team;
  if (t.planT <= 0) {
    t.planT = 0.12;
    const rx = r && r.x !== undefined ? r.x : g.ball.x, ry = r && r.y !== undefined ? r.y : g.ball.y;
    const ctx = { ballProg: clamp(t.prog(rx), 0, 1), ballY: ry, hasBall: attacking, oppHasBall: !attacking, ctrl: null, carrier: null };
    t.poss = attacking ? 0.8 : 0.2;
    computeAnchors(g, t, ctx, players);
    const kind = r && r.kind;
    if (kind === 'corner') {
      if (attacking) cornerAttack(g, t, r, players, r.taker); else cornerDefend(g, t, r, players);
    } else if (attacking && (kind === 'throw' || kind === 'goalkick' || kind === 'freekick') && r.x !== undefined) {
      ctx.carrier = { x: r.x, y: r.y, vx: 0, vy: 0 };
      const others = players.filter(p => p !== r.taker);
      planAttack(g, t, ctx, others);
    } else {
      for (const p of players) p.plan = { x: p.ax, y: p.ay, sprint: dist(p.x, p.y, p.ax, p.ay) > 260, mode: 'hold' };
    }
  }
  for (const p of t.players) {
    if (p.out) continue;
    p.sprint = false;
    if (r && p === r.taker && g.state === 'out') { g.moveToward(p, r.px, r.py, true, true); continue; }
    if (p.isGK) { gkPosition(g, p); continue; }
    followPlan(g, p, dt);
  }
}

// ================= 골키퍼 위치 =================
export function gkPosition(g, p) {
  const t = p.team, b = g.ball;
  const dt = g.dt || 1 / 60;
  const gx = t.ownX, gy = H / 2;
  const dBall = Math.max(1, dist(b.x, b.y, gx, gy));
  let depth = clamp(dBall * 0.1, 14, 62);
  // 우리 팀이 높이 올라가 있고 상대가 공이 없으면 스위퍼처럼 앞으로
  const ourBall = !b.owner || b.owner.team === t;
  if (ourBall && t.prog(b.x) > 0.55) depth = clamp(depth + (t.prog(b.x) - 0.55) * 300, depth, 140);
  const ux = (b.x - gx) / dBall, uy = (b.y - gy) / dBall;
  const rx = gx + ux * depth;
  const ry = clamp(gy + uy * depth, gy - GOAL_HALF * 0.95, gy + GOAL_HALF * 0.95);
  // 목표점을 천천히 따라가게 해서(저역 통과) 공이 움직일 때마다 발을 바꾸는 떨림을 없앰
  if (p.gtx === undefined) { p.gtx = rx; p.gty = ry; }
  const k = 1 - Math.exp(-dt * 4);
  p.gtx += (rx - p.gtx) * k; p.gty += (ry - p.gty) * k;
  const err = dist(p.x, p.y, p.gtx, p.gty);
  // 조금 어긋난 건 그냥 서 있고, 충분히 벌어졌을 때만 걸어서 이동 (멈춤/이동 경계에 히스테리시스)
  if (!p.gkMoving && err < 24) { p.dvx = p.dvy = 0; return; }
  if (err > 24) p.gkMoving = true;
  if (err < 7) { p.gkMoving = false; p.dvx = p.dvy = 0; return; }
  g.moveToward(p, p.gtx, p.gty, err > 150, true);
  const l = Math.hypot(p.dvx, p.dvy);
  if (l > 0 && l < 60) { p.dvx *= 60 / l; p.dvy *= 60 / l; }
}

// ================= 선수 능력치 =================
export function deriveAttrs(info, role, rating, hash01) {
  const [name, num, speed, shooting] = info;
  const h1 = hash01(String(name) + num, 1), h2 = hash01(String(name) + num, 2), h3 = hash01(String(name) + num, 3);
  const r = rating || [78, 78, 78, 78];
  const att = r[1], mid = r[2], def = r[3];
  const isDF = role === 'DF', isMF = role === 'MF', isFW = role === 'FW';
  // 같은 팀 안에서도 슈팅/속도가 높은 공격 자원일수록 패스·드리블이 좋도록 (스타와 평범한 선수 구분)
  const star = role === 'GK' ? 0 : clamp((shooting - 72) * 0.18 + (speed - 74) * 0.08, -4, 6);
  const pass = clamp(60 + (mid - 78) + (isMF ? 7 : isFW ? -1 : isDF ? 0 : -4) + star * 0.8 + (h1 - 0.5) * 10, 38, 96);
  const dribble = clamp(58 + (att - 78) + (speed - 70) * 0.2 + (isFW || isMF ? 6 : -8) + star + (h2 - 0.5) * 10, 30, 96);
  const defend = clamp(56 + (def - 78) + (isDF ? 14 : isMF ? 0 : -20) + (h3 - 0.5) * 12, 20, 96);
  const physical = clamp(66 + (isDF ? 6 : 0) + (h1 - 0.5) * 18, 40, 94);
  return { pass, dribble, defend, physical, shoot: shooting, speed };
}
