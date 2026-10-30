// 대형(포메이션)과 전술 설정. 화면(라인업)과 엔진(AI)이 같이 씀
// 슬롯 = [포지션, x(자기 골문 0 → 상대 골문 1), y(0~1 위→아래)]. 슬롯 순서 = 명단에서 뽑는 선수 순서(ROSTER_PICK)

// 포지션별 성격: role(GK/DF/MF/FW), push(공격 때 앞으로 나가는 폭), follow(공 위치를 따라가는 정도), wide(측면 선수 여부)
export const POS = {
  GK: { role: 'GK', label: 'GK' },
  CB: { role: 'DF', push: 0.035, follow: 0.5, label: 'CB' },
  LB: { role: 'DF', push: 0.15, follow: 0.55, wide: 1, label: 'LB' },
  RB: { role: 'DF', push: 0.15, follow: 0.55, wide: 1, label: 'RB' },
  LWB: { role: 'DF', push: 0.2, follow: 0.6, wide: 1, label: 'LWB' },
  RWB: { role: 'DF', push: 0.2, follow: 0.6, wide: 1, label: 'RWB' },
  DM: { role: 'MF', push: 0.05, follow: 0.6, label: 'DM' },
  CM: { role: 'MF', push: 0.1, follow: 0.65, label: 'CM' },
  AM: { role: 'MF', push: 0.12, follow: 0.7, label: 'AM' },
  LM: { role: 'MF', push: 0.12, follow: 0.65, wide: 1, label: 'LM' },
  RM: { role: 'MF', push: 0.12, follow: 0.65, wide: 1, label: 'RM' },
  LW: { role: 'FW', push: 0.09, follow: 0.6, wide: 1, label: 'LW' },
  RW: { role: 'FW', push: 0.09, follow: 0.6, wide: 1, label: 'RW' },
  ST: { role: 'FW', push: 0.07, follow: 0.6, label: 'ST' },
};

const S = (pos, x, y) => [pos, x, y];

export const FORMATIONS = {
  11: {
    '4-4-2': [S('GK', .03, .5), S('LB', .2, .13), S('CB', .17, .37), S('CB', .17, .63), S('RB', .2, .87),
              S('LM', .42, .13), S('CM', .4, .38), S('CM', .4, .62), S('RM', .42, .87), S('ST', .66, .38), S('ST', .66, .62)],
    '4-3-3': [S('GK', .03, .5), S('LB', .2, .13), S('CB', .17, .37), S('CB', .17, .63), S('RB', .2, .87),
              S('LW', .64, .14), S('CM', .42, .3), S('DM', .34, .5), S('RW', .64, .86), S('ST', .68, .5), S('CM', .42, .7)],
    '4-2-3-1': [S('GK', .03, .5), S('LB', .2, .13), S('CB', .17, .37), S('CB', .17, .63), S('RB', .2, .87),
                S('LM', .52, .14), S('DM', .34, .37), S('DM', .34, .63), S('RM', .52, .86), S('ST', .7, .5), S('AM', .52, .5)],
    '3-5-2': [S('GK', .03, .5), S('LWB', .38, .08), S('CB', .16, .28), S('CB', .16, .72), S('RWB', .38, .92),
              S('CM', .42, .28), S('DM', .33, .5), S('CB', .14, .5), S('CM', .42, .72), S('ST', .66, .38), S('ST', .66, .62)],
    '5-3-2': [S('GK', .03, .5), S('LWB', .26, .08), S('CB', .16, .3), S('CB', .16, .7), S('RWB', .26, .92),
              S('CM', .4, .28), S('CM', .38, .5), S('CB', .14, .5), S('CM', .4, .72), S('ST', .65, .38), S('ST', .65, .62)],
    '4-1-4-1': [S('GK', .03, .5), S('LB', .2, .13), S('CB', .17, .37), S('CB', .17, .63), S('RB', .2, .87),
                S('LM', .48, .12), S('CM', .46, .37), S('DM', .32, .5), S('RM', .48, .88), S('ST', .7, .5), S('CM', .46, .63)],
    '3-4-3': [S('GK', .03, .5), S('LWB', .38, .08), S('CB', .16, .28), S('CB', .16, .72), S('RWB', .38, .92),
              S('LW', .64, .2), S('CM', .38, .38), S('CB', .14, .5), S('CM', .38, .62), S('ST', .68, .5), S('RW', .64, .8)],
  },
  7: {
    '3-2-1': [S('GK', .03, .5), S('LB', .2, .2), S('CB', .18, .5), S('RB', .2, .8), S('CM', .42, .3), S('CM', .42, .7), S('ST', .66, .5)],
    '2-3-1': [S('GK', .03, .5), S('LB', .2, .26), S('DM', .34, .5), S('RB', .2, .74), S('LM', .46, .14), S('RM', .46, .86), S('ST', .66, .5)],
  },
  5: {
    '2-1-1': [S('GK', .03, .5), S('CB', .22, .32), S('CB', .22, .68), S('CM', .44, .5), S('ST', .66, .5)],
    '1-2-1': [S('GK', .03, .5), S('CB', .2, .5), S('LM', .42, .26), S('RM', .42, .74), S('ST', .66, .5)],
  },
};

