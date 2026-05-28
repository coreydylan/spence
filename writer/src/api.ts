/**
 * API client for the recipe-graph worker.
 * In dev, Vite proxies /api/* to the worker.
 * In production, uses the worker URL directly.
 */

import type { Card, DishSearchResult, IngredientSearchResult, AffinitySuggestion } from "./types";

const BASE = import.meta.env.DEV
  ? "/api"
  : "https://recipe-graph.9f745064e644311ed09914b9a12e9c7380ce62b7.workers.dev";

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) throw new Error(`GET ${path}: ${res.status}`);
  return res.json() as Promise<T>;
}

async function post<T>(path: string, body: any): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`POST ${path}: ${res.status}`);
  return res.json() as Promise<T>;
}

// --- Dish search (title-first path) ---

export async function searchDishes(q: string): Promise<DishSearchResult[]> {
  const data = await get<{ dishes: DishSearchResult[] }>(`/dishes?q=${encodeURIComponent(q)}&limit=8`);
  return data.dishes || [];
}

export async function getDishStream(id: number): Promise<Card[]> {
  const data = await get<{ stream: Card[] }>(`/dishes/${id}/stream`);
  return data.stream || [];
}

export async function getBlankStream(): Promise<Card[]> {
  const data = await get<{ stream: Card[] }>("/stream/blank");
  return data.stream || [];
}

// --- Ingredient search (ingredient-first path) ---

export async function searchIngredients(q: string): Promise<IngredientSearchResult[]> {
  const data = await get<{ query: string; results: IngredientSearchResult[] }>(
    `/builder/search?q=${encodeURIComponent(q)}&limit=8`
  );
  return data.results || [];
}

export async function getAffinitySuggestions(
  ingredientIds: number[],
  limit = 15
): Promise<{
  suggestions: AffinitySuggestion[];
  composition: { categories: any[]; tags: any[] };
  matching_recipes: number;
  flavor_pairings: any[];
}> {
  return post("/builder/suggest", { ingredient_ids: ingredientIds, limit });
}

export async function getMatchingRecipes(
  ingredientIds: number[],
  limit = 12
): Promise<{ recipes: any[] }> {
  return post("/builder/recipes", { ingredient_ids: ingredientIds, limit });
}

export async function getDetectedComponents(
  ingredientNames: string[]
): Promise<{ detected_components: any[] }> {
  return post("/builder/components", { ingredient_names: ingredientNames });
}

export async function getMatchingDishes(
  ingredientNames: string[]
): Promise<{ dishes: any[] }> {
  return post("/builder/dishes", { ingredient_names: ingredientNames });
}

// --- Technique graph ---

export async function getTechnique(verb: string): Promise<any> {
  return get(`/techniques/${encodeURIComponent(verb)}`);
}

// --- Composition templates ---

export async function getCompositionTemplate(name: string): Promise<any> {
  return get(`/compositions/${encodeURIComponent(name)}/template`);
}

// --- Canonical recipe save ---

export async function validateCanonical(recipe: any): Promise<any> {
  return post("/canonical/validate", recipe);
}

export async function saveCanonical(recipe: any): Promise<any> {
  return post("/canonical", recipe);
}
