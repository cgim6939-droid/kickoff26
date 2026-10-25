"""머리 모양 모아보기 (개발용)  blender -b --factory-startup -P blender/test_gallery.py -- <출력폴더>"""
import bpy, bmesh, math, os, sys
from mathutils import Vector

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import head

argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
OUT = argv[0] if argv else '.'
os.makedirs(OUT, exist_ok=True)
SKINS = ['#f7d8c4', '#f1c9a5', '#deaa7c', '#c68a5a', '#97623b', '#62402a']
HAIRC = ['#16110d', '#2f2016', '#4b3221', '#7a5836', '#c9a45c', '#a24a22', '#8d8d8d', '#e8dcb5']
STYLES = ['bald', 'buzz', 'short', 'side', 'wavy', 'long', 'curly', 'afro', 'braids', 'bun', 'slick']
bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene

def lin(h):
    c = [int(h[i:i + 2], 16) / 255 for i in (1, 3, 5)]
    return [x ** 2.2 for x in c]

def mat(name, rgb, rough=0.6):
    m = bpy.data.materials.new(name); m.use_nodes = True
    b = next(n for n in m.node_tree.nodes if n.type == 'BSDF_PRINCIPLED')
    b.inputs['Base Color'].default_value = (*rgb, 1); b.inputs['Roughness'].default_value = rough
    return m

NAMES = ['Skin', 'Lips', 'Sclera', 'Eyes', 'Brow', 'Hair', 'Beard']
MI = {n: i for i, n in enumerate(NAMES)}
bm0 = bmesh.new(); layer = bm0.verts.layers.int.new('headpart'); head.head_base(bm0, MI, layer)
base_me = bpy.data.meshes.new('HeadBase'); bm0.to_mesh(base_me); bm0.free()

def head_obj(i, skin, hairc, style, beard):
    sk = lin(SKINS[skin]); hc = lin(HAIRC[hairc])
    mats = {'Skin': mat('Skin%d' % i, sk), 'Lips': mat('Lips%d' % i, [sk[0] * 0.8 + 0.1, sk[1] * 0.55, sk[2] * 0.55]),
            'Sclera': mat('Sc%d' % i, lin('#f1efe9'), 0.3), 'Eyes': mat('Ey%d' % i, lin('#2a1a10'), 0.2),
            'Brow': mat('Br%d' % i, [c * 0.8 for c in hc]), 'Hair': mat('Ha%d' % i, hc, 0.7),
            'Beard': mat('Be%d' % i, [sk[k] * 0.45 + hc[k] * 0.55 for k in range(3)] if beard == 'stubble' else [c * 0.9 for c in hc], 0.8)}
    me = base_me.copy()
    for n in NAMES: me.materials.append(mats[n])
    o = bpy.data.objects.new('H%d' % i, me); scene.collection.objects.link(o)
    parts = [o]
    if style != 'bald':
        b = bmesh.new(); head.hair_mesh(b, 0, style); m2 = bpy.data.meshes.new('hair%d' % i); b.to_mesh(m2); b.free(); m2.materials.append(mats['Hair'])
        parts.append(bpy.data.objects.new('hair%d' % i, m2)); scene.collection.objects.link(parts[-1])
    if beard != 'none':
        b = bmesh.new(); head.beard_mesh(b, 0, beard); m3 = bpy.data.meshes.new('beard%d' % i); b.to_mesh(m3); b.free(); m3.materials.append(mats['Beard'])
        parts.append(bpy.data.objects.new('beard%d' % i, m3)); scene.collection.objects.link(parts[-1])
    return parts

rows = [
    [(2, 0, 'bald', 'none'), (1, 0, 'buzz', 'stubble'), (3, 1, 'short', 'none'), (1, 3, 'side', 'stubble'), (0, 4, 'wavy', 'none'), (2, 1, 'long', 'full')],
    [(4, 0, 'curly', 'stubble'), (5, 0, 'afro', 'none'), (4, 0, 'braids', 'none'), (1, 4, 'bun', 'full'), (1, 1, 'slick', 'stubble'), (3, 0, 'short', 'full')],
]
SP = 0.30
for r, row in enumerate(rows):
    for c, (sk, hc, st, bd) in enumerate(row):
        for o in head_obj(r * 10 + c, sk, hc, st, bd):
            o.location = Vector((c * SP - SP * 2.5, 0, -r * 0.34))

for eng in ('BLENDER_EEVEE', 'BLENDER_EEVEE_NEXT'):
    try:
        scene.render.engine = eng; break
    except TypeError:
        pass
scene.render.resolution_x = 1800; scene.render.resolution_y = 900
scene.view_settings.view_transform = 'Standard'
world = bpy.data.worlds.new('W'); scene.world = world; world.use_nodes = True
bg = next(n for n in world.node_tree.nodes if n.type == 'BACKGROUND')
bg.inputs['Color'].default_value = (0.35, 0.40, 0.46, 1)
sun = bpy.data.objects.new('Sun', bpy.data.lights.new('Sun', 'SUN')); sun.data.energy = 3.2
sun.rotation_euler = (math.radians(55), math.radians(5), math.radians(-30)); scene.collection.objects.link(sun)
fill = bpy.data.objects.new('Fill', bpy.data.lights.new('Fill', 'SUN')); fill.data.energy = 1.4
fill.rotation_euler = (math.radians(70), 0, math.radians(150)); scene.collection.objects.link(fill)
cam = bpy.data.objects.new('Cam', bpy.data.cameras.new('Cam')); cam.data.lens = 70; scene.collection.objects.link(cam); scene.camera = cam
def shot(name, pos, tgt):
    cam.location = Vector(pos); cam.rotation_euler = (Vector(tgt) - cam.location).to_track_quat('-Z', 'Y').to_euler()
    scene.render.filepath = os.path.join(OUT, name + '.png'); bpy.ops.render.render(write_still=True)
shot('g_front', (0, -3.7, 1.52), (0, 0, 1.52))
shot('g_three', (2.6, -2.6, 1.7), (0, 0, 1.52))
print('PREVIEW gallery')
