"""선수 머리/얼굴/머리카락/수염 만들기 (build_player.py가 불러 씀)

 - 머리: 단면(타원)을 쌓은 격자 + 코/눈구멍/입술/턱 같은 얼굴 굴곡. 단면 높이(h)는 턱 아래(0)에서 정수리(0.236)까지(m)
 - 눈동자/흰자/눈썹/귀/목
 - 머리 모양 10가지(Hair_*), 수염 2가지(Beard_*): 머리 표면을 따라 부풀린 껍질 + 몇몇 덩어리(묶음머리, 땋은머리 등)
좌표: Blender Z가 위, 캐릭터는 -Y를 바라봄, 캐릭터의 왼쪽 = +X
"""
import math
import bmesh
from mathutils import Vector, Matrix

H_CHIN = 1.572            # 턱 아래 높이 (Blender z)
H_TOP = 0.236             # 정수리 높이 (턱 기준)

# (h, 앞면 y, 뒷면 y, 반폭) — 머리 단면 모양
PROFILE = [
    (0.000, 0.058, -0.010, 0.018),
    (0.012, 0.082, -0.020, 0.036),
    (0.026, 0.093, -0.034, 0.050),
    (0.044, 0.093, -0.052, 0.060),
    (0.064, 0.095, -0.068, 0.067),
    (0.086, 0.093, -0.082, 0.072),
    (0.110, 0.094, -0.092, 0.076),
    (0.135, 0.097, -0.097, 0.078),
    (0.160, 0.098, -0.099, 0.078),
    (0.185, 0.093, -0.097, 0.075),
    (0.208, 0.080, -0.086, 0.065),
    (0.226, 0.056, -0.062, 0.046),
    (0.236, 0.000, 0.000, 0.000),
]


def clamp(x, a, b):
    return a if x < a else b if x > b else x


def smooth(a, b, x):
    t = clamp((x - a) / (b - a), 0.0, 1.0)
    return t * t * (3 - 2 * t)


def g(x, mu, s):
    return math.exp(-((x - mu) / s) ** 2)


def profile(h):
    h = clamp(h, 0.0, H_TOP)
    P = PROFILE
    n = len(P)
    for i in range(n - 1):
        if h <= P[i + 1][0]:
            a, b = P[i], P[i + 1]
            t = (h - a[0]) / (b[0] - a[0] + 1e-9)
            p0 = P[max(i - 1, 0)]
            p3 = P[min(i + 2, n - 1)]
            out = []
            for k in (1, 2, 3):
                m1 = (b[k] - p0[k]) / (b[0] - p0[0] + 1e-9) * (b[0] - a[0])
                m2 = (p3[k] - a[k]) / (p3[0] - a[0] + 1e-9) * (b[0] - a[0])
                t2, t3 = t * t, t * t * t
                out.append((2 * t3 - 3 * t2 + 1) * a[k] + (t3 - 2 * t2 + t) * m1 + (-2 * t3 + 3 * t2) * b[k] + (t3 - t2) * m2)
            return tuple(out)
    return P[-1][1:]


