// 게임 로직 (물리, AI, 규칙). 화면/입력과 분리되어 있어 Node에서도 실행 가능.
import {
  W, H, GOAL_HALF, GOAL_DEPTH, CROSSBAR, BOX_DEPTH, BOX_HALF, SIX_DEPTH, SIX_HALF, PEN_SPOT, CIRCLE_R, POST_R, PR, BR,
  DRAG, AIR_DRAG, GRAVITY, BASE_SPEED, SPRINT_MUL, TACKLE_SPEED, TACKLE_TIME, TACKLE_RECOVER,
  clamp, dist, randn, segDist, rotate, hash01,
} from './consts';
import { FORMATIONS, ROSTER_PICK, POS, STYLES, suggestTactics, autoOrder } from './formations';
import * as AI from './ai';

const ROLE_PACE = { GK: 0.95, DF: 0.97, MF: 1.0, FW: 1.04 };

// 난이도 6단계. speed: 이동 속도, decide: 판단 간격(작을수록 빠름), error: 패스/슛 오차, steal/tackle: 뺏기 적극성,
// gk: 골키퍼 능력, react: 상황 반응 속도(0~1), vision: 스루패스/침투를 보는 눈(0~1), press: 압박 강도(0~1)
const DIFFICULTY = {
  beginner: { speed: 0.84, decide: 0.62, error: 2.3, steal: 0.16, tackle: 0.3, gk: 0.6, react: 0.2, vision: 0.2, press: 0.25 },
  easy:     { speed: 0.9,  decide: 0.46, error: 1.7, steal: 0.3,  tackle: 0.5, gk: 0.8, react: 0.4, vision: 0.4, press: 0.4 },
  semipro:  { speed: 0.96, decide: 0.36, error: 1.3, steal: 0.4,  tackle: 0.75, gk: 0.9, react: 0.55, vision: 0.55, press: 0.55 },
  normal:   { speed: 1.0,  decide: 0.3,  error: 1.0, steal: 0.5,  tackle: 1.0, gk: 1.0, react: 0.7, vision: 0.7, press: 0.7 },
  hard:     { speed: 1.06, decide: 0.2,  error: 0.72, steal: 0.7, tackle: 1.35, gk: 1.15, react: 0.85, vision: 0.85, press: 0.85 },
  legend:   { speed: 1.12, decide: 0.12, error: 0.5, steal: 0.95, tackle: 1.7, gk: 1.3, react: 1.0, vision: 1.0, press: 1.0 },
};

const blankInput = () => ({ mx: 0, my: 0, pass: false, shoot: false, through: false, lob: false, sprint: false, switch: false, fin: false, chip: false, drive: false, skill: false });
export const SWEET_LO = 0.62, SWEET_HI = 0.9;
const shotKindOf = inp => (inp.fin ? 'finesse' : inp.chip ? 'chip' : inp.drive ? 'drive' : 'normal');

class Player {
  constructor(team, idx, role, hx, hy, info, rating) {
    this.team = team; this.idx = idx; this.num = idx + 1;
    this.role = role; this.isGK = role === 'GK';
    this.hx = hx; this.hy = hy;
    this.slot = null; this.plan = null; this.ax = undefined; this.ay = undefined;
    this.pace = ROLE_PACE[role] * (0.97 + Math.random() * 0.06);
    this.name = null; this.shotErr = 1; this.shotPow = 0;
    this.pass = 68; this.dribble = 64; this.defend = 60; this.physical = 70;
    if (info) {
      // [이름, 등번호, 속도, 슈팅]
      this.name = info[0]; this.num = info[1];
      if (role !== 'GK') this.pace = 0.9 + (info[2] - 60) / 100 * 0.5;
      this.shotErr = clamp(0.6 + (90 - info[3]) / 100, 0.5, 1.2);
      this.shotPow = (info[3] - 75) * 3;
      const a = AI.deriveAttrs(info, role, rating, hash01);
      this.pass = a.pass; this.dribble = a.dribble; this.defend = a.defend; this.physical = a.physical;
    }
    this.x = 0; this.y = 0; this.vx = 0; this.vy = 0; this.dvx = 0; this.dvy = 0;
    this.fx = team.dir; this.fy = 0;
    this.stamina = 1; this.sprint = false;
    this.pickupCd = 0; this.stun = 0; this.protect = 0; this.tackle = null;
    this.holdT = 0; this.aiT = 0; this.mustPass = false; this.locked = false;
    this.charge = 0; this.charging = false; this.tackleCd = 0;
    this.wob = Math.random() * 100;
    this.cards = 0; this.out = false; this.forceShot = null;
    this._icFrame = -1; this._ic = null;
  }
}

class Team {
  constructor(id, info, size, dir, skill, human, tacOpt) {
    this.id = id; this.info = info; this.dir = dir; this.skill = skill; this.human = human;
    this.size = FORMATIONS[size] ? size : 11;
    this.score = 0;
    // 전술: 사람이 고른 값이 있으면 그것, 없으면 팀 능력치에 맞춰 AI가 정함
    const sug = suggestTactics(info, this.size);
    this.tactics = AI.makeTactics(this.size, (tacOpt && tacOpt.formation) || sug.formation, (tacOpt && tacOpt.style) || sug.style);
    if (!human) this.tactics.press = clamp(this.tactics.press * (0.4 + 0.5 * skill.press), 0.1, 1);
    const slots = FORMATIONS[this.size][this.tactics.formation];
    const roster = info.players;
    // 사람이 라인업을 편집했으면 그 선발 순서(명단 번호 11개)를 씀
    const pick = tacOpt && tacOpt.order && tacOpt.order.length === slots.length && tacOpt.order.every(i => roster && roster[i]) ? tacOpt.order : autoOrder(roster, slots, ROSTER_PICK[this.size], info.tags);
    this.players = slots.map((sl, i) => {
      const pi = POS[sl[0]] || POS.CM;
      const pl = new Player(this, i, pi.role, sl[1], sl[2], roster ? roster[pick[i]] : null, info.rating);
      pl.ri = pick[i];           // 명단에서의 순서 (선수 외모 조회용)
      return pl;
    });
    this.customOrder = !!(tacOpt && tacOpt.order && pick === tacOpt.order);     // 사람이 직접 짠 순서면 자리를 다시 배정하지 않음
    AI.applySlots(this, this.size, this.tactics.formation);
    AI.initTeamAI(this);
    this.gk = this.players[0];
    this.controlled = null;
    this.input = blankInput(); this.prev = blankInput();
    this.press = {}; this.release = {};
    this.autoSwitch = false;
    this.stats = { shots: 0, onTarget: 0, possT: 0, passes: 0, fouls: 0, yellow: 0, red: 0, offsides: 0 };
    this.opp = null;
  }
  get attackX() { return this.dir > 0 ? W : 0; }
  get ownX() { return this.dir > 0 ? 0 : W; }
  toWorldX(nx) { return this.dir > 0 ? nx * W : (1 - nx) * W; }
  prog(x) { return this.dir > 0 ? x / W : 1 - x / W; }
  inOwnBox(x, y) {
    const d = this.dir > 0 ? x : W - x;
    return d > -GOAL_DEPTH && d < BOX_DEPTH && Math.abs(y - H / 2) < BOX_HALF;
  }
}

export class Game {
  constructor(opts) {
    this.teamSize = opts.teamSize || 7;
    this.realistic = !!opts.realistic;       // 실감 모드: 파울/카드/프리킥/페널티/오프사이드/체력
    this.noOffsideNext = true;
    this.matchSeconds = opts.matchSeconds || 240;
    const humans = opts.humans || [false, false];
    const diff = DIFFICULTY[opts.difficulty] ? opts.difficulty : 'normal';
    this.teams = [0, 1].map(i => {
      // 난이도는 사람과 상대하는 AI 팀에만 적용
      const key = !humans[i] && humans[1 - i] ? diff : 'normal';
      return new Team(i, opts.teams[i], this.teamSize, i === 0 ? 1 : -1, DIFFICULTY[key], !!humans[i], opts.tactics && opts.tactics[i]);
    });
    this.teams[0].opp = this.teams[1];
    this.teams[1].opp = this.teams[0];
    this.players = this.teams[0].players.concat(this.teams[1].players);
    this.ball = { x: W / 2, y: H / 2, z: 0, vx: 0, vy: 0, vz: 0, owner: null,
                  lastTouch: null, lastKicker: null, passTarget: null, passT: 0, shot: null };
    this.events = [];
    this.goals = [];
    this.message = null;
    this.clock = 0; this.half = 1; this.time = 0; this.frame = 0;
    this.state = 'kickoff'; this.stateT = 0; this.restart = null;
    this.air = null; this.airCd = 0;
    this.setupKickoff(0);
  }

  emit(type, data) { this.events.push(Object.assign({ type }, data)); }
  say(text, t, big) { this.message = { text, t: t || 1.6, max: t || 1.6, big: !!big }; }

  setInput(teamId, input) { this.teams[teamId].input = input; }

  // 표시용 경기 시간 (90분 기준)
  get displayTime() {
    const s = Math.min(5400, Math.floor(this.clock / this.matchSeconds * 5400));
    return { m: Math.floor(s / 60), s: s % 60 };
  }

  // ================= 메인 업데이트 =================
  update(dt) {
    this.dt = dt;
    this.time += dt; this.frame++;
    if (this.message) { this.message.t -= dt; if (this.message.t <= 0) this.message = null; }
    for (const t of this.teams) {
      const i = t.input, p = t.prev;
      t.press = { pass: i.pass && !p.pass, shoot: i.shoot && !p.shoot, through: i.through && !p.through, lob: i.lob && !p.lob, switch: i.switch && !p.switch, skill: i.skill && !p.skill };
      t.release = { shoot: !i.shoot && p.shoot };
      t.prev = Object.assign({}, i);
    }

    switch (this.state) {
      case 'kickoff':
        this.stateT -= dt;
        if (this.stateT <= 0) this.startPlay();
        break;
      case 'play':
        this.clock += dt;
        if (this.ball.owner) this.ball.owner.team.stats.possT += dt;
        if (this.half === 1 && this.clock >= this.matchSeconds / 2) { this.toHalftime(); break; }
        if (this.half === 2 && this.clock >= this.matchSeconds) { this.toFulltime(); break; }
        this.playStep(dt);
        break;
      case 'out':
        this.stateT -= dt;
        this.scriptedStep(dt);
        if (this.stateT <= 0) this.takeRestart();
        break;
      case 'goal':
        this.stateT -= dt;
        this.scriptedStep(dt);
        this.updateBall(dt);
        if (this.stateT <= 0) this.setupKickoff(this.restart.team.id);
        break;
      case 'halftime':
        this.stateT -= dt;
        if (this.stateT <= 0) { this.half = 2; this.setupKickoff(1); }
        break;
      case 'fulltime':
        break;
    }
  }

