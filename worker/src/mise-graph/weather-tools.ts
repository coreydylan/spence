// Weather-tools — pulls a daily forecast from Open-Meteo and synthesizes
// cooking-relevant context for the planning agent.
//
// Open-Meteo (https://open-meteo.com) is free, requires no API key, and
// returns a JSON forecast keyed by ISO date. We keep the call surface small:
// caller hands us {lat, lng, startDate, endDate}, we return a normalized
// `WeatherSummary` with per-day forecasts plus a 1-sentence pattern summary
// and a list of `cooking_hints` derived from temp/precip/wind rules.
//
// The cooking_hints are the magic — they translate "94° + 0% precip" into
// "grill weather, no-oven-day" so the agent can compose the right meal
// without re-implementing the same heuristics in every prompt.

const OPEN_METEO_URL = "https://api.open-meteo.com/v1/forecast";

export type WeatherCondition =
	| "sunny"
	| "partly_cloudy"
	| "cloudy"
	| "rainy"
	| "stormy"
	| "snowy"
	| "foggy";

export interface WeatherForecast {
	date: string;            // YYYY-MM-DD
	high_f: number;
	low_f: number;
	conditions: WeatherCondition;
	precip_chance: number;   // 0..1
	wind_mph: number;
	sunrise_local: string;   // HH:MM
	sunset_local: string;
}

export interface WeatherLocation {
	lat: number;
	lng: number;
	tz: string;
	city?: string;
}

export interface WeatherSummary {
	location: WeatherLocation;
	forecast: WeatherForecast[];
	pattern_summary: string;
	cooking_hints: string[];
}

export interface FetchWeatherOptions {
	timezone?: string;
	city?: string;
	fetch_impl?: typeof fetch;
}

interface OpenMeteoResponse {
	latitude?: number;
	longitude?: number;
	timezone?: string;
	daily?: {
		time?: string[];
		temperature_2m_max?: number[];
		temperature_2m_min?: number[];
		weather_code?: number[];
		precipitation_probability_max?: number[];
		wind_speed_10m_max?: number[];
		sunrise?: string[];
		sunset?: string[];
	};
}

export async function fetchWeatherForecast(
	location: { lat: number; lng: number },
	startDate: string,
	endDate: string,
	options: FetchWeatherOptions = {},
): Promise<WeatherSummary> {
	if (!isFiniteNumber(location?.lat) || !isFiniteNumber(location?.lng)) {
		throw new Error("fetchWeatherForecast: lat/lng required");
	}
	if (!isIsoDate(startDate) || !isIsoDate(endDate)) {
		throw new Error("fetchWeatherForecast: start_date / end_date must be YYYY-MM-DD");
	}
	if (endDate < startDate) {
		throw new Error("fetchWeatherForecast: end_date must be >= start_date");
	}

	const fetchImpl = options.fetch_impl || (globalThis.fetch as typeof fetch);
	const tz = (options.timezone || "auto").trim() || "auto";
	const params = new URLSearchParams({
		latitude: String(location.lat),
		longitude: String(location.lng),
		start_date: startDate,
		end_date: endDate,
		temperature_unit: "fahrenheit",
		wind_speed_unit: "mph",
		precipitation_unit: "inch",
		timezone: tz,
		daily: [
			"temperature_2m_max",
			"temperature_2m_min",
			"weather_code",
			"precipitation_probability_max",
			"wind_speed_10m_max",
			"sunrise",
			"sunset",
		].join(","),
	});

	const url = `${OPEN_METEO_URL}?${params.toString()}`;
	const response = await fetchImpl(url, { headers: { accept: "application/json" } });
	if (!response.ok) {
		throw new Error(`Open-Meteo request failed: ${response.status} ${response.statusText}`);
	}
	const json = (await response.json()) as OpenMeteoResponse;

	const forecast = parseDailyForecast(json);
	const resolvedTz = json.timezone || tz;
	const location_resolved: WeatherLocation = {
		lat: typeof json.latitude === "number" ? json.latitude : location.lat,
		lng: typeof json.longitude === "number" ? json.longitude : location.lng,
		tz: resolvedTz,
	};
	if (options.city) location_resolved.city = options.city;

	return {
		location: location_resolved,
		forecast,
		pattern_summary: buildPatternSummary(forecast),
		cooking_hints: buildCookingHints(forecast),
	};
}

// ─── Parsing ──────────────────────────────────────────────────────────────

