// The tape: record what the emulated synth plays into tracks, switch firmware and record over
// it, mix and export. The audio side is web/tape-worklet.js, after the emulator in the graph.
// Tracks are kept in this browser (IndexedDB) and survive reloads and firmware changes.

export const RATE = 44100;
const MAX_TRACKS = 16;

// ---------------------------------------------------------------- pure helpers (tested)

// the track's left and right gains: equal at the centre, the far side fading out
export const panGains = (gain, pan) => [gain * Math.min(1, 1 - pan), gain * Math.min(1, 1 + pan)];

// every audible track summed from frame 0 to the end of the last one
export function mixdown(tracks) {
  const solo = tracks.some((t) => t.solo);
  const live = tracks.filter((t) => !t.mute && (!solo || t.solo));
  const len = live.reduce((m, t) => Math.max(m, t.start + t.l.length), 0);
  const l = new Float32Array(len), r = new Float32Array(len);
  for (const t of live) {
    const [gl, gr] = panGains(t.gain, t.pan);
    for (let i = 0; i < t.l.length; i++) { l[t.start + i] += t.l[i] * gl; r[t.start + i] += t.r[i] * gr; }
  }
  return { l, r };
}

// 16-bit stereo PCM WAV
export function wav(l, r, rate = RATE) {
  const n = l.length, bytes = 44 + n * 4;
  const v = new DataView(new ArrayBuffer(bytes));
  const s = (o, t) => { for (let i = 0; i < t.length; i++) v.setUint8(o + i, t.charCodeAt(i)); };
  s(0, "RIFF"); v.setUint32(4, bytes - 8, true); s(8, "WAVE");
  s(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 2, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 4, true); v.setUint16(32, 4, true); v.setUint16(34, 16, true);
  s(36, "data"); v.setUint32(40, n * 4, true);
  for (let i = 0, o = 44; i < n; i++, o += 4) {
    v.setInt16(o, Math.round(Math.max(-1, Math.min(1, l[i])) * 32767), true);
    v.setInt16(o + 2, Math.round(Math.max(-1, Math.min(1, r[i])) * 32767), true);
  }
  return new Uint8Array(v.buffer);
}

// join a take's chunks, dropping the first `skip` frames (the delay between hearing the tape
// and the synth's answer landing on it, when the take was played live)
export function joinTake(chunks, skip = 0) {
  const total = chunks.reduce((m, c) => m + c.l.length, 0);
  const n = Math.max(0, total - skip);
  const l = new Float32Array(n), r = new Float32Array(n);
  let at = -skip;
  for (const c of chunks) {
    const from = Math.max(0, -at), to = c.l.length;
    if (from < to) { l.set(c.l.subarray(from, to), at + from); r.set(c.r.subarray(from, to), at + from); }
    at += c.l.length;
  }
  return { l, r };
}

// bars.beats.ticks-free position text: "bar.beat" from frames
export function barBeat(frames, bpm, beats) {
  const beat = Math.floor(frames / (RATE * 60 / bpm));
  return `${Math.floor(beat / beats) + 1}.${(beat % beats) + 1}`;
}
export function clockText(frames) {
  const s = frames / RATE;
  return `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, "0")}`;
}

// ---------------------------------------------------------------- saving (IndexedDB)

function db() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("draenog-tape", 1);
    req.onupgradeneeded = () => req.result.createObjectStore("session");
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function idb(mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const tx = d.transaction("session", mode);
    const req = fn(tx.objectStore("session"));
    tx.oncomplete = () => resolve(req?.result);
    tx.onerror = () => reject(tx.error);
  });
}

// ---------------------------------------------------------------- the tape

