import type { ChaosScenario, PizzaMenuItem } from '../types/voicepizza';

export const PIZZERIA_MENU: PizzaMenuItem[] = [
  {
    id: 'margherita-dop',
    sku: 'VP-PIZ-MARG-01',
    name: 'Margherita DOP',
    italianName: 'Margherita Verace DOP',
    category: 'Classiche',
    priceCents: 1450,
    prepMinutes: 6,
    allergens: ['gluten', 'dairy'],
    description: 'San Marzano DOP tomatoes, fior di latte mozzarella, fresh basil, cold-pressed olive oil.',
    imageUrl: '/src/assets/images/pizza_margherita_dop_1795280908611.jpg',
    available: true,
  },
  {
    id: 'diavola-piccante',
    sku: 'VP-PIZ-DIAV-02',
    name: 'Diavola Piccante',
    italianName: 'Diavola Calabrese',
    category: 'Classiche',
    priceCents: 1750,
    prepMinutes: 7,
    allergens: ['gluten', 'dairy'],
    description: 'Spicy Calabrian salame cups, crushed red chili, San Marzano base, fior di latte, basil.',
    imageUrl: '/src/assets/images/pizza_diavola_piccante_1795280908474.jpg',
    available: true,
  },
  {
    id: 'tartufo-funghi',
    sku: 'VP-PIZ-TART-03',
    name: 'Tartufo & Porcini',
    italianName: 'Bianca al Tartufo e Porcini',
    category: 'Speciali',
    priceCents: 2100,
    prepMinutes: 8,
    allergens: ['gluten', 'dairy'],
    description: 'Roasted wild porcini mushrooms, creamy Pugliese stracciatella, shaved black truffle, thyme.',
    imageUrl: '/src/assets/images/pizza_tartufo_funghi_1795280909298.jpg',
    available: true,
  },
  {
    id: 'marinara-vegana',
    sku: 'VP-PIZ-MARI-04',
    name: 'Marinara Classica',
    italianName: 'Marinara Antica',
    category: 'Classiche',
    priceCents: 1200,
    prepMinutes: 5,
    allergens: ['gluten'],
    description: 'Crushed San Marzano tomatoes, roasted garlic slivers, wild mountain oregano, extra virgin olive oil (dairy-free).',
    imageUrl: '/src/assets/images/pizza_margherita_dop_1795280908611.jpg',
    available: true,
  },
  {
    id: 'burrata-prosciutto',
    sku: 'VP-PIZ-BURR-05',
    name: 'Prosciutto & Burrata',
    italianName: 'Crudo di Parma e Burrata',
    category: 'Speciali',
    priceCents: 2050,
    prepMinutes: 7,
    allergens: ['gluten', 'dairy'],
    description: '24-month Prosciutto di Parma, whole creamy burrata, wild arugula, aged Parmigiano shavings.',
    imageUrl: '/src/assets/images/pizza_diavola_piccante_1795280908474.jpg',
    available: true,
  },
  {
    id: 'tiramisu-casa',
    sku: 'VP-DES-TIRA-06',
    name: 'Tiramisu della Casa',
    italianName: 'Tiramisu Artigianale',
    category: 'Contorni & Bevande',
    priceCents: 850,
    prepMinutes: 2,
    allergens: ['gluten', 'dairy', 'eggs'],
    description: 'Espresso-soaked savoiardi, whipped mascarpone cream, dark Valrhona cocoa.',
    imageUrl: '/src/assets/images/hero_pizzeria_counter_1795280909275.jpg',
    available: true,
  },
  {
    id: 'chinotto-sparkling',
    sku: 'VP-BEV-CHIN-07',
    name: 'Lurisia Chinotto & Sparkling',
    italianName: 'Bibita Chinotto / Acqua Frizzante',
    category: 'Contorni & Bevande',
    priceCents: 450,
    prepMinutes: 1,
    allergens: [],
    description: 'Chilled Italian citrus soda or crisp Alpine sparkling mineral water (500ml).',
    imageUrl: '/src/assets/images/hero_pizzeria_counter_1795280909275.jpg',
    available: true,
  },
];

