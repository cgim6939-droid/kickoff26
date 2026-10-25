'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { createRuntime } from '@/lib/soccer/runtime';
import { CONTROL_GUIDE } from '@/lib/soccer/teams';
import { LEAGUES, CLUBS, clubIndex, clubStars, quickResult, penaltyShootout } from '@/lib/soccer/clubs';
import { lineupFor, suggestTactics, formationList, STYLES, STYLE_ORDER, ROSTER_PICK } from '@/lib/soccer/formations';
import { resolveLook } from '@/lib/soccer/looks';

const SETTINGS = {
  size: [['5', '5 vs 5'], ['7', '7 vs 7'], ['11', '11 vs 11']],
  time: [['120', '2분'], ['240', '4분'], ['360', '6분']],
  diff: [['beginner', '입문'], ['easy', '아마추어'], ['semipro', '세미프로'], ['normal', '프로'], ['hard', '월드클래스'], ['legend', '레전드']],
  rules: [['real', '실감 (파울·카드·오프사이드)'], ['arcade', '아케이드']],
  tod: [['day', '낮'], ['sunset', '노을'], ['night', '야간']],
  weather: [['clear', '맑음'], ['rain', '비'], ['snow', '눈']],
  quality: [['ultra', '최고'], ['high', '높음'], ['medium', '보통'], ['low', '낮음']],
};
const SETTING_LABELS = { size: '인원', time: '경기 시간', diff: '난이도', rules: '경기 규칙', tod: '시간대', weather: '날씨', quality: '그래픽',
  form0: '홈 포메이션', style0: '홈 전술', form1: '원정 포메이션', style1: '원정 전술' };
// 포메이션/전술은 인원수에 따라 고를 수 있는 목록이 달라짐
function optionsOf(key, size) {
  if (key.startsWith('form')) return [['auto', '자동'], ...formationList(Number(size)).map(x => [x, x])];
  if (key.startsWith('style')) return [['auto', '자동'], ...STYLE_ORDER.map(x => [x, STYLES[x].label])];
  return SETTINGS[key];
}

const MAIN_TILES = [
  { id: '1p', title: '킥오프', en: 'KICK OFF', desc: 'AI 팀과 한 판 승부', big: true },
  { id: 'cup', title: '컵 대회', en: 'CUP', desc: '8강 토너먼트 우승에 도전' },
  { id: '2p', title: '로컬 대전', en: 'LOCAL MATCH', desc: '한 키보드로 친구와 대결' },
  { id: 'multi', title: '멀티플레이', en: 'ONLINE', desc: '방 코드로 친구와 1대1', soon: true },
  { id: 'cpu', title: '관전 모드', en: 'SPECTATE', desc: 'AI끼리 경기를 지켜보기' },
  { id: 'controls', title: '조작법', en: 'CONTROLS', desc: '키 배치 보기' },
];

const ROUND_NAMES = ['8강', '준결승', '결승'];

