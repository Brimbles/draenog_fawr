// node --test web/tape.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { mixdown, wav, joinTake, panGains, barBeat, clockText, RATE } from "./tape.js";

const track = (l, start = 0, props = {}) => ({ l: Float32Array.from(l), r: Float32Array.from(l), start, gain: 1, pan: 0, mute: false, solo: false, ...props });

test("pan: centre is unity both sides, hard left silences the right", () => {
  assert.deepEqual(panGains(1, 0), [1, 1]);
  assert.deepEqual(panGains(0.5, -1), [0.5, 0]);
  assert.deepEqual(panGains(1, 0.5), [0.5, 1]);
});

test("mixdown sums tracks at their starts", () => {
  const { l, r } = mixdown([track([0.5, 0.5], 0), track([0.25, 0.25], 1)]);
  assert.deepEqual([...l], [0.5, 0.75, 0.25]);
  assert.deepEqual([...r], [0.5, 0.75, 0.25]);
});

test("mixdown: mute drops a track, solo keeps only soloed ones", () => {
  assert.deepEqual([...mixdown([track([1]), track([0.5], 0, { mute: true })]).l], [1]);
  assert.deepEqual([...mixdown([track([1]), track([0.5], 0, { solo: true })]).l], [0.5]);
});

test("wav: header and clipped 16-bit samples", () => {
  const b = wav(Float32Array.from([0, 1, -2]), Float32Array.from([0.5, 0, 0]));
  const v = new DataView(b.buffer);
  assert.equal(String.fromCharCode(...b.slice(0, 4)), "RIFF");
  assert.equal(String.fromCharCode(...b.slice(8, 12)), "WAVE");
  assert.equal(v.getUint16(22, true), 2);
  assert.equal(v.getUint32(24, true), RATE);
  assert.equal(v.getUint32(40, true), 12);
  assert.equal(b.length, 44 + 12);
  assert.equal(v.getInt16(44 + 2, true), 16384);    // 0.5
  assert.equal(v.getInt16(48, true), 32767);        // 1
  assert.equal(v.getInt16(52, true), -32767);       // -2, clipped
});

test("joinTake joins chunks and drops the compensation frames across chunk edges", () => {
  const c = (a) => ({ l: Float32Array.from(a), r: Float32Array.from(a) });
  assert.deepEqual([...joinTake([c([1, 2]), c([3, 4, 5])]).l], [1, 2, 3, 4, 5]);
  assert.deepEqual([...joinTake([c([1, 2]), c([3, 4, 5])], 3).l], [4, 5]);
  assert.deepEqual([...joinTake([c([1, 2])], 5).l], []);
});

test("position text", () => {
  assert.equal(barBeat(0, 120, 4), "1.1");
  assert.equal(barBeat(RATE * 0.5 * 5, 120, 4), "2.2");    // the sixth beat
  assert.equal(clockText(RATE * 75.25), "1:15.3");
});

// ---- the worklet, in a stubbed AudioWorkletGlobalScope
function loadWorklet() {
  let Proc = null;
  const posted = [];
  class AudioWorkletProcessor { constructor() { this.port = { postMessage: (m) => posted.push(m), onmessage: null }; } }
  const ctx = { AudioWorkletProcessor, sampleRate: RATE, registerProcessor: (_n, c) => { Proc = c; }, Float32Array, Math };
  vm.runInNewContext(readFileSync(new URL("./tape-worklet.js", import.meta.url), "utf8"), ctx);
  const p = new Proc();
  const send = (m) => p.port.onmessage({ data: m });
  const run = (inL, inR = inL) => {
    const out = [[new Float32Array(inL.length), new Float32Array(inL.length)]];
    p.process([[Float32Array.from(inL), Float32Array.from(inR)]], out);
    return out[0];
  };
  return { p, send, run, posted };
}

test("worklet: passes the synth through when stopped", () => {
  const { run } = loadWorklet();
  const [l, r] = run([0.1, 0.2], [0.3, 0.4]);
  assert.deepEqual([...l].map((x) => +x.toFixed(3)), [0.1, 0.2]);
  assert.deepEqual([...r].map((x) => +x.toFixed(3)), [0.3, 0.4]);
});

test("worklet: plays a track from its start under the live sound", () => {
  const { send, run } = loadWorklet();
  send({ type: "add", id: 1, l: Float32Array.from([1, 1]), r: Float32Array.from([1, 1]), start: 2, gain: 0.5, pan: 0, mute: false, solo: false });
  send({ type: "play", from: 0 });
  const [l] = run([0, 0, 0, 0]);
  assert.deepEqual([...l], [0, 0, 0.5, 0.5]);
  send({ type: "update", id: 1, props: { mute: true } });
  send({ type: "seek", pos: 0 });
  assert.deepEqual([...run([0, 0, 0, 0])[0]], [0, 0, 0, 0]);
});

test("worklet: a take records the input from its start, after the count-in", () => {
  const { send, run, posted } = loadWorklet();
  send({ type: "click", click: { on: false, bpm: 120, beats: 4 } });
  send({ type: "record", id: 7, start: 4, from: 2 });   // two frames of count-in
  run([9, 9, 1, 2]);                                     // frames 2..5: 4 and 5 are recorded
  run([3, 4]);                                           // frames 6..7
  send({ type: "stop" });
  const chunks = posted.filter((m) => m.type === "chunk" && m.id === 7);
  const got = chunks.flatMap((c) => [...c.l]);
  assert.deepEqual(got, [1, 2, 3, 4]);
  assert.ok(posted.some((m) => m.type === "take-end" && m.id === 7));
});

test("worklet: the count-in clicks even with the click off", () => {
  const { send, run } = loadWorklet();
  send({ type: "click", click: { on: false, bpm: 120, beats: 4 } });
  const bar = RATE * 2;
  send({ type: "record", id: 1, start: bar, from: 0 });
  const [l] = run(new Array(128).fill(0));
  assert.ok(l.some((x) => Math.abs(x) > 0.01), "a click at the count-in's first beat");
});
