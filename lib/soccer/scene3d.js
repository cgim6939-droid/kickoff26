// three.js 3D 렌더러: 엔진의 2D 좌표(x, y)와 공 높이(z)를 3D 공간(X, Z, Y)으로 옮겨 그림
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { Sky } from 'three/addons/objects/Sky.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { Soccer } from './engine';
import { resolveLook } from './looks';
import photoSkin from './photoSkin.json';
import { hash01 } from './consts';

const { W, H, GOAL_HALF, GOAL_DEPTH, CROSSBAR, BOX_DEPTH, BOX_HALF, SIX_DEPTH, SIX_HALF,
        PEN_SPOT, CIRCLE_R } = Soccer;

const S = 0.1;              // 엔진 단위 → 3D 단위 (가로/세로)
const VZ = 0.063;           // 엔진 높이 → 3D 높이 (골대 비율을 실제처럼 보이게)
const toX = x => (x - W / 2) * S;
const toZ = y => (y - H / 2) * S;
const dist2 = (a, b) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
const BALL_R = 0.36;
const PLAYER_H = 3.0;
const GOAL_H = CROSSBAR * VZ;
const MODEL_URL = '/models/player.glb';
const MODEL_LOW_URL = '/models/player_low.glb';      // 가벼운 모델 (그래픽 '보통/낮음'에서 사용, 삼각형 약 40%)
const META_URL = '/models/player_meta.json';
const MODEL_H = 1.756;   // Blender에서 만든 선수 모델 키(m)
// 다른 동작 위에 덮어쓰는 동작 / 덧씌우는 동작 / 한 번만 재생하는 동작
const OVERRIDES = ['pass', 'volley', 'chest_trap', 'dejected', 'hips', 'gk_punt', 'fall', 'stumble', 'gk_catch', 'gk_jump', 'gk_low', 'gk_throw', 'kick', 'slide', 'tackle', 'dive_R', 'dive_L', 'celebrate', 'celebrate_pump', 'celebrate_slide', 'throw_in', 'gk_hold', 'gk_ready', 'header', 'feint'];
const ADDITIVE = ['touch_R', 'touch_L', 'charge'];
const ONE_SHOT = ['pass', 'volley', 'chest_trap', 'gk_punt', 'fall', 'stumble', 'gk_catch', 'gk_jump', 'gk_low', 'gk_throw', 'kick', 'slide', 'tackle', 'dive_R', 'dive_L', 'touch_R', 'touch_L', 'header', 'feint', 'celebrate_slide'];

export const P_COLORS = ['#38bdf8', '#f472b6'];

const CAMERAS = {
  broadcast: { name: '중계 시점', up: 23, back: 37, fov: 30 },
  close: { name: '근접 시점', up: 17, back: 29, fov: 34 },
  wide: { name: '전체 시점', up: 62, back: 82, fov: 36 },
};
const CAMERA_ORDER = ['broadcast', 'close', 'wide'];

// 시간대별 조명
const TOD = {
  day: {
    sun: [52, 205], sunColor: 0xfff1dc, sunI: 3.0, hemi: [0xd6e8ff, 0x4a6b3a, 0.8],
    exposure: 0.62, sky: { turbidity: 5, rayleigh: 1.2, mie: 0.004, mieG: 0.8 },
    env: 0.55, lamp: 0.4, bloom: 0.08, glow: 0.1, fog: [0xb8d0e6, 300, 900],
  },
  sunset: {
    sun: [8, 240], sunColor: 0xffb47a, sunI: 3.2, hemi: [0xffd2ae, 0x3a442a, 0.75],
    exposure: 0.55, sky: { turbidity: 9, rayleigh: 2.6, mie: 0.006, mieG: 0.86 },
    env: 0.6, lamp: 1.6, bloom: 0.15, glow: 0.5, fog: [0xd79a72, 320, 950],
  },
  night: {
    sun: [68, 160], sunColor: 0xf3f6ff, sunI: 2.8, hemi: [0x7f93c0, 0x1b2a1b, 0.55],
    exposure: 1.0, sky: null,
    env: 0.3, lamp: 4.0, bloom: 0.4, glow: 0.9, fog: [0x0b1222, 280, 900],
  },
};

// composer: 빛 번짐(블룸) 후처리를 쓰는지. 쓰지 않으면 화면에 바로 그려서 훨씬 가벼움
const QUALITY = {
  ultra: { pr: 1.5, shadow: 2048, shadows: true, bloom: true, composer: true, msaa: 4, aniso: 8 },
  high: { pr: 1.5, shadow: 2048, shadows: true, bloom: false, composer: false, msaa: 0, aniso: 8 },
  medium: { pr: 1.25, shadow: 1536, shadows: true, bloom: false, composer: false, msaa: 0, aniso: 4 },
  low: { pr: 1.0, shadow: 1024, shadows: false, bloom: false, composer: false, msaa: 0, aniso: 2 },
};

function canvasTex(w, h, draw, srgb = true) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// 반복되는 잔디 결 (밝기만 가볍게 흔듦). 노멀맵보다 훨씬 저렴함
function noiseDetailMap(size, blobs) {
  const hgt = new Float32Array(size * size);
  for (let k = 0; k < blobs; k++) {
    const cx = Math.random() * size, cy = Math.random() * size;
    const r = 0.8 + Math.random() * 2.2, a = Math.random() - 0.5;
    for (let y = -5; y <= 5; y++) for (let x = -5; x <= 5; x++) {
      const px = (Math.floor(cx + x) + size) % size, py = (Math.floor(cy + y) + size) % size;
      hgt[py * size + px] += a * Math.exp(-(x * x + y * y) / (r * r));
    }
  }
  let lo = 1e9, hi = -1e9;
  for (const v of hgt) { if (v < lo) lo = v; if (v > hi) hi = v; }
  const c = document.createElement('canvas'); c.width = c.height = size;
  const g = c.getContext('2d'), img = g.createImageData(size, size);
  for (let i = 0; i < size * size; i++) {
    const v = Math.round((hgt[i] - lo) / (hi - lo || 1) * 255);
    img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v; img.data[i * 4 + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

// ===== 유니폼: 재질 슬롯(Skin/Jersey/Shorts/Socks/Boots/Hair/Trim/Gloves/Eyes)별로 색을 넣고,
//       상의(Jersey)에만 모델 기본 자세의 좌표로 줄무늬/띠/번호/엠블럼을 그림 =====
const JERSEY_GLSL = /* glsl */`
varying vec3 vBind;
uniform vec3 uJersey2; uniform vec3 uSleeve; uniform vec3 uTrim; uniform float uPattern;
uniform sampler2D uCrest; uniform float uHasCrest; uniform sampler2D uNum;
vec3 jerseyColor(vec3 p, vec3 base) {
  float ax = abs(p.x);
  vec3 c = base;
  if (uPattern > 4.5 && ax > 0.215) c = uSleeve;                                   // 소매 색이 다른 유니폼
  if (uPattern > 0.5 && uPattern < 1.5 && mod(floor((p.x + 0.5) / 0.075), 2.0) > 0.5) c = uJersey2; // 세로 줄무늬
  if (uPattern > 1.5 && uPattern < 2.5 && ax < 0.055) c = uJersey2;                // 가운데 띠
  if (uPattern > 2.5 && uPattern < 3.5 && p.y > 1.20 && p.y < 1.31 && p.z > 0.0 && ax < 0.215) c = uJersey2; // 가슴 가로 띠
  if (uPattern > 3.5 && uPattern < 4.5 && (p.y - 1.2) < -p.x * 1.3) c = uJersey2;  // 대각선 반반
  if (uHasCrest > 0.5 && p.z > 0.06 && p.x > 0.04 && p.x < 0.145 && p.y > 1.24 && p.y < 1.355) {   // 가슴 엠블럼
    vec2 ts = vec2(textureSize(uCrest, 0));
    float asp = ts.x / max(ts.y, 1.0);
    vec2 uv = vec2((p.x - 0.04) / 0.105, (p.y - 1.24) / 0.115) - 0.5;
    if (asp < 1.0) uv.x /= asp; else uv.y *= asp;
    uv += 0.5;
    if (uv.x > 0.0 && uv.x < 1.0 && uv.y > 0.0 && uv.y < 1.0) {
      vec4 cr = texture2D(uCrest, uv);
      if (cr.a > 0.4) c = cr.rgb;
    }
  }
  if (p.z < -0.07 && ax < 0.13 && p.y > 1.11 && p.y < 1.39) {                      // 등번호
    vec2 uv = vec2((0.13 - p.x) / 0.26, (p.y - 1.11) / 0.28);
    c = mix(c, uTrim, texture2D(uNum, uv).a);
  }
  return c;
}
`;

// 재질 슬롯 이름 → 번호. 모델 정점마다 slot 속성이 있고, 색은 팔레트에서 고름
const SLOT_NAMES = ['Skin', 'Jersey', 'Shorts', 'Socks', 'Boots', 'Hair', 'Trim', 'Gloves', 'Eyes', 'Sclera', 'Lips', 'Brow', 'Beard', 'Teeth'];
const SLOT_ROUGH = { Skin: 0.62, Jersey: 0.72, Shorts: 0.75, Socks: 0.85, Boots: 0.35, Hair: 0.8, Trim: 0.72, Gloves: 0.6,
                     Eyes: 0.15, Sclera: 0.3, Lips: 0.5, Brow: 0.85, Beard: 0.9, Teeth: 0.4 };
const slotIndex = name => { const i = SLOT_NAMES.indexOf(name); return i < 0 ? 0 : i; };

// 선수 1명 = 재질 1개 (그리기 호출 9번 → 1번). 유니폼 무늬/번호/엠블럼은 슬롯 1(Jersey)에만 적용
function makePlayerMaterial(c, numTex) {
  const skin = new THREE.Color(c.skin), hair = new THREE.Color(c.hair);
  const pal = {
    Skin: skin, Jersey: new THREE.Color(c.jersey), Shorts: new THREE.Color(c.shorts), Socks: new THREE.Color(c.socks),
    Boots: new THREE.Color(c.boots), Hair: hair, Trim: new THREE.Color(c.trim), Gloves: new THREE.Color(c.glove),
    Eyes: new THREE.Color(c.eye || '#1a1410'), Sclera: new THREE.Color('#f1efe9'),
    Lips: skin.clone().lerp(new THREE.Color('#8c2f3a'), 0.38).multiplyScalar(0.92),
    Brow: hair.clone().multiplyScalar(0.8),
    Beard: c.beardStyle === 'stubble' ? skin.clone().lerp(hair, 0.5).multiplyScalar(0.9) : hair.clone().multiplyScalar(0.92),
    Teeth: new THREE.Color('#e9e6dc'),
  };
  const U = v => ({ value: new THREE.Color(v) });
  const uniforms = {
    uPal: { value: SLOT_NAMES.map(n => pal[n]) }, uRough: { value: new Float32Array(SLOT_NAMES.map(n => SLOT_ROUGH[n])) },
    uJersey2: U(c.jersey2 || c.jersey), uSleeve: U(c.sleeve || c.jersey), uTrim: U(c.trim),
    uPattern: { value: c.pattern || 0 }, uCrest: { value: null }, uHasCrest: { value: 0 }, uNum: { value: numTex },
  };
  const m = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.7, metalness: 0 });
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float slot;\nvarying float vSlot;\nvarying vec3 vBind;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvSlot = slot; vBind = position;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vSlot;\nuniform vec3 uPal[14];\nuniform float uRough[14];\n' + JERSEY_GLSL)
      .replace('#include <color_fragment>', '#include <color_fragment>\nint si = int(vSlot + 0.5);\nvec3 slotCol = uPal[si];\nif (si == 1) slotCol = jerseyColor(vBind, slotCol);\ndiffuseColor.rgb = slotCol;')
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = uRough[si];');
  };
  m.customProgramCacheKey = () => 'soccer-player-palette-v1';
  m.userData.kit = uniforms;
  return m;
}

// 조각(SkinnedMesh)들을 하나의 지오메트리로 합침. 정점마다 슬롯 번호를 달아 둠
function mergeSkinnedParts(parts) {
  const geos = parts.map(m => {
    const g = m.geometry.clone();
    const n = g.attributes.position.count;
    g.setAttribute('slot', new THREE.BufferAttribute(new Float32Array(n).fill(slotIndex(m.material.name)), 1));
    for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'skinIndex', 'skinWeight', 'slot'].includes(k)) g.deleteAttribute(k);
    // 조각마다 뼈대 번호/가중치 자료형이 달라도 합칠 수 있게 통일
    g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(Array.from(g.attributes.skinIndex.array), 4));
    g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(Array.from(g.attributes.skinWeight.array), 4));
    if (!g.attributes.normal) g.computeVertexNormals();
    return g;
  });
  return mergeGeometries(geos, false);
}

