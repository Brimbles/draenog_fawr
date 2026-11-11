// Arturia MiniLab mkII (or any MIDI controller) as the FM-1's own front panel.
//
// The emulator's plain MIDI in sends everything into the firmware's MIDI IN jack, so what a knob
// does depends on whether (and how) each firmware handles controllers. This layer instead turns
// the FM-1's physical encoders, MASTER pot and buttons, which every firmware reads, so the same
// controller works with all of them. Messages not mapped here still go to the MIDI IN jack:
// the keys, pitch bend, the mod strip, sustain and any knob left unmapped.
//
// No page dependencies: main.js hands in the actions (turn an encoder, set the pot, press a
// button, forward to MIDI IN) and feeds it every incoming message.

// FM-1 panel encoders, by the page's index (crates/fm1-live/src/panel.rs ENCS)
export const ENCODERS = ["SELECT", "PRESETS", "ALGORITHM", "K1", "K2", "K3", "K4"];
// FM-1 buttons, by matrix id (panel.rs buttons())
export const BUTTONS = ["OCT-", "OCT+", "FX", "SCL", "ENV", "LFO", "EDIT", "GLO",
  "HOME", "SAVE", "ARP", "SEQ", "PLAY", "REC"];

// What a control can drive. `id` is stable: it keys the saved map.
export const TARGETS = [
  ...ENCODERS.map((name, i) => ({ id: `enc:${i}`, kind: "enc", enc: i, label: `${name} knob` })),
  { id: "pot", kind: "pot", label: "MASTER volume" },
  ...BUTTONS.map((name, i) => ({ id: `btn:${i}`, kind: "btn", btn: i, label: `${name} button` })),
  { id: "step:0:-1", kind: "step", enc: 0, dir: -1, label: "SELECT ◀ (one click)" },
  { id: "step:0:1", kind: "step", enc: 0, dir: 1, label: "SELECT ▶ (one click)" },
  { id: "panic", kind: "panic", label: "All notes off" },
];
const TARGET = Object.fromEntries(TARGETS.map((t) => [t.id, t]));

// How a knob's value is read: absolute 0..127 (the change from the last value turns the
// encoder) or one of Arturia's relative modes (MIDI Control Center: "Relative #1..#3").
export const KNOB_MODES = ["abs", "rel64", "rel0", "rel16"];

// A source: "cc:<channel 1-16>:<number>" or "note:<channel>:<number>".
export const ccSrc = (ch, n) => `cc:${ch}:${n}`;
export const noteSrc = (ch, n) => `note:${ch}:${n}`;

// The MiniLab mkII's factory settings (memory 1, "Analog Lab"): knobs 1 and 9 are endless and
// relative with a push switch, the others absolute; pads 1-8 notes 36-43 on channel 10, pads
// 9-16 controllers 22-29 on channel 1. Laid out like the FM-1: knob 1 (top left) SELECT, knob 9
// below it PRESETS; the top row K1-K4, ALGORITHM and MASTER; pads 1-8 the upper button row with
// the octave buttons, pads 9-16 the lower row and SELECT stepping.
export function factoryMap() {
  const m = {};
  const set = (src, target, mode) => { m[src] = mode ? { target, mode } : { target }; };
  set(ccSrc(1, 112), "enc:0", "rel64");         // knob 1: SELECT
  set(ccSrc(1, 113), "btn:6");                  // knob 1 pushed: EDIT
  set(ccSrc(1, 114), "enc:1", "rel64");         // knob 9: PRESETS
  set(ccSrc(1, 115), "btn:8");                  // knob 9 pushed: HOME
  set(ccSrc(1, 74), "enc:3", "abs");            // knobs 2-5: K1-K4
  set(ccSrc(1, 71), "enc:4", "abs");
  set(ccSrc(1, 76), "enc:5", "abs");
  set(ccSrc(1, 77), "enc:6", "abs");
  set(ccSrc(1, 93), "enc:2", "abs");            // knob 6: ALGORITHM
  set(ccSrc(1, 73), "pot", "abs");              // knob 7: MASTER
  // knob 8 (CC 75) and knobs 10-16 (18 19 16 17 91 79 72) stay unmapped: they reach MIDI IN
  // for the firmwares that read controllers
  ["btn:2", "btn:3", "btn:4", "btn:5", "btn:6", "btn:7", "btn:0", "btn:1"]
    .forEach((t, i) => set(noteSrc(10, 36 + i), t));                 // pads 1-8
  ["btn:8", "btn:9", "btn:10", "btn:11", "btn:12", "btn:13", "step:0:-1", "step:0:1"]
    .forEach((t, i) => set(ccSrc(1, 22 + i), t));                   // pads 9-16
  return m;
}

