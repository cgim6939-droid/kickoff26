"""머리 모델만 만들어 보고 얼굴 클로즈업을 렌더 (개발용)
  blender -b --factory-startup -P blender/test_head.py -- <출력폴더> [머리모양] [수염] [피부번호]
"""
import bpy, bmesh, math, os, sys
from mathutils import Vector

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import head

argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
OUT = argv[0] if argv else '.'
STYLE = argv[1] if len(argv) > 1 else 'short'
BEARD = argv[2] if len(argv) > 2 else 'none'
SKIN = int(argv[3]) if len(argv) > 3 else 2
os.makedirs(OUT, exist_ok=True)

SKINS = ['#f7d8c4', '#f1c9a5', '#deaa7c', '#c68a5a', '#97623b', '#62402a']
bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene

NAMES = ['Skin', 'Lips', 'Sclera', 'Eyes', 'Brow', 'Hair', 'Beard']
COLORS = {'Skin': SKINS[SKIN], 'Lips': None, 'Sclera': '#f1efe9', 'Eyes': '#2a1a10', 'Brow': '#2b1d14', 'Hair': '#2b1d14', 'Beard': '#2b1d14'}


def lin(hexc):
    c = [int(hexc[i:i + 2], 16) / 255 for i in (1, 3, 5)]
    return [x ** 2.2 for x in c]


def mk(name, hexc, rough=0.6):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    b = next(n for n in m.node_tree.nodes if n.type == 'BSDF_PRINCIPLED')
    b.inputs['Base Color'].default_value = (*lin(hexc), 1)
    b.inputs['Roughness'].default_value = rough
    return m


skin = lin(SKINS[SKIN])
lipc = [skin[0] * 0.75 + 0.2 * 0.45, skin[1] * 0.6, skin[2] * 0.6]
mats = {}
for n in NAMES:
    if n == 'Lips':
        m = bpy.data.materials.new('Lips'); m.use_nodes = True
        next(x for x in m.node_tree.nodes if x.type == 'BSDF_PRINCIPLED').inputs['Base Color'].default_value = (*lipc, 1)
        mats[n] = m
    else:
        mats[n] = mk(n, COLORS[n], 0.35 if n in ('Sclera', 'Eyes') else 0.6)
MI = {n: i for i, n in enumerate(NAMES)}

bm = bmesh.new()
layer = bm.verts.layers.int.new('headpart')
head.head_base(bm, MI, layer)
mesh = bpy.data.meshes.new('Head'); bm.to_mesh(mesh); bm.free()
for n in NAMES:
    mesh.materials.append(mats[n])
obj = bpy.data.objects.new('Head', mesh); scene.collection.objects.link(obj)

def add_variant(kind, style):
    b = bmesh.new()
    if kind == 'hair':
        head.hair_mesh(b, 0, style)
    else:
        head.beard_mesh(b, 0, style)
    me = bpy.data.meshes.new(kind + style); b.to_mesh(me); b.free()
    me.materials.append(mats['Hair'] if kind == 'hair' else mats['Beard'])
    o = bpy.data.objects.new(kind + style, me); scene.collection.objects.link(o)
    return o

if STYLE != 'bald':
    add_variant('hair', STYLE)
if BEARD != 'none':
    add_variant('beard', BEARD)

for eng in ('BLENDER_EEVEE', 'BLENDER_EEVEE_NEXT'):
    try:
        scene.render.engine = eng; break
    except TypeError:
        pass
scene.render.resolution_x = 520
scene.render.resolution_y = 520
scene.view_settings.view_transform = 'Standard'
world = bpy.data.worlds.new('W'); scene.world = world; world.use_nodes = True
bg = next((n for n in world.node_tree.nodes if n.type == 'BACKGROUND'), None)
bg.inputs['Color'].default_value = (0.35, 0.40, 0.46, 1); bg.inputs['Strength'].default_value = 1.0
sun = bpy.data.objects.new('Sun', bpy.data.lights.new('Sun', 'SUN')); sun.data.energy = 3.2
sun.rotation_euler = (math.radians(55), math.radians(5), math.radians(-30)); scene.collection.objects.link(sun)
fill = bpy.data.objects.new('Fill', bpy.data.lights.new('Fill', 'SUN')); fill.data.energy = 1.4
fill.rotation_euler = (math.radians(70), 0, math.radians(150)); scene.collection.objects.link(fill)
cam = bpy.data.objects.new('Cam', bpy.data.cameras.new('Cam')); cam.data.lens = 85
scene.collection.objects.link(cam); scene.camera = cam

def shot(name, pos, tgt=(0, 0, 1.69)):
    cam.location = Vector(pos)
    cam.rotation_euler = (Vector(tgt) - cam.location).to_track_quat('-Z', 'Y').to_euler()
    scene.render.filepath = os.path.join(OUT, name + '.png')
    bpy.ops.render.render(write_still=True)

D = 0.95
shot('h_front', (0, -D, 1.69))
shot('h_three', (D * 0.62, -D * 0.78, 1.70))
shot('h_side', (D, 0, 1.69))
shot('h_back', (0, D, 1.69))
print('PREVIEW done', len(mesh.vertices))
