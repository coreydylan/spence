import type {
  Card, TagChipsContent, TimeContent, YieldContent,
  EquipmentContent, VariationChipsContent,
} from "../types";
import { store } from "../store";

export function renderTagChips(card: Card<TagChipsContent>): HTMLElement {
  const el = document.createElement("div");
  el.className = "card card-tags";
  el.addEventListener("click", () => {
    store.setFocus(card.id);
    if (card.lock === "inferred") store.confirmCard(card.id);
  });

  for (const chip of card.content.chips) {
    const tag = document.createElement("span");
    tag.className = `tag tag-${chip.type}`;
    tag.textContent = chip.label.replace(/_/g, " ");
    el.appendChild(tag);
  }

  return el;
}

export function renderTime(card: Card<TimeContent>): HTMLElement {
  const el = document.createElement("div");
  el.className = "card card-time";
  el.addEventListener("click", () => {
    store.setFocus(card.id);
    if (card.lock === "inferred") store.confirmCard(card.id);
  });

  const c = card.content;
  const parts: string[] = [];
  if (c.total_min) parts.push(`${c.total_min} min total`);
  if (c.prep_min) parts.push(`${c.prep_min} prep`);
  if (c.cook_min) parts.push(`${c.cook_min} cook`);

  const text = document.createElement("span");
  text.className = "time-text";
  text.textContent = parts.length > 0 ? parts.join(" \u00b7 ") : "Time not set";

  const icon = document.createElement("span");
  icon.className = "time-icon";
  icon.textContent = "\u23f1";

  el.appendChild(icon);
  el.appendChild(text);
  return el;
}

export function renderYield(card: Card<YieldContent>): HTMLElement {
  const el = document.createElement("div");
  el.className = "card card-yield";
  el.addEventListener("click", () => {
    store.setFocus(card.id);
    if (card.lock === "inferred") store.confirmCard(card.id);
  });

  const c = card.content;
  const text = document.createElement("span");
  text.className = "yield-text";
  text.textContent = `${c.unit === "makes" ? "Makes" : "Serves"} ${c.amount}${c.item ? " " + c.item : ""}`;

  el.appendChild(text);
  return el;
}

export function renderEquipment(card: Card<EquipmentContent>): HTMLElement {
  const el = document.createElement("div");
  el.className = "card card-equipment";
  el.addEventListener("click", () => {
    store.setFocus(card.id);
    if (card.lock === "inferred") store.confirmCard(card.id);
  });

  const header = document.createElement("div");
  header.className = "equipment-header";
  header.textContent = "Equipment";
  el.appendChild(header);

  const list = document.createElement("div");
  list.className = "equipment-list";
  for (const item of card.content.required) {
    const row = document.createElement("div");
    row.className = "equipment-item";
    row.textContent = item;

    const alts = card.content.alternatives?.[item];
    if (alts && alts.length > 0) {
      const altSpan = document.createElement("span");
      altSpan.className = "equipment-alt";
      altSpan.textContent = `or ${alts.join(", ")}`;
      row.appendChild(altSpan);
    }

    list.appendChild(row);
  }
  el.appendChild(list);

  return el;
}

export function renderVariationChips(card: Card<VariationChipsContent>): HTMLElement {
  const el = document.createElement("div");
  el.className = "card card-variations";

  const header = document.createElement("div");
  header.className = "variations-header";
  header.textContent = "Variations";
  el.appendChild(header);

  const chips = document.createElement("div");
  chips.className = "variation-chips";
  for (const v of card.content.variations) {
    const chip = document.createElement("button");
    chip.className = `variation-chip${v.active ? " active" : ""}`;
    chip.textContent = v.label;
    if (v.recipe_count) chip.title = `${v.recipe_count} source recipes`;
    chips.appendChild(chip);
  }
  el.appendChild(chips);

  return el;
}

export function renderCanonicalBadge(card: Card<{ text: string }>): HTMLElement {
  const el = document.createElement("div");
  el.className = "card card-badge";
  el.textContent = card.content.text;
  return el;
}

export function renderSuggestion(card: Card<{ text: string; action?: string }>): HTMLElement {
  const el = document.createElement("div");
  el.className = "card card-suggestion";

  const text = document.createElement("span");
  text.textContent = card.content.text;
  el.appendChild(text);

  const dismiss = document.createElement("button");
  dismiss.className = "suggestion-dismiss";
  dismiss.textContent = "Ignore";
  dismiss.addEventListener("click", () => store.deleteCard(card.id));
  el.appendChild(dismiss);

  return el;
}