// 메뉴 키 입력: 화면이 열린 직후(이전 화면에서 누른 키)는 무시하고, 핸들러는 항상 최신 상태를 씀
function useKeys(handler) {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    const opened = performance.now();
    const onKey = (e) => { if (performance.now() - opened > 150 && !e.repeat) ref.current(e); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

// ================= 컵 대회 로직 =================
function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

function createCup(user) {
  const others = shuffle(CLUBS.map((_, i) => i).filter(i => i !== user)).slice(0, 7);
  const teams = shuffle([user, ...others]);
  const r0 = [];
  for (let i = 0; i < 8; i += 2) r0.push({ a: teams[i], b: teams[i + 1] });
  return { user, rounds: [r0], round: 0, done: false, champion: null, eliminated: false };
}

function finishMatch(m, ga, gb) {
  m.ga = ga; m.gb = gb; m.played = true;
  if (ga === gb) {
    const p = penaltyShootout(m.a, m.b);
    m.pa = p.pa; m.pb = p.pb;
    m.winner = p.pa > p.pb ? m.a : m.b;
  } else m.winner = ga > gb ? m.a : m.b;
}

// 사람이 치른 경기 결과를 넣고, 같은 라운드 나머지 경기를 계산한 뒤 다음 라운드로
function advanceCup(cup, userGoals, oppGoals) {
  const c = JSON.parse(JSON.stringify(cup));
  const round = c.rounds[c.round];
  for (const m of round) {
    if (m.played) continue;
    if (m.a === c.user) finishMatch(m, userGoals, oppGoals);
    else if (m.b === c.user) finishMatch(m, oppGoals, userGoals);
    else { const r = quickResult(m.a, m.b); finishMatch(m, r.ga, r.gb); }
  }
  if (!round.some(m => m.winner === c.user)) c.eliminated = true;
  // 사람이 탈락했으면 남은 라운드는 바로 계산
  while (true) {
    const cur = c.rounds[c.round];
    if (cur.length === 1) { c.done = true; c.champion = cur[0].winner; break; }
    const next = [];
    for (let i = 0; i < cur.length; i += 2) next.push({ a: cur[i].winner, b: cur[i + 1].winner });
    c.rounds.push(next); c.round++;
    if (!c.eliminated) break;
    for (const m of next) { const r = quickResult(m.a, m.b); finishMatch(m, r.ga, r.gb); }
  }
  return c;
}

function cupOpponent(cup) {
  const m = cup.rounds[cup.round].find(x => x.a === cup.user || x.b === cup.user);
  return m ? (m.a === cup.user ? m.b : m.a) : null;
}

export default function SoccerGame() {
  const glRef = useRef(null);
  const hudRef = useRef(null);
  const rtRef = useRef(null);
  const [screen, setScreen] = useState('title'); // title | main | teams | settings | controls | playing
  const [paused, setPaused] = useState(false);
  const [result, setResult] = useState(null);
  const [opts, setOpts] = useState({
    lineup: {}, mode: '1p', size: '11', time: '240', diff: 'normal', rules: 'real', form0: 'auto', style0: 'auto', form1: 'auto', style1: 'auto', tod: 'sunset', weather: 'clear', quality: 'medium',
    team: [clubIndex('TOT'), clubIndex('FCB')],
  });
  const [cup, setCup] = useState(null);
  const [online, setOnline] = useState(null);      // { phase: creating|waiting|joining|connected|playing|closed|error, code, message }

  useEffect(() => {
    const rt = createRuntime({
      glCanvas: glRef.current,
      hudCanvas: hudRef.current,
      onPauseChange: setPaused,
      onResult: (summary, infos) => setResult({ summary, infos }),
      onOnline: (o) => {
        setOnline(o);
        if (o.phase === 'playing') { setResult(null); setPaused(false); setScreen('playing'); }
        else if (o.phase === 'closed') setScreen(sc => (sc === 'playing' ? 'online-lost' : sc === 'waiting' || sc === 'join' ? 'online' : sc));
      },
    });
    rtRef.current = rt;
    return () => rt.destroy();
  }, []);

  // 시간대/그래픽을 바꾸면 배경 경기장에 바로 반영
  useEffect(() => {
    if (rtRef.current) rtRef.current.setVisual({ tod: opts.tod, quality: opts.quality, weather: opts.weather });
  }, [opts.tod, opts.quality, opts.weather]);

  // 컵 대회 경기는 사람(1P)이 항상 HOME
  const start = useCallback((cupState) => {
    setResult(null);
    setPaused(false);
    setScreen('playing');
    const c = cupState && cupState.rounds ? cupState : cup;
    if (opts.mode === 'cup' && c) {
      rtRef.current.start({ ...opts, mode: '1p', team: [c.user, cupOpponent(c)] });
    } else {
      rtRef.current.start(opts);
    }
  }, [opts, cup]);

  const toMenu = () => {
    rtRef.current.toMenu();
    setResult(null);
    setPaused(false);
    setScreen('main');
  };

  // 컵 대회: 경기 결과 반영 후 대진표로
  const continueCup = () => {
    const s = result.summary;
    setCup(c => advanceCup(c, s[0].score, s[1].score));
    rtRef.current.toMenu();
    setResult(null);
    setScreen('cup');
  };

  return (
    <div className="game-root">
      <canvas ref={glRef} className="layer" />
      <canvas ref={hudRef} className="layer hud" />

      {screen === 'title' && <TitleScreen onStart={() => setScreen('main')} />}
      {screen === 'main' && (
        <MainMenu
          onSelect={(id) => {
            if (id === 'controls') { setScreen('controls'); return; }
            if (id === 'multi') { setScreen('online'); return; }
            setOpts(o => ({ ...o, mode: id }));
            setScreen('teams');
          }}
        />
      )}
      {screen === 'controls' && <ControlsScreen onBack={() => setScreen('main')} />}
      {screen === 'teams' && (
        <TeamSelect opts={opts} setOpts={setOpts} onBack={() => setScreen('main')} onNext={() => setScreen('lineup')} />
      )}
      {screen === 'lineup' && (
        <LineupScreen opts={opts} setOpts={setOpts} onBack={() => setScreen('teams')} onNext={() => setScreen('settings')} />
      )}
      {screen === 'settings' && (
        <MatchSettings
          opts={opts} setOpts={setOpts} onBack={() => setScreen('lineup')}
          onStart={() => {
            if (opts.mode === 'host') { setOnline({ phase: 'creating' }); setScreen('waiting'); rtRef.current.hostOnline(opts); }
            else if (opts.mode === 'cup') { setCup(createCup(opts.team[0])); setScreen('cup'); }
            else start();
          }}
        />
      )}
      {screen === 'online' && (
        <OnlineMenu
          onHost={() => { setOpts(o => ({ ...o, mode: 'host', size: '11' })); setScreen('teams'); }}
          onJoin={() => { setOnline(null); setScreen('join'); }}
          onBack={() => setScreen('main')}
        />
      )}
      {screen === 'waiting' && (
        <OnlineWaiting online={online} onCancel={() => { rtRef.current.closeNet(); setOnline(null); setScreen('online'); }} />
      )}
      {screen === 'join' && (
        <OnlineJoin
          online={online}
          onJoin={(code) => { setOnline({ phase: 'joining' }); rtRef.current.joinOnline(code, { quality: opts.quality }); }}
          onCancel={() => { rtRef.current.closeNet(); setOnline(null); setScreen('online'); }}
        />
      )}
      {screen === 'online-lost' && (
        <div className="fc-overlay dim">
          <div className="fc-pause">
            <div className="fc-eyebrow">ONLINE</div>
            <h2>연결이 끊겼어요</h2>
            <button className="fc-btn primary" onClick={() => { toMenu(); setOnline(null); }}>메인 메뉴</button>
          </div>
        </div>
      )}
      {screen === 'cup' && cup && (
        <CupScreen cup={cup} onPlay={() => start(cup)} onMenu={() => { setCup(null); setScreen('main'); }} />
      )}

      {screen === 'playing' && paused && !result && (
        <div className="fc-overlay dim">
          <div className="fc-pause">
            <div className="fc-eyebrow">PAUSED</div>
            <h2>일시정지</h2>
            <button className="fc-btn primary" onClick={() => rtRef.current.setPaused(false)}>계속하기</button>
            <button className="fc-btn" onClick={() => start()}>다시 시작</button>
            <button className="fc-btn" onClick={toMenu}>메인 메뉴</button>
            <ControlsPanel mode={opts.mode} />
          </div>
        </div>
      )}

      {result && (opts.mode === 'cup' && cup
        ? <Result result={result} cupRound={ROUND_NAMES[cup.round]} onAgain={continueCup} againLabel="대진표 보기 ›" onMenu={() => { setCup(null); toMenu(); }} />
        : online && online.phase === 'playing'
          ? <Result result={result} onAgain={() => { toMenu(); setOnline(null); }} againLabel="메인 메뉴 ›" onMenu={() => { toMenu(); setOnline(null); }} />
          : <Result result={result} onAgain={() => start()} onMenu={toMenu} />)}
    </div>
  );
}

// ================= 타이틀 =================
function TitleScreen({ onStart }) {
  useEffect(() => {
    const go = (e) => { if (e.key !== 'Tab') onStart(); };
    const t = setTimeout(() => window.addEventListener('keydown', go), 300);
    return () => { clearTimeout(t); window.removeEventListener('keydown', go); };
  }, [onStart]);
  return (
    <div className="fc-overlay title" onClick={onStart}>
      <img className="title-mark" src="/logo.svg" alt="KICKOFF 26" />
      <div className="title-logo">
        <div className="title-kicker">KICKOFF</div>
        <div className="title-num">26</div>
      </div>
      <div className="title-sub">3D FOOTBALL · PREMIER LEAGUE · BUNDESLIGA · LALIGA · LIGUE 1</div>
      <div className="press">아무 키나 누르세요 <span>PRESS ANY KEY</span></div>
    </div>
  );
}

// ================= 메인 메뉴 =================
function MainMenu({ onSelect }) {
  const [focus, setFocus] = useState(0);
  useKeys((e) => {
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { setFocus(f => (f + 1) % MAIN_TILES.length); e.preventDefault(); }
      if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { setFocus(f => (f + MAIN_TILES.length - 1) % MAIN_TILES.length); e.preventDefault(); }
      if (e.key === 'Enter' || e.key === ' ') { onSelect(MAIN_TILES[focus].id); e.preventDefault(); }
    });
  return (
    <div className="fc-overlay main">
      <TopBar crumbs={['홈']} />
      <div className="menu-hero" aria-hidden="true"><i className="ring r1" /><i className="ring r2" /><img src="/logo.svg" alt="" /><div className="hero-tag">SEASON 2025/26<b>29 CLUBS · 5 LEAGUES</b></div></div>
      <div className="main-wrap">
        <div className="fc-eyebrow">PLAY</div>
        <h1 className="fc-h1">플레이</h1>
        <div className="tiles">
          {MAIN_TILES.map((t, i) => (
            <button
              key={t.id}
              className={`tile ${t.big ? 'big' : ''} ${focus === i ? 'focus' : ''}`}
              onMouseEnter={() => setFocus(i)}
              onClick={() => onSelect(t.id)}
            >
              <span className="tile-en">{t.en}</span>
              <span className="tile-title">{t.title}</span>
              <span className="tile-desc">{t.desc}</span>
              {t.big && <span className="tile-ball">⚽</span>}
              {t.soon && <span className="tile-soon">ONLINE</span>}
            </button>
          ))}
        </div>
      </div>
      <FooterHints hints={[['←→', '이동'], ['Enter', '선택']]} />
    </div>
  );
}

// ================= 온라인 (방 코드) =================
function OnlineMenu({ onHost, onJoin, onBack }) {
  const [focus, setFocus] = useState(0);
  useKeys((e) => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') setFocus(f => 1 - f);
    else if (e.key === 'Enter') (focus === 0 ? onHost : onJoin)();
    else if (e.key === 'Escape' || e.key === 'Backspace') onBack();
    else return;
    e.preventDefault();
  });
  return (
    <div className="fc-overlay main">
      <TopBar crumbs={['홈', '멀티플레이']} />
      <div className="main-wrap">
        <div className="fc-eyebrow">ONLINE 1 vs 1</div>
        <h1 className="fc-h1">멀티플레이</h1>
        <div className="tiles online-tiles">
          <button className={`tile big ${focus === 0 ? 'focus' : ''}`} onMouseEnter={() => setFocus(0)} onClick={onHost}>
            <span className="tile-en">HOST</span><span className="tile-title">방 만들기</span>
            <span className="tile-desc">팀을 고르고 방 코드를 친구에게 알려 주세요</span><span className="tile-ball">⚽</span>
          </button>
          <button className={`tile big ${focus === 1 ? 'focus' : ''}`} onMouseEnter={() => setFocus(1)} onClick={onJoin}>
            <span className="tile-en">JOIN</span><span className="tile-title">코드로 참가</span>
            <span className="tile-desc">친구가 알려 준 5자리 코드를 입력하세요</span><span className="tile-ball">🎮</span>
          </button>
        </div>
        <p className="online-note">방장의 컴퓨터가 경기를 계산하고 친구는 그 화면을 받아서 봐요. 인터넷 상태가 좋을수록 부드러워요.</p>
      </div>
      <div className="bottom-actions"><button className="fc-btn" onClick={onBack}>뒤로</button></div>
      <FooterHints hints={[['←→', '이동'], ['Enter', '선택'], ['Esc', '뒤로']]} />
    </div>
  );
}

function OnlineWaiting({ online, onCancel }) {
  const code = online && online.code;
  const [copied, setCopied] = useState(false);
  useKeys((e) => { if (e.key === 'Escape') { onCancel(); e.preventDefault(); } });
  const copy = () => { try { navigator.clipboard.writeText(code); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch (e) { /* 복사 불가 */ } };
  return (
    <div className="fc-overlay main">
      <TopBar crumbs={['홈', '멀티플레이', '대기']} />
      <div className="online-box">
        <div className="fc-eyebrow">ROOM CODE</div>
        {online && online.phase === 'error'
          ? <><h2>{online.message}</h2><button className="fc-btn primary" onClick={onCancel}>돌아가기</button></>
          : <>
            <div className="room-code">{code || '· · · · ·'}</div>
            <p>{code ? '친구에게 이 코드를 알려 주세요. 친구가 들어오면 바로 경기가 시작돼요.' : '방을 만드는 중…'}</p>
            <div className="online-actions">
              <button className="fc-btn primary" disabled={!code} onClick={copy}>{copied ? '복사됨 ✓' : '코드 복사'}</button>
              <button className="fc-btn" onClick={onCancel}>취소</button>
            </div>
            <div className="dots"><i /><i /><i /></div>
          </>}
      </div>
    </div>
  );
}

function OnlineJoin({ online, onJoin, onCancel }) {
  const [code, setCode] = useState('');
  const busy = online && (online.phase === 'joining' || online.phase === 'connected');
  const go = () => { if (code.length === 5 && !busy) onJoin(code); };
  return (
    <div className="fc-overlay main">
      <TopBar crumbs={['홈', '멀티플레이', '참가']} />
      <div className="online-box">
        <div className="fc-eyebrow">JOIN ROOM</div>
        <h2>방 코드를 입력하세요</h2>
        <input
          className="code-input" value={code} maxLength={5} autoFocus placeholder="ABCDE" spellCheck={false}
          onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5))}
          onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') go(); if (e.key === 'Escape') onCancel(); }}
        />
        <p className={online && online.phase === 'error' ? 'err' : ''}>
          {online && online.phase === 'error' ? online.message
            : online && online.phase === 'connected' ? '연결됐어요! 방장이 시작하길 기다리는 중…'
              : online && online.phase === 'joining' ? '연결하는 중…' : '친구(방장)가 만든 5자리 코드예요'}
        </p>
        <div className="online-actions">
          <button className="fc-btn primary" disabled={code.length !== 5 || busy} onClick={go}>참가하기</button>
          <button className="fc-btn" onClick={onCancel}>뒤로</button>
        </div>
      </div>
    </div>
  );
}

