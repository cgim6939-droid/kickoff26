// 온라인 1대1: 방 코드로 접속 (WebRTC, PeerJS 공용 중계 서버로 연결만 맺고 이후엔 두 브라우저가 직접 통신)
// 방장이 경기를 계산하고 상태를 보내 주며, 손님은 키 입력만 보내고 받은 상태를 그려요.
//
// 연결은 두 개를 같이 열어요:
//   ctl  = 순서/전달이 보장되는 길 (시작, 골 같은 이벤트, 종료, 버튼 입력, 핑)
//   fast = 순서 보장 없는 길 (선수/공 위치, 이동 입력) — 패킷이 늦어져도 뒤 패킷이 막히지 않게 해서 끊김을 줄여요
const PREFIX = 'kickoff26-';
const ALPHA = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export function makeCode() {
  let s = '';
  for (let i = 0; i < 5; i++) s += ALPHA[Math.floor(Math.random() * ALPHA.length)];
  return s;
}

export function cleanCode(v) {
  return String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5);
}

// 두 연결을 묶어서 send(신뢰) / sendFast(빠름)을 제공
function makeLink(h) {
  const L = { ctl: null, fast: null, closed: false };
  const close = () => { if (!L.closed) { L.closed = true; h.onClose && h.onClose(); } };
  const attach = (conn, kind) => {
    L[kind] = conn;
    conn.on('open', () => { if (kind === 'ctl') h.onOpen && h.onOpen(); });
    conn.on('data', (m) => h.onMsg && h.onMsg(m));
    // 빠른 길은 끊겨도 신뢰 길로 대신 보내면 되므로 경기를 끝내지 않음
    conn.on('close', () => { if (kind === 'ctl') close(); else L.fast = null; });
    conn.on('error', () => { if (kind === 'ctl') close(); });
  };
  const safe = (c, m) => { try { if (c && c.open) { c.send(m); return true; } } catch (e) { /* 연결 끊김 */ } return false; };
  const api = {
    attach,
    send: (m) => safe(L.ctl, m),
    sendFast: (m) => safe(L.fast, m) || safe(L.ctl, m),
    close: () => { for (const k of ['ctl', 'fast']) { try { if (L[k]) L[k].close(); } catch (e) { /* 이미 닫힘 */ } } },
  };
  return api;
}

// 방 만들기: 손님이 들어오면 h.onOpen. 반환: { code, send, sendFast, close }
export async function hostRoom(h) {
  const { Peer } = await import('peerjs');
  for (let tries = 0; tries < 5; tries++) {
    const code = makeCode();
    try {
      const peer = await new Promise((resolve, reject) => {
        const p = new Peer(PREFIX + code, { debug: 0 });
        p.on('open', () => resolve(p));
        p.on('error', reject);
      });
      const link = makeLink(h);
      let taken = false;
      const room = {
        code, peer,
        send: (m) => link.send(m), sendFast: (m) => link.sendFast(m),
        close: () => { link.close(); try { peer.destroy(); } catch (e) { /* 이미 닫힘 */ } },
      };
      peer.on('connection', (conn) => {
        const kind = conn.label === 'fast' ? 'fast' : 'ctl';
        if (kind === 'ctl') { if (taken) { conn.close(); return; } taken = true; }
        link.attach(conn, kind);
      });
      peer.on('error', () => h.onClose && h.onClose());
      return room;
    } catch (e) {
      if (!(e && e.type === 'unavailable-id')) throw e;
    }
  }
  throw new Error('방을 만들지 못했어요');
}

// 코드로 참가: 반환 { send, sendFast, close }
export async function joinRoom(code, h) {
  const { Peer } = await import('peerjs');
  const peer = new Peer({ debug: 0 });
  await new Promise((resolve, reject) => { peer.on('open', resolve); peer.on('error', reject); });
  const id = PREFIX + cleanCode(code);
  const link = makeLink(h);
  const ctl = peer.connect(id, { label: 'ctl', reliable: true, serialization: 'json' });
  link.attach(ctl, 'ctl');
  const fast = peer.connect(id, { label: 'fast', reliable: false, serialization: 'json' });
  link.attach(fast, 'fast');
  peer.on('error', () => h.onClose && h.onClose());
  // 10초 안에 연결이 안 되면 실패
  setTimeout(() => { if (!ctl.open) { h.onFail && h.onFail(); link.close(); } }, 10000);
  return { send: link.send, sendFast: link.sendFast, close: () => { link.close(); try { peer.destroy(); } catch (e) { /* 이미 닫힘 */ } } };
}
