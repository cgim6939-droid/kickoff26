# 선수 모델 (Blender)

게임이 쓰는 선수 모델은 `public/models/player.glb`(+ 동작 정보 `player_meta.json`)이고,
이 폴더의 스크립트가 만들어요. Blender 5.2 기준.

| 파일 | 역할 |
|---|---|
| `build_player.py` | 몸(Skin 모디파이어) → 재질 → 뼈대 → 스킨 가중치 → 동작 → `player.blend` 저장 → `player.glb` 내보내기 |
| `animations.py` | 동작 15종 (대기/걷기/달리기/킥/터치/슛 모으기/슬라이딩/태클/다이빙/세리머니/스로인/골키퍼) |
| `render_preview.py` | 미리보기 이미지 렌더 |
| `rebuild.sh` | 다시 만들고 미리보기까지 한 번에 |

## 다시 만들기
```
bash blender/rebuild.sh <미리보기 저장 폴더> views              # 정면/측면/뒷면
bash blender/rebuild.sh <폴더> clip run 0,3,6,9,12 side         # 동작 프레임 보기
```
(미리보기 렌더 끝에 Blender가 `EXCEPTION_ACCESS_VIOLATION`을 내며 종료하는 경우가 있는데, 이미지는 정상 저장돼요.)

## Blender에서 직접 고치고 싶다면
- `player.blend`를 열면 몸, 뼈대, 동작(NLA 트랙)이 그대로 있어요.
- **주의:** `build_player.py`를 다시 실행하면 `player.blend`를 새로 덮어써요. 손으로 고친 파일은 다른 이름으로 저장해 두세요.
- 게임은 아래 이름을 기준으로 찾으니 바꾸지 마세요.
  - 재질: `Skin, Jersey, Shorts, Socks, Boots, Hair, Trim, Gloves, Eyes` (게임이 팀 색을 이 이름으로 입혀요)
  - 뼈대: `Hips, Spine, Spine1, Spine2, Neck, Head, Left/Right + Shoulder, Arm, ForeArm, Hand, UpLeg, Leg, Foot, ToeBase, Toe_End`
  - 동작 이름: `idle, walk, run, kick, touch_R, touch_L, charge, slide, tackle, dive_R, dive_L, celebrate, throw_in, gk_hold, gk_ready`
- glb로 내보낼 땐 `Animation → NLA Tracks` 방식으로, 모델은 키 약 1.756m, 발이 바닥(0)에 오게 하세요.

## 좌표
Blender는 Z가 위, 캐릭터는 -Y를 바라보고 왼쪽이 +X예요. (glTF로 내보내면 +Z를 바라봐요.)

## 2026-10 업데이트: 얼굴/머리/수염/얼굴 사진
- `head.py`: 얼굴 있는 머리(코·눈·눈썹·입술·귀·턱), 머리 모양 10가지(`Hair_*`), 수염 2가지(`Beard_*`)를 코드로 만듦
- `build_player.py`가 `head.py`를 불러 몸에 붙이고, 머리 모양/수염은 별도 객체로 내보냄 (게임이 선수마다 골라 씀)
- `render_faces.py` / `render_faces.sh`: 선수 319명의 얼굴 사진을 `public/faces/<팀>_<번호>.png`로 렌더 (약 6분)
  - 외모 데이터: `lib/soccer/looks.js` → `blender/faces_input.json`으로 내보내서 사용
- `animations.py`: 새 동작 `header`(헤딩) `feint`(헛다리) `celebrate_pump` `celebrate_slide`, 그리고 앞 동작이 다음 동작 첫 프레임을 덮어쓰던 오류 수정(`gk_hold` 자세 정상화)
- 머리 모양 모아보기: `blender -b --factory-startup -P blender/test_gallery.py -- <폴더>`
