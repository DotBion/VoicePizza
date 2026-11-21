export type VoiceArchitecture = 'cascaded' | 'gemini-live';

export type StationChannel = 'phone' | 'counter';

export type OrderStatus = 'incoming' | 'oven' | 'ready' | 'paid';

export type SpeakerRole =
  | 'customer_primary'
  | 'customer_companion'
  | 'counter_staff'
  | 'supplier_delivery'
  | 'queue_complaint'
  | 'other';

export interface PizzaMenuItem {
  id: string;
  sku: string;
  name: string;
  italianName: string;
  category: 'Classiche' | 'Speciali' | 'Contorni & Bevande';
  priceCents: number;
  prepMinutes: number;
  allergens: string[];
  description: string;
  imageUrl: string;
  available: boolean;
}

export interface OrderLineItem {
  menuItemId: string;
  sku: string;
  name: string;
  quantity: number;
  unitPriceCents: number;
  assignedTo: string;
  languageCode: string;
  modifiers: string[];
}

export interface OrderTicket {
  id: string;
  ticketNumber: number;
  channel: StationChannel;
  architecture: VoiceArchitecture;
  partyLabel: string;
  languages: string[];
  status: OrderStatus;
  items: OrderLineItem[];
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
  kitchenNoteIt: string;
  counterNoteEs: string;
  allergenFlag: boolean;
  createdAt: string;
  confirmedAt: string;
  updatedAt: string;
  shopifyDraftOrderId?: string;
}

export interface DecisionTriageResult {
  isOrderIntent: {
    probability: number;
    confidence: number;
    passed: boolean;
  };
  speakerRole: {
    choice: SpeakerRole;
    confidence: number;
  };
  primaryLanguage: {
    choice: string;
    confidence: number;
  };
  chaosSeverity: {
    score: number;
    normalized: number;
    label: string;
    confidence: number;
  };
  evaluatedAt: string;
}

export interface SpeakerAttributionSegment {
  speakerLabel: string;
  languageCode: string;
  role: SpeakerRole;
  utterance: string;
  englishGloss: string;
  extractedItems: Array<{
    menuItemId: string;
    quantity: number;
    modifiers: string[];
    assignedTo: string;
  }>;
  replyText: string;
  replyLanguageCode: string;
}

export interface TranscriptEntry {
  id: string;
  timestamp: string;
  architecture: VoiceArchitecture;
  channel: StationChannel;
  rawTranscript: string;
  segments: SpeakerAttributionSegment[];
  agentReplySummary: string;
  replyAudioBase64?: string;
  replyAudioMimeType?: string;
  triage?: DecisionTriageResult;
  modelsUsed: string[];
  latencyMs: number;
}

export interface NonOrderAlert {
  id: string;
  timestamp: string;
  role: SpeakerRole;
  languageCode: string;
  summary: string;
  staffActionEs: string;
  staffActionIt: string;
  resolved: boolean;
}

export interface ChaosTrackLine {
  id: string;
  speakerLabel: string;
  languageCode: string;
  languageName: string;
  role: SpeakerRole;
  voiceName: 'Puck' | 'Charon' | 'Kore' | 'Fenrir' | 'Zephyr';
  text: string;
  delaySeconds: number;
}

export interface ChaosScenario {
  id: string;
  channel: StationChannel;
  title: string;
  subtitle: string;
  tracks: ChaosTrackLine[];
  expectedOrderItems: Array<{
    menuItemId: string;
    quantity: number;
    assignedTo: string;
  }>;
}

export interface StressLevelResult {
  level: number;
  label: string;
  concurrentSpeakers: number;
  noiseDbLabel: string;
  baselineModel: string;
  baselineLatencyMs: number;
  baselineRecall: number;
  baselineErrorNote: string;
  orchestratedModels: string[];
  orchestratedLatencyMs: number;
  orchestratedRecall: number;
  decisionTriageConfidence: number;
  status: 'passed' | 'degraded' | 'broke';
  rawAudioBenefitNote: string;
}

export interface SessionState {
  sessionId: string | null;
  active: boolean;
  architecture: VoiceArchitecture;
  channel: StationChannel;
  startedAt: string | null;
}
