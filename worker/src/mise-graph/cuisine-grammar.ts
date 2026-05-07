// cuisine-grammar.ts
// ----------------------------------------------------------------------------
// Cuisine grammar validator.
//
// COOKING LOGIC ENCODED HERE
// --------------------------
// Most cuisines have a small set of structural elements that must all be
// present for a dish to taste like that cuisine. Miss one and the plate
// reads as "vaguely Mediterranean" rather than Italian; miss two and it's
// just food.
//
// CUISINE_GRAMMARS below encodes, for each cuisine, three things:
//
//   1. required_slots — the structural roles a dish in that cuisine needs.
//      e.g. Mexican tacos: nixtamal_grain (corn tortilla / masa), filling,
//      salsa, acid, crunch_or_pickle. We check each slot by trying to match
//      its declared `tokens` against the meal's ingredients.
//
//   2. signal_ingredients — the loud "this is X cuisine" markers. A meal
//      tagged with cuisine X but containing zero signal ingredients almost
//      certainly isn't actually that cuisine. (Mexican: cumin/chile/lime/
//      cilantro/queso/tomatillo. Japanese: dashi/miso/soy/mirin/nori/sesame.
//      Indian: turmeric/cumin/coriander/garam masala/ginger/tomato. etc.)
//
//   3. forbidden_combos — pairs that disqualify the cuisine label. Mexican +
//      mirin is a contradiction; Italian + soy sauce + miso is a fusion
//      dish, not Italian.
//
// CUISINE GRAMMARS COVERED (13)
// -----------------------------
//   mexican, japanese, italian, indian, thai, korean, vietnamese, levantine,
//   mediterranean, french, spanish, chinese, peruvian
//
// The grammars are deliberately conservative — we want them to flag obvious
// missing pieces, not to nitpick every stylistic variation. Mediterranean is
// intentionally loose because the label spans Greek, Spanish coast, and
// North African crossover.
//
// PER-FORMAT OVERRIDES
// --------------------
// Some cuisines have wildly different grammars per dish format. Mexican
// tacos vs sopa vs enchiladas; Japanese ramen vs sushi vs donburi. Where
// it matters, `format_overrides` swaps the required_slots for that meal's
// format so a soup isn't dinged for missing nixtamal_grain.
//
// VALIDATOR BEHAVIOR
// ------------------
//   - If meal.cuisine is empty → return [].
//   - For each cuisine on the meal, look up its grammar.
//     - If unknown cuisine → silently skip (no false positives).
//     - If zero signal_ingredients matched → flag
//       cuisine_grammar_no_signal_ingredients.
//     - For each missing required_slot → flag cuisine_grammar_missing_slot
//       with a repair_hint.
//     - For each tripped forbidden_combo → flag
//       cuisine_grammar_forbidden_combo.
// All grammar issues are severity "warning" — they're guidance, not safety.
// ----------------------------------------------------------------------------

// ---- Public types ----------------------------------------------------------

import type { MealForValidation, FormulaIndex } from "./flavor-validator";

export type CuisineIssueSeverity = "warning" | "info";

export type CuisineIssueType =
	| "cuisine_grammar_missing_slot"
	| "cuisine_grammar_forbidden_combo"
	| "cuisine_grammar_no_signal_ingredients";

export interface CuisineGrammarIssue {
	severity: CuisineIssueSeverity;
	issue_type: CuisineIssueType;
	title: string;
	detail: string;
	repair_hint?: string;
	cuisine: string;
	slot?: string;
}

export interface CuisineSlotDef {
	key: string;
	label: string;
	tokens: string[]; // substring matchers against the meal's ingredient blob
	repair_hint: string;
}

export interface ForbiddenCombo {
	a: string[]; // tokens for ingredient A — any match counts
	b: string[]; // tokens for ingredient B — any match counts
	reason: string;
}

export interface CuisineGrammar {
	required_slots: CuisineSlotDef[];
	signal_ingredients: string[];
	format_overrides?: Record<string, CuisineSlotDef[]>;
	forbidden_combos?: ForbiddenCombo[];
}

// ---- Reusable slot definitions --------------------------------------------

const SLOT_ACID_CITRUS_VINEGAR: CuisineSlotDef = {
	key: "acid",
	label: "acid",
	tokens: ["lemon", "lime", "vinegar", "wine", "verjus"],
	repair_hint: "Add lemon, lime, or vinegar to brighten the dish.",
};

const SLOT_FAT_GENERIC: CuisineSlotDef = {
	key: "fat",
	label: "fat carrier",
	tokens: [
		"olive oil", "butter", "ghee", "tahini", "yogurt", "cream",
		"coconut milk", "sesame oil", "lard", "schmaltz", "mayo",
	],
	repair_hint: "Add a fat (oil, butter, ghee, tahini, etc.) to carry the spice and aromatics.",
};

// ---- Cuisine grammars ------------------------------------------------------