export const CHAOS_SCENARIOS: ChaosScenario[] = [
  {
    id: 'p1-phone-uk-de',
    channel: 'phone',
    title: 'P1 · Phone Line: British Husband + German Wife',
    subtitle: 'Single incoming takeaway phone call during Friday rush with two simultaneous languages.',
    tracks: [
      {
        id: 'trk-uk-1',
        speakerLabel: 'Husband (British English)',
        languageCode: 'en-GB',
        languageName: 'British English',
        role: 'customer_primary',
        voiceName: 'Charon',
        text: 'Hi there, sorry it is noisy here—could we do a takeaway Margherita DOP, well done, and one sparkling drink please?',
        delaySeconds: 0,
      },
      {
        id: 'trk-de-1',
        speakerLabel: 'Wife (German)',
        languageCode: 'de-DE',
        languageName: 'German',
        role: 'customer_companion',
        voiceName: 'Kore',
        text: 'Schatz, sag bitte noch eine Diavola Piccante für mich, aber unbedingt glutenfrei ohne Chili-Flocken extra, und ein Tiramisu!',
        delaySeconds: 1.4,
      },
    ],
    expectedOrderItems: [
      { menuItemId: 'margherita-dop', quantity: 1, assignedTo: 'Husband (en-GB)' },
      { menuItemId: 'chinotto-sparkling', quantity: 1, assignedTo: 'Husband (en-GB)' },
      { menuItemId: 'diavola-piccante', quantity: 1, assignedTo: 'Wife (de-DE)' },
      { menuItemId: 'tiramisu-casa', quantity: 1, assignedTo: 'Wife (de-DE)' },
    ],
  },
  {
    id: 'p2-counter-6lang',
    channel: 'counter',
    title: 'P2 · Counter Chaos: 6 Languages At Once',
    subtitle: 'English + German couple ordering while Greek guest complains, Chinese supplier delivers tomatoes, Spanish clerk & Italian owner talk across the pass.',
    tracks: [
      {
        id: 'trk-c-en',
        speakerLabel: 'Customer 1 (English)',
        languageCode: 'en-GB',
        languageName: 'English',
        role: 'customer_primary',
        voiceName: 'Charon',
        text: 'Excuse me, takeaway order: one Tartufo and Porcini pizza and two Margherita DOPs.',
        delaySeconds: 0,
      },
      {
        id: 'trk-c-de',
        speakerLabel: 'Wife (German)',
        languageCode: 'de-DE',
        languageName: 'German',
        role: 'customer_companion',
        voiceName: 'Kore',
        text: 'Und für mich bitte noch eine Marinara Classica mit extra Knoblauch für zum Mitnehmen.',
        delaySeconds: 0.9,
      },
      {
        id: 'trk-c-el',
        speakerLabel: 'Queue Guest (Greek)',
        languageCode: 'el-GR',
        languageName: 'Greek',
        role: 'queue_complaint',
        voiceName: 'Fenrir',
        text: 'Ρε φίλε, περιμένω είκοσι λεπτά για το τραπέζι τέσσερα! Πού είναι οι πίτσες μας;',
        delaySeconds: 1.5,
      },
      {
        id: 'trk-c-zh',
        speakerLabel: 'Supplier (Mandarin)',
        languageCode: 'zh-CN',
        languageName: 'Mandarin Chinese',
        role: 'supplier_delivery',
        voiceName: 'Puck',
        text: '老板你好！二十箱圣马扎诺番茄和面粉送到后门了，请问谁能签收一下？',
        delaySeconds: 2.1,
      },
      {
        id: 'trk-c-es',
        speakerLabel: 'Counter Clerk (Spanish)',
        languageCode: 'es-ES',
        languageName: 'Spanish',
        role: 'counter_staff',
        voiceName: 'Zephyr',
        text: 'Perdón señor, no entiendo alemán ni griego, ¡un momento por favor!',
        delaySeconds: 2.7,
      },
      {
        id: 'trk-c-it',
        speakerLabel: 'Owner (Italian)',
        languageCode: 'it-IT',
        languageName: 'Italian',
        role: 'counter_staff',
        voiceName: 'Charon',
        text: 'Marco! Il forno è a quattrocento gradi, porta fuori la Diavola del tavolo due subito!',
        delaySeconds: 3.1,
      },
    ],
    expectedOrderItems: [
      { menuItemId: 'tartufo-funghi', quantity: 1, assignedTo: 'Customer 1 (en-GB)' },
      { menuItemId: 'margherita-dop', quantity: 2, assignedTo: 'Customer 1 (en-GB)' },
      { menuItemId: 'marinara-vegana', quantity: 1, assignedTo: 'Wife (de-DE)' },
    ],
  },
];

const MENU_ALIASES: Record<string, string[]> = {
  'margherita-dop': ['margherita', 'margarita', 'marguerita', 'classic cheese', 'cheese pizza'],
  'diavola-piccante': ['diavola', 'diabola', 'pepperoni', 'spicy salami', 'spicy salame', 'piccante', 'calabrese'],
  'tartufo-funghi': ['tartufo', 'truffle', 'porcini', 'mushroom', 'funghi'],
  'marinara-vegana': ['marinara', 'vegan', 'dairy free', 'dairy-free', 'no cheese'],
  'burrata-prosciutto': ['burrata', 'prosciutto', 'crudo', 'parma'],
  'tiramisu-casa': ['tiramisu', 'tiramisù', 'dessert'],
  'chinotto-sparkling': ['chinotto', 'sparkling', 'soda', 'water', 'acqua', 'frizzante', 'drink', 'beverage', 'lurisia'],
};

export function findMenuItemByIdOrName(idOrName: string): PizzaMenuItem | undefined {
  const q = (idOrName || '').trim().toLowerCase();
  if (!q) return undefined;

  // 1. Exact ID, SKU, or full name match
  const exact = PIZZERIA_MENU.find(
    (item) =>
      item.id.toLowerCase() === q ||
      item.sku.toLowerCase() === q ||
      item.name.toLowerCase() === q ||
      item.italianName.toLowerCase() === q
  );
  if (exact) return exact;

  // 2. Substring match in either direction (e.g. "margherita pizza" vs "margherita dop")
  const normalized = q.replace(/[^a-z0-9\s-]/g, ' ').replace(/\s+/g, ' ').trim();
  const partial = PIZZERIA_MENU.find((item) => {
    const nameLower = item.name.toLowerCase();
    const itLower = item.italianName.toLowerCase();
    return (
      nameLower.includes(normalized) ||
      normalized.includes(nameLower) ||
      itLower.includes(normalized) ||
      normalized.includes(itLower)
    );
  });
  if (partial) return partial;

  // 3. Alias / keyword match for natural customer speech
  for (const [id, aliases] of Object.entries(MENU_ALIASES)) {
    if (aliases.some((alias) => normalized.includes(alias))) {
      return PIZZERIA_MENU.find((item) => item.id === id);
    }
  }

  return undefined;
}