  // 킥오프/골킥 규칙: 공이 차이기 전에는 상대가 센터서클 / 상대 페널티 박스 안에 들어올 수 없음
  enforceRestartRules(dt) {
    const h = this.restartHold, b = this.ball;
    if (!h) return;
    h.t += dt;
    const done = h.t > 6 || (h.kind === 'kickoff' ? b.owner !== h.taker : ((b.owner && b.owner.team !== h.team) || !h.team.inOwnBox(b.x, b.y)));
    if (done) { this.restartHold = null; return; }
    if (h.kind === 'kickoff') {
      const k = h.taker;
      if (b.owner === k) { k.x = h.x; k.y = h.y; k.vx = k.vy = k.dvx = k.dvy = 0; }     // 차기 전에는 움직이지 않음
      for (const p of h.team.opp.players) {
        const d = dist(p.x, p.y, W / 2, H / 2), need = CIRCLE_R + PR + 4;
        if (d < need) { const q = need / (d || 1); p.x = W / 2 + (p.x - W / 2) * q; p.y = H / 2 + (p.y - H / 2) * q; p.vx *= 0.3; p.vy *= 0.3; }
      }
    } else {
      const t = h.team, edge = t.ownX + t.dir * (BOX_DEPTH + PR + 6);
      for (const p of t.opp.players) {
        if (p.isGK || p.out) continue;
        if (t.inOwnBox(p.x, p.y)) { p.x = edge; p.vx = 0; }
      }
    }
  }

  playStep(dt) {
    this.enforceRestartRules(dt);
    for (const t of this.teams) this.updateControl(t, dt);
    for (const t of this.teams) {
      this.thinkTeam(t, dt);
      if (t.human) this.thinkHuman(t, dt);
    }
    for (const p of this.players) {
      const w = p.kickWind;
      if (!w) continue;
      w.t -= dt;
      if (w.t > 0) continue;
      p.kickWind = null;
      if (this.ball.owner === p) this.doKick(p, w.vx, w.vy, w.vz, w.opts);
    }
    this.integrate(dt);
    this.enforceRestartRules(0);
    this.updateBall(dt);
    this.contacts(dt);
    this.updateAir(dt);
    this.checkOut();
  }

  // ================= 공중볼 다툼 (헤딩) =================
  // 높이 46~86 (머리 높이)로 날아오는 공은 닿을 수 있는 선수들이 점프해서 다툼. 이긴 선수가 슛/연결/걷어내기를 함
  planAir() {
    const b = this.ball;
    for (let t = 0.08; t <= 0.9; t += 0.04) {
      const z = b.z + b.vz * t - 0.5 * GRAVITY * t * t;
      if (z <= 8) break;
      if (z < 46 || z > 86) continue;
      const f = (1 - Math.exp(-AIR_DRAG * t)) / AIR_DRAG;
      const bx = b.x + b.vx * f, by = b.y + b.vy * f;
      if (bx < -10 || bx > W + 10 || by < -10 || by > H + 10) break;
      const who = [];
      for (const p of this.players) {
        if (p.isGK || p.out || p.stun > 0 || p.tackle || p.kickWind || p.pickupCd > 0) continue;
        const d = dist(p.x, p.y, bx, by);
        if (d <= 22 + this.maxSpeed(p, true) * t * 0.8) who.push(p);
      }
      if (who.length) {
        this.air = { t, x: bx, y: by, who };
        for (const p of who) {
          p.header = { x: bx, y: by };
          this.emit('headerStart', { player: p, delay: t });
        }
        return;
      }
    }
  }

  updateAir(dt) {
    const b = this.ball;
    this.airCd = Math.max(0, this.airCd - dt);
    const a = this.air;
    if (!a) {
      if (this.airCd > 0 || b.owner || (b.z < 18 && b.vz < 60)) return;
      this.planAir();
      return;
    }
    a.t -= dt;
    if (b.owner) { this.cancelAir(); return; }
    if (a.t > 0) return;
    this.cancelAir();
    this.airCd = 0.6;
    if (b.z < 38 || b.z > 94 || dist(b.x, b.y, a.x, a.y) > 40) return;
    let win = null, ws = -1e9;
    for (const p of a.who) {
      if (p.out || p.stun > 0 || p.tackle) continue;
      const d = dist(p.x, p.y, b.x, b.y);
      if (d > 36) continue;
      const s = p.physical * 0.55 + p.pace * 10 + Math.random() * 28 - d * 0.35 + (p === b.passTarget ? 8 : 0);
      if (s > ws) { ws = s; win = p; }
    }
    if (win) this.doHeader(win);
  }

  cancelAir() {
    if (this.air) for (const p of this.air.who) p.header = null;
    this.air = null;
  }

  doHeader(p) {
    const b = this.ball, t = p.team;
    this.touchBy(p);
    const dGoal = dist(p.x, p.y, t.attackX, H / 2);
    let vx, vy, vz, shot = false, target = null;
    if (dGoal < 400 && Math.abs(p.y - H / 2) < 330) {
      // 헤딩 슛: 키퍼 반대쪽 구석
      const gk = t.opp.gk, side = gk.y > H / 2 ? -1 : 1;
      const aimY = H / 2 + (Math.random() < 0.7 ? side : -side) * GOAL_HALF * (0.35 + 0.5 * Math.random());
      let dx = t.attackX - p.x, dy = aimY - p.y;
      const d = Math.hypot(dx, dy) || 1;
      [dx, dy] = rotate(dx / d, dy / d, randn() * (0.03 + 0.05 * p.shotErr));
      const spd = 380 + Math.random() * 190 + p.shotPow * 0.6;
      vx = dx * spd; vy = dy * spd; vz = 6 + Math.random() * 40; shot = true;
      t.stats.shots++;
    } else {
      const best = AI.bestPass(this, p, false);
      if (best && best.score > -0.02 && best.d < 620 && best.d > 80) {
        const d = best.d;
        const spd = Math.min(700, d * 1.0 + 130);
        const [ux, uy] = [(best.tx - p.x) / d, (best.ty - p.y) / d];
        vx = ux * spd; vy = uy * spd; vz = 60 + d * 0.12; target = best.mate;
        t.stats.passes++;
      } else {
        // 걷어냄: 우리 골문 반대쪽 + 바깥쪽 옆으로
        const side = p.y < H / 2 ? -1 : 1;
        const dx = t.dir, dy = side * 0.65, l = Math.hypot(dx, dy);
        const spd = 360 + Math.random() * 160;
        vx = dx / l * spd; vy = dy / l * spd; vz = 110 + Math.random() * 70;
      }
    }
    b.owner = null;
    b.vx = vx; b.vy = vy; b.vz = vz;
    b.lastTouch = t.id; b.lastKicker = p; b.kickKind = 'head';
    b.shot = shot ? { team: t.id, t: 0 } : null;
    b.passTarget = target; b.passT = 2; b.spin = null; b.pen = false;
    p.pickupCd = 0.3;
    this.emit('kick', { power: Math.hypot(vx, vy), shot, name: p.name, team: t.id, lofted: false, header: true });
    if (t.human && target && !target.isGK) t.controlled = target;
    if (t.opp.human) t.opp.autoSwitch = true;
    if (t.human) t.autoSwitch = !target;
  }

  // ================= 개인기: 헛다리 (페인트) =================
  doFeint(p) {
    if (p.feintCd > 0 || p.tackle || p.kickWind || p.stun > 0) return false;
    p.feintCd = 1.0; p.boostT = 0.45;
    const sp = Math.hypot(p.vx, p.vy);
    const fx = sp > 20 ? p.vx / sp : p.fx, fy = sp > 20 ? p.vy / sp : p.fy;
    p.feintSide = -(p.feintSide || 1);
    p.vx += -fy * p.feintSide * 95 + fx * 30; p.vy += fx * p.feintSide * 95 + fy * 30;
    for (const o of p.team.opp.players) {
      if (o.out || o.isGK || o.tackle || o.stun > 0) continue;
      if (dist(o.x, o.y, p.x, p.y) < 85 && Math.random() < clamp(0.42 + (p.dribble - o.defend) / 140, 0.12, 0.85)) {
        o.stun = 0.4; o.vx *= 0.3; o.vy *= 0.3;     // 속아서 잠깐 멈칫
      }
    }
    this.emit('feint', { player: p });
    return true;
  }

  // 재시작/골 세리머니 중: 모든 선수가 AI로 자리 잡기
  scriptedStep(dt) {
    const r = this.restart;
    for (const t of this.teams) {
      for (const p of t.players) { p.tackle = null; p.charging = false; }
      AI.thinkRest(this, t, r, dt);
    }
    this.integrate(dt);
  }

  // ================= 경기 흐름 =================
  setupKickoff(teamId) {
    const kt = this.teams[teamId];
    this.state = 'kickoff'; this.stateT = 1.4; this.restart = null; this.aim = null; this.spWait = null; this.setPieceKind = null;
    this.cancelAir(); this.airCd = 0.5; this.restartHold = null;
    this.touchGuard = null;
    const b = this.ball;
    Object.assign(b, { noDirect: null, x: W / 2, y: H / 2, z: 0, vx: 0, vy: 0, vz: 0, owner: null,
                       passTarget: null, shot: null, lastTouch: teamId });
    for (const t of this.teams) {
      for (const p of t.players) {
        const nx = p.isGK ? 0.03 : Math.min(p.hx * 0.82, 0.44);
        p.x = t.toWorldX(nx); p.y = p.hy * H;
        if (t !== kt) {
          const d = dist(p.x, p.y, W / 2, H / 2);
          const need = CIRCLE_R + PR + 6;
          if (d < need) {
            const k = need / (d || 1);
            p.x = W / 2 + (p.x - W / 2) * k; p.y = H / 2 + (p.y - H / 2) * k;
          }
        }
        p.vx = p.vy = p.dvx = p.dvy = 0;
        p.fx = t.dir; p.fy = 0;
        p.tackle = null; p.kickWind = null; p.stun = 0; p.charging = false; p.charge = 0;
        p.mustPass = false; p.locked = false; p.holdT = 0;
      }
    }
    const kicker = kt.players.find(p => p.role === 'FW') || kt.players[kt.players.length - 1];
    kicker.x = W / 2 - kt.dir * (PR + BR + 1); kicker.y = H / 2;
    this.kickoffTaker = kicker;
    for (const t of this.teams) if (t.human) t.controlled = t === kt ? kicker : this.closestOutfield(t, W / 2, H / 2);
    this.say(this.half === 1 && this.clock === 0 ? '킥오프!' : '킥오프', 1.3);
  }

