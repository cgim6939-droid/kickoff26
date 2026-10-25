// Web Audio로 직접 합성하는 효과음
export const Sound = {
  ctx: null, master: null, muted: false, noise: null, crowd: null,

  init() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.6;
    this.master.connect(this.ctx.destination);
    const len = this.ctx.sampleRate * 2;
    this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    // 관중 소음 (배경)
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise; src.loop = true;
    const f = this.ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 500; f.Q.value = 0.6;
    this.crowd = this.ctx.createGain(); this.crowd.gain.value = 0;
    src.connect(f); f.connect(this.crowd); this.crowd.connect(this.master);
    src.start();
    // 빗소리 (고음 잡음)
    const rs = this.ctx.createBufferSource();
    rs.buffer = this.noise; rs.loop = true;
    const rf = this.ctx.createBiquadFilter(); rf.type = 'highpass'; rf.frequency.value = 2500;
    this.rain = this.ctx.createGain(); this.rain.gain.value = 0;
    rs.connect(rf); rf.connect(this.rain); this.rain.connect(this.master);
    rs.start();
    if (this.pendingRain) this.setRain(this.pendingRain);
  },

  setRain(v) {
    if (!this.rain) { this.pendingRain = v; return; }
    this.rain.gain.setTargetAtTime(v * 0.06, this.ctx.currentTime, 0.6);
  },

  toggleMute() {
    this.muted = !this.muted;
    if (this.master) this.master.gain.value = this.muted ? 0 : 0.6;
    return this.muted;
  },

  setCrowd(v) { if (this.crowd) this.crowd.gain.setTargetAtTime(v, this.ctx.currentTime, 0.5); },

  noiseBurst(dur, freq, q, vol, type) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const s = this.ctx.createBufferSource(); s.buffer = this.noise;
    const f = this.ctx.createBiquadFilter(); f.type = type || 'bandpass'; f.frequency.value = freq; f.Q.value = q;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    s.connect(f); f.connect(g); g.connect(this.master);
    s.start(t, Math.random()); s.stop(t + dur + 0.05);
  },

  tone(freq, dur, vol, type, slideTo) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator(); o.type = type || 'sine';
    o.frequency.setValueAtTime(freq, t);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g); g.connect(this.master);
    o.start(t); o.stop(t + dur + 0.05);
  },

  kick(power) {
    const v = Math.min(1, power / 1000);
    this.tone(150, 0.12, 0.25 + v * 0.35, 'sine', 50);
    this.noiseBurst(0.05, 1200, 1, 0.15 + v * 0.25);
  },

  whistle(n, short) {
    if (!this.ctx) return;
    for (let i = 0; i < n; i++) {
      const t = this.ctx.currentTime + i * 0.45;
      const dur = short ? 0.22 : (i === n - 1 && n > 1 ? 0.7 : 0.35);
      const o = this.ctx.createOscillator(); o.type = 'sine'; o.frequency.value = 2900;
      const lfo = this.ctx.createOscillator(); lfo.frequency.value = 32;
      const lg = this.ctx.createGain(); lg.gain.value = 140;
      lfo.connect(lg); lg.connect(o.frequency);
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.12, t + 0.02);
      g.gain.setValueAtTime(0.12, t + dur - 0.05); g.gain.linearRampToValueAtTime(0, t + dur);
      o.connect(g); g.connect(this.master);
      o.start(t); lfo.start(t); o.stop(t + dur + 0.05); lfo.stop(t + dur + 0.05);
    }
  },

  roar(dur, vol) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const s = this.ctx.createBufferSource(); s.buffer = this.noise; s.loop = true;
    const f = this.ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 700; f.Q.value = 0.5;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.001, t); g.gain.exponentialRampToValueAtTime(vol, t + 0.3);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    s.connect(f); f.connect(g); g.connect(this.master);
    s.start(t); s.stop(t + dur + 0.1);
  },

  play(e) {
    switch (e.type) {
      case 'kick': this.kick(e.power); break;
      case 'whistle': this.whistle(e.n, e.short); break;
      case 'goal': this.roar(3.2, 0.5); this.whistle(1, true); break;
      case 'save': this.roar(1.2, 0.18); this.tone(90, 0.15, 0.4); break;
      case 'post': this.tone(1250, 0.4, 0.2, 'triangle'); this.tone(1870, 0.3, 0.12, 'triangle'); this.roar(1.2, 0.2); break;
      case 'miss': this.roar(1.0, 0.12); break;
      case 'tackle': this.noiseBurst(0.08, 400, 1, 0.3); break;
      case 'slide': this.noiseBurst(0.25, 2500, 0.5, 0.08, 'highpass'); break;
      case 'dribble': this.tone(110, 0.05, 0.07, 'sine', 60); this.noiseBurst(0.025, 900, 1, 0.035); break;
    }
  },
};
