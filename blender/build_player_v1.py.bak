"""축구 선수 모델 생성 (Blender 5.x, 명령줄 실행)

  blender -b --factory-startup -P blender/build_player.py

만드는 것:
  1) Skin 모디파이어로 만든 매끈한 사람 몸 (발목/발가락 관절 포함)
  2) 뼈대(Armature)와 스킨 가중치
  3) 부위별 재질 슬롯 (Skin/Jersey/Shorts/Socks/Boots/Hair/Trim/Gloves/Eyes) → 게임에서 팀 색으로 바꿔 입힘
  4) 동작 (blender/animations.py)
  결과: blender/player.blend, public/models/player.glb
좌표: Blender는 Z가 위, 캐릭터는 -Y를 바라봄 (glTF로 내보내면 +Z를 바라봄). 캐릭터의 왼쪽 = +X.
"""
import bpy, bmesh, math, os, sys
from mathutils import Vector, Matrix

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
BLEND = os.path.join(HERE, "player.blend")
GLB = os.path.normpath(os.path.join(HERE, "..", "public", "models", "player.glb"))

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.render.fps = 30

# ============================================================
# 1. 몸 (Skin 모디파이어)
# ============================================================
V = {}          # 이름 -> (위치, (반지름x, 반지름y))
EDGES = []


def vtx(name, x, y, z, rx, ry=None):
    V[name] = (Vector((x, y, z)), (rx, rx if ry is None else ry))


vtx('pelvis', 0, 0, 0.98, 0.155, 0.115)
vtx('waist', 0, 0, 1.10, 0.135, 0.105)
vtx('chest', 0, -0.006, 1.27, 0.178, 0.122)
vtx('ctop', 0, 0, 1.41, 0.185, 0.108)
vtx('neck', 0, 0, 1.51, 0.062)
vtx('head', 0, -0.006, 1.692, 0.102, 0.108)
vtx('headtop', 0, -0.006, 1.762, 0.078, 0.088)
EDGES += [('pelvis', 'waist'), ('waist', 'chest'), ('chest', 'ctop'), ('ctop', 'neck'),
          ('neck', 'head'), ('head', 'headtop')]
for side, sx in (('L', 1), ('R', -1)):
    vtx('sh' + side, sx * 0.205, 0, 1.425, 0.060)
    vtx('el' + side, sx * 0.335, 0, 1.16, 0.047)
    vtx('wr' + side, sx * 0.450, -0.05, 0.915, 0.037)
    vtx('hd' + side, sx * 0.492, -0.062, 0.835, 0.042)
    vtx('hp' + side, sx * 0.095, 0, 0.93, 0.105)
    vtx('th' + side, sx * 0.099, -0.01, 0.72, 0.095)
    vtx('kn' + side, sx * 0.100, -0.02, 0.50, 0.064)
    vtx('an' + side, sx * 0.105, 0.0, 0.105, 0.046)
    vtx('toe' + side, sx * 0.105, -0.17, 0.050, 0.047)
    vtx('heel' + side, sx * 0.105, 0.070, 0.056, 0.040)
    EDGES += [('ctop', 'sh' + side), ('sh' + side, 'el' + side), ('el' + side, 'wr' + side), ('wr' + side, 'hd' + side),
              ('pelvis', 'hp' + side), ('hp' + side, 'th' + side), ('th' + side, 'kn' + side), ('kn' + side, 'an' + side),
              ('an' + side, 'toe' + side), ('an' + side, 'heel' + side)]

bm = bmesh.new()
skin = bm.verts.layers.skin.verify()
vm = {}
for n, (p, (rx, ry)) in V.items():
    v = bm.verts.new(p)
    v[skin].radius = (rx, ry)
    vm[n] = v
for a, b in EDGES:
    bm.edges.new((vm[a], vm[b]))
vm['pelvis'][skin].use_root = True
me0 = bpy.data.meshes.new('SkinBase')
bm.to_mesh(me0)
bm.free()
base = bpy.data.objects.new('SkinBase', me0)
scene.collection.objects.link(base)
m = base.modifiers.new('Skin', 'SKIN')
m.use_x_symmetry = m.use_y_symmetry = m.use_z_symmetry = False
m.branch_smoothing = 0.5
m.use_smooth_shade = True
s = base.modifiers.new('Subsurf', 'SUBSURF')
s.levels = 2
s.render_levels = 2
dg = bpy.context.evaluated_depsgraph_get()
body = bpy.data.meshes.new_from_object(base.evaluated_get(dg))
bpy.data.objects.remove(base)

