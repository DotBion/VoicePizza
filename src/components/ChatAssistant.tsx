import { RotateCcw, Send } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

type ChatModel =
  | 'gemini-3.1-flash-lite'
  | 'gemini-4-hydrogen'
  | 'gemini-4-neon'
  | 'gemini-4-carbon';

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  model: ChatModel;
  timestamp: string;
  latencyMs?: number;
}

const MODEL_OPTIONS: Array<{ id: ChatModel; label: string; purpose: string }> = [
  {
    id: 'gemini-3.1-flash-lite',
    label: 'Fast · Gemini 3.1 Flash Lite',
    purpose: 'Instant menu & allergen lookups',
  },
  {
    id: 'gemini-4-hydrogen',
    label: 'General · Gemini 4 Hydrogen',
    purpose: 'Everyday shift & bilingual guest replies',
  },
  {
    id: 'gemini-4-neon',
    label: 'Complex · Gemini 4 Neon',
    purpose: 'Multi-party order edits & translation disputes',
  },
  {
    id: 'gemini-4-carbon',
    label: 'Deep Reasoning · Gemini 4 Carbon',
    purpose: 'Root-cause prep bottlenecks & catering planning',
  },
];

const PERSONAS = [
  'Multilingual Shift Manager & Order Coordinator',
  'Spanish-Speaking Counter Clerk Assistant',
  'Italian Pizzaiolo Kitchen Pass Translator',
];

export function ChatAssistant() {
  const [sessionId] = useState('voicepizza-shift-chat');
  const [model, setModel] = useState<ChatModel>('gemini-4-neon');
  const [persona, setPersona] = useState(PERSONAS[0]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const threadEndRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    fetch(`/api/chat/${sessionId}`)
      .then((r) => r.json())
      .then((d) => {
        if (Array.isArray(d.history)) setMessages(d.history);
      })
      .catch(() => {});
  }, [sessionId]);

  useEffect(() => {
    threadEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length]);

  async function handleSend(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = input.trim();
    if (!trimmed || sending) return;

    setSending(true);
    setErrorMsg(null);
    setInput('');

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId,
          model,
          rolePersona: persona,
          message: trimmed,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Chat request failed');
      }
      if (Array.isArray(data.history)) {
        setMessages(data.history);
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Unable to send chat message');
    } finally {
      setSending(false);
    }
  }

  async function handleReset() {
    await fetch(`/api/chat/${sessionId}`, { method: 'DELETE' });
    setMessages([]);
    setErrorMsg(null);
  }

  const activeModelMeta = MODEL_OPTIONS.find((m) => m.id === model) ?? MODEL_OPTIONS[2];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4 border-b border-[#E5E0D8] pb-4">
        <div>
          <h1 className="font-display text-2xl font-bold text-[#171717]">
            Multilingual Shift &amp; Order Assistant
          </h1>
          <p className="text-sm text-[#525252]">
            Multi-turn Gemini chat grounded in live menu SKUs, allergen rules, and active kitchen
            tickets.
          </p>
        </div>

        <button
          type="button"
          onClick={handleReset}
          className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold rounded-lg border border-[#E5E0D8] bg-white text-[#171717] hover:bg-[#EFECE6] whitespace-nowrap shrink-0"
        >
          <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
          New Thread
        </button>
      </div>

      <section className="rounded-xl border border-[#E5E0D8] bg-white p-5 space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <label htmlFor="chat-model-select" className="block text-xs font-medium text-[#525252]">
              Gemini Model Tier
            </label>
            <select
              id="chat-model-select"
              value={model}
              onChange={(e) => setModel(e.target.value as ChatModel)}
              className="w-full rounded-lg border border-[#E5E0D8] bg-[#F8F7F4] px-3 py-2 text-sm text-[#171717] focus:border-[#C23B22] focus:outline-none"
            >
              {MODEL_OPTIONS.map((opt) => (
                <option key={opt.id} value={opt.id}>
                  {opt.label}
                </option>
              ))}
            </select>
            <p className="text-xs text-[#737373]">{activeModelMeta.purpose}</p>
          </div>

          <div className="space-y-1.5">
            <label htmlFor="chat-persona-select" className="block text-xs font-medium text-[#525252]">
              System Role Instruction
            </label>
            <select
              id="chat-persona-select"
              value={persona}
              onChange={(e) => setPersona(e.target.value)}
              className="w-full rounded-lg border border-[#E5E0D8] bg-[#F8F7F4] px-3 py-2 text-sm text-[#171717] focus:border-[#C23B22] focus:outline-none"
            >
              {PERSONAS.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
            <p className="text-xs text-[#737373]">
              Maintains multi-turn conversation history across follow-ups.
            </p>
          </div>
        </div>

        {/* Scrollable Message Thread */}
        <div
          aria-label="Assistant conversation thread"
          className="h-[420px] overflow-y-auto rounded-lg border border-[#EFECE6] bg-[#F8F7F4] p-4 space-y-4"
        >
          {messages.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center text-center space-y-2">
              <p className="text-sm font-medium text-[#171717]">
                Ask anything in 90+ languages (English, Spanish, German, Italian, Greek, Chinese, and more).
              </p>
              <p className="text-xs text-[#737373] max-w-md">
                Try asking: “Which pizzas are dairy-free for a German customer?” or “Summarize
                current oven tickets in Spanish for the counter clerk.”
              </p>
            </div>
          ) : (
            messages.map((msg) => (
              <div
                key={msg.id}
                className={`flex flex-col space-y-1 ${
                  msg.role === 'user' ? 'items-end' : 'items-start'
                }`}
              >
                <span className="text-[11px] text-[#737373]">
                  {msg.role === 'user' ? 'You' : `VoicePizza · ${msg.model}`}
                  {msg.latencyMs ? ` · ${msg.latencyMs} ms` : ''}
                </span>
                <div
                  className={`max-w-[80%] rounded-xl px-4 py-3 text-sm leading-relaxed whitespace-pre-wrap ${
                    msg.role === 'user'
                      ? 'bg-[#171717] text-white'
                      : 'border border-[#E5E0D8] bg-white text-[#171717]'
                  }`}
                >
                  {msg.text}
                </div>
              </div>
            ))
          )}
          <div ref={threadEndRef} />
        </div>

        {errorMsg && (
          <div role="alert" className="rounded-lg border border-[#C23B22]/30 bg-[#C23B22]/8 p-3 text-xs text-[#8F2411]">
            {errorMsg}
          </div>
        )}

        <form onSubmit={handleSend} className="flex items-center gap-2.5">
          <label htmlFor="assistant-chat-input" className="sr-only">
            Message VoicePizza Assistant
          </label>
          <input
            id="assistant-chat-input"
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Ask about allergens, translate a counter request, or inspect active tickets..."
            className="flex-1 rounded-lg border border-[#E5E0D8] bg-white px-3.5 py-2.5 text-sm text-[#171717] placeholder:text-[#8A8A8A] focus:border-[#C23B22] focus:outline-none"
          />
          <button
            type="submit"
            disabled={sending || !input.trim()}
            className="inline-flex items-center gap-1.5 px-4 py-2.5 text-sm font-semibold rounded-lg bg-[#C23B22] text-white hover:bg-[#A6311B] disabled:opacity-50 transition-colors whitespace-nowrap shrink-0"
          >
            <Send className="h-4 w-4" aria-hidden="true" />
            {sending ? 'Thinking...' : 'Send'}
          </button>
        </form>
      </section>
    </div>
  );
}
