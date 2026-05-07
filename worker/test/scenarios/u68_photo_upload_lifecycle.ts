// U68 — Photo upload lifecycle: storePhotoBytes + R2 round-trip.
//
// Exercises the pure photo-handler entry points that the CookingLeadAgent
// composes inside the /upload-photo HTTP route. We don't boot the DO here
// (the Agents SDK doesn't load under Node); instead we drive the helpers
// directly with a mock R2 bucket, asserting:
//
//   1. storePhotoBytes computes the expected key and writes bytes through
//      to R2 with the right MIME + custom metadata.
//   2. r2BucketAsStorage is a transparent wrapper — get(key) returns the
//      same bytes we wrote.
//   3. resolveVisionPrompt returns a task-flavoured prompt when a task is
//      attached and the free-form prompt when not.
//   4. The R2 key format is stable: `photos/<cook_session_id>/<photo_id>`.

import type { Scenario } from "../lib/types";
import {
	computeR2Key,
	r2BucketAsStorage,
	resolveVisionPrompt,
	storePhotoBytes,
} from "../../src/mise-graph/agents/photo-handler";
import { MockR2Bucket } from "../lib/mock-r2";
import type { TaskNode } from "../../src/mise-graph/task-graph-types";

function tinyJpeg(): Uint8Array {
	// 8 bytes of "image" — enough for the test, not actually JPEG. The
	// photo-handler is byte-agnostic; the bridge would do real validation.
	return new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
}

const u68: Scenario = {
	id: "u68",
	name: "Photo upload lifecycle: store bytes → retrieve → resolve prompt",
	group: "unit",
	tier: "fast",
	async run(ctx) {
		const bucket = new MockR2Bucket();
		const storage = r2BucketAsStorage(bucket as unknown as R2Bucket);

		const cook_session_id = "cs_u68_alpha";
		const photo_id = "ph_u68_xy";
		const member_id = "mem_alice";
		const task_id = "task_t_dice_onion";
		const bytes = tinyJpeg();

		// 1. computeR2Key is stable.
		const expectedKey = `photos/${cook_session_id}/${photo_id}`;
		ctx.assert.eq(computeR2Key(cook_session_id, photo_id), expectedKey, "R2 key format");

		// 2. storePhotoBytes writes through.
		const stored = await storePhotoBytes(storage, {
			cook_session_id,
			photo_id,
			member_id,
			task_id,
			bytes,
			mime: "image/jpeg",
		});
		ctx.assert.eq(stored.r2_key, expectedKey, "stored key matches");
		ctx.assert.ok(bucket.hasKey(expectedKey), "bucket has the key");
		ctx.assert.eq(bucket.putCalls.length, 1, "exactly one put call");
		ctx.assert.eq(bucket.putCalls[0].size, bytes.byteLength, "put size matches");
		ctx.assert.eq(bucket.putCalls[0].mime, "image/jpeg", "MIME captured");
		ctx.assert.eq(
			bucket.putCalls[0].metadata.cook_session_id,
			cook_session_id,
			"cook_session_id in custom metadata",
		);
		ctx.assert.eq(
			bucket.putCalls[0].metadata.member_id,
			member_id,
			"member_id in custom metadata",
		);
		ctx.assert.eq(
			bucket.putCalls[0].metadata.task_id,
			task_id,
			"task_id in custom metadata",
		);

		// 3. Round-trip via the wrapper.
		const fetched = await storage.get(expectedKey);
		ctx.assert.ok(!!fetched, "fetched object is non-null");
		if (fetched) {
			ctx.assert.eq(fetched.contentType, "image/jpeg", "fetched contentType");
			const fetchedBytes = new Uint8Array(fetched.body);
			ctx.assert.eq(fetchedBytes.byteLength, bytes.byteLength, "byte length preserved");
			for (let i = 0; i < bytes.byteLength; i++) {
				if (fetchedBytes[i] !== bytes[i]) {
					ctx.assert.ok(false, `byte ${i} mismatch (${fetchedBytes[i]} != ${bytes[i]})`);
					break;
				}
			}
		}

		// 4. Missing key → null.
		const missing = await storage.get("photos/nope/nope");
		ctx.assert.eq(missing, null, "missing key returns null");

		// 5. resolveVisionPrompt routes by task vs free-form.
		const task: TaskNode = {
			id: task_id,
			recipe_id: "r_u68",
			step_idx: 1,
			kind: "prep",
			label: "dice onion",
			skill: "knife_basic",
			skill_floor: 0.5,
			equipment: ["chefs_knife"],
			ingredients_in: ["onion"],
			produces: "diced_onion",
			active_min: 4,
			passive_min: 0,
			parallelizable: true,
			depends_on: [],
		};
		const taskPrompt = resolveVisionPrompt({
			task,
			recipe_context: { title: "Sunday Soup" },
		});
		ctx.assert.eq(taskPrompt.prompt_kind, "task", "task prompt kind");
		ctx.assert.contains(taskPrompt.prompt, "Sunday Soup", "task prompt mentions recipe");
		ctx.assert.contains(taskPrompt.prompt, "dice", "knife prompt mentions dice");

		const freeFormPrompt = resolveVisionPrompt({
			task: null,
			recipe_context: null,
		});
		ctx.assert.eq(freeFormPrompt.prompt_kind, "free_form", "free-form prompt kind");
		ctx.assert.contains(
			freeFormPrompt.prompt,
			"the in-progress dish",
			"free-form fallback wording",
		);

		// 6. No-task with recipe context still falls to free-form, but
		//    personalises the recipe title.
		const namedFreeForm = resolveVisionPrompt({
			task: null,
			recipe_context: { title: "Brown Butter Tahini Cabbage" },
		});
		ctx.assert.eq(namedFreeForm.prompt_kind, "free_form", "no-task → free-form");
		ctx.assert.contains(
			namedFreeForm.prompt,
			"Brown Butter Tahini Cabbage",
			"recipe title interpolated",
		);
	},
};

export default u68;
