// U32 — Weather tools: parse Open-Meteo forecast → WeatherSummary,
// pattern_summary synthesis, cooking_hints rules.
//
// Mocks fetch with three fixtures (hot+dry, cold+wet, mixed-week) and
// asserts the right hints fire for each.

import type { Scenario } from "../lib/types";
import { fetchWeatherForecast } from "../../src/mise-graph/weather-tools";

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

function buildOpenMeteoResponse(days: OpenMeteoFixtureDay[], tz = "America/Los_Angeles") {
	return {
		latitude: 32.7,
		longitude: -117.1,
		timezone: tz,
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

function makeMockFetch(payload: unknown, capture?: { url?: string }) {
	const fn: typeof fetch = (async (input: RequestInfo | URL) => {
		const url = typeof input === "string" ? input : input.toString();
		if (capture) capture.url = url;
		return new Response(JSON.stringify(payload), {
			status: 200,
			headers: { "content-type": "application/json" },
		}) as unknown as Response;
	}) as typeof fetch;
	return fn;
}

const u32: Scenario = {
	id: "u32",
	name: "Weather tools: forecast shape, pattern summary, cooking hints",
	group: "unit",
	tier: "fast",
	async run(ctx) {
		// ── Fixture A: hot + dry ("grill weather, gazpacho pivot") ──────────
		// Day 1 mild, day 2 grill-perfect (82° clear), days 3-5 a hot streak
		// starting from a non-Day1 first-hot-day (drives gazpacho pivot).
		const hotWeek = buildOpenMeteoResponse([
			{ time: "2026-05-09", tmax: 76, tmin: 60, weather_code: 1, precip_pct: 5,  wind_mph: 8,  sunrise: "2026-05-09T05:51", sunset: "2026-05-09T19:42" },
			{ time: "2026-05-10", tmax: 82, tmin: 63, weather_code: 0, precip_pct: 0,  wind_mph: 5,  sunrise: "2026-05-10T05:50", sunset: "2026-05-10T19:43" },
			{ time: "2026-05-11", tmax: 86, tmin: 65, weather_code: 0, precip_pct: 0,  wind_mph: 5,  sunrise: "2026-05-11T05:49", sunset: "2026-05-11T19:44" },
			{ time: "2026-05-12", tmax: 88, tmin: 67, weather_code: 0, precip_pct: 0,  wind_mph: 4,  sunrise: "2026-05-12T05:49", sunset: "2026-05-12T19:45" },
			{ time: "2026-05-13", tmax: 92, tmin: 70, weather_code: 0, precip_pct: 0,  wind_mph: 7,  sunrise: "2026-05-13T05:48", sunset: "2026-05-13T19:46" },
		]);
		const captureA: { url?: string } = {};
		const summaryA = await fetchWeatherForecast(
			{ lat: 32.7, lng: -117.1 },
			"2026-05-09",
			"2026-05-13",
			{ fetch_impl: makeMockFetch(hotWeek, captureA), timezone: "America/Los_Angeles", city: "San Diego" },
		);

		ctx.assert.ok(!!captureA.url, "fetch was called");
		ctx.assert.contains(captureA.url || "", "open-meteo.com", "URL hits Open-Meteo");
		ctx.assert.contains(captureA.url || "", "temperature_unit=fahrenheit", "request asks for fahrenheit");
		ctx.assert.contains(captureA.url || "", "start_date=2026-05-09", "start_date in URL");
		ctx.assert.contains(captureA.url || "", "end_date=2026-05-13", "end_date in URL");

		ctx.assert.eq(summaryA.forecast.length, 5, "5 days of forecast");
		ctx.assert.eq(summaryA.location.city, "San Diego", "city echoed back on summary");
		ctx.assert.eq(summaryA.forecast[0].conditions, "partly_cloudy", "weather_code=1 → partly_cloudy");
		ctx.assert.eq(summaryA.forecast[1].conditions, "sunny", "weather_code=0 → sunny");
		ctx.assert.eq(summaryA.forecast[4].high_f, 92, "high_f preserved (92)");
		ctx.assert.eq(summaryA.forecast[1].sunrise_local, "05:50", "sunrise_local extracted to HH:MM");
		ctx.assert.eq(summaryA.forecast[1].precip_chance, 0, "precip_chance 0% → 0");

		ctx.assert.matches(summaryA.pattern_summary, /warm|hot/i, "pattern says warm/hot");
		ctx.assert.matches(summaryA.pattern_summary, /dry/i, "pattern says dry");
		ctx.assert.contains(summaryA.pattern_summary, "92", "pattern includes hot high");

		const hotHints = summaryA.cooking_hints.join(" | ");
		ctx.assert.matches(hotHints, /no-oven|cold meal/i, "hot day → no-oven hint");
		ctx.assert.matches(hotHints, /grill weather/i, "warm dry day → grill weather hint");
		ctx.assert.matches(hotHints, /gazpacho/i, "first hot day pivots to gazpacho");
		ctx.assert.matches(hotHints, /hot streak/i, "consecutive hot days → hot streak hint");
		ctx.notes.push(`hot-week pattern: ${summaryA.pattern_summary}`);
		ctx.notes.push(`hot-week hints (${summaryA.cooking_hints.length}): ${summaryA.cooking_hints.slice(0, 3).join(" | ")}`);

		// ── Fixture B: cold + wet ("braise / soup weather") ─────────────────
		const coldWeek = buildOpenMeteoResponse([
			{ time: "2026-12-01", tmax: 48, tmin: 38, weather_code: 61, precip_pct: 75, wind_mph: 12, sunrise: "2026-12-01T07:01", sunset: "2026-12-01T16:45" },
			{ time: "2026-12-02", tmax: 45, tmin: 36, weather_code: 63, precip_pct: 85, wind_mph: 14, sunrise: "2026-12-02T07:02", sunset: "2026-12-02T16:45" },
			{ time: "2026-12-03", tmax: 42, tmin: 33, weather_code: 95, precip_pct: 90, wind_mph: 22, sunrise: "2026-12-03T07:03", sunset: "2026-12-03T16:45" },
		]);
		const summaryB = await fetchWeatherForecast(
			{ lat: 47.6, lng: -122.3 },
			"2026-12-01",
			"2026-12-03",
			{ fetch_impl: makeMockFetch(coldWeek), timezone: "America/Los_Angeles" },
		);

		ctx.assert.eq(summaryB.forecast.length, 3, "3 days returned");
		ctx.assert.eq(summaryB.forecast[0].conditions, "rainy", "weather_code=61 → rainy");
		ctx.assert.eq(summaryB.forecast[2].conditions, "stormy", "weather_code=95 → stormy");
		ctx.assert.eq(summaryB.forecast[0].precip_chance, 0.75, "precip_chance 75% → 0.75");

		ctx.assert.matches(summaryB.pattern_summary, /cool|cold/i, "pattern says cool/cold");
		ctx.assert.matches(summaryB.pattern_summary, /thunderstorms|rain/i, "pattern mentions rain or storms");
		const coldHints = summaryB.cooking_hints.join(" | ");
		ctx.assert.matches(coldHints, /braise/i, "wet day → braise hint");
		ctx.assert.matches(coldHints, /soup|stew/i, "cold low → soup/stew hint");
		ctx.assert.matches(coldHints, /thunderstorms/i, "stormy day surfaced");
		ctx.notes.push(`cold-week pattern: ${summaryB.pattern_summary}`);

		// ── Fixture C: mixed week (one foggy, one snowy, normal otherwise) ──
		const mixedWeek = buildOpenMeteoResponse([
			{ time: "2026-02-01", tmax: 55, tmin: 41, weather_code: 45, precip_pct: 5,  wind_mph: 4,  sunrise: "2026-02-01T07:11", sunset: "2026-02-01T17:30" },
			{ time: "2026-02-02", tmax: 38, tmin: 27, weather_code: 71, precip_pct: 60, wind_mph: 9,  sunrise: "2026-02-02T07:11", sunset: "2026-02-02T17:31" },
			{ time: "2026-02-03", tmax: 60, tmin: 45, weather_code: 2,  precip_pct: 10, wind_mph: 5,  sunrise: "2026-02-03T07:10", sunset: "2026-02-03T17:32" },
		]);
		const summaryC = await fetchWeatherForecast(
			{ lat: 39.7, lng: -104.9 },
			"2026-02-01",
			"2026-02-03",
			{ fetch_impl: makeMockFetch(mixedWeek) },
		);
		ctx.assert.eq(summaryC.forecast[0].conditions, "foggy", "weather_code=45 → foggy");
		ctx.assert.eq(summaryC.forecast[1].conditions, "snowy", "weather_code=71 → snowy");
		ctx.assert.eq(summaryC.forecast[2].conditions, "partly_cloudy", "weather_code=2 → partly_cloudy");
		const mixedHints = summaryC.cooking_hints.join(" | ");
		ctx.assert.matches(mixedHints, /snow|slow-cook/i, "snow day → slow-cook hint");

		// Bad inputs throw rather than silently return empty.
		let threw = false;
		try {
			await fetchWeatherForecast({ lat: NaN as unknown as number, lng: 0 }, "2026-01-01", "2026-01-02", {
				fetch_impl: makeMockFetch({}),
			});
		} catch {
			threw = true;
		}
		ctx.assert.eq(threw, true, "invalid lat throws");

		threw = false;
		try {
			await fetchWeatherForecast({ lat: 0, lng: 0 }, "not-a-date", "2026-01-02", {
				fetch_impl: makeMockFetch({}),
			});
		} catch {
			threw = true;
		}
		ctx.assert.eq(threw, true, "invalid date throws");
	},
};

export default u32;
