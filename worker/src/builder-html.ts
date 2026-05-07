export const BUILDER_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Spence — Recipe Builder</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    background: #faf8f5;
    color: #2a2a2a;
    min-height: 100vh;
    padding: 24px;
  }
  .container { max-width: 1200px; margin: 0 auto; }
  header {
    margin-bottom: 32px;
    padding-bottom: 24px;
    border-bottom: 2px solid #e8e4dd;
  }
  h1 { font-size: 28px; font-weight: 600; color: #5a3921; letter-spacing: -0.5px; }
  .subtitle { color: #8a7966; font-size: 14px; margin-top: 4px; }

  .search-box {
    position: relative;
    margin-bottom: 16px;
  }
  #search-input {
    width: 100%;
    padding: 16px 20px;
    font-size: 16px;
    border: 2px solid #d4cfc4;
    border-radius: 12px;
    background: white;
    outline: none;
    transition: border-color 0.15s;
  }
  #search-input:focus { border-color: #c7663c; }

  .suggestions-dropdown {
    position: absolute;
    top: 100%;
    left: 0;
    right: 0;
    background: white;
    border: 1px solid #d4cfc4;
    border-radius: 8px;
    margin-top: 4px;
    max-height: 300px;
    overflow-y: auto;
    z-index: 10;
    box-shadow: 0 4px 16px rgba(0,0,0,0.08);
    display: none;
  }
  .suggestions-dropdown.active { display: block; }
  .suggestion-item {
    padding: 12px 16px;
    cursor: pointer;
    border-bottom: 1px solid #f0ece5;
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  .suggestion-item:hover, .suggestion-item.selected { background: #f5f0e8; }
  .suggestion-item:last-child { border-bottom: none; }
  .suggestion-name { font-weight: 500; }
  .suggestion-meta { font-size: 12px; color: #8a7966; }

  .selected-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    min-height: 48px;
    margin-bottom: 24px;
  }
  .chip {
    background: #5a3921;
    color: white;
    padding: 8px 12px 8px 16px;
    border-radius: 20px;
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 14px;
    font-weight: 500;
  }
  .chip button {
    background: rgba(255,255,255,0.2);
    color: white;
    border: none;
    border-radius: 50%;
    width: 20px;
    height: 20px;
    cursor: pointer;
    font-size: 12px;
    display: flex;
    align-items: center;
    justify-content: center;
    line-height: 1;
  }
  .chip button:hover { background: rgba(255,255,255,0.35); }

  .empty-state {
    text-align: center;
    color: #8a7966;
    padding: 40px;
    font-style: italic;
  }

  .grid {
    display: grid;
    grid-template-columns: 2fr 1fr;
    gap: 24px;
  }
  @media (max-width: 768px) { .grid { grid-template-columns: 1fr; } }

  .panel {
    background: white;
    border-radius: 12px;
    padding: 20px;
    border: 1px solid #e8e4dd;
  }
  .panel h2 {
    font-size: 14px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: #8a7966;
    margin-bottom: 16px;
    font-weight: 600;
  }

  .suggestion-card {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 12px;
    border-radius: 8px;
    cursor: pointer;
    transition: background 0.1s;
    border-bottom: 1px solid #f0ece5;
  }
  .suggestion-card:hover { background: #faf8f5; }
  .suggestion-card:last-child { border-bottom: none; }
  .card-info { flex: 1; }
  .card-name { font-weight: 500; color: #2a2a2a; }
  .card-meta { font-size: 12px; color: #8a7966; margin-top: 2px; }
  .card-flavors {
    font-size: 11px;
    color: #c7663c;
    margin-top: 4px;
    font-style: italic;
  }
  .card-score {
    font-size: 12px;
    color: #8a7966;
    background: #f5f0e8;
    padding: 4px 8px;
    border-radius: 4px;
    font-variant-numeric: tabular-nums;
  }
  .card-add {
    background: #c7663c;
    color: white;
    border: none;
    padding: 6px 12px;
    border-radius: 6px;
    cursor: pointer;
    font-size: 13px;
    font-weight: 500;
    margin-left: 12px;
  }
  .card-add:hover { background: #a54f2c; }

  .tag-list {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .tag {
    background: #f5f0e8;
    color: #5a3921;
    padding: 6px 10px;
    border-radius: 6px;
    font-size: 12px;
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .tag-confidence { font-weight: 600; color: #c7663c; }

  .loading {
    text-align: center;
    color: #8a7966;
    padding: 20px;
    font-style: italic;
  }

  .stats-bar {
    display: flex;
    gap: 24px;
    padding: 12px 16px;
    background: #f5f0e8;
    border-radius: 8px;
    margin-bottom: 16px;
    font-size: 13px;
    color: #5a3921;
  }
  .stat { display: flex; align-items: center; gap: 6px; }
  .stat-value { font-weight: 600; color: #c7663c; font-size: 15px; }

  .components-banner {
    background: linear-gradient(135deg, #fff5ed 0%, #faf0e4 100%);
    border: 2px solid #c7663c;
    border-radius: 12px;
    padding: 20px;
    margin-bottom: 20px;
  }
  .components-banner h2 {
    font-size: 13px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: #c7663c;
    margin-bottom: 12px;
    font-weight: 700;
  }
  .component-detected {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    padding: 14px;
    background: white;
    border-radius: 8px;
    margin-bottom: 8px;
    border: 1px solid #e8d4c0;
  }
  .component-detected:last-child { margin-bottom: 0; }
  .component-info { flex: 1; }
  .component-name {
    font-size: 17px;
    font-weight: 700;
    color: #5a3921;
    text-transform: capitalize;
    margin-bottom: 4px;
  }
  .component-status {
    font-size: 13px;
    color: #8a7966;
    margin-bottom: 6px;
  }
  .component-missing {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    margin-top: 6px;
  }
  .component-missing-chip {
    background: #fdeee4;
    color: #c7663c;
    font-size: 11px;
    padding: 3px 8px;
    border-radius: 4px;
    font-weight: 500;
  }
  .component-complete-badge {
    background: #c7663c;
    color: white;
    font-size: 11px;
    padding: 3px 8px;
    border-radius: 4px;
    font-weight: 600;
    text-transform: uppercase;
  }
  .completion-bar-wrap {
    width: 100px;
    height: 6px;
    background: #f0ece5;
    border-radius: 3px;
    overflow: hidden;
    margin-top: 8px;
  }
  .completion-bar {
    height: 100%;
    background: #c7663c;
    border-radius: 3px;
    transition: width 0.3s;
  }

  .recipes-section { margin-top: 24px; }
  .recipes-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
    gap: 16px;
    margin-top: 16px;
  }
  .recipe-card {
    background: white;
    border: 1px solid #e8e4dd;
    border-radius: 10px;
    padding: 16px;
    transition: all 0.15s;
    cursor: pointer;
    text-decoration: none;
    color: inherit;
    display: block;
  }
  .recipe-card:hover {
    border-color: #c7663c;
    transform: translateY(-2px);
    box-shadow: 0 4px 12px rgba(0,0,0,0.06);
  }
  .recipe-title {
    font-weight: 600;
    font-size: 15px;
    color: #2a2a2a;
    line-height: 1.3;
    margin-bottom: 8px;
  }
  .recipe-source {
    font-size: 11px;
    color: #8a7966;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    margin-bottom: 10px;
  }
  .recipe-matches {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    margin-bottom: 10px;
  }
  .recipe-match-chip {
    background: #e8f5e9;
    color: #2d6a31;
    font-size: 11px;
    padding: 3px 8px;
    border-radius: 4px;
    font-weight: 500;
  }
  .recipe-meta {
    display: flex;
    gap: 12px;
    font-size: 12px;
    color: #8a7966;
  }
  .recipe-meta-item { display: flex; align-items: center; gap: 4px; }
</style>
</head>
<body>
<div class="container">
  <header>
    <h1>Spence</h1>
    <p class="subtitle">Type ingredients. Discover what you're making.</p>
  </header>

  <div class="search-box">
    <input type="text" id="search-input" placeholder="Search for an ingredient..." autocomplete="off">
    <div class="suggestions-dropdown" id="search-dropdown"></div>
  </div>

  <div class="selected-chips" id="selected-chips"></div>

  <div id="results-container">
    <div class="empty-state">Add an ingredient to start building</div>
  </div>
</div>

<script>
const API_BASE = 'https://recipe-graph.9f745064e644311ed09914b9a12e9c7380ce62b7.workers.dev';
let selected = []; // {id, name, category}
let searchTimeout;

const searchInput = document.getElementById('search-input');
const dropdown = document.getElementById('search-dropdown');
const chipsContainer = document.getElementById('selected-chips');
const resultsContainer = document.getElementById('results-container');

searchInput.addEventListener('input', (e) => {
  clearTimeout(searchTimeout);
  const q = e.target.value.trim();
  if (q.length < 1) {
    dropdown.classList.remove('active');
    return;
  }
  searchTimeout = setTimeout(() => searchIngredients(q), 150);
});

searchInput.addEventListener('blur', () => {
  setTimeout(() => dropdown.classList.remove('active'), 200);
});

async function searchIngredients(q) {
  const res = await fetch(\`\${API_BASE}/builder/search?q=\${encodeURIComponent(q)}&limit=8\`);
  const data = await res.json();

  const selectedIds = new Set(selected.map(s => s.id));
  const filtered = (data.results || []).filter(r => !selectedIds.has(r.id));

  if (filtered.length === 0) {
    dropdown.classList.remove('active');
    return;
  }

  dropdown.innerHTML = filtered.map(r => \`
    <div class="suggestion-item" data-id="\${r.id}" data-name="\${escapeHtml(r.name)}" data-category="\${r.category || ''}">
      <div>
        <div class="suggestion-name">\${escapeHtml(r.name)}</div>
        <div class="suggestion-meta">\${r.category || 'uncategorized'} · \${r.total_count} recipes</div>
      </div>
    </div>
  \`).join('');

  dropdown.querySelectorAll('.suggestion-item').forEach(el => {
    el.addEventListener('click', () => {
      addIngredient({
        id: parseInt(el.dataset.id),
        name: el.dataset.name,
        category: el.dataset.category,
      });
    });
  });

  dropdown.classList.add('active');
}

function addIngredient(ing) {
  if (selected.find(s => s.id === ing.id)) return;
  selected.push(ing);
  searchInput.value = '';
  dropdown.classList.remove('active');
  renderChips();
  fetchSuggestions();
}

function removeIngredient(id) {
  selected = selected.filter(s => s.id !== id);
  renderChips();
  if (selected.length > 0) fetchSuggestions();
  else resultsContainer.innerHTML = '<div class="empty-state">Add an ingredient to start building</div>';
}

function renderChips() {
  if (selected.length === 0) {
    chipsContainer.innerHTML = '';
    return;
  }
  chipsContainer.innerHTML = selected.map(s => \`
    <div class="chip">
      \${escapeHtml(s.name)}
      <button onclick="removeIngredient(\${s.id})">×</button>
    </div>
  \`).join('');
}

async function fetchSuggestions() {
  resultsContainer.innerHTML = '<div class="loading">Analyzing your ingredients…</div>';

  const [suggestRes, recipesRes, componentsRes, dishesRes] = await Promise.all([
    fetch(\`\${API_BASE}/builder/suggest\`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ingredient_ids: selected.map(s => s.id), limit: 15 }),
    }),
    fetch(\`\${API_BASE}/builder/recipes\`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ingredient_ids: selected.map(s => s.id), limit: 12 }),
    }),
    fetch(\`\${API_BASE}/builder/components\`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ingredient_names: selected.map(s => s.name.toLowerCase()) }),
    }),
    fetch(\`\${API_BASE}/builder/dishes\`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ingredient_names: selected.map(s => s.name.toLowerCase()) }),
    }),
  ]);
  const suggestData = await suggestRes.json();
  const recipesData = await recipesRes.json();
  const componentsData = await componentsRes.json();
  const dishesData = await dishesRes.json();
  renderResults(suggestData, recipesData, componentsData, dishesData);
}

function renderResults(data, recipesData, componentsData, dishesData) {
  const { suggestions, composition, flavor_pairings, matching_recipes } = data;
  const { recipes } = recipesData || { recipes: [] };
  const components = (componentsData?.detected_components || []).slice(0, 4);
  const dishes = (dishesData?.dishes || []).slice(0, 5);

  // Build component banner (if any components detected)
  const componentBanner = components.length > 0 ? \`
    <div class="components-banner">
      <h2>You're Building</h2>
      \${components.map(c => {
        const isComplete = c.core_missing.length === 0;
        const pct = c.completion_pct;
        return \`
          <div class="component-detected">
            <div class="component-info">
              <div class="component-name">\${escapeHtml(c.name)}</div>
              <div class="component-status">
                \${isComplete ? 'You have all the essentials.' : \`\${pct}% there · need \${c.core_missing.length} more\`}
              </div>
              \${!isComplete ? \`
                <div class="component-missing">
                  \${c.core_missing.slice(0, 4).map(m => \`<span class="component-missing-chip">\${escapeHtml(m)}</span>\`).join('')}
                </div>
              \` : ''}
              <div class="completion-bar-wrap"><div class="completion-bar" style="width: \${pct}%"></div></div>
            </div>
            \${isComplete ? '<div class="component-complete-badge">complete</div>' : ''}
          </div>
        \`;
      }).join('')}
    </div>
  \` : '';

  // Build dishes banner
  const dishesBanner = dishes.length > 0 ? \`
    <div class="components-banner" style="background: linear-gradient(135deg, #f0f4f8 0%, #e8eef5 100%); border-color: #3a5a7a;">
      <h2 style="color: #3a5a7a;">You Could Make</h2>
      \${dishes.map(d => {
        const missing = d.missing_top || [];
        const pct = d.completion_pct;
        return \`
          <div class="component-detected" style="border-color: #d0dce8;">
            <div class="component-info">
              <div class="component-name" style="color: #2a3f55;">\${escapeHtml(d.title)}</div>
              <div class="component-status">
                <span style="text-transform: capitalize;">\${escapeHtml((d.composition || '').replace(/_/g, ' '))}</span>
                · \${pct}% there
                \${d.total_time_min ? \`· \${d.total_time_min} min\` : ''}
                \${d.servings ? \`· serves \${d.servings}\` : ''}
                · \${d.recipe_count} recipes
              </div>
              \${missing.length > 0 ? \`
                <div class="component-missing">
                  \${missing.slice(0, 4).map(m => \`<span class="component-missing-chip" style="background:#e0e8f0; color:#3a5a7a;">\${escapeHtml(m)}</span>\`).join('')}
                </div>
              \` : ''}
              <div class="completion-bar-wrap"><div class="completion-bar" style="width: \${pct}%; background: #3a5a7a;"></div></div>
            </div>
          </div>
        \`;
      }).join('')}
    </div>
  \` : '';

  resultsContainer.innerHTML = \`
    \${dishesBanner}
    \${componentBanner}
    <div class="stats-bar">
      <div class="stat"><span>Recipes matching your ingredients:</span> <span class="stat-value">\${matching_recipes}</span></div>
      <div class="stat"><span>Top recipes shown:</span> <span class="stat-value">\${recipes.length}</span></div>
    </div>

    <div class="grid">
      <div class="panel">
        <h2>Next Ingredient Suggestions</h2>
        \${suggestions.length === 0 ? '<div class="empty-state">No suggestions yet</div>' :
          suggestions.map(s => \`
            <div class="suggestion-card">
              <div class="card-info">
                <div class="card-name">\${escapeHtml(s.name)}</div>
                <div class="card-meta">\${s.category || 'uncategorized'} · affinity \${s.score} · \${s.co_occurrence} co-occurrences</div>
                \${s.flavor_profile ? \`<div class="card-flavors">\${s.flavor_profile.join(' · ')}</div>\` : ''}
              </div>
              <button class="card-add" onclick='addIngredient(\${JSON.stringify({id: s.id, name: s.name, category: s.category}).replace(/'/g, "&apos;")})'>+ Add</button>
            </div>
          \`).join('')}
      </div>

      <div>
        <div class="panel" style="margin-bottom: 16px;">
          <h2>Likely Dish Type</h2>
          <div class="tag-list">
            \${composition.categories.slice(0, 8).filter(c => !['recipes','special diets'].includes(c.category)).map(c => \`
              <div class="tag">\${escapeHtml(c.category)} <span class="tag-confidence">\${c.confidence}%</span></div>
            \`).join('')}
          </div>
        </div>

        <div class="panel">
          <h2>Molecular Flavor Pairings</h2>
          \${flavor_pairings.length === 0 ? '<div class="empty-state">No compound data for these ingredients</div>' :
            flavor_pairings.slice(0, 6).map(f => \`
              <div class="suggestion-card" style="padding: 8px 0;">
                <div class="card-info">
                  <div class="card-name" style="font-size: 14px;">\${escapeHtml(f.partner_name)}</div>
                </div>
                <div class="card-score">\${f.shared_compounds} compounds</div>
              </div>
            \`).join('')}
        </div>
      </div>
    </div>

    \${recipes.length > 0 ? \`
      <div class="recipes-section">
        <div class="panel" style="background: transparent; border: none; padding: 0;">
          <h2>Recipes You Can Make</h2>
          <div class="recipes-grid">
            \${recipes.map(r => {
              const matched = (r.matched || '').split(',').filter(Boolean);
              const selectedNames = new Set(selected.map(s => s.name.toLowerCase()));
              return \`
                <a class="recipe-card" href="\${escapeHtml(r.url)}" target="_blank" rel="noopener">
                  <div class="recipe-title">\${escapeHtml(r.title)}</div>
                  <div class="recipe-source">\${escapeHtml(r.source_name || 'unknown')}</div>
                  <div class="recipe-matches">
                    \${matched.slice(0, 5).map(m => \`<span class="recipe-match-chip">\${escapeHtml(m)}</span>\`).join('')}
                    \${matched.length > 5 ? \`<span class="recipe-match-chip">+\${matched.length - 5}</span>\` : ''}
                  </div>
                  <div class="recipe-meta">
                    \${r.total_time_min ? \`<span class="recipe-meta-item">⏱ \${r.total_time_min}m</span>\` : ''}
                    \${r.servings ? \`<span class="recipe-meta-item">🍽 \${r.servings}</span>\` : ''}
                    \${r.rating_value ? \`<span class="recipe-meta-item">★ \${r.rating_value}</span>\` : ''}
                  </div>
                </a>
              \`;
            }).join('')}
          </div>
        </div>
      </div>
    \` : ''}
  \`;
}

function escapeHtml(s) {
  if (!s) return '';
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
}

// Expose for inline handlers
window.removeIngredient = removeIngredient;
window.addIngredient = addIngredient;
</script>
</body>
</html>
`;