# ============================================================
# 2. 부위별 재질 배정 (가장 가까운 뼈대 선분 + 선분 위의 위치로 판단)
# ============================================================
MATS = ['Skin', 'Jersey', 'Shorts', 'Socks', 'Boots', 'Hair', 'Trim', 'Gloves', 'Eyes', 'Sclera', 'Lips', 'Brow', 'Beard']
MI = {n: i for i, n in enumerate(MATS)}
SEG = {}  # 선분 이름 -> (a, b, 그룹)
GROUP_BY_PREFIX = {'sh': 'uarm', 'el': 'farm', 'wr': 'hand', 'hp': 'thigh', 'th': 'thigh', 'kn': 'shin', 'an': 'foot'}
for a, b in EDGES:
    g = {'pelvis-waist': 'torso', 'waist-chest': 'torso', 'chest-ctop': 'torso', 'ctop-neck': 'neck',
         'neck-head': 'neck', 'head-headtop': 'head'}.get(a + '-' + b)
    if g is None:
        g = 'clav' if a == 'ctop' else 'hip' if a == 'pelvis' else GROUP_BY_PREFIX[a[:2]]
    SEG[a + '-' + b] = (V[a][0], V[b][0], g)


def seg_dist(c, a, b):
    ab = b - a
    t = max(0.0, min(1.0, (c - a).dot(ab) / max(ab.length_squared, 1e-9)))
    return (c - (a + ab * t)).length, t


WAIST_Z, HEM_Z, COLLAR = 1.05, 0.70, (1.485, 1.548)


def material_for(c):
    best = None
    for k, (a, b, g) in SEG.items():
        d, t = seg_dist(c, a, b)
        if best is None or d < best[0]:
            best = (d, t, g)
    _, t, g = best
    z = c.z
    if z > 1.62:                                   # 머리
        return 'Hair' if (z > 1.745 or (c.y > 0.035 and z > 1.665)) else 'Skin'
    if COLLAR[0] < z < COLLAR[1] and g in ('torso', 'clav', 'neck'):
        return 'Trim'                              # 목깃
    if g == 'neck':
        return 'Jersey' if z < COLLAR[0] else 'Skin'
    if g in ('torso', 'clav', 'hip') and z > WAIST_Z:
        return 'Jersey'
    if g in ('torso', 'hip'):
        return 'Shorts'
    if g == 'uarm':
        return 'Jersey' if t < 0.55 else ('Trim' if t < 0.66 else 'Skin')
    if g == 'farm':
        return 'Skin'
    if g == 'hand':
        return 'Gloves'
    if g == 'thigh':
        return 'Shorts' if z > HEM_Z else 'Skin'
    if g == 'shin':
        if z < 0.122:
            return 'Boots'
        return 'Skin' if t < 0.10 else ('Trim' if t < 0.18 else 'Socks')
    return 'Boots'


bm = bmesh.new()
bm.from_mesh(body)
# 기존의 단순한 머리(스킨 모디파이어로 만든 덩어리)는 지우고, head.py의 얼굴 있는 머리로 대체
doomed = [f for f in bm.faces if f.calc_center_median().z > 1.552]
bmesh.ops.delete(bm, geom=doomed, context='FACES')
bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context='VERTS')


def all_geom():
    return list(bm.verts) + list(bm.edges) + list(bm.faces)


def cut_plane(co, no, geom=None):
    bmesh.ops.bisect_plane(bm, geom=geom if geom is not None else all_geom(), dist=1e-5,
                           plane_co=Vector(co), plane_no=Vector(no))


# 가로 경계: 허리, 반바지 끝단, 신발 윗선, 목깃, 양말 줄무늬
for z in (WAIST_Z, HEM_Z, 0.122, COLLAR[0], COLLAR[1],
          V['knL'][0].z + (V['anL'][0].z - V['knL'][0].z) * 0.10,
          V['knL'][0].z + (V['anL'][0].z - V['knL'][0].z) * 0.18):
    cut_plane((0, 0, z), (0, 0, 1))
# 소매 끝단: 팔 축에 수직인 면으로, 팔 쪽 면만 자름
for sx, sd in ((1, 'L'), (-1, 'R')):
    a, e = V['sh' + sd][0], V['el' + sd][0]
    axis = (e - a).normalized()
    for t in (0.55, 0.66):
        side_faces = [f for f in bm.faces if sx * f.calc_center_median().x > 0.215]
        geom = list(side_faces) + list({ed for f in side_faces for ed in f.edges}) + list({v for f in side_faces for v in f.verts})
        cut_plane(a + (e - a) * t, axis, geom)
bm.faces.ensure_lookup_table()
for f in bm.faces:
    f.material_index = MI[material_for(f.calc_center_median())]


def add_ball(name, center, radius, scale, mat):
    r = bmesh.ops.create_uvsphere(bm, u_segments=14, v_segments=10, radius=radius)
    vs = r["verts"]
    M = Matrix.Translation(Vector(center)) @ Matrix.Diagonal((scale[0], scale[1], scale[2], 1.0))
    bmesh.ops.transform(bm, matrix=M, verts=vs)
    for f in {f for v in vs for f in v.link_faces}:
        f.material_index = MI[mat]


