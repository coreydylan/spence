import type { Card, StepContent } from "../types";
import { store } from "../store";

export function renderStep(card: Card<StepContent>): HTMLElement {
  const el = document.createElement("div");
  el.className = "card card-step";
  el.addEventListener("click", () => store.setFocus(card.id));

  const c = card.content;

  // Step number
  const num = document.createElement("span");
  num.className = "step-num";
  num.textContent = String(c.index + 1);

  // Prose
  const prose = document.createElement("div");
  prose.className = "step-prose";
  prose.contentEditable = "true";
  prose.textContent = c.text || "";
  prose.dataset.placeholder = "Describe this step...";
  prose.addEventListener("blur", () => {
    const text = prose.textContent?.trim() || "";
    if (text !== c.text) {
      store.updateCard(card.id, { ...c, text });
    }
  });

  // Meta row (time, temp, cues)
  const meta = document.createElement("div");
  meta.className = "step-meta";

  if (c.temp_f) {
    const temp = document.createElement("span");
    temp.className = "step-tag";
    temp.textContent = `${c.temp_f}\u00b0F`;
    meta.appendChild(temp);
  }

  if (c.time_min) {
    const time = document.createElement("span");
    time.className = "step-tag";
    time.textContent = c.time_min.max
      ? `${c.time_min.min}-${c.time_min.max} min`
      : `${c.time_min.min} min`;
    meta.appendChild(time);
  }

  if (c.heat_level) {
    const heat = document.createElement("span");
    heat.className = "step-tag";
    heat.textContent = c.heat_level;
    meta.appendChild(heat);
  }

  if (c.sensory_cues) {
    for (const cue of c.sensory_cues) {
      const cueEl = document.createElement("span");
      cueEl.className = "step-cue";
      cueEl.textContent = cue;
      meta.appendChild(cueEl);
    }
  }

  // Ingredient refs
  if (c.ingredient_refs && c.ingredient_refs.length > 0) {
    const refs = document.createElement("div");
    refs.className = "step-ingredients";
    refs.textContent = c.ingredient_refs.join(", ");
    meta.appendChild(refs);
  }

  // Delete
  const del = document.createElement("button");
  del.className = "card-delete";
  del.textContent = "\u00d7";
  del.addEventListener("click", (e) => {
    e.stopPropagation();
    store.deleteCard(card.id);
  });

  el.appendChild(num);
  el.appendChild(prose);
  if (meta.children.length > 0) el.appendChild(meta);
  el.appendChild(del);

  return el;
}
