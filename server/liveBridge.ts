import {
  FunctionDeclaration,
  LiveServerMessage,
  Modality,
  Type,
} from '@google/genai';
import type { IncomingMessage } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { detectStreamLanguages } from '../src/shared/languageDetect';
import { PIZZERIA_MENU } from '../src/shared/menu';
import { formatCurrency, formatOrderTimestamp } from '../src/shared/orderEngine';
import type { SpeakerRole, StationChannel } from '../src/types/voicepizza';
import { evaluateWithDecisionsApi } from './cascadedPipeline';
import { createBetaGeminiClient } from './geminiClients';
import { voicePizzaStore } from './stateStore';

const MENU_LIST = PIZZERIA_MENU.map(
  (m) => `${m.id} (${m.name}, $${(m.priceCents / 100).toFixed(2)})`
).join('; ');

const UPSERT_ORDER_TOOL: FunctionDeclaration = {
  name: 'upsert_order_item',
  description:
    'Adds, updates quantity of, or removes a pizza, dessert, or drink item on the live pizzeria order board, attributed to the exact speaker and language. Returns the exact authoritative ticket items, subtotal, 8.5% tax, total, and confirmation timestamp.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      menuItemId: {
        type: Type.STRING,
        description: `Menu item ID from: ${PIZZERIA_MENU.map((m) => m.id).join(', ')}`,
      },
      quantity: {
        type: Type.INTEGER,
        description: 'Quantity to add, set, or remove (positive integer).',
      },
      action: {
        type: Type.STRING,
        description: 'Operation: "add" (default, adds quantity), "set" (replaces exact quantity), or "remove" (removes item or subtracts quantity).',
      },
      assignedTo: {
        type: Type.STRING,
        description: 'Who ordered it, e.g., Husband (en-GB) or Wife (de-DE)',
      },
      languageCode: {
        type: Type.STRING,
        description: 'BCP-47 language code spoken by that customer, e.g. en-GB, de-DE, es-ES',
      },
      modifiers: {
        type: Type.ARRAY,
        items: { type: Type.STRING },
        description: 'Modifications or dietary alerts like gluten-free, well done, extra garlic',
      },
      partyLabel: {
        type: Type.STRING,
        description: 'Ticket label for this customer group, e.g. Phone Party #1',
      },
      newOrder: {
        type: Type.BOOLEAN,
        description: 'Set to true ONLY if starting a brand-new separate ticket for a different customer party.',
      },
    },
    required: ['menuItemId', 'quantity', 'assignedTo', 'languageCode'],
  },
};

const ROUTE_NON_ORDER_TOOL: FunctionDeclaration = {
  name: 'route_non_order_speaker',
  description:
    'Routes non-order speech (supplier delivery, queue complaint, staff request) to the counter staff in Spanish and Italian without adding items to a food order.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      role: {
        type: Type.STRING,
        description: 'One of supplier_delivery, queue_complaint, counter_staff, other',
      },
      languageCode: { type: Type.STRING },
      summary: { type: Type.STRING },
      staffActionEs: { type: Type.STRING },
      staffActionIt: { type: Type.STRING },
    },
    required: ['role', 'languageCode', 'summary', 'staffActionEs', 'staffActionIt'],
  },
};