// 선수마다 얼굴 생김새를 다르게: 합쳐진 메시의 머리 부분 꼭짓점을 직접 옮김
// (좌표: y 위, z 앞. 턱 1.572 / 눈 1.695 / 정수리 1.808). f의 값은 모두 -1~1
const gauss = (v, mu, sd) => Math.exp(-(((v - mu) / sd) ** 2));
const sstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
function deformFace(geo, f) {
  const P = geo.attributes.position, S = geo.attributes.slot, a = P.array;
  const EYES = SLOT_NAMES.indexOf('Eyes'), SCL = SLOT_NAMES.indexOf('Sclera'), BROW = SLOT_NAMES.indexOf('Brow'), LIPS = SLOT_NAMES.indexOf('Lips');
  const JERSEY = SLOT_NAMES.indexOf('Jersey'), TRIM = SLOT_NAMES.indexOf('Trim');
  for (let i = 0; i < P.count; i++) {
    let x = a[i * 3], y = a[i * 3 + 1], z = a[i * 3 + 2];
    if (y < 1.5 || Math.abs(x) > 0.11 || z < -0.13) continue;
    const sl = S.array[i];
    if (sl === JERSEY || sl === TRIM) continue;
    const front = sstep(0.0, 0.07, z), sx = x < 0 ? -1 : 1, ax = Math.abs(x);
    // 얼굴 길이(눈 아래)와 이마 높이(눈 위)
    const wN = sstep(1.53, 1.575, y);
    if (y < 1.695) y = 1.695 + (y - 1.695) * (1 + f.len * 0.07 * wN); else y = 1.695 + (y - 1.695) * (1 + f.top * 0.05);
    // 턱선: 아래로 갈수록 넓거나 좁게, 턱 끝은 앞으로/뒤로
    const wJ = sstep(1.68, 1.585, y);
    x *= 1 + f.jaw * 0.12 * wJ + f.cheek * 0.07 * gauss(y, 1.665, 0.03);
    z += f.chin * 0.009 * gauss(y, 1.585, 0.02) * front;
    // 코: 크기(앞으로) / 넓이 / 길이
    const nz = gauss(ax, 0, 0.02 + 0.006 * f.nw) * gauss(y, 1.648 - f.nl * 0.004, 0.024);
    z += f.nose * 0.011 * nz * front;
    x += sx * f.nw * 0.0035 * gauss(y, 1.64, 0.016) * front;
    // 눈 / 눈썹 / 입
    if (sl === EYES || sl === SCL) {
      const cx = sx * 0.0285, cy = 1.695, k = 1 + f.eyeSz * 0.22;
      x = cx + (x - cx) * k + sx * f.eyeSp * 0.0045; y = cy + (y - cy) * k + f.tilt * 0.0025 * (ax / 0.03);
      z += f.nose * 0.0;
    } else if (sl === BROW) {
      const cy = 1.719, k = 1 + f.browT * 0.4;
      y = cy + (y - cy) * k + f.browH * 0.006 + f.tilt * 0.003 * (ax / 0.04) * -0.5;
      x += sx * f.eyeSp * 0.0045;
    } else if (sl === LIPS) {
      const cy = 1.624;
      x *= 1 + f.lipW * 0.2; y = cy + (y - cy) * (1 + f.lipF * 0.3); z += f.lipF * 0.0025;
    }
    a[i * 3] = x; a[i * 3 + 1] = y; a[i * 3 + 2] = z;
  }
  P.needsUpdate = true;
  return geo;
}