  startPlay() {
    this.state = 'play';
    const k = this.kickoffTaker;
    this.gain(k);
    k.protect = 0.6;
    k.mustPass = true; k.holdT = 1.2;                  // 곧바로 동료에게 연결
    this.ball.noDirect = null; this.touchGuard = this.realistic ? { p: k, armed: false } : null;
    this.restartHold = { kind: 'kickoff', team: k.team, taker: k, t: 0, x: k.x, y: k.y };
    this.emit('whistle', { n: 1 });
  }

  toHalftime() {
    this.state = 'halftime'; this.stateT = 3.2;
    this.ball.owner = null;
    this.say('하프타임', 3.2, true);
    this.emit('whistle', { n: 2 });
  }

  toFulltime() {
    this.state = 'fulltime';
    this.ball.owner = null;
    this.say('경기 종료', 99, true);
    this.emit('whistle', { n: 3 });
    this.emit('fulltime', {});
  }

  startRestart(kind, team, x, y, extra) {
    const b = this.ball;
    b.noDirect = null; this.touchGuard = null;
    this.state = 'out'; this.stateT = 1.3;
    Object.assign(b, { owner: null, vx: 0, vy: 0, vz: 0, z: 0, x, y, passTarget: null, shot: null });
    let taker = kind === 'goalkick' ? team.gk : this.closestOutfield(team, x, y);
    // 프리킥/페널티는 AI 팀이면 슈팅이 좋은 선수가 참
    if ((kind === 'penalty' || kind === 'freekick') && !team.human) {
      const c = team.players.filter(q => !q.isGK).sort((a, c2) => c2.shotPow - a.shotPow)[0];
      if (c && (kind === 'penalty' || dist(x, y, team.attackX, H / 2) < 520)) taker = c;
    }
    // 공 뒤쪽(경기장 바깥쪽)에 서서 경기장 안을 바라봄
    let fx, fy;
    if (kind === 'throw') { fx = 0; fy = y < H / 2 ? 1 : -1; }
    else if (kind === 'freekick' || kind === 'penalty') { fx = team.attackX - x; fy = H / 2 - y; }
    else if (kind === 'corner') { fx = W / 2 - x; fy = H / 2 - y; }
    else { fx = team.dir; fy = 0; }
    const fl = Math.hypot(fx, fy) || 1; fx /= fl; fy /= fl;
    this.restart = { kind, team, x, y, taker, fx, fy, indirect: !!(extra && extra.indirect),
                     px: x - fx * (PR + BR + 1), py: y - fy * (PR + BR + 1) };
    const names = { throw: '스로인', corner: '코너킥', goalkick: '골킥', freekick: this.restart.indirect ? '간접 프리킥' : '프리킥', penalty: '페널티킥' };
    if (kind === 'penalty') this.stateT = 2.4;
    else if (kind === 'freekick') this.stateT = 1.9;
    if (!this.message || this.message.t < 0.6) this.say(names[kind], 1.3);
    this.emit('whistle', { n: 1, short: true });
  }

  takeRestart() {
    const r = this.restart, p = r.taker;
    for (const q of this.players) q.kickWind = null;
    p.x = r.px; p.y = r.py; p.vx = p.vy = 0; p.fx = r.fx; p.fy = r.fy;
    this.ball.x = r.x; this.ball.y = r.y;
    this.gain(p);
    p.protect = 1.2;
    p.mustPass = (r.kind !== 'goalkick' && r.kind !== 'penalty' && r.kind !== 'freekick') || !!r.indirect;
    p.locked = r.kind === 'throw';
    p.aiT = 0.5;
    this.ball.off = null;
    this.setPieceKind = r.kind;
    if (r.kind === 'goalkick') this.restartHold = { kind: 'goalkick', team: r.team, taker: p, t: 0 };
    else if (r.kind !== 'kickoff') this.restartHold = null;
    this.noOffsideNext = r.kind === 'goalkick' || r.kind === 'throw' || r.kind === 'corner';
    this.aim = null;
    // 규칙(실감 모드): 스로인/간접 프리킥은 직접 골 불가, 차는 선수는 두 번 연속 터치 불가
    const b0 = this.ball;
    b0.noDirect = this.realistic && (r.kind === 'throw' || (r.kind === 'freekick' && r.indirect)) ? { team: r.team.id, taker: p } : null;
    this.touchGuard = this.realistic && r.kind !== 'penalty' ? { p, armed: false } : null;
    if (this.realistic && r.indirect) this.say('간접 프리킥 — 다른 선수가 먼저 건드려야 골', 2.4);
    if (r.kind === 'penalty' || (r.kind === 'freekick' && !r.indirect)) {
      this.setPiece(r, p);
      // 사람이 차는 프리킥/페널티: 방향키로 조준하고 D를 눌러 세기를 정함
      if (r.team.human && (r.kind === 'penalty' || dist(r.x, r.y, r.team.attackX, H / 2) < 640)) {
        this.aim = { taker: p, y: H / 2, t: 0, kind: r.kind };
        p.forceShot = null;
        this.say('↑ ↓ 조준  ·  D 길게 눌러 세기  ·  떼면 슛', 3.2);
      }
    }
    // 상대 선수는 공에서 떨어뜨림
    for (const o of r.team.opp.players) {
      const d = dist(o.x, o.y, r.x, r.y);
      if (d < 90) {
        const k = 90 / (d || 1);
        o.x = r.x + (o.x - r.x) * k; o.y = r.y + (o.y - r.y) * k;
      }
    }
    if (r.team.human) r.team.controlled = p;
    this.state = 'play';
    this.enforceRestartRules(0);
  }

  // 프리킥 벽 / 페널티 때 선수 배치
  setPiece(r, p) {
    this.spWait = r.kind;
    const t = r.team, opp = t.opp, gx = t.attackX, gy = H / 2;
    const dGoal = dist(r.x, r.y, gx, gy);
    if (r.kind === 'penalty') {
      for (const q of this.players) {
        if (q === p || q.isGK) continue;
        const inBox = Math.abs(q.x - gx) < BOX_DEPTH + 25 && Math.abs(q.y - gy) < BOX_HALF + 25;
        if (inBox || dist(q.x, q.y, r.x, r.y) < 120) {
          q.x = gx - t.dir * (BOX_DEPTH + 50 + Math.random() * 40); q.y = clamp(gy + (Math.random() - 0.5) * 420, 40, H - 40);
        }
        q.stun = 0.9; q.vx = q.vy = q.dvx = q.dvy = 0;
      }
      opp.gk.x = gx - t.dir * 6; opp.gk.y = gy; opp.gk.vx = opp.gk.vy = 0;
      opp.gk.penGuess = undefined;
      this.penKick = true;
      p.forceShot = 'penalty';
    } else if (dGoal < 560) {
      // 수비 벽: 가까운 수비수 3명이 공과 골문 사이에 섬
      const dx = (gx - r.x) / dGoal, dy = (gy - r.y) / dGoal;
      const wall = opp.players.filter(q => !q.isGK).sort((a, c) => dist(a.x, a.y, r.x, r.y) - dist(c.x, c.y, r.x, r.y)).slice(0, dGoal < 380 ? 4 : 3);
      wall.forEach((q, i) => {
        const off = (i - (wall.length - 1) / 2) * 24;
        q.x = clamp(r.x + dx * 94 - dy * off, 10, W - 10); q.y = clamp(r.y + dy * 94 + dx * off, 10, H - 10);
        q.vx = q.vy = q.dvx = q.dvy = 0; q.stun = 1.4; q.fx = -dx; q.fy = -dy;
      });
      if (!t.human) p.forceShot = 'freekick';
    }
    if (p.forceShot) { p.aiT = 0.9; p.mustPass = false; }
  }

  // ===== 심판: 파울/카드/오프사이드 =====
  offsideLine(t) {
    const ps = t.opp.players.map(o => t.prog(o.x)).sort((a, c) => c - a);
    return ps.length > 1 ? ps[1] : (ps[0] || 1);
  }
  isOffside(m, t, ballX) {
    return t.prog(m.x) > Math.max(this.offsideLine(t), t.prog(ballX), 0.5) + 0.004;
  }

  offside(p) {
    const t = p.team;
    t.stats.offsides++;
    this.say('오프사이드', 1.6);
    this.emit('offside', { name: p.name, team: t.id });
    this.startRestart('freekick', t.opp, clamp(p.x, 30, W - 30), clamp(p.y, 30, H - 30), { indirect: true });
  }

  // 두 번 터치 반칙: 스로인/프리킥/코너킥/골킥/킥오프를 찬 선수가 다른 선수가 건드리기 전에 다시 공을 건드림 → 상대 간접 프리킥
  doubleTouch(p) {
    this.say('두 번 터치 반칙', 1.6);
    p.team.stats.fouls++;
    this.startRestart('freekick', p.team.opp, clamp(p.x, 30, W - 30), clamp(p.y, 30, H - 30), { indirect: true });
  }

  // 공을 다른 선수가 건드림: 간접 프리킥/스로인 직접 골 제한과 두 번 터치 감시가 풀림
  touchBy(p) {
    const b = this.ball;
    if (b.noDirect && b.noDirect.taker !== p) b.noDirect = null;
    if (this.touchGuard && this.touchGuard.p !== p) this.touchGuard = null;
  }

  // 태클 당한 선수가 넘어짐 (full) 또는 휘청임 (stumble). 그동안 움직일 수 없음
  trip(v, dx, dy, full) {
    if (v.isGK && !full) return;
    const dur = full ? 1.3 : 0.5;
    v.stun = Math.max(v.stun, dur);
    v.vx = dx * (full ? 130 : 60); v.vy = dy * (full ? 130 : 60);
    this.emit('fall', { player: v, full, dur });
  }

  foul(f, v, rough) {
    const ft = f.team, t = v.team;
    ft.stats.fouls++;
    f.tackle = null; f.stun = Math.max(f.stun, 0.3);
    v.stun = Math.max(v.stun, 0.5);
    { const l = Math.hypot(v.x - f.x, v.y - f.y) || 1; this.trip(v, (v.x - f.x) / l, (v.y - f.y) / l, true); }
    let card = null;
    const r = Math.random();
    if (!f.isGK && r < (rough ? 0.018 : 0.002)) card = 'red';
    else if (r < (rough ? 0.26 : 0.05)) card = 'yellow';
    if (card === 'yellow') {
      f.cards++; ft.stats.yellow++;
      if (f.cards >= 2 && !f.isGK) card = 'red';
    }
    if (card === 'red') ft.stats.red++;
    const who = f.name || ('#' + f.num);
    this.emit('foul', { team: ft.id, name: who });
    if (card) {
      this.emit('card', { team: ft.id, name: who, card });
      this.say((card === 'yellow' ? '옐로카드 ' : '레드카드 ') + who, 2.2);
      if (card === 'red') this.sendOff(f);
    } else {
      this.say('파울', 1.4);
    }
    if (ft.inOwnBox(v.x, v.y)) {
      this.startRestart('penalty', t, t.attackX - t.dir * PEN_SPOT, H / 2);
    } else {
      this.startRestart('freekick', t, clamp(v.x, 30, W - 30), clamp(v.y, 30, H - 30));
    }
  }