function parseDailyForecast(json: OpenMeteoResponse): WeatherForecast[] {
	const daily = json.daily;
	if (!daily || !Array.isArray(daily.time)) return [];
	const out: WeatherForecast[] = [];
	const len = daily.time.length;
	for (let i = 0; i < len; i++) {
		const date = daily.time[i];
		if (!isIsoDate(date)) continue;
		const high = numberOr(daily.temperature_2m_max?.[i], NaN);
		const low = numberOr(daily.temperature_2m_min?.[i], NaN);
		if (!Number.isFinite(high) || !Number.isFinite(low)) continue;
		const code = numberOr(daily.weather_code?.[i], 0);
		const precipPct = clamp01((numberOr(daily.precipitation_probability_max?.[i], 0)) / 100);
		const wind = numberOr(daily.wind_speed_10m_max?.[i], 0);
		out.push({
			date,
			high_f: round1(high),
			low_f: round1(low),
			conditions: weatherCodeToCondition(code),
			precip_chance: round2(precipPct),
			wind_mph: round1(wind),
			sunrise_local: hhmmFromIso(daily.sunrise?.[i]),
			sunset_local: hhmmFromIso(daily.sunset?.[i]),
		});
	}
	return out;
}

// WMO weather interpretation codes (https://open-meteo.com/en/docs).
//   0           = clear sky
//   1, 2, 3     = mainly clear / partly cloudy / overcast
//   45, 48      = fog / depositing rime fog
//   51..67      = drizzle / rain (any intensity, freezing variants)
//   71..77      = snow / snow grains
//   80..82      = rain showers
//   85, 86      = snow showers
//   95, 96, 99  = thunderstorm (with/without hail)
function weatherCodeToCondition(code: number): WeatherCondition {
	if (!Number.isFinite(code)) return "cloudy";
	if (code === 0) return "sunny";
	if (code === 1 || code === 2) return "partly_cloudy";
	if (code === 3) return "cloudy";
	if (code === 45 || code === 48) return "foggy";
	if (code >= 51 && code <= 67) return "rainy";
	if ((code >= 71 && code <= 77) || code === 85 || code === 86) return "snowy";
	if (code >= 80 && code <= 82) return "rainy";
	if (code >= 95) return "stormy";
	return "cloudy";
}

// ─── Pattern summary ──────────────────────────────────────────────────────

function buildPatternSummary(forecast: WeatherForecast[]): string {
	if (forecast.length === 0) return "no forecast data";
	const highs = forecast.map(f => f.high_f);
	const lows = forecast.map(f => f.low_f);
	const minHigh = Math.min(...highs);
	const maxHigh = Math.max(...highs);
	const minLow = Math.min(...lows);
	const maxLow = Math.max(...lows);
	const avgPrecip = forecast.reduce((s, f) => s + f.precip_chance, 0) / forecast.length;

	const tempBand = describeTempBand((minHigh + maxHigh) / 2);
	const tempRange = `${roundDeg(minLow)}°–${roundDeg(maxHigh)}°`;
	const lowsRange = (minLow === maxLow)
		? `${roundDeg(minLow)}° lows`
		: `${roundDeg(minLow)}–${roundDeg(maxLow)}° lows`;
	const highsRange = (minHigh === maxHigh)
		? `${roundDeg(minHigh)}° highs`
		: `${roundDeg(minHigh)}–${roundDeg(maxHigh)}° highs`;

	const wetCount = forecast.filter(f => f.precip_chance >= 0.5).length;
	const stormy = forecast.some(f => f.conditions === "stormy");
	let moisture: string;
	if (stormy) moisture = "with thunderstorms";
	else if (wetCount === 0 && avgPrecip < 0.15) moisture = "dry";
	else if (wetCount >= forecast.length / 2) moisture = "with rain most days";
	else if (wetCount > 0) moisture = `with rain on ${wetCount} of ${forecast.length} days`;
	else moisture = "mostly dry";

	const snowy = forecast.some(f => f.conditions === "snowy");
	if (snowy) moisture = "with snow";

	return `${tempBand} and ${moisture}, ${lowsRange} to ${highsRange} (${tempRange})`;
}

function describeTempBand(avgHigh: number): string {
	if (avgHigh >= 95) return "scorching";
	if (avgHigh >= 85) return "hot";
	if (avgHigh >= 75) return "warm";
	if (avgHigh >= 65) return "mild";
	if (avgHigh >= 50) return "cool";
	if (avgHigh >= 35) return "cold";
	return "frigid";
}

// ─── Cooking hints ────────────────────────────────────────────────────────

