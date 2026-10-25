// 게임 로직 (물리, AI, 규칙). 화면/입력과 분리되어 있어 Node에서도 실행 가능.
(function (root) {
  'use strict';

  // ===== 경기장 규격 (월드 좌표) =====
  const W = 1400, H = 900;
  const GOAL_HALF = 75, GOAL_DEPTH = 34, CROSSBAR = 70;
  const BOX_DEPTH = 210, BOX_HALF = 250, SIX_DEPTH = 70, SIX_HALF = 130;
  const PEN_SPOT = 150, CIRCLE_R = 100, POST_R = 4;
  const PR = 12, BR = 6; // 선수 / 공 반지름

  // ===== 물리 =====
  const DRAG = 1.1, AIR_DRAG = 0.35, GRAVITY = 900;
  const BASE_SPEED = 150, SPRINT_MUL = 1.45;
  const TACKLE_SPEED = { stand: 240, slide: 340, dive: 330 };
  const TACKLE_TIME = { stand: 0.18, slide: 0.38, dive: 0.38 };
  const TACKLE_RECOVER = { stand: 0.12, slide: 0.45, dive: 0.5 };

  // [포지션, x(자기 골문 0 → 상대 골문 1), y(0~1)]
  const FORMATIONS = {
    5: [['GK', .03, .5], ['DF', .22, .32], ['DF', .22, .68], ['MF', .44, .5], ['FW', .66, .5]],
    7: [['GK', .03, .5], ['DF', .2, .25], ['DF', .18, .5], ['DF', .2, .75],
        ['MF', .42, .33], ['MF', .42, .67], ['FW', .66, .5]],
    11: [['GK', .03, .5], ['DF', .2, .14], ['DF', .17, .38], ['DF', .17, .62], ['DF', .2, .86],
         ['MF', .42, .14], ['MF', .39, .4], ['MF', .39, .6], ['MF', .42, .86],
         ['FW', .64, .38], ['FW', .64, .62]],
  };
  const ROLE_PACE = { GK: 0.95, DF: 0.97, MF: 1.0, FW: 1.04 };

  const DIFFICULTY = {
    easy:   { speed: 0.9,  decide: 0.45, error: 1.6, steal: 0.3,  tackle: 0.5, gk: 0.8 },
    normal: { speed: 1.0,  decide: 0.3,  error: 1.0, steal: 0.5,  tackle: 1.0, gk: 1.0 },
    hard:   { speed: 1.07, decide: 0.18, error: 0.7, steal: 0.75, tackle: 1.4, gk: 1.15 },
  };

  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const dist = (ax, ay, bx, by) => Math.hypot(ax - bx, ay - by);
  function randn() {
    let u = 0, v = 0;
    while (!u) u = Math.random();
    while (!v) v = Math.random();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
  function segDist(px, py, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay;
    const l2 = dx * dx + dy * dy || 1;
    const t = clamp(((px - ax) * dx + (py - ay) * dy) / l2, 0, 1);
    return Math.hypot(px - ax - dx * t, py - ay - dy * t);
  }
  function rotate(x, y, a) {
    const c = Math.cos(a), s = Math.sin(a);
    return [x * c - y * s, x * s + y * c];
  }
  const blankInput = () => ({ mx: 0, my: 0, pass: false, shoot: false, sprint: false, switch: false });

  class Player {
    constructor(team, idx, role, hx, hy) {
      this.team = team; this.idx = idx; this.num = idx + 1;
      this.role = role; this.isGK = role === 'GK';
      this.hx = hx; this.hy = hy;
      this.pace = ROLE_PACE[role] * (0.97 + Math.random() * 0.06);
      this.x = 0; this.y = 0; this.vx = 0; this.vy = 0; this.dvx = 0; this.dvy = 0;
      this.fx = team.dir; this.fy = 0;
      this.stamina = 1; this.sprint = false;
      this.pickupCd = 0; this.stun = 0; this.protect = 0; this.tackle = null;
      this.holdT = 0; this.aiT = 0; this.mustPass = false; this.locked = false;
      this.charge = 0; this.charging = false;
      this.wob = Math.random() * 100;
      this._icFrame = -1; this._ic = null;
    }
  }

  class Team {
    constructor(id, info, size, dir, skill, human) {
      this.id = id; this.info = info; this.dir = dir; this.skill = skill; this.human = human;
      this.score = 0;
      this.players = FORMATIONS[size].map((f, i) => new Player(this, i, f[0], f[1], f[2]));
      this.gk = this.players[0];
      this.controlled = null;
      this.input = blankInput(); this.prev = blankInput();
      this.press = {}; this.release = {};
      this.autoSwitch = false;
      this.stats = { shots: 0, onTarget: 0, possT: 0, passes: 0 };
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

  class Game {
    constructor(opts) {
      this.teamSize = opts.teamSize || 7;
      this.matchSeconds = opts.matchSeconds || 240;
      const humans = opts.humans || [false, false];
      const diff = DIFFICULTY[opts.difficulty] ? opts.difficulty : 'normal';
      this.teams = [0, 1].map(i => {
        // 난이도는 사람과 상대하는 AI 팀에만 적용
        const key = !humans[i] && humans[1 - i] ? diff : 'normal';
        return new Team(i, opts.teams[i], this.teamSize, i === 0 ? 1 : -1, DIFFICULTY[key], !!humans[i]);
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
      this.time += dt; this.frame++;
      if (this.message) { this.message.t -= dt; if (this.message.t <= 0) this.message = null; }
      for (const t of this.teams) {
        const i = t.input, p = t.prev;
        t.press = { pass: i.pass && !p.pass, shoot: i.shoot && !p.shoot, switch: i.switch && !p.switch };
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

    playStep(dt) {
      for (const t of this.teams) this.updateControl(t);
      for (const t of this.teams) {
        this.thinkTeam(t, dt);
        if (t.human) this.thinkHuman(t, dt);
      }
      this.integrate(dt);
      this.updateBall(dt);
      this.contacts(dt);
      this.checkOut();
    }

    // 재시작/골 세리머니 중: 모든 선수가 AI로 자리 잡기
    scriptedStep(dt) {
      const r = this.restart;
      for (const t of this.teams) {
        for (const p of t.players) {
          p.tackle = null; p.charging = false;
          if (r && p === r.taker && this.state === 'out') {
            this.moveToward(p, r.px, r.py, true, true);
          } else if (p.isGK) {
            this.gkPosition(p);
          } else {
            this.thinkPosition(p, r ? t === r.team : false);
          }
        }
      }
      this.integrate(dt);
    }

    // ================= 경기 흐름 =================
    setupKickoff(teamId) {
      const kt = this.teams[teamId];
      this.state = 'kickoff'; this.stateT = 1.4; this.restart = null;
      const b = this.ball;
      Object.assign(b, { x: W / 2, y: H / 2, z: 0, vx: 0, vy: 0, vz: 0, owner: null,
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
          p.tackle = null; p.stun = 0; p.charging = false; p.charge = 0;
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

    startRestart(kind, team, x, y) {
      const b = this.ball;
      this.state = 'out'; this.stateT = 1.3;
      Object.assign(b, { owner: null, vx: 0, vy: 0, vz: 0, z: 0, x, y, passTarget: null, shot: null });
      const taker = kind === 'goalkick' ? team.gk : this.closestOutfield(team, x, y);
      // 공 뒤쪽(경기장 바깥쪽)에 서서 경기장 안을 바라봄
      let fx, fy;
      if (kind === 'throw') { fx = 0; fy = y < H / 2 ? 1 : -1; }
      else if (kind === 'corner') { fx = W / 2 - x; fy = H / 2 - y; }
      else { fx = team.dir; fy = 0; }
      const fl = Math.hypot(fx, fy) || 1; fx /= fl; fy /= fl;
      this.restart = { kind, team, x, y, taker, fx, fy,
                       px: x - fx * (PR + BR + 1), py: y - fy * (PR + BR + 1) };
      const names = { throw: '스로인', corner: '코너킥', goalkick: '골킥' };
      this.say(names[kind], 1.3);
      this.emit('whistle', { n: 1, short: true });
    }

    takeRestart() {
      const r = this.restart, p = r.taker;
      p.x = r.px; p.y = r.py; p.vx = p.vy = 0; p.fx = r.fx; p.fy = r.fy;
      this.ball.x = r.x; this.ball.y = r.y;
      this.gain(p);
      p.protect = 1.2;
      p.mustPass = r.kind !== 'goalkick';
      p.locked = r.kind === 'throw';
      p.aiT = 0.5;
      // 상대 선수는 공에서 떨어뜨림
      for (const o of r.team.opp.players) {
        const d = dist(o.x, o.y, r.x, r.y);
        if (d < 90) {
          const k = 90 / (d || 1);
          o.x = r.x + (o.x - r.x) * k; o.y = r.y + (o.y - r.y) * k;
        }
      }
      if (r.team.human && !p.isGK) r.team.controlled = p;
      this.state = 'play';
    }

    scoreGoal(team) {
      team.score++;
      const b = this.ball;
      const t = this.displayTime;
      const own = b.lastTouch !== team.id;
      this.goals.push({ team: team.id, minute: t.m + 1, scorer: own ? null : (b.lastKicker ? b.lastKicker.num : null), own });
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

    updateControl(team) {
      if (!team.human) return;
      const b = this.ball;
      const own = b.owner && b.owner.team === team;
      if (own && !b.owner.isGK && team.controlled !== b.owner) team.controlled = b.owner;
      if (!team.controlled || team.controlled.isGK) team.controlled = this.closestOutfield(team, b.x, b.y);
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
    }

    // ================= 이동 유틸 =================
    maxSpeed(p, sprint) {
      let s = BASE_SPEED * p.pace * p.team.skill.speed;
      if (this.ball.owner === p) s *= 0.9;
      if (sprint && p.stamina > 0.05) s *= SPRINT_MUL;
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

    // ================= 팀 AI =================
    thinkTeam(team, dt) {
      const b = this.ball, owner = b.owner;
      const hasBall = owner && owner.team === team;
      const oppHasBall = owner && owner.team !== team;
      const ctrl = team.human ? team.controlled : null;
      let chaser = null, cover = null, helper = null;
      // 골키퍼가 공을 잡고 있으면 압박하지 않고 물러남
      const gkHolding = oppHasBall && owner.isGK && owner.team.inOwnBox(owner.x, owner.y);
      if (!hasBall && !gkHolding) {
        const cand = team.players.filter(p => !p.isGK && p !== ctrl && p.stun <= 0)
          .sort((a, c) => this.intercept(a).t - this.intercept(c).t);
        if (team.human) {
          // 사람 팀의 AI 동료는 사람보다 확실히 가까울 때만 공을 쫓음
          if (cand[0] && (!ctrl || this.intercept(cand[0]).t < this.intercept(ctrl).t * 0.7 - 0.1)) chaser = cand[0];
          if (oppHasBall) cover = cand.find(p => p !== chaser);
        } else {
          chaser = cand[0];
          if (oppHasBall) cover = cand[1];
        }
        // 우리 진영 깊숙이 밀리면 한 명 더 압박
        if (oppHasBall && team.prog(b.x) < 0.3) helper = cand.find(p => p !== chaser && p !== cover);
      }
      const attacking = hasBall || (!owner && b.lastTouch === team.id);
      for (const p of team.players) {
        if (p === ctrl) continue;
        p.sprint = false;
        if (p.stun > 0 || p.tackle) continue;
        if (gkHolding && dist(p.x, p.y, b.x, b.y) < 130) {
          const dx = p.x - b.x, dy = p.y - b.y, d = Math.hypot(dx, dy) || 1;
          this.moveToward(p, b.x + dx / d * 140, b.y + dy / d * 140, false, true);
          continue;
        }
        if (p.isGK) { this.thinkGK(p, dt); continue; }
        if (owner === p) { this.thinkCarrier(p, dt); continue; }
        if (!owner && b.passTarget === p) {
          const ic = this.intercept(p);
          this.moveToward(p, ic.x, ic.y, ic.t > 0.4, true);
          continue;
        }
        if (p === chaser) { this.thinkChaser(p, dt); continue; }
        if (p === helper) {
          // 공과 골문 사이 슈팅 각도를 막음
          const gx = team.ownX, gy = H / 2;
          const dx = gx - b.x, dy = gy - b.y, d = Math.hypot(dx, dy) || 1;
          const k = Math.min(140, d * 0.6);
          this.moveToward(p, b.x + dx / d * k, b.y + dy / d * k, true, true);
          continue;
        }
        if (p === cover) {
          const gx = team.ownX, gy = H / 2;
          const dx = gx - b.x, dy = gy - b.y, d = Math.hypot(dx, dy) || 1;
          const k = Math.min(80, d * 0.5);
          this.moveToward(p, b.x + dx / d * k, b.y + dy / d * k, dist(p.x, p.y, b.x, b.y) > 140, true);
          continue;
        }
        this.thinkPosition(p, attacking);
      }
    }

    thinkPosition(p, attacking) {
      const b = this.ball, t = p.team;
      const prog = clamp(t.prog(b.x), 0, 1);
      let nx = p.hx * 0.55 + prog * 0.55 - 0.08 + (attacking ? 0.1 : -0.02);
      if (!attacking) {
        const lim = p.role === 'FW' ? prog + 0.12 : prog - 0.03;
        nx = Math.min(nx, Math.max(lim, p.role === 'DF' ? 0.08 : 0.15));
      }
      if (p.role === 'DF') nx = Math.min(nx, attacking ? 0.62 : 0.5);
      if (p.role === 'FW' && attacking) nx = Math.max(nx, Math.min(prog + 0.12, 0.85));
      nx += Math.cos(this.time * 0.5 + p.wob) * 0.015;
      nx = clamp(nx, 0.06, 0.9);
      let ny = 0.5 + (p.hy - 0.5) * (attacking ? 1.15 : 0.85) + (b.y / H - 0.5) * 0.35;
      ny += Math.sin(this.time * 0.7 + p.wob) * 0.02;
      ny = clamp(ny, 0.05, 0.95);
      const tx = t.toWorldX(nx), ty = ny * H;
      this.moveToward(p, tx, ty, dist(p.x, p.y, tx, ty) > 160, true);
    }

    thinkChaser(p, dt) {
      const b = this.ball, sk = p.team.skill;
      if (b.owner) {
        const o = b.owner;
        // 공 운반자의 진행 방향을 살짝 앞질러 압박
        const tx = b.x + o.vx * 0.15, ty = b.y + o.vy * 0.15;
        const d = dist(p.x, p.y, b.x, b.y);
        this.moveToward(p, tx, ty, d > 50, false);
        if (!p.team.human && o.protect <= 0 && !o.isGK) {
          if (d < 34 && Math.random() < dt * 1.0 * sk.tackle) {
            this.startTackle(p, 'stand', b.x - p.x, b.y - p.y);
          } else if (d > 36 && d < 70 && Math.random() < dt * 0.35 * sk.tackle) {
            this.startTackle(p, 'slide', b.x - p.x, b.y - p.y);
          }
        }
      } else {
        const ic = this.intercept(p);
        this.moveToward(p, ic.x, ic.y, true, ic.t > 0.3 ? false : true);
      }
    }

    thinkCarrier(p, dt) {
      const t = p.team, sk = t.skill, b = this.ball;
      p.holdT += dt;
      p.aiT -= dt;
      const gx = t.attackX, gy = H / 2;
      const dGoal = dist(p.x, p.y, gx, gy);
      let press = 1e9;
      for (const o of t.opp.players) press = Math.min(press, dist(o.x, o.y, p.x, p.y));

      if (p.locked) { p.dvx = p.dvy = 0; }
      if (p.aiT <= 0 || (press < 40 && p.aiT < sk.decide * 0.5)) {
        p.aiT = sk.decide * (0.6 + Math.random() * 0.8);
        if (!p.mustPass && Math.abs(gx - p.x) > 40) {
          if (dGoal < 240 || (dGoal < 360 && (press < 55 || Math.random() < 0.35)) ||
              (dGoal < 480 && Math.random() < 0.05)) {
            this.aiShoot(p, dGoal);
            return;
          }
        }
        const best = this.bestPass(p);
        if (best && (p.mustPass || (press < 50 && best.score > 0.05) ||
                     best.score > 0.55 + Math.random() * 0.3 || (p.holdT > 2.5 && best.score > -0.2))) {
          this.passTo(p, best.mate, best.lofted, sk.error);
          return;
        }
        if (p.mustPass && p.holdT > 1.5) {
          this.kickTo(p, t.toWorldX(clamp(t.prog(p.x) + 0.25, 0, 0.85)), H * (0.3 + Math.random() * 0.4), true, sk.error, {});
          return;
        }
      }
      if (p.locked) return;

      // 드리블: 골문 방향 + 앞을 막는 수비 회피
      let dx = gx - p.x, dy = gy - p.y;
      let d = Math.hypot(dx, dy) || 1; dx /= d; dy /= d;
      const bx = dx, by = dy;
      for (const o of t.opp.players) {
        const rx = o.x - p.x, ry = o.y - p.y, od = Math.hypot(rx, ry);
        if (od > 120 || od < 1) continue;
        const ahead = (rx * bx + ry * by) / od;
        if (ahead < 0.1) continue;
        const side = rx * -by + ry * bx > 0 ? 1 : -1;
        const w = (120 - od) / 120 * 1.5 * ahead;
        dx -= -by * side * w; dy -= bx * side * w;
      }
      if (p.y < 70) dy += 0.9;
      if (p.y > H - 70) dy -= 0.9;
      d = Math.hypot(dx, dy) || 1;
      this.moveToward(p, p.x + dx / d * 100, p.y + dy / d * 100, press > 70 && p.stamina > 0.3, false);
    }

    bestPass(p, fromGK) {
      const t = p.team;
      let best = null;
      for (const m of t.players) {
        if (m === p) continue;
        if (m.isGK && (fromGK || t.prog(p.x) > 0.35)) continue;
        const d = dist(p.x, p.y, m.x, m.y);
        if (d < 70 || d > 650) continue;
        let lane = 1e9, mark = 1e9;
        for (const o of t.opp.players) {
          lane = Math.min(lane, segDist(o.x, o.y, p.x, p.y, m.x, m.y));
          mark = Math.min(mark, dist(o.x, o.y, m.x, m.y));
        }
        let lofted = false;
        let score = (t.prog(m.x) - t.prog(p.x)) * 2.5 + Math.min(mark, 140) / 140 * 0.7 - d / 1500 - 0.35;
        if (lane < 22) {
          if (d < 300) continue;
          lofted = true; score -= 0.2;
        } else {
          score += Math.min(lane, 80) / 80 * 0.3;
          if (d > 420) { lofted = true; score -= 0.05; }
        }
        if (m.isGK) score -= 0.4;
        if (!best || score > best.score) best = { mate: m, score, lofted };
      }
      return best;
    }

    aiShoot(p, dGoal) {
      const t = p.team, gk = t.opp.gk;
      // 골키퍼에서 먼 쪽 구석을 노림
      const side = gk.y > H / 2 ? -1 : 1;
      const s = Math.random() < 0.75 ? side : -side;
      const aimY = H / 2 + s * GOAL_HALF * (0.4 + Math.random() * 0.45);
      const power = clamp(0.45 + dGoal / 700, 0.5, 1) * (0.85 + Math.random() * 0.15);
      this.shoot(p, power, aimY, t.skill.error);
    }

    // ================= 골키퍼 AI =================
    thinkGK(p, dt) {
      const t = p.team, b = this.ball;
      if (b.owner === p) {
        p.holdT += dt; p.dvx = p.dvy = 0;
        if (p.holdT > 1.0) this.gkDistribute(p);
        return;
      }
      // 슛 대응
      if (!b.owner && (t.ownX - b.x) * b.vx > 0 && Math.abs(b.vx) > 200) {
        const tt = (p.x - b.x) / b.vx;
        if (tt > 0 && tt < 1.2) {
          const f = (1 - Math.exp(-DRAG * tt)) / DRAG;
          const py = b.y + b.vy * f;
          if (Math.abs(py - H / 2) < GOAL_HALF + 40) {
            const react = b.shot ? b.shot.t > 0.1 / t.skill.gk : true;
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
      // 박스 안으로 들어온 공격수에게 달려 나감
      if (b.owner && b.owner.team !== t && t.inOwnBox(b.x, b.y) && dist(p.x, p.y, b.x, b.y) < 170) {
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

    gkPosition(p) {
      const t = p.team, b = this.ball;
      const gx = t.ownX, gy = H / 2;
      const dx = b.x - gx, dy = b.y - gy, d = Math.hypot(dx, dy) || 1;
      const out = clamp(d * 0.12, 14, 65);
      const tx = gx + dx / d * out;
      const ty = clamp(gy + dy / d * out, gy - GOAL_HALF - 8, gy + GOAL_HALF + 8);
      this.moveToward(p, tx, ty, false, true);
    }

    gkDistribute(p) {
      const best = this.bestPass(p, true);
      if (best && best.score > -0.5) {
        const d = dist(p.x, p.y, best.mate.x, best.mate.y);
        this.passTo(p, best.mate, best.lofted || d > 330, 0.8);
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

      if (b.owner === p && p.locked) {
        p.dvx = p.dvy = 0;
      } else if (moving) {
        p.sprint = inp.sprint;
        const s = this.maxSpeed(p, p.sprint);
        p.dvx = mx * s; p.dvy = my * s;
      } else if (!b.owner && b.passTarget === p) {
        const ic = this.intercept(p);
        this.moveToward(p, ic.x, ic.y, false, true);
      } else {
        p.dvx = p.dvy = 0;
      }

      if (b.owner === p) {
        if (pr.pass) { this.humanPass(p, mx, my, moving); return; }
        if (inp.shoot) {
          p.charging = true;
          p.charge = Math.min(1, p.charge + dt / 0.9);
        } else if (p.charging) {
          const aim = moving ? my : (Math.random() - 0.5) * 0.8;
          this.shoot(p, 0.2 + p.charge * 0.8, H / 2 + clamp(aim, -1, 1) * GOAL_HALF * 0.8, 1);
        }
      } else {
        p.charging = false; p.charge = 0;
        const dx = moving ? mx : b.x - p.x, dy = moving ? my : b.y - p.y;
        if (pr.pass) this.startTackle(p, 'stand', dx, dy);
        else if (pr.shoot) this.startTackle(p, 'slide', moving ? mx : p.fx, moving ? my : p.fy);
      }
    }

    humanPass(p, mx, my, moving) {
      const t = p.team;
      const dx = moving ? mx : p.fx, dy = moving ? my : p.fy;
      let best = null, bs = -1e9;
      for (const m of t.players) {
        if (m === p) continue;
        const vx = m.x - p.x, vy = m.y - p.y, d = Math.hypot(vx, vy);
        if (d < 30) continue;
        const cos = (vx * dx + vy * dy) / d;
        if (cos < 0.5) continue;
        let lane = 1e9;
        for (const o of t.opp.players) lane = Math.min(lane, segDist(o.x, o.y, p.x, p.y, m.x, m.y));
        let s = cos * 1.5 - d / 900 + Math.min(lane, 60) / 60 * 0.3;
        if (m.isGK) s -= 0.5;
        if (s > bs) { bs = s; best = m; }
      }
      if (best) {
        const d = dist(p.x, p.y, best.x, best.y);
        let lane = 1e9;
        for (const o of t.opp.players) lane = Math.min(lane, segDist(o.x, o.y, p.x, p.y, best.x, best.y));
        this.passTo(p, best, d > 420 || (d > 300 && lane < 20), 0.6);
      } else {
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
      [dx, dy] = rotate(dx / d, dy / d, randn() * 0.035 * errMul * (1 + d / 500));
      this.kick(p, dx * spd, dy * spd, vz, opts);
    }

    passTo(p, m, lofted, errMul) {
      const lead = 0.35;
      p.team.stats.passes++;
      this.kickTo(p, m.x + m.vx * lead, m.y + m.vy * lead, lofted, errMul, { passTarget: m });
    }

    shoot(p, power, aimY, errMul) {
      const t = p.team;
      let dx = t.attackX - p.x, dy = aimY - p.y;
      const d = Math.hypot(dx, dy) || 1;
      const err = randn() * (0.03 + 0.06 * power * power + d / 6000) * errMul;
      [dx, dy] = rotate(dx / d, dy / d, err);
      const spd = 480 + power * 720;
      const vz = 20 + power * power * 240 + Math.max(0, randn()) * power * 80;
      t.stats.shots++;
      this.kick(p, dx * spd, dy * spd, vz, { shot: true });
    }

    kick(p, vx, vy, vz, opts) {
      const b = this.ball, t = p.team;
      b.owner = null;
      b.vx = vx; b.vy = vy; b.vz = vz;
      b.lastTouch = t.id; b.lastKicker = p;
      b.passTarget = opts.passTarget || null; b.passT = 2;
      b.shot = opts.shot ? { team: t.id, t: 0 } : null;
      p.pickupCd = 0.28; p.holdT = 0; p.mustPass = false; p.locked = false;
      p.charging = false; p.charge = 0;
      if (p.isGK) p.protect = 0;
      this.emit('kick', { power: Math.hypot(vx, vy), shot: !!opts.shot });
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
      b.owner = p; b.lastTouch = p.team.id; b.lastKicker = p;
      b.passTarget = null; b.shot = null; b.z = 0; b.vz = 0;
      p.protect = 0.3; p.holdT = 0; p.aiT = 0.15 + Math.random() * 0.2;
      p.mustPass = false; p.locked = false;
      this.emit('touch', {});
    }

    // ================= 물리 =================
    integrate(dt) {
      const b = this.ball;
      for (const p of this.players) {
        p.pickupCd = Math.max(0, p.pickupCd - dt);
        p.protect = Math.max(0, p.protect - dt);
        if (p.tackle) {
          const tk = p.tackle, sp = TACKLE_SPEED[tk.kind];
          p.vx = tk.dx * sp; p.vy = tk.dy * sp;
          tk.t -= dt;
          if (tk.t <= 0) { p.stun = TACKLE_RECOVER[tk.kind]; p.tackle = null; }
        } else if (p.stun > 0) {
          p.stun -= dt;
          const f = Math.exp(-8 * dt); p.vx *= f; p.vy *= f;
        } else {
          const a = Math.min(1, dt * (b.owner === p ? 7 : 9));
          p.vx += (p.dvx - p.vx) * a; p.vy += (p.dvy - p.vy) * a;
        }
        p.x = clamp(p.x + p.vx * dt, -30, W + 30);
        p.y = clamp(p.y + p.vy * dt, -30, H + 30);
        const sp = Math.hypot(p.vx, p.vy);
        if (sp > 20 && !p.tackle && !p.locked) {
          const k = Math.min(1, dt * (b.owner === p ? 9 : 14));
          p.fx += (p.vx / sp - p.fx) * k; p.fy += (p.vy / sp - p.fy) * k;
          const fl = Math.hypot(p.fx, p.fy) || 1; p.fx /= fl; p.fy /= fl;
        }
        if (p.sprint && sp > BASE_SPEED * 1.05) p.stamina = Math.max(0, p.stamina - dt * 0.2);
        else p.stamina = Math.min(1, p.stamina + dt * 0.09);
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
        const off = o.isGK && o.team.inOwnBox(o.x, o.y) ? PR * 0.7 : PR + BR + 1 + (o.sprint ? 3 : 0);
        b.x = o.x + o.fx * off; b.y = o.y + o.fy * off;
        b.vx = o.vx; b.vy = o.vy; b.z = 0; b.vz = 0;
        return;
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
        const reach = PR + BR + 4 + (g.tackle && g.tackle.kind === 'dive' ? 16 : 0);
        if (dist(g.x, g.y, b.x, b.y) > reach) continue;
        const sp = Math.hypot(b.vx, b.vy);
        const wasShot = b.shot && b.shot.team !== t.id;
        let chance = b.lastTouch === t.id ? 1 : clamp(1.55 - sp / 1100, 0.4, 0.97) * t.skill.gk;
        if (Math.random() < chance) {
          if (wasShot) { t.opp.stats.onTarget++; this.emit('save', { catch: true }); }
          this.gain(g);
          g.protect = 99;
          g.tackle = null;
        } else {
          if (wasShot) { t.opp.stats.onTarget++; this.emit('save', { catch: false }); }
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

      if (b.z > 28) return;
      let best = null, bd = 1e9;
      for (const p of this.players) {
        if (p.pickupCd > 0 || p.stun > 0) continue;
        const slide = p.tackle && p.tackle.kind === 'slide';
        const reach = PR + BR + 3 + (slide ? 7 : 0);
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
      if (b.passTarget === best) control = Math.max(control, 0.85);
      if (Math.random() < control) {
        if (b.shot && b.shot.team !== best.team.id) this.emit('block', {});
        this.gain(best);
      } else {
        // 굴절
        const [nx, ny] = rotate(b.vx, b.vy, (Math.random() - 0.5) * 2);
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
          if (p.team.inOwnBox(b.x, b.y) && d < PR + BR + 8 && Math.random() < 3 * p.team.skill.gk * dt) {
            this.gain(p);
            p.protect = 99;
            o.pickupCd = 0.5;
            this.emit('save', { catch: true });
            return;
          }
          continue;
        }
        if (p.tackle) {
          const kind = p.tackle.kind;
          if (d < PR + BR + (kind === 'slide' ? 10 : 7)) {
            if (kind === 'slide') {
              this.knock(p, p.tackle.dx, p.tackle.dy, 260);
              o.stun = 0.5; o.pickupCd = 0.6;
              this.emit('tackle', {});
            } else if (Math.random() < 0.7) {
              this.gain(p);
              o.stun = 0.3; o.pickupCd = 0.5;
              this.emit('tackle', {});
            } else {
              p.tackle = null; p.stun = 0.35;
            }
            return;
          }
        } else if (d < PR + BR + 6 && !o.isGK) {
          const rate = p.team.human ? (p === p.team.controlled ? 0.45 : 0.35) : p.team.skill.steal;
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
          this.scoreGoal(def.opp);
          return;
        }
        if (b.shot && b.shot.team === def.opp.id) this.emit('miss', {});
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
        goals: this.goals.filter(g => g.team === t.id),
      }));
    }
  }

  const Soccer = {
    Game, W, H, GOAL_HALF, GOAL_DEPTH, CROSSBAR, BOX_DEPTH, BOX_HALF, SIX_DEPTH, SIX_HALF,
    PEN_SPOT, CIRCLE_R, PR, BR, POST_R, FORMATIONS,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = Soccer;
  else root.Soccer = Soccer;
})(typeof window !== 'undefined' ? window : globalThis);
