import { test, expect, type Page } from '@playwright/test';

// E2E for The Meatball Atlas. Runs against ATLAS_URL or defaults to production.
const URL = process.env.ATLAS_URL ?? 'https://atlas.cookspence.com/';

/** Skip the cinematic by clearing localStorage flag then jumping to done state. */
async function skipCinematic(page: Page) {
  await page.evaluate(() => {
    try { localStorage.setItem('spence-atlas-cinematic-seen-v1', '1'); } catch {}
  });
  await page.reload();
  // Wait until the window.__atlas API is exposed (means React island mounted).
  await page.waitForFunction(() => !!(window as any).__atlas?.graph, null, { timeout: 15_000 });
}

test.describe('Meatball Atlas — production smoke', () => {
  test('page loads with title and masthead', async ({ page }) => {
    await page.goto(URL);
    await expect(page).toHaveTitle(/Meatball Atlas/);
    await expect(page.locator('h1')).toContainText('The Meatball Atlas');
  });

  test('graph contains all 40 dishes and ~60 edges', async ({ page }) => {
    await page.goto(URL);
    await skipCinematic(page);
    const counts = await page.evaluate(() => {
      const g = (window as any).__atlas?.graph;
      return { order: g?.order, size: g?.size };
    });
    expect(counts.order).toBe(40);
    expect(counts.size).toBeGreaterThanOrEqual(55);
    expect(counts.size).toBeLessThanOrEqual(70);
  });

  test('clicking a node opens the panel with correct dish data', async ({ page }) => {
    await page.goto(URL);
    await skipCinematic(page);
    await page.evaluate(() => (window as any).__atlas?.selectNode('kofta-turkish'));
    await expect(page.locator('aside h2')).toHaveText('Köfte');
    await expect(page.locator('aside')).toContainText('Anatolia');
    await expect(page.locator('aside')).toContainText('medieval');
    await expect(page.locator('aside')).toContainText('Ottoman expansion');
  });

  test('kinship list lists at least 8 cousins for kofta hub', async ({ page }) => {
    await page.goto(URL);
    await skipCinematic(page);
    await page.evaluate(() => (window as any).__atlas?.selectNode('kofta-turkish'));
    const count = await page.locator('aside ul li').count();
    expect(count).toBeGreaterThanOrEqual(8);
  });

  test('escape clears the panel', async ({ page }) => {
    await page.goto(URL);
    await skipCinematic(page);
    await page.evaluate(() => (window as any).__atlas?.selectNode('polpette'));
    await expect(page.locator('aside h2')).toHaveText('Polpette');
    await page.keyboard.press('Escape');
    await expect(page.locator('aside')).toHaveCount(0);
  });

  test('legend renders 6 routes + local with color-blind glyphs', async ({ page }) => {
    await page.goto(URL);
    await skipCinematic(page);
    const legendText = await page.evaluate(() => {
      const divs = Array.from(document.querySelectorAll('div')).filter(
        (d) => (d.textContent ?? '').includes('Trade Routes'),
      );
      return divs[0]?.textContent ?? '';
    });
    expect(legendText).toContain('Silk Road');
    expect(legendText).toContain('Ottoman expansion');
    expect(legendText).toContain('Moorish Iberia');
    expect(legendText).toContain('Hanseatic / North Sea');
    expect(legendText).toContain('Diaspora');
    expect(legendText).toContain('Columbian Exchange');
    expect(legendText).toContain('Local / unattributed');
  });

  test('a11y mirror contains all 40 dishes as anchor links', async ({ page }) => {
    await page.goto(URL);
    await skipCinematic(page);
    const anchors = await page.locator('nav[aria-label*="dishes"] a[href*="?dish="]').count();
    expect(anchors).toBe(40);
  });

  test('a11y mirror anchor activates panel without page reload', async ({ page }) => {
    await page.goto(URL);
    await skipCinematic(page);
    const beforeUrl = page.url();
    // The a11y mirror is clipped (inset(50%)) — keyboard reaches it but pixels don't.
    // Programmatically click via the DOM so React's onClick handler fires (preventDefault + selectNode).
    await page.evaluate(() => {
      const a = document.querySelector('nav[aria-label*="dishes"] a[href="?dish=polpette"]') as HTMLAnchorElement | null;
      a?.click();
    });
    await expect(page.locator('aside h2')).toHaveText('Polpette');
    // URL should NOT change (preventDefault worked)
    expect(page.url()).toBe(beforeUrl);
  });

  test('deep link ?dish=kibbeh skips cinematic and pre-selects', async ({ page }) => {
    await page.goto(`${URL}?dish=kibbeh`);
    await page.waitForFunction(() => !!(window as any).__atlas?.graph, null, { timeout: 15_000 });
    await expect(page.locator('aside h2')).toHaveText('Kibbeh');
  });

  test('OG meta tags are present for shareability', async ({ page }) => {
    await page.goto(URL);
    const og = await page.evaluate(() => ({
      title: document.querySelector('meta[property="og:title"]')?.getAttribute('content'),
      desc: document.querySelector('meta[property="og:description"]')?.getAttribute('content'),
      image: document.querySelector('meta[property="og:image"]')?.getAttribute('content'),
      twitter: document.querySelector('meta[name="twitter:card"]')?.getAttribute('content'),
    }));
    expect(og.title).toContain('Meatball Atlas');
    expect(og.desc).toMatch(/40 dishes/);
    expect(og.image).toContain('og.png');
    expect(og.twitter).toBe('summary_large_image');
  });

  test('cinematic plays on first visit (no localStorage flag)', async ({ page }) => {
    await page.context().clearCookies();
    await page.addInitScript(() => {
      try { localStorage.removeItem('spence-atlas-cinematic-seen-v1'); } catch {}
    });
    await page.goto(URL);
    // Skip-intro button should be visible during cinematic
    await expect(page.locator('button:has-text("Skip intro")')).toBeVisible({ timeout: 5_000 });
  });

  test('mobile viewport renders panel as bottom sheet', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(URL);
    await skipCinematic(page);
    await page.evaluate(() => (window as any).__atlas?.selectNode('kofta-turkish'));
    const asideRect = await page.locator('aside').boundingBox();
    expect(asideRect).not.toBeNull();
    // Bottom sheet sits at the bottom of the viewport
    expect(asideRect!.y + asideRect!.height).toBeGreaterThanOrEqual(840);
  });
});
