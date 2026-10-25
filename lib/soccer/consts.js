// 경기장/물리 상수와 수학 도우미. 엔진과 AI가 함께 씀
// 1 엔진 단위 ≈ 0.06 m (경기장 가로 2000 ≈ 120 m)
export const W = 2400, H = 1536;
export const GOAL_HALF = 80, GOAL_DEPTH = 34, CROSSBAR = 70;
export const BOX_DEPTH = 330, BOX_HALF = 380, SIX_DEPTH = 110, SIX_HALF = 165;
export const PEN_SPOT = 215, CIRCLE_R = 170, POST_R = 4;
export const PR = 12, BR = 6; // 선수 / 공 반지름

// ===== 물리 =====
export const DRAG = 1.1, AIR_DRAG = 0.35, GRAVITY = 900;
export const BASE_SPEED = 140, SPRINT_MUL = 1.42;
export const TACKLE_SPEED = { stand: 220, slide: 320, dive: 285 };
export const TACKLE_TIME = { stand: 0.18, slide: 0.38, dive: 0.38 };
export const TACKLE_RECOVER = { stand: 0.12, slide: 0.45, dive: 0.5 };

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const dist = (ax, ay, bx, by) => Math.hypot(ax - bx, ay - by);
export function randn() {
  let u = 0, v = 0;
  while (!u) u = Math.random();
  while (!v) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
export function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy || 1;
  const t = clamp(((px - ax) * dx + (py - ay) * dy) / l2, 0, 1);
  return Math.hypot(px - ax - dx * t, py - ay - dy * t);
}
// 선분 위에서 점에 가장 가까운 위치(0~1)
export function segParam(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy || 1;
  return clamp(((px - ax) * dx + (py - ay) * dy) / l2, 0, 1);
}
export function rotate(x, y, a) {
  const c = Math.cos(a), s = Math.sin(a);
  return [x * c - y * s, x * s + y * c];
}
// 문자열 → 0~1 고정 난수 (같은 선수는 항상 같은 값)
export function hash01(str, salt = 0) {
  let h = 2166136261 ^ salt;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  h ^= h >>> 15; h = Math.imul(h, 2246822519); h ^= h >>> 13;
  return ((h >>> 0) % 100000) / 100000;
}
