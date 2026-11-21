export interface DetectedLanguageInfo {
  code: string;
  label: string;
  confidence: number;
}

export interface StreamLanguageDetection {
  primary: DetectedLanguageInfo | null;
  languages: DetectedLanguageInfo[];
}

// 95+ ISO 639-1 / BCP-47 base languages supported by Gemini multimodal audio & text models
export const GEMINI_SUPPORTED_LANGUAGE_LABELS: Record<string, string> = {
  af: 'Afrikaans',
  sq: 'Albanian',
  am: 'Amharic',
  ar: 'Arabic',
  hy: 'Armenian',
  az: 'Azerbaijani',
  eu: 'Basque',
  be: 'Belarusian',
  bn: 'Bengali',
  bs: 'Bosnian',
  bg: 'Bulgarian',
  my: 'Burmese',
  ca: 'Catalan',
  zh: 'Mandarin Chinese',
  hr: 'Croatian',
  cs: 'Czech',
  da: 'Danish',
  nl: 'Dutch',
  en: 'English',
  et: 'Estonian',
  fil: 'Filipino',
  fi: 'Finnish',
  fr: 'French',
  gl: 'Galician',
  ka: 'Georgian',
  de: 'German',
  el: 'Greek',
  gu: 'Gujarati',
  ht: 'Haitian Creole',
  ha: 'Hausa',
  he: 'Hebrew',
  hi: 'Hindi',
  hu: 'Hungarian',
  is: 'Icelandic',
  ig: 'Igbo',
  id: 'Indonesian',
  ga: 'Irish',
  it: 'Italian',
  ja: 'Japanese',
  jv: 'Javanese',
  kn: 'Kannada',
  kk: 'Kazakh',
  km: 'Khmer',
  ko: 'Korean',
  ky: 'Kyrgyz',
  lo: 'Lao',
  lv: 'Latvian',
  lt: 'Lithuanian',
  lb: 'Luxembourgish',
  mk: 'Macedonian',
  mg: 'Malagasy',
  ms: 'Malay',
  ml: 'Malayalam',
  mt: 'Maltese',
  mi: 'Maori',
  mr: 'Marathi',
  mn: 'Mongolian',
  ne: 'Nepali',
  no: 'Norwegian',
  or: 'Odia',
  ps: 'Pashto',
  fa: 'Persian',
  pl: 'Polish',
  pt: 'Portuguese',
  pa: 'Punjabi',
  ro: 'Romanian',
  ru: 'Russian',
  sr: 'Serbian',
  sd: 'Sindhi',
  si: 'Sinhala',
  sk: 'Slovak',
  sl: 'Slovenian',
  so: 'Somali',
  es: 'Spanish',
  su: 'Sundanese',
  sw: 'Swahili',
  sv: 'Swedish',
  tg: 'Tajik',
  ta: 'Tamil',
  te: 'Telugu',
  th: 'Thai',
  tr: 'Turkish',
  uk: 'Ukrainian',
  ur: 'Urdu',
  uz: 'Uzbek',
  vi: 'Vietnamese',
  cy: 'Welsh',
  xh: 'Xhosa',
  yi: 'Yiddish',
  yo: 'Yoruba',
  zu: 'Zulu',
  other: 'Other',
};

const displayNames =
  typeof Intl !== 'undefined' && typeof Intl.DisplayNames === 'function'
    ? new Intl.DisplayNames(['en'], { type: 'language' })
    : null;

export function normalizeLanguageBase(code: string): string {
  const lower = (code || '').trim().toLowerCase();
  if (!lower) return 'other';
  const base = lower.split(/[-_]/)[0];
  return GEMINI_SUPPORTED_LANGUAGE_LABELS[base] ? base : base || 'other';
}

export function getLanguageLabel(code: string): string {
  const base = normalizeLanguageBase(code);
  if (GEMINI_SUPPORTED_LANGUAGE_LABELS[base]) {
    return GEMINI_SUPPORTED_LANGUAGE_LABELS[base];
  }
  if (displayNames && base !== 'other') {
    try {
      const resolved = displayNames.of(base);
      if (resolved && resolved.toLowerCase() !== base) {
        return resolved;
      }
    } catch {
      // ignore invalid BCP-47 fallback
    }
  }
  return code.toUpperCase();
}

const KEYWORD_LEXICON: Record<
  'en' | 'de' | 'es' | 'it' | 'fr' | 'pt' | 'nl' | 'pl' | 'tr' | 'id' | 'sv',
  string[]
