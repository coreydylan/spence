/**
 * Shop check-state persistence.
 *
 * MVP: localStorage keyed by `shop_${shop_run_id}_checked` mapping to a
 * `Set<string>` of canonical item names. Optionally double-writes to
 * `/api/shop/check` so the worker can persist (no-op if the route is offline).
 *
 * Items are identified by lowercased name within a shop_run. That keeps the
 * check state stable across regenerations of the shopping list as long as the
 * canonical name doesn't change.
 */

const STORAGE_PREFIX = "shop_";
const STORAGE_SUFFIX = "_checked";

export function storageKey(shop_run_id: string): string {
  return `${STORAGE_PREFIX}${shop_run_id}${STORAGE_SUFFIX}`;
}

function safeParse(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.filter((x) => typeof x === "string");
    }
  } catch {
    // ignore
  }
  return [];
}

export function loadChecked(shop_run_id: string): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(storageKey(shop_run_id));
    return new Set(safeParse(raw));
  } catch {
    return new Set();
  }
}

export function saveChecked(
  shop_run_id: string,
  checked: Set<string>,
): void {
  if (typeof window === "undefined") return;
  try {
    const arr = Array.from(checked);
    window.localStorage.setItem(storageKey(shop_run_id), JSON.stringify(arr));
  } catch {
    // quota or disabled — silent
  }
}

export function normalizeItemKey(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * Best-effort: POST to /api/shop/check so the server has a record. Failures
 * are swallowed because localStorage is the source of truth for MVP.
 */
export async function postCheck(
  shop_run_id: string,
  item_name: string,
  checked: boolean,
): Promise<void> {
  if (typeof window === "undefined") return;
  try {
    await fetch("/api/shop/check", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ shop_run_id, item_name, checked }),
    });
  } catch {
    // ignore — localStorage already saved
  }
}