  sendOff(p) {
    const t = p.team;
    p.out = true;
    t.players = t.players.filter(q => q !== p);
    if (t.controlled === p) t.controlled = null;
    p.x = -500; p.y = -500; p.vx = p.vy = p.dvx = p.dvy = 0;
  }

  scoreGoal(team) {
    team.score++;
    const b = this.ball;
    const t = this.displayTime;
    const own = b.lastTouch !== team.id;
    this.goals.push({ team: team.id, minute: t.m + 1, scorer: own ? null : (b.lastKicker ? b.lastKicker.num : null),
                      name: own ? (b.lastKicker && b.lastKicker.name) : (b.lastKicker && b.lastKicker.name), own });
    if (b.shot && b.shot.team === team.id) team.stats.onTarget++;
    this.state = 'goal'; this.stateT = 3;
    b.owner = null; b.shot = null; b.passTarget = null;
    this.restart = { team: team.opp };
    this.say('GOAL!', 2.8, true);
    this.emit('goal', { team: team.id });
  }

  // ================= 컨트롤 선수 관리 =================
  closestOutfield(team, x, y, exclude) {
    let best = null, bd = 1e9;
    for (const p of team.players) {
      if (p.isGK || p === exclude) continue;
      const d = dist(p.x, p.y, x, y);
      if (d < bd) { bd = d; best = p; }
    }
    return best;
  }

  bestInterceptor(team, exclude) {
    let best = null, bt = 1e9;
    for (const p of team.players) {
      if (p.isGK || p === exclude) continue;
      const t = this.intercept(p).t;
      if (t < bt) { bt = t; best = p; }
    }
    return best;
  }

  updateControl(team, dt) {
    if (!team.human) return;
    const b = this.ball;
    const own = b.owner && b.owner.team === team;
    if (own && team.controlled !== b.owner) {
      team.controlled = b.owner;
    }
    // 골키퍼는 공을 잡고 있을 때만 직접 조작 (공을 내보내면 다시 필드 선수로)
    if (!team.controlled || (team.controlled.isGK && b.owner !== team.controlled)) team.controlled = this.closestOutfield(team, b.x, b.y);
    if (!own && team.press.switch) {
      team.controlled = this.bestInterceptor(team, team.controlled) || team.controlled;
      this.emit('switch', { team: team.id });
    }
    if (team.autoSwitch) {
      team.autoSwitch = false;
      const c = team.controlled;
      const best = this.bestInterceptor(team);
      if (best && best !== c && this.intercept(best).t < this.intercept(c).t - 0.2) team.controlled = best;
    }
    // 수비 시 자동 선수 전환: 공에 훨씬 가까운 동료가 있으면 넘겨줌
    team.autoT = (team.autoT || 0) - dt;
    if (!own && team.autoT <= 0) {
      team.autoT = 0.25;
      const c = team.controlled;
      const best = this.bestInterceptor(team);
      const moving = Math.hypot(team.input.mx, team.input.my) > 0.15;
      if (best && best !== c && c.stun <= 0 && !c.tackle &&
          this.intercept(best).t < this.intercept(c).t - (moving ? 0.6 : 0.35)) {
        team.controlled = best;
      }
    }
  }

  // ================= 이동 유틸 =================
  maxSpeed(p, sprint) {
    let s = BASE_SPEED * p.pace * p.team.skill.speed;
    if (this.ball.owner === p) s *= 0.9;
    if (p.boostT > 0) s *= 1.15;
    if (sprint && p.stamina > 0.05) s *= SPRINT_MUL;
    if (this.realistic) s *= 0.82 + 0.18 * clamp(p.stamina * 1.8, 0, 1);
    return s;
  }

  moveToward(p, tx, ty, sprint, arrive) {
    const dx = tx - p.x, dy = ty - p.y, d = Math.hypot(dx, dy);
    p.sprint = !!sprint && d > 40;
    if (d < 2) { p.dvx = p.dvy = 0; return; }
    const ms = this.maxSpeed(p, p.sprint);
    const s = arrive === false ? ms : Math.min(ms, d * 3.5);
    p.dvx = dx / d * s; p.dvy = dy / d * s;
  }

  // 선수가 공을 잡을 수 있는 가장 빠른 시점/위치
  intercept(p) {
    if (p._icFrame === this.frame) return p._ic;
    const b = this.ball, s = this.maxSpeed(p, true);
    let res;
    if (b.owner) {
      res = { t: dist(p.x, p.y, b.x, b.y) / s, x: b.x, y: b.y };
    } else {
      for (let t = 0; t <= 2.5; t += 0.1) {
        const f = (1 - Math.exp(-DRAG * t)) / DRAG;
        const bx = b.x + b.vx * f, by = b.y + b.vy * f;
        if (dist(p.x, p.y, bx, by) / s <= t + 0.05) { res = { t, x: bx, y: by }; break; }
      }
      if (!res) {
        const f = (1 - Math.exp(-DRAG * 2.5)) / DRAG;
        const bx = b.x + b.vx * f, by = b.y + b.vy * f;
        res = { t: 2.5 + dist(p.x, p.y, bx, by) / s, x: bx, y: by };
      }
    }
    p._icFrame = this.frame; p._ic = res;
    return res;
  }

  // ================= 팀 AI (ai.js) =================
  thinkTeam(team, dt) { AI.thinkTeam(this, team, dt); }
  bestPass(p, fromGK) { return AI.bestPass(this, p, fromGK); }

  // 전술 변경 (경기 중에도 가능): { formation, style, press, line, width, tempo, direct, mentality }
  setTactics(teamId, o) {
    const t = this.teams[teamId];
    if (o.formation && o.formation !== t.tactics.formation && FORMATIONS[t.size][o.formation]) {
      t.tactics.formation = o.formation;
      AI.applySlots(t, t.size, o.formation);
      for (const p of t.players) p.tx = undefined;
    }
    if (o.style && STYLES[o.style]) {
      const keep = t.tactics.formation;
      Object.assign(t.tactics, STYLES[o.style], { style: o.style, formation: keep });
      if (!t.human) t.tactics.press = clamp(t.tactics.press * (0.4 + 0.5 * t.skill.press), 0.1, 1);
    }
    for (const k of ['press', 'line', 'width', 'tempo', 'direct', 'mentality']) if (typeof o[k] === 'number') t.tactics[k] = o[k];
    this.emit('tactics', { team: teamId, tactics: Object.assign({}, t.tactics) });
  }

  // ================= 골키퍼 AI =================
  thinkGK(p, dt) {
    const t = p.team, b = this.ball;
    if (b.owner === p) {
      p.holdT += dt; p.dvx = p.dvy = 0;
      if (p.holdT > (p.feet ? 0.25 : 1.0)) this.gkDistribute(p);
      return;
    }
    // 세트피스 직전에는 키퍼가 뛰쳐나오지 않고 골문을 지킴
    if (this.spWait && b.owner && b.owner.team !== t) {
      if (this.spWait === 'penalty') { p.dvx = p.dvy = 0; p.x += (t.ownX + t.dir * 6 - p.x) * 0.2; p.y += (H / 2 - p.y) * 0.2; }
      else this.gkPosition(p);
      return;
    }
    // 페널티: 키퍼는 한쪽을 찍고 몸을 날림 (찍은 쪽으로 오면 막고, 아니면 골)
    if (b.pen && b.shot && b.shot.team !== t.id && !b.owner) {
      if (p.penGuess === undefined) {
        p.penGuess = Math.random() < 0.12 ? 0 : (Math.random() < 0.5 ? -1 : 1);
        if (p.penGuess) { this.startTackle(p, 'dive', 0, p.penGuess); p.tackle.t = 0.24; }
      }
      if (!p.tackle) { p.dvx = p.dvy = 0; }
      return;
    }
    // 슛 대응
    if (!b.owner && (t.ownX - b.x) * b.vx > 0 && Math.abs(b.vx) > 200) {
      const tt = (p.x - b.x) / b.vx;
      if (tt > 0 && tt < 1.2) {
        const f = (1 - Math.exp(-DRAG * tt)) / DRAG;
        const py = b.y + b.vy * f;
        if (Math.abs(py - H / 2) < GOAL_HALF + 40) {
          const react = b.shot ? b.shot.t > 0.14 / t.skill.gk : true;
          if (react) {
            const ty = clamp(py, H / 2 - GOAL_HALF - 12, H / 2 + GOAL_HALF + 12);
            if (Math.abs(ty - p.y) > 16 && tt < 0.38) {
              this.startTackle(p, 'dive', 0, ty - p.y);
            } else {
              this.moveToward(p, p.x, ty, true, true);
            }
          } else {
            p.dvx = p.dvy = 0;
          }
          return;
        }
      }
    }
    // 공중으로 박스에 떨어지는 크로스: 키퍼가 먼저 잡으러 나감
    if (!b.owner && b.z > 18 && !b.shot) {
      const tl = (b.vz + Math.sqrt(b.vz * b.vz + 2 * GRAVITY * b.z)) / GRAVITY;
      if (tl > 0.15 && tl < 1.6) {
        const f = (1 - Math.exp(-AIR_DRAG * tl)) / AIR_DRAG;
        const lx = b.x + b.vx * f, ly = b.y + b.vy * f;
        if (t.inOwnBox(lx, ly) && dist(lx, ly, t.ownX, H / 2) > 70) {
          const tg = dist(p.x, p.y, lx, ly) / this.maxSpeed(p, true);
          let opp = 1e9;
          for (const o of t.opp.players) if (!o.isGK) opp = Math.min(opp, dist(o.x, o.y, lx, ly) / this.maxSpeed(o, true));
          if (tg < tl - 0.1 && tg < opp * 1.15) { this.moveToward(p, lx, ly, true, false); return; }
        }
      }
    }
    // 박스 안으로 들어온 공격수에게 달려 나감
    if (b.owner && b.owner.team !== t && t.inOwnBox(b.x, b.y) && dist(p.x, p.y, b.x, b.y) < 230) {
      this.moveToward(p, b.x, b.y, true, false);
      return;
    }
    // 박스 안의 루즈볼은 키퍼가 처리
    if (!b.owner && t.inOwnBox(b.x, b.y) && b.z < 60) {
      const mine = this.intercept(p).t;
      let opp = 1e9;
      for (const o of t.opp.players) if (!o.isGK) opp = Math.min(opp, this.intercept(o).t);
      if (mine < opp * 1.1 + 0.05) {
        const ic = this.intercept(p);
        this.moveToward(p, ic.x, ic.y, true, false);
        return;
      }
    }
    this.gkPosition(p);
  }