export const DEFAULT_FORMATION = { 11: '4-4-2', 7: '3-2-1', 5: '2-1-1' };
// 명단(GK, LB, LCB, RCB, RB, LM, LCM, RCM, RM, ST, ST2)에서 인원별로 뽑는 선수
export const ROSTER_PICK = { 5: [0, 2, 3, 8, 9], 7: [0, 1, 2, 4, 5, 8, 9], 11: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10] };

// 전술 스타일 프리셋
export const STYLES = {
  balanced: { label: '균형', press: 0.5, line: 0.5, width: 0.5, tempo: 0.5, direct: 0.45, mentality: 0 },
  possession: { label: '점유', press: 0.55, line: 0.6, width: 0.55, tempo: 0.35, direct: 0.2, mentality: 0.1 },
  counter: { label: '역습', press: 0.35, line: 0.3, width: 0.45, tempo: 0.8, direct: 0.85, mentality: -0.1 },
  attack: { label: '공격', press: 0.72, line: 0.72, width: 0.6, tempo: 0.7, direct: 0.55, mentality: 0.65 },
  defend: { label: '수비', press: 0.25, line: 0.2, width: 0.4, tempo: 0.4, direct: 0.65, mentality: -0.65 },
  wings: { label: '측면', press: 0.5, line: 0.5, width: 0.95, tempo: 0.6, direct: 0.55, mentality: 0.2 },
};
export const STYLE_ORDER = ['balanced', 'possession', 'counter', 'attack', 'defend', 'wings'];

export const formationList = size => Object.keys(FORMATIONS[size] || FORMATIONS[11]);

// 팀 정보(능력치)로 AI 팀의 기본 대형/스타일을 정함
export function suggestTactics(info, size) {
  const list = formationList(size);
  const r = info.rating || [78, 78, 78, 78];
  const [, att, mid, def] = r;
  let formation = DEFAULT_FORMATION[size];
  let style = 'balanced';
  if (size === 11) {
    if (att - def >= 4) { formation = att - mid >= 3 ? '4-3-3' : '4-2-3-1'; style = 'attack'; }
    else if (def - att >= 3) { formation = '5-3-2'; style = 'defend'; }
    else if (mid - att >= 3) { formation = '4-1-4-1'; style = 'possession'; }
    else if (att >= 84) { formation = '4-3-3'; style = 'possession'; }
    else { formation = '4-4-2'; style = 'balanced'; }
  } else if (size === 7) {
    formation = att >= def ? '2-3-1' : '3-2-1';
  } else {
    formation = att >= def ? '2-1-1' : '1-2-1';
  }
  if (!list.includes(formation)) formation = DEFAULT_FORMATION[size];
  return { formation, style };
}

// 대형에 맞춘 선수 배치표: [{ slot:[pos,x,y], rosterIndex }]
export function lineupFor(size, formation) {
  const sizeKey = FORMATIONS[size] ? size : 11;
  const slots = (FORMATIONS[sizeKey][formation] || FORMATIONS[sizeKey][DEFAULT_FORMATION[sizeKey]]);
  const pick = ROSTER_PICK[sizeKey];
  return slots.map((slot, i) => ({ slot, rosterIndex: pick[i] }));
}

