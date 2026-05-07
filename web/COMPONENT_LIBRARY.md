# Spence Component Library

Reference for the parallel screen agents building Phase 2+. Every primitive
listed here is shipped, type-clean, and Storybook-able. If you need a new
primitive, add it under `components/primitives/` with the same conventions —
`forwardRef` + `cn()` for className composition + Tailwind-only styles.

## Design tokens

Defined in `app/globals.css` `@theme` block; mirrored in TS via
`lib/design-tokens.ts`. Use Tailwind utilities (`bg-terracotta`, `font-serif`,
`rounded-[var(--radius-md)]`) — don't reach for the TS mirror unless you
need a raw value (SVG fills, animated charts, etc.).

| Token | Hex | Use |
|---|---|---|
| `terracotta` | `#E07856` | primary CTAs, Spence's avatar, single-choice "selected" |
| `cream` | `#F8F3EC` | global background |
| `cream-deep` | `#EFE7DA` | secondary surfaces, muted chips |
| `ink` | `#2A1E15` | headings, body text |
| `ink-soft` | `#5C4A3D` | secondary text |
| `sage` | `#3F6E4A` | "active"/"done" states, secondary CTAs |
| `amber` | `#C8893A` | preference warnings, soft alerts |

Type families: `font-sans` (Inter), `font-serif` (Source Serif 4),
`font-mono` (Fira Code, used only for trait values + tool names).

Radii: `rounded-[var(--radius-sm)]` (8), `--radius-md` (12), `--radius-lg`
(24), `--radius-full` (pill).

Shadows: `shadow-[var(--shadow-soft)]` (default), `shadow-[var(--shadow-card)]`
(raised hero cards).

## Primitives

### `<Button>` — `components/primitives/button.tsx`

```tsx
<Button variant="primary" size="lg" onClick={…}>Send</Button>
```

| Prop | Type | Default |
|---|---|---|
| `variant` | `"primary" \| "secondary" \| "ghost" \| "outline"` | `"primary"` |
| `size` | `"sm" \| "md" \| "lg"` | `"md"` |
| `loading` | `boolean` | `false` (shows spinner + disables) |
| `disabled` | `boolean` | inherited |

`primary` = terracotta (one per screen), `secondary` = sage, `ghost` =
text-only, `outline` = bordered.

### `<Card>` family — `components/primitives/card.tsx`

```tsx
<Card variant="raised">
  <CardHeader><CardTitle>…</CardTitle><CardSubtitle>…</CardSubtitle></CardHeader>
  <CardContent>…</CardContent>
  <CardFooter>…</CardFooter>
</Card>
```

| Prop | Type | Default |
|---|---|---|
| `variant` | `"default" \| "raised" \| "muted"` | `"default"` |

`default` = white-tinted with soft shadow; `raised` = full white with card
shadow (used for hero meal cards); `muted` = flat cream-deep panel.

### `<Input>` / `<Textarea>` — `components/primitives/input.tsx`

Drop-in replacements for `<input>` / `<textarea>`. Same prop surface,
opinionated styles. Use `<Textarea>` for the chef chat composer or any
multi-line answer.

### `<Chip>` — `components/primitives/chip.tsx`

```tsx
<Chip variant="selected" onClick={…}>vegetarian</Chip>
```

| Prop | Type | Default |
|---|---|---|
| `variant` | `"default" \| "selected" \| "muted" \| "warning" \| "active"` | `"default"` |

Use for selectable tokens (onboarding answer chips, ingredient chips,
equipment chips). For non-interactive labels, prefer `<Badge>`.

### `<Badge>` — `components/primitives/badge.tsx`

Static label. Pill-shaped. Use for cuisine tags, format pills, "serves N".

| Prop | Type | Default |
|---|---|---|
| `tone` | `"neutral" \| "terracotta" \| "sage" \| "amber" \| "ink"` | `"neutral"` |

### `<Sheet>` — `components/primitives/sheet.tsx`

Bottom drawer (mobile) / right drawer (desktop). Phase 1 implementation is
intentionally tiny — no focus trap, no portal. Phase 2 agents should swap to
Radix Dialog if accessibility-critical surfaces (cook mode, deep config) need
it.