// 진짜 축구공 모양: 깎은 정이십면체 (오각형 12 + 육각형 20). 패널마다 살짝 볼록하고 이음매가 파여 있어요
function buildBallGeometry(R) {
  const phi = (1 + Math.sqrt(5)) / 2;
  const base = [];
  for (const a of [-1, 1]) for (const b of [-phi, phi]) base.push(new THREE.Vector3(0, a, b), new THREE.Vector3(a, b, 0), new THREE.Vector3(b, 0, a));
  base.forEach(v => v.normalize());
  const edgeLen = base[0].distanceTo(base.slice(1).sort((p, q) => p.distanceTo(base[0]) - q.distanceTo(base[0]))[0]);
  const adj = base.map((v, i) => base.map((w, j) => (j !== i && v.distanceTo(w) < edgeLen * 1.01 ? j : -1)).filter(j => j >= 0));
  const third = (i, j) => base[i].clone().lerp(base[j], 1 / 3);
  const polys = [];
  // 오각형: 꼭짓점마다 이웃 5개 방향으로 1/3 지점
  base.forEach((v, i) => {
    const nb = adj[i].slice().sort((a, b) => {
      const ref = new THREE.Vector3().subVectors(base[adj[i][0]], v);
      const ang = (j) => { const d = new THREE.Vector3().subVectors(base[j], v); const c = ref.clone().cross(d); return Math.atan2(c.dot(v), ref.dot(d)); };
      return ang(a) - ang(b);
    });
    polys.push({ pts: nb.map(j => third(i, j)), pent: true });
  });
  // 육각형: 삼각형 면(꼭짓점 3개가 서로 이웃)마다 각 변의 1/3, 2/3 지점
  for (let a = 0; a < 12; a++) for (const b of adj[a]) for (const c of adj[b]) {
    if (a < b && b < c && adj[a].includes(c)) {
      polys.push({ pts: [third(a, b), third(b, a), third(b, c), third(c, b), third(c, a), third(a, c)], pent: false });
    }
  }
  const pos = [], col = [];
  const N = 5;
  const DARK = new THREE.Color('#0b1220'), PEARL = new THREE.Color('#ffffff'), SEAM = new THREE.Color('#2a3140'), ACC = new THREE.Color('#00ff85');
  for (const poly of polys) {
    const c = new THREE.Vector3();
    poly.pts.forEach(p => c.add(p)); c.normalize();
    const n = poly.pts.length;
    const vtx = (t, edgeI, u) => {
      // t: 중심(0) → 가장자리(1), u: 변 위치 0~1
      const e0 = poly.pts[edgeI], e1 = poly.pts[(edgeI + 1) % n];
      const edgePt = e0.clone().lerp(e1, u);
      const p = c.clone().lerp(edgePt, t).normalize();
      // 볼록한 패널 + 이음매 홈
      const bulge = 1 + 0.018 * (1 - t * t) - 0.02 * Math.pow(t, 6);
      const color = poly.pent
        ? (t > 0.84 && t < 0.93 ? ACC : t > 0.93 ? SEAM : DARK)
        : (t > 0.93 ? SEAM : PEARL);
      return { p: p.multiplyScalar(R * bulge), color };
    };
    for (let e = 0; e < n; e++) {
      for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
        const t0 = i / N, t1 = (i + 1) / N, u0 = j / N, u1 = (j + 1) / N;
        const A = vtx(t0, e, u0), B = vtx(t1, e, u0), C = vtx(t1, e, u1), D = vtx(t0, e, u1);
        for (const q of (i === 0 ? [[A, B, C]] : [[A, B, C], [A, C, D]])) for (const v of q) { pos.push(v.p.x, v.p.y, v.p.z); col.push(v.color.r, v.color.g, v.color.b); }
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  // 둥근 공처럼 부드럽게 (위치 방향 = 법선), 패널 느낌은 색과 이음매 홈으로
  const nrm = new Float32Array(pos.length);
  for (let i = 0; i < pos.length; i += 3) { const l = Math.hypot(pos[i], pos[i + 1], pos[i + 2]) || 1; nrm[i] = pos[i] / l; nrm[i + 1] = pos[i + 1] / l; nrm[i + 2] = pos[i + 2] / l; }
  g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  return g;
}

function numberTexture(num) {
  return canvasTex(128, 128, (g, w, h) => {
    g.clearRect(0, 0, w, h);
    g.fillStyle = '#fff';
    g.font = '900 100px "Arial Black", system-ui, sans-serif';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(String(num), w / 2, h / 2 + 6);
  });
}

export class Scene3D {
  constructor(canvas) {
    const r = this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFShadowMap;
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.toneMapping = THREE.ACESFilmicToneMapping;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(30, 1, 0.5, 6000);
    this._fo = new THREE.Vector3();
    this.camMode = 'broadcast';
    this.camTarget = new THREE.Vector3();
    this.camPos = new THREE.Vector3(0, 30, 48);
    this.width = 1; this.height = 1;
    this.clock = 0;
    this.excite = 0;
    this.pmrem = new THREE.PMREMGenerator(r);

    this.buildLights();
    this.buildSky();
    this.buildPitch();
    this.buildGoals();
    this.buildStadium();
    this.buildBall();
    this.buildMarkers();
    this.buildWeather();
    this.buildComposer();

    this.players = [];
    this.game = null;
    this.prevKicker = null;
    this.models = {};                  // { full, low }
    this.lod = 'low';
    this.quality = null;
    this.resScale = 1;
    this.setQuality('medium');
    this.setTimeOfDay('sunset');
    this.loadModel();
  }

  // ================= 조명 / 하늘 =================
  buildLights() {
    this.hemi = new THREE.HemisphereLight(0xffffff, 0x445533, 0.8);
    this.sun = new THREE.DirectionalLight(0xffffff, 3);
    this.sun.castShadow = true;
    const sc = this.sun.shadow.camera;
    sc.left = -95; sc.right = 95; sc.top = 75; sc.bottom = -75; sc.near = 1; sc.far = 600;
    this.sun.shadow.bias = -0.0002;
    this.sun.shadow.normalBias = 0.02;
    this.scene.add(this.hemi, this.sun, this.sun.target);
  }

  buildSky() {
    this.sky = new Sky();
    this.sky.scale.setScalar(5000);
    this.scene.add(this.sky);
    this.nightBg = canvasTex(8, 512, (g, w, h) => {
      const gr = g.createLinearGradient(0, 0, 0, h);
      gr.addColorStop(0, '#02050d'); gr.addColorStop(0.6, '#0b1630'); gr.addColorStop(1, '#1d2d4f');
      g.fillStyle = gr; g.fillRect(0, 0, w, h);
    });
  }

  setTimeOfDay(key) {
    if (this.tod === key) return;
    this.tod = key;
    this.applyEnv();
  }

  setWeather(w) {
    if (this.weather === w) return;
    this.weather = w;
    this.rain.visible = w === 'rain';
    this.snow.visible = w === 'snow';
    this.applyEnv();
  }

  // 시간대 + 날씨를 합쳐 조명/하늘/안개를 정함
  applyEnv() {
    const t = TOD[this.tod] || TOD.sunset;
    const wx = this.weather || 'clear';
    const cloudy = wx !== 'clear';
    const elev = THREE.MathUtils.degToRad(t.sun[0]), az = THREE.MathUtils.degToRad(t.sun[1]);
    const dir = new THREE.Vector3().setFromSphericalCoords(1, Math.PI / 2 - elev, az);
    // 그림자가 너무 길어지지 않도록 그림자용 빛은 최소 25도 높이에서 비춤
    const sdir = new THREE.Vector3().setFromSphericalCoords(1, Math.PI / 2 - Math.max(elev, 0.44), az);
    this.sunDir = sdir.clone();
    this.sun.position.copy(sdir).multiplyScalar(220);
    this.sun.color.set(cloudy && this.tod !== 'night' ? 0xdfe6ee : t.sunColor);
    this.sun.intensity = t.sunI * (wx === 'rain' ? 0.45 : wx === 'snow' ? 0.6 : 1);
    this.hemi.color.set(cloudy ? 0xc9d3de : t.hemi[0]); this.hemi.groundColor.set(t.hemi[1]);
    this.hemi.intensity = t.hemi[2] * (cloudy ? 1.15 : 1);
    this.renderer.toneMappingExposure = t.exposure * (wx === 'rain' ? 0.95 : 1);
    const fogColor = !cloudy ? t.fog[0] : this.tod === 'night' ? 0x101722 : wx === 'snow' ? 0xc8d2dc : 0x707b88;
    this.scene.fog = new THREE.Fog(fogColor, cloudy ? 140 : t.fog[1], cloudy ? 520 : t.fog[2]);
    if (this.envRT) this.envRT.dispose();
    if (t.sky && !cloudy) {
      const u = this.sky.material.uniforms;
      u.turbidity.value = t.sky.turbidity; u.rayleigh.value = t.sky.rayleigh;
      u.mieCoefficient.value = t.sky.mie; u.mieDirectionalG.value = t.sky.mieG;
      u.sunPosition.value.copy(dir);
      this.sky.visible = true;
      this.scene.background = null;
      const envScene = new THREE.Scene();
      const sky2 = new Sky(); sky2.scale.setScalar(5000);
      Object.keys(u).forEach(k => { if (sky2.material.uniforms[k]) sky2.material.uniforms[k].value = u[k].value; });
      envScene.add(sky2);
      this.envRT = this.pmrem.fromScene(envScene);
    } else {
      this.sky.visible = false;
      this.scene.background = this.tod === 'night' ? this.nightBg : wx === 'snow' ? this.snowBg : this.overcastBg;
      this.envRT = this.pmrem.fromScene(new RoomEnvironment(), 0.04);
    }
    this.scene.environment = this.envRT.texture;
    this.scene.environmentIntensity = t.env * (cloudy ? 1.3 : 1);
    for (const m of this.lampMats || []) m.emissiveIntensity = Math.max(t.lamp, cloudy ? 2.2 : 0);
    if (this.bloom) this.bloom.strength = t.bloom + (cloudy ? 0.1 : 0);
    if (this.glowMat) this.glowMat.opacity = t.glow * (cloudy ? 1.25 : 1);
    // 비 오면 잔디가 젖어 반짝이고, 눈 오면 하얗게
    if (this.pitchMat) {
      this.pitchMat.roughness = wx === 'rain' ? 0.5 : 0.9;
      this.pitchMat.envMapIntensity = wx === 'rain' ? 1.1 : 0.35;
      this.pitchMat.color.set(wx === 'snow' ? 0xdfe9ef : 0xffffff);
    }
  }

  buildWeather() {
    // 비: 짧은 선분, 눈: 둥근 점. 경기장 전체를 덮는 상자 안에서 떨어짐
    const N = 7000;
    this.rainData = new Float32Array(N * 3);
    const rp = new Float32Array(N * 6);
    for (let i = 0; i < N; i++) {
      this.rainData[i * 3] = (Math.random() - 0.5) * 200;
      this.rainData[i * 3 + 1] = Math.random() * 60;
      this.rainData[i * 3 + 2] = (Math.random() - 0.5) * 150;
    }
    const rg = new THREE.BufferGeometry();
    rg.setAttribute('position', new THREE.BufferAttribute(rp, 3));
    this.rain = new THREE.LineSegments(rg, new THREE.LineBasicMaterial({ color: 0xc8d4e4, transparent: true, opacity: 0.42 }));
    this.rain.frustumCulled = false;
    this.rain.visible = false;

    const M = 6000;
    this.snowData = new Float32Array(M * 4);
    const sp = new Float32Array(M * 3);
    for (let i = 0; i < M; i++) {
      this.snowData[i * 4] = (Math.random() - 0.5) * 200;
      this.snowData[i * 4 + 1] = Math.random() * 50;
      this.snowData[i * 4 + 2] = (Math.random() - 0.5) * 150;
      this.snowData[i * 4 + 3] = Math.random() * 6.28;
    }
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.BufferAttribute(sp, 3));
    const flake = canvasTex(32, 32, (g, w, h) => {
      const gr = g.createRadialGradient(16, 16, 0, 16, 16, 16);
      gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = gr; g.fillRect(0, 0, w, h);
    });
    this.snow = new THREE.Points(sg, new THREE.PointsMaterial({ size: 0.65, map: flake, transparent: true, depthWrite: false, color: 0xffffff }));
    this.snow.frustumCulled = false;
    this.snow.visible = false;
    this.scene.add(this.rain, this.snow);

    this.overcastBg = canvasTex(8, 512, (g, w, h) => {
      const gr = g.createLinearGradient(0, 0, 0, h);
      gr.addColorStop(0, '#3b4552'); gr.addColorStop(1, '#8a96a3');
      g.fillStyle = gr; g.fillRect(0, 0, w, h);
    });
    this.snowBg = canvasTex(8, 512, (g, w, h) => {
      const gr = g.createLinearGradient(0, 0, 0, h);
      gr.addColorStop(0, '#9aa6b2'); gr.addColorStop(1, '#dde4ea');
      g.fillStyle = gr; g.fillRect(0, 0, w, h);
    });
  }

  animateWeather(dt) {
    if (this.rain.visible) {
      const d = this.rainData, pos = this.rain.geometry.attributes.position.array;
      const n = d.length / 3, vy = -60, vx = 6;
      for (let i = 0; i < n; i++) {
        let x = d[i * 3] + vx * dt, y = d[i * 3 + 1] + vy * dt;
        if (y < 0) { y += 60; x = (Math.random() - 0.5) * 200; }
        if (x > 100) x -= 200;
        d[i * 3] = x; d[i * 3 + 1] = y;
        const z = d[i * 3 + 2], o = i * 6;
        pos[o] = x; pos[o + 1] = y; pos[o + 2] = z;
        pos[o + 3] = x - vx * 0.03; pos[o + 4] = y - vy * 0.03; pos[o + 5] = z;
      }
      this.rain.geometry.attributes.position.needsUpdate = true;
    }
    if (this.snow.visible) {
      const d = this.snowData, pos = this.snow.geometry.attributes.position.array;
      const n = d.length / 4, t = this.clock;
      for (let i = 0; i < n; i++) {
        let y = d[i * 4 + 1] - 3.2 * dt;
        if (y < 0) y += 50;
        d[i * 4 + 1] = y;
        pos[i * 3] = d[i * 4] + Math.sin(t * 0.8 + d[i * 4 + 3]) * 1.2;
        pos[i * 3 + 1] = y;
        pos[i * 3 + 2] = d[i * 4 + 2] + Math.cos(t * 0.6 + d[i * 4 + 3]) * 1.2;
      }
      this.snow.geometry.attributes.position.needsUpdate = true;
    }
  }

  setQuality(key) {
    if (this.quality === key) return;
    this.quality = key;
    const q = this.q = QUALITY[key] || QUALITY.medium;
    this.lod = key === 'ultra' || key === 'high' ? 'full' : 'low';
    this.applyCrowdDensity();     // 그래픽에 따라 선수 모델 선택 (다음 경기 시작 때 적용)
    this.useComposer = q.composer;
    this.renderer.shadowMap.enabled = q.shadows;
    this._sf = 1;
    this.sun.shadow.mapSize.set(q.shadow, q.shadow);
    if (this.sun.shadow.map) { this.sun.shadow.map.dispose(); this.sun.shadow.map = null; }
    this.scene.traverse(o => { if (o.material) [].concat(o.material).forEach(m => { m.needsUpdate = true; }); });
    if (this.bloom) this.bloom.enabled = q.bloom;
    for (const rt of [this.composer.renderTarget1, this.composer.renderTarget2]) {
      if (rt && rt.samples !== q.msaa) { rt.samples = q.msaa; rt.dispose(); }
    }
    if (this.pitchTex) { this.pitchTex.anisotropy = Math.min(q.aniso, this.renderer.capabilities.getMaxAnisotropy()); this.pitchTex.needsUpdate = true; }
    for (const m of this.glowMats || []) m.visible = !q.bloom;
    this.applyShadowFrustum();
    this.applyPixelRatio();
  }

  // 화면 해상도 = 품질별 상한 × 화면 배율 × 동적 해상도(렉이 있으면 자동으로 낮춤)
  applyPixelRatio() {
    const q = this.q || QUALITY.medium;
    this.renderer.setPixelRatio(Math.max(0.5, Math.min(q.pr, window.devicePixelRatio || 1) * (this.resScale || 1)));
    this.resize(this.width, this.height);
  }

  setResScale(v) {
    v = Math.max(0.55, Math.min(1, v));
    if (Math.abs(v - this.resScale) < 0.01) return;
    this.resScale = v;
    this.applyPixelRatio();
  }

  // 그림자 범위: 카메라가 보는 곳 주변만 (범위가 좁을수록 같은 해상도로 더 선명함)
  applyShadowFrustum() {
    const sc = this.sun.shadow.camera;
    const m = { broadcast: [78, 56], close: [58, 44], wide: [112, 86] }[this.camMode] || [78, 56];
    sc.left = -m[0]; sc.right = m[0]; sc.top = m[1]; sc.bottom = -m[1];
    sc.updateProjectionMatrix();
  }

  render() {
    if (this.useComposer) this.composer.render();
    else this.renderer.render(this.scene, this.camera);
  }

  buildComposer() {
    const rt = new THREE.WebGLRenderTarget(1, 1, { samples: 2, type: THREE.HalfFloatType });
    this.composer = new EffectComposer(this.renderer, rt);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.3, 0.45, 0.97);
    const bloomSetSize = this.bloom.setSize.bind(this.bloom);
    this.bloom.setSize = (w, h) => bloomSetSize(Math.max(2, w >> 1), Math.max(2, h >> 1));
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
  }

  // ================= 경기장 =================
  buildPitch() {
    const mx = 260, my = 200;
    const tw = 2560, k = tw / (W + mx * 2), th = Math.round((H + my * 2) * k);
    const tex = canvasTex(tw, th, (g) => {
      g.fillStyle = '#2e6b2a'; g.fillRect(0, 0, tw, th);
      g.save();
      g.scale(k, k); g.translate(mx, my);
      // 잔디 깎은 무늬 (세로 줄 + 옅은 가로 줄)
      const stripe = W / 16;
      for (let i = -5; i < 21; i++) {
        g.fillStyle = i % 2 ? '#3f8a35' : '#377d2e';
        g.fillRect(i * stripe, -my, stripe, H + my * 2);
      }
      for (let j = -3; j < 14; j++) {
        if (j % 2) continue;
        g.fillStyle = 'rgba(255,255,255,0.025)';
        g.fillRect(-mx, j * (H / 10), W + mx * 2, H / 10);
      }
      // 큰 얼룩 (색 변화)
      for (let i = 0; i < 260; i++) {
        const x = Math.random() * (W + mx * 2) - mx, y = Math.random() * (H + my * 2) - my;
        const r = 30 + Math.random() * 90;
        const gr = g.createRadialGradient(x, y, 0, x, y, r);
        const dark = Math.random() < 0.5;
        gr.addColorStop(0, dark ? 'rgba(20,50,10,0.10)' : 'rgba(140,190,90,0.07)');
        gr.addColorStop(1, 'rgba(0,0,0,0)');
        g.fillStyle = gr; g.fillRect(x - r, y - r, r * 2, r * 2);
      }
      // 잔디 결
      for (let i = 0; i < 60000; i++) {
        const x = Math.random() * (W + mx * 2) - mx, y = Math.random() * (H + my * 2) - my;
        g.fillStyle = Math.random() < 0.5 ? 'rgba(0,25,0,0.07)' : 'rgba(200,255,160,0.045)';
        g.fillRect(x, y, 1 + Math.random() * 2.2, 0.6 + Math.random() * 0.8);
      }
      // 골문 앞 닳은 잔디
      for (const gx of [0, W]) {
        for (let i = 0; i < 40; i++) {
          const x = gx + (gx ? -1 : 1) * Math.random() * 60, y = H / 2 + (Math.random() - 0.5) * 140;
          const r = 8 + Math.random() * 22;
          const gr = g.createRadialGradient(x, y, 0, x, y, r);
          gr.addColorStop(0, 'rgba(120,100,60,0.22)'); gr.addColorStop(1, 'rgba(120,100,60,0)');
          g.fillStyle = gr; g.fillRect(x - r, y - r, r * 2, r * 2);
        }
      }
      // 라인
      g.strokeStyle = 'rgba(250,250,245,0.93)'; g.lineWidth = 4;
      g.strokeRect(0, 0, W, H);
      g.beginPath(); g.moveTo(W / 2, 0); g.lineTo(W / 2, H); g.stroke();
      g.beginPath(); g.arc(W / 2, H / 2, CIRCLE_R, 0, Math.PI * 2); g.stroke();
      const dot = (x, y, r) => { g.fillStyle = 'rgba(250,250,245,0.95)'; g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill(); };
      dot(W / 2, H / 2, 5);
      for (const side of [0, 1]) {
        const x0 = side ? W : 0;
        g.strokeRect(side ? W - BOX_DEPTH : 0, H / 2 - BOX_HALF, BOX_DEPTH, BOX_HALF * 2);
        g.strokeRect(side ? W - SIX_DEPTH : 0, H / 2 - SIX_HALF, SIX_DEPTH, SIX_HALF * 2);
        const px = side ? W - PEN_SPOT : PEN_SPOT;
        dot(px, H / 2, 4);
        const rr = CIRCLE_R, a = Math.acos(Math.min(1, (BOX_DEPTH - PEN_SPOT) / rr));
        g.beginPath();
        if (side) g.arc(px, H / 2, rr, Math.PI - a, Math.PI + a); else g.arc(px, H / 2, rr, -a, a);
        g.stroke();
        for (const cy of [0, H]) {
          const st = side ? (cy ? Math.PI : Math.PI / 2) : (cy ? -Math.PI / 2 : 0);
          g.beginPath(); g.arc(x0, cy, 14, st, st + Math.PI / 2); g.stroke();
        }
      }
      g.restore();
    });
    tex.anisotropy = 4;
    this.pitchTex = tex;
    const detail = noiseDetailMap(256, 2600);
    detail.anisotropy = 2;
    const pw = (W + mx * 2) * S, ph = (H + my * 2) * S;
    // 램버트(빛 계산이 단순) + 반복 디테일 맵. 큰 노멀맵을 쓰던 때보다 프레임당 수 ms 빠름
    const mat = new THREE.MeshLambertMaterial({ map: tex });
    const detailU = { uDetail: { value: detail }, uDetailRep: { value: new THREE.Vector2(pw / 3.5, ph / 3.5) } };
    mat.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, detailU);
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform sampler2D uDetail;\nuniform vec2 uDetailRep;')
        .replace('#include <map_fragment>', '#include <map_fragment>\ndiffuseColor.rgb *= 0.8 + 0.4 * texture2D(uDetail, vMapUv * uDetailRep).r;');
    };
    mat.customProgramCacheKey = () => 'pitch-detail-v1';
    this.pitchMat = mat;
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(pw, ph), mat);
    mesh.rotation.x = -Math.PI / 2;
    mesh.receiveShadow = true;
    this.scene.add(mesh);

    // 경기장 바깥 바닥
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(2000, 2000),
      new THREE.MeshLambertMaterial({ color: 0x2b3238 }));
    ground.rotation.x = -Math.PI / 2; ground.position.y = -0.05;
    ground.receiveShadow = true;
    this.scene.add(ground);

    // 코너 깃발
    const poleGeo = new THREE.CylinderGeometry(0.05, 0.05, 2.4, 6);
    const poleMat = new THREE.MeshStandardMaterial({ color: 0xffffff });
    const flagMat = new THREE.MeshStandardMaterial({ color: 0xfacc15, side: THREE.DoubleSide });
    this.flags = [];
    for (const x of [0, W]) for (const y of [0, H]) {
      const pole = new THREE.Mesh(poleGeo, poleMat);
      pole.position.set(toX(x), 1.2, toZ(y)); pole.castShadow = true;
      const flag = new THREE.Mesh(new THREE.PlaneGeometry(0.75, 0.5, 6, 1), flagMat);
      flag.geometry.translate(0.375, 0, 0);
      flag.position.set(toX(x), 2.15, toZ(y));
      this.flags.push(flag);
      this.scene.add(pole, flag);
    }
  }

  // ===== 골대: 상자형 그물 (지붕 → 비스듬한 뒷면), 지지대, 실시간으로 출렁이는 그물 =====
  buildGoals() {
    // 골대 기둥은 너무 번쩍이지 않게 (빛 번짐 방지)
    const postMat = new THREE.MeshStandardMaterial({ color: 0xcfd4da, roughness: 0.6, metalness: 0.05, envMapIntensity: 0.4 });
    const frameMat = new THREE.MeshStandardMaterial({ color: 0xb9c0c8, roughness: 0.5, metalness: 0.3, envMapIntensity: 0.5 });
    // 그물 무늬: 굵은 마름모 그물코 (매듭 점 없음). 가장자리는 부드럽게 처리해 멀리서도 깜빡이지 않게 함
    const netTex = canvasTex(512, 512, (g, w, h) => {
      g.clearRect(0, 0, w, h);
      g.strokeStyle = '#ffffff'; g.lineWidth = 9; g.lineCap = 'butt';
      const p = 128;
      for (let k = -h; k <= w + h; k += p) {
        g.beginPath(); g.moveTo(k, 0); g.lineTo(k + h, h); g.stroke();
        g.beginPath(); g.moveTo(k, h); g.lineTo(k + h, 0); g.stroke();
      }
    });
    netTex.wrapS = netTex.wrapT = THREE.RepeatWrapping;
    netTex.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
    const netMat = new THREE.MeshStandardMaterial({
      map: netTex, alphaToCoverage: true, alphaTest: 0.0, side: THREE.DoubleSide,
      roughness: 1, metalness: 0, color: 0xc4ccd4, envMapIntensity: 0.35,
    });

    const r = 0.13, gw = GOAL_HALF * 2 * S, gd = GOAL_DEPTH * S, H = GOAL_H;
    const rx = gd * 0.55, ry = H * 0.93;           // 지붕 끝(뒤쪽 위) 지점
    const TILE = 2.4;                               // 그물 무늬 한 장 크기 (그물코 약 10cm)
    const up = new THREE.Vector3(0, 1, 0);
    // 두 점을 잇는 원기둥
    const bar = (a, b, rad, mat) => {
      const d = new THREE.Vector3().subVectors(b, a);
      const m = new THREE.Mesh(new THREE.CylinderGeometry(rad, rad, d.length(), 10), mat);
      m.position.copy(a).addScaledVector(d, 0.5);
      m.quaternion.setFromUnitVectors(up, d.normalize());
      m.castShadow = true;
      return m;
    };
    // 매개변수 곡면으로 그물 한 면 생성 (처짐 포함). 출렁임 계산용 데이터도 함께 보관
    const surface = (fn, nu, nv, normal, sag, lenU, lenV) => {
      const count = (nu + 1) * (nv + 1);
      const pos = new Float32Array(count * 3), uv = new Float32Array(count * 2);
      const idx = [];
      for (let j = 0; j <= nv; j++) for (let i = 0; i <= nu; i++) {
        const u = i / nu, v = j / nv, k = j * (nu + 1) + i;
        const p = fn(u, v);
        p.addScaledVector(normal, sag * Math.sin(Math.PI * u) * Math.sin(Math.PI * v));
        pos[k * 3] = p.x; pos[k * 3 + 1] = p.y; pos[k * 3 + 2] = p.z;
        uv[k * 2] = u * lenU / TILE; uv[k * 2 + 1] = v * lenV / TILE;
        if (i < nu && j < nv) idx.push(k, k + 1, k + nu + 1, k + 1, k + nu + 2, k + nu + 1);
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
      geo.setIndex(idx);
      geo.computeVertexNormals();
      const mesh = new THREE.Mesh(geo, netMat);
      mesh.frustumCulled = false;
      return { mesh, base: Float32Array.from(pos), n: normal.clone(), nu, nv,
               off: new Float32Array(count), vel: new Float32Array(count), tmp: new Float32Array(count) };
    };

    this.nets = [];
    for (const side of [0, 1]) {
      const g = new THREE.Group();
      const d = side ? 1 : -1;
      const V = (x, y, z) => new THREE.Vector3(d * x, y, z);
      // 골대 프레임
      for (const z of [-gw / 2, gw / 2]) {
        const post = new THREE.Mesh(new THREE.CylinderGeometry(r, r, H, 16), postMat);
        post.position.set(0, H / 2, z); post.castShadow = true;
        g.add(post);
        g.add(bar(V(0, H, z), V(rx, ry, z), 0.045, frameMat));   // 옆 윗선
        g.add(bar(V(rx, ry, z), V(gd, 0.04, z), 0.055, frameMat)); // 뒤 지지대
        g.add(bar(V(0, 0.04, z), V(gd, 0.04, z), 0.05, frameMat));  // 바닥선
      }
      const cross = new THREE.Mesh(new THREE.CylinderGeometry(r, r, gw + r * 2, 16), postMat);
      cross.rotation.x = Math.PI / 2; cross.position.set(0, H, 0); cross.castShadow = true;
      g.add(cross);
      g.add(bar(V(rx, ry, -gw / 2), V(rx, ry, gw / 2), 0.045, frameMat));  // 지붕 뒤 가로대
      g.add(bar(V(gd, 0.04, -gw / 2), V(gd, 0.04, gw / 2), 0.05, frameMat)); // 바닥 뒤 가로대

      // 그물 면들 (모두 바깥쪽 법선 방향으로 출렁임)
      const backLen = Math.hypot(gd - rx, ry);
      const backN = new THREE.Vector3(d * ry, gd - rx, 0).normalize();
      const nets = [
        surface((u, v) => V(rx * v, H + (ry - H) * v, -gw / 2 + gw * u), 48, 6, new THREE.Vector3(0, 1, 0), -0.12, gw, rx),
        surface((u, v) => V(rx + (gd - rx) * v, ry * (1 - v), -gw / 2 + gw * u), 48, 14, backN, 0.12, gw, backLen),
      ];
      for (const sz of [-1, 1]) {
        const z = sz * gw / 2;
        nets.push(surface((u, v) => {
          const bx = gd * u, by = 0;              // 아래 변: 골라인 → 뒤 바닥
          const tx = rx * u, ty = H + (ry - H) * u; // 위 변: 크로스바 → 지붕 끝
          const x = bx + (tx - bx) * v, y = by + (ty - by) * v;
          // 뒤쪽 비스듬한 변에 맞춰 위쪽 끝을 잘라냄
          return V(Math.min(x, rx + (gd - rx) * (1 - y / ry)), y, z);
        }, 12, 14, new THREE.Vector3(0, 0, sz), 0.08, gd, H));
      }
      for (const n of nets) g.add(n.mesh);
      g.position.x = toX(side ? W : 0);
      this.scene.add(g);
      this.nets.push({ group: g, surfaces: nets, active: true });
    }
  }

  buildStadium() {
    const fw = W * S, fh = H * S;
    // LED 광고판 (흐르는 애니메이션)
    this.adTex = canvasTex(2048, 96, (g, w, h) => {
      const ads = [['KICKOFF SOCCER', '#0b1220', '#22c55e'], ['3D FOOTBALL', '#1d4ed8', '#ffffff'],
                   ['GOAL!', '#b91c1c', '#fde047'], ['NEXT.JS × THREE.JS', '#0b1220', '#38bdf8']];
      const seg = w / ads.length;
      ads.forEach(([txt, bg, fg], i) => {
        const gr = g.createLinearGradient(0, 0, 0, h);
        gr.addColorStop(0, bg); gr.addColorStop(1, '#000');
        g.fillStyle = gr; g.fillRect(i * seg, 0, seg, h);
        g.fillStyle = fg; g.font = 'italic 900 58px system-ui, sans-serif';
        g.textAlign = 'center'; g.textBaseline = 'middle';
        g.fillText(txt, i * seg + seg / 2, h / 2 + 3);
      });
      g.fillStyle = 'rgba(0,0,0,0.25)';
      for (let y = 0; y < h; y += 3) g.fillRect(0, y, w, 1);
    });
    this.adTex.wrapS = THREE.RepeatWrapping;
    this.adTextures = [];
    const boardBack = new THREE.MeshLambertMaterial({ color: 0x111827 });
    const adBoard = (len, x, z, rotY) => {
      const t = this.adTex.clone(); t.needsUpdate = true; t.repeat.set(len / 70, 1);
      this.adTextures.push(t);
      const face = new THREE.MeshBasicMaterial({ map: t, color: new THREE.Color(1.25, 1.25, 1.25) });
      const m = new THREE.Mesh(new THREE.BoxGeometry(len, 1.0, 0.3), [boardBack, boardBack, boardBack, boardBack, face, boardBack]);
      m.position.set(x, 0.5, z); m.rotation.y = rotY;
      this.scene.add(m);
    };
    const off = 7;
    adBoard(fw + 16, 0, -fh / 2 - off, 0);
    adBoard(fw + 16, 0, fh / 2 + off + 4, Math.PI);
    adBoard(fh - 18, -fw / 2 - off - 3, 0, Math.PI / 2);
    adBoard(fh - 18, fw / 2 + off + 3, 0, -Math.PI / 2);

    // 관중석 + 관중
    const seats = [];
    const concrete = new THREE.MeshLambertMaterial({ color: 0x59606a });
    const roofMat = new THREE.MeshLambertMaterial({ color: 0x3a4452, side: THREE.DoubleSide });
    this.lampMats = [];
    const lampMat = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xfff3d6, emissiveIntensity: 2 });
    this.lampMats.push(lampMat);
    const ROWS = 22, STEP_H = 0.62, STEP_D = 1.45, BASE_H = 2.4;
    // 조명 번짐(블룸 대신 쓰는 가벼운 효과)
    this.glowMat = new THREE.SpriteMaterial({
      map: canvasTex(128, 128, (g, w, h) => {
        const gr = g.createRadialGradient(64, 64, 0, 64, 64, 64);
        gr.addColorStop(0, 'rgba(255,244,220,1)'); gr.addColorStop(0.25, 'rgba(255,236,200,0.45)'); gr.addColorStop(1, 'rgba(255,230,190,0)');
        g.fillStyle = gr; g.fillRect(0, 0, w, h);
      }), color: 0xfff1d0, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0.5,
    });
    this.glowMats = [this.glowMat];
    const glowAt = (x, y, z, size) => {
      const sp = new THREE.Sprite(this.glowMat);
      sp.position.set(x, y, z); sp.scale.set(size, size, 1);
      this.scene.add(sp);
    };
    const stand = (len, dist, rotY, seatColor) => {
      const g = new THREE.Group();
      const geos = [];
      for (let i = 0; i < ROWS; i++) {
        const b = new THREE.BoxGeometry(len, STEP_H * (i + 1) + BASE_H, STEP_D);
        b.translate(0, (STEP_H * (i + 1) + BASE_H) / 2, -(i * STEP_D + STEP_D / 2));
        geos.push(b);
      }
      const steps = new THREE.Mesh(mergeGeometries(geos), concrete);
      g.add(steps);
      // 좌석 줄
      const seatGeos = [];
      for (let i = 0; i < ROWS; i++) {
        const b = new THREE.BoxGeometry(len, 0.35, 0.5);
        b.translate(0, STEP_H * (i + 1) + BASE_H + 0.17, -(i * STEP_D + STEP_D * 0.65));
        seatGeos.push(b);
      }
      g.add(new THREE.Mesh(mergeGeometries(seatGeos), new THREE.MeshLambertMaterial({ color: seatColor })));
      // 지붕
      const topY = STEP_H * ROWS + BASE_H;
      const depth = ROWS * STEP_D;
      const roof = new THREE.Mesh(new THREE.BoxGeometry(len + 6, 0.6, depth + 10), roofMat);
      roof.position.set(0, topY + 13, -depth / 2 + 3);
      roof.rotation.x = -0.1;
      g.add(roof);
      const back = new THREE.Mesh(new THREE.BoxGeometry(len, 14, 1), roofMat);
      back.position.set(0, topY + 6, -depth - 0.5);
      g.add(back);
      // 지붕 앞쪽 조명 줄
      const strip = new THREE.Mesh(new THREE.BoxGeometry(len, 0.5, 0.5), lampMat);
      strip.position.set(0, topY + 12.4, 7.6);
      g.add(strip);
      for (let x = -len / 2 + 6; x < len / 2; x += 9) {
        const col = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.4, 13, 8), roofMat);
        col.position.set(x, topY + 6.5, -depth + 1);
        g.add(col);
      }
      g.rotation.y = rotY;
      g.position.set(Math.sin(rotY) * -dist, 0, Math.cos(rotY) * -dist);
      this.scene.add(g);
      g.updateMatrixWorld(true);
      for (let x = -len / 2 + 10; x < len / 2; x += 18) {
        const wp = new THREE.Vector3(x, topY + 12.4, 7.6).applyMatrix4(g.matrixWorld);
        glowAt(wp.x, wp.y, wp.z, 15);
      }
      // 관중 자리
      const v = new THREE.Vector3();
      for (let i = 0; i < ROWS; i++) {
        for (let x = -len / 2 + 0.8; x < len / 2 - 0.8; x += 1.05) {
          if (Math.random() < 0.12) continue;
          v.set(x + (Math.random() - 0.5) * 0.25, STEP_H * (i + 1) + BASE_H + 0.1, -(i * STEP_D + STEP_D * 0.6));
          v.applyMatrix4(g.matrixWorld);
          seats.push({ x: v.x, y: v.y, z: v.z, rot: rotY, ph: Math.random() * 6.28 });
        }
      }
    };
    stand(fw + 46, fh / 2 + 15, 0, 0xb91c1c);
    stand(fh + 30, fw / 2 + 19, Math.PI / 2, 0x1d4ed8);
    stand(fh + 30, fw / 2 + 19, -Math.PI / 2, 0x1d4ed8);
    this.buildCrowd(seats);

    // 조명탑
    const towerMat = new THREE.MeshStandardMaterial({ color: 0x7b8794, metalness: 0.6, roughness: 0.4 });
    const towerLamp = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xfff6dd, emissiveIntensity: 3 });
    this.lampMats.push(towerLamp);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      const x = sx * (fw / 2 + 24), z = sz * (fh / 2 + 30);
      const t = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 1.4, 64, 8), towerMat);
      t.position.set(x, 32, z);
      const panel = new THREE.Group();
      const frame = new THREE.Mesh(new THREE.BoxGeometry(12, 7, 0.6), towerMat);
      panel.add(frame);
      for (let i = 0; i < 4; i++) for (let j = 0; j < 3; j++) {
        const l = new THREE.Mesh(new THREE.BoxGeometry(2.2, 1.6, 0.4), towerLamp);
        l.position.set(-4.5 + i * 3, -2.1 + j * 2.1, 0.4);
        panel.add(l);
      }
      panel.position.set(x, 66, z);
      panel.lookAt(0, 0, 0);
      this.scene.add(t, panel);
      glowAt(x - Math.sign(x) * 2, 65, z - Math.sign(z) * 2, 46);
    }
  }

  buildCrowd(seats) {
    // 자리를 섞어 두면 관중 수를 줄여도(그래픽 보통/낮음) 빈자리가 고르게 생김
    for (let i = seats.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; [seats[i], seats[j]] = [seats[j], seats[i]]; }
    const n = seats.length;
    this.crowdU = { uTime: { value: 0 }, uExcite: { value: 0 } };
    const bodyGeo = new THREE.BoxGeometry(0.62, 0.95, 0.42); bodyGeo.translate(0, 0.48, 0);
    const headGeo = new THREE.SphereGeometry(0.24, 6, 4); headGeo.translate(0, 1.2, 0);
    const phase = new Float32Array(n);
    for (let i = 0; i < n; i++) phase[i] = Math.random() * 6.28;
    bodyGeo.setAttribute('aPhase', new THREE.InstancedBufferAttribute(phase, 1));
    headGeo.setAttribute('aPhase', new THREE.InstancedBufferAttribute(phase, 1));
    const mk = () => {
      const m = new THREE.MeshLambertMaterial();
      m.onBeforeCompile = (sh) => {
        sh.uniforms.uTime = this.crowdU.uTime; sh.uniforms.uExcite = this.crowdU.uExcite;
        sh.vertexShader = sh.vertexShader
          .replace('#include <common>', '#include <common>\nattribute float aPhase;\nuniform float uTime;\nuniform float uExcite;')
          .replace('#include <begin_vertex>', '#include <begin_vertex>\ntransformed.y += abs(sin(uTime * 9.0 + aPhase)) * 0.8 * min(1.0, uExcite * 1.5) * step(0.01, uExcite);');
      };
      m.customProgramCacheKey = () => 'crowd-jump-v1';
      return m;
    };
    this.crowdBody = new THREE.InstancedMesh(bodyGeo, mk(), n);
    this.crowdHead = new THREE.InstancedMesh(headGeo, mk(), n);
    const shirts = ['#dc2626', '#dc2626', '#b91c1c', '#2563eb', '#1d4ed8', '#f8fafc', '#fde047', '#111827', '#16a34a', '#f97316', '#e5e7eb', '#7c3aed'];
    const skins = ['#f1c27d', '#e0ac69', '#c68642', '#8d5524', '#ffdbac'];
    const m = new THREE.Matrix4(), c = new THREE.Color();
    const up = new THREE.Vector3(0, 1, 0), sc = new THREE.Vector3(1, 1, 1), p = new THREE.Vector3();
    seats.forEach((s, i) => {
      s.q = new THREE.Quaternion().setFromAxisAngle(up, s.rot + (Math.random() - 0.5) * 0.4);
      m.compose(p.set(s.x, s.y, s.z), s.q, sc);
      this.crowdBody.setMatrixAt(i, m); this.crowdHead.setMatrixAt(i, m);
      this.crowdBody.setColorAt(i, c.set(shirts[(Math.random() * shirts.length) | 0]));
      this.crowdHead.setColorAt(i, c.set(skins[(Math.random() * skins.length) | 0]));
    });
    this.crowdSeats = seats;
    this.crowdN = n;
    this.applyCrowdDensity();
    this.crowdBody.frustumCulled = this.crowdHead.frustumCulled = false;
    this.scene.add(this.crowdBody, this.crowdHead);
  }

  // 그래픽 단계에 맞춰 보이는 관중 수 (보통 60%, 낮음 40%) — 전체 삼각형의 절반 이상이 관중이라 렉을 크게 줄임
  applyCrowdDensity() {
    if (!this.crowdBody) return;
    const f = { ultra: 1, high: 1, medium: 0.6, low: 0.4 }[this.quality] || 0.6;
    this.crowdBody.count = this.crowdHead.count = Math.floor(this.crowdN * f);
  }

  // 골이 들어가면 관중이 뛰어오름 (위치 계산은 GPU가 함)
  animateCrowd(dt) {
    this.excite = Math.max(0, this.excite - dt * 0.18);
    this.crowdU.uTime.value = this.clock;
    this.crowdU.uExcite.value = this.excite;
  }

  buildBall() {
    this.ball = new THREE.Mesh(buildBallGeometry(BALL_R),
      new THREE.MeshPhysicalMaterial({ vertexColors: true, roughness: 0.32, metalness: 0.05, clearcoat: 0.9, clearcoatRoughness: 0.2, emissive: 0x303a36, emissiveIntensity: 0.5 }));
    this.ball.castShadow = true;
    this.scene.add(this.ball);
  }

  buildMarkers() {
    this.markers = P_COLORS.map(c => {
      const ring = new THREE.Mesh(new THREE.RingGeometry(1.05, 1.35, 40),
        new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: 0.95, depthWrite: false }));
      ring.rotation.x = -Math.PI / 2;
      ring.renderOrder = 2;
      const cone = new THREE.Mesh(new THREE.ConeGeometry(0.38, 0.8, 16), new THREE.MeshBasicMaterial({ color: c }));
      cone.rotation.x = Math.PI;
      ring.visible = cone.visible = false;
      this.scene.add(ring, cone);
      return { ring, cone };
    });
  }

  // ================= 선수 =================
  // 현재 그래픽에 맞는 선수 모델 (없으면 다른 쪽이라도)
  get model() { return this.models[this.lod] || this.models.low || this.models.full || null; }

  loadModel() {
    const metaP = fetch(META_URL).then(r => r.json()).catch(() => ({ clips: {} }));
    const loadOne = (url, kind) => new GLTFLoader().load(url, async (gltf) => {
      const meta = await metaP;
      this.clipMeta = meta.clips || {};
      // 덧씌우는 동작은 기본 자세와의 차이만 남김 (three.js의 Additive 블렌딩용)
      if (!this.additiveClips) {
        this.additiveClips = {};
        for (const n of ADDITIVE) {
          const clip = gltf.animations.find(c => c.name === n);
          if (clip) this.additiveClips[n] = THREE.AnimationUtils.makeClipAdditive(clip.clone(), 0, clip);
        }
      }
      const had = !!this.model;
      this.models[kind] = gltf;
      // 처음 불러온 모델이거나, 지금 쓰려던 쪽이 막 도착했으면 선수를 다시 만듦
      if (this.game && (!had || kind === this.lod)) this.setGame(this.game);
    }, undefined, (err) => {
      console.warn('선수 모델을 불러오지 못했습니다:', url, err);
    });
    loadOne(MODEL_LOW_URL, 'low');
    loadOne(MODEL_URL, 'full');
  }

  setGame(game) {
    for (const v of this.players) {
      this.scene.remove(v.root);
      if (v.mixer) v.mixer.stopAllAction();
    }
    this.players = [];
    this.game = game;
    this.prevKicker = null;
    this.excite = 0; this.crowdDirty = true;
    if (!game) return;
    for (const t of game.teams) {
      for (const p of t.players) {
        this.players.push(this.model ? this.makeSkinnedPlayer(p) : this.makeSimplePlayer(p));
      }
    }
  }

  // 선수 고유 외모 (피부/머리 모양/머리 색/수염). 같은 선수는 언제나 같은 모습
  lookOf(p) {
    if (!p._look) {
      const short = p.team.info.short, ri = p.ri === undefined ? p.idx : p.ri;
      const l = resolveLook(short, ri, p.name || '', p.num);
      const id = short + '_' + ri;
      // 실제 사진에서 뽑은 피부색을 정해 둔 피부색과 섞어서 그 선수답게 (사진 조명 때문에 반만 반영)
      if (photoSkin[id]) l.skinHex = '#' + new THREE.Color(l.skinHex).lerp(new THREE.Color(photoSkin[id]), 0.5).getHexString();
      // 선수마다 머리 색 농도와 얼굴 비율이 조금씩 다름
      const hc = new THREE.Color(l.hairHex), j = 0.8 + hash01(id, 3) * 0.45;
      l.hairHex = '#' + hc.multiplyScalar(j).getHexString();
      const R = (n) => (hash01(id, 20 + n) * 2 - 1) * 2.1;   // 차이를 크게 (범위 -2.1~2.1)
      l.shape = { len: R(1), top: R(2), jaw: R(3), cheek: R(4), chin: R(5), nose: R(6), nw: R(7), nl: R(8), eyeSz: R(9), eyeSp: R(10), tilt: R(11), browH: R(12), browT: R(13), lipW: R(14), lipF: R(15) };
      l.face = {
        w: 0.9 + hash01(id, 4) * 0.22, h: 0.93 + hash01(id, 5) * 0.14, d: 0.94 + hash01(id, 6) * 0.12,
        neck: 0.85 + hash01(id, 7) * 0.4, eye: hash01(id, 8),
      };
      p._look = l;
    }
    return p._look;
  }
  kitColors(p) {
    const info = p.team.info;
    const look = this.lookOf(p);
    const skin = look.skinHex, hair = look.hairHex;
    // 눈 색: 금발/붉은 머리는 파랑·초록이 섞이게
    const e = look.face ? look.face.eye : 0.5;
    const EYES_L = ['#3a5f86', '#2f6b4f', '#5b7f9a', '#4a3a2a', '#6b7b4a'], EYES_D = ['#2a1a10', '#2a1a10', '#3a2414', '#241a12', '#4a3018', '#5a4a2a', '#2a3a2a'];
    const eye = look.color >= 4 ? EYES_L[Math.floor(e * EYES_L.length)] : EYES_D[Math.floor(e * EYES_D.length)];
    const common = { skin, hair, eye, beardStyle: look.beardStyle };
    if (p.isGK) {
      return { ...common, jersey: info.gk, shorts: '#111827', socks: info.gk, trim: '#111827', boots: '#0f172a', glove: '#f8fafc' };
    }
    const k = info.kit || { shirt: info.color, trim: info.color2, shorts: info.color2, socks: info.color };
    const pattern = { stripes: 1, band: 2, chest: 3, diag: 4, sleeves: 5 }[k.pattern] || 0;
    const boots = ['#111827', '#f8fafc', '#facc15', '#ef4444', '#22d3ee', '#a3e635'][(p.num * 7 + (p.name ? p.name.length : 1)) % 6];
    return { ...common, jersey: k.shirt, jersey2: k.shirt2, sleeve: k.sleeve, pattern, shorts: k.shorts, socks: k.socks, trim: k.trim, boots, glove: skin };
  }
  makeSkinnedPlayer(p) {
    const gltf = this.model;
    const obj = SkeletonUtils.clone(gltf.scene);
    const mat = makePlayerMaterial(this.kitColors(p), numberTexture(p.num));
    if (!p.isGK && p.team.info.crest) {
      this.crestTex = this.crestTex || {};
      const url = p.team.info.crest;
      if (!this.crestTex[url]) {
        this.crestTex[url] = new THREE.TextureLoader().load(url);
        this.crestTex[url].colorSpace = THREE.SRGBColorSpace;
      }
      mat.userData.kit.uCrest.value = this.crestTex[url];
      mat.userData.kit.uHasCrest.value = 1;
    }
    // 9조각이던 몸을 하나의 메시로 합침 (그리기 호출/뼈대 갱신 9배 절약)
    const parts = [];
    obj.traverse(o => { if (o.isSkinnedMesh) parts.push(o); });
    const look = this.lookOf(p);
    const wantHair = 'Hair_' + look.hairStyle, wantBeard = 'Beard_' + look.beardStyle;
    const used = parts.filter(o => !/^(Hair|Beard)_/.test(o.name) || o.name === wantHair || o.name === wantBeard);
    const key = this.lod + '|' + look.hairStyle + '|' + look.beardStyle;
    this.mergedGeo = this.mergedGeo || {};
    if (!this.mergedGeo[key]) this.mergedGeo[key] = mergeSkinnedParts(used);
    // 얼굴 생김새는 선수마다 다르므로 선수별로 복제해서 변형 (같은 선수는 재사용)
    this.faceGeo = this.faceGeo || {};
    const fid = p.team.info.short + '_' + (p.ri === undefined ? p.idx : p.ri);
    if (!this.faceGeo[fid + key]) this.faceGeo[fid + key] = deformFace(this.mergedGeo[key].clone(), look.shape);
    const body = new THREE.SkinnedMesh(this.faceGeo[fid + key], mat);
    body.bind(parts[0].skeleton, parts[0].bindMatrix);
    body.castShadow = true; body.frustumCulled = false;
    parts[0].parent.add(body);
    for (const m of parts) m.parent.remove(m);
    // 선수마다 키와 체격을 조금씩 다르게 (골키퍼는 더 크게)
    const base = PLAYER_H / MODEL_H;
    const hh = (p.isGK ? 1.04 : 0.96) + Math.random() * 0.07, ww = 0.94 + Math.random() * 0.12;
    obj.scale.set(base * ww, base * hh, base * ww);
    const fc = look.face;
    const bones = { hs: fc ? new THREE.Vector3(fc.w, fc.h, fc.d) : null, ns: fc ? fc.neck : 1, lArm: obj.getObjectByName('LeftArm'), rArm: obj.getObjectByName('RightArm'), lFore: obj.getObjectByName('LeftForeArm'), rFore: obj.getObjectByName('RightForeArm'), neck: obj.getObjectByName('Neck'), head: obj.getObjectByName('Head'), chest: obj.getObjectByName('Spine2'), spine: obj.getObjectByName('Spine1') };

    // 동작: 이동(대기/걷기/달리기)은 서로 섞고, 나머지는 위에 덮어쓰거나 덧씌움
    const mixer = new THREE.AnimationMixer(obj);
    const acts = {};
    for (const clip of gltf.animations) {
      const n = clip.name;
      const additive = ADDITIVE.includes(n);
      const a = mixer.clipAction(additive ? this.additiveClips[n] : clip);
      if (additive) a.blendMode = THREE.AdditiveAnimationBlendMode;
      if (ONE_SHOT.includes(n)) { a.setLoop(THREE.LoopOnce, 1); a.clampWhenFinished = true; }
      a.setEffectiveWeight(n === 'idle' ? 1 : 0);
      acts[n] = a;
    }
    for (const n of ['idle', 'dejected', 'hips', 'celebrate', 'celebrate_pump', 'throw_in', 'gk_hold', 'gk_ready']) if (acts[n]) { acts[n].play(); acts[n].time = Math.random() * acts[n].getClip().duration; }
    // 걷기/달리기는 같은 박자로 맞추려고 시간을 직접 지정함
    for (const n of ['walk', 'run']) { acts[n].timeScale = 0; acts[n].play(); }
    // 슛 모으기: 자세를 고정해 두고 세기만 조절
    if (acts.charge) { acts.charge.timeScale = 0; acts.charge.time = acts.charge.getClip().duration; acts.charge.play(); }

    const w = {};
    for (const n of OVERRIDES) w[n] = 0;
    const root = new THREE.Group();
    const pivot = new THREE.Group();
    pivot.add(obj); root.add(pivot);
    if (!this.blobGeo) {
      this.blobGeo = new THREE.CircleGeometry(1.0, 20);
      this.blobMat = new THREE.MeshBasicMaterial({
        map: canvasTex(64, 64, (g, w, h) => {
          const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
          gr.addColorStop(0, 'rgba(0,0,0,0.6)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
          g.fillStyle = gr; g.fillRect(0, 0, w, h);
        }), transparent: true, depthWrite: false,
      });
    }
    const blob = new THREE.Mesh(this.blobGeo, this.blobMat);
    blob.rotation.x = -Math.PI / 2; blob.position.y = 0.04; blob.visible = false;
    root.add(blob);
    this.scene.add(root);
    return { p, root, pivot, obj, blob, bones, breath: Math.random() * 6.28, look: 0, lookP: 0, mixer, acts, w, lw: { idle: 1, walk: 0, run: 0 }, phase: Math.random(), charge: 0,
             kickUntil: 0, tk: null, ovName: null, footToggle: false, pose: null, skinned: true };
  }

  makeSimplePlayer(p) {
    const c = this.kitColors(p);
    const root = new THREE.Group(), pivot = new THREE.Group();
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.35, 1.6, 12), new THREE.MeshStandardMaterial({ color: c.jersey }));
    body.position.y = 1.7;
    const legs = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.25, 1.0, 12), new THREE.MeshStandardMaterial({ color: c.shorts }));
    legs.position.y = 0.5;
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.33, 16, 12), new THREE.MeshStandardMaterial({ color: c.skin }));
    head.position.y = 2.75;
    for (const m of [body, legs, head]) { m.castShadow = true; pivot.add(m); }
    root.add(pivot);
    this.scene.add(root);
    return { p, root, pivot, kickT: 0, pose: null, skinned: false };
  }

  cycleCamera() {
    const i = CAMERA_ORDER.indexOf(this.camMode);
    this.camMode = CAMERA_ORDER[(i + 1) % CAMERA_ORDER.length];
    this.applyShadowFrustum();
    return CAMERAS[this.camMode].name;
  }

  resize(w, h) {
    this.width = w || 1; this.height = h || 1;
    this.renderer.setSize(this.width, this.height, false);
    if (this.useComposer) {
      this.composer.setPixelRatio(this.renderer.getPixelRatio());
      this.composer.setSize(this.width, this.height);
    }
    this.camera.aspect = this.width / this.height;
    this.camera.updateProjectionMatrix();
  }

  // 3D 좌표 → 화면 좌표 (HUD용)
  project(x, y, height) {
    const v = new THREE.Vector3(toX(x), height, toZ(y)).project(this.camera);
    return { x: (v.x + 1) / 2 * this.width, y: (1 - v.y) / 2 * this.height, visible: v.z < 1 };
  }

  onEvent(e) {
    if (!this.game) return;
    if (e.type === 'goal') {
      this.excite = 1;
    } else if (e.type === 'save' || e.type === 'post') {
      this.excite = Math.max(this.excite, 0.35);
      if (e.type === 'save') this.gkSave(e);
    } else if (e.type === 'fall') {
      const v = this.players.find(x => x.p === e.player);
      if (v && v.skinned) {
        const clip = e.full ? 'fall' : 'stumble';
        this.triggerOneShot(v, clip, 0, e.full ? 1.1 : 1.0);
        v.gkClip = clip; v.gkUntil = this.clock + (e.full ? 1.35 : 0.55);
      }
    } else if (e.type === 'receive') {
      const v = this.players.find(x => x.p === e.player);
      if (v && v.skinned && !v.p.tackle && !(v.p.stun > 0)) { this.triggerOneShot(v, 'chest_trap', 0.06, 1); v.gkClip = 'chest_trap'; v.gkUntil = this.clock + 0.45; }
    } else if (e.type === 'gkCatch') {
      this.gkSave(e);
    } else if (e.type === 'kickStart') {
      const v = this.players.find(x => x.p === e.player);
      if (v && e.gkThrow && v.skinned) { this.triggerOneShot(v, 'gk_throw', Math.max(0, 0.3 - e.delay), 1); v.gkClip = 'gk_throw'; v.gkUntil = this.clock + 0.75; }
      else if (v && e.throwIn) { v.throwT0 = this.clock; v.throwDur = e.delay; }
      else if (v && v.skinned && e.gkPunt) { this.triggerOneShot(v, 'gk_punt', Math.max(0, 0.267 - e.delay), 1); v.gkClip = 'gk_punt'; v.gkUntil = this.clock + e.delay + 0.55; v.kickUntil = 0; }
      else if (v && v.skinned && e.shot && e.air) { this.triggerOneShot(v, 'volley', Math.max(0, 0.267 - e.delay), 1); v.gkClip = 'volley'; v.gkUntil = this.clock + e.delay + 0.6; v.kickUntil = 0; }
      else if (v && v.skinned && !e.shot && !e.lofted && !e.player.isGK && e.power < 760) { this.triggerOneShot(v, 'pass', Math.max(0, 0.167 - e.delay), 1); v.gkClip = 'pass'; v.gkUntil = this.clock + e.delay + 0.4; v.kickUntil = 0; }
      else if (v) this.triggerKick(v, e.delay);
    } else if (e.type === 'headerStart') {
      const v = this.players.find(x => x.p === e.player);
      if (v && v.skinned) { v.headerAt = this.clock + Math.max(0, e.delay - 0.333); v.headerDelay = e.delay; }   // 접촉 프레임 = 0.333초
    } else if (e.type === 'feint') {
      const v = this.players.find(x => x.p === e.player);
      if (v && v.skinned) { this.triggerOneShot(v, 'feint', 0, 1); v.feintUntil = this.clock + 0.55; }
    } else if (e.type === 'dribble') {
      const v = this.players.find(x => x.p === e.player);
      if (v && !e.player.isGK && !e.player.tackle && !e.player.kickWind) this.triggerTouch(v);
    }
  }

  // 골키퍼 선방 동작: 공 높이에 따라 점프 / 가슴 캐치 / 낮은 공 쓸어 담기 (몸을 날리는 중이면 다이빙 동작을 그대로 둠)
  gkSave(e) {
    const v = this.players.find(x => x.p === e.player);
    if (!v || !v.skinned || e.player.tackle) return;
    const z = e.z || 0;
    const clip = e.smother || z < 14 ? 'gk_low' : z > 42 ? 'gk_jump' : 'gk_catch';
    this.triggerOneShot(v, clip, 0.04, 1.15);
    v.gkClip = clip; v.gkUntil = this.clock + 0.7;
  }

  triggerOneShot(v, name, startTime = 0, timeScale = 1) {
    const a = v.acts[name];
    if (!a) return;
    a.reset();
    a.time = startTime;
    a.timeScale = timeScale;
    a.play();
  }

  triggerKick(v, delay = 0.14) {
    if (!v.skinned) return;
    this.triggerOneShot(v, 'kick', Math.max(0, 0.2 - delay), 1);
    v.kickUntil = this.clock + delay + 0.32;
  }

  triggerTouch(v) {
    if (!v.skinned) return;
    v.footToggle = !v.footToggle;
    const name = v.footToggle ? 'touch_R' : 'touch_L';
    this.triggerOneShot(v, name, 0, 1);
    v.acts[name].setEffectiveWeight(0.9);
  }

  // ================= 프레임 갱신 =================
  update(dt, controlledList, opt = {}) {
    this.replay = !!opt.replay;
    this.clock += dt;
    for (const t of this.adTextures) t.offset.x = (t.offset.x + dt * 0.04) % 1;
    for (const f of this.flags) f.rotation.y = Math.sin(this.clock * 2 + f.position.x) * 0.25;
    this.animateNets(dt);
    this.animateCrowd(dt);
    this.animateWeather(dt);

    const game = this.game;
    if (!game) {
      for (const m of this.markers) m.ring.visible = m.cone.visible = false;
      this.ball.visible = false;
      const t = this.clock * 0.05;
      this.camera.position.set(Math.sin(t) * 105, 34, Math.cos(t) * 105);
      this.camera.lookAt(0, 2, 0);
      this.renderer.shadowMap.autoUpdate = true;
      this.render();
      return;
    }
    this.ball.visible = true;
    const b = game.ball;

    // 공 + 회전
    const bx = toX(b.x), bz = toZ(b.y);
    const prevX = this.ball.position.x, prevZ = this.ball.position.z;
    const held = b.owner && b.owner.isGK && b.owner.team.inOwnBox(b.owner.x, b.owner.y);
    const ov = b.owner && b.owner.locked && !b.owner.isGK ? this.players.find(x => x.p === b.owner) : null;
    let by = held ? PLAYER_H * 0.55 : BALL_R + b.z * VZ;
    if (ov) {
      const u = ov.throwU === undefined ? 0 : ov.throwU;
      by = PLAYER_H * (1.02 + 0.06 * Math.sin(Math.min(1, u * 1.4) * Math.PI)) - u * 0.2;
    }
    this.ball.position.set(bx, by, bz);
    const mx = bx - prevX, mz = bz - prevZ, md = Math.hypot(mx, mz);
    if (md > 0.0001 && md < 5 && !held) {
      this.ball.rotateOnWorldAxis(new THREE.Vector3(mz, 0, -mx).normalize(), md / BALL_R);
    }


    const celebrating = !this.replay && game.state === 'goal' && game.restart ? game.restart.team.opp : null;
    for (const v of this.players) { v.root.visible = !v.p.out; if (!v.p.out) this.animatePlayer(v, dt, b, celebrating); }

    // 프리킥/페널티 조준점
    const A = !this.replay && game.aim;
    if (A) {
      if (!this.aimMark) {
        const g = new THREE.Group();
        const mat = new THREE.MeshBasicMaterial({ color: 0xfacc15, transparent: true, opacity: 0.95, depthTest: false, side: THREE.DoubleSide, toneMapped: false });
        g.add(new THREE.Mesh(new THREE.RingGeometry(0.55, 0.72, 40), mat));
        g.add(new THREE.Mesh(new THREE.CircleGeometry(0.12, 16), mat));
        g.renderOrder = 20;
        this.scene.add(g); this.aimMark = g;
      }
      const side = A.taker.team.dir;
      this.aimMark.visible = true;
      this.aimMark.position.set(toX(A.taker.team.attackX) - side * 0.15, 1.15 + Math.sin(this.clock * 6) * 0.04, toZ(A.y));
      this.aimMark.rotation.y = Math.PI / 2;
      const sc = 1 + Math.sin(this.clock * 6) * 0.08;
      this.aimMark.scale.setScalar(sc);
    } else if (this.aimMark) this.aimMark.visible = false;

    this.markers.forEach((m, i) => {
      const c = this.replay ? null : controlledList[i];
      m.ring.visible = m.cone.visible = !!c;
      if (!c) return;
      m.ring.position.set(toX(c.x), 0.04, toZ(c.y));
      m.cone.position.set(toX(c.x), PLAYER_H + 0.9 + Math.sin(this.clock * 6) * 0.12, toZ(c.y));
    });

    // 패스 대상 표시: 지금 S를 누르면 공이 갈 동료의 발 밑에 노란 고리
    if (!this.hintRings) {
      this.hintRings = [0, 1].map(() => {
        const r = new THREE.Mesh(new THREE.RingGeometry(0.75, 0.95, 32), new THREE.MeshBasicMaterial({ color: 0xfacc15, transparent: true, opacity: 0.9, depthWrite: false, side: THREE.DoubleSide }));
        r.rotation.x = -Math.PI / 2; r.visible = false; r.renderOrder = 3; this.scene.add(r); return r;
      });
    }
    game.teams.forEach((t, i) => {
      const h = !this.replay && t.human && t.passHint;
      const r = this.hintRings[i];
      r.visible = !!h;
      if (h) { r.position.set(toX(h.x), 0.06, toZ(h.y)); r.scale.setScalar(1 + 0.08 * Math.sin(this.clock * 9)); }
    });

    if (this.replay) this.replayCamera(dt, b, opt.goalX); else this.updateCamera(dt, b);
    // 그림자는 2프레임에 한 번만 갱신 (눈에 거의 안 띄고 GPU 부담이 크게 줄어듦)
    // 그림자 카메라는 보는 곳을 따라다님 (4칸 단위로 움직여 그림자가 떨리지 않게)
    const fo = this.replay ? this._fo.set(bx, 0, bz) : this.camTarget;
    this.sun.target.position.set(Math.round(fo.x / 4) * 4, 0, Math.round(fo.z / 4) * 4);
    this.sun.position.copy(this.sunDir).multiplyScalar(220).add(this.sun.target.position);
    this.sun.target.updateMatrixWorld();
    for (const v of this.players) if (v.blob) v.blob.visible = !this.q.shadows;
    this.renderer.shadowMap.autoUpdate = false;
    this.renderer.shadowMap.needsUpdate = ((this._sf = (this._sf || 0) + 1) % 2) === 0;
    this.render();
  }

  // 리플레이: 사이드라인 쪽 낮은 시점에서, 골대 방향으로 살짝 앞서며 공을 따라감 (해를 등지는 방향)
  replayCamera(dt, b, goalX) {
    const gx = toX(goalX), side = Math.sign(gx) || 1;
    const bx = toX(b.x), bz = toZ(b.y);
    const cx = Math.max(-W * S / 2, Math.min(W * S / 2, bx + side * 9));
    const want = new THREE.Vector3(cx, 6.5, bz + 24);
    if (!this.replayInit) { this.camera.position.copy(want); this.replayInit = true; }
    this.camera.position.lerp(want, Math.min(1, dt * 2));
    if (this.camera.fov !== 32) { this.camera.fov = 32; this.camera.updateProjectionMatrix(); }
    this.camera.lookAt(bx, 1.2 + b.z * VZ * 0.5, bz);
  }

  endReplay() {
    this.replayInit = false;
    this.camTarget.set(toX(this.game ? this.game.ball.x : 700), 0, 0);
  }

  // 그물 출렁임: 공이 그물을 밀면 그 자리가 밀려나고, 이웃 그물코로 물결처럼 퍼졌다가 돌아옴
  animateNets(dt) {
    if (!dt) return;
    const ball = this.ball.visible ? this.ball.position : null;
    const R2 = 0.9 * 0.9, reach = BALL_R * 1.3;
    // 공 속도 (이전 프레임 위치와 비교). 순간이동(킥오프 등)은 무시
    const bp = this.ball.position;
    let bvx = 0, bvy = 0, bvz = 0;
    if (this.prevBall) {
      bvx = (bp.x - this.prevBall.x) / dt; bvy = (bp.y - this.prevBall.y) / dt; bvz = (bp.z - this.prevBall.z) / dt;
      if (bvx * bvx + bvy * bvy + bvz * bvz > 200 * 200) bvx = bvy = bvz = 0;
    }
    this.prevBall = bp.clone();
    for (const net of this.nets) {
      const gx = net.group.position.x;
      const lx = ball ? ball.x - gx : 0;
      const near = ball && Math.abs(lx) < GOAL_DEPTH * S + 1.5 && Math.abs(ball.z) < GOAL_HALF * S + 1.5 && ball.y < GOAL_H + 1.5;
      if (!near && !net.active) continue;
      let energy = 0;
      for (const sf of net.surfaces) {
        const { base, n, off, vel, tmp, nu, nv } = sf;
        const pos = sf.mesh.geometry.attributes.position.array;
        const count = off.length;
        for (let i = 0; i < count; i++) {
          let desired = 0;
          if (near) {
            const px = lx - base[i * 3], py = ball.y - base[i * 3 + 1], pz = ball.z - base[i * 3 + 2];
            const sd = px * n.x + py * n.y + pz * n.z;           // 그물 면에서 공까지 (바깥쪽 +)
            const lat2 = px * px + py * py + pz * pz - sd * sd;  // 면을 따라 떨어진 거리²
            if (lat2 < R2 && sd > -reach) desired = (sd + reach) * Math.exp(-lat2 / 0.3);
          }
          let v = vel[i];
          if (desired > off[i]) v += (desired - off[i]) * 140 * dt;
          // 공이 그물 쪽으로 날아와 부딪히면 그 속도만큼 밀어냄
          if (near) {
            const px = lx - base[i * 3], py = ball.y - base[i * 3 + 1], pz = ball.z - base[i * 3 + 2];
            const sd = px * n.x + py * n.y + pz * n.z;
            const lat2 = px * px + py * py + pz * pz - sd * sd;
            const vn = bvx * n.x + bvy * n.y + bvz * n.z;
            if (vn > 2 && sd > -reach * 2.2 && lat2 < R2 * 1.6) v += vn * 0.9 * Math.exp(-lat2 / 0.3);
          }
          v += -off[i] * 38 * dt;
          v *= Math.exp(-4.5 * dt);
          vel[i] = v;
          tmp[i] = Math.max(-0.35, Math.min(1.8, off[i] + v * dt));
        }
        // 이웃 그물코와 섞어 물결이 퍼지게
        const w = nu + 1;
        for (let j = 0; j <= nv; j++) for (let i = 0; i <= nu; i++) {
          const k = j * w + i;
          const edge = i === 0 || j === 0 || i === nu || j === nv;
          if (edge) { off[k] = 0; vel[k] = 0; }
          else off[k] = tmp[k] * 0.72 + (tmp[k - 1] + tmp[k + 1] + tmp[k - w] + tmp[k + w]) * 0.07;
          energy += Math.abs(off[k]) + Math.abs(vel[k]) * 0.05;
          pos[k * 3] = base[k * 3] + n.x * off[k];
          pos[k * 3 + 1] = base[k * 3 + 1] + n.y * off[k];
          pos[k * 3 + 2] = base[k * 3 + 2] + n.z * off[k];
        }
        sf.mesh.geometry.attributes.position.needsUpdate = true;
      }
      net.active = near || energy > 0.02;
    }
  }

  animatePlayer(v, dt, b, celebrating) {
    const { p, root } = v;
    const clampv = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
    const wrap = a => Math.atan2(Math.sin(a), Math.cos(a));
    const lerp = (x, y, k) => x + (y - x) * Math.min(1, k);
    root.position.set(toX(p.x), 0, toZ(p.y));

    // 방향 전환을 부드럽게
    const targetYaw = Math.atan2(p.fx, p.fy);
    if (v.yaw === undefined) v.yaw = targetYaw;
    // 몸 방향은 지수 감쇠 + 최소 회전 속도: 뒤로 달리는 것처럼(문워크) 보이는 시간을 없앰
    const yerr = wrap(targetYaw - v.yaw);
    const step = Math.max(Math.abs(yerr) * Math.min(1, dt * 14), Math.min(Math.abs(yerr), 16 * dt));
    const dyaw = Math.sign(yerr) * step;
    v.yaw = wrap(v.yaw + dyaw);
    root.rotation.order = 'YXZ';
    root.rotation.y = v.yaw;
    if (!v.skinned) return;
    // 무릎 슬라이딩 세리머니는 앞으로 미끄러져 나감
    if (celebrating === p.team && v.celeClip === 'celebrate_slide' && v.slideT0 !== undefined) {
      const u = Math.min(1, (this.clock - v.slideT0) / 0.9);
      const off = 3.4 * (1 - (1 - u) * (1 - u));
      root.position.x += Math.sin(v.yaw) * off; root.position.z += Math.cos(v.yaw) * off;
    }

    const A = v.acts, M = this.clipMeta || {};
    const spd = Math.hypot(p.vx, p.vy) * S / (PLAYER_H / MODEL_H);   // 모델 기준 속도(m/s)
    // 진행 방향과 몸이 어긋나 있으면 발 구르는 속도를 줄임 (미끄러져 보이지 않게)
    let ms = spd;
    if (spd > 0.3) {
      const mis = Math.abs(wrap(Math.atan2(p.vx, p.vy) - v.yaw));
      ms = spd * clampv(1.15 - mis / 1.6, 0.15, 1);
    }
    // 몸 기울기: 달릴수록 앞으로, 회전할 때는 안쪽으로
    v.lean = lerp(v.lean || 0, clampv(ms * 0.014, 0, 0.1), dt * 6);
    v.bank = lerp(v.bank || 0, clampv(-dyaw / Math.max(dt, 1e-3) * spd * 0.012, -0.22, 0.22), dt * 7);
    root.rotation.x = v.lean;
    root.rotation.z = v.bank;

    // ----- 이동: 대기/걷기/달리기를 속도에 따라 섞고, 걷기와 달리기는 같은 박자로 재생 -----
    const t1 = clampv((ms - 0.2) / 0.9, 0, 1), t2 = clampv((ms - 2.2) / 2.0, 0, 1);
    const k = dt * 10;
    v.lw.idle = lerp(v.lw.idle, 1 - t1, k);
    v.lw.walk = lerp(v.lw.walk, t1 * (1 - t2), k);
    v.lw.run = lerp(v.lw.run, t1 * t2, k);
    if (v.lw.idle < 0.004) v.lw.idle = 0;
    if (v.lw.walk < 0.004) v.lw.walk = 0;
    if (v.lw.run < 0.004) v.lw.run = 0;
    const refW = (M.walk && M.walk.refSpeed) || 1.4, refR = (M.run && M.run.refSpeed) || 6.5;
    const durW = A.walk.getClip().duration, durR = A.run.getClip().duration;
    const cps = lerp(clampv(ms / refW, 0.5, 1.8) / durW, clampv(ms / refR, 0.7, 1.55) / durR, t2);
    v.phase = (v.phase + dt * cps) % 1;
    A.walk.time = v.phase * durW;
    A.run.time = v.phase * durR;

    // ----- 덮어쓰는 동작 고르기 -----
    let want = null;
    const tk = p.tackle;
    if (tk) {
      if (tk.kind === 'slide') want = 'slide';
      else if (tk.kind === 'dive') {
        const rx = -Math.cos(v.yaw), rz = Math.sin(v.yaw);   // 캐릭터의 오른쪽 방향
        want = (tk.dx * rx + tk.dy * rz) >= 0 ? 'dive_R' : 'dive_L';
      } else want = 'tackle';
      if (v.tk !== tk) {
        v.tk = tk;
        v.ovName = want;
        this.triggerOneShot(v, want, 0, want.startsWith('dive') ? 1.7 : want === 'slide' ? 1.25 : 1.2);
      }
    } else if (v.ovName && p.stun > 0 && A[v.ovName].time < A[v.ovName].getClip().duration - 0.05) {
      want = v.ovName;    // 태클이 끝난 뒤 일어서는 동작까지 이어서 재생
    } else { v.tk = null; v.ovName = null; }
    if (v.headerAt !== undefined && this.clock >= v.headerAt) {
      const late = Math.max(0, 0.333 - (v.headerDelay || 0.333));
      this.triggerOneShot(v, 'header', late, 1);
      v.headerUntil = this.clock + 0.8 - late; v.headerAt = undefined;
    }
    if (!want && this.clock < (v.gkUntil || 0)) want = v.gkClip;
    if (!want && this.clock < (v.headerUntil || 0)) want = 'header';
    if (!want && this.clock < (v.feintUntil || 0)) want = 'feint';
    if (!want && this.clock < v.kickUntil) want = 'kick';
    if (!want) {
      if (b.owner === p && p.isGK && !p.feet) want = 'gk_hold';
      else if (b.owner === p && p.locked) want = 'throw_in';
      else if (celebrating === p.team && !p.isGK) {
        // 골 세리머니: 득점한 선수는 무릎 슬라이딩, 나머지는 점프/주먹 흔들기 중 무작위 (골마다 새로 정함)
        const gn = this.game.goals.length;
        if (v.celeFor !== gn) {
          v.celeFor = gn;
          const gl = this.game.goals[this.game.goals.length - 1];
          const scorer = gl ? gl.pi === this.game.players.indexOf(p) : b.lastKicker === p;      // 실제 득점자(굴절된 슛이면 슈터)가 무릎 슬라이딩
          v.celeClip = scorer && Math.random() < 0.6 ? 'celebrate_slide' : (Math.random() < 0.4 ? 'celebrate_pump' : 'celebrate');
          if (v.celeClip === 'celebrate_slide') { this.triggerOneShot(v, 'celebrate_slide', 0, 1); v.slideT0 = this.clock; }
        }
        want = v.celeClip || 'celebrate';
      }
      else if (celebrating && p.team !== celebrating) want = 'dejected';
      else if (p.isGK && !b.owner && Math.hypot(b.x - p.x, b.y - p.y) < 330) want = 'gk_ready';
      else if (this.game.state === 'out' && ms < 0.4 && !p.isGK) {
        // 재시작을 기다리는 동안 일부 선수는 무릎에 손을 얹고 숨을 고름 (재시작마다 새로 정함)
        const rs = this.game.restart;
        if (v.rsRef !== rs) { v.rsRef = rs; v.hipsOn = Math.random() < 0.3; }
        if (v.hipsOn && rs && rs.taker !== p) want = 'hips';
      }
    }

    let ow = 0;
    for (const n of OVERRIDES) {
      let tg = n === want ? 1 : 0;
      if (tg && n === 'gk_ready') tg = ms > 2.5 ? 0.45 : 0.9;
      if (tg && n === 'kick') tg = 0.9;
      v.w[n] = lerp(v.w[n], tg, dt * (tg > v.w[n] ? 18 : 9));
      if (tg === 0 && v.w[n] < 0.004) v.w[n] = 0;      // 0이 되면 three.js가 그 동작은 계산을 건너뜀
      A[n].setEffectiveWeight(v.w[n]);
      ow += v.w[n];
    }
    ow = Math.min(1, ow);
    A.idle.setEffectiveWeight(v.lw.idle * (1 - ow));
    A.walk.setEffectiveWeight(v.lw.walk * (1 - ow));
    A.run.setEffectiveWeight(v.lw.run * (1 - ow));

    // ----- 슛 모으기: 차는 발을 뒤로 빼는 자세를 세기만큼 -----
    v.charge = lerp(v.charge, p.charging ? 0.4 + 0.6 * p.charge : 0, dt * 12);
    if (v.charge < 0.004) v.charge = 0;
    if (A.charge) A.charge.setEffectiveWeight(v.charge);

    v.mixer.update(dt);

    // ----- 뼈대 위에 덧씌우는 자연스러운 움직임: 시선, 호흡, 몸통 비틀기 -----
    const bn = v.bones;
    // 스로인 던지는 동작: 공을 머리 뒤로 넘겼다가 앞으로 던짐
    if (bn && bn.lArm && v.throwT0 !== undefined) {
      const u = clampv((this.clock - v.throwT0) / (v.throwDur || 0.46), 0, 1);
      v.throwU = u;
      const swing = u < 0.45 ? -(u / 0.45) * 0.55 : -0.55 + (u - 0.45) / 0.55 * 1.5;   // 뒤로 젖혔다가 앞으로
      for (const a of [bn.lArm, bn.rArm]) a.rotateX(swing * 1.0);
      for (const a of [bn.lFore, bn.rFore]) a.rotateX(swing * 0.5);
      bn.chest.rotateX(swing * 0.35); bn.spine.rotateX(swing * 0.25);
      if (u >= 1 && !(p.locked)) v.throwT0 = undefined;
    } else v.throwU = undefined;
    if (bn && bn.head && bn.neck && bn.chest) {
      // 공을 바라봄 (몸 방향 기준으로 좌우 최대 약 60도, 천천히 따라감)
      const dx = toX(b.x) - root.position.x, dz = toZ(b.y) - root.position.z;
      const far = Math.hypot(dx, dz);
      let want = far > 1.5 && !p.tackle ? clampv(wrap(Math.atan2(dx, dz) - v.yaw), -1.05, 1.05) : 0;
      if (ms > 4.5) want *= 0.4;                       // 전력 질주 중에는 앞을 봄
      if (this.clock < v.kickUntil || p.kickWind) want *= 0.3;
      const wantP = far > 1.5 ? clampv((1.4 - 1.6) * 0.1 - Math.min(far, 30) * 0.003, -0.15, 0.1) : 0;
      v.look = lerp(v.look, want, dt * 5);
      v.lookP = lerp(v.lookP, wantP, dt * 4);
      const still = v.lw.idle * (1 - ow);
      v.breath += dt * (1.6 + Math.min(ms, 7) * 0.25);
      const br = Math.sin(v.breath);
      bn.neck.rotateY(v.look * 0.35); bn.head.rotateY(v.look * 0.5);
      if (bn.hs) { bn.neck.scale.set(1, bn.ns, 1); bn.head.scale.set(bn.hs.x, bn.hs.y / bn.ns, bn.hs.z); }
      bn.head.rotateX(v.lookP);
      bn.chest.rotateX(br * (0.012 + 0.012 * still));          // 숨 쉴 때 가슴이 부풀었다 가라앉음
      // 달릴 때 어깨가 다리 반대로 살짝 돌아감
      bn.chest.rotateY(Math.sin(v.phase * Math.PI * 2) * Math.min(1, ms / 6) * 0.12 * (1 - ow));
      bn.spine.rotateY(Math.sin(v.phase * Math.PI * 2) * Math.min(1, ms / 6) * 0.06 * (1 - ow));
    }
  }

  updateCamera(dt, b) {
    const cfg = CAMERAS[this.camMode];
    const lim = W * S / 2 - 4;
    const tx = Math.max(-lim, Math.min(lim, toX(b.x) + b.vx * S * 0.3));
    const tz = toZ(b.y) * 1.0;
    const k = Math.min(1, dt * 2.6);
    this.camTarget.x += (tx - this.camTarget.x) * k;
    this.camTarget.z += (tz - this.camTarget.z) * k;
    const fl = this.flip ? -1 : 1;      // 손님(AWAY)은 반대편에서 봄: 내 골문이 왼쪽, 상대 골문이 오른쪽
    this.camPos.set(this.camTarget.x * 0.94, cfg.up + Math.max(0, Math.abs(this.camTarget.z) - 40) * 0.25, Math.max(-96, Math.min(96, this.camTarget.z + cfg.back * fl)));
    this.camera.position.lerp(this.camPos, Math.min(1, dt * 3.5));
    if (this.camera.fov !== cfg.fov) { this.camera.fov = cfg.fov; this.camera.updateProjectionMatrix(); }
    this.camera.lookAt(this.camTarget.x, 1, this.camTarget.z - 3 * fl);
  }

  dispose() {
    this.composer.dispose();
    this.renderer.dispose();
  }
}