def features(h, x, wf):
    """얼굴 굴곡: (높이 h, 가로 x)에서 표면을 바깥(+)/안쪽(-)으로 밀어내는 양(m)"""
    if wf <= 0.0:
        return 0.0
    ax = abs(x)
    d = 0.0
    # 코: 코끝, 콧대, 콧볼, 콧구멍
    d += 0.0215 * g(ax, 0, 0.0085) * g(h, 0.081, 0.0072)
    amp = 0.0035 + 0.0115 * clamp((0.120 - h) / 0.034, 0, 1)
    if 0.080 < h < 0.130:
        d += amp * g(ax, 0, 0.0052) * smooth(0.079, 0.094, h)
    d += 0.0100 * g(ax, 0.0148, 0.0068) * g(h, 0.0765, 0.0058)
    d -= 0.0042 * g(ax, 0.0088, 0.0034) * g(h, 0.0715, 0.0030)
    # 눈구멍 / 눈썹뼈 / 광대 / 볼
    d -= 0.0066 * g(ax, 0.0345, 0.0135) * g(h, 0.1225, 0.0105)
    d += 0.0058 * g(ax, 0.0, 0.040) * g(h, 0.1430, 0.0085)
    d += 0.0050 * g(ax, 0.052, 0.016) * g(h, 0.0880, 0.0135)
    d -= 0.0030 * g(ax, 0.050, 0.014) * g(h, 0.0600, 0.0120)
    # 입 주변
    lipw = max(0.0, 1 - (ax / 0.0245) ** 2)
    d += 0.0078 * lipw * g(h, 0.0585, 0.0042)           # 윗입술
    d += 0.0088 * lipw * g(h, 0.0455, 0.0050)           # 아랫입술
    d -= 0.0034 * max(0.0, 1 - (ax / 0.0235) ** 2) * g(h, 0.0518, 0.0013)   # 입술 사이
    d -= 0.0020 * g(ax, 0, 0.004) * g(h, 0.0680, 0.006)                      # 인중
    d -= 0.0035 * max(0.0, 1 - (ax / 0.0155) ** 2) * g(h, 0.0345, 0.0042)    # 입술 아래 오목
    d += 0.0085 * g(ax, 0, 0.0165) * g(h, 0.0170, 0.0125)                    # 턱
    d += 0.0020 * g(ax, 0.026, 0.012) * g(h, 0.168, 0.012)                   # 이마
    return d * wf


def sgn(v):
    return -1.0 if v < 0 else 1.0


def raw_point(h, th, extra=0.0, use_feat=True):
    f, b, W = profile(h)
    D = (f - b) / 2.0
    yc = (f + b) / 2.0
    n = 2.0 + 0.5 * smooth(0.03, 0.12, h)
    s, c = math.sin(th), math.cos(th)
    x = W * sgn(s) * abs(s) ** (2.0 / n)
    fw = yc + D * sgn(c) * abs(c) ** (2.0 / n)
    d = 0.0
    if use_feat:
        d = features(h, x, smooth(0.05, 0.75, c))
    # 바깥쪽 방향 (단면 타원의 법선)
    nx = x / (W * W + 1e-9)
    nf = (fw - yc) / (D * D + 1e-9)
    l = math.hypot(nx, nf) or 1.0
    nx, nf = nx / l, nf / l
    X = x + nx * (d + extra)
    F = fw + nf * (d + extra)
    return Vector((X, -F, H_CHIN + h))


def normal_at(h, th, use_feat=True):
    e = 0.0016
    p_h1 = raw_point(min(h + e, H_TOP - 1e-4), th, 0, use_feat)
    p_h0 = raw_point(max(h - e, 0.0), th, 0, use_feat)
    p_t1 = raw_point(h, th + 0.02, 0, use_feat)
    p_t0 = raw_point(h, th - 0.02, 0, use_feat)
    n = (p_t1 - p_t0).cross(p_h1 - p_h0)
    if n.length < 1e-9:
        return Vector((0, 0, 1))
    n.normalize()
    ctr = raw_point(h, th, 0, use_feat) - Vector((0, 0.0, H_CHIN + 0.115))
    ctr.x *= 1.0
    if n.dot(ctr) < 0:
        n = -n
    return n


# ----- 격자(고리 × 각도) -----
import os as _os
LOD = float(_os.environ.get('PLAYER_LOD', '1'))      # 1 = 원본, 0.5 = 가벼운 모델(경기 화면용)
N_RING = 52
def ring_heights():
    # 입/턱 근처를 촘촘하게 (입술 모양을 살리려고)
    hs = []
    for a, b, step in ((0.0, 0.03, 0.006), (0.03, 0.075, 0.0028), (0.075, 0.16, 0.0053), (0.16, 0.226, 0.0094)):
        n = max(1, int(round((b - a) / (step / LOD))))
        for i in range(n):
            hs.append(a + (b - a) * i / n)
    hs.append(0.226)
    hs.append(H_TOP)
    return hs