  gkPosition(p) { AI.gkPosition(this, p); }

  gkDistribute(p) {
    const best = this.bestPass(p, true);
    if (best && best.score > -0.5) {
      const d = dist(p.x, p.y, best.mate.x, best.mate.y);
      // 가까운 동료에게는 손으로 던져 줌 (오버핸드), 먼 곳은 킥
      if (!p.feet && d < 360 && d > 90) this.passTo(p, best.mate, false, 0.7, { gkThrow: true });
      else this.passTo(p, best.mate, best.lofted || d > 330, 0.8);
    } else {
      const t = p.team;
      this.kickTo(p, t.toWorldX(0.55 + Math.random() * 0.15), H * (0.25 + Math.random() * 0.5), true, 1, {});
    }
  }

  // ================= 사람 조작 =================
  thinkHuman(team, dt) {
    const p = team.controlled, b = this.ball;
    if (!p) return;
    const inp = team.input, pr = team.press;
    p.sprint = false;
    if (p.stun > 0 || p.tackle) return;
    let mx = inp.mx, my = inp.my;
    const m = Math.hypot(mx, my);
    if (m > 1) { mx /= m; my /= m; }
    const moving = m > 0.15;

    // 프리킥/페널티 조준
    if (this.aim && this.aim.taker === p && b.owner === p) {
      const A = this.aim;
      p.dvx = p.dvy = 0;
      A.t += dt;
      // 슛 전까지 다른 선수들은 제자리 (페널티는 전원, 프리킥은 공 근처 수비수)
      for (const q of this.players) {
        if (q === p || q.isGK || q.out) continue;
        if (A.kind === 'penalty' || (q.team !== p.team && dist(q.x, q.y, b.x, b.y) < 170)) { q.stun = Math.max(q.stun, 0.3); q.vx = q.vy = 0; }
      }
      A.y = clamp(A.y + my * 230 * dt, H / 2 - GOAL_HALF * 0.9, H / 2 + GOAL_HALF * 0.9);
      if (inp.shoot) {
        if (!p.charging) p.shotKind = shotKindOf(inp);
        p.charging = true;
        p.charge = Math.min(1, p.charge + dt / 0.9);
      } else if (p.charging || A.t > 14) {
        const pw = p.charging ? 0.35 + 0.65 * p.charge : 0.8;
        this.aim = null;
        this.shoot(p, pw, A.y, 0.4, p.shotKind || 'normal');
      }
      return;
    }

    if (b.owner === p && p.locked) {
      p.dvx = p.dvy = 0;
      if (moving && !p.kickWind) {
        const cur = Math.atan2(p.fy, p.fx);
        let d = Math.atan2(my, mx) - cur;
        d = Math.atan2(Math.sin(d), Math.cos(d));
        const st = Math.sign(d) * Math.min(Math.abs(d), 7 * dt);
        p.fx = Math.cos(cur + st); p.fy = Math.sin(cur + st);
      }
    } else if (!b.owner && b.passTarget === p) {
      // 패스 자동 받기: 공이 올 때까지 방향키와 상관없이 공을 향해 움직임
      const ic = this.intercept(p);
      this.moveToward(p, ic.x, ic.y, inp.sprint || ic.t > 0.6, true);
    } else if (moving) {
      p.sprint = inp.sprint;
      const s = this.maxSpeed(p, p.sprint);
      p.dvx = mx * s; p.dvy = my * s;
    } else {
      p.dvx = p.dvy = 0;
    }

    if (p.isGK && b.owner === p) {
      p.holdT += dt;
      // 박스 밖으로는 못 나감 (핸들링 반칙 대신)
      const nx = p.x + p.dvx * 0.12, ny = p.y + p.dvy * 0.12;
      if (!p.team.inOwnBox(nx, ny)) { p.dvx = p.dvy = 0; }
      if (p.holdT > 6.5) { this.gkDistribute(p); return; }
      if (pr.pass) { this.humanPass(p, mx, my, moving); return; }
      if (pr.through) { this.humanThrough(p, mx, my, moving); return; }
      if (pr.lob) { this.humanLob(p, mx, my, moving); return; }
      if (inp.shoot) {
        p.charging = true;
        p.charge = Math.min(1, p.charge + dt / 0.8);
      } else if (p.charging) {
        // 길게 차기: 방향키로 좌우를 정하고 세기만큼 멀리
        const t = p.team;
        const reach = 0.42 + 0.46 * p.charge;
        const ty = clamp(p.y + (moving ? my : 0) * 330 + (Math.random() - 0.5) * 60, 40, H - 40);
        this.kickTo(p, t.toWorldX(reach), ty, true, 1.3 - p.charge * 0.5, {});
      }
      return;
    }

    team.hintT = (team.hintT || 0) - dt;
    if (b.owner === p && !p.locked && !p.isGK) {
      if (team.hintT <= 0) { team.hintT = 0.1; const h = this.pickHumanPass(p, mx, my, moving); team.passHint = h ? h.mate : null; }
    } else team.passHint = null;
    if (b.owner === p) {
      if (pr.skill && !p.kickWind) this.doFeint(p);
      if (pr.pass) { this.humanPass(p, mx, my, moving); return; }
      if (pr.through) { this.humanThrough(p, mx, my, moving); return; }
      if (pr.lob) { this.humanLob(p, mx, my, moving); return; }
      if (inp.shoot) {
        if (!p.charging) p.shotKind = shotKindOf(inp);
        p.charging = true;
        p.charge = Math.min(1, p.charge + dt / 0.9);
      } else if (p.charging) {
        // 에임 어시스트: 방향키를 누른 쪽 골문 모서리로 끌어당기고, 안 누르면 키퍼 반대쪽 구석을 노림
        const gk = p.team.opp.gk, away = gk.y > H / 2 ? -1 : 1;
        const want = moving && Math.abs(my) > 0.2 ? Math.sign(my) : away;
        const corner = H / 2 + want * GOAL_HALF * 0.74;
        const manual = H / 2 + clamp(moving ? my : 0, -1, 1) * GOAL_HALF * 0.66;
        const sweet = p.charge >= SWEET_LO && p.charge <= SWEET_HI;
        let aimY = manual + (corner - manual) * (moving ? 0.55 : 1);
        if (sweet) aimY = H / 2 + Math.sign(aimY - H / 2 || away) * GOAL_HALF * 0.8;      // 상단 구석(사이드 네트 위쪽)
        // 스위트 스팟: 게이지 62~90%에서 떼면 정확도와 파워가 오름
        this.shoot(p, 0.2 + p.charge * 0.8, aimY, sweet ? 0.22 : 0.5, p.shotKind || 'normal', sweet, sweet ? 54 : undefined);
      }
    } else {
      p.charging = false; p.charge = 0;
      if (inp.pass) {
        // 압박: 누르고 있으면 공을 향해 자동으로 달려가고, 붙으면 태클
        const ic = this.intercept(p);
        const d = dist(p.x, p.y, b.x, b.y);
        this.moveToward(p, ic.x, ic.y, inp.sprint || d > 90, false);
        if (b.owner && b.owner.team !== team && d < 30 && p.tackleCd <= 0) {
          this.startTackle(p, 'stand', b.x - p.x, b.y - p.y);
          p.tackleCd = 0.7;
        }
      } else if (pr.shoot) {
        this.startTackle(p, 'slide', moving ? mx : b.x - p.x, moving ? my : b.y - p.y);
      }
    }
  }

  // 로빙 패스: 방향에 있는 동료(멀수록 선호)에게 공을 띄워 보냄. 상대 골문 근처면 크로스
  humanLob(p, mx, my, moving) {
    const t = p.team;
    const dx = moving ? mx : t.dir, dy = moving ? my : 0;
    let best = null, bs = -1e9;
    for (const m of t.players) {
      if (m === p || m.isGK) continue;
      const vx = m.x - p.x, vy = m.y - p.y, d = Math.hypot(vx, vy);
      if (d < 120 || d > 750) continue;
      const cos = (vx * dx + vy * dy) / d;
      if (cos < 0.45) continue;
      let mark = 1e9;
      for (const o of t.opp.players) mark = Math.min(mark, dist(o.x, o.y, m.x, m.y));
      const s = cos + d / 900 + Math.min(mark, 120) / 240;
      if (s > bs) { bs = s; best = m; }
    }
    t.stats.passes++;
    if (best) {
      // 받는 선수가 달려가는 앞쪽으로 살짝 띄움
      this.kickTo(p, best.x + best.vx * 0.6 + t.dir * 20, best.y + best.vy * 0.6, true, 0.7, { passTarget: best });
    } else {
      const l = Math.hypot(dx, dy) || 1;
      this.kickTo(p, clamp(p.x + dx / l * 320, 20, W - 20), clamp(p.y + dy / l * 320, 20, H - 20), true, 0.7, {});
    }
  }

  // 스루패스: 동료가 달려갈 앞 공간으로 공을 보냄
  humanThrough(p, mx, my, moving) {
    const t = p.team;
    const dx = moving ? mx : t.dir, dy = moving ? my : 0;
    let best = null, bs = -1e9;
    for (const m of t.players) {
      if (m === p || m.isGK) continue;
      const vx = m.x - p.x, vy = m.y - p.y, d = Math.hypot(vx, vy);
      if (d < 50 || d > 700) continue;
      const cos = (vx * dx + vy * dy) / d;
      if (cos < 0.3) continue;
      const s = cos + (t.prog(m.x) - t.prog(p.x)) * 2 - d / 1500;
      if (s > bs) { bs = s; best = m; }
    }
    if (!best) { this.humanPass(p, mx, my, moving); return; }
    const lead = 150;
    const tx = clamp(best.x + t.dir * lead + best.vx * 0.3, 30, W - 30);
    const ty = clamp(best.y + (moving ? my * 60 : 0) + best.vy * 0.3, 30, H - 30);
    t.stats.passes++;
    this.kickTo(p, tx, ty, false, 0.6, { passTarget: best });
  }