// ================= 팀 선택 =================
function leagueOf(clubIdx) {
  return LEAGUES.findIndex(l => l.id === CLUBS[clubIdx].league);
}

// 선수의 본래 포지션 (명단 0=GK, 1~4=DF, 5~8=MF, 9~10=FW, 11~=후보는 직접 적힌 값)
const squadRole = (club, ri) => ri <= 10 ? (ri === 0 ? 'GK' : ri <= 4 ? 'DF' : ri <= 8 ? 'MF' : 'FW') : (club.players[ri][4] || 'MF');
const SLOT_ROLE = { GK: 'GK', CB: 'DF', LB: 'DF', RB: 'DF', LWB: 'DF', RWB: 'DF', DM: 'MF', CM: 'MF', LM: 'MF', RM: 'MF', AM: 'MF', LW: 'FW', RW: 'FW', ST: 'FW', CF: 'FW', SS: 'FW' };
// 라인업: 편집한 값이 있으면 그것, 없으면 AI 추천
function lineupOf(opts, clubIdx) {
  const club = CLUBS[clubIdx], sug = suggestTactics(club, 11), e = (opts.lineup && opts.lineup[clubIdx]) || {};
  return { formation: e.formation || sug.formation, style: e.style || sug.style, order: e.order || ROSTER_PICK[11].slice() };
}

