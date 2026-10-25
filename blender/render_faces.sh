#!/usr/bin/env bash
# 모든 선수 얼굴 사진을 다시 렌더 (약 8분). 사용법: bash blender/render_faces.sh
BL="/c/Program Files/Blender Foundation/Blender 5.2/blender.exe"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
JSON_WIN="$(cygpath -w "$ROOT/blender/faces_input.json")"
OUT_WIN="$(cygpath -w "$ROOT/public/faces")"
TOTAL=$(python -c "import json,sys;print(len(json.load(open(sys.argv[1],encoding='utf8'))))" "$JSON_WIN")
STEP=80
for ((s=0; s<TOTAL; s+=STEP)); do
  timeout 900 "$BL" -b "$ROOT/blender/player.blend" -P "$ROOT/blender/render_faces.py" -- "$JSON_WIN" "$OUT_WIN" $s $STEP 256 2>&1 | grep -E "FACES|Traceback|Error" | head -3
done
echo ALL_DONE