  // 사람이 S로 줄 동료 고르기: 방향키를 누르면 그 방향의 동료 중, 안 누르면 가장 좋은 동료. AI의 패스 평가(안전/공간/전진)를 같이 씀
  pickHumanPass(p, mx, my, moving) {
    const list = AI.evalPasses(this, p).filter(e => e.kind !== 'through' && e.kind !== 'cross');
    let best = null, bs = -1e9;
    for (const e of list) {
      const vx = e.tx - p.x, vy = e.ty - p.y, d = Math.hypot(vx, vy) || 1;
      const cos = moving ? (vx * mx + vy * my) / d / (Math.hypot(mx, my) || 1) : (vx * p.fx + vy * p.fy) / d;
      if (moving && cos < 0.35) continue;
      const sc = e.score * 6 + (moving ? 1.4 * cos : 0.25 * cos) - (e.mate.isGK ? 0.25 : 0);
      if (sc > bs) { bs = sc; best = e; }
    }
    return best;
  }

  humanPass(p, mx, my, moving) {
    const best = this.pickHumanPass(p, mx, my, moving);
    if (best) {
      this.passTo(p, best.mate, best.lofted, 0.6);
    } else {
      const dx = moving ? mx : p.fx, dy = moving ? my : p.fy;
      const l = Math.hypot(dx, dy) || 1;
      this.kick(p, dx / l * 480, dy / l * 480, 0, {});
    }
  }

  // ================= 킥 =================
  kickTo(p, tx, ty, lofted, errMul, opts) {
    let dx = tx - p.x, dy = ty - p.y;
    const d = Math.hypot(dx, dy) || 1;
    let spd, vz = 0;
    if (lofted) {
      vz = clamp(200 + d * 0.3, 220, 420);
      const T = 2 * vz / GRAVITY;
      const a = (1 - Math.exp(-AIR_DRAG * T)) / AIR_DRAG;
      spd = Math.min(1000, d / (a + 0.35));
    } else {
      spd = Math.min(950, d * DRAG + 140);
    }
    // 패스는 정확하게 (오차 약 1/3), 슛은 기존 오차
    const base = opts && opts.passTarget ? 0.0125 : 0.035;
    [dx, dy] = rotate(dx / d, dy / d, randn() * base * errMul * (1 + d / (opts && opts.passTarget ? 900 : 500)));
    this.kick(p, dx * spd, dy * spd, vz, opts);
  }

  passTo(p, m, lofted, errMul, extra) {
    if (p.kickWind) return;
    // 공이 날아가는 시간 + 킥 준비 시간만큼 동료가 더 가 있을 자리로 정확히 겨냥
    let tx = m.x, ty = m.y;
    for (let k = 0; k < 3; k++) {
      const d = dist(p.x, p.y, tx, ty) || 1;
      let T;
      if (lofted) T = 2 * clamp(200 + d * 0.3, 220, 420) / GRAVITY + 0.35;
      else { const spd = Math.min(950, d * DRAG + 140); T = -Math.log(Math.max(0.05, 1 - d * DRAG / spd)) / DRAG; }
      T = clamp(T * 0.8 + 0.14, 0.2, 1.2);       // 동료도 공을 향해 조금 움직이므로 80%만 반영
      tx = clamp(m.x + m.vx * T, 20, W - 20); ty = clamp(m.y + m.vy * T, 20, H - 20);
    }
    p.team.stats.passes++;
    this.kickTo(p, tx, ty, lofted, errMul, { passTarget: m, ...extra });
  }

  // kind: normal(일반) / finesse(감아차기) / chip(칩슛) / drive(낮고 강한 슛)
  shoot(p, power, aimY, errMul, kind = 'normal', sweet = false, aimH) {
    if (p.kickWind) return;
    const t = p.team;
    if (kind === 'chip') {
      // 키퍼 머리 위로 띄워 골문 안쪽에 떨어뜨림
      t.stats.shots++;
      const gx = t.attackX + t.dir * (6 + power * 22);
      this.kickTo(p, gx, aimY, true, 1.7 * errMul * p.shotErr, { shot: true });
      return;
    }
    let dx = t.attackX - p.x, dy = aimY - p.y;
    const d = Math.hypot(dx, dy) || 1;
    let mul = 1, spd, vz, spin = null;
    if (kind === 'finesse') mul = 0.55;
    else if (kind === 'drive') mul = 1.0;
    const err = randn() * (0.013 + 0.026 * power * power + d / 14000) * errMul * p.shotErr * mul;
    [dx, dy] = rotate(dx / d, dy / d, err);
    if (kind === 'finesse') {
      // 골문 바깥쪽을 향해 차서 안쪽으로 휘어 들어오게 함
      spd = 430 + power * 560 + p.shotPow * power * 0.5;
      vz = 35 + power * 150;
      const sx = Math.sign(dx) || 1, aimSide = Math.sign(aimY - H / 2) || 1;
      const th = aimSide * sx * (0.1 + 0.04 * power);
      [dx, dy] = rotate(dx, dy, th);
      const T = (d / spd) * 1.05;
      spin = { w: -th / T, t: T };
    } else if (kind === 'drive') {
      spd = 640 + power * 900 + p.shotPow * power;
      vz = 8 + power * 40;
    } else {
      spd = 520 + power * 820 + p.shotPow * power;
      vz = 20 + power * power * 240 + Math.max(0, randn()) * power * 80;
    }
    // 목표 높이(aimH)가 있으면 골라인에서 그 높이에 오도록 탄도를 계산 (상단 구석 / 낮은 구석)
    if (aimH !== undefined && (kind === 'normal' || kind === 'drive')) {
      const L = Math.abs(t.attackX - p.x) / Math.max(0.2, Math.abs(dx));
      const arg = 1 - L * AIR_DRAG / spd;
      const T = arg > 0.05 ? -Math.log(arg) / AIR_DRAG : L / spd * 1.6;
      vz = clamp((aimH + 0.5 * GRAVITY * T * T) / T, 0, 430);
    }
    if (sweet) { spd *= 1.1; this.say('굿 타이밍!', 0.7); }
    t.stats.shots++;
    this.kick(p, dx * spd, dy * spd, vz, { shot: true, spin });
  }

  // 킥 예약: 발을 뒤로 젖히는 시간(delay) 뒤에 실제로 공이 떠남
  kick(p, vx, vy, vz, opts) {
    if (p.kickWind) return;
    const thr = p.locked && !p.isGK;                       // 스로인: 공을 머리 뒤로 넘겼다가 던짐
    const delay = thr ? 0.46 : opts.gkThrow ? 0.3 : p.isGK ? 0.14 : opts.shot ? 0.17 : 0.14;
    p.kickWind = { t: delay, vx, vy, vz, opts };
    p.protect = Math.max(p.protect, delay + 0.08);
    p.charging = false; p.charge = 0;
    const l = Math.hypot(vx, vy);
    if (l > 1) { p.fx = vx / l; p.fy = vy / l; }       // 차는 방향을 바라봄
    this.emit('kickStart', { player: p, delay, shot: !!opts.shot, power: l, throwIn: thr, gkThrow: !!opts.gkThrow });
  }

  doKick(p, vx, vy, vz, opts) {
    const b = this.ball, t = p.team;
    if (this.touchGuard) { if (this.touchGuard.p === p) this.touchGuard.armed = true; else this.touchGuard = null; }
    if (b.noDirect && b.noDirect.taker !== p) b.noDirect = null;
    const thrown = p.locked && !p.isGK;
    b.owner = null;
    b.vx = vx; b.vy = vy; b.vz = vz;
    if (thrown) { b.z = 32; b.vz = Math.max(vz, 80); }     // 스로인은 머리 위에서 던짐
    else if (opts.gkThrow) { b.z = 30; b.vz = 40; }       // 키퍼 던지기: 어깨 높이에서 낮게
    b.lastTouch = t.id; b.lastKicker = p;
    b.kickKind = p.isGK ? 'hand' : thrown ? 'throw' : 'foot';
    p.feet = false;
    b.passTarget = opts.passTarget || null; b.passT = 2;
    b.shot = opts.shot ? { team: t.id, t: 0 } : null;
    b.spin = opts.spin || null;
    p.pickupCd = 0.28; p.holdT = 0; p.mustPass = false; p.locked = false;
    p.charging = false; p.charge = 0; p.forceShot = null;
    if (this.aim && this.aim.taker === p) this.aim = null;
    b.pen = !!this.penKick; this.penKick = false; this.spWait = null; this.setPieceKind = null;
    if (p.isGK) p.protect = 0;
    if (this.realistic) {
      if (this.noOffsideNext) { b.off = null; this.noOffsideNext = false; }
      else {
        const set = new Set();
        for (const m of t.players) if (m !== p && !m.isGK && this.isOffside(m, t, p.x)) set.add(m);
        b.off = set.size ? { team: t.id, set } : null;
      }
    }
    this.emit('kick', { power: Math.hypot(vx, vy), shot: !!opts.shot, name: p.name, team: t.id, lofted: vz > 150 && !opts.shot });
    if (t.human && opts.passTarget && !opts.passTarget.isGK) t.controlled = opts.passTarget;
    if (t.opp.human) t.opp.autoSwitch = true;
  }

  startTackle(p, kind, dx, dy) {
    const l = Math.hypot(dx, dy);
    if (l < 0.001) { dx = p.fx; dy = p.fy; } else { dx /= l; dy /= l; }
    p.tackle = { kind, t: TACKLE_TIME[kind], dx, dy };
    if (kind !== 'dive') { p.fx = dx; p.fy = dy; }
    if (kind === 'slide') this.emit('slide', {});
  }

  gain(p) {
    const b = this.ball;
    const tg = this.touchGuard;
    if (tg && tg.armed && tg.p === p && this.state === 'play') { this.touchGuard = null; b.noDirect = null; this.doubleTouch(p); return; }
    this.touchBy(p);
    const off = this.realistic && !b.owner && b.off && b.off.team === p.team.id && b.off.set.has(p) && this.state === 'play';
    b.off = null;
    // 백패스 규칙: 동료가 발로 차거나 스로인으로 준 공은 키퍼가 손으로 잡을 수 없음 → 발로 처리
    const back = p.isGK && b.lastTouch === p.team.id && b.lastKicker && b.lastKicker !== p && (b.kickKind === 'foot' || b.kickKind === 'throw');
    b.kickKind = null;
    b.owner = p; b.lastTouch = p.team.id; b.lastKicker = p;
    p.feet = !!back;
    b.passTarget = null; b.shot = null; b.z = 0; b.vz = 0;
    b.touchT = 0; b.preSent = false; b.spin = null;
    const insp = Math.hypot(b.vx, b.vy);
    b.recvT = (insp > 70 && !p.isGK) ? 0.3 : 0;
    if (b.recvT > 0) {
      const ddx = b.x - p.x, ddy = b.y - p.y, dl = Math.hypot(ddx, ddy);
      if (dl > 5 && Math.hypot(p.vx, p.vy) < 60 && !p.kickWind) { p.fx = ddx / dl; p.fy = ddy / dl; }   // 느리게 서 있으면 공 쪽을 봄
    }
    p.protect = 0.3; p.holdT = 0; p.aiT = 0.15 + Math.random() * 0.2;
    p.mustPass = false; p.locked = false;
    this.emit('touch', {});
    if (off) this.offside(p);
  }

