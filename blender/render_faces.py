"""선수 얼굴 사진(초상화) 렌더. 팀 선택 화면의 라인업에 쓰임.

  blender -b blender/player.blend -P blender/render_faces.py -- <입력 JSON> <출력 폴더> [시작번호] [개수] [해상도]

입력 JSON(blender/faces_input.json)은 lib/soccer/looks.js 의 선수별 외모(피부/머리/수염)와 팀 색.
같은 모델(player.blend)에서 머리 모양/수염 객체만 켜고 끄고, 재질 색을 바꿔 가며 한 명씩 렌더해요.
출력: <폴더>/<팀약칭>_<명단번호>.png (배경 투명)
"""
import bpy, sys, os, json, math
from mathutils import Vector

argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
SRC = argv[0]
OUT = argv[1]
START = int(argv[2]) if len(argv) > 2 else 0
COUNT = int(argv[3]) if len(argv) > 3 else 10 ** 6
RES = int(argv[4]) if len(argv) > 4 else 256
os.makedirs(OUT, exist_ok=True)
data = json.load(open(SRC, encoding='utf8'))[START:START + COUNT]

scene = bpy.context.scene
ao = bpy.data.objects['Armature']
if ao.animation_data:
    ao.animation_data.use_nla = False
    ao.animation_data.action = None
for pb in ao.pose.bones:
    pb.rotation_mode = 'XYZ'
    pb.rotation_euler = (0, 0, 0)
    pb.location = (0, 0, 0)

for eng in ('BLENDER_EEVEE', 'BLENDER_EEVEE_NEXT'):
    try:
        scene.render.engine = eng
        break
    except TypeError:
        pass
scene.render.resolution_x = RES
scene.render.resolution_y = RES
scene.render.film_transparent = True
scene.render.image_settings.file_format = 'PNG'
scene.render.image_settings.color_mode = 'RGBA'
scene.view_settings.view_transform = 'Standard'
try:
    scene.eevee.taa_render_samples = 24
except Exception:
    pass

world = bpy.data.worlds.new('W')
scene.world = world
world.use_nodes = True
bg = next((n for n in world.node_tree.nodes if n.type == 'BACKGROUND'), None)
bg.inputs['Color'].default_value = (0.55, 0.58, 0.62, 1)
bg.inputs['Strength'].default_value = 0.9

# 조명: 정면 위쪽 키라이트 + 옆 보조 + 뒤쪽 림라이트
def sun(name, energy, rot):
    o = bpy.data.objects.new(name, bpy.data.lights.new(name, 'SUN'))
    o.data.energy = energy
    o.rotation_euler = tuple(math.radians(a) for a in rot)
    scene.collection.objects.link(o)
sun('Key', 3.4, (58, 8, -28))
sun('Fill', 1.3, (70, 0, 140))
sun('Rim', 1.6, (100, 0, 190))

cam = bpy.data.objects.new('Cam', bpy.data.cameras.new('Cam'))
cam.data.lens = 85
scene.collection.objects.link(cam)
scene.camera = cam
cam.location = Vector((0.0, -1.06, 1.645))
cam.rotation_euler = (Vector((0.0, 0.0, 1.652)) - cam.location).to_track_quat('-Z', 'Y').to_euler()

player = bpy.data.objects['Player']
variants = {o.name: o for o in bpy.data.objects if o.name.startswith(('Hair_', 'Beard_'))}
# 다른 객체(바닥/조명 등) 정리
for o in list(bpy.data.objects):
    if o.name.startswith(('Floor',)):
        bpy.data.objects.remove(o)


def lin(hexc):
    c = [int(hexc[i:i + 2], 16) / 255 for i in (1, 3, 5)]
    return [x ** 2.2 for x in c]


def set_color(mat_name, rgb, rough=None):
    m = bpy.data.materials.get(mat_name)
    if not m:
        return
    b = next(n for n in m.node_tree.nodes if n.type == 'BSDF_PRINCIPLED')
    b.inputs['Base Color'].default_value = (rgb[0], rgb[1], rgb[2], 1)
    if rough is not None:
        b.inputs['Roughness'].default_value = rough


def mix(a, b, t):
    return [a[i] * (1 - t) + b[i] * t for i in range(3)]


EYE = ['#2a1a10', '#3a2414', '#241a12']
n = 0
for d in data:
    skin = lin(d['skin']); hair = lin(d['hair'])
    set_color('Skin', skin, 0.55)
    set_color('Lips', mix(skin, lin('#8c2f3a'), 0.38), 0.45)
    set_color('Hair', hair, 0.7)
    set_color('Brow', [c * 0.8 for c in hair], 0.8)
    set_color('Beard', mix(skin, hair, 0.5) if d['beard'] == 'stubble' else [c * 0.92 for c in hair], 0.85)
    eye = '#3a5f86' if d['colorIdx'] >= 4 and (d['num'] % 3 != 0) else EYE[d['num'] % 3]
    set_color('Eyes', lin(eye), 0.2)
    shirt = d['gkShirt'] if d['gk'] else d['shirt']
    set_color('Jersey', lin(shirt), 0.7)
    set_color('Trim', lin(d['trim'] if not d['gk'] else '#111827'), 0.7)
    for name, o in variants.items():
        want = name == 'Hair_' + d['hairStyle'] or name == 'Beard_' + d['beard']
        o.hide_render = not want
        o.hide_viewport = not want
    scene.render.filepath = os.path.join(OUT, f"{d['short']}_{d['ri']}.png")
    bpy.ops.render.render(write_still=True)
    n += 1
print('FACES done', n)
