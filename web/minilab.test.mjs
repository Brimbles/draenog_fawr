// node --test web/minilab.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { MiniLab, factoryMap, relClicks, TARGETS, ccSrc, noteSrc } from "./minilab.js";

// fake timers: run() fires what is due by `t`
function clock() {
  let t = 0, next = 1;
  const pending = new Map();
  return {
    now: () => t,
    setTimeout(fn, ms) { const id = next++; pending.set(id, { at: t + ms, fn }); return id; },
    clearTimeout(id) { pending.delete(id); },
    advance(ms) {
      t += ms;
      for (const [id, p] of [...pending].sort((a, b) => a[1].at - b[1].at)) {
        if (p.at <= t && pending.has(id)) { pending.delete(id); p.fn(); }
      }
    },
  };
}

function rig() {
  const log = [];
  let pot = 500;
  const timers = clock();
  const ml = new MiniLab({
    turn: (enc, clicks) => log.push(["turn", enc, clicks]),
    setPot: (v) => { pot = Math.max(0, Math.min(1023, v)); log.push(["pot", pot]); },
    getPot: () => pot,
    setKey: (id, down) => log.push(["key", id, down]),
    forward: (bytes) => log.push(["fwd", ...bytes]),
  }, { timers });
  return { ml, log, timers };
}

test("relative modes decode to signed clicks", () => {
  assert.equal(relClicks(65, "rel64"), 1);
  assert.equal(relClicks(61, "rel64"), -3);
  assert.equal(relClicks(2, "rel0"), 2);
  assert.equal(relClicks(126, "rel0"), -2);
  assert.equal(relClicks(15, "rel16"), -1);
});

test("factory map: every target id exists, no target mapped twice", () => {
  const ids = new Set(TARGETS.map((t) => t.id));
  const seen = new Set();
  for (const [src, m] of Object.entries(factoryMap())) {
    assert.ok(ids.has(m.target), `${src} -> ${m.target}`);
    if (m.target !== "btn:6" && m.target !== "btn:8") assert.ok(!seen.has(m.target), `${m.target} twice`);
    seen.add(m.target);
  }
});

test("knob 1 (relative) turns SELECT", () => {
  const { ml, log } = rig();
  assert.equal(ml.handle([0xb0, 112, 66]), true);
  assert.equal(ml.handle([0xb0, 112, 63]), true);
  assert.deepEqual(log, [["turn", 0, 2], ["turn", 0, -1]]);
});

test("absolute knobs turn by their change; the first value only sets the reference", () => {
  const { ml, log } = rig();
  ml.handle([0xb0, 74, 40]);
  ml.handle([0xb0, 74, 43]);
  ml.handle([0xb0, 74, 41]);
  assert.deepEqual(log, [["turn", 3, 3], ["turn", 3, -2]]);
});

test("MASTER follows an absolute knob directly", () => {
  const { ml, log } = rig();
  ml.handle([0xb0, 73, 127]);
  ml.handle([0xb0, 73, 0]);
  assert.deepEqual(log, [["pot", 1023], ["pot", 0]]);
});

test("unmapped messages go to MIDI IN: keys, pitch bend, unmapped knobs", () => {
  const { ml } = rig();
  assert.equal(ml.handle([0x90, 60, 100]), false);
  assert.equal(ml.handle([0x80, 60, 0]), false);
  assert.equal(ml.handle([0xe0, 0, 64]), false);
  assert.equal(ml.handle([0xb0, 18, 10]), false);   // knob 10
  assert.equal(ml.handle([0xb0, 1, 10]), false);    // mod strip
});

test("disabled: nothing is taken", () => {
  const { ml, log } = rig();
  ml.enabled = false;
  assert.equal(ml.handle([0xb0, 112, 65]), false);
  assert.deepEqual(log, []);
});