function TeamSelect({ opts, setOpts, onBack, onNext }) {
  const [side, setSide] = useState(0);
  const setTeam = useCallback((s, idx) => {
    setOpts(o => {
      if (idx === o.team[1 - s]) return o;
      const team = [...o.team]; team[s] = idx;
      return { ...o, team };
    });
  }, [setOpts]);

  const cycleTeam = useCallback((s, d) => {
    setOpts(o => {
      const lg = LEAGUES[leagueOf(o.team[s])];
      const ids = lg.teams.map(t => clubIndex(t.short)).filter(i => i !== o.team[1 - s]);
      const cur = ids.indexOf(o.team[s]);
      const next = ids[(cur + d + ids.length) % ids.length];
      const team = [...o.team]; team[s] = next;
      return { ...o, team };
    });
  }, [setOpts]);

  const cycleLeague = useCallback((s, d) => {
    setOpts(o => {
      let li = (leagueOf(o.team[s]) + d + LEAGUES.length) % LEAGUES.length;
      const ids = LEAGUES[li].teams.map(t => clubIndex(t.short)).filter(i => i !== o.team[1 - s]);
      const team = [...o.team]; team[s] = ids[0];
      return { ...o, team };
    });
  }, [setOpts]);

  useKeys((e) => {
      if (e.key === 'ArrowLeft') cycleTeam(side, -1);
      else if (e.key === 'ArrowRight') cycleTeam(side, 1);
      else if (e.key === 'ArrowUp') cycleLeague(side, -1);
      else if (e.key === 'ArrowDown') cycleLeague(side, 1);
      else if (e.key === 'Tab') setSide(s => 1 - s);
      else if (e.key === 'Enter') onNext();
      else if (e.key === 'Escape' || e.key === 'Backspace') onBack();
      else return;
      e.preventDefault();
    });

  const sideNames = { '1p': ['1P', 'CPU'], '2p': ['1P', '2P'], cpu: ['CPU', 'CPU'], cup: ['1P', 'CUP'], host: ['나', '친구'] }[opts.mode];

  return (
    <div className="fc-overlay teams-screen">
      <TopBar crumbs={['홈', modeName(opts.mode), '팀 선택']} />
      <div className="teams-wrap">
        {[0, 1].map(s => s === 1 && opts.mode === 'cup' ? <CupInfo key="cup" /> : (
          <TeamPanel
            key={s}
            side={s}
            active={side === s}
            label={s === 0 ? 'HOME' : 'AWAY'}
            controller={sideNames[s]}
            clubIdx={opts.team[s]}
            otherIdx={opts.team[1 - s]}
            onActivate={() => setSide(s)}
            onCycle={(d) => cycleTeam(s, d)}
            onLeague={(li) => {
              const ids = LEAGUES[li].teams.map(t => clubIndex(t.short)).filter(i => i !== opts.team[1 - s]);
              setTeam(s, ids[0]);
            }}
            onPick={(idx) => setTeam(s, idx)}
            lineup={lineupOf(opts, opts.team[s])}
          />
        ))}
        <div className="vs-badge">VS</div>
      </div>
      <div className="bottom-actions">
        <button className="fc-btn" onClick={onBack}>뒤로</button>
        <button className="fc-btn primary" onClick={onNext}>다음: 라인업 · 포메이션 ›</button>
      </div>
      <FooterHints hints={[['←→', '팀 변경'], ['↑↓', '리그 변경'], ['Tab', 'HOME/AWAY 전환'], ['Enter', '다음'], ['Esc', '뒤로']]} />
    </div>
  );
}

const crestSrc = (club) => club.crest || `/crests/${club.short}.png`;

function Crest({ club, size = 96 }) {
  const [failed, setFailed] = useState(false);
  if (failed) return <DesignedCrest club={club} size={size} />;
  return (
    <div className="crest-img" style={{ width: size, height: size }}>
      <img src={crestSrc(club)} alt={club.name} draggable={false} onError={() => setFailed(true)} />
    </div>
  );
}

// 작은 엠블럼 (대진표, 결과, 팀 목록)
function MiniCrest({ club, size = 22 }) {
  const [failed, setFailed] = useState(false);
  const k = club.kits.home;
  if (failed) return <span className="mini-crest fallback" style={{ width: size, height: size, background: k.shirt, borderColor: k.trim }} />;
  return <img className="mini-crest" src={crestSrc(club)} alt="" width={size} height={size} draggable={false} onError={() => setFailed(true)} />;
}

// 직접 디자인한 엠블럼: 팀 유니폼 색과 무늬로 만든 방패
function DesignedCrest({ club, size }) {
  const k = club.kits.home;
  const id = 'c' + club.short;
  const second = k.shirt2 || k.sleeve || k.trim;
  let fill;
  if (k.pattern === 'stripes') fill = <pattern id={id} width="16" height="10" patternUnits="userSpaceOnUse"><rect width="8" height="10" fill={k.shirt} /><rect x="8" width="8" height="10" fill={second} /></pattern>;
  else if (k.pattern === 'diag') fill = <linearGradient id={id} x1="0" y1="0" x2="1" y2="1"><stop offset="0.5" stopColor={k.shirt} /><stop offset="0.5" stopColor={second} /></linearGradient>;
  else if (k.pattern === 'band' || k.pattern === 'sleeves') fill = <linearGradient id={id} x1="0" x2="1"><stop offset="0.38" stopColor={k.shirt} /><stop offset="0.38" stopColor={second} /><stop offset="0.62" stopColor={second} /><stop offset="0.62" stopColor={k.shirt} /></linearGradient>;
  else fill = <linearGradient id={id} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor={k.shirt} /><stop offset="1" stopColor={k.shirt} stopOpacity="0.8" /></linearGradient>;
  return (
    <svg className="designed-crest" width={size} height={size * 1.15} viewBox="0 0 100 115">
      <defs>{fill}</defs>
      <path d="M50 4 L94 18 V54 C94 82 74 101 50 111 C26 101 6 82 6 54 V18 Z" fill={`url(#${id})`} stroke={k.trim} strokeWidth="6" strokeLinejoin="round" />
      <path d="M50 4 L94 18 V30 H6 V18 Z" fill={k.trim} opacity="0.9" />
      <text x="50" y="26" textAnchor="middle" fontSize="13" fontWeight="900" fill={k.shirt}>★ ★ ★</text>
      <text x="50" y="74" textAnchor="middle" fontSize="28" fontWeight="900" fontStyle="italic" fill={k.trim} stroke="rgba(0,0,0,0.35)" strokeWidth="1">{club.short}</text>
    </svg>
  );
}