export const CUISINE_GRAMMARS: Record<string, CuisineGrammar> = {
	// MEXICAN ---------------------------------------------------------------
	// Default form: tacos / quesadilla / tostada — needs nixtamal grain
	// (corn tortilla / masa), filling, salsa, citrus acid, and a pickle or
	// crunch. Signals: chiles (ancho/guajillo/chipotle/jalapeño/serrano/
	// poblano), lime, cilantro, cumin, queso fresco, tomatillo, epazote.
	mexican: {
		required_slots: [
			{
				key: "nixtamal_grain",
				label: "nixtamal grain (corn tortilla, masa, hominy)",
				tokens: ["corn tortilla", "masa", "hominy", "tortilla", "tostada", "totopos", "tlayuda"],
				repair_hint: "Add corn tortillas, masa, or hominy. Wheat tortillas are a substitute, not a base.",
			},
			{
				key: "filling",
				label: "filling (beans, vegetables, cheese, egg)",
				tokens: [
					"bean", "frijole", "refried", "rajas", "nopal", "huitlacoche",
					"squash blossom", "potato", "egg", "queso", "cheese", "mushroom",
				],
				repair_hint: "Add a filling — black or pinto beans, rajas, nopales, queso fresco, or roasted veg.",
			},
			{
				key: "salsa",
				label: "salsa or chile-tomato sauce",
				tokens: [
					"salsa", "pico de gallo", "guajillo", "ancho", "chipotle", "morita",
					"pasilla", "arbol", "mole", "tomatillo", "tomato sauce",
				],
				repair_hint: "Add a salsa — roja, verde, or a quick pico — to anchor the chile flavor.",
			},
			{
				key: "acid",
				label: "lime / acid",
				tokens: ["lime", "lemon", "vinegar", "tomatillo"],
				repair_hint: "Add lime juice, escabeche, or tomatillo to satisfy Mexican grammar.",
			},
			{
				key: "crunch_or_pickle",
				label: "crunch or pickled element",
				tokens: [
					"radish", "cabbage", "slaw", "pickled onion", "escabeche",
					"crispy", "tortilla chip", "totopos", "chicharron",
				],
				repair_hint: "Add pickled red onions, shaved radish, raw cabbage, or crispy totopos.",
			},
		],
		signal_ingredients: [
			"cumin", "chile", "chili", "ancho", "guajillo", "chipotle", "morita",
			"pasilla", "arbol", "jalapeno", "jalapeño", "serrano", "poblano",
			"habanero", "lime", "cilantro", "queso fresco", "queso",
			"tomatillo", "epazote", "masa", "corn tortilla", "achiote", "mole",
		],
		format_overrides: {
			soup: [
				{
					key: "broth_with_chile",
					label: "chile-spiked broth",
					tokens: ["pozole", "tortilla soup", "caldo", "chile", "ancho", "guajillo", "chipotle", "tomatillo"],
					repair_hint: "Build the broth on dried chiles (ancho/guajillo/chipotle) or tomatillo.",
				},
				{
					key: "garnish",
					label: "raw garnish (cabbage, radish, lime)",
					tokens: ["cabbage", "radish", "lime", "cilantro", "onion", "avocado"],
					repair_hint: "Top with shredded cabbage, radish, lime, and cilantro.",
				},
				{
					key: "crunch",
					label: "crunch (tortilla strips, totopos, chicharron)",
					tokens: ["tortilla strip", "totopos", "tortilla chip", "chicharron"],
					repair_hint: "Finish with tortilla strips or chicharron for crunch.",
				},
			],
			stew: [
				{
					key: "chile_base",
					label: "dried chile base",
					tokens: ["ancho", "guajillo", "chipotle", "morita", "pasilla", "mole", "chile"],
					repair_hint: "Build on a dried-chile mole/adobo base.",
				},
				{
					key: "fat",
					label: "fat carrier",
					tokens: ["lard", "oil", "butter"],
					repair_hint: "Bloom the chiles in lard or oil.",
				},
				{
					key: "acid",
					label: "lime / vinegar acid",
					tokens: ["lime", "vinegar"],
					repair_hint: "Finish with lime or a splash of vinegar.",
				},
			],
		},
		forbidden_combos: [
			{ a: ["mirin"], b: ["taco", "salsa", "tortilla"], reason: "Mirin is a Japanese sweetener — wrong family for Mexican." },
			{ a: ["soy sauce", "shoyu", "tamari"], b: ["taco", "salsa"], reason: "Soy sauce in tacos/salsa points to fusion, not Mexican." },
			{ a: ["coconut milk"], b: ["taco", "tortilla"], reason: "Coconut milk in tacos isn't traditional Mexican." },
		],
	},

	// JAPANESE --------------------------------------------------------------
	// Default form: rice + dashi-based seasoning + soy/miso. Signals: dashi,
	// miso, soy/shoyu, mirin, sake, nori, bonito, sesame, ginger.
	japanese: {
		required_slots: [
			{
				key: "umami_base",
				label: "umami base (dashi / miso / soy)",
				tokens: ["dashi", "miso", "soy sauce", "shoyu", "tamari", "katsuobushi", "kombu"],
				repair_hint: "Build on dashi, miso, or shoyu — Japanese cuisine runs on these.",
			},
			{
				key: "rice_or_noodle",
				label: "rice or noodle base",
				tokens: ["rice", "udon", "soba", "ramen", "somen", "mochi"],
				repair_hint: "Anchor the meal in rice or a noodle (udon/soba/ramen).",
			},
			{
				key: "umami_accent",
				label: "umami accent (mirin / sake / ginger)",
				tokens: ["mirin", "sake", "ginger", "rice vinegar"],
				repair_hint: "Add mirin, sake, or fresh ginger to balance the dashi.",
			},
			{
				key: "garnish",
				label: "garnish (nori / sesame / scallion)",
				tokens: ["nori", "sesame", "scallion", "shiso", "furikake", "togarashi"],
				repair_hint: "Finish with nori, sesame, scallion, or furikake.",
			},
		],
		signal_ingredients: [
			"dashi", "miso", "soy sauce", "shoyu", "tamari", "mirin", "sake",
			"nori", "sesame", "ginger", "kombu", "katsuobushi", "bonito",
			"furikake", "togarashi", "shiso", "yuzu", "rice vinegar",
		],
		format_overrides: {
			ramen: [
				{
					key: "broth",
					label: "ramen broth (miso/shoyu/shio/tonkotsu)",
					tokens: ["miso", "shoyu", "shio", "tonkotsu", "dashi"],
					repair_hint: "Build a miso, shoyu, shio, or dashi-rich broth.",
				},
				{
					key: "noodle",
					label: "ramen noodle",
					tokens: ["ramen", "noodle"],
					repair_hint: "Use proper ramen noodles, not just any wheat noodle.",
				},
				{
					key: "topping",
					label: "topping (egg / nori / scallion / corn / mushroom)",
					tokens: ["egg", "nori", "scallion", "corn", "mushroom", "menma", "bamboo"],
					repair_hint: "Top with at least two of: marinated egg, nori, scallion, corn, mushroom.",
				},
			],
		},
		forbidden_combos: [
			{ a: ["cumin"], b: ["miso", "dashi"], reason: "Cumin in miso/dashi suggests a different cuisine." },
			{ a: ["parmesan", "parmigiano"], b: ["dashi", "miso"], reason: "Parmesan + dashi is fusion, not Japanese." },
		],
	},

	// ITALIAN ---------------------------------------------------------------
	// Italian needs olive oil, an acid (tomato, wine, vinegar, lemon), an
	// allium, and almost always salt-driven cheese or cured element. Signals:
	// olive oil, garlic, basil, oregano, parmigiano, pecorino, mozzarella,
	// tomato, balsamic, lemon.
	italian: {
		required_slots: [
			{
				key: "olive_oil",
				label: "olive oil",
				tokens: ["olive oil", "evoo", "extra virgin"],
				repair_hint: "Italian food is built on olive oil — make sure it's there.",
			},
			{
				key: "allium",
				label: "garlic / onion / shallot",
				tokens: ["garlic", "onion", "shallot", "leek"],
				repair_hint: "Soffritto starts with garlic, onion, or both.",
			},
			{
				key: "acid",
				label: "acid (tomato, wine, lemon, vinegar)",
				tokens: ["tomato", "passata", "marinara", "wine", "balsamic", "red wine vinegar", "lemon"],
				repair_hint: "Add tomato, wine, lemon, or vinegar to lift the dish.",
			},
			{
				key: "cheese_or_cured",
				label: "cheese or cured element",
				tokens: [
					"parmesan", "parmigiano", "pecorino", "mozzarella", "burrata",
					"ricotta", "gorgonzola", "fontina", "taleggio",
				],
				repair_hint: "Add a hard or fresh cheese — parmigiano, pecorino, mozzarella, ricotta.",
			},
		],
		signal_ingredients: [
			"olive oil", "garlic", "basil", "oregano", "parsley", "rosemary",
			"sage", "thyme", "parmesan", "parmigiano", "pecorino", "mozzarella",
			"burrata", "ricotta", "tomato", "balsamic", "lemon", "pasta",
			"polenta", "risotto", "prosciutto",
		],
		format_overrides: {
			risotto: [
				{
					key: "rice",
					label: "arborio / carnaroli rice",
					tokens: ["arborio", "carnaroli", "vialone", "risotto", "rice"],
					repair_hint: "Use a starchy short-grain rice (arborio/carnaroli/vialone).",
				},
				{
					key: "stock",
					label: "stock to mount the rice",
					tokens: ["stock", "broth", "brodo"],
					repair_hint: "Build with vegetable or meat stock, ladled in.",
				},
				{
					key: "fat_finish",
					label: "butter / cheese mantecatura",
					tokens: ["butter", "parmesan", "parmigiano", "pecorino"],
					repair_hint: "Finish with butter and grated cheese (mantecatura).",
				},
				{
					key: "wine_or_acid",
					label: "white wine or lemon",
					tokens: ["white wine", "wine", "lemon"],
					repair_hint: "Deglaze with white wine or finish with lemon.",
				},
			],
		},
		forbidden_combos: [
			{ a: ["soy sauce", "shoyu", "tamari"], b: ["pasta", "risotto", "polenta"], reason: "Soy sauce in pasta/risotto/polenta is fusion, not Italian." },
			{ a: ["coconut milk"], b: ["pasta", "risotto"], reason: "Coconut milk isn't part of Italian grammar." },
			{ a: ["cumin"], b: ["pasta", "risotto"], reason: "Cumin in Italian pasta/risotto signals the wrong cuisine." },
		],
	},

	// INDIAN ----------------------------------------------------------------
	// Indian needs an aromatic spice base (cumin/coriander/turmeric/garam
	// masala), a fat carrier (ghee or oil) to bloom them, alliums and ginger,
	// and an acid (tomato, yogurt, lemon, tamarind).
	indian: {
		required_slots: [
			{
				key: "aromatic_spice_base",
				label: "aromatic spice base (cumin/coriander/turmeric/garam masala)",
				tokens: [
					"cumin", "coriander", "turmeric", "garam masala", "mustard seed",
					"fenugreek", "asafoetida", "hing", "fennel seed", "kalonji",
					"black cardamom", "cardamom", "curry leaf", "curry powder",
				],
				repair_hint: "Bloom whole or ground spices in fat — without this, it isn't Indian.",
			},
			{
				key: "fat_carrier",
				label: "fat carrier (ghee / oil)",
				tokens: ["ghee", "oil", "mustard oil", "coconut oil"],
				repair_hint: "Bloom the spices in ghee, mustard oil, or neutral oil.",
			},
			{
				key: "allium_ginger",
				label: "allium + ginger",
				tokens: ["onion", "garlic", "ginger", "shallot"],
				repair_hint: "Build on onion + garlic + ginger paste.",
			},
			{
				key: "acid",
				label: "acid (tomato / yogurt / lemon / tamarind)",
				tokens: ["tomato", "yogurt", "yoghurt", "lemon", "lime", "tamarind", "amchur", "kokum"],
				repair_hint: "Add tomato, yogurt, lemon, or tamarind for acidity.",
			},
		],
		signal_ingredients: [
			"cumin", "coriander", "turmeric", "garam masala", "ginger",
			"cardamom", "cinnamon", "clove", "fenugreek", "mustard seed",
			"curry leaf", "asafoetida", "hing", "ghee", "paneer", "yogurt",
			"tamarind", "kalonji", "amchur", "chana", "dal", "lentil",
		],
		format_overrides: {
			dal: [
				{
					key: "lentil",
					label: "lentil/legume",
					tokens: ["lentil", "dal", "daal", "moong", "toor", "chana", "masoor", "urad"],
					repair_hint: "Pick a real lentil — moong, toor, chana, masoor, urad.",
				},
				{
					key: "tadka",
					label: "tadka (tempered fat + spice)",
					tokens: ["tadka", "tarka", "ghee", "mustard seed", "cumin", "asafoetida"],
					repair_hint: "Finish with a tadka — ghee bloomed with mustard seed, cumin, and curry leaves.",
				},
				{
					key: "acid",
					label: "tomato / lemon / amchur",
					tokens: ["tomato", "lemon", "amchur", "tamarind"],
					repair_hint: "Add tomato or lemon to brighten.",
				},
				{
					key: "aromatic",
					label: "ginger / chili / cilantro",
					tokens: ["ginger", "chili", "chile", "green chili", "cilantro"],
					repair_hint: "Finish with grated ginger, green chili, and cilantro.",
				},
			],
		},
		forbidden_combos: [
			{ a: ["soy sauce", "shoyu"], b: ["curry", "dal", "tikka", "masala"], reason: "Soy sauce isn't part of Indian grammar." },
			{ a: ["mirin", "sake"], b: ["curry", "dal", "masala"], reason: "Mirin/sake in Indian curries is wrong cuisine." },
			{ a: ["parmesan", "parmigiano"], b: ["curry", "dal", "masala"], reason: "Parmesan in Indian dishes signals fusion." },
		],
	},

	// THAI ------------------------------------------------------------------
	// Thai balances four flavors: salty (fish sauce), sour (lime/tamarind),
	// sweet (palm sugar), spicy (chili). Plus aromatics (lemongrass, galangal,
	// kaffir lime, basil). Coconut milk in many curries.
	thai: {
		required_slots: [
			{
				key: "fish_sauce_or_soy",
				label: "fish sauce or soy",
				tokens: ["fish sauce", "nam pla", "soy sauce", "tamari", "golden mountain"],
				repair_hint: "Use fish sauce (or vegetarian soy/golden mountain) for Thai salt.",
			},
			{
				key: "sour",
				label: "lime or tamarind",
				tokens: ["lime", "tamarind", "kaffir lime"],
				repair_hint: "Add lime juice or tamarind for the sour leg of Thai balance.",
			},
			{
				key: "sweet",
				label: "palm sugar / sugar",
				tokens: ["palm sugar", "coconut sugar", "sugar", "jaggery"],
				repair_hint: "Add palm sugar to round out Thai balance — salty, sour, sweet, spicy.",
			},
			{
				key: "heat",
				label: "chili heat",
				tokens: ["chili", "chile", "bird's eye", "thai chili", "prik", "curry paste"],
				repair_hint: "Add Thai chili or curry paste — Thai food without heat is incomplete.",
			},
			{
				key: "aromatic",
				label: "Thai aromatic (lemongrass / galangal / kaffir lime / basil)",
				tokens: ["lemongrass", "galangal", "kaffir lime", "thai basil", "holy basil", "horapha", "krachai"],
				repair_hint: "Add lemongrass, galangal, kaffir lime leaf, or Thai basil.",
			},
		],
		signal_ingredients: [
			"fish sauce", "lemongrass", "galangal", "kaffir lime", "thai basil",
			"holy basil", "coconut milk", "tamarind", "palm sugar",
			"curry paste", "red curry", "green curry", "yellow curry",
			"thai chili", "bird's eye", "shrimp paste", "kapi",
		],
		forbidden_combos: [
			{ a: ["miso"], b: ["curry paste", "lemongrass"], reason: "Miso isn't part of Thai grammar." },
			{ a: ["parmesan", "parmigiano"], b: ["curry paste", "lemongrass"], reason: "Parmesan in Thai dishes is fusion, not Thai." },
		],
	},

	// KOREAN ----------------------------------------------------------------
	// Korean grammar: gochujang/gochugaru, soy/ganjang, sesame oil, garlic,
	// ginger, and almost always rice + banchan (side dishes / pickles).
	korean: {
		required_slots: [
			{
				key: "gochu",
				label: "gochujang or gochugaru (Korean chili)",
				tokens: ["gochujang", "gochugaru", "korean chili", "korean chile"],
				repair_hint: "Add gochujang (paste) or gochugaru (flake) — Korean dishes need this.",
			},
			{
				key: "soy",
				label: "soy / ganjang",
				tokens: ["soy sauce", "ganjang", "tamari"],
				repair_hint: "Use Korean soy (ganjang) or another soy sauce.",
			},
			{
				key: "sesame",
				label: "sesame (oil or seed)",
				tokens: ["sesame", "sesame oil", "sesame seed", "perilla"],
				repair_hint: "Finish with toasted sesame oil and/or sesame seeds.",
			},
			{
				key: "allium_ginger",
				label: "garlic + scallion (and often ginger)",
				tokens: ["garlic", "scallion", "green onion", "ginger"],
				repair_hint: "Build on garlic, scallion, and (often) ginger.",
			},
			{
				key: "ferment_or_pickle",
				label: "kimchi or other Korean pickle",
				tokens: ["kimchi", "danmuji", "kkakdugi", "oi muchim", "namul", "banchan"],
				repair_hint: "Serve kimchi or a banchan pickle alongside.",
			},
		],
		signal_ingredients: [
			"gochujang", "gochugaru", "kimchi", "doenjang", "ssamjang",
			"sesame oil", "sesame seed", "ganjang", "perilla", "scallion",
			"banchan", "namul", "japchae", "bibimbap", "bulgogi", "tteokbokki",
		],
		forbidden_combos: [
			{ a: ["coconut milk"], b: ["gochujang", "kimchi"], reason: "Coconut milk isn't part of Korean grammar." },
			{ a: ["parmesan", "parmigiano"], b: ["gochujang", "kimchi"], reason: "Parmesan in Korean dishes is fusion." },
		],
	},

	// VIETNAMESE ------------------------------------------------------------
	// Vietnamese: fish sauce + lime + chili + sugar (nuoc cham balance), tons
	// of fresh herbs (mint/cilantro/Thai basil/perilla), rice or rice noodle.
	vietnamese: {
		required_slots: [
			{
				key: "fish_sauce_or_soy",
				label: "fish sauce or vegetarian soy",
				tokens: ["fish sauce", "nuoc mam", "soy sauce", "maggi", "tamari"],
				repair_hint: "Use fish sauce (or vegetarian Maggi/soy) for the salt leg.",
			},
			{
				key: "lime_acid",
				label: "lime",
				tokens: ["lime", "calamansi", "rice vinegar"],
				repair_hint: "Lime is non-negotiable in Vietnamese.",
			},
			{
				key: "fresh_herbs",
				label: "fresh herbs (mint / cilantro / Thai basil)",
				tokens: ["mint", "cilantro", "thai basil", "perilla", "rau ram", "shiso"],
				repair_hint: "Pile on fresh mint, cilantro, Thai basil — a Vietnamese plate is half herbs.",
			},
			{
				key: "rice_or_noodle",
				label: "rice or rice noodle",
				tokens: ["rice", "rice noodle", "vermicelli", "bun", "pho noodle", "banh"],
				repair_hint: "Anchor on rice or rice noodle (bun, pho, vermicelli).",
			},
			{
				key: "heat",
				label: "chili",
				tokens: ["chili", "chile", "bird's eye", "thai chili", "sriracha", "sambal"],
				repair_hint: "Add fresh chili or chili sauce.",
			},
		],
		signal_ingredients: [
			"fish sauce", "nuoc mam", "lime", "mint", "cilantro", "thai basil",
			"perilla", "rice noodle", "vermicelli", "lemongrass", "ginger",
			"hoisin", "sriracha", "rice paper",
		],
		forbidden_combos: [
			{ a: ["cumin"], b: ["fish sauce", "nuoc mam"], reason: "Cumin isn't part of Vietnamese grammar." },
			{ a: ["miso", "dashi"], b: ["fish sauce", "rice noodle"], reason: "Miso/dashi point to Japanese, not Vietnamese." },
		],
	},

	// LEVANTINE -------------------------------------------------------------
	// Levantine (Lebanese, Syrian, Palestinian, Jordanian): olive oil, lemon,
	// garlic, parsley/mint, sumac, za'atar, tahini, yogurt, chickpeas.
	levantine: {
		required_slots: [
			{
				key: "olive_oil",
				label: "olive oil",
				tokens: ["olive oil", "evoo"],
				repair_hint: "Generous olive oil is structural to Levantine cooking.",
			},
			{
				key: "lemon_acid",
				label: "lemon (or sumac / pomegranate molasses)",
				tokens: ["lemon", "sumac", "pomegranate molasses", "verjus"],
				repair_hint: "Add lemon, sumac, or pomegranate molasses for the acid leg.",
			},
			{
				key: "herb_garlic",
				label: "fresh herb + garlic",
				tokens: ["parsley", "mint", "cilantro", "dill", "garlic"],
				repair_hint: "Pile on fresh parsley/mint and garlic.",
			},
			{
				key: "tahini_or_yogurt",
				label: "tahini, yogurt, or labneh",
				tokens: ["tahini", "yogurt", "yoghurt", "labneh"],
				repair_hint: "Add tahini, yogurt, or labneh — they appear in nearly every Levantine plate.",
			},
			{
				key: "spice",
				label: "Levantine spice (sumac / za'atar / allspice / cumin / Aleppo)",
				tokens: ["sumac", "za'atar", "zaatar", "allspice", "cumin", "aleppo", "baharat", "seven spice"],
				repair_hint: "Add sumac, za'atar, allspice, or baharat.",
			},
		],
		signal_ingredients: [
			"tahini", "sumac", "za'atar", "zaatar", "yogurt", "labneh",
			"chickpea", "lemon", "parsley", "mint", "olive oil", "pita",
			"bulgur", "freekeh", "pomegranate", "aleppo", "baharat",
		],
		forbidden_combos: [
			{ a: ["soy sauce", "shoyu"], b: ["tahini", "sumac"], reason: "Soy sauce isn't part of Levantine grammar." },
			{ a: ["coconut milk"], b: ["tahini", "sumac"], reason: "Coconut milk in Levantine dishes is wrong cuisine." },
		],
	},

	// MEDITERRANEAN ---------------------------------------------------------
	// Intentionally loose — the label spans Greek, Spanish coast, Provençal,
	// North African crossover. Required: olive oil, garlic-or-allium, an
	// acid, fresh herb. We don't enforce cheese or specific spice family.
	mediterranean: {
		required_slots: [
			{
				key: "olive_oil",
				label: "olive oil",
				tokens: ["olive oil", "evoo"],
				repair_hint: "Olive oil is the through-line of Mediterranean cooking.",
			},
			{
				key: "allium",
				label: "garlic / onion / shallot",
				tokens: ["garlic", "onion", "shallot", "leek"],
				repair_hint: "Build on garlic and/or onion.",
			},
			{
				key: "acid",
				label: "acid (lemon / vinegar / tomato / wine)",
				tokens: ["lemon", "vinegar", "tomato", "wine", "verjus", "pomegranate"],
				repair_hint: "Add lemon, vinegar, tomato, or wine.",
			},
			{
				key: "herb",
				label: "fresh or dried herb",
				tokens: [
					"oregano", "basil", "parsley", "mint", "dill", "thyme",
					"rosemary", "marjoram", "bay", "sage",
				],
				repair_hint: "Add an herb — oregano, basil, parsley, mint, thyme, rosemary.",
			},
		],
		signal_ingredients: [
			"olive oil", "garlic", "lemon", "tomato", "feta", "olive",
			"oregano", "basil", "parsley", "mint", "yogurt", "tahini",
			"chickpea", "eggplant", "zucchini",
		],
	},

	// FRENCH ----------------------------------------------------------------
	// French: butter or olive oil, mirepoix (onion + carrot + celery), wine
	// or vinegar, fresh herb (parsley, thyme, tarragon), and dairy or stock
	// finish.
	french: {
		required_slots: [
			{
				key: "fat",
				label: "butter or olive oil",
				tokens: ["butter", "olive oil", "duck fat"],
				repair_hint: "French dishes start in butter or olive oil.",
			},
			{
				key: "mirepoix",
				label: "mirepoix base (onion + carrot + celery, or shallot)",
				tokens: ["onion", "shallot", "carrot", "celery", "leek"],
				repair_hint: "Build on a mirepoix or sweated shallot.",
			},
			{
				key: "wine_or_vinegar",
				label: "wine or vinegar",
				tokens: ["wine", "white wine", "red wine", "vermouth", "vinegar", "verjus", "lemon"],
				repair_hint: "Deglaze with wine, vermouth, or vinegar — or finish with lemon.",
			},
			{
				key: "herb",
				label: "French herb (parsley / thyme / tarragon / chervil / chives / bay)",
				tokens: ["parsley", "thyme", "tarragon", "chervil", "chives", "bay", "herbes de provence"],
				repair_hint: "Add parsley, thyme, tarragon, or chervil.",
			},
		],
		signal_ingredients: [
			"butter", "wine", "shallot", "tarragon", "thyme", "dijon",
			"creme fraiche", "crème fraîche", "gruyere", "comté", "comte",
			"herbes de provence", "bay", "parsley", "chervil",
		],
		forbidden_combos: [
			{ a: ["soy sauce", "shoyu", "tamari"], b: ["wine", "butter"], reason: "Soy sauce isn't part of classic French grammar." },
			{ a: ["coconut milk"], b: ["wine", "butter"], reason: "Coconut milk in classic French dishes is fusion." },
		],
	},

	// SPANISH ---------------------------------------------------------------
	// Spanish: olive oil, smoked paprika (pimentón), garlic, often saffron,
	// often sherry or sherry vinegar, often tomato.
	spanish: {
		required_slots: [
			{
				key: "olive_oil",
				label: "olive oil",
				tokens: ["olive oil", "evoo"],
				repair_hint: "Spanish cooking is built on olive oil.",
			},
			{
				key: "garlic",
				label: "garlic",
				tokens: ["garlic", "ajo"],
				repair_hint: "Garlic is structural — sofrito, ajo blanco, gambas al ajillo.",
			},
			{
				key: "paprika_or_saffron",
				label: "smoked paprika or saffron",
				tokens: ["paprika", "pimenton", "pimentón", "saffron", "azafran", "azafrán"],
				repair_hint: "Add smoked paprika (dulce/picante) or saffron.",
			},
			{
				key: "acid",
				label: "sherry vinegar / wine / lemon / tomato",
				tokens: ["sherry vinegar", "sherry", "manzanilla", "fino", "tomato", "lemon", "wine"],
				repair_hint: "Finish with sherry vinegar, wine, lemon, or tomato.",
			},
		],
		signal_ingredients: [
			"olive oil", "garlic", "paprika", "pimenton", "pimentón", "saffron",
			"sherry", "sherry vinegar", "manchego", "chorizo", "jamón", "jamon",
			"piquillo", "padron", "padrón", "tomato",
		],
		forbidden_combos: [
			{ a: ["soy sauce", "shoyu"], b: ["paprika", "pimenton", "saffron"], reason: "Soy in a Spanish dish is fusion, not traditional." },
			{ a: ["coconut milk"], b: ["paprika", "pimenton"], reason: "Coconut milk isn't part of Spanish grammar." },
		],
	},

	// CHINESE ---------------------------------------------------------------
	// Baseline grammar (acknowledging Chinese is many regional cuisines):
	// soy sauce / shaoxing / vinegar (black or rice), garlic + ginger +
	// scallion (the "holy trinity"), sesame or peanut oil, rice or noodle.
	chinese: {
		required_slots: [
			{
				key: "soy_or_shaoxing",
				label: "soy sauce or shaoxing wine",
				tokens: ["soy sauce", "shoyu", "tamari", "shaoxing", "rice wine", "oyster sauce", "hoisin", "doubanjiang", "doenjang"],
				repair_hint: "Add light/dark soy or shaoxing wine.",
			},
			{
				key: "trinity",
				label: "garlic / ginger / scallion",
				tokens: ["garlic", "ginger", "scallion", "green onion"],
				repair_hint: "Use garlic + ginger + scallion — the foundation of most stir-fries and braises.",
			},
			{
				key: "acid_or_pickle",
				label: "vinegar (black / rice / chinkiang) or fermented note",
				tokens: ["chinkiang", "black vinegar", "rice vinegar", "vinegar", "doubanjiang", "fermented black bean", "douchi"],
				repair_hint: "Add black vinegar, rice vinegar, or a fermented note (doubanjiang / douchi).",
			},
			{
				key: "rice_or_noodle",
				label: "rice or wheat noodle",
				tokens: ["rice", "noodle", "lo mein", "chow mein", "udon", "wonton", "dumpling", "bao", "mantou"],
				repair_hint: "Anchor on rice or a wheat/rice noodle.",
			},
		],
		signal_ingredients: [
			"soy sauce", "shaoxing", "ginger", "scallion", "sesame oil",
			"oyster sauce", "hoisin", "black vinegar", "chinkiang", "rice vinegar",
			"sichuan peppercorn", "doubanjiang", "doenjang", "douchi",
			"five spice", "star anise",
		],
		forbidden_combos: [
			{ a: ["parmesan", "parmigiano"], b: ["soy sauce", "shaoxing"], reason: "Parmesan in Chinese dishes is fusion." },
			{ a: ["cumin"], b: ["shaoxing", "oyster sauce"], reason: "Cumin appears in Xinjiang/lamb dishes; in shaoxing/oyster contexts it's wrong." },
		],
	},

	// PERUVIAN --------------------------------------------------------------
	// Peruvian: aji (amarillo, panca, rocoto), lime, cilantro, garlic,
	// red onion, often potato/quinoa/corn. Ceviche needs lime + raw or
	// briefly-cooked protein + ají + onion. We give a generic baseline.
	peruvian: {
		required_slots: [
			{
				key: "aji",
				label: "ají (amarillo / panca / rocoto)",
				tokens: ["aji", "ají", "amarillo", "panca", "rocoto", "limo"],
				repair_hint: "Add ají amarillo, ají panca, or rocoto — Peruvian heat is structural.",
			},
			{
				key: "lime",
				label: "lime",
				tokens: ["lime", "limon", "limón"],
				repair_hint: "Add lime — leche de tigre, ceviche, escabeche all depend on it.",
			},
			{
				key: "cilantro_or_huacatay",
				label: "cilantro / huacatay",
				tokens: ["cilantro", "culantro", "huacatay"],
				repair_hint: "Finish with cilantro (or huacatay for highland dishes).",
			},
			{
				key: "allium",
				label: "red onion / garlic",
				tokens: ["red onion", "onion", "garlic"],
				repair_hint: "Macerated red onion + garlic appears in nearly every Peruvian dish.",
			},
			{
				key: "starch_anchor",
				label: "potato / quinoa / corn / rice",
				tokens: ["potato", "papa", "quinoa", "corn", "choclo", "cancha", "rice", "sweet potato", "camote"],
				repair_hint: "Anchor on Andean starch — potato, quinoa, or corn — or rice.",
			},
		],
		signal_ingredients: [
			"aji", "ají", "amarillo", "panca", "rocoto", "lime", "cilantro",
			"huacatay", "quinoa", "choclo", "cancha", "papa", "yuca", "lucuma",
			"chicha", "leche de tigre",
		],
		forbidden_combos: [
			{ a: ["soy sauce", "shoyu"], b: ["aji", "amarillo", "panca"], reason: "Soy in Peruvian dishes points to chifa fusion, not classic Peruvian. (Allow if dish is explicitly chifa.)" },
			{ a: ["coconut milk"], b: ["aji", "amarillo", "panca"], reason: "Coconut milk isn't part of standard Peruvian grammar." },
		],
	},
};