def thetas():
    back = max(5, int(12 * LOD))
    front = max(16, int(40 * LOD))
    out = []
    # 뒤(-pi..-1.4) → 앞(-1.4..1.4) → 뒤(1.4..pi)
    for i in range(back):
        out.append(-math.pi + (math.pi - 1.4) * i / back)
    for i in range(front):
        out.append(-1.4 + 2.8 * i / front)
    for i in range(back):
        out.append(1.4 + (math.pi - 1.4) * i / back)
    return out


HS = ring_heights()
THS = thetas()
NS = len(THS)


def build_skin_grid(bm, mi_skin, mi_lips, tag=None, tag_layer=None):
    """머리 피부: 격자 + 위/아래 마개. 얼굴 굴곡 포함. 입술 영역은 Lips 재질"""
    rings = []
    for h in HS[:-1]:
        row = []
        for th in THS:
            v = bm.verts.new(raw_point(h, th))
            if tag_layer is not None:
                v[tag_layer] = tag
            row.append(v)
        rings.append(row)
    top = bm.verts.new(raw_point(H_TOP, 0.0))
    bot = bm.verts.new(Vector((0, -0.024, H_CHIN - 0.002)))
    if tag_layer is not None:
        top[tag_layer] = tag
        bot[tag_layer] = tag
    faces = []
    for i in range(len(rings) - 1):
        for j in range(NS):
            a, b = rings[i][j], rings[i][(j + 1) % NS]
            c, d = rings[i + 1][(j + 1) % NS], rings[i + 1][j]
            faces.append(bm.faces.new((a, b, c, d)))
    for j in range(NS):
        faces.append(bm.faces.new((rings[-1][(j + 1) % NS], rings[-1][j], top)))
        faces.append(bm.faces.new((rings[0][j], rings[0][(j + 1) % NS], bot)))
    for f in faces:
        ctr = f.calc_center_median()
        x = ctr.x
        h = ctr.z - H_CHIN
        front = -ctr.y > 0.07
        f.material_index = mi_skin
    return faces


def surface_at(x, h):
    """가로 x, 높이 h 위치의 얼굴 앞 표면(좌표)과 앞쪽 법선"""
    f, b, W = profile(h)
    s = clamp(x / W, -0.98, 0.98)
    th = math.asin(s)
    p = raw_point(h, th)
    return p, normal_at(h, th)


def add_sphere(bm, center, radius, scale, mi, segs=(14, 10), rot=None):
    r = bmesh.ops.create_uvsphere(bm, u_segments=max(6, int(segs[0] * LOD)), v_segments=max(4, int(segs[1] * LOD)), radius=radius)
    vs = r['verts']
    M = Matrix.Translation(Vector(center))
    if rot is not None:
        M = M @ rot.to_4x4()
    M = M @ Matrix.Diagonal((scale[0], scale[1], scale[2], 1.0))
    bmesh.ops.transform(bm, matrix=M, verts=vs)
    for f in {f for v in vs for f in v.link_faces}:
        f.material_index = mi
        f.smooth = True
    return vs


def add_eyes(bm, mi_sclera, mi_iris):
    for sx in (1, -1):
        x = sx * 0.0335
        p, n = surface_at(abs(x), 0.1225)
        # 눈알: 눈구멍 안쪽에 반쯤 묻히게
        ctr = Vector((x, p.y + 0.0058, H_CHIN + 0.1225))
        add_sphere(bm, ctr, 0.0108, (1.0, 1.0, 1.0), mi_sclera, (16, 12))
        # 홍채/동공: 앞쪽에 납작하게
        ir = Vector((x * 0.985, ctr.y - 0.0095, ctr.z - 0.0004))
        add_sphere(bm, ir, 0.0056, (1.0, 0.42, 1.0), mi_iris, (12, 8))


