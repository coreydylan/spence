import type { Card, TitleContent } from "../types";
import { store } from "../store";

export function renderTitle(card: Card<TitleContent>): HTMLElement {
  const el = document.createElement("div");
  el.className = "card card-title";

  const input = document.createElement("h1");
  input.contentEditable = "true";
  input.className = "title-input";
  input.textContent = card.content.title || "";
  input.dataset.placeholder = "Recipe title...";

  input.addEventListener("focus", () => store.setFocus(card.id));
  input.addEventListener("blur", () => {
    const text = input.textContent?.trim() || "";
    if (text !== card.content.title) {
      store.updateCard(card.id, { ...card.content, title: text });
    }
  });

  el.appendChild(input);

  if (card.content.canonical_id) {
    const badge = document.createElement("span");
    badge.className = "canonical-ref";
    badge.textContent = `#${card.content.canonical_id}`;
    el.appendChild(badge);
  }

  return el;
}
