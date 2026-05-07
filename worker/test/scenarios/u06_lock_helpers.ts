// U6 — lock helper round-trips and immutability.
//
// Pure unit tests for the lock primitives. No ledger, no repair, no fixtures —
// just exercise the helpers directly to pin down their contract:
//   - lockEntity / unlockEntity round-trip preserves the rest of the lock
//     metadata bag and toggles only the `locked` flag.
//   - isLocked correctly identifies locked / unlocked / missing-meta cases.
//   - lockMeal returns a NEW plan; the original plan is never mutated.

import type { Scenario } from "../lib/types";
import {
	isLocked,
	lockEntity,
	unlockEntity,
	lockMeal,
	unlockMeal,
	listLockedEntities,
	type LockMeta,
} from "../../src/mise-graph/locks";
import type { MiseWeeklyPlanDraft } from "../../src/mise-graph/planner";

const u06: Scenario = {
	id: "u06",
	name: "lock helpers round-trip and lock plan-level helpers are immutable",
	group: "unit",
	tier: "fast",
	async run(ctx) {
		// --- isLocked --------------------------------------------------------
		ctx.assert.ok(!isLocked(undefined), "undefined meta is not locked");
		ctx.assert.ok(!isLocked(null), "null meta is not locked");
		ctx.assert.ok(!isLocked({ locked: false }), "explicit locked=false is not locked");
		ctx.assert.ok(isLocked({ locked: true }), "locked=true is locked");

		// --- lockEntity ------------------------------------------------------
		const fixedTime = "2026-05-06T12:00:00.000Z";
		const lockMeta = lockEntity(undefined, {
			reason: "user pinned recipe pr_abc",
			by: "user",
			scope: "hard",
			at: fixedTime,
		});
		ctx.assert.eq(lockMeta.locked, true, "lockEntity sets locked=true");
		ctx.assert.eq(lockMeta.lock_reason, "user pinned recipe pr_abc", "lock_reason captured");
		ctx.assert.eq(lockMeta.lock_by, "user", "lock_by captured");
		ctx.assert.eq(lockMeta.lock_scope, "hard", "lock_scope captured");
		ctx.assert.eq(lockMeta.locked_at, fixedTime, "locked_at uses provided timestamp");
		ctx.assert.ok(!!lockMeta.lock_token && lockMeta.lock_token.length > 0, "lock_token generated");

		// Default `by` and `scope`.
		const defaultLock = lockEntity(undefined, { reason: "x", at: fixedTime });
		ctx.assert.eq(defaultLock.lock_by, "user", "default lock_by is 'user'");
		ctx.assert.eq(defaultLock.lock_scope, "hard", "default lock_scope is 'hard'");

		// --- unlockEntity round-trip ----------------------------------------
		const unlocked = unlockEntity(lockMeta);
		ctx.assert.eq(unlocked.locked, false, "unlockEntity flips locked to false");
		ctx.assert.ok(unlocked.lock_reason === undefined, "lock_reason cleared on unlock");
		ctx.assert.ok(unlocked.lock_by === undefined, "lock_by cleared on unlock");
		ctx.assert.ok(unlocked.lock_scope === undefined, "lock_scope cleared on unlock");
		ctx.assert.ok(unlocked.locked_at === undefined, "locked_at cleared on unlock");
		ctx.assert.ok(unlocked.lock_token === undefined, "lock_token cleared on unlock");

		// Re-locking after unlock should produce a comparable shape.
		const relock = lockEntity(unlocked, { reason: "second pin", scope: "soft", at: fixedTime });
		ctx.assert.eq(relock.locked, true, "round-trip: lock again works");
		ctx.assert.eq(relock.lock_scope, "soft", "soft scope honored");

		// --- lockMeal returns a new plan ------------------------------------
		const original = makeMinimalPlan();
		const originalSnapshot = JSON.stringify(original);
		const locked = lockMeal(original, { date: "2026-05-13", slot: "dinner" }, {
			reason: "user pinned",
			by: "user",
			scope: "hard",
			at: fixedTime,
		});

		// Original is unchanged.
		ctx.assert.eq(JSON.stringify(original), originalSnapshot, "lockMeal did not mutate the original plan");

		// Returned plan has the lock on the right meal.
		const wed = locked.meals_by_day[0].meals.find(m => m.slot === "dinner");
		ctx.assert.ok(!!wed, "locked plan still contains the Wed dinner meal");
		const wedLock = (wed!.meta as { lock?: LockMeta } | undefined)?.lock;
		ctx.assert.ok(!!wedLock && wedLock.locked === true, "Wed meal carries lock=true in meta.lock");

		// Other meals untouched.
		const breakfast = locked.meals_by_day[0].meals.find(m => m.slot === "breakfast");
		const breakfastLock = (breakfast?.meta as { lock?: LockMeta } | undefined)?.lock;
		ctx.assert.ok(!breakfastLock || !breakfastLock.locked, "non-targeted meal is not locked");

		// listLockedEntities surfaces it.
		const refs = listLockedEntities(locked);
		ctx.assert.eq(refs.length, 1, "exactly one locked entity in plan");
		ctx.assert.eq(refs[0].type, "Meal", "locked ref classified as Meal");

		// --- unlockMeal round-trip ------------------------------------------
		const reverted = unlockMeal(locked, { date: "2026-05-13", slot: "dinner" });
		const refsAfter = listLockedEntities(reverted);
		ctx.assert.eq(refsAfter.length, 0, "unlockMeal removes the lock");
	},
};

function makeMinimalPlan(): MiseWeeklyPlanDraft {
	return {
		id: "mise_plan:u06",
		household_id: "test",
		title: "Minimal plan for u06",
		start_date: "2026-05-13",
		end_date: "2026-05-13",
		timezone: "UTC",
		people: 2,
		status: "draft",
		constraints: {},
		selected_ingredients: [],
		source_recipe_ids: [],
		meals_by_day: [{
			date: "2026-05-13",
			day_index: 0,
			meals: [
				{
					id: "meal:wed_breakfast",
					date: "2026-05-13",
					slot: "breakfast",
					title: "Wed breakfast",
					format: "yogurt bowl",
					component_ids: [],
					ingredient_names: [],
					source: "test",
					notes: [],
					people: 2,
					cuisine: [],
					locked: false,
				},
				{
					id: "meal:wed_dinner",
					date: "2026-05-13",
					slot: "dinner",
					title: "Wed dinner",
					format: "bowl",
					component_ids: [],
					ingredient_names: [],
					source: "test",
					notes: [],
					people: 2,
					cuisine: [],
					locked: false,
				},
			],
		}],
		component_batches: [],
		prep_tasks: [],
		breakfasts: [],
		snack_boxes: [],
		shopping_list: [],
		shop_runs: [],
		storage_labels: [],
		meta: { generated_by: "mise_graph_planner", deterministic: true },
	};
}

export default u06;