// a relative value as signed clicks
export function relClicks(v, mode) {
  if (mode === "rel64") return v - 64;
  if (mode === "rel16") return v - 16;
  if (mode === "rel0") return v < 64 ? v : v - 128;
  return 0;
}

export function srcLabel(src) {
  const [kind, ch, n] = src.split(":");
  return kind === "cc" ? `CC ${n} · ch ${ch}` : `note ${n} · ch ${ch}`;
}

// A pad or switch may send gate messages (on when pressed, off when let go) or toggles (on at
// one press, off at the next). A switch is taken as gate until an "on" stays without its "off"
// for TOGGLE_GUESS ms: then it is a toggle, and each of its messages is one short press. An off
// arriving in time marks it as gate for good (holds then last as long as the pad is held), and a
// "toggle" whose off follows its on quickly was a gate held long the first time: it turns back.
const TOGGLE_GUESS = 400, TAP = 90;

export class MiniLab {
  // actions: { turn(enc, clicks), setPot(0..1023), getPot(), setKey(id, down), forward(bytes) }
  constructor(actions, { map = factoryMap(), timers = globalThis } = {}) {
    this.a = actions;
    this.map = map;
    this.timers = timers;
    this.enabled = true;
    this.last = new Map();      // absolute knob source -> last value
    this.held = new Map();      // switch source -> the target it holds
    this.toggles = new Set();   // switch sources found to send toggles
    this.gates = new Set();     // switch sources found to send gates (on, then off on release)
    this.lastOn = new Map();    // toggle source -> when its last "on" came
    this.guess = new Map();     // switch source -> pending toggle-guess timer
    this.learning = null;       // { target, done(src) }
  }

  setMap(map) { this.releaseAll(); this.map = map; this.last.clear(); this.toggles.clear(); this.gates.clear(); }

  // the source mapped to a target (for the map's view)
  sourceOf(targetId) {
    for (const [src, m] of Object.entries(this.map)) if (m.target === targetId) return src;
    return null;
  }

  // the next control moved (a controller, or a note pressed) is assigned to `targetId`
  learn(targetId, done) { this.learning = { target: targetId, done }; }
  cancelLearn() { this.learning = null; }
  assign(src, targetId, mode) {
    for (const [s, m] of Object.entries(this.map)) if (m.target === targetId || s === src) delete this.map[s];
    const t = TARGET[targetId];
    if (!t) return;
    this.map[src] = (t.kind === "enc" || t.kind === "pot") ? { target: targetId, mode: mode || "abs" } : { target: targetId };
    this.last.delete(src);
    this.toggles.delete(src);
    this.gates.delete(src);
  }
  unassign(targetId) {
    for (const [s, m] of Object.entries(this.map)) if (m.target === targetId) delete this.map[s];
  }

  releaseAll() {
    for (const t of this.guess.values()) this.timers.clearTimeout(t);
    this.guess.clear();
    for (const target of this.held.values()) this.press(target, false);
    this.held.clear();
  }