# 머리(얼굴/눈/눈썹/귀/입술/목): head.py
import head as headmod
tag_layer = bm.verts.layers.int.new('headpart')      # 1 = 머리뼈에 100% 붙는 부위, 2 = 목(몸과 부드럽게 이어짐)
headmod.head_base(bm, MI, tag_layer)

mesh = bpy.data.meshes.new('Player')
bm.to_mesh(mesh)
bm.free()
for p in mesh.polygons:
    p.use_smooth = True


def mk_mat(name, hex_color, rough=0.7):
    col = [int(hex_color[i:i + 2], 16) / 255 for i in (1, 3, 5)]
    lin = [c ** 2.2 for c in col]
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = next(n for n in mat.node_tree.nodes if n.type == 'BSDF_PRINCIPLED')
    bsdf.inputs['Base Color'].default_value = (*lin, 1)
    bsdf.inputs['Roughness'].default_value = rough
    mat.diffuse_color = (*lin, 1)
    return mat


PREVIEW = {'Skin': '#d9a066', 'Jersey': '#d62828', 'Shorts': '#f8fafc', 'Socks': '#d62828', 'Boots': '#111827',
           'Hair': '#2b1d14', 'Trim': '#f8fafc', 'Gloves': '#d9a066', 'Eyes': '#2a1a10', 'Sclera': '#f1efe9',
           'Lips': '#b8625a', 'Brow': '#2b1d14', 'Beard': '#2b1d14'}
MAT_OBJ = {}
for n in MATS:
    MAT_OBJ[n] = mk_mat(n, PREVIEW[n], 0.35 if n in ('Boots', 'Eyes', 'Sclera') else 0.75)
    mesh.materials.append(MAT_OBJ[n])

player = bpy.data.objects.new('Player', mesh)
scene.collection.objects.link(player)

# ============================================================
# 3. 뼈대 (Armature)
# ============================================================
FWD, BACK, DOWN = Vector((0, -1, 0)), Vector((0, 1, 0)), Vector((0, 0, -1))
BONES = [  # (이름, 부모, head, tail, roll 기준 벡터, 영향 반경)
    ('Hips', None, (0, 0, 0.93), (0, 0, 1.03), FWD, 0.15),
    ('Spine', 'Hips', (0, 0, 1.03), (0, 0, 1.15), FWD, 0.14),
    ('Spine1', 'Spine', (0, 0, 1.15), (0, 0, 1.27), FWD, 0.16),
    ('Spine2', 'Spine1', (0, 0, 1.27), (0, 0, 1.46), FWD, 0.17),
    ('Neck', 'Spine2', (0, 0, 1.46), (0, 0, 1.585), FWD, 0.054),
    ('Head', 'Neck', (0, 0, 1.585), (0, -0.005, 1.80), FWD, 0.105),
]
for side, sx in (('Left', 1), ('Right', -1)):
    BONES += [
        (side + 'Shoulder', 'Spine2', (sx * 0.03, 0, 1.42), (sx * 0.205, 0, 1.425), BACK, 0.055),
        (side + 'Arm', side + 'Shoulder', (sx * 0.205, 0, 1.425), (sx * 0.335, 0, 1.16), BACK, 0.05),
        (side + 'ForeArm', side + 'Arm', (sx * 0.335, 0, 1.16), (sx * 0.450, -0.05, 0.915), BACK, 0.038),
        (side + 'Hand', side + 'ForeArm', (sx * 0.450, -0.05, 0.915), (sx * 0.492, -0.062, 0.835), BACK, 0.038),
        (side + 'UpLeg', 'Hips', (sx * 0.095, 0, 0.93), (sx * 0.100, -0.02, 0.50), BACK, 0.10),
        (side + 'Leg', side + 'UpLeg', (sx * 0.100, -0.02, 0.50), (sx * 0.105, 0, 0.105), BACK, 0.062),
        (side + 'Foot', side + 'Leg', (sx * 0.105, 0, 0.105), (sx * 0.105, -0.17, 0.050), DOWN, 0.048),
        (side + 'ToeBase', side + 'Foot', (sx * 0.105, -0.17, 0.050), (sx * 0.105, -0.245, 0.034), DOWN, 0.042),
        (side + 'Toe_End', side + 'ToeBase', (sx * 0.105, -0.245, 0.034), (sx * 0.105, -0.275, 0.033), DOWN, 0.03),
    ]

