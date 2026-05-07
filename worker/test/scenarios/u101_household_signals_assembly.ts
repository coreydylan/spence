// U101 — Household signals assembly (LLM compose context wiring).
//
// Confirms `buildHouseholdSignals` aggregates onboarding-collected state
// (traits, traditions, pantry, equipment, member dietary/preferences) into
// the compact bundle the LLM compose pipeline consumes:
//
//   * personality.summary — natural-language sentence from the 7 dimensions,
//     skipping under-evidenced traits (confidence < 0.15) and falling back
//     to a "still calibrating" stub when nothing is decisive.
//   * traditions — Friday + Sunday rituals round-trip with cadence.
//   * pantry_top — items grouped by category (pantry/produce/protein/...),
//     capped per category.
//   * equipment_available — slug list for the household.
//   * avoidances — dietary + allergies + dislikes merged across members.
//   * member_spread_guidance — null when aligned/uncalibrated, populated
//     description when 2+ members diverge on a trait.
//
// Also exercises the inspire_read_household_signals MCP dispatch.

import type { Scenario } from "../lib/types";
import { createMockD1 } from "../lib/mock-d1";
import { migrateHouseholdMemorySchema } from "../../src/mise-graph/admin-household-memory";
import { migrateOnboardingSchema } from "../../src/mise-graph/schemas/migrations";
import { migrateEquipmentSchema, ensureEquipmentDefined } from "../../src/mise-graph/equipment";
import { addItem } from "../../src/mise-graph/kitchen-inventory";
import { upsertMember } from "../../src/mise-graph/household-members";
import { setTraditions } from "../../src/mise-graph/onboarding-bulk";
import { buildHouseholdSignals, renderPersonalitySummary } from "../../src/mise-graph/household-signals";
import { handlePlanWorldJsonRpc } from "../../src/mise-graph/plan-world-mcp";
import type { MiseGraphEnv } from "../../src/mise-graph/types";
import type { TraitView } from "../../src/mise-graph/onboarding-traits";

