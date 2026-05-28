export type MeatballDish = {
  id: string;
  name: string;
  place: string;
  era: string;
  binder: string;
  fat: string;
  cooked_in: string;
  route: string;
  one_liner: string;
};

export type MeatballEdge = {
  from: string;
  to: string;
  type: 'cousin-of' | 'descends-from' | 'migrated-via' | 'diaspora-of' | 'transformed-by';
  via: string;
  note?: string;
};

export const ROUTE_COLORS: Record<string, string> = {
  silk_road: '#A47BE6',  // violet — mystical east
  ottoman: '#F4A23C',    // saffron — Anatolian court
  moorish: '#B85540',    // terracotta — Andalusi clay
  hanseatic: '#6FA8D6',  // cold North Sea blue
  diaspora: '#7BA05B',   // sage — travel, dispersion
  columbian: '#E84A3B',  // vivid red — 1492 detonation
  none: '#D4C29C',       // warm neutral — local
};

export const ROUTE_ANGLES: Record<string, number> = {
  silk_road: 0,                     // 3 o'clock — east
  ottoman: Math.PI / 3,             // 1 o'clock
  moorish: (2 * Math.PI) / 3,       // 11 o'clock
  hanseatic: Math.PI,               // 9 o'clock — west
  columbian: (4 * Math.PI) / 3,     // 7 o'clock
  diaspora: (5 * Math.PI) / 3,      // 5 o'clock
};

export const EDGE_COLORS: Record<string, string> = {
  'descends-from': 'rgba(247,237,226,0.45)',
  'cousin-of': 'rgba(247,237,226,0.22)',
  'migrated-via': 'rgba(247,237,226,0.38)',
  'diaspora-of': 'rgba(247,237,226,0.32)',
  'transformed-by': 'rgba(232,74,59,0.45)',
};

export const ROUTE_LABELS: Record<string, string> = {
  ottoman: 'Ottoman expansion',
  moorish: 'Moorish Iberia',
  silk_road: 'Silk Road',
  hanseatic: 'Hanseatic / North Sea',
  diaspora: 'Diaspora',
  columbian: 'Columbian Exchange',
  none: 'Local',
};