// ---- Aliases — common synonyms users / LLM may emit -----------------------

const CUISINE_ALIASES: Record<string, string> = {
	mex: "mexican",
	"tex-mex": "mexican",
	jpn: "japanese",
	japan: "japanese",
	ita: "italian",
	italy: "italian",
	ind: "indian",
	india: "indian",
	thailand: "thai",
	korea: "korean",
	vietnam: "vietnamese",
	"viet": "vietnamese",
	lebanese: "levantine",
	syrian: "levantine",
	palestinian: "levantine",
	jordanian: "levantine",
	"middle eastern": "levantine",
	"middle-eastern": "levantine",
	greek: "mediterranean",
	"north african": "mediterranean",
	moroccan: "mediterranean",
	provencal: "french",
	provençal: "french",
	france: "french",
	spain: "spanish",
	china: "chinese",
	cantonese: "chinese",
	szechuan: "chinese",
	sichuan: "chinese",
	hunan: "chinese",
	shanghainese: "chinese",
	peru: "peruvian",
};

function normalizeCuisine(value: string): string {
	const lower = value.trim().toLowerCase();
	if (!lower) return "";
	if (CUISINE_GRAMMARS[lower]) return lower;
	if (CUISINE_ALIASES[lower]) return CUISINE_ALIASES[lower];
	return lower;
}