def add_brows(bm, mi_brow):
    for sx in (1, -1):
        N = 9
        rows = []
        for i in range(N):
            t = i / (N - 1)
            ax = 0.0115 + 0.047 * t                      # 안쪽 → 바깥
            hb = 0.1425 + 0.0105 * math.sin(t * math.pi * 0.85) - 0.0035 * t
            w = (0.0070 + 0.0035 * math.sin(t * math.pi * 0.9)) * (1.0 - 0.45 * t * t)
            p, n = surface_at(ax, hb)
            p = Vector((sx * p.x, p.y, p.z))
            nn = Vector((sx * n.x, n.y, n.z))
            up = Vector((0, 0, 1))
            side = nn.cross(up)
            if side.length < 1e-6:
                side = Vector((1, 0, 0))
            side.normalize()
            base = p + nn * 0.0006
            tck = 0.0030
            corners = [base + up * w * 0.5, base + up * w * 0.5 + nn * tck, base - up * w * 0.5 + nn * tck, base - up * w * 0.5]
            rows.append([bm.verts.new(c) for c in corners])
        for i in range(N - 1):
            for k in range(4):
                a, b = rows[i][k], rows[i][(k + 1) % 4]
                c, d = rows[i + 1][(k + 1) % 4], rows[i + 1][k]
                f = bm.faces.new((a, b, c, d) if sx > 0 else (b, a, d, c))
                f.material_index = mi_brow
                f.smooth = True
        for fv in (rows[0], rows[-1]):
            try:
                f = bm.faces.new(fv if (fv is rows[-1]) == (sx > 0) else list(reversed(fv)))
                f.material_index = mi_brow
            except ValueError:
                pass


def add_ears(bm, mi_skin):
    for sx in (1, -1):
        c = Vector((sx * 0.0795, 0.004, H_CHIN + 0.1095))
        rot = Matrix.Rotation(sx * 0.18, 3, 'Z') @ Matrix.Rotation(-0.10, 3, 'X')
        add_sphere(bm, c, 0.012, (0.55, 0.85, 1.55), mi_skin, (12, 10), rot)
        # 귓바퀴 테두리(살짝 도톰)
        c2 = c + Vector((sx * 0.0035, 0.002, 0.002))
        add_sphere(bm, c2, 0.0105, (0.40, 0.70, 1.35), mi_skin, (10, 8), rot)


def add_neck(bm, mi_skin, tag, tag_layer):
    """몸의 목과 머리 사이를 잇는 원뿔"""
    rings = []
    seg = 24
    z0, z1 = 1.495, H_CHIN + 0.024
    N = 6
    for i in range(N):
        t = i / (N - 1)
        z = z0 + (z1 - z0) * t
        r = 0.0640 - 0.0150 * (t ** 0.9)
        rx, ry = r, r * 0.96
        row = []
        for k in range(seg):
            a = 2 * math.pi * k / seg
            v = bm.verts.new(Vector((rx * math.sin(a), 0.004 - ry * math.cos(a) * 0.95 + 0.002, z)))
            v[tag_layer] = tag
            row.append(v)
        rings.append(row)
    for i in range(N - 1):
        for k in range(seg):
            a, b = rings[i][k], rings[i][(k + 1) % seg]
            c, d = rings[i + 1][(k + 1) % seg], rings[i + 1][k]
            f = bm.faces.new((a, b, c, d))
            f.material_index = mi_skin
            f.smooth = True


def x_of(h, th):
    f, b, W = profile(h)
    n = 2.0 + 0.5 * smooth(0.03, 0.12, h)
    s = math.sin(th)
    return W * sgn(s) * abs(s) ** (2.0 / n)


def add_lips(bm, mi_lips):
    """입술: 얼굴 표면 위에 얇은 타원 껍질을 얹어 경계가 매끈하게 보이게 함"""
    hs = [0.030 + 0.0012 * i for i in range(int(0.045 / 0.0012) + 1)]
    ths = [-0.62 + 0.02 * i for i in range(int(1.24 / 0.02) + 1)]

    def mask(h, th):
        if math.cos(th) < 0.5:
            return 0.0
        x = x_of(h, th)
        e = (x / 0.0262) ** 2 + ((h - 0.0520) / 0.0138) ** 2
        return smooth(1.02, 0.80, e)
    def thick(h, th):
        # 가운데(입 사이 선)는 살짝 들어가게
        return 0.0020 - 0.0012 * g(h, 0.0518, 0.0010)
    # 껍질 가장자리 두께 처리를 위해 일반 껍질 함수 재사용
    shell(bm, mi_lips, mask, thick, hs, ths)


