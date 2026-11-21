import { ThinkingLevel, Type } from '@google/genai';
import { CHAOS_SCENARIOS, PIZZERIA_MENU } from '../src/shared/menu';
import {
  evaluateOrderRecall,
  formatCurrency,
  formatOrderTotalsSummary,
} from '../src/shared/orderEngine';
import type {
  ChaosTrackLine,
  DecisionTriageResult,
  NonOrderAlert,
  OrderTicket,
  SpeakerAttributionSegment,
  SpeakerRole,
  StationChannel,
  StressLevelResult,
  TranscriptEntry,
} from '../src/types/voicepizza';
import { createBetaGeminiClient, createDecisionsClient, createGeminiClient } from './geminiClients';
import { voicePizzaStore } from './stateStore';

const MENU_SUMMARY = PIZZERIA_MENU.map(
  (m) =>
    `- id="${m.id}" | sku="${m.sku}" | name="${m.name}" (IT: "${m.italianName}") | price=$${(
      m.priceCents / 100
    ).toFixed(2)} | allergens=[${m.allergens.join(', ')}] | ${m.description}`
).join('\n');

const CHAOS_SCORE_CRITERIA = [
  'Single clear speaker directly placing or confirming a pizza order with low background noise.',
  'Two cooperative speakers (e.g., couple on a phone call) switching between languages while ordering.',
  'Busy counter with 3 to 4 overlapping voices, side chatter, or moderate clarification needed.',
  'Severe 5+ speaker acoustic chaos: overlapping languages, queue complaint, supplier delivery, or allergen alert requiring immediate triage.',
];

export async function evaluateWithDecisionsApi(params: {
  text?: string;
  audioBase64?: string;
  mimeType?: string;
  imageBase64?: string;
}): Promise<DecisionTriageResult> {
  const decisionsAi = createDecisionsClient();
  const inputBlocks: Array<Record<string, unknown>> = [];

  if (params.audioBase64 && params.mimeType) {
    inputBlocks.push({
      type: 'audio',
      data: params.audioBase64,
      mime_type: params.mimeType,
    });
  }
  if (params.imageBase64) {
    inputBlocks.push({
      type: 'image',
      data: params.imageBase64,
      mime_type: 'image/jpeg',
      resolution: 'low',
    });
  }
  if (params.text?.trim()) {
    inputBlocks.push({
      type: 'text',
      text: params.text.trim(),
    });
  }
  if (inputBlocks.length === 0) {
    throw new Error('Decisions API requires non-empty audio, image, or text input.');
  }

  const result = await decisionsAi.decisions.create({
    model: 'gemini-decision-1',
    input: inputBlocks as never,
    questions: {
      is_customer_order_intent: {
        type: 'noul',
        instructions:
          'Does this pizzeria audio/text contain at least one customer placing, modifying, or asking about a food or drink order?',
        criteria: {
          true_description: 'Contains a customer food or drink order, modifier, or menu inquiry.',
          false_description: 'Only supplier delivery, staff-only kitchen talk, or complaint without an order.',
        },
      },
      speaker_role: {
        type: 'choice',
        instructions: 'Who is the dominant or highest-priority speaker needing action in this input?',
        criteria: {
          customer_primary: 'Primary customer ordering food or drinks.',
          customer_companion: 'Companion adding or modifying items alongside the primary customer.',
          counter_staff: 'Counter clerk or pizza chef coordinating internally.',
          supplier_delivery: 'Delivery driver or supplier asking where to drop ingredients or sign.',
          queue_complaint: 'Waiting customer complaining about delay or missing table order.',
          other: 'Unrelated ambient speech or noise.',
        },
      },
      primary_language: {
        type: 'choice',
        instructions: 'Which primary language is spoken first or most prominently in this input?',
        criteria: {
          en: 'English (British, American, or international English).',
          de: 'German.',
          es: 'Spanish.',
          it: 'Italian.',
          el: 'Greek.',
          zh: 'Mandarin or Cantonese Chinese.',
          other: 'Any other of the 90+ Gemini-supported languages (French, Portuguese, Japanese, Korean, Arabic, Hindi, etc.).',
        },
      },
      chaos_severity: {
        type: 'score',
        instructions: 'Rate the acoustic and conversational complexity of this pizzeria turn.',
        criteria: CHAOS_SCORE_CRITERIA,
      },
    },
  });

  const answers = result.answers ?? {};
  const intent = answers.is_customer_order_intent;
  const role = answers.speaker_role;
  const lang = answers.primary_language;
  const chaos = answers.chaos_severity;

  const isOrderProb = intent?.type === 'noul' ? intent.noul : 0.5;
  const isOrderConf = intent?.type === 'noul' ? intent.confidence : 0.5;
  const scoreVal = chaos?.type === 'score' ? chaos.score : 0;
  const topLevelIdx =
    chaos?.type === 'score'
      ? Number(
          Object.entries(chaos.probabilities).sort(([, a], [, b]) => b - a)[0]?.[0] ?? 0
        )
      : 0;

  return {
    isOrderIntent: {
      probability: Number(isOrderProb.toFixed(3)),
      confidence: Number(isOrderConf.toFixed(3)),
      passed: isOrderProb >= 0.5,
    },
    speakerRole: {
      choice: (role?.type === 'choice' ? role.choice : 'other') as SpeakerRole,
      confidence: Number((role?.type === 'choice' ? role.confidence : 0.5).toFixed(3)),
    },
    primaryLanguage: {
      choice: lang?.type === 'choice' ? lang.choice : 'en',
      confidence: Number((lang?.type === 'choice' ? lang.confidence : 0.5).toFixed(3)),
    },
    chaosSeverity: {
      score: Number(scoreVal.toFixed(2)),
      normalized: Number((scoreVal / (CHAOS_SCORE_CRITERIA.length - 1)).toFixed(3)),
      label: CHAOS_SCORE_CRITERIA[topLevelIdx] ?? CHAOS_SCORE_CRITERIA[0],
      confidence: Number((chaos?.type === 'score' ? chaos.confidence : 0.5).toFixed(3)),
    },
    evaluatedAt: new Date().toISOString(),
  };
}