export const dishes: MeatballDish[] = [
  { id: 'polpette', name: 'Polpette', place: 'Naples', era: '15th c. (Martino da Como)', binder: 'bread', fat: 'mixed', cooked_in: 'tomato', route: 'none', one_liner: 'Small, soft, bread-soaked balls braised in Sunday sugo, never the size of an American meatball.' },
  { id: 'polpette-al-sugo-american', name: 'Italian-American Meatball', place: 'Little Italy, New York', era: '1900s', binder: 'bread', fat: 'beef', cooked_in: 'tomato', route: 'diaspora', one_liner: 'A diaspora bulking-up of polpette — bigger, beefier, served on spaghetti for the New World.' },
  { id: 'kofta-turkish', name: 'Köfte', place: 'Anatolia', era: 'medieval', binder: 'bread', fat: 'lamb', cooked_in: 'grilled', route: 'ottoman', one_liner: 'The Anatolian flat oval of seasoned lamb that seeded a thousand cousins from Athens to Dhaka.' },
  { id: 'kibbeh', name: 'Kibbeh', place: 'Aleppo', era: 'ancient', binder: 'bulgur', fat: 'lamb', cooked_in: 'fried_in_oil', route: 'none', one_liner: "Bulgur-jacketed lamb torpedoes — Syria's national obsession and the Levant's most architectural meatball." },
  { id: 'dawood-basha', name: 'Dawood Basha', place: 'Damascus', era: '1800s', binder: 'bread', fat: 'lamb', cooked_in: 'tomato', route: 'ottoman', one_liner: 'Lamb balls drowned in pomegranate-tinged tomato, named for an Ottoman pasha with a temper.' },
  { id: 'soutzoukakia', name: 'Soutzoukakia', place: 'Smyrna', era: '1920s', binder: 'bread', fat: 'beef', cooked_in: 'tomato', route: 'ottoman', one_liner: 'Cumin-heavy lamb-beef cigars carried from Smyrna to Thessaloniki by refugees in 1922.' },
  { id: 'keftedes', name: 'Keftedes', place: 'Crete', era: '1800s', binder: 'bread', fat: 'beef', cooked_in: 'fried_in_oil', route: 'ottoman', one_liner: 'Mint and oregano in the mix, ouzo on the side, fried in a heavy iron pan.' },
  { id: 'cevapi', name: 'Ćevapi', place: 'Sarajevo', era: '1500s', binder: 'none', fat: 'beef', cooked_in: 'grilled', route: 'ottoman', one_liner: 'Skinless sausage-fingers grilled over coals, served with somun bread and raw onion.' },
  { id: 'albondigas', name: 'Albóndigas', place: 'Andalusia', era: '900s', binder: 'bread', fat: 'pork', cooked_in: 'tomato', route: 'moorish', one_liner: "Al-bunduq, the hazelnut, became Spain's word for meatballs after the Moors brought the technique." },
  { id: 'albondigas-mexicana', name: 'Albóndigas en Caldo', place: 'Mexico City', era: '1700s', binder: 'rice', fat: 'beef', cooked_in: 'broth', route: 'columbian', one_liner: "Rice-studded balls bobbing in mint-chipotle broth — Spain's albóndiga remade for the Mexican comal." },
  { id: 'koobideh', name: 'Koobideh', place: 'Tehran', era: '1800s', binder: 'none', fat: 'lamb', cooked_in: 'grilled', route: 'silk_road', one_liner: 'Pounded lamb and onion smeared on flat skewers, charred over mangal until the fat weeps.' },
  { id: 'kofta-mughlai', name: 'Mughlai Kofta', place: 'Lucknow', era: '1600s', binder: 'bread', fat: 'lamb', cooked_in: 'yogurt', route: 'silk_road', one_liner: 'Persian kofta dressed in cardamom, cream, and saffron in the Mughal courts of Awadh.' },
  { id: 'malai-kofta', name: 'Malai Kofta', place: 'Delhi', era: '1900s', binder: 'starch', fat: 'vegetarian', cooked_in: 'tomato', route: 'none', one_liner: 'Paneer-potato dumplings in cashew gravy — the vegetarian answer to Mughal kofta.' },
  { id: 'nargisi-kofta', name: 'Nargisi Kofta', place: 'Lucknow', era: '1700s', binder: 'bread', fat: 'lamb', cooked_in: 'yogurt', route: 'silk_road', one_liner: 'A hard-boiled egg wrapped in spiced lamb — the Mughal Scotch egg, named for the narcissus flower.' },
  { id: 'lions-head', name: "Lion's Head", place: 'Yangzhou', era: '600s', binder: 'starch', fat: 'pork', cooked_in: 'broth', route: 'none', one_liner: 'Fist-sized pork meatballs braised with napa cabbage — the cabbage is the mane, the meatball the head.' },
  { id: 'tsukune', name: 'Tsukune', place: 'Tokyo', era: '1800s', binder: 'starch', fat: 'chicken', cooked_in: 'grilled', route: 'none', one_liner: 'Chicken-thigh paste shaped on a skewer, lacquered with tare, eaten with a raw yolk for dipping.' },
  { id: 'xiu-mai', name: 'Xíu Mại', place: 'Saigon', era: '1900s', binder: 'bread', fat: 'pork', cooked_in: 'tomato', route: 'diaspora', one_liner: 'Cantonese siu mai reborn in Vietnam as a tomato-braised pork ball eaten with a baguette.' },
  { id: 'bakso', name: 'Bakso', place: 'Surabaya', era: '1800s', binder: 'starch', fat: 'beef', cooked_in: 'broth', route: 'diaspora', one_liner: "Hokkien immigrants' bouncy beef ball, now Indonesia's national street-cart soup." },
  { id: 'look-chin', name: 'Look Chin', place: 'Bangkok', era: '1800s', binder: 'starch', fat: 'pork', cooked_in: 'broth', route: 'diaspora', one_liner: 'Teochew-descended snap-bouncy balls skewered, grilled, and dunked in sweet chili.' },
  { id: 'bola-bola', name: 'Bola-Bola', place: 'Manila', era: '1900s', binder: 'bread', fat: 'pork', cooked_in: 'steamed', route: 'diaspora', one_liner: 'Filipino pork balls steamed in mami soup or fried for pancit — Spanish name, Chinese technique.' },
  { id: 'frikadeller', name: 'Frikadeller', place: 'Copenhagen', era: '1700s', binder: 'bread', fat: 'pork', cooked_in: 'fried_in_oil', route: 'hanseatic', one_liner: 'Flattened pork-veal patties fried in butter, the lukewarm leftover sandwich better than the dinner.' },
  { id: 'kottbullar', name: 'Köttbullar', place: 'Stockholm', era: '1700s', binder: 'bread', fat: 'mixed', cooked_in: 'fried_in_oil', route: 'ottoman', one_liner: 'Charles XII brought the recipe back from Ottoman exile in 1715 — Sweden has been claiming it ever since.' },
  { id: 'klopsy', name: 'Klopsy', place: 'Königsberg', era: '1800s', binder: 'bread', fat: 'mixed', cooked_in: 'broth', route: 'hanseatic', one_liner: 'Königsberger Klopse — veal balls in caper-lemon white sauce, a Prussian bourgeoisie classic.' },
  { id: 'faggots', name: 'Faggots', place: 'Black Country', era: '1800s', binder: 'bread', fat: 'pork', cooked_in: 'other', route: 'none', one_liner: 'Pig offal bound with breadcrumbs, wrapped in caul fat, baked in onion gravy — English thrift cuisine.' },
  { id: 'boulettes-senegalaises', name: 'Boulettes de Poisson', place: 'Dakar', era: '1900s', binder: 'bread', fat: 'fish', cooked_in: 'tomato', route: 'diaspora', one_liner: 'Pounded fish balls simmered in tomato-onion yassa — French boulette technique on Senegalese fish.' },
  { id: 'kefta-tagine', name: 'Kefta Mkaouara', place: 'Marrakech', era: '1800s', binder: 'none', fat: 'beef', cooked_in: 'tomato', route: 'moorish', one_liner: 'Cumin-paprika beef balls poached with eggs cracked into a clay tagine over coals.' },
  { id: 'dolma-kufta', name: 'Kufta Bozbash', place: 'Tabriz', era: '1800s', binder: 'rice', fat: 'lamb', cooked_in: 'broth', route: 'silk_road', one_liner: 'A grapefruit-sized lamb ball with a prune and walnut inside, simmered in turmeric broth.' },
  { id: 'chiftele', name: 'Chiftele', place: 'Bucharest', era: '1800s', binder: 'bread', fat: 'pork', cooked_in: 'fried_in_oil', route: 'ottoman', one_liner: "Garlicky Romanian pork patties, the cold leftover slipped between two slices of bread for the next day's lunch." },
  { id: 'cig-kofte', name: 'Çiğ Köfte', place: 'Şanlıurfa', era: 'ancient', binder: 'bulgur', fat: 'lamb', cooked_in: 'other', route: 'none', one_liner: 'Raw lamb (now usually meatless) kneaded with bulgur and pepper paste for an hour until it cooks itself.' },
  { id: 'gondi', name: 'Gondi', place: 'Tehran', era: '1800s', binder: 'starch', fat: 'chicken', cooked_in: 'broth', route: 'silk_road', one_liner: 'Persian-Jewish chickpea-flour chicken balls floated in turmeric broth for Shabbat.' },
  { id: 'yuvarlakia', name: 'Youvarlakia', place: 'Athens', era: '1800s', binder: 'rice', fat: 'beef', cooked_in: 'broth', route: 'ottoman', one_liner: 'Rice-bound beef balls in egg-lemon avgolemono — Greek winter comfort in a bowl.' },
  { id: 'kufteh-tabrizi', name: 'Kufteh Tabrizi', place: 'Tabriz', era: '1700s', binder: 'rice', fat: 'lamb', cooked_in: 'broth', route: 'silk_road', one_liner: 'Volleyball-sized lamb-rice spheres hiding a whole chicken or hard-boiled eggs inside.' },
  { id: 'portuguese-meatball-saimin', name: 'Portuguese Sausage Meatballs', place: 'Honolulu', era: '1900s', binder: 'bread', fat: 'pork', cooked_in: 'fried_in_oil', route: 'diaspora', one_liner: 'Madeiran linguiça reshaped into balls in plantation Hawaii, served over rice or in saimin.' },
  { id: 'chili-meatball-tex', name: 'Texas Chili Meatballs', place: 'San Antonio', era: '1900s', binder: 'none', fat: 'beef', cooked_in: 'tomato', route: 'diaspora', one_liner: 'Mexican albóndigas absorbed into Texas chili — cumin-heavy, no bean, all gravy.' },
  { id: 'shilta', name: 'Shifta', place: 'Addis Ababa', era: '1900s', binder: 'none', fat: 'beef', cooked_in: 'grilled', route: 'none', one_liner: "Berbere-spiced minced beef grilled on skewers — Ethiopia's lean cousin to the kebab." },
  { id: 'dombolo-meatballs', name: 'South African Meatballs', place: 'Johannesburg', era: '1900s', binder: 'bread', fat: 'beef', cooked_in: 'tomato', route: 'diaspora', one_liner: 'Cape Malay curried meatballs in tomato-onion gravy, eaten with pap or fluffy white bread.' },
  { id: 'laab-balls', name: 'Laab Tod', place: 'Chiang Mai', era: '1900s', binder: 'rice', fat: 'pork', cooked_in: 'fried_in_oil', route: 'none', one_liner: 'Northern Thai laab seasoning rolled into balls and deep-fried — herby, gamey, eaten with sticky rice.' },
  { id: 'maultaschen-meatcore', name: 'Maultaschen', place: 'Swabia', era: '1700s', binder: 'starch', fat: 'pork', cooked_in: 'broth', route: 'none', one_liner: 'A pork-spinach ball wrapped in pasta, invented by monks to hide meat from God during Lent.' },
  { id: 'kuyteav-meatballs', name: 'Kuyteav Meatballs', place: 'Phnom Penh', era: '1900s', binder: 'starch', fat: 'pork', cooked_in: 'broth', route: 'diaspora', one_liner: "Teochew-descended bouncy pork balls swimming in Cambodia's morning noodle soup." },
  { id: 'shish-barak', name: 'Shish Barak', place: 'Beirut', era: 'medieval', binder: 'starch', fat: 'lamb', cooked_in: 'yogurt', route: 'none', one_liner: 'Tiny lamb meatballs sealed in dough crescents, poached in warm garlic yogurt — Levantine ravioli with intent.' },
];