def head_base(bm, mi, tag_layer):
    """머리 본체(피부/입술/눈/눈썹/귀/목)를 bm에 추가. mi: 재질 이름 → 번호"""
    # 눈/눈썹/귀는 뼈대 100% Head에 붙이려고 태그 1, 목은 태그 2, 머리 피부는 태그 1
    before = set(bm.verts)
    build_skin_grid(bm, mi['Skin'], mi['Lips'], 1, tag_layer)
    add_lips(bm, mi['Lips'])
    for v in set(bm.verts) - before:
        v[tag_layer] = 1
    b2 = set(bm.verts)
    add_eyes(bm, mi['Sclera'], mi['Eyes'])
    add_brows(bm, mi['Brow'])
    add_ears(bm, mi['Skin'])
    for v in set(bm.verts) - b2:
        v[tag_layer] = 1
    add_neck(bm, mi['Skin'], 2, tag_layer)
    for f in bm.faces:
        f.smooth = True


# ============================================================
# 머리카락 / 수염 (머리 표면을 따라 부풀린 껍질)
# ============================================================
def hair_line(th, style):
    """머리카락이 시작하는 높이(턱 기준 h). 각도 th: 0=정면"""
    a = abs(th)
    side = smooth(0.2, 1.0, a / (math.pi / 2))
    back = smooth(1.0, 2.0, a / (math.pi / 2))
    front_h, side_h, back_h = 0.186, 0.158, 0.098
    if style in ('short', 'buzz', 'slick', 'side'):
        side_h, back_h = 0.164, 0.120
    if style in ('wavy', 'curly', 'afro'):
        front_h, side_h, back_h = 0.180, 0.140, 0.082
    if style == 'long':
        front_h, side_h, back_h = 0.184, 0.140, 0.095
    return front_h - (front_h - side_h) * side - (side_h - back_h) * back


def noise(h, th, k=1.0):
    return (math.sin(h * 190 * k + th * 5.1) + math.sin(h * 83 * k - th * 9.3 + 1.7) + math.sin(th * 13.0 * k + h * 41)) / 3.0


def hair_thickness(style, h, th):
    top = smooth(0.14, 0.22, h)
    if style == 'buzz':
        return 0.0034
    if style == 'short':
        return 0.0075 + 0.0045 * top
    if style == 'side':
        front = smooth(0.1, 1.0, math.cos(th)) * smooth(0.16, 0.21, h)
        return 0.0075 + 0.0035 * top + 0.0085 * front
    if style == 'slick':
        back = smooth(0.0, 1.0, -math.cos(th))
        return 0.0095 + 0.0070 * top + 0.004 * back
    if style == 'wavy':
        return 0.0130 + 0.0045 * noise(h, th) + 0.005 * top
    if style == 'curly':
        return 0.0190 + 0.0070 * noise(h, th, 1.6) + 0.004 * top
    if style == 'afro':
        return 0.040 * (0.55 + 0.45 * top) + 0.006 * noise(h, th, 1.2)
    if style == 'long':
        return 0.0115 + 0.0035 * top
    if style == 'bun':
        return 0.0080 + 0.0035 * top
    if style == 'braids':
        return 0.0085 + 0.0035 * top
    return 0.008


# 껍질(머리카락/수염)은 머리 본체보다 촘촘한 격자를 써서 가장자리가 매끈하게 보이게 함
HS_FINE = [i * (0.0042 / LOD) for i in range(int(H_TOP / (0.0042 / LOD)))] + [H_TOP]
_NF = max(32, int(80 * LOD))
THS_FINE = [-math.pi + 2 * math.pi * i / _NF for i in range(_NF)]


