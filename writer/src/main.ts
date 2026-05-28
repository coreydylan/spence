/**
 * Spence Writer — entry point.
 * Three paths: title-first, ingredient-first, composition-first.
 */

import "./styles.css";
import { store } from "./store";
import { initRenderer } from "./renderer";
import { initSidebar, renderAffinitySidebar } from "./components/sidebar";
import { createSearchInput } from "./components/search-input";
import * as api from "./api";
import type { Card, DishSearchResult, IngredientSearchResult, IngredientContent, AffinitySuggestion } from "./types";

// ── DOM references ──

const app = document.getElementById("app")!;

// ── State for ingredient-first path ──

interface SelectedIngredient {
  id: number;
  name: string;
  category?: string;
}

let selectedIngredients: SelectedIngredient[] = [];

// ── Boot ──

showEntryScreen();

// ── Entry screen ──

function showEntryScreen() {
  app.innerHTML = `
    <div class="entry-screen">
      <header class="entry-header">
        <h1 class="logo">Spence</h1>
        <p class="tagline">Write recipes with intelligence.</p>
      </header>
      <div class="entry-paths">
        <div class="entry-search" id="entry-dish-search"></div>
        <div class="entry-divider"><span>or</span></div>
        <div class="entry-buttons">
          <button class="entry-btn" id="btn-ingredients">Start from ingredients</button>
          <button class="entry-btn" id="btn-blank">Start from scratch</button>
        </div>
      </div>
    </div>
  `;

  // Dish search (title-first)
  const dishSearch = createSearchInput<DishSearchResult>({
    placeholder: "What are you making?",
    search: api.searchDishes,
    renderItem: (d) => `
      <div class="dish-result">
        <span class="dish-name">${titleCase(d.canonical_title)}</span>
        <span class="dish-meta">${d.composition?.replace(/_/g, " ") || ""} \u00b7 ${d.recipe_count} recipes</span>
      </div>
    `,
    onSelect: (d) => loadDishStream(d),
  });
  document.getElementById("entry-dish-search")!.appendChild(dishSearch);

  // Ingredient-first
  document.getElementById("btn-ingredients")!.addEventListener("click", showIngredientPath);

  // Blank
  document.getElementById("btn-blank")!.addEventListener("click", async () => {
    const stream = await api.getBlankStream();
    showEditor(stream);
  });
}

// ── Title-first: load dish stream ──

async function loadDishStream(dish: DishSearchResult) {
  app.innerHTML = `<div class="loading-screen">Loading ${titleCase(dish.canonical_title)}...</div>`;
  try {
    const stream = await api.getDishStream(dish.id);
    showEditor(stream);
  } catch (e) {
    app.innerHTML = `<div class="error-screen">Failed to load. <button id="retry">Try again</button></div>`;
    document.getElementById("retry")?.addEventListener("click", showEntryScreen);
  }
}

// ── Ingredient-first path ──

function showIngredientPath() {
  selectedIngredients = [];

  app.innerHTML = `
    <div class="writer-layout">
      <div class="writer-main">
        <header class="writer-header">
          <button class="back-btn" id="btn-back">\u2190</button>
          <h1 class="logo-small">Spence</h1>
        </header>
        <div id="ing-search-area"></div>
        <div class="selected-chips" id="ing-chips"></div>
        <div id="ing-predictions"></div>
        <div id="stream-container" class="stream-container"></div>
      </div>
      <aside class="writer-sidebar" id="sidebar"></aside>
    </div>
    <div class="progress-wrap" id="progress-wrap" style="display:none">
      <div class="progress-track"><div class="progress-bar" id="progress-bar"></div></div>
      <span class="progress-text" id="progress-text"></span>
    </div>
  `;

  document.getElementById("btn-back")!.addEventListener("click", showEntryScreen);

  const search = createSearchInput<IngredientSearchResult>({
    placeholder: "Search for an ingredient...",
    search: async (q) => {
      const results = await api.searchIngredients(q);
      const selectedIds = new Set(selectedIngredients.map((s) => s.id));
      return results.filter((r) => !selectedIds.has(r.id));
    },
    renderItem: (r) => `
      <div class="ing-result">
        <span class="ing-result-name">${r.name}</span>
        <span class="ing-result-meta">${r.category || ""} \u00b7 ${r.total_count} recipes</span>
      </div>
    `,
    onSelect: (r) => addSelectedIngredient(r),
  });
  document.getElementById("ing-search-area")!.appendChild(search);
}

