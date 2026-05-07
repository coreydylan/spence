# Spence Frontend — Phase 2 Report (Onboarding Wizard)

Full-screen guided wizard at `/onboarding`. Drop-in over the Phase 1 shell:
the `app/onboarding/layout.tsx` mounts a `fixed inset-0 z-50` canvas with the
warm `onboarding-bg` gradient so the chef wordmark + tab bar are hidden while
the user is being interviewed. ONE question per screen, big serif typography,
sticky bottom CTA, slide-in animation per step (CSS `@keyframes step-slide`,
honors `prefers-reduced-motion`).

## Step list → MCP tool

| # | Step id | MCP tool | question_kind |
|---|---|---|---|
| 1 | household_name | household_onboarding_answer | tier_0_household_name |
| 2 | primary_member | household_onboarding_answer | tier_0_primary_member |
| 3 | location | household_onboarding_answer | tier_0_location |
| 4 | size | household_onboarding_answer | tier_0_size |
| 5 | first_help | household_onboarding_answer | tier_0_first_help |
| 6 | members_roster | household_onboarding_answer | tier_1_members_roster |
| 7 | avoidances | household_onboarding_answer | tier_1_avoidances |
| 8 | dinner_ritual | household_onboarding_answer | tier_1_dinner_ritual |
| 9 | cook_frequency | household_onboarding_answer | tier_1_cook_frequency |
| 10 | pantry_intake | household_onboarding_answer | tier_1_pantry_intake |
| 11 | pantry_paste (cond) | household_set_pantry_bulk | — |
| 12 | equipment_grid | household_set_equipment_bulk | — |
| 13 | traditions | household_set_traditions | — |
| 14 | final | (router → /chat) | — |

Step 11 only renders when step 10 = "bulk" (predicate-driven via
`StepDef.skipIf` in `lib/onboarding-flow.ts`).

## Resume-from-mid-flow

On mount, the wizard fires `mcpClient("chef_status_check")` and:
- if `tier_0_done && tier_1_done` → `router.replace("/chat")`,
- else maps `recommendation.next_question.kind` → step id via
  `stepFromQuestionKind()` and lands the user there.

Local-storage (`spence.onboarding.state.v1`) persists answers + last cursor so
even a fresh device with no worker state can resume. After every successful
`household_onboarding_answer`, the wizard re-runs `chef_status_check` to pick
up the worker's next `question_id` (used as the answer's `question_id`).

## Visual treatment

- `BigQuestion` — serif eyebrow / 3xl–4xl serif headline / sans subhead.
- `CardChoice` — 80px-min tappable card, sage outline + checkmark on select.
- `ProgressDots` — three grouped clusters (5 / 5 / 3); active dot widens.
- `StepShell` — back top-left, optional skip top-right, sticky CTA bottom
  with cream-fade gradient. Animation re-runs per `animationKey` change.
- All MCP calls go through `lib/mcp.ts` `mcpClient` (POST /api/mcp-proxy).

## Storybook coverage

15 stories across `web/stories/onboarding/`: HouseholdName, PrimaryMember,
Location, Size, FirstHelp, MembersRoster, Avoidances, DinnerRitual,
CookFrequency, PantryIntake, PantryPaste, EquipmentGrid, Traditions, Final,
ProgressDots — each with empty + filled states.

## Tool-renderer hookup

`lib/tool-renderers.ts` `pickUiFromToolResult()` now surfaces an inline
`OnboardingQuestionCard` for `chef_status_check`, `household_onboarding_start`
and `household_onboarding_answer` results — so chat-driven onboarding shows
the same card as the wizard.

## Open polish items

- Pre-existing `lib/markdown.ts` (parallel agent, not mine) has TS errors
  blocking a clean `tsc --noEmit`; my files are clean.
- No framer-motion installed; using CSS keyframes. Smooth on Pixel 4a in
  hand-test.
- Photo-pantry path stubbed (button reachable but only shows the choice;
  Vision-API capture is Phase 3).
- Reverse-geocode for the location step is deferred; we send raw coords.