def shell(bm, mi, mask_fn, thick_fn, hs=None, ths=None):
    """머리 표면을 thick만큼 부풀린 껍질. mask_fn(h, th) > 0 인 곳만, 가장자리는 두께 0으로 이어짐"""
    hs = hs or HS_FINE
    ths = ths or THS_FINE
    nh, nt = len(hs), len(ths)
    mk = {}
    for i, h in enumerate(hs):
        for j, th in enumerate(ths):
            mk[(i, j)] = clamp(mask_fn(h, th), 0.0, 1.0)
    vm = {}
    for i, h in enumerate(hs):
        for j, th in enumerate(ths):
            used = False
            for di in (-1, 0):
                for dj in (-1, 0):
                    ii, jj = i + di, (j + dj) % nt
                    if 0 <= ii < nh - 1 and any(mk[(ii + a, (jj + b) % nt)] > 0.002 for a in (0, 1) for b in (0, 1)):
                        used = True
            if not used:
                continue
            m = mk[(i, j)]
            t = thick_fn(h, th) * m - 0.0012      # 가장자리는 살짝 피부 속에 묻혀서 경계가 매끈한 곡선이 됨
            if h >= H_TOP - 1e-6:
                p = raw_point(H_TOP - 1e-5, 0.0) + Vector((0, 0, t))
            else:
                p = raw_point(h, th) + normal_at(h, th) * t
            vm[(i, j)] = bm.verts.new(p)
    faces = []
    for i in range(nh - 1):
        for j in range(nt):
            ks = [(i, j), (i, (j + 1) % nt), (i + 1, (j + 1) % nt), (i + 1, j)]
            if all(k in vm for k in ks) and any(mk[k] > 0.002 for k in ks):
                f = bm.faces.new([vm[k] for k in ks])
                f.material_index = mi
                f.smooth = True
                faces.append(f)
    return faces


def tube(bm, mi, pts, radius, sides=6, taper=0.55):
    rings = []
    for i, p in enumerate(pts):
        t = i / max(1, len(pts) - 1)
        r = radius * (1.0 - taper * t)
        if i == 0:
            d = pts[1] - pts[0]
        else:
            d = pts[i] - pts[i - 1]
        d.normalize()
        up = Vector((0, 0, 1)) if abs(d.z) < 0.9 else Vector((1, 0, 0))
        a = d.cross(up); a.normalize()
        b = d.cross(a); b.normalize()
        rings.append([bm.verts.new(p + (a * math.cos(2 * math.pi * k / sides) + b * math.sin(2 * math.pi * k / sides)) * r) for k in range(sides)])
    for i in range(len(rings) - 1):
        for k in range(sides):
            f = bm.faces.new((rings[i][k], rings[i][(k + 1) % sides], rings[i + 1][(k + 1) % sides], rings[i + 1][k]))
            f.material_index = mi
            f.smooth = True
    try:
        f = bm.faces.new(list(reversed(rings[-1])))
        f.material_index = mi
    except ValueError:
        pass