function Stars({ value }) {
  return (
    <span className="stars">
      {[0, 1, 2, 3, 4].map(i => {
        const fill = Math.max(0, Math.min(1, value - i));
        return <span key={i} className="star"><span style={{ width: `${fill * 100}%` }}>★</span>★</span>;
      })}
    </span>
  );
}

function TeamPanel({ side, active, label, controller, clubIdx, otherIdx, onActivate, onCycle, onLeague, onPick, lineup }) {
  const club = CLUBS[clubIdx];
  const li = leagueOf(clubIdx);
  const league = LEAGUES[li];
  const [ovr, att, mid, def] = club.rating;
  return (
    <div className={`team-panel ${active ? 'active' : ''}`} onMouseDown={onActivate} style={{ '--league': league.color, '--accent': league.accent }}>
      <div className="panel-head">
        <span className="side-tag">{label}</span>
        <span className="ctrl-tag">{controller}</span>
      </div>
      <div className="league-tabs">
        {LEAGUES.map((l, i) => (
          <button key={l.id} className={i === li ? 'on' : ''} style={{ '--lc': l.color }} onClick={() => onLeague(i)}>{l.name}</button>
        ))}
      </div>
      <div className="club-main">
        <button className="cycle slim" onClick={() => onCycle(-1)}>‹</button>
        <div className="club-card compact">
          <Crest club={club} size={74} />
          <div className="club-info">
            <div className="league-en">{league.en}</div>
            <div className="club-name">{club.name}</div>
            <Stars value={clubStars(club)} />
          </div>
          <div className="ovr-row">
            <div className="ovr"><span>OVR</span>{ovr}</div>
            {[['ATT', att], ['MID', mid], ['DEF', def]].map(([k, v]) => (
              <div key={k} className="sub-ovr">
                <span>{k}</span>{v}
                <i style={{ width: `${(v - 60) / 35 * 100}%` }} />
              </div>
            ))}
          </div>
        </div>
        <button className="cycle slim" onClick={() => onCycle(1)}>›</button>
      </div>
      <Lineup club={club} formation={lineup.formation} style={lineup.style} order={lineup.order} mirror={side === 1} />
      <div className="club-strip">
        {league.teams.map(t => {
          const idx = clubIndex(t.short);
          return (
            <button
              key={t.short}
              className={`mini ${idx === clubIdx ? 'on' : ''}`}
              disabled={idx === otherIdx}
              title={t.name}
              onClick={() => onPick(idx)}
            ><MiniCrest club={t} size={30} /></button>
          );
        })}
      </div>
    </div>
  );
}

// ================= 라인업 편집 (포메이션 / 전술 / 선발 · 후보 교체) =================
function LineupScreen({ opts, setOpts, onBack, onNext }) {
  const [side, setSide] = useState(0);
  const sides = opts.mode === 'cup' ? [0] : [0, 1];
  const sideNames = { '1p': ['1P', 'CPU'], '2p': ['1P', '2P'], cpu: ['CPU', 'CPU'], cup: ['1P'], host: ['나', '친구'] }[opts.mode] || ['HOME', 'AWAY'];
  const idx = opts.team[side];
  const setLineup = (clubIdx, v) => setOpts(o => ({ ...o, lineup: { ...(o.lineup || {}), [clubIdx]: v } }));
  useKeys((e) => {
    if (e.key === 'Tab') setSide(x => (sides.length > 1 ? 1 - x : 0));
    else if (e.key === 'Enter') onNext();
    else if (e.key === 'Escape' || e.key === 'Backspace') onBack();
    else return;
    e.preventDefault();
  });
  const can = +opts.size === 11;
  return (
    <div className="fc-overlay lineup-screen">
      <TopBar crumbs={['홈', modeName(opts.mode), '팀 선택', '라인업']} />
      <div className="lineup-tabs">
        {sides.map(sd => {
          const cl = CLUBS[opts.team[sd]];
          return (
            <button key={sd} className={side === sd ? 'on' : ''} onClick={() => setSide(sd)}>
              <Crest club={cl} size={30} /><span>{sd === 0 ? 'HOME' : 'AWAY'} · {sideNames[sd]}</span><b>{cl.name}</b>
            </button>
          );
        })}
      </div>
      {can
        ? <LineupEditor key={idx} club={CLUBS[idx]} value={lineupOf(opts, idx)} onChange={(v) => setLineup(idx, v)} />
        : <div className="lineup-off">라인업 편집은 11대11 경기에서만 쓸 수 있어요. (인원은 경기 설정에서 바꿀 수 있어요)</div>}
      <div className="bottom-actions">
        <button className="fc-btn" onClick={onBack}>뒤로</button>
        <button className="fc-btn primary" onClick={onNext}>다음: 경기 설정 ›</button>
      </div>
      <FooterHints hints={[['Tab', 'HOME/AWAY 전환'], ['클릭', '선수 교체'], ['Enter', '다음'], ['Esc', '뒤로']]} />
    </div>
  );
}

