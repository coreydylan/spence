// U77 — Weather tool: days_ahead ergonomics + tool errors surfaced as MCP isError.
//
// Two regressions that bit us during the live walkthrough:
//   1. Agents naturally pass days_ahead, but the schema only accepted start_date.
//      Now days_ahead auto-derives the start/end window from "today".
//   2. Throwing in a tool path produced a JSON-RPC error envelope, which most
//      MCP clients treat as transport failure and silently drop. Errors should
//      land in the tool result as { isError: true, content: [{type:"text"}] }
//      so the agent reads them and reacts.

import type { Scenario } from "../lib/types";
import { _mcpInternals, callPlanWorldTool } from "../../src/mise-graph/plan-world-mcp";
import { createMockD1 } from "../lib/mock-d1";

interface OpenMeteoFixtureDay {
	time: string;
	tmax: number;
	tmin: number;
	weather_code: number;
	precip_pct: number;
	wind_mph: number;
	sunrise: string;
	sunset: string;
}

function buildOpenMeteoResponse(days: OpenMeteoFixtureDay[]) {
	return {
		latitude: 32.7,
		longitude: -117.1,
		timezone: "America/Los_Angeles",
		daily: {
			time: days.map(d => d.time),
			temperature_2m_max: days.map(d => d.tmax),
			temperature_2m_min: days.map(d => d.tmin),
			weather_code: days.map(d => d.weather_code),
			precipitation_probability_max: days.map(d => d.precip_pct),
			wind_speed_10m_max: days.map(d => d.wind_mph),
			sunrise: days.map(d => d.sunrise),
			sunset: days.map(d => d.sunset),
		},
	};
}

function isoDateUTC(d: Date): string {
	const y = d.getUTCFullYear();
	const m = String(d.getUTCMonth() + 1).padStart(2, "0");
	const day = String(d.getUTCDate()).padStart(2, "0");
	return `${y}-${m}-${day}`;
}

const u77: Scenario = {
	id: "u77",
	name: "Weather: days_ahead derives window from today + tool errors land as isError",
	group: "unit",
	tier: "fast",
	async run(ctx) {
		const env = { DB: createMockD1() } as any;

		// ── Part 1: days_ahead auto-derives today..today+N ──────────────────
		const today = new Date();
		const day0 = isoDateUTC(today);
		const day2 = isoDateUTC(new Date(today.getTime() + 2 * 86400000));

		const captured: { url?: string } = {};
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async (input: RequestInfo | URL) => {
			const url = typeof input === "string" ? input : input.toString();
			captured.url = url;
			return new Response(JSON.stringify(buildOpenMeteoResponse([
				{ time: day0, tmax: 75, tmin: 60, weather_code: 1, precip_pct: 5, wind_mph: 8, sunrise: `${day0}T05:50`, sunset: `${day0}T19:42` },
				{ time: isoDateUTC(new Date(today.getTime() + 86400000)), tmax: 78, tmin: 62, weather_code: 0, precip_pct: 0, wind_mph: 6, sunrise: "X", sunset: "Y" },
				{ time: day2, tmax: 80, tmin: 64, weather_code: 0, precip_pct: 0, wind_mph: 5, sunrise: "X", sunset: "Y" },
			])), { status: 200, headers: { "content-type": "application/json" } }) as unknown as Response;
		}) as typeof fetch;

		try {
			const result = await callPlanWorldTool(
				"inspire_read_weather",
				{ location: { lat: 32.7, lng: -117.1 }, days_ahead: 2 },
				env,
			);

			ctx.assert.ok(!!captured.url, "fetch was called via globalThis.fetch");
			ctx.assert.contains(captured.url || "", `start_date=${day0}`, `URL contains today as start_date (${day0})`);
			ctx.assert.contains(captured.url || "", `end_date=${day2}`, `URL contains today+2 as end_date (${day2})`);

			const forecast = (result as any).forecast;
			ctx.assert.ok(Array.isArray(forecast), "result has forecast array");
			ctx.assert.eq(forecast.length, 3, "forecast has 3 days (today + 2)");
			ctx.assert.eq(forecast[0].date, day0, "first day is today");
		} finally {
			globalThis.fetch = originalFetch;
		}

		// ── Part 2: missing required args returns isError tool result ────────
		// The walkthrough hit this exact shape (no start_date, no days_ahead),
		// but the error was thrown to the JSON-RPC envelope and the python
		// helper masked it as `{}`. Now the error must come back IN the result.
		const errResult = await _mcpInternals.handleToolCall(
			{
				name: "inspire_read_weather",
				arguments: { location: { lat: 32.7, lng: -117.1 } },
			},
			env,
		);

		ctx.assert.eq((errResult as any).isError, true, "missing date args → isError: true");
		const errContent = (errResult as any).content;
		ctx.assert.ok(Array.isArray(errContent), "isError result has content array");
		ctx.assert.eq(errContent[0].type, "text", "error content is text");
		ctx.assert.matches(errContent[0].text, /start_date|days_ahead/i, "error message names the missing fields");
		ctx.assert.matches(errContent[0].text, /inspire_read_weather/, "error message names the tool");

		// ── Part 3: unknown tool name also surfaces as isError, not a throw ──
		const unknownResult = await _mcpInternals.handleToolCall(
			{ name: "this_tool_does_not_exist", arguments: {} },
			env,
		);
		ctx.assert.eq((unknownResult as any).isError, true, "unknown tool → isError");
		ctx.assert.matches((unknownResult as any).content[0].text, /this_tool_does_not_exist|Unknown tool/i, "unknown-tool error text mentions name or 'Unknown'");

		ctx.notes.push(`days_ahead window: ${day0} → ${day2}`);
		ctx.notes.push(`error surfaced: "${String(errContent[0].text).slice(0, 80)}"`);
	},
};

export default u77;
