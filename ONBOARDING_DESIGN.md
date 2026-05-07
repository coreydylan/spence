# Spence Onboarding — Progressive, Adaptive, Personality-Aware

> The chef-of-staff doesn't fill out a form on day 1. It gets to know the household the way a real chef-of-staff would: a few essential questions up front, then careful observation, then deeper questions over weeks and seasons — calibrated to how chatty each person is.

---

## Design tenets

1. **Never block planning on a long form.** Day-1 user gets a meal plan within 2 minutes of saying hi. Everything else is progressive.
2. **The agent earns the right to ask deeper questions.** Surface-level questions on day 1; identity-level questions only after the user has invested time and seen value.
3. **Adapt question density to the user's actual chattiness.** A 3-word-answer user gets fewer, narrower questions; a 3-paragraph-answer user gets follow-ups inline.
4. **Observe more than you ask.** Behavior is the ground truth. Stated preference is hypothesis; eaten meals + skipped meals are evidence. The two converge over time.
5. **Every question references something the user said or did.** "I noticed you've eaten chickpeas 4 times in 2 weeks — constant or phase?" not "Do you like chickpeas?"
6. **No identity quizzes.** No "are you a foodie / a feeder / a fueler?" boxes. The personality dimensions are inferred from real signals, not self-reported labels.

---

## The five depth tiers

### Tier 0 — Existence stub (15 seconds)
Bare minimum to plan a single meal. Triggered by `household_onboarding_start`.

- Household name (or auto-generated)
- Primary member's display name + age group
- Coarse location (city or zip)
- Household size estimate (just adults; kids added later)
- One single question: **"What's the most useful thing I could help with first — meal planning, dinner-tonight ideas, or just getting your pantry organized?"** — sets the agent's first action.

After tier 0 → user can immediately ask for a meal plan. Quality is rough but functional.

---

### Tier 1 — Day-1 essentials (3-5 questions, ~3 min, asked across the first session)
The minimum to plan plausible meals for THIS household.

| # | Question | Stored as |
|---|---|---|
| 1.1 | Who else lives here / eats with you regularly? (names + ages, optional) | `mise_household_members` |
| 1.2 | Anything anyone in the house can't / won't eat? (allergies, hard avoidances, vegetarian, etc.) | per-member `dietary` + `preferences.allergies` |
| 1.3 | When you say "dinner," what does that usually look like — eat at the table, eat in front of the TV, eat at your desk, varies? | `household_profile.dinner_ritual` |
| 1.4 | Do you cook most nights, sometimes, or rarely? | `household_profile.cook_frequency` |
| 1.5 | Pantry: do you want to take 5 min to tell me what's in there, or let me build it as we cook? | `household_profile.pantry_intake_mode` |

**1.3 is the most important question on day 1** — the answer is more about identity than logistics. Eating at the table = the cook signals investment in dinner-as-ritual; eating at the desk = signals refuel-mode. The agent uses this to set the default cook complexity.

---

### Tier 2 — Week-1 calibration (5-8 questions, spread across days 2–7)
The agent has now seen 2-3 actual meal plans. It uses observed behavior to calibrate stated preferences. Surfaced one question per morning brief.

Each question is selected from a bag based on what's MISSING from the agent's model.

| Trigger | Example question |
|---|---|
| User skipped a planned meal | "Mon's mezze didn't get cooked — was it the recipe, the timing, or just not feeling it?" |
| User's plan keeps trending toward one cuisine | "I notice we've leaned hard into Italian — is that a deliberate streak or just the path of least resistance?" |
| Repeated ingredient | "Tofu's shown up 4 times — is firm tofu a constant for you, or is it a phase you're working through?" |
| Equipment never used | "Tell me about your kitchen — do you have a [Dutch oven / instant pot / grill]? I'm avoiding [thing] until I know." |
| First weekend | "What does Saturday morning food look like at your house — pancake ritual, leftovers, just coffee?" |
| First takeout night | "Wed was a takeout night — fine, but is that a once-a-week thing or did something specific happen?" |