> = {
  en: [
    'hi',
    'hello',
    'hey',
    'please',
    'thank',
    'thanks',
    'could',
    'would',
    'can',
    'one',
    'two',
    'three',
    'takeaway',
    'delivery',
    'order',
    'sorry',
    'noisy',
    'well',
    'done',
    'sparkling',
    'drink',
    'water',
    'without',
    'extra',
    'slices',
    'gluten',
    'free',
    'for',
    'me',
    'and',
    'the',
  ],
  de: [
    'hallo',
    'bitte',
    'danke',
    'und',
    'für',
    'fur',
    'mich',
    'eine',
    'einen',
    'ein',
    'zwei',
    'drei',
    'mit',
    'ohne',
    'noch',
    'aber',
    'unbedingt',
    'glutenfrei',
    'schatz',
    'sag',
    'ich',
    'möchte',
    'mochte',
    'keine',
    'kein',
    'extra',
    'scharf',
    'zum',
    'mitnehmen',
  ],
  es: [
    'hola',
    'buenas',
    'buenos',
    'por',
    'favor',
    'gracias',
    'quiero',
    'para',
    'llevar',
    'una',
    'uno',
    'dos',
    'tres',
    'sin',
    'con',
    'más',
    'mas',
    'donde',
    'dónde',
    'está',
    'esta',
    'caja',
    'mesa',
    'pedido',
    'aqui',
    'aquí',
    'ahora',
    'muy',
    'bien',
    'pero',
  ],
  it: [
    'buongiorno',
    'buonasera',
    'ciao',
    'salve',
    'vorrei',
    'grazie',
    'prego',
    'scusi',
    'subito',
    'allora',
    'asporto',
    'taglio',
    'fette',
    'senza',
    'due',
    'tre',
    'quattro',
    'forno',
    'banco',
    'cucina',
    'pronto',
    'bene',
    'ecco',
    'questo',
    'quella',
    'favore',
    'una',
    'con',
  ],
  fr: [
    'bonjour',
    'bonsoir',
    'salut',
    'merci',
    'je',
    'voudrais',
    'une',
    'deux',
    'trois',
    'avec',
    'sans',
    'pour',
    'emporter',
    'plaît',
    'plait',
    'sil',
    'vous',
    'commande',
    'livraison',
  ],
  pt: [
    'olá',
    'ola',
    'obrigado',
    'obrigada',
    'quero',
    'gostaria',
    'uma',
    'duas',
    'dois',
    'para',
    'por',
    'levar',
    'viagem',
    'sem',
    'com',
    'não',
    'nao',
    'bom',
    'dia',
    'favor',
    'entrega',
    'posso',
    'mais',
  ],
  nl: [
    'hallo',
    'alstublieft',
    'dank',
    'bedankt',
    'ik',
    'wil',
    'graag',
    'een',
    'twee',
    'zonder',
    'met',
    'meenemen',
    'bestellen',
  ],
  pl: [
    'dzień',
    'dobry',
    'cześć',
    'proszę',
    'prosze',
    'dziękuję',
    'dziekuje',
    'chciałbym',
    'poproszę',
    'jedną',
    'dwie',
    'bez',
    'wynos',
  ],
  tr: [
    'merhaba',
    'lütfen',
    'lutfen',
    'teşekkür',
    'tesekkur',
    'istiyorum',
    'bir',
    'iki',
    'olsun',
    'olmasın',
    'paket',
    'sipariş',
  ],
  id: [
    'halo',
    'selamat',
    'terima',
    'kasih',
    'tolong',
    'saya',
    'pesan',
    'satu',
    'dua',
    'tanpa',
    'dengan',
    'bungkus',
  ],
  sv: [
    'hej',
    'tack',
    'snälla',
    'jag',
    'vill',
    'beställa',
    'en',
    'två',
    'utan',
    'med',
  ],
};