function addSelectedIngredient(ing: IngredientSearchResult) {
  if (selectedIngredients.find((s) => s.id === ing.id)) return;
  selectedIngredients.push({ id: ing.id, name: ing.name, category: ing.category });
  renderIngredientChips();
  fetchIngredientIntelligence();
}

function removeSelectedIngredient(id: number) {
  selectedIngredients = selectedIngredients.filter((s) => s.id !== id);
  renderIngredientChips();
  if (selectedIngredients.length > 0) {
    fetchIngredientIntelligence();
  } else {
    const predictions = document.getElementById("ing-predictions");
    const sidebar = document.getElementById("sidebar");
    if (predictions) predictions.innerHTML = "";
    if (sidebar) sidebar.innerHTML = "";
  }
}

function renderIngredientChips() {
  const container = document.getElementById("ing-chips");
  if (!container) return;
  container.innerHTML = selectedIngredients.map((s) => `
    <div class="chip">
      ${escapeHtml(s.name)}
      <button data-id="${s.id}" class="chip-remove">\u00d7</button>
    </div>
  `).join("");

  container.querySelectorAll(".chip-remove").forEach((btn) => {
    btn.addEventListener("click", () => {
      removeSelectedIngredient(parseInt((btn as HTMLElement).dataset.id || "0"));
    });
  });
}

async function fetchIngredientIntelligence() {
  const ids = selectedIngredients.map((s) => s.id);
  const names = selectedIngredients.map((s) => s.name.toLowerCase());
  const predictions = document.getElementById("ing-predictions");
  const sidebar = document.getElementById("sidebar");

  if (!predictions) return;
  predictions.innerHTML = `<div class="loading-inline">Analyzing...</div>`;

  try {
    const [suggestData, dishesData] = await Promise.all([
      api.getAffinitySuggestions(ids),
      api.getMatchingDishes(names),
    ]);

    // Predictions panel: composition + matching dishes
    let html = "";

    // Matching dishes
    const dishes = dishesData.dishes?.slice(0, 5) || [];
    if (dishes.length > 0) {
      html += `<div class="prediction-section">
        <div class="prediction-heading">This looks like...</div>
        <div class="prediction-dishes">
          ${dishes.map((d: any) => `
            <button class="prediction-dish" data-id="${d.id}">
              <span class="prediction-dish-name">${titleCase(d.canonical_title)}</span>
              <span class="prediction-dish-meta">${d.composition?.replace(/_/g, " ") || ""} \u00b7 ${d.recipe_count} recipes</span>
            </button>
          `).join("")}
        </div>
      </div>`;
    }

    // Composition categories
    const cats = suggestData.composition?.categories?.slice(0, 5) || [];
    if (cats.length > 0) {
      html += `<div class="prediction-section">
        <div class="prediction-heading">Composition</div>
        <div class="prediction-tags">
          ${cats.map((c: any) => `<span class="tag tag-composition">${c.category} ${c.confidence}%</span>`).join("")}
        </div>
      </div>`;
    }

    predictions.innerHTML = html;

    // Bind dish buttons — load that dish's card stream
    predictions.querySelectorAll(".prediction-dish").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const id = parseInt((btn as HTMLElement).dataset.id || "0");
        if (id) {
          const stream = await api.getDishStream(id);
          showEditor(stream);
        }
      });
    });

    // Sidebar: affinity suggestions
    if (sidebar && suggestData.suggestions?.length) {
      renderAffinitySidebar(sidebar, suggestData.suggestions, (s) => {
        addSelectedIngredient({ id: s.id, name: s.name, category: s.category, total_count: 0 });
      });
    }
  } catch {
    predictions.innerHTML = "";
  }
}

// ── Editor view (all paths converge here) ──

