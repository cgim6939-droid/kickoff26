#!/usr/bin/env bash
# 사용법: bash blender/rebuild.sh <미리보기 폴더> <모드> [옵션...]
#   모델/동작을 다시 만들고(player.blend, player.glb) 미리보기 이미지를 그림
#   예) bash blender/rebuild.sh /tmp/p views
#       bash blender/rebuild.sh /tmp/p clip run 0,6,12,18,24
BL="/c/Program Files/Blender Foundation/Blender 5.2/blender.exe"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$1"; shift
mkdir -p "$OUT"
timeout 600 "$BL" -b --factory-startup -P "$ROOT/blender/build_player.py" 2>&1 \
  | grep -E "VERTS|EXPORTED|Error|Traceback|File \"|Exception|NLA|CLIPS" | head -20
timeout 600 "$BL" -b --factory-startup "$ROOT/blender/player.blend" -P "$ROOT/blender/render_preview.py" -- "$(cygpath -w "$OUT")" "$@" 2>&1 \
  | grep -E "PREVIEW|Traceback|Error|File \"" | head -10