export class TapeDeck {
  constructor({ firmwareName = () => "", status = () => {} } = {}) {
    this.tracks = [];          // { id, name, l, r, start, gain, pan, mute, solo }
    this.nextId = 1;
    this.bpm = 120; this.beats = 4;
    this.clickOn = false; this.countIn = true; this.sync = false; this.compMs = null;   // null: automatic
    this.pos = 0; this.playing = false; this.recording = false; this.counting = false;
    this.take = null;          // { id, chunks, start, skip }
    this.node = null; this.emu = null; this.ac = null;
    this.firmwareName = firmwareName;
    this.say = status;
    this.onchange = () => {};
    this.saveTimer = 0;
  }

  // ---- the audio graph: called each time the page builds its audio context
  async attach(ac, emu) {
    this.ac = ac; this.emu = emu;
    await ac.audioWorklet.addModule("tape-worklet.js");
    this.node = new AudioWorkletNode(ac, "tape", { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] });
    emu.connect(this.node).connect(ac.destination);
    this.node.port.onmessage = (e) => this.fromWorklet(e.data);
    this.post({ type: "click", click: { on: this.clickOn, bpm: this.bpm, beats: this.beats } });
    for (const t of this.tracks) this.sendTrack(t);
    this.post({ type: "seek", pos: this.pos });
    this.playing = this.recording = this.counting = false;
    this.take = null;
    this.onchange();
  }
  detach() { this.node?.disconnect(); this.node = null; }
  post(m, transfer) { this.node?.port.postMessage(m, transfer || []); }
  sendTrack(t) {
    // the worklet gets copies: the page keeps its own for drawing, mixing and saving
    const l = t.l.slice(), r = t.r.slice();
    this.post({ type: "add", id: t.id, l, r, start: t.start, gain: t.gain, pan: t.pan, mute: t.mute, solo: t.solo }, [l.buffer, r.buffer]);
  }

  // automatic: the time from a sound leaving the page to being heard, which is how late a part
  // played along to the tape lands on it
  autoCompMs() {
    if (!this.ac) return 0;
    return Math.round(1000 * ((this.ac.outputLatency || 0) + (this.ac.baseLatency || 0)));
  }
  compFrames() {
    if (this.sync) return 0;           // the firmware's own sequencer, clocked by the tape: on time
    return Math.round((this.compMs ?? this.autoCompMs()) / 1000 * RATE);
  }

  fromWorklet(m) {
    if (m.type === "pos") {
      this.pos = m.pos; this.playing = m.playing; this.recording = m.recording; this.counting = m.countIn;
      this.onchange("pos");
    } else if (m.type === "chunk") {
      if (this.take?.id === m.id) this.take.chunks.push({ l: m.l, r: m.r });
    } else if (m.type === "take-end") {
      if (this.take?.id !== m.id) return;
      const { l, r } = joinTake(this.take.chunks, this.take.skip);
      const take = this.take;
      this.take = null;
      if (l.length < RATE / 10) { this.say("Nothing recorded"); this.onchange(); return; }
      const t = { id: take.id, name: take.name, l, r, start: take.start, gain: 1, pan: 0, mute: false, solo: false };
      this.tracks.push(t);
      this.sendTrack(t);
      this.say(`Recorded ${clockText(l.length)} on “${t.name}”`);
      this.onchange();
      this.save();
    }
  }

  // ---- transport
  play() {
    if (!this.node) { this.say("Start a firmware first"); return; }
    this.post({ type: "play", from: this.pos });
    if (this.sync) this.emu.port.postMessage({ type: "clock", run: true, bpm: this.bpm });
  }
  stop() {
    this.post({ type: "stop" });
    if (this.sync) this.emu?.port.postMessage({ type: "clock", run: false });
  }
  toStart() { this.stop(); this.pos = 0; this.post({ type: "seek", pos: 0 }); this.onchange("pos"); }
  seek(frames) { this.pos = Math.max(0, frames); this.post({ type: "seek", pos: this.pos }); this.onchange("pos"); }
  record() {
    if (!this.node) { this.say("Start a firmware first"); return; }
    if (this.playing) this.stop();
    if (this.tracks.length >= MAX_TRACKS) { this.say(`At most ${MAX_TRACKS} tracks: delete one first`); return; }
    const id = this.nextId++;
    const start = this.pos;
    const bar = Math.round(RATE * 60 / this.bpm * this.beats);
    const counted = this.countIn && !this.sync;
    const from = counted ? start - bar : start;
    this.take = { id, start, chunks: [], skip: this.compFrames(), name: this.firmwareName() || `Track ${id}` };
    this.post({ type: "record", id, start, from });
    if (this.sync) this.emu.port.postMessage({ type: "clock", run: true, bpm: this.bpm });
    this.onchange();
  }

  setTempo(bpm) {
    this.bpm = Math.max(30, Math.min(300, Math.round(bpm) || 120));
    this.post({ type: "click", click: { bpm: this.bpm } });
    if (this.sync && this.playing) this.emu?.port.postMessage({ type: "clock", run: true, bpm: this.bpm });
    this.save();
  }
  setClick(on) { this.clickOn = on; this.post({ type: "click", click: { on } }); this.save(); }

  // ---- tracks
  update(t, props) {
    Object.assign(t, props);
    this.post({ type: "update", id: t.id, props });
    this.save();
  }
  remove(t) {
    this.tracks = this.tracks.filter((x) => x !== t);
    this.post({ type: "remove", id: t.id });
    this.onchange();
    this.save();
  }
  clearAll() {
    this.tracks = [];
    this.post({ type: "clear" });
    this.toStart();
    this.onchange();
    this.save();
  }
  length() { return this.tracks.reduce((m, t) => Math.max(m, t.start + t.l.length), 0); }

  // ---- files
  exportMix() { const { l, r } = mixdown(this.tracks); return wav(l, r); }
  exportTrack(t) {
    const l = new Float32Array(t.start + t.l.length), r = new Float32Array(l.length);
    l.set(t.l, t.start); r.set(t.r, t.start);
    return wav(l, r);
  }
  async importWav(file) {
    const ctx = new OfflineAudioContext(2, 1, RATE);
    const buf = await ctx.decodeAudioData(await file.arrayBuffer());
    // decodeAudioData resamples to the context's rate
    const l = buf.getChannelData(0).slice(), r = (buf.numberOfChannels > 1 ? buf.getChannelData(1) : buf.getChannelData(0)).slice();
    const t = { id: this.nextId++, name: file.name.replace(/\.[^.]+$/, ""), l, r, start: 0, gain: 1, pan: 0, mute: false, solo: false };
    this.tracks.push(t);
    this.sendTrack(t);
    this.onchange();
    this.save();
  }

  // ---- this browser's copy
  save() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.saveNow().catch((e) => this.say(`Could not save the tape: ${e.message || e}`)), 800);
  }
  async saveNow() {
    if (typeof indexedDB === "undefined") return;
    const session = {
      v: 1, bpm: this.bpm, beats: this.beats, clickOn: this.clickOn, countIn: this.countIn, sync: this.sync, compMs: this.compMs,
      nextId: this.nextId,
      tracks: this.tracks.map(({ id, name, l, r, start, gain, pan, mute, solo }) => ({ id, name, l, r, start, gain, pan, mute, solo })),
    };
    await idb("readwrite", (s) => s.put(session, "current"));
  }
  async load() {
    if (typeof indexedDB === "undefined") return;
    const s = await idb("readonly", (st) => st.get("current"));
    if (!s || s.v !== 1) return;
    Object.assign(this, { bpm: s.bpm, beats: s.beats, clickOn: s.clickOn, countIn: s.countIn, sync: s.sync, compMs: s.compMs, nextId: s.nextId });
    this.tracks = s.tracks;
    if (this.node) {
      this.post({ type: "clear" });
      for (const t of this.tracks) this.sendTrack(t);
      this.post({ type: "click", click: { on: this.clickOn, bpm: this.bpm, beats: this.beats } });
    }
    this.onchange();
  }
}