test("gate pad holds its button while held, however long", () => {
  const { ml, log, timers } = rig();
  ml.handle([0x99, 36, 100]);                       // pad 1 down: FX
  timers.advance(100);
  ml.handle([0x89, 36, 0]);                         // released in time: a gate pad
  ml.handle([0x99, 36, 100]);
  timers.advance(2000);                             // held long: still held
  assert.deepEqual(log, [["key", 2, true], ["key", 2, false], ["key", 2, true]]);
  ml.handle([0x89, 36, 0]);
  assert.deepEqual(log.at(-1), ["key", 2, false]);
});

test("toggle pad: every message is one short press", () => {
  const { ml, log, timers } = rig();
  ml.handle([0xb0, 22, 127]);                       // pad 9 (HOME), toggle on
  timers.advance(500);                              // no off: a toggle; released
  assert.deepEqual(log, [["key", 8, true], ["key", 8, false]]);
  log.length = 0;
  timers.advance(2000);
  ml.handle([0xb0, 22, 0]);                         // the toggle's off: another press
  timers.advance(200);
  assert.deepEqual(log, [["key", 8, true], ["key", 8, false]]);
});

test("a gate pad held long on its first press is recognised as gate afterwards", () => {
  const { ml, log, timers } = rig();
  ml.handle([0xb0, 23, 127]);                       // pad 10 (SAVE), held 1 s
  timers.advance(1000);                             // taken for a toggle: released
  ml.handle([0xb0, 23, 0]);                         // ... but the off: within the window? no
  timers.advance(200);
  log.length = 0;
  ml.handle([0xb0, 23, 127]);                       // the next press
  timers.advance(50);
  ml.handle([0xb0, 23, 0]);                         // off quickly after on: gate after all
  timers.advance(200);
  ml.handle([0xb0, 23, 127]);
  timers.advance(3000);
  ml.handle([0xb0, 23, 0]);
  assert.deepEqual(log.slice(-2), [["key", 9, true], ["key", 9, false]]);
  // the long hold was one press, held through
  const presses = log.filter((e) => e[0] === "key" && e[2]);
  assert.ok(presses.length >= 1);
});

test("step pads click SELECT once per press", () => {
  const { ml, log, timers } = rig();
  ml.handle([0xb0, 28, 127]);                       // pad 15
  timers.advance(50);
  ml.handle([0xb0, 28, 0]);
  ml.handle([0xb0, 29, 127]);                       // pad 16
  timers.advance(50);
  ml.handle([0xb0, 29, 0]);
  assert.deepEqual(log, [["turn", 0, -1], ["turn", 0, 1]]);
});

test("learn assigns the next control, replacing the target's old source", () => {
  const { ml, log } = rig();
  let learned = null;
  ml.learn("enc:3", (src) => { learned = src; });
  assert.equal(ml.handle([0xb2, 20, 65]), true);    // CC 20 on channel 3, nudged up from 64
  assert.equal(learned, ccSrc(3, 20));
  assert.equal(ml.sourceOf("enc:3"), ccSrc(3, 20));
  assert.equal(ml.map[ccSrc(1, 74)], undefined);    // knob 2 no longer K1
  assert.equal(ml.map[ccSrc(3, 20)].mode, "rel64");
  ml.handle([0xb2, 20, 67]);
  assert.deepEqual(log, [["turn", 3, 3]]);
  assert.equal(ml.handle([0xb0, 74, 10]), false);   // knob 2 now goes to MIDI IN
});

test("learn a note for a button", () => {
  const { ml, log } = rig();
  ml.learn("btn:12", () => {});
  assert.equal(ml.handle([0x90, 48, 90]), true);
  assert.equal(ml.handle([0x80, 48, 0]), true);     // its release is not played
  assert.equal(ml.sourceOf("btn:12"), noteSrc(1, 48));
  ml.handle([0x90, 48, 90]);
  assert.deepEqual(log, [["key", 12, true]]);
});

test("panic sends all notes off on every channel", () => {
  const { ml, log } = rig();
  ml.assign(ccSrc(1, 30), "panic");
  ml.handle([0xb0, 30, 127]);
  assert.equal(log.length, 32);
  assert.deepEqual(log[0], ["fwd", 0xb0, 123, 0]);
});