arm = bpy.data.armatures.new('Armature')
ao = bpy.data.objects.new('Armature', arm)
scene.collection.objects.link(ao)
bpy.context.view_layer.objects.active = ao
ao.select_set(True)
bpy.ops.object.mode_set(mode='EDIT')
for name, parent, head, tail, roll_vec, _r in BONES:
    eb = arm.edit_bones.new(name)
    eb.head = Vector(head)
    eb.tail = Vector(tail)
    eb.align_roll(roll_vec)
    if parent:
        eb.parent = arm.edit_bones[parent]
        if (Vector(head) - arm.edit_bones[parent].tail).length < 1e-4:
            eb.use_connect = True
bpy.ops.object.mode_set(mode='OBJECT')
ao.show_in_front = True
arm.display_type = 'OCTAHEDRAL'

# ============================================================
# 4. 스킨 가중치: 각 뼈대 선분까지의 거리를 반경만큼 빼고 가까울수록 크게
# ============================================================
SEGS = [(n, Vector(h), Vector(t), r) for n, _p, h, t, _v, r in BONES]
EPS, POW = 0.03, 3.0
for n, *_ in SEGS:
    player.vertex_groups.new(name=n)
tags_attr = mesh.attributes.get('headpart')
tags = [d.value for d in tags_attr.data] if tags_attr else None


def smoothstep(a, b, x):
    t = max(0.0, min(1.0, (x - a) / (b - a)))
    return t * t * (3 - 2 * t)


for vert in mesh.vertices:
    tag = tags[vert.index] if tags else 0
    if tag == 1:
        player.vertex_groups['Head'].add([vert.index], 1.0, 'REPLACE')
        continue
    if tag == 2:
        t = smoothstep(1.50, 1.60, vert.co.z)
        if t < 0.999:
            player.vertex_groups['Neck'].add([vert.index], 1.0 - t, 'REPLACE')
        if t > 0.001:
            player.vertex_groups['Head'].add([vert.index], t, 'REPLACE')
        continue
    ws = []
    for n, a, b, r in SEGS:
        d, _t = seg_dist(vert.co, a, b)
        ws.append((1.0 / (max(d - r, 0.0) + EPS) ** POW, n))
    ws.sort(reverse=True)
    top = ws[:4]
    tot = sum(w for w, _ in top)
    for w, n in top:
        player.vertex_groups[n].add([vert.index], w / tot, 'REPLACE')
am = player.modifiers.new('Armature', 'ARMATURE')
am.object = ao
player.parent = ao

# 머리 모양 / 수염: 선수마다 다른 것을 보이게 하려고 별도 객체로 만들어 둠 (게임이 이름으로 골라 씀)
VARIANTS = []


def make_variant(name, build, mat_name):
    b = bmesh.new()
    build(b)
    me = bpy.data.meshes.new(name)
    b.to_mesh(me)
    b.free()
    for p in me.polygons:
        p.use_smooth = True
    me.materials.append(MAT_OBJ[mat_name])
    o = bpy.data.objects.new(name, me)
    scene.collection.objects.link(o)
    vg = o.vertex_groups.new(name='Head')
    vg.add(list(range(len(me.vertices))), 1.0, 'REPLACE')
    mod = o.modifiers.new('Armature', 'ARMATURE')
    mod.object = ao
    o.parent = ao
    VARIANTS.append(o)


for st in ('buzz', 'short', 'side', 'wavy', 'long', 'curly', 'afro', 'braids', 'bun', 'slick'):
    make_variant('Hair_' + st, lambda b, st=st: headmod.hair_mesh(b, 0, st), 'Hair')
for st in ('stubble', 'full'):
    make_variant('Beard_' + st, lambda b, st=st: headmod.beard_mesh(b, 0, st), 'Beard')

# 뼈대 이름이 아닌 부분은 Blender 쪽 정리
for o in (player, ao):
    o.location = (0, 0, 0)

print("VERTS", len(mesh.vertices), "FACES", len(mesh.polygons), "BBOX",
      [round(min(v.co[i] for v in mesh.vertices), 3) for i in range(3)],
      [round(max(v.co[i] for v in mesh.vertices), 3) for i in range(3)])

# ============================================================
# 5. 동작 만들기 + 저장 + 내보내기
# ============================================================
try:
    import animations
    animations.build(ao, scene)
except ImportError:
    print("(animations.py 없음: 동작 없이 저장)")

bpy.ops.wm.save_as_mainfile(filepath=BLEND)
os.makedirs(os.path.dirname(GLB), exist_ok=True)
bpy.ops.object.select_all(action='DESELECT')
player.select_set(True)
ao.select_set(True)
for o in VARIANTS:
    o.select_set(True)
bpy.context.view_layer.objects.active = ao
bpy.ops.export_scene.gltf(
    filepath=GLB, export_format='GLB', use_selection=True, export_yup=True,
    export_animations=True, export_animation_mode='NLA_TRACKS',
    export_skins=True, export_materials='EXPORT', export_cameras=False, export_lights=False,
)
print("EXPORTED", GLB, os.path.getsize(GLB))
