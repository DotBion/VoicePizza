import type { Chat, GenerateContentResponse } from '@google/genai';
import { PIZZERIA_MENU } from '../src/shared/menu';
import { createGeminiClient } from './geminiClients';
import { voicePizzaStore } from './stateStore';

export type ChatModelId =
  | 'gemini-3.1-flash-lite'
  | 'gemini-4-hydrogen'
  | 'gemini-4-neon'
  | 'gemini-4-carbon';

const ALLOWED_CHAT_MODELS = new Set<ChatModelId>([
  'gemini-3.1-flash-lite',
  'gemini-4-hydrogen',
  'gemini-4-neon',
  'gemini-4-carbon',
]);

interface ChatMessageRecord {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  model: ChatModelId;
  timestamp: string;
  latencyMs?: number;
}

class ChatSessionManager {
  private sessions = new Map<string, { model: ChatModelId; chat: Chat; history: ChatMessageRecord[] }>();

  private buildSystemInstruction(rolePersona: string): string {
    const menuSummary = PIZZERIA_MENU.map(
      (m) =>
        `${m.name} (${m.italianName}, $${(m.priceCents / 100).toFixed(2)}, allergens: ${
          m.allergens.join(', ') || 'none'
        })`
    ).join('; ');

    const activeOrders = voicePizzaStore
      .getOrders()
      .slice(0, 8)
      .map(
        (o) =>
          `Ticket #${o.ticketNumber} [${o.status}] ${o.partyLabel}: ${o.items
            .map((i) => `${i.quantity}x ${i.name} (${i.assignedTo})`)
            .join(', ')}`
      )
      .join('\n');

    return `You are VoicePizza's multilingual pizzeria assistant (${rolePersona}).
Respond fluently in whichever language(s) the user or customer uses (English, Spanish, German, Italian, Greek, Mandarin Chinese, etc.).
Menu: ${menuSummary}
Live Kitchen Tickets:\n${activeOrders || 'No active orders yet.'}`;
  }

  getHistory(sessionId: string): ChatMessageRecord[] {
    return this.sessions.get(sessionId)?.history ?? [];
  }

  resetSession(sessionId: string) {
    this.sessions.delete(sessionId);
  }

  async sendMessage(params: {
    sessionId: string;
    model: ChatModelId;
    rolePersona: string;
    message: string;
  }): Promise<{ reply: ChatMessageRecord; history: ChatMessageRecord[] }> {
    if (!ALLOWED_CHAT_MODELS.has(params.model)) {
      throw new Error(`Unsupported chat model: ${params.model}`);
    }
    const text = params.message.trim();
    if (!text) {
      throw new Error('Message cannot be empty.');
    }

    let entry = this.sessions.get(params.sessionId);
    if (!entry || entry.model !== params.model) {
      const ai = createGeminiClient();
      const chat = ai.chats.create({
        model: params.model,
        config: {
          systemInstruction: this.buildSystemInstruction(params.rolePersona),
        },
        history: entry
          ? entry.history.map((m) => ({
              role: m.role === 'user' ? 'user' : 'model',
              parts: [{ text: m.text }],
            }))
          : undefined,
      });
      entry = {
        model: params.model,
        chat,
        history: entry ? [...entry.history] : [],
      };
      this.sessions.set(params.sessionId, entry);
    }

    const userRecord: ChatMessageRecord = {
      id: `msg-u-${Date.now()}`,
      role: 'user',
      text,
      model: params.model,
      timestamp: new Date().toISOString(),
    };
    entry.history.push(userRecord);

    const started = Date.now();
    const response: GenerateContentResponse = await entry.chat.sendMessage({
      message: text,
    });
    const replyText = (response.text ?? '').trim();
    const replyRecord: ChatMessageRecord = {
      id: `msg-a-${Date.now()}`,
      role: 'assistant',
      text: replyText,
      model: params.model,
      timestamp: new Date().toISOString(),
      latencyMs: Date.now() - started,
    };
    entry.history.push(replyRecord);

    return {
      reply: replyRecord,
      history: [...entry.history],
    };
  }
}

export const chatSessionManager = new ChatSessionManager();