export function attachLiveWebSocketServer(wss: WebSocketServer) {
  wss.on('connection', async (clientWs: WebSocket, req: IncomingMessage) => {
    const url = new URL(req.url ?? '/api/live', 'http://localhost:3000');
    const channelParam = (url.searchParams.get('channel') ?? 'phone') as StationChannel;
    const channel: StationChannel = channelParam === 'counter' ? 'counter' : 'phone';

    let liveSession: Awaited<ReturnType<ReturnType<typeof createBetaGeminiClient>['live']['connect']>> | null = null;
    let isClosed = false;
    let inputBuffer = '';
    let outputBuffer = '';
    let activeSessionTicketId: string | null = null;

    const safeSend = (payload: Record<string, unknown>) => {
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(JSON.stringify(payload));
      }
    };

    try {
      const ai = createBetaGeminiClient();

      const systemInstruction = `You are VoicePizza, a live multilingual pizzeria voice agent operating in ${
        channel === 'phone' ? 'P1 Phone Line' : 'P2 Busy Counter Chaos'
      } mode.
CRITICAL MULTILINGUAL & EXACT ORDER RULES:
1) You fluently understand and speak all 90+ Gemini-supported languages (including British English, Spanish, German, Italian, Greek, Mandarin Chinese, French, Portuguese, Japanese, Korean, Arabic, Hindi, Turkish, Polish, Dutch, Vietnamese, and more) in the SAME conversation.
2) Always reply aloud clearly in the exact language(s) spoken by the customer(s). If two people speak on the same call or at the counter in different languages, answer BOTH in their own languages in one spoken reply and call upsert_order_item for each item with their exact BCP-47 languageCode.
3) EXACT TOTALS & ORDER SYNC: Sales tax is 8.5%. NEVER calculate, round, or guess totals in your head! Always call upsert_order_item for EVERY item ordered (use action="set" to change a quantity or action="remove" to cancel an item). Then read back the EXACT items, subtotal, 8.5% tax, and final total returned by the upsert_order_item tool response so your spoken confirmation matches the Station and Orders board to the exact cent.
4) After calling any tool (upsert_order_item or route_non_order_speaker), ALWAYS speak a concise, friendly confirmation aloud in the customer's language with the exact total from the tool response.
5) In noisy counter environments, ignore background complaints or supplier deliveries for the food cart, and instead call route_non_order_speaker so the Spanish counter clerk and Italian owner see what happened.
6) If the counter camera shows allergen notes, ingredients, or packaging, acknowledge what you see.
Menu items (prices before 8.5% tax): ${MENU_LIST}. Keep spoken replies concise, warm, and natural.`;

      liveSession = await ai.live.connect({
        model: 'gemini-3.8-live',
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Zephyr' } },
          },
          inputAudioTranscription: {},
          outputAudioTranscription: {},
          tools: [{ functionDeclarations: [UPSERT_ORDER_TOOL, ROUTE_NON_ORDER_TOOL] }],
          systemInstruction,
        },
        callbacks: {
          onmessage: async (message: LiveServerMessage) => {
            if (isClosed) return;

            const content = message.serverContent;
            if (content?.interrupted) {
              safeSend({ type: 'interrupted' });
            }

            if (content?.inputTranscription?.text) {
              inputBuffer += content.inputTranscription.text;
              const detected = detectStreamLanguages(inputBuffer);
              safeSend({
                type: 'input_transcript',
                text: content.inputTranscription.text,
                detectedLanguage: detected.primary,
                detectedLanguages: detected.languages,
              });
            }

            if (content?.outputTranscription?.text) {
              outputBuffer += content.outputTranscription.text;
              safeSend({ type: 'output_transcript', text: content.outputTranscription.text });
            }

            for (const part of content?.modelTurn?.parts ?? []) {
              if (part.inlineData?.data) {
                safeSend({ type: 'audio', data: part.inlineData.data });
              }
            }

            if (content?.turnComplete && outputBuffer.trim()) {
              const userText = inputBuffer.trim() || 'Live voice / multimodal turn';
              const agentText = outputBuffer.trim();
              inputBuffer = '';
              outputBuffer = '';

              evaluateWithDecisionsApi({ text: userText })
                .then((triage) => {
                  voicePizzaStore.addTranscript({
                    id: `trn-live-${Date.now()}`,
                    timestamp: new Date().toISOString(),
                    architecture: 'gemini-live',
                    channel,
                    rawTranscript: userText,
                    segments: [],
                    agentReplySummary: agentText,
                    triage,
                    modelsUsed: ['gemini-3.8-live', 'gemini-decision-1'],
                    latencyMs: 0,
                  });
                  safeSend({
                    type: 'turn_committed',
                    rawTranscript: userText,
                    agentReplySummary: agentText,
                    triage,
                  });
                })
                .catch(() => {
                  voicePizzaStore.addTranscript({
                    id: `trn-live-${Date.now()}`,
                    timestamp: new Date().toISOString(),
                    architecture: 'gemini-live',
                    channel,
                    rawTranscript: userText,
                    segments: [],
                    agentReplySummary: agentText,
                    modelsUsed: ['gemini-3.8-live'],
                    latencyMs: 0,
                  });
                  safeSend({
                    type: 'turn_committed',
                    rawTranscript: userText,
                    agentReplySummary: agentText,
                  });
                });
            }

            const calls = message.toolCall?.functionCalls ?? [];
            if (calls.length > 0) {
              const functionResponses: Array<{
                id: string | undefined;
                name: string | undefined;
                response: Record<string, unknown>;
              }> = [];

              for (const call of calls) {
                const args = (call.args ?? {}) as Record<string, unknown>;
                if (call.name === 'upsert_order_item') {
                  const langCode = String(args.languageCode || 'en');
                  const rawAction = String(args.action || 'add').toLowerCase();
                  const operation: 'add' | 'set' | 'remove' =
                    rawAction === 'set' || rawAction === 'remove' ? rawAction : 'add';
                  const createNewTicket = Boolean(args.newOrder);
                  if (createNewTicket) {
                    activeSessionTicketId = null;
                  }

                  const order = voicePizzaStore.upsertOrderFromExtractedItems({
                    channel,
                    architecture: 'gemini-live',
                    ticketId: activeSessionTicketId,
                    createNewTicket,
                    partyLabel: String(
                      args.partyLabel ||
                        (channel === 'phone' ? 'Live Phone Order' : 'Live Counter Order')
                    ),
                    extractedItems: [
                      {
                        menuItemId: String(args.menuItemId || ''),
                        quantity: Number(args.quantity ?? 1),
                        assignedTo: String(args.assignedTo || 'Guest'),
                        languageCode: langCode,
                        modifiers: Array.isArray(args.modifiers) ? args.modifiers.map(String) : [],
                        operation,
                      },
                    ],
                  });

                  activeSessionTicketId = order?.id ?? null;
                  safeSend({ type: 'order_updated', order });
                  safeSend({ type: 'language_detected', languageCode: langCode });

                  functionResponses.push({
                    id: call.id,
                    name: call.name,
                    response: order
                      ? {
                          status: 'ok',
                          ticketNumber: order.ticketNumber,
                          confirmedAt: formatOrderTimestamp(order.confirmedAt),
                          items: order.items.map((item) => ({
                            menuItemId: item.menuItemId,
                            name: item.name,
                            quantity: item.quantity,
                            unitPrice: formatCurrency(item.unitPriceCents),
                            lineTotal: formatCurrency(item.unitPriceCents * item.quantity),
                            assignedTo: item.assignedTo,
                            modifiers: item.modifiers,
                          })),
                          subtotal: formatCurrency(order.subtotalCents),
                          taxRate: '8.5%',
                          tax: formatCurrency(order.taxCents),
                          total: formatCurrency(order.totalCents),
                        }
                      : {
                          status: operation === 'remove' ? 'order_cleared' : 'item_not_found',
                          availableMenuIds: PIZZERIA_MENU.map((m) => m.id),
                        },
                  });
                } else if (call.name === 'route_non_order_speaker') {
                  const langCode = String(args.languageCode || 'other');
                  const alert = voicePizzaStore.createQuickAlert({
                    role: String(args.role || 'other') as SpeakerRole,
                    languageCode: langCode,
                    summary: String(args.summary || 'Non-order event'),
                    staffActionEs: String(args.staffActionEs || 'Atender al cliente en mostrador.'),
                    staffActionIt: String(args.staffActionIt || 'Controllare situazione al banco.'),
                  });
                  safeSend({ type: 'alert_created', alert });
                  safeSend({ type: 'language_detected', languageCode: langCode });
                  functionResponses.push({
                    id: call.id,
                    name: call.name,
                    response: { status: 'routed', alertId: alert.id },
                  });
                }
              }

              if (functionResponses.length > 0) {
                liveSession?.sendToolResponse({ functionResponses });
              }
            }
          },
          onerror: (err) => {
            const msg =
              err instanceof Error
                ? err.message
                : typeof err === 'object' && err !== null && 'message' in err
                  ? String((err as { message: unknown }).message)
                  : String(err);
            safeSend({ type: 'error', message: msg });
          },
          onclose: () => {
            if (!isClosed) {
              isClosed = true;
              voicePizzaStore.stopSession();
              safeSend({ type: 'session_stopped' });
            }
          },
        },
      });

      const sessionState = voicePizzaStore.startSession('gemini-live', channel);
      safeSend({ type: 'session_started', session: sessionState });

      voicePizzaStore.registerCloseHandler(() => {
        isClosed = true;
        try {
          liveSession?.close();
        } catch {
          // ignore
        }
        if (clientWs.readyState === WebSocket.OPEN) {
          clientWs.close();
        }
      });

      clientWs.on('message', (raw) => {
        if (!liveSession || isClosed) return;
        try {
          const msg = JSON.parse(raw.toString()) as {
            type?: string;
            audio?: string;
            video?: string;
            text?: string;
            audioStreamEnd?: boolean;
          };
          if (msg.audio) {
            liveSession.sendRealtimeInput({
              audio: { data: msg.audio, mimeType: 'audio/pcm;rate=16000' },
            });
          }
          if (msg.audioStreamEnd) {
            const silenceB64 = Buffer.alloc(16000 * 2 * 0.8).toString('base64');
            liveSession.sendRealtimeInput({
              audio: { data: silenceB64, mimeType: 'audio/pcm;rate=16000' },
            });
            liveSession.sendRealtimeInput({ audioStreamEnd: true });
          }
          if (msg.video) {
            liveSession.sendRealtimeInput({
              video: { data: msg.video, mimeType: 'image/jpeg' },
            });
          }
          if (msg.text) {
            inputBuffer = msg.text;
            liveSession.sendRealtimeInput({ text: msg.text });
          }
        } catch (err) {
          safeSend({ type: 'error', message: err instanceof Error ? err.message : 'Invalid Live message' });
        }
      });

      clientWs.on('close', () => {
        isClosed = true;
        try {
          liveSession?.close();
        } catch {
          // ignore
        }
        voicePizzaStore.stopSession();
      });
    } catch (err) {
      voicePizzaStore.stopSession();
      safeSend({
        type: 'error',
        message: err instanceof Error ? err.message : 'Failed to initialize Gemini Live session',
      });
      clientWs.close();
    }
  });
}
