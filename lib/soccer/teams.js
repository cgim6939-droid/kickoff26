// 키보드 배치. 1P는 피파 온라인 기본 키와 같음
export const BINDINGS = {
  single: {
    up: ['ArrowUp'], down: ['ArrowDown'], left: ['ArrowLeft'], right: ['ArrowRight'],
    pass: ['KeyS'], shoot: ['KeyD'], through: ['KeyW'], lob: ['KeyA'], sprint: ['KeyE', 'ShiftLeft'], switch: ['KeyQ'],
    fin: ['KeyZ'], chip: ['KeyX'], drive: ['KeyV'], skill: ['KeyR'],
  },
  p1: {
    up: ['KeyW'], down: ['KeyS'], left: ['KeyA'], right: ['KeyD'],
    pass: ['KeyF'], shoot: ['KeyG'], through: ['KeyR'], lob: ['KeyT'], sprint: ['ShiftLeft'], switch: ['KeyQ'],
    fin: ['KeyZ'], chip: ['KeyX'], drive: ['KeyV'], skill: ['KeyY'],
  },
  p2: {
    up: ['ArrowUp'], down: ['ArrowDown'], left: ['ArrowLeft'], right: ['ArrowRight'],
    pass: ['KeyK', 'Numpad1'], shoot: ['KeyL', 'Numpad2'], through: ['KeyI', 'Numpad5'], lob: ['KeyO', 'Numpad4'],
    sprint: ['KeyJ', 'Numpad0'], switch: ['KeyU', 'Numpad3'],
    fin: ['KeyN', 'Numpad7'], chip: ['Comma', 'Numpad8'], drive: ['Period', 'Numpad9'], skill: ['KeyH'],
  },
};

// 화면에 보여줄 조작 안내
export const CONTROL_GUIDE = {
  single: [
    ['이동', ['←', '↑', '↓', '→']],
    ['패스 / 압박', ['S']],
    ['슛 (꾹) / 슬라이딩', ['D']],
    ['감아차기 (Z 누른 채)', ['Z', '+', 'D']],
    ['칩슛 (X 누른 채)', ['X', '+', 'D']],
    ['낮고 강한 슛 (V 누른 채)', ['V', '+', 'D']],
    ['개인기 (헛다리)', ['R']],
    ['스루패스', ['W']],
    ['로빙 패스 / 크로스', ['A']],
    ['질주', ['E']],
    ['선수 전환', ['Q']],
  ],
  p1: [
    ['이동', ['W', 'A', 'S', 'D']],
    ['패스 / 압박', ['F']],
    ['슛 / 슬라이딩', ['G']],
    ['스루패스', ['R']],
    ['로빙 패스', ['T']],
    ['질주', ['Shift']],
    ['선수 전환', ['Q']],
  ],
  p2: [
    ['이동', ['←', '↑', '↓', '→']],
    ['패스 / 압박', ['K']],
    ['슛 / 슬라이딩', ['L']],
    ['스루패스', ['I']],
    ['로빙 패스', ['O']],
    ['질주', ['J']],
    ['선수 전환', ['U']],
  ],
};
