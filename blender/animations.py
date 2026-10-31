"""선수 동작 제작 (build_player.py가 불러 씀)

회전 방향 규칙 (미리보기로 확인함. 캐릭터는 -Y를 보고, 왼쪽이 +X):
  UpLeg / Arm   x 음수 = 앞으로,   Leg x 양수 = 무릎 굽힘,  Foot x 양수 = 발끝 내림
  Spine/Hips    x 양수 = 앞으로 숙임,  y 양수 = 왼쪽으로 돎,  z 양수 = 캐릭터 오른쪽으로 기울어짐
  LeftArm z 음수 / RightArm z 양수 = 팔을 옆으로 듦,  LeftUpLeg z 음수 / RightUpLeg z 양수 = 다리를 벌림
  Hips location = (좌우, 위아래, 앞뒤)
"""
import bpy, math, json, os
from mathutils import Euler

FPS = 30
REST_ANKLE_Z = 0.105
D = math.radians


def d(x=0, y=0, z=0):
    return (D(x), D(y), D(z))


def mirror_pose(rots, locs=None):
    """좌우 반전 (왼쪽 뼈대 <-> 오른쪽 뼈대)"""
    def swap(n):
        if n.startswith('Left'):
            return 'Right' + n[4:]
        if n.startswith('Right'):
            return 'Left' + n[5:]
        return n
    r = {swap(n): (v[0], -v[1], -v[2]) for n, v in rots.items()}
    l = {n: (-v[0], v[1], v[2]) for n, v in (locs or {}).items()}
    return r, l