// ---- Validator -------------------------------------------------------------

export function validateMealCuisineGrammar(meal: MealForValidation, formulas: FormulaIndex): CuisineGrammarIssue[] {
	const issues: CuisineGrammarIssue[] = [];
	const cuisines = (meal.cuisine || []).map(normalizeCuisine).filter(Boolean);
	if (cuisines.length === 0) return issues;

	const blob = buildIngredientBlob(meal, formulas);

	for (const cuisine of cuisines) {
		const grammar = CUISINE_GRAMMARS[cuisine];
		if (!grammar) continue; // unknown cuisine — silently skip

		// Pick required_slots: format override if available, else default.
		const formatKey = (meal.format || "").toLowerCase();
		const requiredSlots = pickRequiredSlots(grammar, formatKey);

		// Signal ingredients check.
		const matchedSignals = grammar.signal_ingredients.filter(token => containsWord(blob, token));
		if (matchedSignals.length === 0) {
			issues.push({
				severity: "warning",
				issue_type: "cuisine_grammar_no_signal_ingredients",
				cuisine,
				title: `No ${prettyCuisine(cuisine)} signal ingredients found`,
				detail: `${meal.title} is tagged as ${prettyCuisine(cuisine)} but contains none of its hallmark ingredients (${grammar.signal_ingredients.slice(0, 6).join(", ")}, …).`,
				repair_hint: `Either retag the cuisine, or add at least one ${prettyCuisine(cuisine)} signal ingredient.`,
			});
		}

		// Required slot check.
		for (const slot of requiredSlots) {
			const matched = slot.tokens.some(token => containsWord(blob, token));
			if (matched) continue;
			issues.push({
				severity: "warning",
				issue_type: "cuisine_grammar_missing_slot",
				cuisine,
				slot: slot.key,
				title: `Missing ${slot.label} for ${prettyCuisine(cuisine)}`,
				detail: `${meal.title} is tagged as ${prettyCuisine(cuisine)} but doesn't include a ${slot.label}.`,
				repair_hint: slot.repair_hint,
			});
		}

		// Forbidden combos check.
		for (const combo of grammar.forbidden_combos || []) {
			const aHit = combo.a.some(token => containsWord(blob, token));
			const bHit = combo.b.some(token => containsWord(blob, token));
			if (!aHit || !bHit) continue;
			issues.push({
				severity: "warning",
				issue_type: "cuisine_grammar_forbidden_combo",
				cuisine,
				title: `Forbidden ${prettyCuisine(cuisine)} combination`,
				detail: `${meal.title} mixes elements that don't belong together in ${prettyCuisine(cuisine)} cuisine: ${combo.reason}`,
				repair_hint: `Either drop one of the conflicting elements or retag the cuisine (this looks like fusion).`,
			});
		}
	}

	return issues;
}

