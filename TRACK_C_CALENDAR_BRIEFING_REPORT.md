# Track C — Calendar conflict awareness in pre_eve briefing

## Files modified

- `worker/src/mise-graph/agents/meal-phase-handlers.ts` — added `CalendarBlock` type-only import and extended `pre_eve_entry`'s body. Added in-module helpers `computeCalendarConflict`, `buildConflictSummary`, and `parseLocalIsoToMs`. No exports added. Other handlers (`day_of_entry`, `cook_window_entry`, etc.) and existing imports left intact for Track D coordination.
- `worker/test/scenarios/u83_pre_eve_calendar_briefing.ts` — new ~145-line pure unit test, three cases (cook overlap, clean cal, eat-only overlap).

## Conflict-detection logic

For each calendar busy block on the meal date, parse start/end with the same local-clock convention `defaultWindowsForSlot` uses (UTC-anchored ms), then test overlap against `cook_window_start..end_ms` and `eat_window_start..end_ms`. Flags:

- `cook_window_conflict` — any busy block overlaps the cook interval.
- `eat_window_conflict` — any busy block overlaps the eat interval.
- `cook_window_tight` — partial overlap leaves the largest contiguous free slice inside the cook window below `max(60min, half-window-span)` but > 0 (full block ≠ tight).

Briefing payload gains: `calendar_busy_blocks_json`, `cook_window_conflict`, `eat_window_conflict`, `cook_window_tight`, `conflict_summary` (e.g. "17:30 Standup overlaps cook window" or "no conflicts"). When any conflict exists, one `calendar_conflict` notification per adult is emitted via the existing `result.notifications` channel — `meal-agent.applyHandlerResult` already inserts those into `mise_member_notifications`.

## Schema choice — Option C (payload-only)

Neither A (ALTER TABLE) nor B (edit schema). All conflict fields live inside `payload_json`. Rationale: `meal-agent.ts` is owned by Track B and its `insertBriefing` only writes the existing 7 columns — new columns wouldn't be persisted. The briefing's `payload_json` is the canonical kind-specific store; downstream readers already parse it (matches `day_of`/`cook_window` patterns). Zero schema migration risk, zero Track-coordination drift.

## Results

- u83 — 18/18 assertions pass
- Full suite — 102/102 pass (u42 unchanged contract)
- `npx tsc --noEmit` — clean
- `wrangler deploy --dry-run --config wrangler.mise.toml` — clean
- No new top-level deps
