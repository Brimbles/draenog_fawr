// The page's side of web/minilab.js: the on/off switch and the controller map with Learn, saved
// in this browser.
import { MiniLab, TARGETS, KNOB_MODES, factoryMap, srcLabel } from "./minilab.js";

const MODE_NAMES = { abs: "absolute", rel64: "relative #1", rel0: "relative #2", rel16: "relative #3" };

export function setupMiniLab(actions, { stored, store }) {
  let map;
  try { map = JSON.parse(stored("draenog.minilab.map") || "null"); } catch { map = null; }
  const ml = new MiniLab(actions, { map: map && typeof map === "object" ? map : factoryMap() });
  const on = document.getElementById("ml-on");
  const body = document.querySelector("#ml-table tbody");
  const reset = document.getElementById("ml-reset");
  if (!on || !body) return ml;                       // (a page without the controls: the SMK-37's)

  ml.enabled = stored("draenog.minilab") !== "0";
  on.checked = ml.enabled;
  on.addEventListener("change", () => {
    ml.enabled = on.checked;
    if (!on.checked) ml.releaseAll();
    store("draenog.minilab", on.checked ? "1" : "0");
  });
  const save = () => store("draenog.minilab.map", JSON.stringify(ml.map));

  function render() {
    body.replaceChildren();
    for (const t of TARGETS) {
      const srcs = ml.sourcesOf(t.id), src = srcs[0] ?? null;
      const tr = document.createElement("tr");
      const name = document.createElement("th");
      name.scope = "row";
      name.textContent = t.label;
      const from = document.createElement("td");
      from.className = "dim";
      from.replaceChildren(...(srcs.length ? srcs.map((x) => { const d = document.createElement("div"); d.textContent = srcLabel(x); return d; }) : ["—"]));
      const acts = document.createElement("td");
      acts.className = "acts";
      if (src && (t.kind === "enc" || t.kind === "pot")) {
        const mode = document.createElement("select");
        mode.setAttribute("aria-label", `How ${t.label} reads its knob`);
        for (const k of KNOB_MODES) mode.add(new Option(MODE_NAMES[k], k));
        mode.value = ml.map[src].mode || "abs";
        mode.addEventListener("change", () => { ml.assign(src, t.id, mode.value); save(); });
        acts.append(mode);
      }
      const learn = document.createElement("button");
      learn.type = "button";
      learn.textContent = "Learn";
      learn.addEventListener("click", () => {
        if (ml.learning?.target === t.id) { ml.cancelLearn(); render(); return; }
        ml.learn(t.id, () => { save(); render(); });
        for (const b of body.querySelectorAll("button.learning")) { b.classList.remove("learning"); b.textContent = "Learn"; }
        learn.classList.add("learning");
        learn.textContent = "Move a control…";
      });
      acts.append(learn);
      if (src) {
        const clear = document.createElement("button");
        clear.type = "button";
        clear.textContent = "✕";
        clear.setAttribute("aria-label", `Unmap ${t.label}`);
        clear.addEventListener("click", () => { ml.unassign(t.id); save(); render(); });
        acts.append(clear);
      }
      tr.append(name, from, acts);
      body.append(tr);
    }
  }
  reset.addEventListener("click", () => { ml.setMap(factoryMap()); save(); render(); });
  render();
  return ml;
}