  // One incoming MIDI message (bytes with any channel rewriting not yet applied). Returns true
  // when it was used here, false when the caller should send it on to MIDI IN.
  handle(bytes) {
    const st = bytes[0] & 0xf0, ch = (bytes[0] & 0x0f) + 1;
    let src = null, value = 0, on = false;
    if (st === 0xb0) { src = ccSrc(ch, bytes[1]); value = bytes[2]; on = value > 0; }
    else if (st === 0x90 || st === 0x80) { src = noteSrc(ch, bytes[1]); on = st === 0x90 && bytes[2] > 0; value = on ? 127 : 0; }
    else return false;

    if (this.learning) {
      // learn from a controller moving or a note pressed (not from its release)
      if (st === 0xb0 || on) {
        const { target, done } = this.learning;
        this.learning = null;
        const t = TARGET[target];
        // a knob that sits around 64 or near 0/127 when nudged is most likely relative
        const mode = (t && (t.kind === "enc" || t.kind === "pot") && st === 0xb0 && (value === 63 || value === 65)) ? "rel64" : "abs";
        this.assign(src, target, mode);
        done?.(src);
        return true;
      }
      return true;                               // (the learned note's release)
    }
    if (!this.enabled) return false;
    const m = this.map[src];
    if (!m) return false;
    const t = TARGET[m.target];
    if (!t) return false;

    if (t.kind === "enc" || t.kind === "pot") {
      if (st !== 0xb0) return true;              // a note mapped to a knob: nothing to turn
      let clicks;
      if (m.mode === "abs") {
        const prev = this.last.get(src);
        this.last.set(src, value);
        if (t.kind === "pot") { this.a.setPot(Math.round(value / 127 * 1023)); return true; }
        clicks = prev === undefined ? 0 : value - prev;
      } else {
        clicks = relClicks(value, m.mode);
      }
      if (!clicks) return true;
      if (t.kind === "pot") this.a.setPot(this.a.getPot() + clicks * 8);
      else this.a.turn(t.enc, clicks);
      return true;
    }
    this.switchMsg(src, m.target, on);
    return true;
  }

  switchMsg(src, target, on) {
    const now = this.timers.now ? this.timers.now() : Date.now();
    if (this.toggles.has(src)) {
      // an off soon after an on: this was a gate switch after all (first held long)
      const onAt = this.lastOn.get(src);
      if (!on && onAt !== undefined && now - onAt < TOGGLE_GUESS) {
        this.toggles.delete(src);
        this.gates.add(src);
        return;
      }
      if (on) this.lastOn.set(src, now); else this.lastOn.delete(src);
      this.tap(target);
      return;
    }
    if (on) {
      if (this.held.has(src)) this.press(this.held.get(src), false);
      this.held.set(src, target);
      this.press(target, true);
      if (this.gates.has(src)) return;
      // gate until shown otherwise: an "on" without its "off" for a while is a toggle
      this.timers.clearTimeout(this.guess.get(src));
      this.guess.set(src, this.timers.setTimeout(() => {
        this.guess.delete(src);
        if (!this.held.has(src)) return;
        this.toggles.add(src);
        this.press(this.held.get(src), false);
        this.held.delete(src);
      }, TOGGLE_GUESS));
    } else {
      if (this.guess.has(src)) this.gates.add(src);      // its off came in time: a gate switch
      this.timers.clearTimeout(this.guess.get(src));
      this.guess.delete(src);
      if (this.held.has(src)) { this.press(this.held.get(src), false); this.held.delete(src); }
    }
  }

  tap(target) {
    this.press(target, true);
    this.timers.setTimeout(() => this.press(target, false), TAP);
  }

  press(targetId, down) {
    const t = TARGET[targetId];
    if (!t) return;
    if (t.kind === "btn") this.a.setKey(t.btn, down);
    else if (t.kind === "step" && down) this.a.turn(t.enc, t.dir);
    else if (t.kind === "panic" && down) {
      for (let c = 0; c < 16; c++) {
        this.a.forward([0xb0 | c, 123, 0]);
        this.a.forward([0xb0 | c, 120, 0]);
      }
    }
  }
}