export function detectStreamLanguages(rawText: string): StreamLanguageDetection {
  const text = (rawText || '').trim();
  if (!text) {
    return { primary: null, languages: [] };
  }

  const scores: Record<string, number> = {};
  const addScore = (code: string, points: number) => {
    scores[code] = (scores[code] ?? 0) + points;
  };

  // 1. Deterministic non-Latin script detection across Gemini's 90+ languages
  const kanaCount = (text.match(/[\u3040-\u309F\u30A0-\u30FF]/g) || []).length;
  const hanCount = (text.match(/[\u4E00-\u9FFF]/g) || []).length;
  if (kanaCount >= 1) {
    addScore('ja', Math.min(20, (kanaCount + hanCount) * 2.5));
  } else if (hanCount >= 1) {
    addScore('zh', Math.min(20, hanCount * 2.5));
  }

  const hangulCount = (text.match(/[\uAC00-\uD7AF\u1100-\u11FF]/g) || []).length;
  if (hangulCount >= 1) addScore('ko', Math.min(20, hangulCount * 2.5));

  const greekCount = (text.match(/[\u0370-\u03FF\u1F00-\u1FFF]/g) || []).length;
  if (greekCount >= 2) addScore('el', Math.min(20, greekCount * 1.5));

  const arabicCount = (text.match(/[\u0600-\u06FF]/g) || []).length;
  if (arabicCount >= 2) {
    if (/[ٹڈڑںے]/.test(text)) addScore('ur', Math.min(20, arabicCount * 2));
    else if (/[پچژگ]/.test(text)) addScore('fa', Math.min(20, arabicCount * 2));
    else addScore('ar', Math.min(20, arabicCount * 1.8));
  }

  const cyrillicCount = (text.match(/[\u0400-\u04FF]/g) || []).length;
  if (cyrillicCount >= 2) {
    if (/[іїєґІЇЄҐ]/.test(text)) addScore('uk', Math.min(20, cyrillicCount * 2));
    else if (/[ђјљњћџЂЈЉЊЋЏ]/.test(text)) addScore('sr', Math.min(20, cyrillicCount * 2));
    else addScore('ru', Math.min(20, cyrillicCount * 1.6));
  }

  if (/[\u0590-\u05FF]/.test(text)) addScore('he', 10);
  if (/[\u0900-\u097F]/.test(text)) addScore('hi', 10);
  if (/[\u0980-\u09FF]/.test(text)) addScore('bn', 10);
  if (/[\u0A00-\u0A7F]/.test(text)) addScore('pa', 10);
  if (/[\u0A80-\u0AFF]/.test(text)) addScore('gu', 10);
  if (/[\u0B80-\u0BFF]/.test(text)) addScore('ta', 10);
  if (/[\u0C00-\u0C7F]/.test(text)) addScore('te', 10);
  if (/[\u0C80-\u0CFF]/.test(text)) addScore('kn', 10);
  if (/[\u0D00-\u0D7F]/.test(text)) addScore('ml', 10);
  if (/[\u0D80-\u0DFF]/.test(text)) addScore('si', 10);
  if (/[\u0E00-\u0E7F]/.test(text)) addScore('th', 10);
  if (/[\u0E80-\u0EFF]/.test(text)) addScore('lo', 10);
  if (/[\u1000-\u109F]/.test(text)) addScore('my', 10);
  if (/[\u10A0-\u10FF]/.test(text)) addScore('ka', 10);
  if (/[\u0530-\u058F]/.test(text)) addScore('hy', 10);
  if (/[\u1200-\u137F]/.test(text)) addScore('am', 10);
  if (/[\u1780-\u17FF]/.test(text)) addScore('km', 10);

  // 2. Latin-script diacritic signals
  if (/[äöüßÄÖÜ]/.test(text)) addScore('de', 4);
  if (/[ñÑ¿¡]/.test(text)) addScore('es', 4.5);
  if (/[çÇœŒêÊàÀ]/.test(text)) addScore('fr', 3);
  if (/[ãõÃÕ]/.test(text)) addScore('pt', 4.5);
  if (/[łśźćżńŁŚŹĆŻŃ]/.test(text)) addScore('pl', 5);
  if (/[ğüşöçıĞÜŞÖÇİ]/.test(text)) addScore('tr', 4.5);
  if (/[ăâđêôơưĂÂĐÊÔƠƯ]/.test(text)) addScore('vi', 5);
  if (/[șțȘȚ]/.test(text)) addScore('ro', 5);
  if (/[åÅøØæÆ]/.test(text)) addScore('sv', 4);

  // 3. Token-level lexical scoring
  const tokens = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s'-]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);

  for (const token of tokens) {
    (Object.keys(KEYWORD_LEXICON) as Array<keyof typeof KEYWORD_LEXICON>).forEach((lang) => {
      if (KEYWORD_LEXICON[lang].includes(token)) {
        addScore(lang, 2);
      }
    });
  }

  // Multi-word strong phrases
  const lower = text.toLowerCase();
  if (lower.includes('para llevar')) addScore('es', 4.5);
  if (lower.includes('por favor')) {
    addScore('es', 1.5);
    addScore('pt', 1.5);
  }
  if (lower.includes('per favore') || lower.includes('buongiorno')) addScore('it', 4);
  if (lower.includes('glutenfrei') || lower.includes('für mich')) addScore('de', 4);
  if (lower.includes("s'il vous plaît") || lower.includes('je voudrais')) addScore('fr', 5);
  if (
    lower.includes('obrigado') ||
    lower.includes('obrigada') ||
    lower.includes('para levar') ||
    lower.includes('para viagem') ||
    lower.includes('gostaria de')
  ) {
    addScore('pt', 4.5);
  }
  if (lower.includes('terima kasih')) addScore('id', 5);
  if (lower.includes('well done') || lower.includes('could we') || lower.includes('thank you')) {
    addScore('en', 3.5);
  }

  const ranked = Object.entries(scores)
    .filter(([, score]) => score >= 2)
    .sort(([, a], [, b]) => b - a);

  if (ranked.length === 0) {
    if (/[a-zA-Z]/.test(text)) {
      const fallback: DetectedLanguageInfo = {
        code: 'en',
        label: 'English',
        confidence: 0.55,
      };
      return { primary: fallback, languages: [fallback] };
    }
    return { primary: null, languages: [] };
  }

  const totalScore = ranked.reduce((acc, [, s]) => acc + s, 0);
  const topScore = ranked[0][1];

  const languages: DetectedLanguageInfo[] = ranked
    .filter(([, s], idx) => idx === 0 || s >= Math.max(3.5, topScore * 0.28))
    .slice(0, 5)
    .map(([code, score]) => ({
      code,
      label: getLanguageLabel(code),
      confidence: Number(Math.min(0.99, Math.max(0.55, score / Math.max(4, totalScore))).toFixed(2)),
    }));

  return {
    primary: languages[0] ?? null,
    languages,
  };
}
