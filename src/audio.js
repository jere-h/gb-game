// Procedural WebAudio SFX — no binary assets. Context starts on first gesture.

export class GameAudio {
  constructor() {
    this.ctx = null;
    this.master = null;
    const start = () => {
      if (this.ctx) return;
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.35;
      this.master.connect(this.ctx.destination);
    };
    window.addEventListener('pointerdown', start, { once: false });
    window.addEventListener('keydown', start, { once: false });
  }

  env(node, t0, a, d, peak = 1) {
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(peak, t0 + a);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + a + d);
    node.connect(g);
    g.connect(this.master);
    return g;
  }

  noiseBuffer(len = 1) {
    const buf = this.ctx.createBuffer(1, this.ctx.sampleRate * len, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }

  fire() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator();
    o.type = 'square';
    o.frequency.setValueAtTime(220, t);
    o.frequency.exponentialRampToValueAtTime(60, t + 0.25);
    this.env(o, t, 0.005, 0.3, 0.5);
    o.start(t); o.stop(t + 0.35);

    const n = this.ctx.createBufferSource();
    n.buffer = this.noiseBuffer(0.3);
    const f = this.ctx.createBiquadFilter();
    f.type = 'lowpass'; f.frequency.value = 1200;
    n.connect(f);
    this.env(f, t, 0.002, 0.22, 0.6);
    n.start(t);
  }

  explosion(big = 1) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const n = this.ctx.createBufferSource();
    n.buffer = this.noiseBuffer(1.2);
    const f = this.ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.setValueAtTime(900 * big, t);
    f.frequency.exponentialRampToValueAtTime(80, t + 0.9);
    n.connect(f);
    this.env(f, t, 0.005, 1.0, 1.0 * big);
    n.start(t);

    const o = this.ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(90, t);
    o.frequency.exponentialRampToValueAtTime(30, t + 0.7);
    this.env(o, t, 0.005, 0.8, 0.8 * big);
    o.start(t); o.stop(t + 0.9);
  }

  splash() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const n = this.ctx.createBufferSource();
    n.buffer = this.noiseBuffer(0.6);
    const f = this.ctx.createBiquadFilter();
    f.type = 'bandpass'; f.frequency.value = 900; f.Q.value = 1.4;
    n.connect(f);
    this.env(f, t, 0.01, 0.5, 0.5);
    n.start(t);
  }

  tick() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator();
    o.type = 'sine'; o.frequency.value = 1200;
    this.env(o, t, 0.001, 0.05, 0.15);
    o.start(t); o.stop(t + 0.06);
  }
}
