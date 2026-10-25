// 후보 선수 (클럽마다 7명: GK 1, DF 2, MF 2, FW 2). 팀 선택 화면의 라인업 편집에서 선발과 바꿀 수 있음
// 형식: '이름 등번호 포지션'. 능력치(속도/슛)는 포지션과 이름으로 고정된 값을 만들어 씀
import { hash01 } from './consts';

const B = {
  MCI: '트래포드 1 GK|스톤스 5 DF|아칸지 25 DF|베르나르두 실바 20 MF|코바치치 8 MF|마르무시 7 FW|사비뉴 26 FW',
  ARS: '케파 13 GK|진첸코 35 DF|벤 화이트 4 DF|수비멘디 36 MF|메리노 23 MF|트로사르 19 FW|하베르츠 29 FW',
  LIV: '켈러허 62 GK|로버트슨 26 DF|브래들리 84 DF|엔도 3 MF|흐라벤베르흐 38 MF|누녜스 27 FW|엘리엇 19 FW',
  CHE: '외르겐센 12 GK|구스토 27 DF|포파나 33 DF|라비아 45 MF|산투스 8 MF|잭슨 15 FW|가르나초 49 FW',
  TOT: '킨스키 31 GK|데이비스 33 DF|아치 그레이 14 DF|비수마 28 MF|매디슨 10 MF|오도베르 28 FW|텔 11 FW',
  MUN: '바인드르 1 GK|달롯 20 DF|요로 15 DF|우가르테 25 MF|마운트 7 MF|호일룬 11 FW|지르크지 22 FW',
  NEW: '램스데일 32 GK|트리피어 2 DF|보트만 4 DF|조엘링톤 7 MF|머피 23 MF|하비 반스 15 FW|오술라 18 FW',
  AVL: '올센 25 GK|마트센 22 DF|밍스 5 DF|바클리 6 MF|보가르더 26 MF|베일리 31 FW|말런 17 FW',
  FCB: '우르비히 40 GK|게헤이루 22 DF|이토 히로키 21 DF|파블로비치 45 MF|라이머 27 MF|그나브리 7 FW|코망 11 FW',
  B04: '코바르 17 GK|인카피에 3 DF|바데 5 DF|팔라시오스 25 MF|마자 30 MF|텔라 19 FW|아들리 21 FW',
  BVB: '마이어 33 GK|벤세바이니 5 DF|엠레 잔 23 DF|요베 벨링엄 22 MF|그로스 13 MF|파비우 시우바 9 FW|뒤랑빌 16 FW',
  RBL: '반데보르트 26 GK|헤이르트라위다 3 DF|핑크그레페 15 DF|우에드라오고 8 MF|페르메이런 18 MF|폴센 9 FW|디오망데 49 FW',
  VFB: '브레들로 1 GK|헨드릭스 4 DF|자케즈 5 DF|나르테이 7 MF|밀로 8 MF|티아구 토마스 9 FW|투레 40 FW',
  SGE: '그랄 1 GK|투타 35 DF|콜린스 3 DF|괴체 27 MF|샤이비 8 MF|마타노비치 9 FW|응앙캄 11 FW',
  RMA: '루닌 13 GK|페를랑 멘디 23 DF|뤼디거 22 DF|카마빙가 6 MF|브라힘 디아스 21 MF|로드리고 11 FW|엔드릭 16 FW',
  BAR: '슈체스니 25 GK|헤라르드 마르틴 18 DF|에리크 가르시아 24 DF|올모 20 MF|가비 6 MF|페란 토레스 7 FW|래시퍼드 14 FW',
  ATM: '무소 13 GK|몰리나 16 DF|렝글레 15 DF|카르도수 5 MF|데 파울 17 MF|그리즈만 7 FW|알마다 11 FW',
  ATH: '아히레사발라 13 GK|라포르트 14 DF|보이로 18 DF|프라도스 24 MF|우나이 고메스 17 MF|산나디 19 FW|세라노 15 FW',
  VIL: '아센호 13 GK|로건 코스타 4 DF|바이이 5 DF|파페 게예 18 MF|부캐넌 17 MF|아코마흐 11 FW|바리 19 FW',
  RSO: '마레로 13 GK|아이엔 3 DF|트라오레 18 DF|솔레르 18 MF|파블로 마린 28 MF|오스카르손 9 FW|게드스 11 FW',
  BET: '파우 로페스 25 GK|주니오르 피르포 3 DF|디에고 요렌테 16 DF|암라바트 4 MF|마르크 로카 21 MF|바캄부 11 FW|치미 아빌라 9 FW',
  PSG: '사포노프 39 GK|베랄두 35 DF|뤼카 에르난데스 21 DF|자이르에메리 33 MF|파비안 루이스 8 MF|바르콜라 29 FW|곤살루 하무스 9 FW',
  OM: '더 랑허 1 GK|메를랭 21 DF|파쿤도 메디나 32 DF|라비오 25 MF|에인절 고메스 8 MF|모페 9 FW|웨아 22 FW',
  ASM: '쾬 16 GK|마위사 22 DF|디어 3 DF|라민 카마라 15 MF|벤 세기르 7 MF|엠볼로 36 FW|미나미노 18 FW',
  LIL: '뷔텔 30 GK|티아구 산투스 22 DF|은고이 3 DF|에단 음바페 7 MF|사라위 10 MF|조나단 다비드 9 FW|펠릭스 코헤이아 11 FW',
  OL: '데상 40 GK|아브네르 16 DF|칼레타카르 5 DF|망갈라 5 MF|테스만 6 MF|라카제트 10 FW|모헤이라 20 FW',
  NIC: '디우프 16 GK|멘디 2 DF|라투 4 DF|루셰 8 MF|바르 앙드레 20 MF|라보르드 9 FW|클라우스 주니 11 FW',
  KOR: '김승규 21 GK|김진수 3 DF|김영권 19 DF|박용우 6 MF|백승호 16 MF|조규성 9 FW|배준호 10 FW',
  JPN: '오사코 12 GK|도미야스 22 DF|나가토모 5 DF|모리타 5 MF|이토 준야 14 MF|호소야 9 FW|마에다 11 FW',
};

const POS_STAT = { GK: [46, 20], DF: [72, 52], MF: [74, 72], FW: [80, 80] };

// club.short → [[이름, 등번호, 속도, 슛, 포지션], ...]
export function benchOf(short) {
  const row = B[short];
  if (!row) return [];
  return row.split('|').map(s => {
    const t = s.trim().split(' ');
    const pos = t.pop(), num = Number(t.pop()), name = t.join(' ');
    const [sp, sh] = POS_STAT[pos] || POS_STAT.MF;
    const j = (k) => Math.round((hash01(short + name, k) - 0.5) * 12);
    return [name, num, sp + j(1), sh + j(2), pos];
  });
}