def hair_mesh(bm, mi, style):
    if style == 'bald':
        return
    shell(bm, mi, lambda h, th: smooth(0.0, 0.008, h - hair_line(th, style)), lambda h, th: hair_thickness(style, h, th))
    if style == 'long':
        # 뒤통수에서 어깨로 흘러내리는 머리카락: 바깥/안쪽 두 겹으로 닫힌 얇은 덩어리
        K = 10
        ths = [math.pi * (0.50 + 1.0 * i / 18.0) for i in range(19)]       # 오른쪽 옆 → 뒤 → 왼쪽 옆
        outer, inner = [], []
        for k in range(K):
            hh = 0.100 - k * 0.0255
            row_o, row_i = [], []
            kk = k / (K - 1.0)
            taper = 1.0 - 0.18 * kk ** 1.5
            for i, th in enumerate(ths):
                s_, c_ = math.sin(th), math.cos(th)
                u = (i / 18.0 - 0.5) * 2.0                      # -1(옆) .. 0(뒤 가운데) .. 1(옆)
                wide = 0.086 + 0.010 * kk
                dep = 0.086 + 0.018 * kk
                end_taper = 1.0 - 0.55 * (abs(u) ** 2.2) * kk
                x = wide * s_ * taper * end_taper
                y = 0.016 - dep * c_ * 0.95 + 0.020 * kk
                row_o.append(bm.verts.new(Vector((x, y, H_CHIN + hh))))
                row_i.append(bm.verts.new(Vector((x * 0.9, y - 0.012, H_CHIN + hh - 0.003))))
            outer.append(row_o); inner.append(row_i)
        for k in range(K - 1):
            for i in range(len(ths) - 1):
                f1 = bm.faces.new((outer[k][i], outer[k][i + 1], outer[k + 1][i + 1], outer[k + 1][i]))
                f2 = bm.faces.new((inner[k][i], inner[k + 1][i], inner[k + 1][i + 1], inner[k][i + 1]))
                for f_ in (f1, f2):
                    f_.material_index = mi
                    f_.smooth = True
        for i in range(len(ths) - 1):          # 아래 끝 막기
            f_ = bm.faces.new((outer[-1][i], inner[-1][i], inner[-1][i + 1], outer[-1][i + 1]))
            f_.material_index = mi
        for k in range(K - 1):                 # 양옆 끝 막기
            for i, sg in ((0, 1), (len(ths) - 1, -1)):
                q = (outer[k][i], inner[k][i], inner[k + 1][i], outer[k + 1][i])
                f_ = bm.faces.new(q if sg > 0 else tuple(reversed(q)))
                f_.material_index = mi
    if style == 'bun':
        add_sphere(bm, Vector((0, 0.074, H_CHIN + 0.212)), 0.036, (1.0, 1.0, 0.92), mi, (14, 10))
    if style == 'braids':
        for k in range(9):
            th = math.pi * (0.55 + 0.90 * k / 8.0)
            h0 = 0.150
            p0 = raw_point(h0, th) + normal_at(h0, th) * 0.004
            pts = []
            for i in range(9):
                t = i / 8.0
                pts.append(Vector((p0.x * (1 + 0.15 * t) + 0.006 * math.sin(i * 1.3 + k), p0.y + 0.020 * t * (0.5 + math.cos(th) * -0.5), p0.z - 0.19 * t - 0.01 * t)))
            tube(bm, mi, pts, 0.0085, 6, 0.4)


def beard_mesh(bm, mi, style):
    if style == 'stubble':
        def mask(h, th):
            if math.cos(th) < -0.2:
                return 0.0
            side = smooth(0.2, 0.9, abs(math.sin(th)))
            ymax = 0.082 + 0.030 * (1 - side) * 0.0 + 0.012 * side
            m = smooth(ymax, ymax - 0.014, h)
            # 입술 위쪽 (콧수염 자리)과 입술 자체는 비움
            x = raw_point(h, th).x
            if abs(x) < 0.027 and 0.0385 < h < 0.0645:
                return 0.0
            if abs(x) > 0.086:
                return 0.0
            return m * smooth(-0.1, 0.2, math.cos(th))
        shell(bm, mi, mask, lambda h, th: 0.0030)
    elif style == 'full':
        def mask(h, th):
            c = math.cos(th)
            if c < -0.3:
                return 0.0
            x = raw_point(h, th).x
            if abs(x) > 0.088:
                return 0.0
            if abs(x) < 0.027 and 0.0385 < h < 0.0645:
                return 0.0
            low = smooth(0.098, 0.082, h)                      # 뺨 위쪽 한계
            # 콧수염 (입술 위)
            mus = smooth(0.0645, 0.0680, h) * smooth(0.086, 0.078, h) * smooth(0.030, 0.021, abs(x))
            return clamp(low + mus, 0, 1) * smooth(-0.3, 0.3, c)
        def thick(h, th):
            chin = smooth(0.060, 0.012, h)
            return 0.0090 + 0.0100 * chin
        shell(bm, mi, mask, thick)