class Builder:
    def __init__(self, ao, scene):
        self.ao = ao
        self.scene = scene
        self.pb = ao.pose.bones
        for b in self.pb:
            b.rotation_mode = 'XYZ'
        self.ad = ao.animation_data_create()
        self.ad.use_nla = False          # 이미 만든 동작(NLA 트랙)이 작성 중인 자세를 덮어쓰지 않게 함
        self.meta = {}

    # ---------- 기본 도구 ----------
    def set_pose(self, rots, locs=None, bones=None):
        for name, b in self.pb.items():
            if bones is not None and name not in bones:
                continue
            b.rotation_euler = Euler(rots.get(name, (0, 0, 0)), 'XYZ')
            b.location = (locs or {}).get(name, (0, 0, 0))

    def ankle_min_z(self):
        dg = bpy.context.evaluated_depsgraph_get()
        eo = self.ao.evaluated_get(dg)
        return min(eo.pose.bones['LeftFoot'].head.z, eo.pose.bones['RightFoot'].head.z)

    def ankles(self):
        dg = bpy.context.evaluated_depsgraph_get()
        eo = self.ao.evaluated_get(dg)
        return [tuple(eo.pose.bones[n].head) for n in ('LeftFoot', 'RightFoot')]

    def begin(self, name):
        self.name = name
        self.act = bpy.data.actions.new(name)
        self.ad.action = None
        self.frames = 0

    def key(self, frame, bones=None):
        self.ad.action = self.act        # 키를 찍는 순간에만 연결 (그 사이 갱신이 자세를 덮어쓰지 않음)
        for name, b in self.pb.items():
            if bones is not None and name not in bones:
                continue
            b.keyframe_insert('rotation_euler', frame=frame)
            if name == 'Hips':
                b.keyframe_insert('location', frame=frame)
        self.ad.action = None
        self.frames = max(self.frames, frame)

    def end(self, loop=False):
        self.ad.action = self.act
        tr = self.ad.nla_tracks.new()
        tr.name = self.name
        st = tr.strips.new(self.name, 0, self.act)
        st.name = self.name
        self.ad.action = None
        info = self.meta.setdefault(self.name, {})
        info['duration'] = round(self.frames / FPS, 4)
        info['loop'] = loop

    def frame_pose(self, frame, rots, locs=None, ground=False, bounce=0.0, bones=None):
        locs = dict(locs or {})
        self.set_pose(rots, locs, bones)
        if ground:
            hx, hy, hz = locs.get('Hips', (0, 0, 0))
            self.pb['Hips'].location = (hx, hy, hz)
            bpy.context.view_layer.update()
            shift = REST_ANKLE_Z - self.ankle_min_z()
            self.pb['Hips'].location = (hx, hy + shift + bounce, hz)
        self.key(frame, bones)

    # ---------- 반복 동작 (걷기/달리기) ----------
    def loco(self, name, secs, P):
        n = int(round(secs * FPS))
        self.begin(name)
        track = []
        for i in range(n + 1):
            phi = 2 * math.pi * i / n
            rots, locs, bounce = self.loco_pose(phi, P)
            self.frame_pose(i, rots, locs, ground=True, bounce=bounce)
            track.append((i / FPS, self.ankles()))
        self.end(loop=True)
        # 미끄럼 없이 움직일 때의 지면 속도 = 지지발(가장 낮은 발)이 몸 기준으로 뒤로 가는 속도의 중앙값
        speeds = []
        for k in range(len(track) - 1):
            t0, a0 = track[k]
            t1, a1 = track[k + 1]
            side = 0 if a0[0][2] <= a0[1][2] else 1
            if (side == 0) == (a1[0][2] <= a1[1][2]):
                v = (a1[side][1] - a0[side][1]) / (t1 - t0)
                if v > 0.05:
                    speeds.append(v)
        speeds.sort()
        self.meta[name]['refSpeed'] = round(speeds[len(speeds) // 2], 3) if speeds else 1.0

    def loco_pose(self, phi, P):
        r, l = {}, {}
        S = {'Left': phi, 'Right': phi + math.pi}
        for side, s in S.items():
            f = P['A'] * math.sin(s)
            thigh = -f + P.get('thigh0', 0.0)
            knee = P['K0'] + P['KA'] * (0.5 + 0.5 * math.cos(s + 0.9)) ** 2
            push = max(0.0, -math.sin(s)) ** 3
            heel = max(0.0, math.sin(s)) ** 4
            foot = -(thigh + knee) * 0.85 + P['push'] * push - P['heel'] * heel
            r[side + 'UpLeg'] = (thigh, 0, P['legZ'] * (1 if side == 'Left' else -1))
            r[side + 'Leg'] = (knee, 0, 0)
            r[side + 'Foot'] = (foot, 0, 0)
            r[side + 'ToeBase'] = (-P['toe'] * push, 0, 0)
            sgn = 1 if side == 'Left' else -1
            r[side + 'Arm'] = (P['arm'] * math.sin(s) - P['arm0'], 0, P['add'] * sgn)
            r[side + 'ForeArm'] = (-(P['e0'] - P['eA'] * math.sin(s)), 0, 0)
        tw = (P['T'] + P['H']) * math.sin(phi)
        r['Hips'] = (0, -P['H'] * math.sin(phi), 0)
        r['Spine'] = (P['lean'] * 0.3, 0.4 * tw, 0)
        r['Spine1'] = (P['lean'] * 0.3, 0.35 * tw, 0)
        r['Spine2'] = (P['lean'] * 0.4 + 0.01 * math.sin(2 * phi), 0.25 * tw, 0)
        r['Neck'] = (-P['lean'] * 0.3, 0, 0)
        r['Head'] = (-P['lean'] * 0.4, -P['T'] * 0.8 * math.sin(phi), 0)
        l['Hips'] = (P['sway'] * math.sin(phi), 0, 0)
        bounce = P['bounce'] * (1 - math.cos(2 * phi)) / 2
        return r, l, bounce

    def idle(self, name, secs, ready):
        n = int(round(secs * FPS))
        self.begin(name)
        for i in range(n + 1):
            phi = 2 * math.pi * i / n
            br = math.sin(phi)
            r, l = {}, {}
            k = ready['knee']
            for side, sgn in (('Left', 1), ('Right', -1)):
                r[side + 'UpLeg'] = (-ready['thigh'], 0, ready['legZ'] * sgn)
                r[side + 'Leg'] = (k, 0, 0)
                r[side + 'Foot'] = (-(-ready['thigh'] + k) * 0.9, 0, 0)
                r[side + 'Arm'] = (-ready['arm'] + 0.03 * math.sin(phi + sgn), 0, ready['armZ'] * sgn)
                r[side + 'ForeArm'] = (-ready['elbow'] - 0.04 * br, 0, 0)
            r['Spine'] = (ready['lean'] * 0.3, 0, 0)
            r['Spine1'] = (ready['lean'] * 0.3, 0.02 * br, 0)
            r['Spine2'] = (ready['lean'] * 0.4 + 0.018 * br, 0, 0)
            r['Head'] = (-ready['lean'] * 0.5 + 0.01 * br, 0.05 * math.sin(phi * 0.5), 0)
            l['Hips'] = (0.012 * math.sin(phi), 0, 0)
            self.frame_pose(i, r, l, ground=True)
        self.end(loop=True)

    # ---------- 키 포즈로 만드는 동작 ----------
    def author(self, name, keys, ground=False, loop=False, bones=None):
        """keys: {프레임: (rots, locs)} 사이 프레임은 Blender가 부드럽게 보간"""
        self.begin(name)
        for fr in sorted(keys):
            rots, locs = keys[fr]
            self.frame_pose(fr, rots, locs, ground=ground, bones=bones)
        self.end(loop=loop)


def build(ao, scene):
    b = Builder(ao, scene)
    scene.render.fps = FPS

    # ---------------- 이동 ----------------
    b.idle('idle', 2.0, dict(knee=0.22, thigh=0.10, legZ=-0.03, arm=0.10, armZ=0.10, elbow=0.45, lean=0.10))
    b.loco('walk', 1.05, dict(A=0.40, K0=0.08, KA=0.75, arm=0.40, arm0=0.05, e0=0.30, eA=0.15, add=0.10, legZ=-0.02,
                              lean=0.05, T=0.10, H=0.07, sway=0.012, bounce=0.0, push=0.45, heel=0.25, toe=0.45))
    b.loco('run', 0.53, dict(A=0.95, K0=0.20, KA=1.70, arm=0.90, arm0=0.10, e0=1.25, eA=0.30, add=0.22, legZ=-0.03,
                             lean=0.26, T=0.24, H=0.10, sway=0.010, bounce=0.06, push=0.65, heel=0.10, toe=0.55))

    zero = {}
    # ---------------- 킥 (오른발, 공 접촉 = 6프레임) ----------------
    b.author('kick', {
        0: ({'Spine1': d(5), 'LeftLeg': d(15), 'LeftUpLeg': d(-8), 'LeftArm': d(-15, 0, 10), 'RightArm': d(15, 0, -10)}, {}),
        4: ({'RightUpLeg': d(42), 'RightLeg': d(90), 'RightFoot': d(25),
             'LeftUpLeg': d(-12), 'LeftLeg': d(28), 'LeftFoot': d(-10),
             'Hips': d(0, -12, 0), 'Spine1': d(8, 10, 0), 'Spine2': d(5, 8, 0),
             'LeftArm': d(-50, 0, -35), 'RightArm': d(25, 0, 25), 'LeftForeArm': d(-40), 'RightForeArm': d(-30),
             'Head': d(8)}, {}),
        6: ({'RightUpLeg': d(-48), 'RightLeg': d(25), 'RightFoot': d(42), 'RightToeBase': d(-10),
             'LeftUpLeg': d(-14), 'LeftLeg': d(32), 'LeftFoot': d(-12),
             'Hips': d(0, 14, 0), 'Spine1': d(12, -12, 0), 'Spine2': d(6, -8, 0),
             'LeftArm': d(-30, 0, -45), 'RightArm': d(35, 0, 30), 'LeftForeArm': d(-30), 'RightForeArm': d(-30),
             'Head': d(14)}, {}),
        9: ({'RightUpLeg': d(-78), 'RightLeg': d(8), 'RightFoot': d(30),
             'LeftUpLeg': d(-8), 'LeftLeg': d(22),
             'Hips': d(0, 24, 0), 'Spine': d(10), 'Spine1': d(14, -18, 0), 'Spine2': d(6, -10, 0),
             'LeftArm': d(-20, 0, -50), 'RightArm': d(30, 0, 45), 'LeftForeArm': d(-25), 'RightForeArm': d(-20),
             'Head': d(14)}, {}),
        15: ({'RightUpLeg': d(-30), 'RightLeg': d(35), 'RightFoot': d(10),
              'LeftUpLeg': d(-10), 'LeftLeg': d(20),
              'Hips': d(0, 8, 0), 'Spine1': d(8, -6, 0), 'LeftArm': d(-20, 0, -15), 'RightArm': d(10, 0, 10),
              'LeftForeArm': d(-35), 'RightForeArm': d(-35)}, {}),
        21: ({'LeftLeg': d(10), 'LeftUpLeg': d(-5), 'Spine1': d(5), 'LeftArm': d(-10), 'RightArm': d(-10),
              'LeftForeArm': d(-25), 'RightForeArm': d(-25)}, {}),
    }, ground=True)

    # ---------------- 터치 (달리며 공을 툭 침) - 다리만, 덧씌우기용 ----------------
    for side in ('Right', 'Left'):
        leg = [side + n for n in ('UpLeg', 'Leg', 'Foot', 'ToeBase')]
        b.author('touch_' + side[0], {
            0: ({}, {}),
            3: ({side + 'UpLeg': d(-38), side + 'Leg': d(34), side + 'Foot': d(32), side + 'ToeBase': d(-8)}, {}),
            5: ({side + 'UpLeg': d(-24), side + 'Leg': d(18), side + 'Foot': d(18)}, {}),
            9: ({}, {}),
        }, bones=leg)

    # ---------------- 슛 모으기 (덧씌우기용, 가중치로 세기 조절) ----------------
    ch = ['RightUpLeg', 'RightLeg', 'RightFoot', 'LeftArm', 'RightArm', 'Spine1', 'Spine2', 'Hips']
    pose = {'RightUpLeg': d(38), 'RightLeg': d(80), 'RightFoot': d(28), 'LeftArm': d(-35, 0, -30),
            'RightArm': d(25, 0, 20), 'Spine1': d(-4), 'Spine2': d(-4), 'Hips': d(0, -10, 0)}
    b.author('charge', {0: ({}, {}), 1: (pose, {}), 2: (pose, {})}, bones=ch)

    # ---------------- 슬라이딩 태클 ----------------
    slide = ({'Hips': d(-60), 'Spine1': d(28), 'Spine2': d(10), 'Head': d(48),
              'RightUpLeg': d(-12), 'RightLeg': d(2), 'RightFoot': d(-15),
              'LeftUpLeg': d(-40), 'LeftLeg': d(105), 'LeftFoot': d(10),
              'LeftArm': d(40, 0, -30), 'RightArm': d(45, 0, 30), 'LeftForeArm': d(-15), 'RightForeArm': d(-15)},
             {'Hips': (0, -0.47, 0)})
    slide2 = ({**slide[0], 'Hips': d(-62)}, {'Hips': (0, -0.49, 0)})
    b.author('slide', {0: ({'Spine1': d(10)}, {}), 5: slide, 14: slide2, 24: ({'Spine1': d(20), 'LeftLeg': d(30), 'LeftUpLeg': d(-40)}, {'Hips': (0, -0.25, 0)}),
                       30: ({}, {})})

    # ---------------- 스탠딩 태클 ----------------
    stand = ({'Spine': d(10), 'Spine1': d(14), 'Head': d(-8),
              'RightUpLeg': d(-78), 'RightLeg': d(18), 'RightFoot': d(22),
              'LeftUpLeg': d(12), 'LeftLeg': d(52), 'LeftFoot': d(-12),
              'LeftArm': d(-35, 0, -40), 'RightArm': d(35, 0, 35), 'LeftForeArm': d(-25), 'RightForeArm': d(-25)},
             {'Hips': (0, -0.05, 0)})
    b.author('tackle', {0: ({}, {}), 5: stand, 9: stand, 16: ({'LeftLeg': d(15), 'Spine1': d(5)}, {}), 20: ({}, {})}, ground=True)

    # ---------------- 골키퍼 다이빙 (캐릭터 오른쪽), 왼쪽은 좌우 반전 ----------------
    arms_up = {'LeftArm': d(-165, 0, -8), 'RightArm': d(-165, 0, 8), 'LeftForeArm': d(-8), 'RightForeArm': d(-8)}
    dive = {
        0: ({}, {}),
        3: ({'LeftUpLeg': d(-45), 'RightUpLeg': d(-45), 'LeftLeg': d(95), 'RightLeg': d(95),
             'LeftFoot': d(-30), 'RightFoot': d(-30), 'Spine': d(12), 'Spine1': d(14), 'Head': d(-10),
             'LeftArm': d(30, 0, -10), 'RightArm': d(30, 0, 10)}, {'Hips': (0, -0.30, 0)}),
        7: ({**arms_up, 'Hips': d(0, 0, 45), 'LeftUpLeg': d(-10), 'RightUpLeg': d(15), 'LeftLeg': d(40), 'RightLeg': d(30),
             'Spine1': d(0, 0, 8), 'Head': d(-5)}, {'Hips': (-0.22, 0.02, 0)}),
        11: ({**arms_up, 'Hips': d(0, 0, 86), 'LeftUpLeg': d(-18), 'RightUpLeg': d(12), 'LeftLeg': d(55), 'RightLeg': d(20),
              'LeftFoot': d(20), 'RightFoot': d(20), 'Spine1': d(0, 0, 8), 'Head': d(-5)}, {'Hips': (-0.55, -0.12, 0)}),
        17: ({**arms_up, 'Hips': d(0, 0, 88), 'LeftUpLeg': d(-14), 'RightUpLeg': d(8), 'LeftLeg': d(60), 'RightLeg': d(25),
              'Spine1': d(0, 0, 6), 'Head': d(-5)}, {'Hips': (-0.62, -0.62, 0)}),
        27: ({**arms_up, 'Hips': d(0, 0, 88), 'LeftUpLeg': d(-14), 'RightUpLeg': d(8), 'LeftLeg': d(60), 'RightLeg': d(25),
              'Spine1': d(0, 0, 6), 'Head': d(-5)}, {'Hips': (-0.62, -0.64, 0)}),
        36: ({'LeftUpLeg': d(-60), 'RightUpLeg': d(-60), 'LeftLeg': d(110), 'RightLeg': d(110), 'Spine': d(20), 'Spine1': d(20),
              'LeftArm': d(-30, 0, -20), 'RightArm': d(-30, 0, 20)}, {'Hips': (0, -0.45, 0)}),
        44: ({}, {}),
    }
    b.author('dive_R', dive)
    b.author('dive_L', {fr: mirror_pose(r, l) for fr, (r, l) in dive.items()})

    # ---------------- 골 세리머니 ----------------
    n = 30
    b.begin('celebrate')
    for i in range(n + 1):
        t = i / n
        jump = math.sin(math.pi * t)
        crouch = (1 - jump) ** 2
        r = {}
        for side, sgn in (('Left', 1), ('Right', -1)):
            r[side + 'UpLeg'] = (-(0.15 + 0.7 * crouch), 0, 0)
            r[side + 'Leg'] = (0.25 + 1.2 * crouch, 0, 0)
            r[side + 'Foot'] = (0.3 - 0.9 * crouch * 0.5 + 0.5 * jump * 0.5, 0, 0)
            r[side + 'Arm'] = (-2.55 - 0.2 * jump, 0, 0.35 * sgn - 0.1 * jump * sgn)
            r[side + 'ForeArm'] = (-0.25 - 0.6 * (1 - jump) * 0 - 0.3 * math.sin(4 * math.pi * t + (0 if sgn > 0 else math.pi)) , 0, 0)
        r['Spine1'] = (-0.1 + 0.1 * crouch, 0, 0)
        r['Spine2'] = (-0.12, 0, 0)
        r['Head'] = (-0.25, 0, 0)
        b.frame_pose(i, r, {}, ground=True, bounce=0.32 * jump)
    b.end(loop=True)

    # ---------------- 헤딩 (공 접촉 = 10프레임) ----------------
    hd_load = ({'Hips': d(8), 'Spine': d(-4), 'Spine1': d(-6), 'Spine2': d(-8), 'Head': d(-6),
                'LeftUpLeg': d(-30), 'RightUpLeg': d(-30), 'LeftLeg': d(70), 'RightLeg': d(70), 'LeftFoot': d(-10), 'RightFoot': d(-10),
                'LeftArm': d(20, 0, -30), 'RightArm': d(20, 0, 30), 'LeftForeArm': d(-30), 'RightForeArm': d(-30)}, {})
    hd_up = ({'Spine': d(-6), 'Spine1': d(-10), 'Spine2': d(-12), 'Neck': d(-4), 'Head': d(-10),
              'LeftUpLeg': d(-20), 'RightUpLeg': d(-5), 'LeftLeg': d(80), 'RightLeg': d(55), 'LeftFoot': d(10), 'RightFoot': d(5),
              'LeftArm': d(-35, 0, -55), 'RightArm': d(-35, 0, 55), 'LeftForeArm': d(-20), 'RightForeArm': d(-20)},
             {'Hips': (0, 0.14, 0)})
    hd_hit = ({'Spine': d(3), 'Spine1': d(7), 'Spine2': d(8), 'Neck': d(4), 'Head': d(6),
               'LeftUpLeg': d(-15), 'RightUpLeg': d(-5), 'LeftLeg': d(60), 'RightLeg': d(45), 'LeftFoot': d(10), 'RightFoot': d(8),
               'LeftArm': d(-20, 0, -60), 'RightArm': d(-20, 0, 60), 'LeftForeArm': d(-25), 'RightForeArm': d(-25)},
              {'Hips': (0, 0.28, 0)})
    hd_down = ({'Spine1': d(6), 'Spine2': d(4), 'Head': d(2),
                'LeftUpLeg': d(-25), 'RightUpLeg': d(-15), 'LeftLeg': d(50), 'RightLeg': d(35),
                'LeftArm': d(-15, 0, -45), 'RightArm': d(-15, 0, 45), 'LeftForeArm': d(-25), 'RightForeArm': d(-25)},
               {'Hips': (0, 0.14, 0)})
    hd_land = ({'Hips': d(10), 'Spine1': d(10), 'Spine2': d(6), 'LeftUpLeg': d(-40), 'RightUpLeg': d(-40), 'LeftLeg': d(75), 'RightLeg': d(75),
                'LeftArm': d(-10, 0, -25), 'RightArm': d(-10, 0, 25), 'LeftForeArm': d(-30), 'RightForeArm': d(-30)}, {})
    b.begin('header')
    for fr, (r_, l_), gnd in [(0, ({}, {}), True), (4, hd_load, True), (7, hd_up, False), (10, hd_hit, False),
                              (13, hd_down, False), (18, hd_land, True), (24, ({}, {}), True)]:
        b.frame_pose(fr, r_, l_, ground=gnd)
    b.end()

    # ---------------- 개인기: 헛다리 짚기(스텝오버) ----------------
    fe1 = ({'RightUpLeg': d(-48, 0, -20), 'RightLeg': d(60), 'RightFoot': d(15), 'LeftLeg': d(25), 'LeftUpLeg': d(-10),
            'Spine1': d(6, 0, 6), 'Spine2': d(4, 0, 5), 'Hips': d(0, 0, -6), 'LeftArm': d(-10, 0, -30), 'RightArm': d(10, 0, 40)}, {'Hips': (0.02, 0, 0)})
    fe2 = ({'RightUpLeg': d(-25, 0, -38), 'RightLeg': d(35), 'RightFoot': d(10), 'LeftUpLeg': d(-18), 'LeftLeg': d(40),
            'Spine1': d(8, 0, -8), 'Spine2': d(4, 0, -6), 'Hips': d(0, 0, 8), 'LeftArm': d(-5, 0, -45), 'RightArm': d(5, 0, 25)}, {'Hips': (-0.06, 0, 0)})
    fe3 = ({'LeftUpLeg': d(-34, 0, -12), 'LeftLeg': d(55), 'LeftFoot': d(12), 'RightUpLeg': d(-10), 'RightLeg': d(30),
            'Spine1': d(10, 0, -4), 'Spine2': d(6), 'Hips': d(0, 8, 0), 'LeftArm': d(-15, 0, -35), 'RightArm': d(15, 0, 30)}, {})
    b.author('feint', {0: ({}, {}), 4: fe1, 7: fe2, 11: fe3, 16: ({}, {})}, ground=True)

    # ---------------- 골 세리머니 2: 주먹 흔들기 / 무릎 슬라이딩 ----------------
    n = 21
    b.begin('celebrate_pump')
    for i in range(n + 1):
        phi = 2 * math.pi * i / n
        sn = math.sin(phi)
        r = {}
        for side, sgn in (('Left', 1), ('Right', -1)):
            r[side + 'UpLeg'] = (-(0.20 + 0.10 * math.cos(2 * phi)), 0, 0)
            r[side + 'Leg'] = (0.40 + 0.20 * math.cos(2 * phi), 0, 0)
            r[side + 'Foot'] = (0.15, 0, 0)
            r[side + 'Arm'] = (-1.9 + 0.5 * sn * sgn, 0, 0.30 * sgn)
            r[side + 'ForeArm'] = (-1.55 + 0.25 * sn * sgn, 0, 0)
        r['Spine1'] = (-0.06, 0.10 * sn, 0)
        r['Spine2'] = (-0.14, 0.10 * sn, 0)
        r['Head'] = (-0.28, -0.12 * sn, 0)
        b.frame_pose(i, r, {}, ground=True, bounce=0.07 * (1 - math.cos(2 * phi)) / 2)
    b.end(loop=True)
    cs = ({'Spine': d(-8), 'Spine1': d(-16), 'Spine2': d(-14), 'Head': d(-24),
           'LeftUpLeg': d(-4), 'RightUpLeg': d(-4), 'LeftLeg': d(150), 'RightLeg': d(150), 'LeftFoot': d(35), 'RightFoot': d(35),
           'LeftArm': d(20, 0, -75), 'RightArm': d(20, 0, 75), 'LeftForeArm': d(-10), 'RightForeArm': d(-10)}, {})
    cs2 = ({**cs[0], 'Spine1': d(-20), 'Head': d(-28), 'LeftArm': d(5, 0, -85), 'RightArm': d(5, 0, 85)}, {})
    b.begin('celebrate_slide')
    for fr, (r_, l_), gnd in [(0, ({}, {}), True), (7, cs, True), (16, cs2, True), (26, cs2, True), (34, ({'Spine1': d(6)}, {}), True)]:
        b.frame_pose(fr, r_, l_, ground=gnd)
    b.end()

    # ---------------- 스로인 / 골키퍼 ----------------
    throw = {'LeftArm': d(-168, 0, -12), 'RightArm': d(-168, 0, 12), 'LeftForeArm': d(-40), 'RightForeArm': d(-40),
             'Spine': d(-6), 'Spine1': d(-8), 'Spine2': d(-8), 'Head': d(-12),
             'LeftUpLeg': d(-8), 'RightUpLeg': d(-8), 'LeftLeg': d(14), 'RightLeg': d(14)}
    b.author('throw_in', {0: (throw, {}), 2: (throw, {})}, ground=True, loop=True)

    hold = {'LeftArm': d(-45, 0, 8), 'RightArm': d(-45, 0, -8), 'LeftForeArm': d(-100, 0, -25), 'RightForeArm': d(-100, 0, 25),
            'Spine1': d(6), 'Spine2': d(6), 'Head': d(-6),
            'LeftUpLeg': d(-10), 'RightUpLeg': d(-10), 'LeftLeg': d(22), 'RightLeg': d(22)}
    b.author('gk_hold', {0: (hold, {}), 2: (hold, {})}, ground=True, loop=True)

    n = 48
    b.begin('gk_ready')
    for i in range(n + 1):
        phi = 2 * math.pi * i / n
        s = math.sin(phi)
        r = {}
        for side, sgn in (('Left', 1), ('Right', -1)):
            r[side + 'UpLeg'] = (-(0.55 + 0.04 * s), 0, -0.24 * sgn)
            r[side + 'Leg'] = (1.05 + 0.05 * s, 0, 0)
            r[side + 'Foot'] = (-0.40, 0, 0)
            r[side + 'Arm'] = (-0.55 + 0.05 * s, 0, -0.60 * sgn)
            r[side + 'ForeArm'] = (-0.85, 0, 0)
        r['Spine'] = (0.12, 0, 0)
        r['Spine1'] = (0.12, 0, 0)
        r['Spine2'] = (0.10 + 0.01 * s, 0, 0)
        r['Head'] = (-0.32, 0, 0)
        b.frame_pose(i, r, {}, ground=True)
    b.end(loop=True)

    # ---------------- 골키퍼: 선방 / 던지기 ----------------
    # 가슴 높이 공 잡기: 몸을 앞으로 던지며 팔을 뻗어 받은 뒤 가슴에 끌어안음
    g_hold = {'LeftArm': d(-45, 0, 8), 'RightArm': d(-45, 0, -8), 'LeftForeArm': d(-100, 0, -25), 'RightForeArm': d(-100, 0, 25),
              'Spine1': d(6), 'Spine2': d(6), 'Head': d(-6), 'LeftUpLeg': d(-10), 'RightUpLeg': d(-10), 'LeftLeg': d(22), 'RightLeg': d(22)}
    c_pre = ({'LeftUpLeg': d(-30, 0, -14), 'RightUpLeg': d(-30, 0, 14), 'LeftLeg': d(60), 'RightLeg': d(60), 'LeftFoot': d(-20), 'RightFoot': d(-20),
              'Spine': d(8), 'Spine1': d(10), 'Spine2': d(8), 'Head': d(-10),
              'LeftArm': d(-35, 0, -35), 'RightArm': d(-35, 0, 35), 'LeftForeArm': d(-50), 'RightForeArm': d(-50)}, {})
    c_reach = ({'LeftUpLeg': d(-48, 0, -10), 'RightUpLeg': d(-16, 0, 10), 'LeftLeg': d(58), 'RightLeg': d(24), 'LeftFoot': d(-14),
                'Spine': d(12), 'Spine1': d(16), 'Spine2': d(12), 'Head': d(-18),
                'LeftArm': d(-88, 0, -12), 'RightArm': d(-88, 0, 12), 'LeftForeArm': d(-6), 'RightForeArm': d(-6)}, {'Hips': (0, -0.05, 0.10)})
    b.author('gk_catch', {0: ({}, {}), 3: c_pre, 6: c_reach, 9: c_reach, 14: (g_hold, {}), 18: (g_hold, {})}, ground=True)
    # 높은 공 점프 캐치/펀칭: 도약해서 팔을 위로 뻗음
    j_arm = {'LeftArm': d(-172, 0, -10), 'RightArm': d(-172, 0, 10), 'LeftForeArm': d(-6), 'RightForeArm': d(-6)}
    j_crouch = ({'LeftUpLeg': d(-42), 'RightUpLeg': d(-42), 'LeftLeg': d(88), 'RightLeg': d(88), 'LeftFoot': d(-25), 'RightFoot': d(-25),
                 'Spine': d(10), 'Spine1': d(14), 'Spine2': d(8), 'LeftArm': d(30, 0, -20), 'RightArm': d(30, 0, 20), 'LeftForeArm': d(-30), 'RightForeArm': d(-30)}, {})
    j_up = ({**j_arm, 'LeftUpLeg': d(-6), 'RightUpLeg': d(-62), 'LeftLeg': d(10), 'RightLeg': d(95), 'LeftFoot': d(30), 'RightFoot': d(10),
             'Spine': d(-1), 'Spine1': d(-2), 'Spine2': d(-3), 'Head': d(-4)}, {})
    j_down = ({**j_arm, 'LeftUpLeg': d(-12), 'RightUpLeg': d(-40), 'LeftLeg': d(18), 'RightLeg': d(70), 'Spine1': d(-4), 'Head': d(-6)}, {})
    j_land = ({'LeftUpLeg': d(-40), 'RightUpLeg': d(-40), 'LeftLeg': d(80), 'RightLeg': d(80), 'Spine1': d(14), 'Spine2': d(10),
               'LeftArm': d(-60, 0, -10), 'RightArm': d(-60, 0, 10), 'LeftForeArm': d(-70), 'RightForeArm': d(-70)}, {})
    b.begin('gk_jump')
    for fr, (r_, l_), gnd, bo in [(0, ({}, {}), True, 0), (4, j_crouch, True, 0), (7, j_up, False, 0.30), (11, j_up, False, 0.50),
                                  (15, j_down, False, 0.30), (19, j_land, True, 0), (25, (g_hold, {}), True, 0)]:
        b.frame_pose(fr, r_, l_, ground=gnd, bounce=bo)
    b.end()
    # 낮은 공 막기: 무릎을 굽히고 몸을 숙여 손으로 쓸어 담음
    l_dip = ({'LeftUpLeg': d(-58, 0, -14), 'RightUpLeg': d(-44, 0, 14), 'LeftLeg': d(88), 'RightLeg': d(80), 'LeftFoot': d(10), 'RightFoot': d(5),
              'Spine': d(14), 'Spine1': d(24), 'Spine2': d(14), 'Head': d(-26),
              'LeftArm': d(-50, 0, -14), 'RightArm': d(-50, 0, 14), 'LeftForeArm': d(-12), 'RightForeArm': d(-12)}, {'Hips': (0, -0.06, 0.06)})
    l_scoop = ({**l_dip[0], 'Spine1': d(40), 'LeftArm': d(-20, 0, -8), 'RightArm': d(-20, 0, 8)}, l_dip[1])
    b.author('gk_low', {0: ({}, {}), 4: l_dip, 7: l_scoop, 12: l_dip, 18: (g_hold, {}), 22: (g_hold, {})}, ground=True)
    # 오버핸드 던지기 (오른손, 공을 놓는 순간 = 9프레임 = 0.3초): 가슴에서 뒤로 젖혔다가 몸을 돌리며 던짐
    t_back = ({'Spine': d(-4, 0, 0), 'Spine1': d(-8, 22, 0), 'Spine2': d(-8, 26, 0), 'Head': d(-6, -18, 0),
               'RightArm': d(-20, 0, 78), 'RightForeArm': d(-105), 'LeftArm': d(-70, 0, -18), 'LeftForeArm': d(-20),
               'LeftUpLeg': d(-30), 'RightUpLeg': d(12), 'LeftLeg': d(40), 'RightLeg': d(40), 'Hips': d(0, -14, 0)}, {})
    t_rel = ({'Spine': d(6), 'Spine1': d(14, -26, 0), 'Spine2': d(10, -22, 0), 'Head': d(4, 14, 0),
              'RightArm': d(-150, 0, 22), 'RightForeArm': d(-14), 'LeftArm': d(20, 0, -50), 'LeftForeArm': d(-40),
              'LeftUpLeg': d(-48), 'RightUpLeg': d(18), 'LeftLeg': d(30), 'RightLeg': d(30), 'Hips': d(0, 18, 0)}, {})
    t_follow = ({'Spine': d(10), 'Spine1': d(24, -18, 0), 'Spine2': d(14, -12, 0), 'Head': d(6),
                 'RightArm': d(-40, 0, 14), 'RightForeArm': d(-30), 'LeftArm': d(10, 0, -40), 'LeftForeArm': d(-30),
                 'LeftUpLeg': d(-30), 'RightUpLeg': d(10), 'LeftLeg': d(30), 'RightLeg': d(24), 'Hips': d(0, 10, 0)}, {})
    b.author('gk_throw', {0: (g_hold, {}), 5: t_back, 9: t_rel, 14: t_follow, 22: ({}, {})}, ground=True)

    # ---------------- 태클 당해서 넘어짐 / 휘청임 ----------------
    def two(rl, ar, ar2=None):
        return {**rl, 'LeftArm': d(ar[0], 0, -ar[1]), 'RightArm': d(ar[0], 0, ar[1]), 'LeftForeArm': d(ar[2]), 'RightForeArm': d(ar[2])}
    f_trip = ({**two({}, (-20, 50, -25)), 'Hips': d(-6), 'Spine1': d(-12), 'Spine2': d(-8), 'Head': d(-8),
               'RightUpLeg': d(-58), 'RightLeg': d(35), 'LeftUpLeg': d(12), 'LeftLeg': d(30)}, {})
    f_pitch = ({**two({}, (-125, 14, -15)), 'Hips': d(38), 'Spine1': d(22), 'Spine2': d(10), 'Head': d(-24),
                'LeftUpLeg': d(26), 'LeftLeg': d(44), 'RightUpLeg': d(8), 'RightLeg': d(60)}, {'Hips': (0, -0.20, 0.08)})
    f_down = ({**two({}, (-150, 12, -8)), 'Hips': d(82), 'Spine': d(4), 'Spine1': d(4), 'Head': d(-40),
               'LeftUpLeg': d(8), 'LeftLeg': d(14), 'LeftFoot': d(40), 'RightUpLeg': d(4), 'RightLeg': d(26), 'RightFoot': d(40)}, {'Hips': (0, -0.50, 0.26)})
    f_push = ({**two({}, (-60, 26, -40)), 'Hips': d(40), 'Spine1': d(-6), 'Head': d(-22),
               'LeftUpLeg': d(-95), 'LeftLeg': d(112), 'RightUpLeg': d(-20), 'RightLeg': d(100), 'RightFoot': d(35)}, {'Hips': (0, -0.26, 0.10)})
    b.author('fall', {0: ({}, {}), 4: f_trip, 8: f_pitch, 13: f_down, 28: f_down, 36: f_push, 44: ({'Spine1': d(8)}, {})}, ground=False)
    st1 = ({**two({}, (-55, 52, -20)), 'Spine1': d(20), 'Spine2': d(8), 'Hips': d(10), 'Head': d(-12),
            'LeftUpLeg': d(-52), 'LeftLeg': d(60), 'RightUpLeg': d(18), 'RightLeg': d(30)}, {})
    st2 = ({**two({}, (-30, 40, -30)), 'Spine1': d(10), 'Hips': d(4), 'RightUpLeg': d(-40), 'RightLeg': d(55), 'LeftUpLeg': d(8), 'LeftLeg': d(25)}, {})
    b.author('stumble', {0: ({}, {}), 4: st1, 9: st2, 15: ({'Spine1': d(4)}, {}), 20: ({}, {})}, ground=True)

    # ---------------- 추가 동작: 짧은 패스 / 발리슛 / 가슴 트래핑 / 낙담 / 손 허리 / 키퍼 펀트 ----------------
    # 인사이드 짧은 패스 (공 접촉 = 5프레임): 슛보다 작고 빠른 스윙
    b.author('pass', {
        0: ({}, {}),
        3: ({'RightUpLeg': d(22), 'RightLeg': d(55), 'RightFoot': d(10), 'LeftUpLeg': d(-14), 'LeftLeg': d(28), 'Spine1': d(5), 'Hips': d(0, -6, 0),
             'LeftArm': d(-22, 0, -38), 'RightArm': d(12, 0, 32), 'LeftForeArm': d(-25), 'RightForeArm': d(-25)}, {}),
        5: ({'RightUpLeg': d(-38), 'RightLeg': d(14), 'RightFoot': d(18), 'LeftUpLeg': d(-12), 'LeftLeg': d(30), 'Spine1': d(9, -6, 0), 'Hips': d(0, 8, 0),
             'LeftArm': d(-18, 0, -42), 'RightArm': d(14, 0, 36), 'LeftForeArm': d(-25), 'RightForeArm': d(-25)}, {}),
        9: ({'RightUpLeg': d(-50), 'RightLeg': d(10), 'LeftLeg': d(22), 'Spine1': d(7), 'Hips': d(0, 6, 0), 'LeftArm': d(-12, 0, -30), 'RightArm': d(8, 0, 26)}, {}),
        15: ({'RightUpLeg': d(-16), 'RightLeg': d(24), 'LeftLeg': d(14), 'Spine1': d(3)}, {}),
        18: ({}, {}),
    }, ground=True)
    # 공중볼 발리슛 (공 접촉 = 8프레임): 몸을 옆으로 눕히며 다리를 높이 휘두름
    v_load = ({'RightUpLeg': d(25), 'RightLeg': d(80), 'LeftUpLeg': d(-30), 'LeftLeg': d(48), 'Hips': d(0, -10, 14), 'Spine1': d(0, -8, -10), 'Spine2': d(-4, 0, -8),
               'LeftArm': d(-40, 0, -70), 'RightArm': d(10, 0, 60), 'LeftForeArm': d(-20), 'RightForeArm': d(-20), 'Head': d(6)}, {'Hips': (0, 0.06, 0)})
    v_hit = ({'RightUpLeg': d(-82), 'RightLeg': d(8), 'RightFoot': d(30), 'LeftUpLeg': d(-18), 'LeftLeg': d(36), 'Hips': d(0, 14, 24), 'Spine1': d(6, -12, -16), 'Spine2': d(0, 0, -10),
              'LeftArm': d(-30, 0, -80), 'RightArm': d(20, 0, 70), 'LeftForeArm': d(-20), 'RightForeArm': d(-20), 'Head': d(8)}, {'Hips': (0, 0.20, 0)})
    v_after = ({**v_hit[0], 'RightUpLeg': d(-60), 'RightLeg': d(40), 'Hips': d(0, 12, 28)}, {'Hips': (0, 0.14, 0)})
    v_land = ({'RightUpLeg': d(-30), 'RightLeg': d(55), 'LeftUpLeg': d(-28), 'LeftLeg': d(60), 'Spine1': d(8), 'LeftArm': d(-15, 0, -40), 'RightArm': d(12, 0, 38)}, {})
    b.begin('volley')
    for fr, (r_, l_), gnd in [(0, ({}, {}), True), (4, v_load, False), (8, v_hit, False), (12, v_after, False), (17, v_land, True), (24, ({}, {}), True)]:
        b.frame_pose(fr, r_, l_, ground=gnd)
    b.end()
    # 가슴 트래핑 (공 접촉 = 4프레임): 가슴을 내밀어 공을 죽이고 몸을 접음
    b.author('chest_trap', {
        0: ({}, {}),
        3: ({'Spine': d(-6), 'Spine1': d(-12), 'Spine2': d(-10), 'Head': d(-14), 'LeftArm': d(8, 0, -62), 'RightArm': d(8, 0, 62), 'LeftForeArm': d(-30), 'RightForeArm': d(-30),
             'LeftUpLeg': d(-16), 'RightUpLeg': d(-10), 'LeftLeg': d(34), 'RightLeg': d(22)}, {}),
        6: ({'Spine': d(4), 'Spine1': d(14), 'Spine2': d(10), 'Head': d(8), 'LeftArm': d(-18, 0, -40), 'RightArm': d(-18, 0, 40), 'LeftForeArm': d(-50), 'RightForeArm': d(-50),
             'LeftUpLeg': d(-22), 'RightUpLeg': d(-18), 'LeftLeg': d(44), 'RightLeg': d(36)}, {}),
        12: ({'Spine1': d(5), 'LeftLeg': d(18), 'RightLeg': d(16)}, {}),
        16: ({}, {}),
    }, ground=True)
    # 낙담 (실점/놓침): 손으로 머리를 감싸고 고개를 숙임 (반복)
    dej = {'Spine': d(8), 'Spine1': d(14), 'Spine2': d(8), 'Head': d(24), 'LeftArm': d(-150, 0, -26), 'RightArm': d(-150, 0, 26), 'LeftForeArm': d(-115), 'RightForeArm': d(-115),
           'LeftUpLeg': d(-8), 'RightUpLeg': d(-8), 'LeftLeg': d(14), 'RightLeg': d(14)}
    dej2 = {**dej, 'Spine1': d(18), 'Head': d(30), 'Hips': d(2)}
    b.author('dejected', {0: (dej, {}), 12: (dej2, {}), 24: (dej, {})}, ground=True, loop=True)
    # 숨 고르기 (재시작 대기 중): 상체를 숙이고 손을 무릎에 얹음 (반복, 숨쉬는 흔들림)
    hips1 = {'Spine': d(16), 'Spine1': d(26), 'Spine2': d(14), 'Head': d(-16), 'LeftArm': d(-18, 0, -10), 'RightArm': d(-18, 0, 10), 'LeftForeArm': d(-8), 'RightForeArm': d(-8),
             'LeftUpLeg': d(-32, 0, -6), 'RightUpLeg': d(-32, 0, 6), 'LeftLeg': d(46), 'RightLeg': d(46), 'LeftFoot': d(-10), 'RightFoot': d(-10)}
    hips2 = {**hips1, 'Spine1': d(31), 'Spine2': d(17), 'Head': d(-20)}
    b.author('hips', {0: (hips1, {}), 30: (hips2, {}), 60: (hips1, {})}, ground=True, loop=True)
    # 키퍼 펀트 (손에서 떨어뜨려 차기, 공 접촉 = 8프레임)
    p_hold = {'LeftArm': d(-45, 0, 8), 'RightArm': d(-45, 0, -8), 'LeftForeArm': d(-100, 0, -25), 'RightForeArm': d(-100, 0, 25), 'Spine1': d(6), 'Spine2': d(6), 'Head': d(-6),
              'LeftUpLeg': d(-10), 'RightUpLeg': d(-10), 'LeftLeg': d(22), 'RightLeg': d(22)}
    b.author('gk_punt', {
        0: (p_hold, {}),
        4: ({'LeftArm': d(-62, 0, -8), 'RightArm': d(-62, 0, 8), 'LeftForeArm': d(-30), 'RightForeArm': d(-30), 'RightUpLeg': d(18), 'RightLeg': d(40), 'LeftUpLeg': d(-14), 'LeftLeg': d(30),
             'Spine1': d(8), 'Hips': d(0, -6, 0)}, {}),
        8: ({'RightUpLeg': d(-84), 'RightLeg': d(6), 'RightFoot': d(28), 'LeftUpLeg': d(-14), 'LeftLeg': d(34), 'LeftArm': d(-20, 0, -62), 'RightArm': d(12, 0, 52), 'Spine1': d(-6, 10, 0),
             'Spine2': d(-4), 'Hips': d(0, 14, 0), 'Head': d(4)}, {}),
        13: ({'RightUpLeg': d(-96), 'RightLeg': d(14), 'LeftLeg': d(30), 'LeftArm': d(-14, 0, -56), 'RightArm': d(14, 0, 48), 'Spine1': d(-4), 'Hips': d(0, 10, 0)}, {}),
        20: ({'RightUpLeg': d(-30), 'RightLeg': d(40)}, {}),
        24: ({}, {}),
    }, ground=True)

    # ---------------- 추가 동작 2: 크로스(긴 킥) / 몸으로 공 지키기 / 세리머니 2종 ----------------
    # 크로스·롱패스 (공 접촉 = 6프레임): 큰 백스윙, 몸을 젖히며 높이 차올림
    b.author('cross', {
        0: ({}, {}),
        4: ({'RightUpLeg': d(34), 'RightLeg': d(78), 'RightFoot': d(10), 'LeftUpLeg': d(-14), 'LeftLeg': d(30), 'Spine1': d(-4), 'Hips': d(0, -10, 0),
             'LeftArm': d(-32, 0, -52), 'RightArm': d(18, 0, 46), 'LeftForeArm': d(-25), 'RightForeArm': d(-25), 'Head': d(6)}, {}),
        6: ({'RightUpLeg': d(-56), 'RightLeg': d(16), 'RightFoot': d(34), 'LeftUpLeg': d(-16), 'LeftLeg': d(32), 'Spine1': d(-8, -10, 0), 'Hips': d(0, 14, 0),
             'LeftArm': d(-26, 0, -60), 'RightArm': d(22, 0, 52), 'Head': d(4)}, {}),
        10: ({'RightUpLeg': d(-86), 'RightLeg': d(8), 'RightFoot': d(30), 'LeftUpLeg': d(-12), 'LeftLeg': d(26), 'Spine1': d(-10, -14, 0), 'Hips': d(0, 20, 0),
              'LeftArm': d(-18, 0, -66), 'RightArm': d(26, 0, 58)}, {}),
        16: ({'RightUpLeg': d(-40), 'RightLeg': d(36), 'LeftLeg': d(16), 'Spine1': d(-2)}, {}),
        22: ({}, {}),
    }, ground=True)
    # 몸으로 공 지키기: 몸을 숙이고 한쪽 팔을 벌려 수비수를 막음 (반복)
    sh1 = {'Spine': d(8), 'Spine1': d(20), 'Spine2': d(10), 'Head': d(-10), 'Hips': d(0, 0, 4),
           'LeftArm': d(8, 0, -88), 'LeftForeArm': d(-28), 'RightArm': d(-38, 0, 28), 'RightForeArm': d(-70),
           'LeftUpLeg': d(-30, 0, -18), 'RightUpLeg': d(-34, 0, 14), 'LeftLeg': d(54), 'RightLeg': d(60), 'LeftFoot': d(-12), 'RightFoot': d(-14)}
    sh2 = {**sh1, 'Hips': d(0, 0, -4), 'Spine1': d(23), 'LeftArm': d(10, 0, -92)}
    b.author('shield', {0: (sh1, {}), 14: (sh2, {}), 28: (sh1, {})}, ground=True, loop=True)
    # 세리머니: 비행기 (팔을 활짝, 몸을 좌우로 기울임)
    pl1 = {'LeftArm': d(0, 0, -86), 'RightArm': d(0, 0, 86), 'LeftForeArm': d(-6), 'RightForeArm': d(-6), 'Spine1': d(6, 0, 12), 'Spine2': d(2, 0, 8), 'Head': d(-6, 0, -6),
           'LeftUpLeg': d(-14), 'RightUpLeg': d(-14), 'LeftLeg': d(26), 'RightLeg': d(26)}
    pl2 = {**pl1, 'Spine1': d(6, 0, -12), 'Spine2': d(2, 0, -8), 'Head': d(-6, 0, 6)}
    b.author('celebrate_plane', {0: (pl1, {}), 12: (pl2, {}), 24: (pl1, {})}, ground=True, loop=True)
    # 세리머니: 하늘 가리키기 (한 손은 위로, 한 손은 가슴에)
    sk1 = {'RightArm': d(-176, 0, -4), 'RightForeArm': d(-4), 'LeftArm': d(-40, 0, 12), 'LeftForeArm': d(-112), 'Head': d(-34), 'Spine': d(-4), 'Spine1': d(-8), 'Spine2': d(-6),
           'LeftUpLeg': d(-12), 'RightUpLeg': d(-12), 'LeftLeg': d(22), 'RightLeg': d(22)}
    sk2 = {**sk1, 'Head': d(-28), 'Spine1': d(-5), 'RightArm': d(-168, 0, -6)}
    b.author('celebrate_sky', {0: (sk1, {}), 15: (sk2, {}), 30: (sk1, {})}, ground=True, loop=True)

    # ---------------- 메타데이터 저장 ----------------
    meta_path = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'public', 'models', 'player_meta.json'))
    os.makedirs(os.path.dirname(meta_path), exist_ok=True)
    with open(meta_path, 'w', encoding='utf-8') as f:
        json.dump({'clips': b.meta, 'fps': FPS}, f, ensure_ascii=False, indent=1)
    print("CLIPS", json.dumps(b.meta))
    # 마지막 상태 초기화
    b.ad.use_nla = True
    b.set_pose({}, {})