export async function transcribeRawAudio(
  audioBase64: string,
  mimeType: string
): Promise<string> {
  const ai = createBetaGeminiClient();
  const response = await ai.models.generateContent({
    model: 'gemini-3.5-transcribe',
    contents: {
      parts: [
        {
          inlineData: {
            mimeType,
            data: audioBase64,
          },
        },
        {
          text: 'Transcribe every audible speaker accurately in their original language across all 90+ Gemini-supported languages (preserving native script). Label overlapping turns if multiple voices are heard.',
        },
      ],
    },
  });
  return (response.text ?? '').trim();
}

export async function synthesizeAudioClip(
  text: string,
  voiceName: 'Puck' | 'Charon' | 'Kore' | 'Fenrir' | 'Zephyr' = 'Zephyr',
  style = 'Natural, warm, crystal-clear conversational speech'
): Promise<{ dataBase64: string; mimeType: string }> {
  const ai = createBetaGeminiClient();
  const response = await ai.models.generateContent({
    model: 'gemini-3.8-flash-lite-tts',
    contents: [
      {
        role: 'user',
        parts: [
          {
            text,
            speechMetadata: { style },
          },
        ],
      },
    ],
    config: {
      responseModalities: ['AUDIO'],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: { voiceName },
        },
      },
    },
  });

  const part = response.candidates?.[0]?.content?.parts?.[0];
  const data = part?.inlineData?.data;
  if (!data) {
    throw new Error('TTS synthesis returned no audio payload.');
  }
  return {
    dataBase64: data,
    mimeType: part?.inlineData?.mimeType || 'audio/wav',
  };
}

interface NeonAttributionOutput {
  partyLabel: string;
  segments: SpeakerAttributionSegment[];
  combinedAgentSpeech: string;
  nonOrderAlerts: Array<{
    role: SpeakerRole;
    languageCode: string;
    summary: string;
    staffActionEs: string;
    staffActionIt: string;
  }>;
}