const u101: Scenario = {
	id: "u101",
	name: "Household signals assembly: personality + traditions + pantry + equipment + avoidances + spread guidance",
	group: "unit",
	tier: "fast",
	async run(ctx) {
		const db = createMockD1();
		const env = { DB: db as unknown as D1Database } as MiseGraphEnv;
		await migrateHouseholdMemorySchema(env);
		await migrateOnboardingSchema(env);
		await migrateEquipmentSchema(env);

		const hh = "hh_u101";
		const now = Date.now();
		const today = new Date(now).toISOString().slice(0, 10);

		// 1. Two adult members — Corey is vegetarian, Katrina has a peanut allergy
		// and dislikes cilantro. Avoidances aggregator should de-dupe + sort.
		await upsertMember(env, {
			household_id: hh,
			display_name: "Corey",
			age_group: "adult",
			dietary: ["vegetarian"],
			preferences: { loves: [], dislikes: [], allergies: [] },
		});
		await upsertMember(env, {
			household_id: hh,
			display_name: "Katrina",
			age_group: "adult",
			dietary: ["vegetarian"],   // overlap — should de-dupe to ["vegetarian"]
			preferences: { loves: [], dislikes: ["cilantro"], allergies: ["peanut"] },
		});

		// 2. Two traditions — Friday pizza + Sunday slow dinner.
		const tradResult = await setTraditions(env, {
			household_id: hh,
			traditions: [
				{ name: "Friday Pizza Night", cadence: "weekly:friday", description: "homemade pies", must_include_ingredients: ["mozzarella"] },
				{ name: "Sunday Slow Dinner", cadence: "weekly:sunday", description: "long braises" },
			],
		});
		ctx.assert.eq(tradResult.traditions_set, 2, "two traditions persisted");

		// 3. Eight pantry items spanning multiple categories.
		const pantryItems = [
			"chickpeas",       // protein
			"olive oil",       // pantry
			"tahini",          // pantry
			"cumin",           // pantry
			"red lentils",     // protein
			"garlic",          // produce
			"lemon",           // fruit
			"feta",            // dairy
		];
		for (const name of pantryItems) {
			await addItem(env, {
				household_id: hh,
				canonical_name: name,
				qty: null,
				unit: null,
				storage: null,
				acquired_at: today,
				expires_at: null,
				source: "test",
				notes: null,
			});
		}

		// 4. Five equipment slugs.
		for (const slug of ["dutch_oven", "instant_pot", "cast_iron_skillet", "stand_mixer", "sheet_pan"]) {
			await ensureEquipmentDefined(env, hh, slug);
		}

		// 5. One settled trait (high-confidence ritual lean).
		await env.DB.prepare(
			`INSERT OR REPLACE INTO mise_household_traits
				(household_id, trait_name, member_id, trait_value, confidence, last_evidence_at_ms, evidence_count)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		).bind(hh, "ritual_vs_refueling", "", 0.18, 0.55, now, 4).run();

		// ── Build signals ────────────────────────────────────────────────────
		const signals = await buildHouseholdSignals(env, hh);

		// Shape sanity.
		ctx.assert.eq(signals.household_id, hh, "echoes household_id");
		ctx.assert.gt(signals.generated_at_ms, 0, "stamped");

		// Personality.
		ctx.assert.eq(signals.personality.dimensions.length, 7, "all 7 trait dimensions present (defaults filled)");
		const ritualDim = signals.personality.dimensions.find(d => d.trait_name === "ritual_vs_refueling");
		ctx.assert.ok(!!ritualDim, "ritual dimension surfaced");
		ctx.assert.contains(ritualDim!.label, "ritual", "label names the ritual lean");
		ctx.assert.gt(ritualDim!.confidence, 0.5, "confidence carried through");
		ctx.assert.contains(signals.personality.summary, "ritual", "summary mentions ritual when value < 0.3 with confidence > 0.15");

		// Traditions.
		ctx.assert.eq(signals.traditions.length, 2, "both traditions present");
		const friday = signals.traditions.find(t => t.cadence === "weekly:friday");
		const sunday = signals.traditions.find(t => t.cadence === "weekly:sunday");
		ctx.assert.ok(!!friday, "Friday tradition present");
		ctx.assert.ok(!!sunday, "Sunday tradition present");
		ctx.assert.contains(friday!.must_include ?? [], "mozzarella", "tradition must_include round-trips");

		// Pantry top — grouped by category, items present.
		ctx.assert.gt(signals.pantry_top.length, 0, "pantry_top has groups");
		const allItems = signals.pantry_top.flatMap(g => g.items);
		ctx.assert.contains(allItems, "chickpeas", "chickpeas in pantry_top");
		ctx.assert.contains(allItems, "olive oil", "olive oil in pantry_top");
		ctx.assert.contains(allItems, "garlic", "garlic in pantry_top");
		ctx.assert.contains(allItems, "lemon", "lemon in pantry_top");
		const categories = signals.pantry_top.map(g => g.category);
		ctx.assert.contains(categories, "pantry", "pantry category present");
		ctx.assert.contains(categories, "produce", "produce category present");
		ctx.assert.contains(categories, "protein", "protein category present");
		ctx.assert.contains(categories, "dairy", "dairy category present");

		// Equipment.
		ctx.assert.eq(signals.equipment_available.length, 5, "all 5 equipment slugs returned");
		ctx.assert.contains(signals.equipment_available, "dutch_oven", "dutch_oven listed");
		ctx.assert.contains(signals.equipment_available, "instant_pot", "instant_pot listed");
		ctx.assert.contains(signals.equipment_available, "cast_iron_skillet", "cast_iron_skillet listed");

		// Avoidances — vegetarian de-duped, peanut + cilantro present.
		ctx.assert.eq(signals.avoidances.dietary.length, 1, "vegetarian de-duped across two members");
		ctx.assert.contains(signals.avoidances.dietary, "vegetarian", "vegetarian retained");
		ctx.assert.contains(signals.avoidances.allergies, "peanut", "Katrina's allergy aggregated");
		ctx.assert.contains(signals.avoidances.dislikes, "cilantro", "Katrina's dislike aggregated");

		// Member spread guidance — no member-level traits yet, so null.
		ctx.assert.eq(signals.member_spread_guidance, null, "no diverging traits → null");

		// ── Member spread DIVERGING case ──────────────────────────────────────
		// Inject per-member rows (Corey lean comfort, Katrina lean adventure).
		const tables = (db as unknown as { __tables: () => Map<string, { rows: Map<string, Record<string, unknown>>; insertion_order: string[] }> }).__tables();
		const traitTable = tables.get("mise_household_traits");
		if (!traitTable) throw new Error("traits table missing");
		const coreyKey = `${hh}|comfort_vs_adventure|corey`;
		const katrinaKey = `${hh}|comfort_vs_adventure|katrina`;
		traitTable.rows.set(coreyKey, {
			household_id: hh,
			trait_name: "comfort_vs_adventure",
			member_id: "corey",
			trait_value: 0.2,
			confidence: 0.7,
			last_evidence_at_ms: now,
			evidence_count: 5,
		});
		traitTable.insertion_order.push(coreyKey);
		traitTable.rows.set(katrinaKey, {
			household_id: hh,
			trait_name: "comfort_vs_adventure",
			member_id: "katrina",
			trait_value: 0.85,
			confidence: 0.7,
			last_evidence_at_ms: now,
			evidence_count: 5,
		});
		traitTable.insertion_order.push(katrinaKey);

		// Look up member IDs that upsertMember wrote so the names render.
		const memberRows = await env.DB.prepare(
			`SELECT member_id, display_name FROM mise_household_members WHERE household_id = ?`,
		).bind(hh).all<{ member_id: string; display_name: string }>();
		// Replace synthetic rows with member IDs that match real members so the
		// description reads "Corey leans …, Katrina leans …".
		traitTable.rows.delete(coreyKey);
		traitTable.rows.delete(katrinaKey);
		const coreyId = (memberRows.results || []).find(r => r.display_name === "Corey")?.member_id;
		const katrinaId = (memberRows.results || []).find(r => r.display_name === "Katrina")?.member_id;
		ctx.assert.ok(!!coreyId, "Corey member_id resolved");
		ctx.assert.ok(!!katrinaId, "Katrina member_id resolved");
		const newCoreyKey = `${hh}|comfort_vs_adventure|${coreyId}`;
		const newKatrinaKey = `${hh}|comfort_vs_adventure|${katrinaId}`;
		traitTable.rows.set(newCoreyKey, {
			household_id: hh,
			trait_name: "comfort_vs_adventure",
			member_id: coreyId,
			trait_value: 0.2,
			confidence: 0.7,
			last_evidence_at_ms: now,
			evidence_count: 5,
		});
		traitTable.insertion_order.push(newCoreyKey);
		traitTable.rows.set(newKatrinaKey, {
			household_id: hh,
			trait_name: "comfort_vs_adventure",
			member_id: katrinaId,
			trait_value: 0.85,
			confidence: 0.7,
			last_evidence_at_ms: now,
			evidence_count: 5,
		});
		traitTable.insertion_order.push(newKatrinaKey);

		const signalsDiverge = await buildHouseholdSignals(env, hh);
		ctx.assert.ok(signalsDiverge.member_spread_guidance !== null, "diverging traits → guidance populated");
		ctx.assert.contains(signalsDiverge.member_spread_guidance!, "Corey", "guidance names Corey");
		ctx.assert.contains(signalsDiverge.member_spread_guidance!, "Katrina", "guidance names Katrina");

		// ── Pure render rules for personality.summary ─────────────────────────
		// All defaults → "no personality signal yet."
		const blank: TraitView[] = [
			{ trait_name: "precision_vs_improvisation", value: 0.5, confidence: 0, evidence_count: 0, last_evidence_at_ms: 0 },
			{ trait_name: "ritual_vs_refueling", value: 0.5, confidence: 0, evidence_count: 0, last_evidence_at_ms: 0 },
			{ trait_name: "comfort_vs_adventure", value: 0.5, confidence: 0, evidence_count: 0, last_evidence_at_ms: 0 },
			{ trait_name: "solo_cook_vs_social_cook", value: 0.5, confidence: 0, evidence_count: 0, last_evidence_at_ms: 0 },
			{ trait_name: "quick_vs_project", value: 0.5, confidence: 0, evidence_count: 0, last_evidence_at_ms: 0 },
			{ trait_name: "pantry_first_vs_shop_fresh", value: 0.5, confidence: 0, evidence_count: 0, last_evidence_at_ms: 0 },
			{ trait_name: "equipment_rich_vs_minimalist", value: 0.5, confidence: 0, evidence_count: 0, last_evidence_at_ms: 0 },
		];
		const blankSummary = renderPersonalitySummary(blank);
		ctx.assert.contains(blankSummary, "calibrating", "blank traits → 'calibrating' stub");

		// Multiple decisive traits → adjective list + tail clause.
		const decisive: TraitView[] = blank.map(t => ({ ...t }));
		decisive[0] = { ...decisive[0], value: 0.15, confidence: 0.6 };  // precise
		decisive[2] = { ...decisive[2], value: 0.85, confidence: 0.5 };  // adventurous
		decisive[4] = { ...decisive[4], value: 0.18, confidence: 0.45 }; // quick-cook
		const decisiveSummary = renderPersonalitySummary(decisive);
		ctx.assert.contains(decisiveSummary, "precise", "decisive summary lists 'precise'");
		ctx.assert.contains(decisiveSummary, "adventurous", "decisive summary lists 'adventurous'");
		ctx.assert.matches(decisiveSummary, /quick/i, "decisive summary mentions quick-cook lean");

		// Low-confidence-only → preliminary fallback.
		const prelim: TraitView[] = blank.map(t => ({ ...t }));
		prelim[1] = { ...prelim[1], value: 0.2, confidence: 0.05 }; // ritual but low conf
		const prelimSummary = renderPersonalitySummary(prelim);
		ctx.assert.contains(prelimSummary.toLowerCase(), "calibrating", "low-conf only → 'calibrating' wording");
		ctx.assert.contains(prelimSummary, "ritual", "prelim fallback names the ritual lean");

		// ── MCP dispatch ──────────────────────────────────────────────────────
		const rpcResult = await handlePlanWorldJsonRpc({
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: { name: "inspire_read_household_signals", arguments: { household_id: hh } },
		}, env) as { result?: { structuredContent?: { household_id: string; personality: { summary: string }; traditions: unknown[]; equipment_available: string[] } } };
		ctx.assert.ok(!!rpcResult.result, "MCP tool returned a result");
		const structured = rpcResult.result?.structuredContent;
		ctx.assert.ok(!!structured, "MCP tool returned structuredContent");
		ctx.assert.eq(structured!.household_id, hh, "MCP echoes household_id");
		ctx.assert.gt(structured!.personality.summary.length, 0, "MCP surfaces personality.summary");
		ctx.assert.eq(structured!.traditions.length, 2, "MCP surfaces traditions");
		ctx.assert.eq(structured!.equipment_available.length, 5, "MCP surfaces equipment");

		// Payload size budget — must stay small (<5KB target, allow headroom).
		const json = JSON.stringify(signalsDiverge);
		ctx.assert.lte(json.length, 8000, "signals payload < 8KB (target <5KB)");

		ctx.notes.push(`u101 personality summary: "${signalsDiverge.personality.summary}"`);
		ctx.notes.push(`u101 spread guidance: "${signalsDiverge.member_spread_guidance}"`);
		ctx.notes.push(`u101 payload bytes: ${json.length}`);
	},
};

export default u101;
