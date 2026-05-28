// The Tempura/Fish-and-Chips revelation — one Iberian kitchen, two religions, two national dishes.
// Facts verified against Wikipedia + cited sources (see ABOUT modal): Cwiertka 2006, Rath 2016,
// Davidson's Oxford Companion to Food, Roden 1996, Panayi 2014.

export type StoryNode = {
  id: string;
  name: string;
  place: string;
  era: string;
  color: string;
  /** Position in story coordinates — used by the scene reducer. */
  x: number;
  y: number;
};

export type StoryEdge = {
  from: string;
  to: string;
  label?: string;
  color?: string;
};

export type Scene = {
  id: string;
  /** Visible nodes for this scene */
  nodes: string[];
  /** Visible edges for this scene */
  edges: Array<[string, string]>;
  /** Heading text, large */
  heading: string;
  /** Body paragraphs */
  body: string[];
  /** Optional pull-quote text shown over the graph */
  caption?: string;
};

// Warm palette consistent with the rest of Spence Atlas
const COLORS = {
  catholic: '#B85540',     // terracotta — Iberian Catholic root
  portugal: '#E07A2C',     // warm Lisbon orange
  japan: '#D4453E',        // hinomaru-adjacent red
  sephardic: '#7BA05B',    // olive — Sephardic/Mediterranean
  england: '#6FA8D6',      // cool North-Atlantic blue
  ancestor: '#C9B79C',     // neutral cream — abstract concept
};

export const storyNodes: StoryNode[] = [
  {
    id: 'quattuor-tempora',
    name: 'Quattuor Tempora',
    place: 'Catholic Iberia',
    era: 'medieval',
    color: COLORS.ancestor,
    x: 0,
    y: -2,
  },
  {
    id: 'peixinhos-da-horta',
    name: 'Peixinhos da Horta',
    place: 'Portugal',
    era: '~1500s',
    color: COLORS.portugal,
    x: -4,
    y: -0.5,
  },
  {
    id: 'pescado-frito',
    name: 'Pescado Frito',
    place: 'Sephardic Iberia',
    era: '~1492',
    color: COLORS.sephardic,
    x: 4,
    y: -0.5,
  },
  {
    id: 'tempura',
    name: 'Tempura',
    place: 'Nagasaki / Tokyo',
    era: '1543 — present',
    color: COLORS.japan,
    x: -6,
    y: 3,
  },
  {
    id: 'fish-and-chips',
    name: 'Fish & Chips',
    place: 'London',
    era: '~1860',
    color: COLORS.england,
    x: 6,
    y: 3,
  },
];

export const storyEdges: StoryEdge[] = [
  { from: 'quattuor-tempora', to: 'peixinhos-da-horta', label: 'fast-day frying', color: 'rgba(247,237,226,0.55)' },
  { from: 'quattuor-tempora', to: 'pescado-frito', label: 'shared Iberian frying', color: 'rgba(247,237,226,0.55)' },
  { from: 'peixinhos-da-horta', to: 'tempura', label: 'Nanban trade · 1543–1639', color: 'rgba(224,122,44,0.85)' },
  { from: 'pescado-frito', to: 'fish-and-chips', label: 'Sephardic exodus · 1492–1860', color: 'rgba(111,168,214,0.85)' },
  { from: 'tempura', to: 'fish-and-chips', label: 'siblings', color: 'rgba(212,69,62,0.75)' },
];