function LineupEditor({ club, value, onChange }) {
  const [sel, setSel] = useState(null);       // { kind: 'slot' | 'bench', i }
  const { formation, style, order } = value;
  const slots = lineupFor(11, formation);
  const bench = Array.from({ length: club.players.length }, (_, i) => i).filter(i => !order.includes(i));
  const k = club.kits.home;
  const kitText = luma(k.shirt) > 150 ? '#0b1220' : '#fff';

  const pick = (kind, i) => {
    if (!sel) { setSel({ kind, i }); return; }
    if (sel.kind === kind && sel.i === i) { setSel(null); return; }
    const next = order.slice();
    if (sel.kind === 'slot' && kind === 'slot') { [next[sel.i], next[i]] = [next[i], next[sel.i]]; }
    else if (sel.kind === 'slot' && kind === 'bench') { next[sel.i] = i; }
    else if (sel.kind === 'bench' && kind === 'slot') { next[i] = sel.i; }
    else { setSel({ kind, i }); return; }
    onChange({ ...value, order: next });
    setSel(null);
  };
  const fits = (slotPos, ri) => SLOT_ROLE[slotPos] === squadRole(club, ri);
  const fit = order.reduce((a, ri, i) => a + (fits(slots[i].slot[0], ri) ? 1 : 0), 0);

  return (
    <div className="editor-inline">
      <div className="editor" style={{ '--kit': k.shirt }}>
        <div className="editor-head">
          <div><div className="fc-eyebrow">LINEUP EDITOR</div><h2>{club.name}</h2></div>
          <div className="editor-fit">포지션 적합 <b>{fit}</b>/11</div>
        </div>
        <div className="editor-body">
          <div className="editor-side">
            <h4>포메이션</h4>
            <div className="chips">
              {formationList(11).map(f => <button key={f} className={f === formation ? 'on' : ''} onClick={() => onChange({ ...value, formation: f })}>{f}</button>)}
            </div>
            <h4>전술</h4>
            <div className="chips">
              {STYLE_ORDER.map(x => <button key={x} className={x === style ? 'on' : ''} onClick={() => onChange({ ...value, style: x })}>{STYLES[x].label}</button>)}
            </div>
            <button className="fc-btn reset" onClick={() => { const sug = suggestTactics(club, 11); onChange({ formation: sug.formation, style: sug.style, order: ROSTER_PICK[11].slice() }); setSel(null); }}>↺ 추천 라인업으로</button>
            <p className="editor-tip">선수를 누르고 → 바꿀 선수(경기장 위 또는 후보)를 누르면 자리가 바뀌어요. 테두리가 <b>주황색</b>이면 본래 포지션이 아닌 자리예요.</p>
          </div>
          <div className="editor-pitch lineup-pitch">
            <i className="lp-c" /><i className="lp-b t" /><i className="lp-b b" />
            {slots.map(({ slot }, i) => {
              const ri = order[i], p = club.players[ri];
              const top = 8 + (1 - (slot[1] - 0.03) / 0.67) * 82, left = 11 + (slot[2] - 0.08) / 0.84 * 78;
              const on = sel && sel.kind === 'slot' && sel.i === i;
              return (
                <button key={i} className={`pl pl-btn ${on ? 'sel' : ''} ${fits(slot[0], ri) ? '' : 'off'}`} style={{ left: `${left}%`, top: `${top}%` }} onClick={() => pick('slot', i)}>
                  <Face club={club} ri={ri} p={p} size={50} />
                  <span className="pl-num" style={{ background: k.shirt, color: kitText }}>{p[1]}</span>
                  <span className="pl-name">{p[0]}</span>
                  <span className="pl-pos">{slot[0]}</span>
                </button>
              );
            })}
          </div>
          <div className="editor-bench">
            <h4>후보 <small>{bench.length}명</small></h4>
            {bench.map(ri => {
              const p = club.players[ri];
              const on = sel && sel.kind === 'bench' && sel.i === ri;
              return (
                <button key={ri} className={`bench-row ${on ? 'sel' : ''}`} onClick={() => pick('bench', ri)}>
                  <Face club={club} ri={ri} p={p} size={40} />
                  <b>{p[0]}</b><span className="tag">{squadRole(club, ri)}</span><i>{p[1]}</i>
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

// 선수 얼굴: Blender로 렌더한 사진(public/faces) → 없으면 간단한 그림으로 대체
function Face({ club, ri, p, size = 42 }) {
  // 0: 실제 사진(public/faces_real) → 1: Blender 얼굴 → 2: 그림
  const [stage, setStage] = useState(0);
  const look = resolveLook(club.short, ri, p[0], p[1]);
  const k = club.kits.home;
  const kitText = luma(k.shirt) > 150 ? '#0b1220' : '#ffffff';
  return (
    <span className="face" style={{ width: size, height: size, '--kit': k.shirt, '--kit-text': kitText }}>
      {stage >= 2
        ? <FallbackFace look={look} />
        : <img className={stage === 0 ? 'real' : ''} src={stage === 0 ? `/faces_real/${club.short}_${ri}.jpg` : `/faces/${club.short}_${ri}.png`} alt={p[0]} draggable={false} onError={() => setStage(st => st + 1)} />}
    </span>
  );
}
const luma = (hex) => { const v = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)); return 0.299 * v[0] + 0.587 * v[1] + 0.114 * v[2]; };

function FallbackFace({ look }) {
  return (
    <svg viewBox="0 0 100 100" width="100%" height="100%">
      <rect width="100" height="100" fill="#243247" />
      <ellipse cx="50" cy="56" rx="24" ry="29" fill={look.skinHex} />
      {look.hairStyle !== 'bald' && <path d="M24 50 Q26 14 50 14 Q74 14 76 50 Q70 32 50 30 Q30 32 24 50Z" fill={look.hairHex} />}
      <circle cx="41" cy="54" r="3.2" fill="#2a1a10" /><circle cx="59" cy="54" r="3.2" fill="#2a1a10" />
      {look.beardStyle !== 'none' && <path d="M27 62 Q50 104 73 62 Q64 76 50 76 Q36 76 27 62Z" fill={look.hairHex} opacity={look.beardStyle === 'full' ? 0.95 : 0.4} />}
      <path d="M43 68 Q50 72 57 68" stroke="#8c2f3a" strokeWidth="3" fill="none" strokeLinecap="round" />
    </svg>
  );
}

// 라인업: 포메이션대로 선수 얼굴 + 등번호 + 이름을 배치 (HOME은 오른쪽 공격, AWAY는 왼쪽 공격)
function Lineup({ club, formation, style, mirror, order }) {
  const slots = lineupFor(11, formation).map((x, i) => order ? { ...x, rosterIndex: order[i] } : x);
  const k = club.kits.home;
  return (
    <div className="lineup" style={{ '--kit': k.shirt }}>
      <div className="lineup-head"><b>{formation}</b><span>스타팅 11 · {STYLES[style] ? STYLES[style].label : '균형'} 전술</span></div>
      <div className="lineup-pitch"><i className="lp-c" /><i className="lp-b t" /><i className="lp-b b" />
        {slots.map(({ slot, rosterIndex }) => {
          const p = club.players[rosterIndex];
          // 세로 배치: 골키퍼가 아래, 공격수가 위
          const top = 8 + (1 - (slot[1] - 0.03) / 0.67) * 82;
          const left = 11 + (slot[2] - 0.08) / 0.84 * 78;
          return (
            <div key={rosterIndex} className="pl" style={{ left: `${left}%`, top: `${top}%` }}>
              <Face club={club} ri={rosterIndex} p={p} />
              <span className="pl-num" style={{ background: k.shirt, color: luma(k.shirt) > 150 ? '#0b1220' : '#fff' }}>{p[1]}</span>
              <span className="pl-name">{p[0]}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ================= 경기 설정 =================
function MatchSettings({ opts, setOpts, onBack, onStart }) {
  const sides = opts.mode === '2p' || opts.mode === 'cpu' ? [0, 1] : [0];
  const base = Object.keys(SETTINGS).filter(k => k !== 'diff' || opts.mode === '1p' || opts.mode === 'cup');
  const tacRows = [];     // 포메이션/전술은 팀 선택의 라인업 편집에서 설정
  const at = base.indexOf('rules') + 1;
  const keys = [...base.slice(0, at), ...tacRows, ...base.slice(at)];
  const [row, setRow] = useState(0);
  const change = (key, value) => setOpts(o => {
    const next = { ...o, [key]: value };
    if (key === 'size') { next.form0 = 'auto'; next.form1 = 'auto'; }      // 인원이 바뀌면 포메이션 목록도 바뀜
    return next;
  });
  useEffect(() => {
    const el = document.querySelector('.set-row.focus');
    if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
  }, [row]);
  useKeys((e) => {
      const key = keys[row];
      if (e.key === 'ArrowDown') setRow(r => Math.min(keys.length, r + 1));
      else if (e.key === 'ArrowUp') setRow(r => Math.max(0, r - 1));
      else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && key) {
        const list = optionsOf(key, opts.size).map(x => x[0]);
        const i = Math.max(0, list.indexOf(opts[key]));
        const ni = (i + (e.key === 'ArrowRight' ? 1 : -1) + list.length) % list.length;
        change(key, list[ni]);
      } else if (e.key === 'Enter') onStart();
      else if (e.key === 'Escape' || e.key === 'Backspace') onBack();
      else return;
      e.preventDefault();
    });

  const [h, a] = [CLUBS[opts.team[0]], CLUBS[opts.team[1]]];
  return (
    <div className="fc-overlay settings-screen">
      <TopBar crumbs={['홈', modeName(opts.mode), '경기 설정']} />
      <div className="settings-wrap">
        <div className="matchup">
          <div className="mu-team"><Crest club={h} size={64} /><div><div className="mu-name">{h.name}</div><Stars value={clubStars(h)} /></div></div>
          <div className="mu-vs">VS</div>
          {opts.mode === 'cup'
            ? <div className="mu-team right"><div><div className="mu-name">8강 토너먼트</div><div className="muted">상대는 추첨으로 정해져요</div></div><div className="trophy-mini">🏆</div></div>
            : <div className="mu-team right"><div><div className="mu-name">{a.name}</div><Stars value={clubStars(a)} /></div><Crest club={a} size={64} /></div>}
        </div>
        <div className="settings-list">
          {keys.map((k, i) => (
            <div key={k} className={`set-row ${row === i ? 'focus' : ''}`} onMouseEnter={() => setRow(i)}>
              <label>{SETTING_LABELS[k]}</label>
              <div className="set-opts">
                {optionsOf(k, opts.size).map(([v, text]) => (
                  <button key={v} className={opts[k] === v ? 'on' : ''} onClick={() => change(k, v)}>{text}</button>
                ))}
              </div>
            </div>
          ))}
        </div>
        <div className="bottom-actions">
          <button className="fc-btn" onClick={onBack}>뒤로</button>
          <button className={`fc-btn primary big ${row === keys.length ? 'focus' : ''}`} onClick={onStart}>{opts.mode === 'cup' ? '대회 시작 🏆' : '킥오프 ⚽'}</button>
        </div>
      </div>
      <FooterHints hints={[['↑↓', '항목'], ['←→', '변경'], ['Enter', '킥오프'], ['Esc', '뒤로']]} />
    </div>
  );
}

// ================= 조작법 =================
function ControlsScreen({ onBack }) {
  useKeys((e) => { if (e.key === 'Escape' || e.key === 'Backspace' || e.key === 'Enter') onBack(); });
  return (
    <div className="fc-overlay settings-screen">
      <TopBar crumbs={['홈', '조작법']} />
      <div className="settings-wrap">
        <ControlsPanel mode="1p" />
        <ControlsPanel mode="2p" />
        <div className="bottom-actions"><button className="fc-btn" onClick={onBack}>뒤로</button></div>
      </div>
      <FooterHints hints={[['Esc', '뒤로']]} />
    </div>
  );
}

function Keys({ keys }) {
  return keys.map((k, i) => <kbd key={i}>{k}</kbd>);
}

function GuideBox({ title, rows }) {
  return (
    <div className="box">
      <h3>{title}</h3>
      <table>
        <tbody>
          {rows.map(([label, keys]) => (
            <tr key={label}><td><Keys keys={keys} /></td><td>{label}</td></tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ControlsPanel({ mode }) {
  if (mode === 'cpu') {
    return <div className="controls"><div className="box"><h3>관전 모드</h3><kbd>C</kbd> 카메라 전환 · <kbd>Esc</kbd> 일시정지</div></div>;
  }
  if (mode === '2p') {
    return (
      <div className="controls">
        <GuideBox title="1P (HOME)" rows={CONTROL_GUIDE.p1} />
        <GuideBox title="2P (AWAY)" rows={CONTROL_GUIDE.p2} />
      </div>
    );
  }
  return (
    <div className="controls">
      <GuideBox title="1P 조작 (피파 온라인 배치)" rows={CONTROL_GUIDE.single} />
      <div className="box">
        <h3>팁</h3>
        <ul>
          <li><kbd>S</kbd>만 눌러도 AI가 좋은 동료를 골라 패스해요.</li>
          <li>수비 땐 <kbd>S</kbd>를 <b>누르고 있으면</b> 자동 압박·태클.</li>
          <li>슛은 <kbd>D</kbd> 꾹 → 떼기. <kbd>↑</kbd>/<kbd>↓</kbd>로 구석 조준.</li>
          <li>골 리플레이는 아무 키나 눌러 건너뛰기.</li>
          <li>경기 중 전술 변경: <kbd>1</kbd>~<kbd>6</kbd> 스타일, <kbd>B</kbd> 포메이션, <kbd>7</kbd>/<kbd>8</kbd> 압박, <kbd>9</kbd>/<kbd>0</kbd> 수비 라인.</li>
        </ul>
      </div>
    </div>
  );
}

// ================= 결과 =================
function Result({ result, onAgain, onMenu, cupRound, againLabel }) {
  const { summary: s, infos } = result;
  const winner = s[0].score === s[1].score ? null : s[0].score > s[1].score ? 0 : 1;
  const scorers = i => s[i].goals.length
    ? s[i].goals.map((g, k) => <div key={k}>⚽ {g.name || ''}{g.own ? ' (자책골)' : ''} {g.minute}&apos;</div>)
    : null;
  const rows = [['점유율', 'possession', '%'], ['슈팅', 'shots', ''], ['유효 슈팅', 'onTarget', ''], ['패스', 'passes', ''], ['파울', 'fouls', ''], ['경고', 'yellow', ''], ['퇴장', 'red', ''], ['오프사이드', 'offsides', '']];
  return (
    <div className="fc-overlay dim">
      <div className="fc-result">
        <div className="fc-eyebrow">FULL TIME{cupRound ? ` · ${cupRound}` : ''}</div>
        <div className="final-score">
          <div className={`fs-team ${winner === 0 ? 'win' : ''}`}><MiniCrest club={{ ...infos[0], kits: { home: infos[0].kit } }} size={34} />{s[0].name}</div>
          <div className="fs-num">{s[0].score}<span>-</span>{s[1].score}</div>
          <div className={`fs-team right ${winner === 1 ? 'win' : ''}`}>{s[1].name}<MiniCrest club={{ ...infos[1], kits: { home: infos[1].kit } }} size={34} /></div>
        </div>
        <div className="scorers"><div>{scorers(0)}</div><div>{scorers(1)}</div></div>
        <div className="stat-bars">
          {rows.filter(([, key]) => ['possession', 'shots', 'onTarget', 'passes'].includes(key) || s[0][key] + s[1][key] > 0).map(([label, key, unit]) => {
            const a = s[0][key], b = s[1][key], t = (a + b) || 1;
            return (
              <div key={key} className="stat">
                <div className="stat-top"><b>{a}{unit}</b><span>{label}</span><b>{b}{unit}</b></div>
                <div className="stat-bar"><i style={{ width: `${a / t * 100}%`, background: infos[0].color }} /><i style={{ width: `${b / t * 100}%`, background: infos[1].color }} /></div>
              </div>
            );
          })}
        </div>
        <div className="bottom-actions">
          <button className="fc-btn primary" onClick={onAgain}>{againLabel || '다시 하기'}</button>
          <button className="fc-btn" onClick={onMenu}>{cupRound ? '대회 포기' : '메인 메뉴'}</button>
        </div>
        {cupRound && s[0].score === s[1].score && <div className="muted center">무승부 — 대진표에서 승부차기 결과를 확인하세요</div>}
      </div>
    </div>
  );
}

// ================= 컵 대회 =================
function CupInfo() {
  return (
    <div className="team-panel cup-info">
      <div className="panel-head"><span className="side-tag">CUP</span><span className="ctrl-tag">8 TEAMS</span></div>
      <div className="cup-info-body">
        <div className="trophy">🏆</div>
        <h3>컵 대회</h3>
        <p>내 팀을 고르면 나머지 7팀은 5대 리그와 국가대표 중에서 추첨돼요.</p>
        <p>8강 → 준결승 → 결승. 비기면 승부차기로 다음 라운드 진출 팀을 가려요.</p>
      </div>
    </div>
  );
}

function CupScreen({ cup, onPlay, onMenu }) {
  const opp = cupOpponent(cup);
  useKeys((e) => {
    if (e.key === 'Enter') { if (!cup.done && !cup.eliminated) onPlay(); else onMenu(); e.preventDefault(); }
    if (e.key === 'Escape') onMenu();
  });
  const user = CLUBS[cup.user];
  const won = cup.done && cup.champion === cup.user;
  const Team = ({ idx, m, side }) => {
    if (idx === undefined || idx === null) return <div className="bk-team tbd">미정</div>;
    const c = CLUBS[idx];
    const g = m && m.played ? (side === 'a' ? m.ga : m.gb) : null;
    const p = m && m.pa !== undefined ? (side === 'a' ? m.pa : m.pb) : null;
    const lose = m && m.played && m.winner !== idx;
    return (
      <div className={`bk-team ${idx === cup.user ? 'me' : ''} ${lose ? 'lose' : ''}`}>
        <MiniCrest club={c} size={22} />
        <span className="bk-name">{c.name}</span>
        {g !== null && <b>{g}{p !== null ? <small> ({p})</small> : null}</b>}
      </div>
    );
  };
  const rounds = [0, 1, 2].map(r => cup.rounds[r] || Array.from({ length: 4 >> r }, () => ({})));
  return (
    <div className="fc-overlay cup-screen">
      <TopBar crumbs={['홈', '컵 대회', '대진표']} />
      <div className="cup-wrap">
        <div className="cup-head">
          <div>
            <div className="fc-eyebrow">KICKOFF CUP</div>
            <h1 className="fc-h1">{won ? '우승!' : cup.eliminated ? '탈락' : ROUND_NAMES[cup.round]}</h1>
          </div>
          {!cup.done && !cup.eliminated && opp !== null && (
            <div className="next-match">
              <div className="nm-label">다음 경기 · {ROUND_NAMES[cup.round]}</div>
              <div className="nm-teams"><Crest club={user} size={44} /><span>VS</span><Crest club={CLUBS[opp]} size={44} /></div>
              <div className="nm-names">{user.name} vs {CLUBS[opp].name}</div>
            </div>
          )}
        </div>
        {won && (
          <div className="champion">
            <div className="champ-trophy">🏆</div>
            <div>
              <div className="champ-title">{user.name} 우승!</div>
              <div className="muted">축하합니다! 컵 대회 정상에 올랐어요.</div>
            </div>
          </div>
        )}
        {cup.done && !won && (
          <div className="champion lost">
            <div className="champ-trophy">🏆</div>
            <div>
              <div className="champ-title">우승: {CLUBS[cup.champion].name}</div>
              <div className="muted">다음 대회에서 다시 도전해 보세요.</div>
            </div>
          </div>
        )}
        <div className="bracket">
          {rounds.map((ms, r) => (
            <div key={r} className="bk-col">
              <div className="bk-round">{ROUND_NAMES[r]}</div>
              <div className="bk-matches">
                {ms.map((m, i) => (
                  <div key={i} className={`bk-match ${m.a === cup.user || m.b === cup.user ? 'mine' : ''}`}>
                    <Team idx={m.a} m={m} side="a" />
                    <Team idx={m.b} m={m} side="b" />
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
      <div className="bottom-actions">
        <button className="fc-btn" onClick={onMenu}>{cup.done || cup.eliminated ? '메인 메뉴' : '대회 포기'}</button>
        {!cup.done && !cup.eliminated && <button className="fc-btn primary big" onClick={onPlay}>{ROUND_NAMES[cup.round]} 킥오프 ⚽</button>}
      </div>
      <FooterHints hints={[['Enter', cup.done || cup.eliminated ? '메인 메뉴' : '경기 시작'], ['Esc', '메인 메뉴']]} />
    </div>
  );
}

// ================= 공통 =================
function modeName(m) { return { '1p': '킥오프', '2p': '로컬 대전', cpu: '관전 모드', cup: '컵 대회', host: '멀티플레이' }[m]; }

function TopBar({ crumbs }) {
  return (
    <div className="topbar">
      <div className="brand"><img src="/logo.svg" alt="" />KICKOFF<b>26</b></div>
      <div className="crumbs">{crumbs.map((c, i) => <span key={i}>{c}</span>)}</div>
    </div>
  );
}

function FooterHints({ hints }) {
  return (
    <div className="footer-hints">
      {hints.map(([k, t]) => <span key={k}><kbd>{k}</kbd>{t}</span>)}
    </div>
  );
}
