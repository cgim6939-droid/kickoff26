"""미리보기 렌더 (명령줄)

  blender -b blender/player.blend -P blender/render_preview.py -- <출력폴더> <모드> [옵션...]

모드:
  views            정면/측면/뒷면/3/4 시점 (기본 자세)
  clip <이름> <프레임들 쉼표>   동작 클립의 해당 프레임들 (측면)
  pose <뼈대=x,y,z;...>       특정 뼈대를 돌려본 시험 자세 (정면+측면)
"""
import bpy, sys, os, math
from mathutils import Vector, Euler

argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
OUT = argv[0] if argv else '.'
MODE = argv[1] if len(argv) > 1 else 'views'
os.makedirs(OUT, exist_ok=True)

scene = bpy.context.scene
ao = bpy.data.objects['Armature']
player = bpy.data.objects['Player']
# 머리 모양/수염 변형은 하나만 보이게 (기본: 짧은 머리 + 수염 없음)
for _o in bpy.data.objects:
    if _o.name.startswith(('Hair_', 'Beard_')) and _o.name != 'Hair_short':
        _o.hide_render = True
        _o.hide_viewport = True

# --- 렌더 설정 ---
for eng in ('BLENDER_EEVEE', 'BLENDER_EEVEE_NEXT'):
    try:
        scene.render.engine = eng
        break
    except TypeError:
        pass
scene.render.resolution_x = 420
scene.render.resolution_y = 640
scene.render.image_settings.file_format = 'PNG'
scene.view_settings.view_transform = 'Standard'

world = bpy.data.worlds.new('W')
scene.world = world
world.use_nodes = True
nt = world.node_tree
bg = next((n for n in nt.nodes if n.type == 'BACKGROUND'), None)
if bg is None:
    bg = nt.nodes.new('ShaderNodeBackground')
    out = next((n for n in nt.nodes if n.type == 'OUTPUT_WORLD'), None) or nt.nodes.new('ShaderNodeOutputWorld')
    nt.links.new(bg.outputs[0], out.inputs[0])
bg.inputs['Color'].default_value = (0.16, 0.2, 0.26, 1)
bg.inputs['Strength'].default_value = 1.2

# 바닥
bpy.ops.mesh.primitive_plane_add(size=6, location=(0, 0, 0))
floor = bpy.context.object
fm = bpy.data.materials.new('Floor')
fm.use_nodes = True
next(n for n in fm.node_tree.nodes if n.type == 'BSDF_PRINCIPLED').inputs['Base Color'].default_value = (0.05, 0.22, 0.07, 1)
floor.data.materials.append(fm)

# 조명
sun = bpy.data.objects.new('Sun', bpy.data.lights.new('Sun', 'SUN'))
sun.data.energy = 3.5
sun.rotation_euler = (math.radians(50), math.radians(10), math.radians(-35))
scene.collection.objects.link(sun)
fill = bpy.data.objects.new('Fill', bpy.data.lights.new('Fill', 'SUN'))
fill.data.energy = 1.2
fill.rotation_euler = (math.radians(70), 0, math.radians(150))
scene.collection.objects.link(fill)

cam = bpy.data.objects.new('Cam', bpy.data.cameras.new('Cam'))
cam.data.type = 'ORTHO'
cam.data.ortho_scale = 2.2
scene.collection.objects.link(cam)
scene.camera = cam


def look(pos, target=(0, 0, 0.9)):
    cam.location = Vector(pos)
    d = Vector(target) - cam.location
    cam.rotation_euler = d.to_track_quat('-Z', 'Y').to_euler()


VIEWS = {
    'front': (0, -6, 0.9), 'side': (6, 0, 0.9), 'back': (0, 6, 0.9), 'three': (4.2, -4.2, 1.2),
}


def shot(name, view):
    look(VIEWS[view])
    scene.render.filepath = os.path.join(OUT, name + '.png')
    bpy.ops.render.render(write_still=True)


def reset_pose():
    for pb in ao.pose.bones:
        pb.rotation_mode = 'XYZ'
        pb.rotation_euler = (0, 0, 0)
        pb.location = (0, 0, 0)


if ao.animation_data:
    ao.animation_data.use_nla = False
    ao.animation_data.action = None

if MODE == 'views':
    reset_pose()
    for v in VIEWS:
        shot('v_' + v, v)

elif MODE == 'pose':
    reset_pose()
    spec = argv[2] if len(argv) > 2 else ''
    for item in filter(None, spec.split(';')):
        bone, vals = item.split('=')
        ao.pose.bones[bone].rotation_euler = Euler(tuple(float(x) for x in vals.split(',')), 'XYZ')
    bpy.context.view_layer.update()
    shot('pose_front', 'front')
    shot('pose_side', 'side')

elif MODE == 'clip':
    name = argv[2]
    frames = [int(f) for f in argv[3].split(',')]
    view = argv[4] if len(argv) > 4 else 'side'
    ao.animation_data_create()
    ao.animation_data.action = bpy.data.actions[name]
    if hasattr(ao.animation_data, 'action_slot') and ao.animation_data.action.slots:
        ao.animation_data.action_slot = ao.animation_data.action.slots[0]
    for f in frames:
        scene.frame_set(f + 1)
        scene.frame_set(f)
        bpy.context.view_layer.update()
        shot('%s_%03d' % (name, f), view)
print("PREVIEW DONE", MODE)