After a week of these the agent has data on:
- Active equipment (what's actually used)
- Anchor ingredients (what shows up unprompted)
- Effort tolerance (weeknight 30-min vs Sunday 2hr)
- Skip patterns (what gets cancelled, why)

---

### Tier 3 — Month-1 depth (deeper, opportunistic)
The agent has 4 weeks of meal data. Now questions can be identity-level.

These are surfaced **opportunistically** — usually when the user already raised a related topic. NEVER as a standalone "let's go deeper" prompt.

| Hook | Deeper question |
|---|---|
| User says "I'm tired tonight" | "When you're this kind of tired, what's the food you actually want vs what you usually settle for?" |
| User cancels a planned meal | "Was there a specific meal that would have hit instead, or was tonight a no-cook night no matter what?" |
| User loves a meal | "Tell me about why this one worked — was it the dish, the timing, the prep amount, the leftover potential?" |
| Sunday | "Is there a Sunday meal from when you were growing up that I should keep in rotation?" |
| Holiday approaching | "Do you have your own version of [Thanksgiving / Passover / Lunar New Year], or is it whatever?" |
| Meal looks "perfect on paper" but isn't loved | "When a recipe technically nails the brief but you don't reach for it again — what was missing for you?" |

These reveal the dimensions in the table below.

---

### Tier 4 — Seasonal / life-event recalibration
Re-asked on calendar triggers, not user actions.

| Trigger | Question class |
|---|---|
| Season change | "Summer's coming — anything you want to lean into or avoid? (gazpacho? grill?)" |
| New member | "Got it — a new person joins the table. What do they bring / dislike / love?" |
| Move | "New kitchen — same equipment list or did it change?" |
| Job change | "Your weeknight time may have shifted — should I tighten the cook windows?" |
| Hosting more | "More guests lately — should we default Friday/Sat to higher headcount?" |
| Travel | "Coming back from [trip] — anything you want to keep or ditch from what you ate there?" |

---

## Kitchen personality — the 7 dimensions

These are the dimensions the agent infers (never asks directly). Each is a 0..1 scalar, with a confidence band that tightens over time.

| Dimension | Low end | High end | Inferred from |
|---|---|---|---|
| `precision_vs_improvisation` | follows recipes exactly | "I'll figure it out" | recipe lookups, sub requests, deviation patterns |
| `ritual_vs_refueling` | dinner is a moment | dinner is a refuel | tier 1.3 answer, eat-at-table signal, cook duration tolerance |
| `comfort_vs_adventure` | same 10 dishes | always something new | repeat-rate of dishes, novelty acceptance |
| `solo_cook_vs_social_cook` | cooking is alone time | cooking is together time | who's-eating-with-you patterns, brigade-mode adoption |
| `quick_vs_project` | weeknight 20-min rule | no time pressure | active-cook-min tolerance, weekend vs weekday split |
| `pantry_first_vs_shop_fresh` | plan from what's there | plan from market | shop-frequency, pantry-utilization rate |
| `equipment_rich_vs_minimalist` | 30+ gadgets | one knife, one pan | equipment.length, format diversity |

**These dimensions feed back into:**
- Default cook_active_min thresholds (high precision = more buffer)
- Recipe vs concept prompts in compose (improvisation = "make a bowl with..."; precision = "use this recipe")
- Equipment claim aggressiveness (minimalist = warn earlier on conflicts)
- Format diversity targets (comfort = OK with repeats; adventure = penalize)

---

## Chattiness adaptation

Each user's response history feeds an `engagement_signal` that scales question density.

```
engagement_signal = clamp(0.5..2.0,
  (avg_response_chars_last_5 / 60)
  × (response_rate_last_10 / 0.7)        # how often they answer at all
  × (1 - cooldown_decay_factor)           # damp if just answered
)
```

- **Chatty (signal ≥ 1.4)**: Asks up to 2 questions per brief, accepts long-form responses, uses follow-up probes inline.
- **Default (0.7–1.4)**: One question per brief, no follow-ups unless explicitly invited.
- **Terse (< 0.7)**: One question per WEEK, narrower forced-choice style ("A or B?").
- **Skipper (response_rate < 0.2)**: Stops asking. Falls back to inferred-only mode for 4 weeks, then re-tries with a fresh hook.

---

## Storage model — new tables

```sql
-- Onboarding state machine per household
CREATE TABLE mise_onboarding_state (
  household_id TEXT PRIMARY KEY,
  current_tier INTEGER NOT NULL DEFAULT 0,
  tier_0_completed_at TEXT,
  tier_1_completed_at TEXT,
  tier_2_completed_at TEXT,
  tier_3_completed_at TEXT,
  active_question_bag_json TEXT,         -- queued questions waiting for a slot
  engagement_signal REAL DEFAULT 1.0,    -- chattiness, recomputed nightly
  last_question_asked_at TEXT,
  questions_asked_count INTEGER DEFAULT 0,
  questions_answered_count INTEGER DEFAULT 0,
  questions_skipped_count INTEGER DEFAULT 0,
  updated_at_ms INTEGER NOT NULL
);

-- Append-only log of every question + response
CREATE TABLE mise_onboarding_responses (
  response_id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL,
  member_id TEXT,
  question_kind TEXT NOT NULL,           -- e.g. 'dinner_ritual', 'tofu_anchor_check'
  question_text TEXT NOT NULL,
  response_text TEXT,                    -- null if skipped
  response_chars INTEGER,                -- for engagement signal
  asked_at_ms INTEGER NOT NULL,
  answered_at_ms INTEGER,
  inferred_traits_json TEXT,             -- what the agent extracted from the answer
  tier INTEGER NOT NULL
);
CREATE INDEX ix_onboarding_responses_household ON mise_onboarding_responses(household_id, asked_at_ms DESC);

-- Derived personality dimensions, with confidence
CREATE TABLE mise_household_traits (
  household_id TEXT NOT NULL,
  trait_name TEXT NOT NULL,              -- one of the 7 dimensions
  trait_value REAL NOT NULL,             -- 0..1
  confidence REAL NOT NULL,              -- 0..1, grows with evidence
  last_evidence_at_ms INTEGER NOT NULL,
  evidence_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (household_id, trait_name)
);

-- Traditions / standing meals (Sunday roast, Friday pizza, etc.)
CREATE TABLE mise_household_traditions (
  tradition_id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL,
  name TEXT NOT NULL,
  cadence TEXT NOT NULL,                 -- 'weekly:friday' | 'monthly:1st-saturday' | 'seasonal:fall' | etc.
  description TEXT,
  must_include_ingredients_json TEXT,
  must_include_format TEXT,
  origin_note TEXT,                      -- 'grew up with mom's', 'started 2024'
  active INTEGER NOT NULL DEFAULT 1,
  created_at_ms INTEGER NOT NULL
);
```

The existing `mise_household_profiles` gets new columns:
- `dinner_ritual TEXT` (table | tv | desk | varies)
- `cook_frequency TEXT` (most | sometimes | rarely)
- `pantry_intake_mode TEXT` (bulk | gradual | photo)

---

## MCP tools — onboarding surface

| Tool | Use |
|---|---|
| `household_onboarding_start` | Begin tier 0; returns first question. Idempotent. |
| `household_onboarding_status` | Tier %, next question preview, traits-with-confidence, engagement signal |
| `household_onboarding_answer` | Record answer; agent extracts inferred traits, advances state, returns next question OR null if quota for this session is satisfied |
| `household_onboarding_skip` | Record skip; no penalty; question may resurface later |
| `household_set_pantry_bulk` | One-shot inventory paste — accepts free text, auto-categorizes |
| `household_set_equipment_bulk` | One-shot equipment list — single tool call replaces the trickle-discover-as-you-cook model |
| `household_set_traditions` | Add/remove standing meals |
| `household_observe_response` | Agent calls this from inside other tools when it overhears a fact ("user mentioned they don't have a grill" during compose) — writes a synthetic onboarding_response so the trait inference engine sees it |
| `household_get_traits` | Returns the 7 dimensions with confidences — fed into compose context |

---

## Behavioral observation pipeline (the implicit half)

The agent learns more from what the user *does* than from what they *say*. Observations land in `mise_onboarding_responses` with `question_kind = "_observed"` and a synthetic question_text describing the inference.

| Observation | Trait update |
|---|---|
| Meal cancelled within 2h of cook_window | `quick_vs_project` ↑ (more time-pressured than they said) |
| Same recipe accepted 3 weeks running | `comfort_vs_adventure` ↓ |
| Sub-request: "swap olive oil for ghee" | `precision_vs_improvisation` ↑ on improvisation side |
| Brigade mode used | `solo_cook_vs_social_cook` ↑ on social side |
| Pantry stays >75% used between shops | `pantry_first_vs_shop_fresh` ↑ on pantry side |

Trait values update as a Bayesian-ish moving average:
```
new_value = (old_value × old_confidence + observed_signal × evidence_weight) / (old_confidence + evidence_weight)
new_confidence = min(1, old_confidence + evidence_weight × decay_factor)
```

---

## Daily question scheduler — the "one question per morning brief" pattern

Every morning the HouseholdAgent's brief picks one question from the active bag.

```
score(question) =
  tier_weight[question.tier]                    # 0:1.0  1:0.8  2:0.5  3:0.3  4:0.4
  × hook_match_bonus                            # 1.0 default; 1.5 if related to recent activity
  × novelty_decay(question, last_asked)         # 0..1, low if asked recently
  × question_kind_priority                      # dietary > equipment > tradition > personality
```

Multiplied by the engagement_signal, then top-scored is surfaced. If `score < 0.3` for all, **don't ask anything** — just brief the day.

---

## Open design questions (for you to weigh in)

1. **Is the dinner_ritual question the right "tier 1 identity probe," or do you have a different one in mind?**
   - Alternates: "What's a weeknight dinner you've never gotten tired of?" / "If I had to cook for you blindfolded, what's the dish I should NOT make?"

2. **Should pantry intake be by photo (Vision API) by default, or text paste?**
   - Photo would lean on the existing bridge-vision module; text paste is faster but less rich.

3. **How aggressive is "skipper" detection — 2 skips in a row, 5 in a row, or some smarter signal?**
   - Risk: too aggressive and we lose users who are just busy that week.

4. **Should the 7 dimensions be visible to the user?**
   - "Here's what I think your kitchen personality is — am I close?" could be a delightful tier-3 reveal.
   - Or it could feel creepy / over-systematized.

5. **Where do household traditions intersect with calendar?**
   - "Friday pizza night" — should the agent enforce it (always plan pizza Friday) or treat it as a strong default with override?

6. **Multi-member tension** — what if Corey's `comfort_vs_adventure` is 0.2 and Katrina's is 0.8?
   - Average it? Negotiate per-meal? Alternate?

---

## Implementation phases (when you greenlight)

**Phase A — Schema + tier 0 + tier 1**
- 3 new tables (state, responses, traits)
- 4 MCP tools (start, answer, skip, status)
- Day-1 path is fully usable

**Phase B — Bulk intake tools + trait inference**
- `household_set_pantry_bulk` (text + photo via bridge-vision)
- `household_set_equipment_bulk`
- Trait inference engine (the Bayesian update)
- Backfill traits from existing meal history

**Phase C — Daily scheduler + observation pipeline**
- HouseholdAgent's morning brief picks a question
- `household_observe_response` hooks into compose / cancel / mark-eaten paths
- Engagement signal computation

**Phase D — Tier 3 + tier 4 + chattiness adaptation**
- Hook-matched deeper questions
- Seasonal triggers
- Multi-member tension resolution