function showEditor(stream: Card[]) {
  app.innerHTML = `
    <div class="writer-layout">
      <div class="writer-main">
        <header class="writer-header">
          <button class="back-btn" id="btn-back">\u2190</button>
          <h1 class="logo-small">Spence</h1>
          <div class="header-actions">
            <button class="btn-secondary" id="btn-add-ingredient">+ Ingredient</button>
            <button class="btn-secondary" id="btn-add-step">+ Step</button>
            <button class="btn-primary" id="btn-export">Export JSON</button>
          </div>
        </header>
        <div id="stream-container" class="stream-container"></div>
      </div>
      <aside class="writer-sidebar" id="sidebar"></aside>
    </div>
    <div class="progress-wrap">
      <div class="progress-track"><div class="progress-bar" id="progress-bar"></div></div>
      <span class="progress-text" id="progress-text"></span>
    </div>
  `;

  const container = document.getElementById("stream-container")!;
  const sidebar = document.getElementById("sidebar")!;

  // Init renderer + sidebar
  initRenderer(container);
  initSidebar(sidebar);

  // Load stream into store
  store.loadStream(stream);

  // Wire up buttons
  document.getElementById("btn-back")!.addEventListener("click", showEntryScreen);
  document.getElementById("btn-add-ingredient")!.addEventListener("click", () => addNewIngredient());
  document.getElementById("btn-add-step")!.addEventListener("click", () => addNewStep());
  document.getElementById("btn-export")!.addEventListener("click", () => exportJSON());
}

function addNewIngredient() {
  const cards = store.getCards();
  // Find last ingredient card to insert after
  let lastIngIdx = -1;
  for (let i = cards.length - 1; i >= 0; i--) {
    if (cards[i].type === "ingredient" || cards[i].type === "optional_ingredients") {
      lastIngIdx = i;
      break;
    }
  }

  const newCard: Card<IngredientContent> = {
    id: `ing_new_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    type: "ingredient",
    content: { name: "", quantity: undefined, unit: undefined },
    lock: "user",
    source: "user",
    meta: { editable: true, deletable: true },
  };

  store.insertCard(newCard, lastIngIdx >= 0 ? cards[lastIngIdx].id : undefined);

  // Focus the new card's name field after render
  requestAnimationFrame(() => {
    const el = document.querySelector(`[data-card-id="${newCard.id}"] .ing-name`) as HTMLElement;
    el?.focus();
  });
}

function addNewStep() {
  const cards = store.getCards();
  const stepCards = cards.filter((c) => c.type === "step");
  const nextIndex = stepCards.length;

  // Find last step to insert after
  let lastStepId: string | undefined;
  for (let i = cards.length - 1; i >= 0; i--) {
    if (cards[i].type === "step") {
      lastStepId = cards[i].id;
      break;
    }
  }

  const newCard: Card = {
    id: `step_new_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    type: "step",
    content: { index: nextIndex, text: "" },
    lock: "user",
    source: "user",
    meta: { editable: true, deletable: true },
  };

  store.insertCard(newCard, lastStepId);

  requestAnimationFrame(() => {
    const el = document.querySelector(`[data-card-id="${newCard.id}"] .step-prose`) as HTMLElement;
    el?.focus();
  });
}

function exportJSON() {
  const cards = store.getCards();

  // Build a recipe-like object from the card stream
  const recipe: any = {};

  for (const card of cards) {
    switch (card.type) {
      case "title":
        recipe.title = card.content.title;
        recipe.id = card.content.title?.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
        break;
      case "tag_chips":
        recipe.tags = card.content.chips;
        break;
      case "time":
        recipe.time = card.content;
        break;
      case "yield":
        recipe.yield = card.content;
        break;
      case "ingredient":
        if (!recipe.ingredients) recipe.ingredients = [];
        recipe.ingredients.push(card.content);
        break;
      case "step":
        if (!recipe.steps) recipe.steps = [];
        recipe.steps.push(card.content);
        break;
      case "equipment":
        recipe.equipment = card.content;
        break;
      case "variation_chips":
        recipe.variations = card.content.variations;
        break;
    }
  }

  // Download
  const blob = new Blob([JSON.stringify(recipe, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${recipe.id || "recipe"}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

// ── Helpers ──

function titleCase(s: string): string {
  return s.split(" ").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

function escapeHtml(s: string): string {
  const div = document.createElement("div");
  div.textContent = s;
  return div.innerHTML;
}
