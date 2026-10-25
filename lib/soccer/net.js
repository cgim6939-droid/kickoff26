// 온라인 1대1: 방 코드로 접속 (WebRTC, PeerJS 공용 중계 서버로 연결만 맺고 이후엔 두 브라우저가 직접 통신)
// 방장이 경기를 계산하고 상태를 보내 주며, 손님은 키 입력만 보내고 받은 상태를 그려요.
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

function wire(conn, h) {
  let closed = false;
  const close = () => { if (!closed) { closed = true; h.onClose && h.onClose(); } };
  conn.on('open', () => h.onOpen && h.onOpen());
  conn.on('data', (m) => h.onMsg && h.onMsg(m));
  conn.on('close', close);
  conn.on('error', close);
  return {
    send: (m) => { try { if (conn.open) conn.send(m); } catch (e) { /* 연결 끊김 */ } },
    close: () => { try { conn.close(); } catch (e) { /* 이미 닫힘 */ } },
  };
}

// 방 만들기: 손님이 들어오면 h.onOpen. 반환: { code, send, close }
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
      const room = { code, peer, link: null, send: () => {}, close: () => { try { peer.destroy(); } catch (e) { /* 이미 닫힘 */ } } };
      peer.on('connection', (conn) => {
        if (room.link) { conn.close(); return; }      // 한 명만 입장
        room.link = wire(conn, h);
        room.send = room.link.send;
      });
      peer.on('error', () => h.onClose && h.onClose());
      return room;
    } catch (e) {
      if (!(e && e.type === 'unavailable-id')) throw e;
    }
  }
  throw new Error('방을 만들지 못했어요');
}

// 코드로 참가: 반환 { send, close }
export async function joinRoom(code, h) {
  const { Peer } = await import('peerjs');
  const peer = new Peer({ debug: 0 });
  await new Promise((resolve, reject) => { peer.on('open', resolve); peer.on('error', reject); });
  const conn = peer.connect(PREFIX + cleanCode(code), { reliable: true, serialization: 'json' });
  const link = wire(conn, h);
  peer.on('error', () => h.onClose && h.onClose());
  // 10초 안에 연결이 안 되면 실패
  setTimeout(() => { if (!conn.open) { h.onFail && h.onFail(); link.close(); } }, 10000);
  return { send: link.send, close: () => { link.close(); try { peer.destroy(); } catch (e) { /* 이미 닫힘 */ } } };
}