function buildCookingHints(forecast: WeatherForecast[]): string[] {
	if (forecast.length === 0) return [];
	const hints: string[] = [];
	const dayLabel = (date: string) => weekdayName(date) || date;

	let firstHotDay: string | null = null;
	let firstColdDay: string | null = null;
	let consecutiveHotStart: string | null = null;
	let hotStreak = 0;
	let bestHotStreak = 0;
	let bestHotStart: string | null = null;

	for (const f of forecast) {
		const isHot = f.high_f >= 85;
		const isWarm = f.high_f >= 80;
		const isWet = f.precip_chance >= 0.6;
		const isCold = f.low_f <= 50;

		if (isHot && firstHotDay === null) firstHotDay = f.date;
		if (isCold && firstColdDay === null) firstColdDay = f.date;

		if (isHot) {
			hints.push(`${dayLabel(f.date)} ${roundDeg(f.high_f)}° — cold meals / no-oven day`);
			if (hotStreak === 0) consecutiveHotStart = f.date;
			hotStreak++;
			if (hotStreak > bestHotStreak) {
				bestHotStreak = hotStreak;
				bestHotStart = consecutiveHotStart;
			}
		} else {
			hotStreak = 0;
			consecutiveHotStart = null;
		}

		if (!isHot && isWarm && f.precip_chance < 0.1 && (f.conditions === "sunny" || f.conditions === "partly_cloudy")) {
			hints.push(`${dayLabel(f.date)} ${roundDeg(f.high_f)}° clear — grill weather`);
		}

		if (isWet) {
			hints.push(`${dayLabel(f.date)} ${Math.round(f.precip_chance * 100)}% rain — stay-in / braise weather`);
		}

		if (f.conditions === "stormy") {
			hints.push(`${dayLabel(f.date)} thunderstorms — keep dinner indoors`);
		}

		if (isCold) {
			hints.push(`${dayLabel(f.date)} ${roundDeg(f.low_f)}° low — soup / stew night`);
		}

		if (f.wind_mph >= 25) {
			hints.push(`${dayLabel(f.date)} ${Math.round(f.wind_mph)}mph wind — skip the grill`);
		}

		if (f.conditions === "snowy") {
			hints.push(`${dayLabel(f.date)} snow — slow-cook day, big-batch comfort`);
		}
	}

	// Pattern-level hints over the whole window.
	if (firstHotDay && forecast.length > 1 && firstHotDay !== forecast[0].date) {
		hints.push(`first hot day ${dayLabel(firstHotDay)} — gazpacho / cold-soup pivot`);
	}
	if (bestHotStreak >= 3 && bestHotStart) {
		hints.push(`hot streak starting ${dayLabel(bestHotStart)} (${bestHotStreak} days) — front-load oven prep before it hits`);
	}
	if (firstColdDay && forecast.length > 1 && firstColdDay !== forecast[0].date) {
		hints.push(`first cold night ${dayLabel(firstColdDay)} — chili / braise window opens`);
	}

	const driestDay = forecast.reduce(
		(best, f) => (f.precip_chance < best.precip_chance ? f : best),
		forecast[0],
	);
	const sunnyEnough = driestDay.conditions === "sunny" || driestDay.conditions === "partly_cloudy";
	if (forecast.length >= 4 && sunnyEnough && driestDay.high_f >= 70 && driestDay.precip_chance < 0.2) {
		// Pick a "best grill day" suggestion if no other grill hint already names that day.
		const already = hints.some(h => h.includes(dayLabel(driestDay.date)) && /grill weather/.test(h));
		if (!already) hints.push(`best outdoor cook day looks like ${dayLabel(driestDay.date)}`);
	}

	return hints;
}

// ─── small helpers ────────────────────────────────────────────────────────

function clamp01(n: number): number {
	if (!Number.isFinite(n)) return 0;
	if (n < 0) return 0;
	if (n > 1) return 1;
	return n;
}

function isIsoDate(value: unknown): value is string {
	return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function numberOr(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function round1(n: number): number {
	return Math.round(n * 10) / 10;
}

function round2(n: number): number {
	return Math.round(n * 100) / 100;
}

function roundDeg(n: number): number {
	return Math.round(n);
}

function hhmmFromIso(value: string | undefined | null): string {
	if (typeof value !== "string") return "";
	const m = /T(\d{2}):(\d{2})/.exec(value);
	if (!m) return "";
	return `${m[1]}:${m[2]}`;
}

function weekdayName(date: string): string {
	if (!isIsoDate(date)) return "";
	const ms = Date.parse(`${date}T12:00:00Z`);
	if (!Number.isFinite(ms)) return "";
	const day = new Date(ms).getUTCDay();
	return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][day];
}
