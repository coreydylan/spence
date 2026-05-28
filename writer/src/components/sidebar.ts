/**
 * Contextual sidebar — shows intelligence based on focused card.
 */

import { store } from "../store";
import * as api from "../api";
import type { AffinitySuggestion, IngredientContent } from "../types";

export function initSidebar(container: HTMLElement) {
  store.onFocusChange(async (cardId) => {
    if (!cardId) {
      container.innerHTML = "";
      return;
    }

    const cards = store.getCards();
    const card = cards.find((c) => c.id === cardId);
    if (!card) return;

    switch (card.type) {
      case "ingredient":
        await renderIngredientSidebar(container, card.content as IngredientContent);
        break;
      case "step":
        await renderStepSidebar(container, card.content);
        break;
      default:
        container.innerHTML = "";
    }
  });
}

async function renderIngredientSidebar(container: HTMLElement, content: IngredientContent) {
  container.innerHTML = `<div class="sidebar-loading">Loading suggestions...</div>`;

  // Get all current ingredient IDs from the stream
  const cards = store.getCards();
  const ingredientCards = cards.filter((c) => c.type === "ingredient");
  const currentNames = ingredientCards.map((c) => (c.content as IngredientContent).name);

  // Show role and frequency info
  let html = `<div class="sidebar-section">
    <div class="sidebar-heading">About this ingredient</div>
    <div class="sidebar-detail">
      <span class="detail-label">Role:</span>
      <span class="detail-value">${content.role || "unknown"}</span>
    </div>
    ${content.frequency ? `<div class="sidebar-detail">
      <span class="detail-label">Corpus frequency:</span>
      <span class="detail-value">${Math.round(content.frequency * 100)}% of source recipes</span>
    </div>` : ""}
  </div>`;

  container.innerHTML = html;

  // Try to fetch technique data for common actions on this ingredient
  try {
    const name = content.canonical || content.name;
    // Get affinities (if we have ingredient IDs we could use /builder/suggest)
    // For now show what we know
  } catch {
    // Silent fail
  }
}

async function renderStepSidebar(container: HTMLElement, content: any) {
  // Extract verb from step text
  const text = content.text || "";
  const verb = text.split(/\s+/)[0]?.toLowerCase();

  if (!verb || verb.length < 3) {
    container.innerHTML = "";
    return;
  }

  container.innerHTML = `<div class="sidebar-loading">Looking up "${verb}"...</div>`;

  try {
    const data = await api.getTechnique(verb);
    if (!data.params && !data.sensory_cues?.length) {
      container.innerHTML = "";
      return;
    }

    let html = `<div class="sidebar-section">
      <div class="sidebar-heading">Technique: ${verb}</div>`;

    // Sensory cues
    if (data.sensory_cues?.length) {
      html += `<div class="sidebar-subsection">
        <div class="sidebar-subheading">Sensory cues</div>
        ${data.sensory_cues.slice(0, 5).map((c: any) =>
          `<div class="sidebar-cue">"${c.cue}"</div>`
        ).join("")}
      </div>`;
    }

    // Pitfalls
    if (data.pitfalls?.length) {
      html += `<div class="sidebar-subsection">
        <div class="sidebar-subheading">Watch out for</div>
        ${data.pitfalls.slice(0, 3).map((p: any) =>
          `<div class="sidebar-pitfall">${p.pitfall}</div>`
        ).join("")}
      </div>`;
    }

    // Common next steps
    if (data.followed_by?.length) {
      html += `<div class="sidebar-subsection">
        <div class="sidebar-subheading">Usually followed by</div>
        <div class="sidebar-sequence">
          ${data.followed_by.slice(0, 4).map((f: any) =>
            `<span class="sequence-step">${f.next_technique}</span>`
          ).join(" \u2192 ")}
        </div>
      </div>`;
    }

    // Heat levels
    if (data.heat_levels?.length) {
      html += `<div class="sidebar-subsection">
        <div class="sidebar-subheading">Heat</div>
        <div class="sidebar-heat">
          ${data.heat_levels.map((h: any) =>
            `<span class="heat-level">${h.heat_level} (${h.count})</span>`
          ).join(" ")}
        </div>
      </div>`;
    }

    html += `</div>`;
    container.innerHTML = html;
  } catch {
    container.innerHTML = "";
  }
}

/**
 * Render affinity suggestions in the sidebar (used by ingredient-first path)
 */
export function renderAffinitySidebar(
  container: HTMLElement,
  suggestions: AffinitySuggestion[],
  onAdd: (suggestion: AffinitySuggestion) => void,
) {
  let html = `<div class="sidebar-section">
    <div class="sidebar-heading">You might also want</div>`;

  for (const s of suggestions.slice(0, 10)) {
    html += `<div class="sidebar-suggestion" data-id="${s.id}">
      <div class="sidebar-suggestion-info">
        <span class="sidebar-suggestion-name">${s.name}</span>
        <span class="sidebar-suggestion-meta">${s.category || ""}</span>
      </div>
      <div class="sidebar-suggestion-score">${s.score.toFixed(1)}</div>
      <button class="sidebar-suggestion-add" data-id="${s.id}">+</button>
    </div>`;
  }

  html += `</div>`;
  container.innerHTML = html;

  // Bind add buttons
  container.querySelectorAll(".sidebar-suggestion-add").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = parseInt((btn as HTMLElement).dataset.id || "0");
      const s = suggestions.find((x) => x.id === id);
      if (s) onAdd(s);
    });
  });
}
