/**
 * Card stream renderer.
 * Diffs by card ID — existing cards stay in DOM, new ones get inserted.
 */

import type { Card } from "./types";
import { store } from "./store";
import { renderTitle } from "./cards/title";
import { renderIngredient, renderIngredientGroup, renderOptionalIngredients } from "./cards/ingredient";
import { renderStep } from "./cards/step";
import {
  renderTagChips, renderTime, renderYield,
  renderEquipment, renderVariationChips,
  renderCanonicalBadge, renderSuggestion,
} from "./cards/metadata";

// Map card ID → DOM element
const cardElements = new Map<string, HTMLElement>();

function renderCard(card: Card): HTMLElement {
  switch (card.type) {
    case "title": return renderTitle(card);
    case "canonical_badge": return renderCanonicalBadge(card);
    case "tag_chips": return renderTagChips(card);
    case "time": return renderTime(card);
    case "yield": return renderYield(card);
    case "ingredient_group": return renderIngredientGroup(card);
    case "ingredient": return renderIngredient(card);
    case "optional_ingredients": return renderOptionalIngredients(card);
    case "equipment": return renderEquipment(card);
    case "step": return renderStep(card);
    case "variation_chips": return renderVariationChips(card);
    case "suggestion": return renderSuggestion(card);
    default: return renderGeneric(card);
  }
}

function renderGeneric(card: Card): HTMLElement {
  const el = document.createElement("div");
  el.className = `card card-${card.type}`;
  el.textContent = JSON.stringify(card.content);
  return el;
}

function applyLockState(el: HTMLElement, card: Card) {
  el.classList.remove("lock-user", "lock-inferred", "lock-locked");
  el.classList.add(`lock-${card.lock}`);
  el.dataset.cardId = card.id;
  el.dataset.cardType = card.type;
  el.dataset.source = card.source;
}

export function initRenderer(container: HTMLElement) {
  store.subscribe((cards) => {
    renderStream(container, cards);
    renderProgress();
  });

  store.onFocusChange((id) => {
    // Update focused state on cards
    for (const [cardId, el] of cardElements) {
      el.classList.toggle("focused", cardId === id);
    }
  });
}

function renderStream(container: HTMLElement, cards: Card[]) {
  const newIds = new Set(cards.map((c) => c.id));

  // Remove cards no longer in stream
  for (const [id, el] of cardElements) {
    if (!newIds.has(id)) {
      el.remove();
      cardElements.delete(id);
    }
  }

  // Build ordered list of elements
  let prevEl: HTMLElement | null = null;
  for (const card of cards) {
    let el = cardElements.get(card.id);

    if (!el) {
      // New card — render and insert
      el = renderCard(card);
      applyLockState(el, card);
      cardElements.set(card.id, el);

      if (prevEl && prevEl.nextSibling) {
        container.insertBefore(el, prevEl.nextSibling);
      } else if (prevEl) {
        container.appendChild(el);
      } else if (container.firstChild) {
        container.insertBefore(el, container.firstChild);
      } else {
        container.appendChild(el);
      }
    } else {
      // Existing card — update lock state (content updates handled by card renderers)
      applyLockState(el, card);

      // Ensure correct order
      const expectedNext: ChildNode | null = prevEl ? prevEl.nextSibling : container.firstChild;
      if (el !== expectedNext) {
        if (prevEl) {
          prevEl.after(el);
        } else {
          container.prepend(el);
        }
      }
    }

    prevEl = el;
  }
}

function renderProgress() {
  const bar = document.getElementById("progress-bar");
  const text = document.getElementById("progress-text");
  if (!bar || !text) return;

  const { confirmed, total } = store.getProgress();
  if (total === 0) {
    bar.style.width = "0%";
    text.textContent = "";
    return;
  }

  const pct = Math.round((confirmed / total) * 100);
  bar.style.width = `${pct}%`;
  text.textContent = `${confirmed}/${total} confirmed`;
}