function pickRequiredSlots(grammar: CuisineGrammar, formatKey: string): CuisineSlotDef[] {
	if (!grammar.format_overrides || !formatKey) return grammar.required_slots;
	// Substring-match the format key against override keys (so "ramen bowl"
	// still triggers the "ramen" override).
	for (const [overrideKey, slots] of Object.entries(grammar.format_overrides)) {
		if (containsWord(formatKey, overrideKey)) return slots;
	}
	return grammar.required_slots;
}

// Word-boundary substring match. Same shape as flavor-validator's helper —
// kept local here to avoid coupling the two files.
function containsWord(haystack: string, needle: string): boolean {
	if (!needle) return false;
	let from = 0;
	while (from < haystack.length) {
		const idx = haystack.indexOf(needle, from);
		if (idx < 0) return false;
		const before = idx === 0 ? "" : haystack.charAt(idx - 1);
		const afterIndex = idx + needle.length;
		const after = afterIndex >= haystack.length ? "" : haystack.charAt(afterIndex);
		if (!isWordChar(before) && !isWordChar(after)) return true;
		from = idx + 1;
	}
	return false;
}

function isWordChar(ch: string): boolean {
	if (!ch) return false;
	const c = ch.charCodeAt(0);
	if (c >= 97 && c <= 122) return true; // a-z
	if (c >= 65 && c <= 90) return true; // A-Z
	if (c >= 48 && c <= 57) return true; // 0-9
	if (ch === "'" || ch === "’") return true;
	return false;
}

function buildIngredientBlob(meal: MealForValidation, formulas: FormulaIndex): string {
	const parts: string[] = [];
	if (meal.title) parts.push(meal.title.toLowerCase());
	if (meal.format) parts.push(meal.format.toLowerCase());
	if (meal.method_summary) parts.push(meal.method_summary.toLowerCase());

	for (const fid of meal.formula_ids || []) {
		const formula = formulas.by_id.get(fid);
		if (!formula) continue;
		const label = (formula.output_label || formula.label || "").toLowerCase();
		if (label) parts.push(label);
		const out = (formula.output_canonical_name || "").toLowerCase();
		if (out) parts.push(out);
		for (const input of formula.inputs || []) {
			if (input.canonical_name) parts.push(input.canonical_name.toLowerCase());
		}
	}

	for (const raw of meal.raw_ingredients || []) {
		if (raw.name) parts.push(raw.name.toLowerCase());
		if (raw.category) parts.push(raw.category.toLowerCase());
	}

	return parts.join(" | ");
}

function prettyCuisine(slug: string): string {
	if (!slug) return slug;
	return slug.charAt(0).toUpperCase() + slug.slice(1);
}