  // ================= 물리 =================
  integrate(dt) {
    const b = this.ball;
    for (const p of this.players) {
      if (p.out) continue;
      p.pickupCd = Math.max(0, p.pickupCd - dt);
      p.tackleCd = Math.max(0, p.tackleCd - dt);
      p.feintCd = Math.max(0, (p.feintCd || 0) - dt);
      p.boostT = Math.max(0, (p.boostT || 0) - dt);
      p.protect = Math.max(0, p.protect - dt);
      if (p.tackle) {
        const tk = p.tackle, sp = TACKLE_SPEED[tk.kind];
        p.vx = tk.dx * sp; p.vy = tk.dy * sp;
        tk.t -= dt;
        if (tk.t <= 0) { p.stun = TACKLE_RECOVER[tk.kind]; p.tackle = null; }
      } else if (p.kickWind) {
        const f = Math.exp(-7 * dt); p.vx *= f; p.vy *= f;
      } else if (p.stun > 0) {
        p.stun -= dt;
        const f = Math.exp(-8 * dt); p.vx *= f; p.vy *= f;
      } else {
        const a = Math.min(1, dt * (b.owner === p ? 7 : 9));
        // 몸이 가려는 반대쪽을 향하고 있으면 먼저 돌아선 뒤 가속 (뒤로 달리지 않고 방향을 틀게)
        let tx = p.dvx, ty = p.dvy;
        const dl = Math.hypot(tx, ty);
        if (dl > 20) {
          const al = (tx * p.fx + ty * p.fy) / dl;
          const k = al < 0.3 ? 0.35 + Math.max(0, al + 1) * 0.35 : 1;
          tx *= k; ty *= k;
        }
        p.vx += (tx - p.vx) * a; p.vy += (ty - p.vy) * a;
      }
      p.x = clamp(p.x + p.vx * dt, -30, W + 30);
      p.y = clamp(p.y + p.vy * dt, -30, H + 30);
      const sp = Math.hypot(p.vx, p.vy);
      const dl = Math.hypot(p.dvx, p.dvy);
      if ((sp > 45 || dl > 45) && !p.tackle && !p.locked && !p.kickWind && !(p.stun > 0)) {
        // 원하는 이동 방향(dv)으로 각도를 돌림. 벡터 보간은 정반대 방향일 때 제자리에 멈춰 버려서(문워크) 각도로 처리.
        // 느리게 움직일 때는 천천히 돌고, 작은 각도 차이는 무시해서 몸이 떨리지 않게 함
        const tx = dl > 45 ? p.dvx / dl : p.vx / sp, ty = dl > 45 ? p.dvy / dl : p.vy / sp;
        const cur = Math.atan2(p.fy, p.fx);
        let d = Math.atan2(ty, tx) - cur;
        d = Math.atan2(Math.sin(d), Math.cos(d));
        if (Math.abs(d) > 0.05) {
          const w = clamp(Math.max(dl, sp) / 140, 0.3, 1);
          const k = Math.min(1, dt * (b.owner === p ? 12 : 16) * w);
          const maxStep = (b.owner === p ? 11 : 15) * dt * w;
          const st = Math.sign(d) * Math.min(Math.abs(d), Math.max(Math.abs(d) * k, maxStep));
          p.fx = Math.cos(cur + st); p.fy = Math.sin(cur + st);
        }
      }
      if (p.sprint && sp > BASE_SPEED * 1.05) p.stamina = Math.max(0, p.stamina - dt * (this.realistic ? 0.3 : 0.2));
      else p.stamina = Math.min(1, p.stamina + dt * (this.realistic ? 0.06 : 0.09));
    }
    // 선수끼리 겹치지 않게
    const ps = this.players, n = ps.length;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const a = ps[i], c = ps[j];
        const dx = c.x - a.x, dy = c.y - a.y, d = Math.hypot(dx, dy);
        if (d < PR * 2 && d > 0.01) {
          const push = (PR * 2 - d) / 2;
          a.x -= dx / d * push; a.y -= dy / d * push;
          c.x += dx / d * push; c.y += dy / d * push;
        }
      }
    }
  }

  updateBall(dt) {
    const b = this.ball;
    if (b.owner) {
      const o = b.owner;
      b.z = 0; b.vz = 0;
      if (o.isGK && o.team.inOwnBox(o.x, o.y)) {
        b.x = o.x + o.fx * PR * 0.7; b.y = o.y + o.fy * PR * 0.7;
        b.vx = o.vx; b.vy = o.vy;
        return;
      }
      // 패스를 막 받은 순간(퍼스트 터치): 공이 오던 방향 그대로 속도를 죽이며 발 쪽으로 붙임 (뒤로 튀지 않게)
      if (b.recvT > 0) {
        b.recvT -= dt;
        const k = Math.exp(-9 * dt);
        b.vx = o.vx + (b.vx - o.vx) * k; b.vy = o.vy + (b.vy - o.vy) * k;
        b.x += b.vx * dt; b.y += b.vy * dt;
        const rx = b.x - o.x, ry = b.y - o.y, rl = Math.hypot(rx, ry);
        if (rl > 15) { b.x = o.x + rx / rl * 15; b.y = o.y + ry / rl * 15; }
        if (rl < 8 && rl > 0.1) { b.x = o.x + rx / rl * 8; b.y = o.y + ry / rl * 8; }
        return;
      }
      const spd = Math.hypot(o.vx, o.vy);
      // 거의 서 있으면 발 앞에 놓아 둠
      if (spd < 35 || o.tackle || o.kickWind) {
        if (!o.kickWind) { b.touchT = 0; b.preSent = false; }
        const tx = o.x + o.fx * 11, ty = o.y + o.fy * 11;
        const a = Math.min(1, dt * 10);
        const nx = b.x + (tx - b.x) * a, ny = b.y + (ty - b.y) * a;
        b.vx = (nx - b.x) / dt; b.vy = (ny - b.y) / dt;
        b.x = nx; b.y = ny;
        return;
      }
      // 달리는 방향
      const dx = o.vx / spd, dy = o.vy / spd, px = -dy, py = dx;
      const interval = clamp(0.5 - spd / 900, 0.3, 0.5);
      b.touchT = (b.touchT || 0) + dt;
      // 발이 공에 닿기 직전에 신호를 보내 발 동작을 미리 시작함
      if (!b.preSent && b.touchT >= interval - 0.11) {
        b.preSent = true;
        this.emit('dribble', { player: o, v: spd, delay: 0.11 });
      }
      if (b.touchT >= interval) {
        // 터치: 공을 발 앞 목표 지점으로 보내는 만큼의 속도를 줌 (선수 속도 + 앞으로 툭)
        b.touchT -= interval; b.preSent = false;
        b.side = -(b.side || 1);
        const lead = 9 + spd * 0.03;
        const tx = o.x + dx * lead + px * b.side * 3, ty = o.y + dy * lead + py * b.side * 3;
        let rx = (tx - b.x) / 0.2, ry = (ty - b.y) / 0.2;
        const rl = Math.hypot(rx, ry), cap = 26 + spd * 0.22;
        if (rl > cap) { rx *= cap / rl; ry *= cap / rl; }
        b.vx = o.vx + rx; b.vy = o.vy + ry;
      }
      // 터치 사이에는 공이 혼자 굴러감 (약한 마찰)
      // 선수 속도에 맞춰 같이 달림 (땅 기준으로 감속하면 선수가 앞서가 공이 뒤로 처짐)
      const fr = Math.exp(-1.4 * dt);
      b.vx = o.vx + (b.vx - o.vx) * fr; b.vy = o.vy + (b.vy - o.vy) * fr;
      b.x += b.vx * dt; b.y += b.vy * dt;
      // 공이 너무 멀어지거나 발 뒤로 가면 부드럽게 끌어옴 (앞뒤 6~19, 옆 ±7)
      let rx = b.x - o.x, ry = b.y - o.y;
      const fwd = rx * dx + ry * dy, lat = rx * px + ry * py;
      const cf = clamp(fwd, 7, 19), cl = clamp(lat, -7, 7);
      const corr = Math.min(1, dt * (fwd < 2 ? 14 : 10));      // 공이 몸 뒤쪽이면 천천히(몸을 관통해 튀지 않게)
      const ex = (cf - fwd) * dx + (cl - lat) * px, ey = (cf - fwd) * dy + (cl - lat) * py;
      b.x += ex * corr; b.y += ey * corr;
      return;
    }
    if (b.spin) {
      const a = b.spin.w * dt, c = Math.cos(a), s2 = Math.sin(a);
      const vx = b.vx * c - b.vy * s2; b.vy = b.vx * s2 + b.vy * c; b.vx = vx;
      b.spin.t -= dt;
      if (b.spin.t <= 0 || b.z <= 0 && b.vz === 0) b.spin = null;
    }
    b.x += b.vx * dt; b.y += b.vy * dt;
    const k = b.z > 1 ? AIR_DRAG : DRAG;
    const f = Math.exp(-k * dt);
    b.vx *= f; b.vy *= f;
    if (b.z > 0 || b.vz > 0) {
      b.vz -= GRAVITY * dt;
      b.z += b.vz * dt;
      if (b.z <= 0) {
        b.z = 0;
        if (b.vz < -60) {
          b.vz = -b.vz * 0.45;
          b.vx *= 0.6; b.vy *= 0.6;
          this.emit('bounce', { v: b.vz });
        } else b.vz = 0;
      }
    }
    if (Math.hypot(b.vx, b.vy) < 3) b.vx = b.vy = 0;
    if (b.shot) b.shot.t += dt;
    if (b.passTarget) { b.passT -= dt; if (b.passT <= 0) b.passTarget = null; }

    // 골대 맞음
    if (b.z < CROSSBAR) {
      for (const px of [0, W]) {
        for (const py of [H / 2 - GOAL_HALF, H / 2 + GOAL_HALF]) {
          const dx = b.x - px, dy = b.y - py, d = Math.hypot(dx, dy);
          if (d < BR + POST_R && d > 0.01) {
            const nx = dx / d, ny = dy / d, vn = b.vx * nx + b.vy * ny;
            if (vn < 0) {
              b.vx -= 1.6 * vn * nx; b.vy -= 1.6 * vn * ny;
              b.x = px + nx * (BR + POST_R); b.y = py + ny * (BR + POST_R);
              this.emit('post', {});
            }
          }
        }
      }
    }
    // 골망 안에서는 공이 멈춤
    if (this.state === 'goal') {
      if (b.x < -GOAL_DEPTH + BR) { b.x = -GOAL_DEPTH + BR; b.vx = -b.vx * 0.2; }
      if (b.x > W + GOAL_DEPTH - BR) { b.x = W + GOAL_DEPTH - BR; b.vx = -b.vx * 0.2; }
      if (b.x < 0 || b.x > W) {
        b.y = clamp(b.y, H / 2 - GOAL_HALF + BR, H / 2 + GOAL_HALF - BR);
        if (b.z > CROSSBAR - 10) { b.z = CROSSBAR - 10; b.vz = Math.min(b.vz, 0); }
      }
    }
  }

  contacts(dt) {
    const b = this.ball;
    if (b.owner) { this.ownerContacts(dt); return; }

    // 골키퍼 캐치 (박스 안, 손 사용)
    for (const t of this.teams) {
      const g = t.gk;
      if (g.pickupCd > 0 || (g.stun > 0 && !g.tackle) || !t.inOwnBox(b.x, b.y) || b.z > CROSSBAR + 5) continue;
      if (b.lastTouch === t.id && b.lastKicker && b.lastKicker !== g && (b.kickKind === 'foot' || b.kickKind === 'throw')) continue;   // 백패스: 손으로 못 잡음 (아래 일반 선수 접촉으로 발 처리)
      const reach = PR + BR + 3 + (g.tackle && g.tackle.kind === 'dive' ? 9 : 0);
      if (dist(g.x, g.y, b.x, b.y) > reach) continue;
      const sp = Math.hypot(b.vx, b.vy);
      const wasShot = b.shot && b.shot.team !== t.id;
      let chance = b.lastTouch === t.id ? 1 : clamp(1.4 - sp / 1030, 0.3, 0.93) * t.skill.gk * (wasShot ? (b.z > 52 ? 0.4 : b.z > 36 ? 0.62 : 0.8) : 1);
      if (Math.random() < chance) {
        if (wasShot) { t.opp.stats.onTarget++; this.emit('save', { catch: true, name: g.name, team: t.id, z: b.z, player: g }); }
        else this.emit('gkCatch', { z: b.z, player: g });
        this.gain(g);
        g.protect = 99;
        g.tackle = null;
      } else {
        if (wasShot) { t.opp.stats.onTarget++; this.emit('save', { catch: false, name: g.name, team: t.id, z: b.z, player: g }); }
        this.touchBy(g);
        // 측면 바깥으로 쳐냄 (골문 앞 리바운드 방지)
        const side = b.y < g.y ? -1 : 1;
        b.vx = t.dir * (120 + Math.random() * 160);
        b.vy = side * (380 + Math.random() * 260);
        b.vz = 120 + Math.random() * 120;
        b.lastTouch = t.id; b.lastKicker = g; b.shot = null; b.passTarget = null;
        g.pickupCd = 0.3;
        if (t.opp.human) t.opp.autoSwitch = true;
        if (t.human) t.autoSwitch = true;
      }
      return;
    }

    // 패스 받을 선수는 가슴 높이 공까지 받아냄
    if (b.z > (b.passTarget ? 45 : 28)) return;
    let best = null, bd = 1e9;
    for (const p of this.players) {
      if (p.out) continue;
      if (p.pickupCd > 0 || p.stun > 0) continue;
      if (b.z > 28 && b.passTarget !== p) continue;
      const slide = p.tackle && p.tackle.kind === 'slide';
      const reach = PR + BR + 3 + (slide ? 7 : 0) + (b.passTarget === p ? 5 : 0);
      const d = dist(p.x, p.y, b.x, b.y);
      if (d < reach && d < bd) { bd = d; best = p; }
    }
    if (!best) return;
    if (best.tackle && best.tackle.kind === 'slide') {
      this.knock(best, best.tackle.dx, best.tackle.dy, 220);
      return;
    }
    const sp = Math.hypot(b.vx, b.vy);
    let control = sp < 520 ? 1 : sp < 850 ? 0.45 : 0.1;
    if (b.passTarget === best) control = sp < 900 ? 1 : 0.85;
    if (Math.random() < control) {
      if (b.shot && b.shot.team !== best.team.id) this.emit('block', {});
      this.gain(best);
    } else {
      // 굴절
      const [nx, ny] = rotate(b.vx, b.vy, (Math.random() - 0.5) * 2);
      this.touchBy(best);
      b.vx = nx * 0.4; b.vy = ny * 0.4; b.vz = Math.random() * 120;
      b.lastTouch = best.team.id; b.lastKicker = best; b.passTarget = null;
      if (b.shot && b.shot.team !== best.team.id) { b.shot = null; this.emit('block', {}); }
      best.pickupCd = 0.25;
      this.emit('touch', {});
    }
  }

  // 공을 가진 선수에 대한 태클/압박
  ownerContacts(dt) {
    const b = this.ball, o = b.owner;
    if (o.protect > 0) return;
    for (const p of o.team.opp.players) {
      if (p.stun > 0) continue;
      const d = dist(p.x, p.y, b.x, b.y);
      if (p.isGK) {
        // 골키퍼가 발밑의 공을 덮침
        if (p.team.inOwnBox(b.x, b.y) && d < PR + BR + 8 && Math.random() < 1.6 * p.team.skill.gk * dt) {
          this.gain(p);
          p.protect = 99;
          o.pickupCd = 0.5;
          this.emit('save', { catch: true, name: p.name, team: p.team.id, smother: true, z: 0, player: p });
          return;
        }
        continue;
      }
      if (p.tackle) {
        const kind = p.tackle.kind;
        if (d < PR + BR + (kind === 'slide' ? 10 : 7)) {
          if (this.realistic && kind !== 'dive') {
            const behind = p.tackle.dx * o.fx + p.tackle.dy * o.fy > 0.45;
            const pf = kind === 'slide' ? (behind ? 0.75 : 0.28) : (behind ? 0.4 : 0.07);
            if (Math.random() < pf * (p.team.human ? 1 : 0.85)) { this.foul(p, o, kind === 'slide' || behind); return; }
          }
          if (kind === 'slide') {
            this.knock(p, p.tackle.dx, p.tackle.dy, 260);
            o.stun = 0.5; o.pickupCd = 0.6;
            this.trip(o, p.tackle.dx, p.tackle.dy, Math.random() < 0.75);
            this.emit('tackle', {});
          } else if (Math.random() < 0.7) {
            this.gain(p);
            o.stun = 0.3; o.pickupCd = 0.5;
            this.trip(o, p.fx, p.fy, Math.random() < 0.3);
            this.emit('tackle', {});
          } else {
            p.tackle = null; p.stun = 0.35;
          }
          return;
        }
      } else if (d < PR + BR + 6 && !o.isGK) {
        const rate = p.team.human ? (p === p.team.controlled ? 0.45 : 0.35) : p.team.skill.steal * 0.7;
        if (Math.random() < rate * dt) {
          this.gain(p);
          o.pickupCd = 0.5; o.stun = 0.15;
          this.emit('tackle', {});
          return;
        }
      }
    }
  }

  knock(p, dx, dy, spd) {
    const b = this.ball;
    this.touchBy(p);
    const [nx, ny] = rotate(dx, dy, (Math.random() - 0.5) * 0.8);
    b.owner = null;
    b.vx = nx * spd; b.vy = ny * spd; b.vz = 40;
    b.lastTouch = p.team.id; b.lastKicker = p; b.passTarget = null; b.shot = null;
    p.pickupCd = 0.15;
    for (const t of this.teams) if (t.human) t.autoSwitch = true;
    this.emit('touch', {});
  }

  checkOut() {
    const b = this.ball;
    if (b.x < -BR || b.x > W + BR) {
      const def = this.teams[b.x < 0 ? 0 : 1]; // 0팀은 왼쪽 골문을 지킴
      if (Math.abs(b.y - H / 2) < GOAL_HALF && b.z < CROSSBAR) {
        const nd = b.noDirect;
        if (nd) {
          // 스로인/간접 프리킥에서 다른 선수가 건드리기 전에 들어간 공: 상대 골이면 골킥, 자기 골이면 코너킥
          b.noDirect = null; this.touchGuard = null;
          this.say('직접 골 불가', 1.6);
          const lineX = b.x < 0 ? 0 : W;
          if (nd.team === def.opp.id) this.startRestart('goalkick', def, lineX === 0 ? SIX_DEPTH : W - SIX_DEPTH, H / 2);
          else this.startRestart('corner', def.opp, lineX === 0 ? 4 : W - 4, b.y < H / 2 ? 4 : H - 4);
          return;
        }
        this.scoreGoal(def.opp);
        return;
      }
      if (b.shot && b.shot.team === def.opp.id) this.emit('miss', { name: b.lastKicker && b.lastKicker.name });
      const lineX = b.x < 0 ? 0 : W;
      if (b.lastTouch === def.id) {
        const cy = b.y < H / 2 ? 4 : H - 4;
        this.startRestart('corner', def.opp, lineX === 0 ? 4 : W - 4, cy);
      } else {
        this.startRestart('goalkick', def, lineX === 0 ? SIX_DEPTH : W - SIX_DEPTH, H / 2);
      }
      return;
    }
    if (b.y < -BR || b.y > H + BR) {
      const team = this.teams[b.lastTouch === 0 ? 1 : 0];
      this.startRestart('throw', team, clamp(b.x, 20, W - 20), b.y < 0 ? 4 : H - 4);
    }
  }

  summary() {
    const total = this.teams[0].stats.possT + this.teams[1].stats.possT || 1;
    return this.teams.map(t => ({
      name: t.info.name, score: t.score,
      possession: Math.round(t.stats.possT / total * 100),
      shots: t.stats.shots, onTarget: t.stats.onTarget, passes: t.stats.passes,
      fouls: t.stats.fouls, yellow: t.stats.yellow, red: t.stats.red, offsides: t.stats.offsides,
      goals: this.goals.filter(g => g.team === t.id),
    }));
  }
}

export const Soccer = {
  Game, W, H, GOAL_HALF, GOAL_DEPTH, CROSSBAR, BOX_DEPTH, BOX_HALF, SIX_DEPTH, SIX_HALF,
  PEN_SPOT, CIRCLE_R, PR, BR, POST_R, FORMATIONS, DIFFICULTY,
};
