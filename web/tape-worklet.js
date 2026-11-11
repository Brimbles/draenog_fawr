// The tape: a multitrack recorder after the emulator in the audio graph (web/tape.js drives it).
// The emulator's sound passes through to the speakers; the tracks play beside it from the
// playhead; a take records the emulator's sound from a start position, in chunks posted to the
// page. A click (metronome) and a count-in help to play in time.

const CLICK_LEN = 0.025;                    // s

class Tape extends AudioWorkletProcessor {
  constructor() {
    super();
    this.tracks = new Map();                // id -> { l, r, start, gain, pan, mute, solo }
    this.pos = 0;                           // the playhead, in frames
    this.playing = false;
    this.rec = null;                        // { id, start, l, r, fill }
    this.click = { on: false, bpm: 120, beats: 4 };
    this.monitor = 1;
    this.sinceReport = 0;
    this.port.onmessage = (e) => this.message(e.data);
  }

  message(m) {
    switch (m.type) {
      case "add": this.tracks.set(m.id, { l: m.l, r: m.r, start: m.start, gain: m.gain, pan: m.pan, mute: m.mute, solo: m.solo }); break;
      case "update": { const t = this.tracks.get(m.id); if (t) Object.assign(t, m.props); break; }
      case "remove": this.tracks.delete(m.id); break;
      case "clear": this.tracks.clear(); break;
      case "seek": this.pos = Math.max(0, Math.round(m.pos)); this.report(); break;
      case "play": this.pos = Math.round(m.from); this.playing = true; this.report(); break;
      case "record":
        // from `from` (the count-in before it, when asked), into take `id` from `start`
        this.pos = Math.round(m.from);
        this.playing = true;
        this.rec = { id: m.id, start: Math.round(m.start), l: new Float32Array(CHUNK), r: new Float32Array(CHUNK), fill: 0, started: false };
        this.report();
        break;
      case "stop":
        this.playing = false;
        if (this.rec) this.endTake();
        this.report();
        break;
      case "click": Object.assign(this.click, m.click); break;
      case "monitor": this.monitor = m.gain; break;
    }
  }

  flush() {
    const r = this.rec;
    if (!r.fill) return;
    const l = r.l.slice(0, r.fill), rr = r.r.slice(0, r.fill);
    this.port.postMessage({ type: "chunk", id: r.id, l, r: rr }, [l.buffer, rr.buffer]);
    r.fill = 0;
  }
  endTake() {
    this.flush();
    this.port.postMessage({ type: "take-end", id: this.rec.id });
    this.rec = null;
  }
  report() {
    this.sinceReport = 0;
    this.port.postMessage({ type: "pos", pos: this.pos, playing: this.playing, recording: !!this.rec?.started,
      countIn: !!this.rec && !this.rec.started });
  }

  process(inputs, outputs) {
    const out = outputs[0], input = inputs[0];
    const n = out[0].length;
    const ol = out[0], or = out[1] || out[0];
    const il = input?.[0], ir = input?.[1] || il;
    if (il) for (let i = 0; i < n; i++) { ol[i] = il[i] * this.monitor; or[i] = ir[i] * this.monitor; }
    else { ol.fill(0); or.fill(0); }
    if (!this.playing) return true;

    // the tracks
    let solo = false;
    for (const t of this.tracks.values()) if (t.solo) { solo = true; break; }
    for (const t of this.tracks.values()) {
      if (t.mute || (solo && !t.solo)) continue;
      const from = this.pos - t.start;
      if (from + n <= 0 || from >= t.l.length) continue;
      const gl = t.gain * Math.min(1, 1 - t.pan), gr = t.gain * Math.min(1, 1 + t.pan);
      const i0 = Math.max(0, -from), i1 = Math.min(n, t.l.length - from);
      for (let i = i0; i < i1; i++) { ol[i] += t.l[from + i] * gl; or[i] += t.r[from + i] * gr; }
    }

    // the click: a short blip each beat, higher on the bar's first; always in the count-in
    const counting = this.rec && this.pos < this.rec.start;
    if (this.click.on || counting) {
      const beat = sampleRate * 60 / this.click.bpm, len = sampleRate * CLICK_LEN;
      const origin = this.rec ? this.rec.start : 0;       // (beats counted from the take's start)
      for (let i = 0; i < n; i++) {
        const p = this.pos + i - origin;
        const k = Math.floor(p / beat), into = p - k * beat;
        if (into >= len) continue;
        const accent = ((k % this.click.beats) + this.click.beats) % this.click.beats === 0;
        const env = 1 - into / len;
        const s = Math.sin(2 * Math.PI * (accent ? 1760 : 1320) * into / sampleRate) * env * env * 0.35;
        ol[i] += s; or[i] += s;
      }
    }

    // the take: the emulator's sound from its start on
    const r = this.rec;
    if (r && il) {
      for (let i = 0; i < n; i++) {
        if (this.pos + i < r.start) continue;
        if (!r.started) { r.started = true; this.report(); }
        r.l[r.fill] = il[i]; r.r[r.fill] = ir[i];
        if (++r.fill === CHUNK) this.flush();
      }
    }

    this.pos += n;
    if ((this.sinceReport += n) >= sampleRate / 20) this.report();
    return true;
  }
}
const CHUNK = 16384;
registerProcessor("tape", Tape);
