// The tape's controls on the page (web/tape.js is the recorder itself).
import { TapeDeck, RATE, barBeat, clockText } from "./tape.js";

const $ = (id) => document.getElementById(id);

function download(bytes, name) {
  const url = URL.createObjectURL(new Blob([bytes], { type: "audio/wav" }));
  const a = document.createElement("a");
  a.href = url; a.download = name;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
const fileName = (s) => (s || "track").replace(/[^a-z0-9_-]+/gi, "_").replace(/^_+|_+$/g, "") || "track";

// the peaks of a track, one min/max pair per column (cached per track and width)
const peakCache = new WeakMap();
function peaks(t, cols, span) {
  const key = `${cols}:${span}`;
  const c = peakCache.get(t);
  if (c?.key === key) return c.p;
  const p = new Float32Array(cols * 2);
  const per = span / cols;
  for (let x = 0; x < cols; x++) {
    const a = Math.floor(x * per) - t.start, b = Math.floor((x + 1) * per) - t.start;
    let lo = 0, hi = 0;
    for (let i = Math.max(0, a); i < Math.min(t.l.length, b); i += 4) {
      const v = (t.l[i] + t.r[i]) * 0.5;
      if (v < lo) lo = v; if (v > hi) hi = v;
    }
    p[2 * x] = lo; p[2 * x + 1] = hi;
  }
  peakCache.set(t, { key, p });
  return p;
}

export function setupTape({ firmwareName }) {
  const statusEl = $("tape-status");
  const deck = new TapeDeck({ firmwareName, status: (s) => { statusEl.textContent = s; } });
  const list = $("t-tracks"), posEl = $("t-pos");
  const playBtn = $("t-play"), recBtn = $("t-rec");
  const bpm = $("t-bpm"), click = $("t-click"), count = $("t-count"), sync = $("t-sync"), comp = $("t-comp");

  // the shared timeline: all tracks to one scale, a little room after the longest
  const span = () => Math.max(deck.length(), deck.pos, 30 * RATE) * 1.05;

  function controls() {
    bpm.value = deck.bpm;
    click.checked = deck.clickOn;
    count.checked = deck.countIn;
    sync.checked = deck.sync;
    comp.value = deck.compMs ?? "";
    comp.placeholder = `auto (${deck.autoCompMs()} ms)`;
  }

  function drawTrack(canvas, t) {
    const w = canvas.clientWidth || 600, h = canvas.clientHeight || 48, dpr = devicePixelRatio || 1;
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    const g = canvas.getContext("2d");
    g.scale(dpr, dpr);
    const cols = Math.max(1, Math.floor(w));
    const p = peaks(t, cols, span());
    g.fillStyle = t.mute ? "#5a5852" : "#f2a33a";
    for (let x = 0; x < cols; x++) {
      const lo = p[2 * x], hi = p[2 * x + 1];
      if (hi - lo < 0.002) continue;
      const y0 = h / 2 - hi * h / 2, y1 = h / 2 - lo * h / 2;
      g.fillRect(x, y0, 1, Math.max(1, y1 - y0));
    }
  }

  function render() {
    list.replaceChildren();
    if (!deck.tracks.length) {
      const p = document.createElement("p");
      p.className = "dim empty";
      p.textContent = "No tracks yet. Press ● Rec and play: the take records what the synth plays. Then pick another firmware and record over it.";
      list.append(p);
    }
    for (const t of deck.tracks) {
      const row = document.createElement("div");
      row.className = "track";
      const name = document.createElement("input");
      name.value = t.name; name.className = "tname"; name.setAttribute("aria-label", "Track name");
      name.addEventListener("change", () => deck.update(t, { name: name.value }));
      const toggle = (label, prop, title) => {
        const b = document.createElement("button");
        b.type = "button"; b.textContent = label; b.title = title;
        b.className = "tog"; b.setAttribute("aria-pressed", String(t[prop]));
        b.addEventListener("click", () => { deck.update(t, { [prop]: !t[prop] }); render(); });
        return b;
      };
      const slider = (label, prop, min, max, step) => {
        const l = document.createElement("label");
        l.className = "tslider";
        const s = document.createElement("input");
        Object.assign(s, { type: "range", min, max, step, value: t[prop] });
        s.setAttribute("aria-label", `${label}: ${t.name}`);
        s.addEventListener("input", () => deck.update(t, { [prop]: Number(s.value) }));
        s.addEventListener("dblclick", () => { s.value = prop === "pan" ? 0 : 1; deck.update(t, { [prop]: Number(s.value) }); });
        l.append(label, s);
        return l;
      };
      const wave = document.createElement("div");
      wave.className = "wave";
      const canvas = document.createElement("canvas");
      const head = document.createElement("div");
      head.className = "head";
      wave.append(canvas, head);
      wave.addEventListener("pointerdown", (e) => {
        const r = wave.getBoundingClientRect();
        deck.seek(Math.round((e.clientX - r.left) / r.width * span()));
      });
      const acts = document.createElement("div");
      acts.className = "tacts";
      const exp = document.createElement("button");
      exp.type = "button"; exp.textContent = "⤓"; exp.title = "Export this track (.wav)";
      exp.setAttribute("aria-label", `Export ${t.name}`);
      exp.addEventListener("click", () => download(deck.exportTrack(t), `${fileName(t.name)}.wav`));
      const del = document.createElement("button");
      del.type = "button"; del.textContent = "✕"; del.title = "Delete this track";
      del.setAttribute("aria-label", `Delete ${t.name}`);
      del.addEventListener("click", () => { if (confirm(`Delete “${t.name}”?`)) deck.remove(t); });
      acts.append(exp, del);
      const strip = document.createElement("div");
      strip.className = "tstrip";
      strip.append(name, toggle("M", "mute", "Mute"), toggle("S", "solo", "Solo"),
        slider("Vol", "gain", 0, 1.5, 0.01), slider("Pan", "pan", -1, 1, 0.01), acts);
      row.append(strip, wave);
      list.append(row);
      requestAnimationFrame(() => drawTrack(canvas, t));
    }
    playhead();
    transport();
  }

  function playhead() {
    const f = deck.pos / span();
    for (const h of list.querySelectorAll(".head")) h.style.left = `${Math.min(100, f * 100)}%`;
    posEl.textContent = `${barBeat(deck.pos, deck.bpm, deck.beats)} · ${clockText(deck.pos)}`;
  }
  function transport() {
    playBtn.setAttribute("aria-pressed", String(deck.playing && !deck.recording && !deck.counting));
    recBtn.setAttribute("aria-pressed", String(deck.recording || deck.counting));
    recBtn.textContent = deck.counting ? "● Count-in…" : deck.recording ? "● Recording" : "● Rec";
  }

  let lastSpan = 0;
  deck.onchange = (what) => {
    if (what === "pos") {
      // the timeline grows while recording past its end: redraw then
      const s = span();
      if (Math.abs(s - lastSpan) > RATE * 5) { lastSpan = s; render(); return; }
      playhead(); transport();
      return;
    }
    lastSpan = span();
    controls();
    render();
  };

  $("t-start").addEventListener("click", () => deck.toStart());
  playBtn.addEventListener("click", () => (deck.playing ? deck.stop() : deck.play()));
  $("t-stop").addEventListener("click", () => deck.stop());
  recBtn.addEventListener("click", () => (deck.recording || deck.counting ? deck.stop() : deck.record()));
  bpm.addEventListener("change", () => { deck.setTempo(Number(bpm.value)); bpm.value = deck.bpm; render(); });
  click.addEventListener("change", () => deck.setClick(click.checked));
  count.addEventListener("change", () => { deck.countIn = count.checked; deck.save(); });
  sync.addEventListener("change", () => { deck.sync = sync.checked; deck.save(); });
  comp.addEventListener("change", () => {
    deck.compMs = comp.value === "" ? null : Math.max(0, Math.min(500, Number(comp.value) || 0));
    deck.save();
  });
  $("t-mix").addEventListener("click", () => {
    if (!deck.tracks.length) { statusEl.textContent = "Nothing to export yet"; return; }
    download(deck.exportMix(), "draenog-fawr-mix.wav");
  });
  $("t-import").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file) return;
    try { await deck.importWav(file); } catch (err) { statusEl.textContent = `Could not read ${file.name}: ${err.message || err}`; }
  });
  $("t-clear").addEventListener("click", () => { if (confirm("Delete every track on the tape?")) deck.clearAll(); });
  addEventListener("resize", () => render());

  controls();
  render();
  deck.load().catch(() => {});
  return deck;
}