export const scenes: Scene[] = [
  {
    id: 'hook',
    nodes: ['tempura'],
    edges: [],
    heading: 'Tempura isn\'t Japanese.',
    body: [
      'The shrimp is. The dipping sauce is. But the actual technique — wet batter, hot oil, a fast fry that leaves the inside steam-cooked — came in on a Portuguese ship in 1543.',
      'It is, almost word-for-word, a Catholic fasting workaround.',
    ],
  },
  {
    id: 'ember-days',
    nodes: ['tempura', 'quattuor-tempora'],
    edges: [],
    heading: 'It starts with a calendar.',
    body: [
      'Every spring, summer, autumn, and winter, the medieval Catholic church called three days of fasting. No meat. Twelve days a year, devout kitchens across Iberia cooked without flesh. The Latin name for these four seasons of fasting was quattuor tempora — "the four times."',
      'But Catholic doctrine had a quiet loophole: oil was not meat. You could fry.',
      'So Portuguese cooks battered whatever was in the garden and dropped it in hot oil — substantial enough to fill the plate, legal enough to keep the rule.',
    ],
  },
  {
    id: 'peixinhos',
    nodes: ['tempura', 'quattuor-tempora', 'peixinhos-da-horta'],
    edges: [['quattuor-tempora', 'peixinhos-da-horta']],
    heading: 'Little fish from the garden.',
    body: [
      'They called it peixinhos da horta — "little fish from the garden." Green beans, dipped in flour-and-water batter, deep-fried until they curled and cracked. The point was that they looked like small fried fish. They weren\'t. That was the joke, and the loophole.',
      'Lisbon kitchens still make them. They were making them in the 1500s, too, when Portugal had the fastest ships in Europe and was about to discover Japan by accident.',
    ],
    caption: 'Lisbon · c. 1500',
  },
  {
    id: 'nanban',
    nodes: ['tempura', 'quattuor-tempora', 'peixinhos-da-horta'],
    edges: [
      ['quattuor-tempora', 'peixinhos-da-horta'],
      ['peixinhos-da-horta', 'tempura'],
    ],
    heading: 'Tanegashima, 1543.',
    body: [
      'A storm blows a Chinese trading junk into a small island south of Kyushu. Three Portuguese sailors are aboard, working passage home. The local lord buys their muskets — the first firearms ever seen in Japan — and suddenly Japan is very interested in Portuguese visitors.',
      'Within twenty years, Nagasaki is a Portuguese trading port. Jesuit priests follow, Francis Xavier among them, and they bring everything: the gun, the rosary, and the kitchen. The kitchen includes battered, deep-fried vegetables, eaten on the fasting days they call tempora.',
      'The Japanese borrow the word straight from the Latin. They write it 天ぷら.',
    ],
    caption: 'Nanban trade · 1543 – 1639',
  },
  {
    id: 'sakoku',
    nodes: ['tempura', 'quattuor-tempora', 'peixinhos-da-horta'],
    edges: [
      ['quattuor-tempora', 'peixinhos-da-horta'],
      ['peixinhos-da-horta', 'tempura'],
    ],
    heading: '1639. The door closes.',
    body: [
      'A failed Christian uprising scares the shogun. He expels the Portuguese, executes the priests, bans the religion. Japan declares itself sakoku — "the closed country" — and seals its ports for the next two hundred and twenty years.',
      'The recipe does not leave with them. Edo street vendors are already selling battered shrimp on skewers, hot from the oil. The batter gets lighter, the technique gets neater. By the time Japan reopens in the 1860s, tempura is unambiguously Japanese — a national dish whose name is medieval Latin and whose technique is Iberian Catholic.',
    ],
  },
  {
    id: 'fork',
    nodes: ['tempura', 'quattuor-tempora', 'peixinhos-da-horta'],
    edges: [
      ['quattuor-tempora', 'peixinhos-da-horta'],
      ['peixinhos-da-horta', 'tempura'],
    ],
    heading: 'Same kitchen, second religion.',
    body: [
      'While Catholic Portugal was sending its battered vegetables east, the same Iberian kitchen was already sending its battered fish in the other direction.',
      'For one reason: it wasn\'t only Catholics living in it.',
    ],
  },
  {
    id: 'sephardic',
    nodes: ['tempura', 'quattuor-tempora', 'peixinhos-da-horta', 'pescado-frito'],
    edges: [
      ['quattuor-tempora', 'peixinhos-da-horta'],
      ['peixinhos-da-horta', 'tempura'],
      ['quattuor-tempora', 'pescado-frito'],
    ],
    heading: 'Pescado frito.',
    body: [
      'Sephardic — from Sefarad, the Hebrew name for Spain — Jews had lived in Iberia for eight hundred years. They cooked in the same kitchens, with the same oil, the same batter, the same technique as their Catholic neighbors.',
      'On Friday afternoons they fried fish ahead of the Sabbath — when cooking is forbidden — and ate it cold the next day. Same workaround as the Catholics, different rule.',
      'Then 1492 happened. The Catholic Monarchs expelled the Jews from Spain. Portugal followed in 1497. The Sephardim scattered — to Amsterdam, to London, to Salonica, to the Ottoman Empire. Their kitchens went with them. Including the cold fried fish.',
    ],
    caption: 'Sephardic exodus · 1492',
  },
  {
    id: 'london',
    nodes: ['tempura', 'quattuor-tempora', 'peixinhos-da-horta', 'pescado-frito', 'fish-and-chips'],
    edges: [
      ['quattuor-tempora', 'peixinhos-da-horta'],
      ['peixinhos-da-horta', 'tempura'],
      ['quattuor-tempora', 'pescado-frito'],
      ['pescado-frito', 'fish-and-chips'],
    ],
    heading: 'London, 1860.',
    body: [
      'A teenager named Joseph Malin opens a fried-fish shop in Bow, East London. His family is Ashkenazi — Eastern European — but the dish he\'s selling came from the Sephardic Jews who had been in London since Cromwell allowed them back in 1656. Cold battered fish, the way it had been done in Lisbon and Seville for centuries.',
      'Malin\'s contribution was the second half. He paired the fried fish with potatoes — cut into batons, fried in beef tallow — a Northern European street food that already existed on its own. Chips.',
      'Nobody had thought to sell the two together. Within fifty years, fish and chips is the British national dish. Almost nobody remembers it started Jewish.',
    ],
    caption: 'Malin\'s shop, Bow · 1860',
  },
  {
    id: 'reveal',
    nodes: ['tempura', 'quattuor-tempora', 'peixinhos-da-horta', 'pescado-frito', 'fish-and-chips'],
    edges: [
      ['quattuor-tempora', 'peixinhos-da-horta'],
      ['peixinhos-da-horta', 'tempura'],
      ['quattuor-tempora', 'pescado-frito'],
      ['pescado-frito', 'fish-and-chips'],
      ['tempura', 'fish-and-chips'],
    ],
    heading: 'Tempura and fish-and-chips are siblings.',
    body: [
      'One Iberian kitchen. Two religious calendars — one with Lent, one with Shabbat — that both needed a way to make oil-fried food count as a meatless meal.',
      'Two empires didn\'t carry the recipe out of Iberia. Two diasporas did. One voluntary, with Portuguese Jesuits in 1543. One forced, with Sephardic exiles starting in 1492. They went in opposite directions and built two national dishes that look nothing alike and share everything.',
      'Almost nobody knows this. You do now.',
    ],
    caption: 'Two national dishes · one Iberian kitchen',
  },
];