```tsx
<Sheet open={open} onClose={() => setOpen(false)} side="bottom">
  …
</Sheet>
```

## Layout

### `<Shell>` — `components/layout/shell.tsx`

Wraps every page. Top bar (Spence wordmark) + main + `<TabBar>`. Already
applied at `app/layout.tsx`. Don't re-wrap from individual routes.

### `<TabBar>` — `components/layout/tab-bar.tsx`

Bottom-mobile nav, hidden on `md`+. Five tabs: Today / Plan / Chat / Shop /
More. Highlights the active route via `usePathname()`.

### `<ComingSoon>` — `components/layout/coming-soon.tsx`

Placeholder for unbuilt routes. Replace `app/<route>/page.tsx` with your
real screen when you ship it.

## Chef / chat-surface components

### `<ChefBubble>` — `components/chef/chef-bubble.tsx`

Left-aligned bubble for Spence's replies. Has the terracotta `S` avatar.
Compose with text + tool-call chips + UI components as children.

```tsx
<ChefBubble typing={false}>
  <ToolCallChip toolName="plan_compose_meal" status="running" />
  <p>Tonight is donburi night.</p>
  <MealCard meal={meal} />
</ChefBubble>
```

### `<UserBubble>` — `components/chef/user-bubble.tsx`

Right-aligned, ink-on-cream, no avatar. Whitespace-pre-wrap by default so
multi-line user input renders correctly.

### `<ToolCallChip>` — `components/chef/tool-call-chip.tsx`

Inline pill that shows tool-call state.

| Prop | Type | Default |
|---|---|---|
| `toolName` | `string` (e.g. `"plan_compose_meal"`) | required |
| `status` | `"running" \| "done" \| "error"` | required |

The chip humanizes tool names via a small lookup (extend
`TOOL_LABELS` for new tools). Running shows a spinner, done shows a sage dot,
error shows an amber dot.

### `<ChefInput>` — `components/chef/chef-input.tsx`

Auto-growing textarea + Send button. Submits on Enter (Shift+Enter for
newline). The mic-button slot is reserved for Phase 6 voice mode.

```tsx
<ChefInput onSubmit={handleSubmit} disabled={busy} />
```

### `<OnboardingQuestionCard>` — `components/chef/onboarding-question-card.tsx`

Renders the question shape returned by `chef_status_check.recommendation
.next_question`. Accepts both worker shape (`{kind, question_text, choices?}`)
and the leaner `{prompt, choices?}` shape.

```tsx
<OnboardingQuestionCard
  question={status.recommendation.next_question}
  onAnswer={({ question_id, answer }) => submitAnswer(question_id, answer)}
/>
```

Phase 2's `/onboarding` route will lift this into a full-screen flow with
animated transitions; for now it renders inline in the chat as the chef-agent
loop's primary "you're blocked" surface.

## Meal components

### `<MealCard>` — `components/meal/meal-card.tsx`

The canonical "this is a meal" surface. Uses `meal.photo_url` if present,
otherwise derives a gradient from `meal.format`.

| Prop | Type | Default |
|---|---|---|
| `meal` | `Meal` (loose-typed) | required |
| `variant` | `"compact" \| "hero"` | `"compact"` |
| `onOpen` | `(mealId: string) => void` | — |

`compact` = chat inline, 24px header gradient. `hero` = recipe page header,
56px photo. Tap → `onOpen(meal.id)`.

## Adding a new tool result renderer

When your agent introduces a new tool whose result deserves a UI component
instead of JSON:

1. Add the component under `components/<area>/`.
2. Extend the `UiComponent` union in `lib/chef-agent.ts`:
   ```ts
   | { component: "shopping_list", props: { list: unknown } }
   ```
3. Wire it in `lib/tool-renderers.ts` `REGISTRY`.
4. Have the agent loop `pickUiComponent(toolName, result)` map your tool to
   the new component.
5. Add a Storybook story under `stories/`.

That's the full extension surface — no global registry, no DI.
