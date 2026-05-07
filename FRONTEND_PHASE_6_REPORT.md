# Frontend Phase 6 — Polish Report

> Chat polish + settings + ambient touches for the Spence web app. Builds on
> Phase 1's foundation; nothing in `lib/chef-agent.ts`, `lib/auth.ts`,
> `components/primitives/*`, or `components/chef/*` was modified.

## What landed

**Chat polish** (`/chat` rewritten additively):
- Pre-token typing indicator inside the bubble while tools spin up.
- Tool-call chips collapse to a sage `done` pill; tools with renderers
  (e.g. `plan_compose_meal` → `<MealCard>`) replace their chip with the UI.
- Consecutive Spence messages stack under a shared avatar via
  `spence-avatar-hidden` CSS rule (no fork of `<ChefBubble>`).
- Markdown rendering — safe by construction (no innerHTML, no raw HTML
  pass-through, http/mailto links only). Subset: bold/italic/code/lists/
  links/headings.
- Auto-scroll sticks to bottom unless user scrolls up; `<NewMessagePill>`
  surfaces "↓ new message" when streaming arrives off-screen.
- Voice mic button next to the composer fires a `useToast().info("Voice
  input is coming soon")` and documents the SpeechRecognition wiring inline
  for Phase 7.
- Empty state: serif "Hi. I'm Spence." + 4 starter chips when no messages.

**Settings (`/settings`)** — Server Component fans out parallel MCP reads
(`household_read_profile`, `inspire_read_household_signals`,
`chef_status_check`, `household_read_observations`) wrapped in `safe()`,
hands data to per-section client islands. Sections shipped: Profile,
Traditions (Sheet-based add/remove), Equipment (chip grid + custom slug),
Calendar (coming soon), Notifications (cookie-persisted toggles + theme
toggle), Onboarding (engagement summary + re-run + "what Spence knows"
expanded view), Debug (collapsed by default; trait values + dimensions +
observations), About (version + build hash). Edit modes use the
foundation `<Sheet>`.

**Ambient system layer** (`components/system/`): `<ToastProvider>` +
`useToast()` mounted at the root layout (above `<Shell>`); skeleton family
with terracotta-tinted shimmer (`@keyframes shimmer`); `<ErrorBoundary>` at
root layout + framework-level `app/error.tsx` + `app/not-found.tsx`;
`<PullToRefresh>` (touch-only, scrollTop-gated, graceful fallback);
`<ThemeToggle>` with cookie + `data-theme` + paint-blocking
`ThemeBootstrapScript`; `<EmptyState>` for "no data" routes.

**Helpers**: `lib/haptics.ts` (feature-detected `navigator.vibrate` w/
reduced-motion guard), `lib/wake-lock.ts` (visibility-aware screen wake
lock), `lib/markdown.tsx` (single-pass safe renderer).

**About**: `/about` static serif page with version + build hash + GitHub
link (env-driven).

**MCP**: extended `ToolMap` with `household_read_profile`,
`household_update_profile`, `household_read_observations` for settings.

**Storybook**: 7 new story files (TypingIndicator, SuggestedPrompts,
MessageGroup, NewMessagePill, Skeleton, Toast, VoiceInputStub).

## Verification

- `tsc --noEmit` clean (excluding pre-existing untracked shop-state test).
- All 22 vitest tests pass (foundation 3, brigade 6, perishability 8,
  shop-state 5).
- Foundation files untouched.

## Open follow-ups

- `household_read_profile`/`household_update_profile`/
  `household_read_observations` may not exist worker-side yet —
  `safe()` returns `null` and sections render fallbacks until they ship.
- Tailwind v4 `@custom-variant dark` rule is `[data-theme="dark"]` only;
  system-pref dark is handled by raw `@media (prefers-color-scheme: dark)`
  in CSS, so component-level `dark:` utilities only fire when the cookie
  is set. Acceptable for Phase 6.
- Push notifications, Google/iCloud calendar OAuth gated as "coming soon".
