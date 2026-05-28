import type { Card, IngredientContent, OptionalIngredientsContent } from "../types";
import { store } from "../store";

export function renderIngredient(card: Card<IngredientContent>): HTMLElement {
  const el = document.createElement("div");
  el.className = "card card-ingredient";
  el.addEventListener("click", () => {
    store.setFocus(card.id);
    if (card.lock === "inferred") store.confirmCard(card.id);
  });

  const c = card.content;

  // Quantity + unit
  const qty = document.createElement("span");
  qty.className = "ing-qty";
  qty.contentEditable = "true";
  qty.textContent = c.quantity ? `${c.quantity}${c.unit ? " " + c.unit : ""}` : "";
  qty.dataset.placeholder = "qty";
  qty.addEventListener("blur", () => {
    const text = qty.textContent?.trim() || "";
    // Simple parse: "2 cups" → quantity=2, unit="cups"
    const match = text.match(/^([\d./]+)\s*(.*)?$/);
    if (match) {
      const parts = match[1].split("/");
      const q = parts.length === 2
        ? Number(parts[0]) / Number(parts[1])
        : parseFloat(match[1]);
      store.updateCard(card.id, { ...c, quantity: q, unit: match[2] || c.unit });
    }
  });

  // Name
  const name = document.createElement("span");
  name.className = "ing-name";
  name.contentEditable = "true";
  name.textContent = c.name;
  name.addEventListener("blur", () => {
    const text = name.textContent?.trim() || "";
    if (text && text !== c.name) {
      store.updateCard(card.id, { ...c, name: text });
    }
  });

  // Prep
  const prep = document.createElement("span");
  prep.className = "ing-prep";
  if (c.prep) prep.textContent = c.prep;

  // Frequency badge (corpus confidence)
  const freq = document.createElement("span");
  freq.className = "ing-freq";
  if (c.frequency && c.frequency > 0) {
    freq.textContent = `${Math.round(c.frequency * 100)}%`;
    freq.title = `${Math.round(c.frequency * 100)}% of source recipes include this`;
  }

  // Role badge
  const role = document.createElement("span");
  role.className = `ing-role role-${c.role || "other"}`;
  if (c.role) role.textContent = c.role;

  // Delete button
  const del = document.createElement("button");
  del.className = "card-delete";
  del.textContent = "\u00d7";
  del.title = "Remove ingredient";
  del.addEventListener("click", (e) => {
    e.stopPropagation();
    store.deleteCard(card.id);
  });

  el.appendChild(qty);
  el.appendChild(name);
  if (c.prep) el.appendChild(prep);
  el.appendChild(freq);
  if (c.role) el.appendChild(role);
  if (card.meta?.deletable !== false) el.appendChild(del);

  return el;
}

export function renderIngredientGroup(card: Card<{ label: string }>): HTMLElement {
  const el = document.createElement("div");
  el.className = "card card-ingredient-group";

  const label = document.createElement("h3");
  label.className = "group-label";
  label.contentEditable = "true";
  label.textContent = card.content.label;
  label.addEventListener("blur", () => {
    const text = label.textContent?.trim() || "";
    if (text !== card.content.label) {
      store.updateCard(card.id, { label: text });
    }
  });

  el.appendChild(label);
  return el;
}

export function renderOptionalIngredients(card: Card<OptionalIngredientsContent>): HTMLElement {
  const el = document.createElement("div");
  el.className = "card card-optional-group";

  const toggle = document.createElement("button");
  toggle.className = "optional-toggle";
  toggle.textContent = `${card.content.collapsed ? "\u25b8" : "\u25be"} ${card.content.label} (${card.content.ingredients.length})`;
  toggle.addEventListener("click", () => {
    store.updateCard(card.id, {
      ...card.content,
      collapsed: !card.content.collapsed,
    });
  });

  el.appendChild(toggle);

  if (!card.content.collapsed) {
    const list = document.createElement("div");
    list.className = "optional-list";
    for (const ing of card.content.ingredients) {
      const row = document.createElement("div");
      row.className = "card card-ingredient optional";
      row.innerHTML = `
        <span class="ing-qty">${ing.quantity ? `${ing.quantity} ${ing.unit || ""}` : ""}</span>
        <span class="ing-name">${ing.name}</span>
        ${ing.prep ? `<span class="ing-prep">${ing.prep}</span>` : ""}
        ${ing.frequency ? `<span class="ing-freq">${Math.round(ing.frequency * 100)}%</span>` : ""}
      `;
      list.appendChild(row);
    }
    el.appendChild(list);
  }

  return el;
}