export const edges: MeatballEdge[] = [
  { from: 'polpette', to: 'kofta-turkish', type: 'cousin-of', via: 'ottoman' },
  { from: 'polpette', to: 'polpette-al-sugo-american', type: 'diaspora-of', via: 'diaspora', note: 'Steerage immigrants scaled up and beefed up for New World abundance.' },
  { from: 'kofta-turkish', to: 'kibbeh', type: 'cousin-of', via: 'none', note: 'Both Levantine-Anatolian, kibbeh keeps the bulgur jacket kofta dropped.' },
  { from: 'kofta-turkish', to: 'soutzoukakia', type: 'descends-from', via: 'ottoman' },
  { from: 'kofta-turkish', to: 'keftedes', type: 'descends-from', via: 'ottoman' },
  { from: 'kofta-turkish', to: 'cevapi', type: 'cousin-of', via: 'ottoman' },
  { from: 'kofta-turkish', to: 'kottbullar', type: 'migrated-via', via: 'ottoman', note: "Charles XII's Ottoman exile, 1715." },
  { from: 'kofta-turkish', to: 'chiftele', type: 'descends-from', via: 'ottoman' },
  { from: 'kofta-turkish', to: 'yuvarlakia', type: 'cousin-of', via: 'ottoman' },
  { from: 'kofta-turkish', to: 'dawood-basha', type: 'cousin-of', via: 'ottoman' },
  { from: 'kibbeh', to: 'cig-kofte', type: 'cousin-of', via: 'none', note: 'Bulgur-lamb axis, one raw, one fried.' },
  { from: 'kibbeh', to: 'dawood-basha', type: 'cousin-of', via: 'none' },
  { from: 'kibbeh', to: 'shish-barak', type: 'cousin-of', via: 'none' },
  { from: 'koobideh', to: 'kofta-turkish', type: 'cousin-of', via: 'silk_road' },
  { from: 'koobideh', to: 'kofta-mughlai', type: 'migrated-via', via: 'silk_road', note: 'Persian technique carried east by Mughal courts.' },
  { from: 'kofta-mughlai', to: 'malai-kofta', type: 'descends-from', via: 'none' },
  { from: 'kofta-mughlai', to: 'nargisi-kofta', type: 'cousin-of', via: 'silk_road' },
  { from: 'kofta-mughlai', to: 'kufteh-tabrizi', type: 'cousin-of', via: 'silk_road' },
  { from: 'koobideh', to: 'gondi', type: 'cousin-of', via: 'none', note: 'Persian-Jewish adaptation, chickpea flour instead of bulgur.' },
  { from: 'koobideh', to: 'dolma-kufta', type: 'cousin-of', via: 'silk_road' },
  { from: 'kufteh-tabrizi', to: 'dolma-kufta', type: 'cousin-of', via: 'none' },
  { from: 'albondigas', to: 'kofta-turkish', type: 'descends-from', via: 'moorish', note: 'Al-bunduq, the Arabic hazelnut, gave Spain the word.' },
  { from: 'albondigas', to: 'albondigas-mexicana', type: 'migrated-via', via: 'columbian' },
  { from: 'albondigas-mexicana', to: 'chili-meatball-tex', type: 'diaspora-of', via: 'diaspora' },
  { from: 'albondigas', to: 'kefta-tagine', type: 'cousin-of', via: 'moorish' },
  { from: 'kefta-tagine', to: 'kofta-turkish', type: 'cousin-of', via: 'ottoman' },
  { from: 'kefta-tagine', to: 'boulettes-senegalaises', type: 'migrated-via', via: 'diaspora', note: 'French colonial route through North and West Africa.' },
  { from: 'lions-head', to: 'tsukune', type: 'cousin-of', via: 'none' },
  { from: 'lions-head', to: 'bakso', type: 'migrated-via', via: 'diaspora', note: 'Hokkien diaspora into the Dutch East Indies.' },
  { from: 'lions-head', to: 'look-chin', type: 'migrated-via', via: 'diaspora', note: 'Teochew migration into Siam.' },
  { from: 'lions-head', to: 'bola-bola', type: 'migrated-via', via: 'diaspora' },
  { from: 'lions-head', to: 'xiu-mai', type: 'migrated-via', via: 'diaspora' },
  { from: 'lions-head', to: 'kuyteav-meatballs', type: 'migrated-via', via: 'diaspora' },
  { from: 'bakso', to: 'look-chin', type: 'cousin-of', via: 'diaspora' },
  { from: 'look-chin', to: 'kuyteav-meatballs', type: 'cousin-of', via: 'diaspora' },
  { from: 'xiu-mai', to: 'bola-bola', type: 'cousin-of', via: 'diaspora' },
  { from: 'xiu-mai', to: 'polpette', type: 'transformed-by', via: 'diaspora', note: 'French colonial tomato sauce wrapping a Cantonese technique.' },
  { from: 'frikadeller', to: 'kottbullar', type: 'cousin-of', via: 'hanseatic' },
  { from: 'frikadeller', to: 'klopsy', type: 'cousin-of', via: 'hanseatic' },
  { from: 'klopsy', to: 'kottbullar', type: 'cousin-of', via: 'hanseatic' },
  { from: 'frikadeller', to: 'faggots', type: 'cousin-of', via: 'none', note: 'North-Sea pork-and-bread axis.' },
  { from: 'faggots', to: 'polpette', type: 'cousin-of', via: 'none', note: 'Both thrift dishes — old bread, cheap meat.' },
  { from: 'kottbullar', to: 'polpette-al-sugo-american', type: 'cousin-of', via: 'diaspora' },
  { from: 'portuguese-meatball-saimin', to: 'polpette', type: 'cousin-of', via: 'diaspora' },
  { from: 'portuguese-meatball-saimin', to: 'bakso', type: 'cousin-of', via: 'diaspora', note: 'Both plantation-era diaspora meatballs in soup.' },
  { from: 'dombolo-meatballs', to: 'kofta-mughlai', type: 'migrated-via', via: 'diaspora', note: 'Cape Malay route via Indian Ocean indenture.' },
  { from: 'dombolo-meatballs', to: 'albondigas', type: 'cousin-of', via: 'diaspora' },
  { from: 'shilta', to: 'kofta-turkish', type: 'cousin-of', via: 'none' },
  { from: 'laab-balls', to: 'look-chin', type: 'cousin-of', via: 'none' },
  { from: 'maultaschen-meatcore', to: 'shish-barak', type: 'cousin-of', via: 'none', note: 'Meat hidden in pasta — Lenten cunning meets Levantine ravioli.' },
  { from: 'maultaschen-meatcore', to: 'klopsy', type: 'cousin-of', via: 'hanseatic' },
  { from: 'shish-barak', to: 'kofta-mughlai', type: 'cousin-of', via: 'silk_road' },
  { from: 'gondi', to: 'kufteh-tabrizi', type: 'cousin-of', via: 'none' },
  { from: 'nargisi-kofta', to: 'kibbeh', type: 'cousin-of', via: 'silk_road', note: 'Both hide something inside the meat shell.' },
  { from: 'kufteh-tabrizi', to: 'nargisi-kofta', type: 'cousin-of', via: 'silk_road' },
  { from: 'boulettes-senegalaises', to: 'albondigas', type: 'migrated-via', via: 'diaspora', note: 'French boulette technique on West African fish.' },
  { from: 'bola-bola', to: 'albondigas', type: 'cousin-of', via: 'columbian', note: 'Spanish name carried on the Manila galleon.' },
  { from: 'chili-meatball-tex', to: 'polpette-al-sugo-american', type: 'cousin-of', via: 'diaspora' },
  { from: 'cevapi', to: 'koobideh', type: 'cousin-of', via: 'ottoman' },
  { from: 'dawood-basha', to: 'polpette', type: 'cousin-of', via: 'none', note: 'Tomato-braised lamb/beef balls, parallel evolution of the Mediterranean sugo.' },
];