// ===== 선수 ↔ 자리 배정 =====
// 명단 번호별 본래 자리: 0 GK, 1 LB, 2·3 CB, 4 RB, 5 LM, 6·7 CM, 8 RM, 9·10 ST. 후보(11~)는 적힌 포지션으로 추정.
export function tagOfRoster(ri, entry, tags) {
  if (tags && tags[ri]) return tags[ri];          // 2026-27 새 선수는 실제 포지션으로
  if (ri <= 10) return ['GK', 'LB', 'CB', 'CB', 'RB', 'LM', 'CM', 'CM', 'RM', 'ST', 'ST'][ri];
  const pos = entry && entry[4];
  return pos === 'GK' ? 'GK' : pos === 'DF' ? 'CB' : pos === 'FW' ? 'ST' : 'CM';
}
// [본래 자리][대형 자리] → 어울리지 않는 정도 (작을수록 잘 맞음). 없으면 9
const FIT = {
  LB: { LB: 0, LWB: 0, CB: 1, RB: 3, RWB: 3, DM: 4, LM: 2, LW: 3, CM: 5, RM: 6, AM: 7, ST: 9 },
  RB: { RB: 0, RWB: 0, CB: 1, LB: 3, LWB: 3, DM: 4, RM: 2, RW: 3, CM: 5, LM: 6, AM: 7, ST: 9 },
  CB: { CB: 0, LB: 1.5, RB: 1.5, LWB: 2, RWB: 2, DM: 2.5, CM: 5, LM: 7, RM: 7, AM: 8, ST: 9 },
  CM: { CM: 0, DM: 0.5, AM: 0.8, LM: 1.5, RM: 1.5, LW: 3, RW: 3, ST: 4, LWB: 3.5, RWB: 3.5, CB: 3.5, LB: 5, RB: 5 },
  LM: { LM: 0, LW: 0.5, LWB: 1, AM: 1.2, CM: 1.5, RM: 2.5, RW: 3, ST: 2, DM: 3, LB: 3, CB: 5, RB: 6, RWB: 5 },
  RM: { RM: 0, RW: 0.5, RWB: 1, AM: 1.2, CM: 1.5, LM: 2.5, LW: 3, ST: 2, DM: 3, RB: 3, CB: 5, LB: 6, LWB: 5 },
  ST: { ST: 0, AM: 1.5, LW: 1.2, RW: 1.2, LM: 2, RM: 2, CM: 3, DM: 5, LB: 9, RB: 9, CB: 9, LWB: 8, RWB: 8 },
};
function fitCost(tag, slotPos) {
  if (tag === 'GK' || slotPos === 'GK') return tag === slotPos ? 0 : 1000;
  const row = FIT[tag];
  return row && row[slotPos] !== undefined ? row[slotPos] : 9;
}
// 최소 비용 배정 (헝가리안 알고리즘, n ≤ 11). cost[i][j]: 선수 i를 자리 j에 놓는 비용 → 자리마다 선수 번호
function hungarian(cost) {
  const n = cost.length, INF = 1e9;
  const u = new Array(n + 1).fill(0), v = new Array(n + 1).fill(0), p = new Array(n + 1).fill(0), way = new Array(n + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    p[0] = i; let j0 = 0;
    const minv = new Array(n + 1).fill(INF), used = new Array(n + 1).fill(false);
    do {
      used[j0] = true; const i0 = p[j0]; let delta = INF, j1 = 0;
      for (let j = 1; j <= n; j++) if (!used[j]) {
        const cur = cost[i0 - 1][j - 1] - u[i0] - v[j];
        if (cur < minv[j]) { minv[j] = cur; way[j] = j0; }
        if (minv[j] < delta) { delta = minv[j]; j1 = j; }
      }
      for (let j = 0; j <= n; j++) { if (used[j]) { u[p[j]] += delta; v[j] -= delta; } else minv[j] -= delta; }
      j0 = j1;
    } while (p[j0] !== 0);
    do { const j1 = way[j0]; p[j0] = p[j1]; j0 = j1; } while (j0);
  }
  const slotOf = new Array(n);
  for (let j = 1; j <= n; j++) slotOf[j - 1] = p[j] - 1;   // 자리 j-1 ← 선수 p[j]-1
  return slotOf;
}
// pool: 뛸 선수들의 명단 번호, slots: 대형의 자리들 → 자리 순서대로 정렬된 명단 번호
export function autoOrder(roster, slots, pool, tags) {
  if (!roster || pool.length !== slots.length) return pool;
  const tg = pool.map(ri => tagOfRoster(ri, roster[ri], tags));
  const cost = tg.map(t => slots.map(sl => fitCost(t, sl[0])));
  // 동점일 때 원래 순서를 유지하도록 아주 작은 가중치
  for (let i = 0; i < pool.length; i++) for (let j = 0; j < slots.length; j++) cost[i][j] += Math.abs(i - j) * 0.001;
  const slotOf = hungarian(cost);
  return slotOf.map(i => pool[i]);
}