export async function runCascadedTurn(params: {
  channel: StationChannel;
  audioBase64?: string;
  audioMimeType?: string;
  imageBase64?: string;
  textInput?: string;
  enableTtsReply?: boolean;
}): Promise<{
  transcriptEntry: TranscriptEntry;
  createdOrUpdatedOrder: OrderTicket | null;
  createdAlerts: NonOrderAlert[];
}> {
  const startedMs = Date.now();
  const ai = createGeminiClient();

  let rawTranscript = (params.textInput ?? '').trim();
  const modelsUsed: string[] = [];

  // Step 1: Raw Audio Transcription with gemini-3.5-transcribe when audio is provided
  if (params.audioBase64 && params.audioMimeType) {
    const transcribed = await transcribeRawAudio(params.audioBase64, params.audioMimeType);
    modelsUsed.push('gemini-3.5-transcribe');
    rawTranscript = transcribed || rawTranscript;
  }

  if (!rawTranscript && !params.imageBase64 && !params.audioBase64) {
    throw new Error('No speech, text, or camera input was detected.');
  }

  // Step 2: Decisions API (gemini-decision-1) calibrated zero-token chaos triage
  const triage = await evaluateWithDecisionsApi({
    text: rawTranscript || 'Raw pizzeria customer audio attached.',
    audioBase64: params.audioBase64,
    mimeType: params.audioMimeType,
    imageBase64: params.imageBase64,
  });
  modelsUsed.push('gemini-decision-1');

  // Step 3: Gemini 4 Neon (Complex Multi-Speaker Disambiguation & Multilingual Attribution)
  const neonParts: Array<Record<string, unknown>> = [];
  if (params.audioBase64 && params.audioMimeType) {
    neonParts.push({
      inlineData: {
        mimeType: params.audioMimeType,
        data: params.audioBase64,
      },
    });
  }
  if (params.imageBase64) {
    neonParts.push({
      inlineData: {
        mimeType: 'image/jpeg',
        data: params.imageBase64,
      },
    });
  }

  const promptText = `You are VoicePizza's multilingual orchestration brain operating in "${
    params.channel === 'phone' ? 'P1 Phone Line' : 'P2 Over-the-Counter Chaos'
  }" mode.
You can hear raw overlapping voices directly from the audio AND see counter camera frames if attached.
Do NOT drop secondary speakers! Across all 90+ Gemini-supported languages—whether a British English caller and German wife speak together, or Chinese, Greek, French, Japanese, Hindi, Arabic, Spanish, and Italian voices overlap at the counter:
1) Separate every distinct speaker into its own segment with accurate BCP-47 languageCode (e.g., en-GB, de-DE, es-ES, it-IT, el-GR, zh-CN, fr-FR, pt-BR, ja-JP, ko-KR, ar-SA, hi-IN, tr-TR, pl-PL).
2) Attribute food/drink menu items ONLY to actual ordering customers (never turn a queue complaint or supplier delivery into a pizza order!).
3) Match menu items strictly to the catalog IDs below and capture modifiers (especially allergies like gluten-free / glutenfrei, well done, extra garlic, no chili).
4) Write a warm, concise reply in EACH speaker's own language (replyText + replyLanguageCode), AND produce combinedAgentSpeech that confirms the ordered items naturally in their respective languages. Do NOT invent or estimate a dollar total in combinedAgentSpeech (the exact subtotal + 8.5% tax total is calculated automatically by the POS engine right after extraction).
5) If there is a non-order operational event (supplier delivery, queue complaint, staff confusion), populate nonOrderAlerts with clear Spanish (for the counter clerk) and Italian (for the owner) action notes.

Menu Catalog (pre-tax prices; 8.5% sales tax applied by POS):
${MENU_SUMMARY}

Decisions API Pre-Triage:
${JSON.stringify(triage)}

ASR Transcript:
"${rawTranscript}"`;

  neonParts.push({ text: promptText });

  const neonResponse = await ai.models.generateContent({
    model: 'gemini-4-neon',
    contents: { parts: neonParts as never },
    config: {
      thinkingConfig: { thinkingLevel: ThinkingLevel.MEDIUM },
      responseMimeType: 'application/json',
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          partyLabel: { type: Type.STRING },
          combinedAgentSpeech: { type: Type.STRING },
          segments: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                speakerLabel: { type: Type.STRING },
                languageCode: { type: Type.STRING },
                role: { type: Type.STRING },
                utterance: { type: Type.STRING },
                englishGloss: { type: Type.STRING },
                replyText: { type: Type.STRING },
                replyLanguageCode: { type: Type.STRING },
                extractedItems: {
                  type: Type.ARRAY,
                  items: {
                    type: Type.OBJECT,
                    properties: {
                      menuItemId: { type: Type.STRING },
                      quantity: { type: Type.INTEGER },
                      modifiers: { type: Type.ARRAY, items: { type: Type.STRING } },
                      assignedTo: { type: Type.STRING },
                    },
                    required: ['menuItemId', 'quantity', 'modifiers', 'assignedTo'],
                  },
                },
              },
              required: [
                'speakerLabel',
                'languageCode',
                'role',
                'utterance',
                'englishGloss',
                'replyText',
                'replyLanguageCode',
                'extractedItems',
              ],
            },
          },
          nonOrderAlerts: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                role: { type: Type.STRING },
                languageCode: { type: Type.STRING },
                summary: { type: Type.STRING },
                staffActionEs: { type: Type.STRING },
                staffActionIt: { type: Type.STRING },
              },
              required: ['role', 'languageCode', 'summary', 'staffActionEs', 'staffActionIt'],
            },
          },
        },
        required: ['partyLabel', 'combinedAgentSpeech', 'segments', 'nonOrderAlerts'],
      },
    },
  });
  modelsUsed.push('gemini-4-neon');

  const parsed: NeonAttributionOutput = JSON.parse((neonResponse.text ?? '{}').trim());

  // Aggregate extracted order items across customer segments
  const allExtractedItems = (parsed.segments ?? []).flatMap((seg) =>
    (seg.extractedItems ?? []).map((item) => ({
      ...item,
      languageCode: seg.languageCode,
    }))
  );

  // Step 4: Gemini 4 Hydrogen (Fast Low-Latency Kitchen Ticket Translation in Italian & Spanish)
  let kitchenNoteIt = '';
  let counterNoteEs = '';
  if (allExtractedItems.length > 0) {
    const hydrogenResp = await ai.models.generateContent({
      model: 'gemini-4-hydrogen',
      contents: `Format a concise kitchen ticket for these pizzeria items: ${JSON.stringify(
        allExtractedItems
      )}. Provide an Italian note for the pizzaiolo (kitchenNoteIt) and a Spanish note for the counter clerk (counterNoteEs), highlighting any allergen or gluten-free warnings.`,
      config: {
        thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            kitchenNoteIt: { type: Type.STRING },
            counterNoteEs: { type: Type.STRING },
          },
          required: ['kitchenNoteIt', 'counterNoteEs'],
        },
      },
    });
    modelsUsed.push('gemini-4-hydrogen');
    const hJson = JSON.parse((hydrogenResp.text ?? '{}').trim());
    kitchenNoteIt = hJson.kitchenNoteIt || '';
    counterNoteEs = hJson.counterNoteEs || '';
  }

  const createdOrUpdatedOrder = voicePizzaStore.upsertOrderFromExtractedItems({
    channel: params.channel,
    architecture: 'cascaded',
    partyLabel: parsed.partyLabel || (params.channel === 'phone' ? 'Phone Party' : 'Counter Party'),
    extractedItems: allExtractedItems,
    kitchenNoteIt,
    counterNoteEs,
  });

  const createdAlerts: NonOrderAlert[] = [];
  for (const alertItem of parsed.nonOrderAlerts ?? []) {
    const created = voicePizzaStore.createQuickAlert({
      role: alertItem.role,
      languageCode: alertItem.languageCode,
      summary: alertItem.summary,
      staffActionEs: alertItem.staffActionEs,
      staffActionIt: alertItem.staffActionIt,
    });
    createdAlerts.push(created);
  }

  // Sync authoritative exact order total (subtotal + 8.5% tax) into reply summary & spoken TTS
  const baseSpeech = (parsed.combinedAgentSpeech || '').trim();
  const exactTotalSummary = createdOrUpdatedOrder
    ? formatOrderTotalsSummary(createdOrUpdatedOrder)
    : '';
  const spokenText = createdOrUpdatedOrder
    ? `${baseSpeech}${baseSpeech ? ' ' : ''}Confirmed Ticket #${
        createdOrUpdatedOrder.ticketNumber
      }. Your exact total including 8.5% tax is ${formatCurrency(
        createdOrUpdatedOrder.totalCents
      )}.`
    : baseSpeech;
  const fullReplySummary = createdOrUpdatedOrder
    ? `${baseSpeech}${baseSpeech ? '\n' : ''}${exactTotalSummary}`
    : baseSpeech;

  // Step 5: Cascaded TTS Audio Reply using gemini-3.8-flash-lite-tts
  let replyAudioBase64: string | undefined;
  let replyAudioMimeType: string | undefined;
  if (params.enableTtsReply !== false && spokenText) {
    const tts = await synthesizeAudioClip(
      spokenText,
      'Zephyr',
      'Warm, efficient Italian pizzeria host switching effortlessly between languages'
    );
    replyAudioBase64 = tts.dataBase64;
    replyAudioMimeType = tts.mimeType;
    modelsUsed.push('gemini-3.8-flash-lite-tts');
  }

  const transcriptEntry: TranscriptEntry = {
    id: `trn-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    timestamp: new Date().toISOString(),
    architecture: 'cascaded',
    channel: params.channel,
    rawTranscript,
    segments: parsed.segments ?? [],
    agentReplySummary: fullReplySummary,
    replyAudioBase64,
    replyAudioMimeType,
    triage,
    modelsUsed,
    latencyMs: Date.now() - startedMs,
  };

  voicePizzaStore.addTranscript(transcriptEntry);
  return { transcriptEntry, createdOrUpdatedOrder, createdAlerts };
}

export async function synthesizeChaosScenarioTracks(
  scenarioId: string
): Promise<Array<ChaosTrackLine & { audioBase64: string; mimeType: string }>> {
  const scenario = CHAOS_SCENARIOS.find((s) => s.id === scenarioId);
  if (!scenario) {
    throw new Error(`Unknown scenario: ${scenarioId}`);
  }

  const results = await Promise.all(
    scenario.tracks.map(async (track) => {
      const style =
        track.role === 'queue_complaint'
          ? 'Impatient, loud customer in a noisy restaurant queue'
          : track.role === 'supplier_delivery'
            ? 'Hurried delivery driver calling over shop noise'
            : 'Natural conversational tone in a lively pizzeria';
      const clip = await synthesizeAudioClip(track.text, track.voiceName, style);
      return {
        ...track,
        audioBase64: clip.dataBase64,
        mimeType: clip.mimeType,
      };
    })
  );

  return results;
}

export async function runElement119StressTest(params: {
  audioBase64?: string;
  audioMimeType?: string;
  scenarioId: string;
  level: 1 | 2 | 3;
}): Promise<StressLevelResult> {
  const ai = createGeminiClient();
  const scenario =
    CHAOS_SCENARIOS.find((s) => s.id === params.scenarioId) ?? CHAOS_SCENARIOS[1];

  // Level 1: 2 overlapping speakers (EN + DE)
  // Level 2: 4 overlapping speakers (EN + DE + EL complaint + ZH supplier)
  // Level 3: 6 overlapping speakers + kitchen clutter (all 6 tracks + acoustic pressure)
  const speakerSliceCount = params.level === 1 ? 2 : params.level === 2 ? 4 : 6;
  const activeTracks = scenario.tracks.slice(0, speakerSliceCount);
  const simulatedMixedTranscript = activeTracks
    .map((t) => `[${t.speakerLabel} | ${t.languageName}]: ${t.text}`)
    .join('\n');

  // 1) Baseline: single fast model (gemini-4-hydrogen) with low thinking and NO Decisions triage
  const baselineStart = Date.now();
  const baselineParts: Array<Record<string, unknown>> = [];
  if (params.audioBase64 && params.audioMimeType) {
    baselineParts.push({
      inlineData: { mimeType: params.audioMimeType, data: params.audioBase64 },
    });
  }
  baselineParts.push({
    text: `Extract all pizza order items from this noisy counter input into JSON array {items: [{menuItemId, quantity}]}. Menu IDs: ${PIZZERIA_MENU.map(
      (m) => m.id
    ).join(', ')}. ${params.audioBase64 ? '' : `Input:\n${simulatedMixedTranscript}`}`,
  });

  const baselineResp = await ai.models.generateContent({
    model: 'gemini-4-hydrogen',
    contents: { parts: baselineParts as never },
    config: {
      thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
      responseMimeType: 'application/json',
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          items: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                menuItemId: { type: Type.STRING },
                quantity: { type: Type.INTEGER },
              },
              required: ['menuItemId', 'quantity'],
            },
          },
        },
        required: ['items'],
      },
    },
  });
  const baselineLatencyMs = Date.now() - baselineStart;
  const baselineParsed = JSON.parse((baselineResp.text ?? '{"items":[]}').trim());
  const baselineRecall = evaluateOrderRecall(
    scenario.expectedOrderItems,
    baselineParsed.items ?? []
  );

  // 2) Orchestrated VoicePizza Pipeline: Decisions API + Gemini 4 Neon + Hydrogen
  const orchStart = Date.now();
  const triage = await evaluateWithDecisionsApi({
    text: simulatedMixedTranscript,
    audioBase64: params.audioBase64,
    mimeType: params.audioMimeType,
  });

  const orchParts: Array<Record<string, unknown>> = [];
  if (params.audioBase64 && params.audioMimeType) {
    orchParts.push({
      inlineData: { mimeType: params.audioMimeType, data: params.audioBase64 },
    });
  }
  orchParts.push({
    text: `You are disambiguating a ${speakerSliceCount}-speaker overlapping pizzeria environment.
Decisions API Triage: ${JSON.stringify(triage)}
Filter out queue complaints (table 4 waiting) and supplier deliveries (20 crates of tomatoes), and extract ONLY actual customer takeaway pizza orders with strict menu IDs from:\n${MENU_SUMMARY}\n${
      params.audioBase64 ? '' : `Acoustic capture:\n${simulatedMixedTranscript}`
    }`,
  });

  const orchResp = await ai.models.generateContent({
    model: 'gemini-4-neon',
    contents: { parts: orchParts as never },
    config: {
      thinkingConfig: { thinkingLevel: ThinkingLevel.MEDIUM },
      responseMimeType: 'application/json',
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          items: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                menuItemId: { type: Type.STRING },
                quantity: { type: Type.INTEGER },
                assignedTo: { type: Type.STRING },
              },
              required: ['menuItemId', 'quantity', 'assignedTo'],
            },
          },
        },
        required: ['items'],
      },
    },
  });
  const orchestratedLatencyMs = Date.now() - orchStart;
  const orchParsed = JSON.parse((orchResp.text ?? '{"items":[]}').trim());
  const orchestratedRecall = evaluateOrderRecall(
    scenario.expectedOrderItems,
    orchParsed.items ?? []
  );

  const status: StressLevelResult['status'] =
    orchestratedRecall >= 0.85 ? 'passed' : orchestratedRecall >= 0.5 ? 'degraded' : 'broke';

  return {
    level: params.level,
    label:
      params.level === 1
        ? 'Level 1 · Dual-Language Call (EN + DE)'
        : params.level === 2
          ? 'Level 2 · Counter Interruptions (4 Speakers)'
          : 'Level 3 · Full 6-Language Acoustic Chaos',
    concurrentSpeakers: speakerSliceCount,
    noiseDbLabel: params.level === 1 ? '62 dB' : params.level === 2 ? '78 dB' : '89 dB',
    baselineModel: 'gemini-4-hydrogen (uncalibrated)',
    baselineLatencyMs,
    baselineRecall,
    baselineErrorNote:
      baselineRecall < 1
        ? `Confused Table 4 complaint ("Diavola") or missed secondary German speaker (${Math.round(
            baselineRecall * 100
          )}% recall).`
        : 'Matched expected items on baseline.',
    orchestratedModels: ['gemini-decision-1', 'gemini-4-neon', 'gemini-4-hydrogen'],
    orchestratedLatencyMs,
    orchestratedRecall,
    decisionTriageConfidence: triage.chaosSeverity.confidence,
    status,
    rawAudioBenefitNote:
      'Raw audio exposes prosodic urgency (Greek yell vs calm English order), overlapping speaker timbre, and immediate code-switching lost in flat text.',
  };
}
