/**
 * Autocomplete search input — used for dish search and ingredient search.
 */

export interface SearchConfig<T> {
  placeholder: string;
  search: (q: string) => Promise<T[]>;
  renderItem: (item: T) => string;
  onSelect: (item: T) => void;
}

export function createSearchInput<T>(config: SearchConfig<T>): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "search-box";

  const input = document.createElement("input");
  input.type = "text";
  input.className = "search-input";
  input.placeholder = config.placeholder;
  input.autocomplete = "off";

  const dropdown = document.createElement("div");
  dropdown.className = "search-dropdown";

  let timeout: ReturnType<typeof setTimeout>;
  let selectedIdx = -1;
  let currentItems: T[] = [];

  function updateDropdown(items: T[]) {
    currentItems = items;
    selectedIdx = -1;
    if (items.length === 0) {
      dropdown.classList.remove("active");
      return;
    }

    dropdown.innerHTML = items.map((item, i) =>
      `<div class="search-item" data-index="${i}">${config.renderItem(item)}</div>`
    ).join("");

    dropdown.querySelectorAll(".search-item").forEach((el, i) => {
      el.addEventListener("click", () => {
        config.onSelect(items[i]);
        input.value = "";
        dropdown.classList.remove("active");
      });
    });

    dropdown.classList.add("active");
  }

  input.addEventListener("input", () => {
    clearTimeout(timeout);
    const q = input.value.trim();
    if (q.length < 1) {
      dropdown.classList.remove("active");
      return;
    }
    timeout = setTimeout(async () => {
      try {
        const items = await config.search(q);
        updateDropdown(items);
      } catch {
        dropdown.classList.remove("active");
      }
    }, 150);
  });

  input.addEventListener("keydown", (e) => {
    if (!dropdown.classList.contains("active")) return;

    if (e.key === "ArrowDown") {
      e.preventDefault();
      selectedIdx = Math.min(selectedIdx + 1, currentItems.length - 1);
      highlightItem(dropdown, selectedIdx);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      selectedIdx = Math.max(selectedIdx - 1, 0);
      highlightItem(dropdown, selectedIdx);
    } else if (e.key === "Enter" && selectedIdx >= 0) {
      e.preventDefault();
      config.onSelect(currentItems[selectedIdx]);
      input.value = "";
      dropdown.classList.remove("active");
    } else if (e.key === "Escape") {
      dropdown.classList.remove("active");
    }
  });

  input.addEventListener("blur", () => {
    setTimeout(() => dropdown.classList.remove("active"), 200);
  });

  wrap.appendChild(input);
  wrap.appendChild(dropdown);
  return wrap;
}

function highlightItem(dropdown: HTMLElement, idx: number) {
  dropdown.querySelectorAll(".search-item").forEach((el, i) => {
    el.classList.toggle("selected", i === idx);
  });
}
