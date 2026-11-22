import 'dotenv/config';
import express from 'express';
import http from 'node:http';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { CHAOS_SCENARIOS, PIZZERIA_MENU } from './src/shared/menu';
import { buildShopifyCheckoutPayload } from './src/shared/orderEngine';
import type {
  OrderStatus,
  StationChannel,
  VoiceArchitecture,
} from './src/types/voicepizza';
import {
  runCascadedTurn,
  runElement119StressTest,
  synthesizeChaosScenarioTracks,
  transcribeRawAudio,
} from './server/cascadedPipeline';
import { type ChatModelId, chatSessionManager } from './server/chatManager';
import { recordCase, statusForError } from './server/caseRecorder';
import { attachFixItProxy } from './server/fixitProxy';
import { attachLiveWebSocketServer } from './server/liveBridge';
import { attachRestoOpsProxy } from './server/opsProxy';
import { voicePizzaStore } from './server/stateStore';

const VALID_ARCHITECTURES = new Set<VoiceArchitecture>(['cascaded', 'gemini-live']);
const VALID_CHANNELS = new Set<StationChannel>(['phone', 'counter']);
const VALID_STATUSES = new Set<OrderStatus>(['incoming', 'oven', 'ready', 'paid']);

async function bootstrap() {
  const app = express();
  attachFixItProxy(app);
  attachRestoOpsProxy(app);
  app.use(express.json({ limit: '25mb' }));

  // Health & State
  app.get('/api/health', (_req, res) => {
    res.json({
      ok: true,
      hasGeminiKey: Boolean(process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY !== 'MY_GEMINI_API_KEY'),
      session: voicePizzaStore.getSession(),
    });
  });

  app.get('/api/state', (_req, res) => {
    res.json({
      session: voicePizzaStore.getSession(),
      orders: voicePizzaStore.getOrders(),
      transcripts: voicePizzaStore.getTranscripts(),
      alerts: voicePizzaStore.getAlerts(),
      menu: PIZZERIA_MENU,
      scenarios: CHAOS_SCENARIOS,
    });
  });

  // Server-side architecture & session lifecycle validation
  app.post('/api/session/start', (req, res) => {
    const { architecture, channel } = req.body as {
      architecture?: VoiceArchitecture;
      channel?: StationChannel;
    };

    if (!architecture || !VALID_ARCHITECTURES.has(architecture)) {
      res.status(400).json({ error: 'Invalid voice architecture. Must be "cascaded" or "gemini-live".' });
      return;
    }
    if (!channel || !VALID_CHANNELS.has(channel)) {
      res.status(400).json({ error: 'Invalid channel. Must be "phone" or "counter".' });
      return;
    }

    try {
      const current = voicePizzaStore.getSession();
      if (current.active && current.architecture !== architecture) {
        res.status(409).json({
          error: `Stop the active ${current.architecture} session before switching to ${architecture}.`,
        });
        return;
      }
      const started = voicePizzaStore.startSession(architecture, channel);
      res.json({ session: started });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Unable to start session' });
    }
  });

  app.post('/api/session/stop', (_req, res) => {
    const stopped = voicePizzaStore.stopSession();
    res.json({ session: stopped });
  });

  app.post('/api/session/preferences', (req, res) => {
    const { architecture, channel } = req.body as {
      architecture?: VoiceArchitecture;
      channel?: StationChannel;
    };
    if (!architecture || !VALID_ARCHITECTURES.has(architecture)) {
      res.status(400).json({ error: 'Invalid voice architecture.' });
      return;
    }
    if (!channel || !VALID_CHANNELS.has(channel)) {
      res.status(400).json({ error: 'Invalid channel.' });
      return;
    }
    try {
      const updated = voicePizzaStore.setPreferences(architecture, channel);
      res.json({ session: updated });
    } catch (err) {
      res.status(409).json({ error: err instanceof Error ? err.message : 'Cannot switch while active.' });
    }
  });

  // Cascaded Architecture Voice / Multimodal Turn
  app.post('/api/cascaded/turn', async (req, res) => {
    const {
      channel = 'phone',
      audioBase64,
      audioMimeType,
      imageBase64,
      textInput,
      enableTtsReply = true,
    } = req.body as {
      channel?: StationChannel;
      audioBase64?: string;
      audioMimeType?: string;
      imageBase64?: string;
      textInput?: string;
      enableTtsReply?: boolean;
    };

    if (!VALID_CHANNELS.has(channel)) {
      res.status(400).json({ error: 'Invalid channel.' });
      return;
    }

    const session = voicePizzaStore.getSession();
    if (session.active && session.architecture !== 'cascaded') {
      res.status(409).json({
        error: 'Gemini Live session is active. Stop it before running Cascaded mode.',
      });
      return;
    }

    try {
      const result = await runCascadedTurn({
        channel,
        audioBase64,
        audioMimeType,
        imageBase64,
        textInput,
        enableTtsReply,
      });
      res.json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Cascaded turn failed';
      res.status(500).json({ error: message });
    }
  });

  // Dedicated Microphone Audio Transcription via gemini-3.5-transcribe
  app.post('/api/transcribe', async (req, res) => {
    const { audioBase64, audioMimeType = 'audio/wav' } = req.body as {
      audioBase64?: string;
      audioMimeType?: string;
    };
    if (!audioBase64) {
      res.status(400).json({ error: 'audioBase64 is required for transcription.' });
      return;
    }
    const started = Date.now();
    try {
      const transcript = await transcribeRawAudio(audioBase64, audioMimeType);
      res.json({
        transcript,
        model: 'gemini-3.5-transcribe',
        latencyMs: Date.now() - started,
      });
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Audio transcription failed',
      });
    }
  });

  // Multi-turn Gemini Chat Assistant
  app.get('/api/chat/:sessionId', (req, res) => {
    res.json({ history: chatSessionManager.getHistory(req.params.sessionId) });
  });

  app.delete('/api/chat/:sessionId', (req, res) => {
    chatSessionManager.resetSession(req.params.sessionId);
    res.json({ ok: true });
  });

  app.post('/api/chat', async (req, res) => {
    const {
      sessionId = 'default-staff-chat',
      model = 'gemini-4-neon',
      rolePersona = 'Multilingual Shift Manager & Order Coordinator',
      message,
    } = req.body as {
      sessionId?: string;
      model?: ChatModelId;
      rolePersona?: string;
      message?: string;
    };

    if (!message || !message.trim()) {
      res.status(400).json({ error: 'Message is required.' });
      return;
    }

    try {
      const result = await chatSessionManager.sendMessage({
        sessionId,
        model,
        rolePersona,
        message,
      });
      res.json(result);
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Chat request failed',
      });
    }
  });

  // Real TTS Multi-Speaker Track Synthesis for P1/P2 Live Acoustic Mixer
  app.post('/api/chaos/synthesize', async (req, res) => {
    const { scenarioId } = req.body as { scenarioId?: string };
    if (!scenarioId) {
      res.status(400).json({ error: 'scenarioId is required.' });
      return;
    }
    try {
      const tracks = await synthesizeChaosScenarioTracks(scenarioId);
      res.json({ scenarioId, tracks });
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Failed to synthesize chaos tracks',
      });
    }
  });

  // Element 119 Stress Test ("Where It Breaks")
  app.post('/api/stress/run', async (req, res) => {
    const {
      scenarioId = 'p2-counter-6lang',
      level = 1,
      audioBase64,
      audioMimeType,
      audioLabel,
      replayOf,
    } = req.body as {
      scenarioId?: string;
      level?: 1 | 2 | 3;
      audioBase64?: string;
      audioMimeType?: string;
      audioLabel?: string;
      replayOf?: string;
    };
    const startedMs = Date.now();
    const scenario = CHAOS_SCENARIOS.find((s) => s.id === scenarioId);
    const caseInput = {
      scenario_id: scenarioId,
      scenario: scenario?.title ?? scenarioId,
      level,
      audio: audioLabel ? String(audioLabel).slice(0, 120) : audioBase64 ? 'custom upload' : 'built-in scenario',
      replayable: !audioBase64 || audioLabel === 'Gemini TTS mix',
    };
    if (![1, 2, 3].includes(level)) {
      res.status(400).json({ error: 'Stress level must be 1, 2, or 3.' });
      return;
    }
    try {
      const result = await runElement119StressTest({
        scenarioId,
        level,
        audioBase64,
        audioMimeType,
      });
      res.json({ result });
      const gap = Math.abs(result.orchestratedRecall - result.baselineRecall);
      void recordCase({
        source: 'stress',
        area: 'front-of-house',
        status: result.status === 'broke' ? 'failed' : gap >= 0.34 ? 'disagreement' : 'ok',
        title: `${result.label} · ${result.concurrentSpeakers} speakers`,
        input: caseInput,
        models: {
          [result.baselineModel]: {
            role: 'single-model baseline',
            recall: result.baselineRecall,
            latency_ms: result.baselineLatencyMs,
            note: result.baselineErrorNote,
          },
          [result.orchestratedModels.join(' + ')]: {
            role: 'orchestrated stack',
            recall: result.orchestratedRecall,
            decisions_confidence: result.decisionTriageConfidence,
            latency_ms: result.orchestratedLatencyMs,
            status: result.status,
          },
        },
        latency_ms: result.orchestratedLatencyMs,
        error: result.status === 'passed' ? null : result.baselineErrorNote,
        replay_of: typeof replayOf === 'string' ? replayOf.slice(0, 100) : null,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Stress benchmark failed';
      res.status(500).json({ error: message });
      void recordCase({
        source: 'stress',
        area: 'front-of-house',
        status: statusForError(message),
        title: `Level ${level} · ${scenario?.title ?? scenarioId}`,
        input: caseInput,
        models: {},
        latency_ms: Date.now() - startedMs,
        error: message,
        replay_of: typeof replayOf === 'string' ? replayOf.slice(0, 100) : null,
      });
    }
  });

  // Orders & Shopify Commerce Sync
  app.post('/api/orders/manual-add', (req, res) => {
    const { menuItemId, quantity = 1, channel = 'counter', partyLabel = 'Walk-in Counter' } =
      req.body as {
        menuItemId?: string;
        quantity?: number;
        channel?: StationChannel;
        partyLabel?: string;
      };
    if (!menuItemId) {
      res.status(400).json({ error: 'menuItemId is required.' });
      return;
    }
    const order = voicePizzaStore.upsertOrderFromExtractedItems({
      channel: VALID_CHANNELS.has(channel) ? channel : 'counter',
      architecture: voicePizzaStore.getSession().architecture,
      partyLabel,
      extractedItems: [{ menuItemId, quantity, assignedTo: partyLabel, languageCode: 'en' }],
    });
    res.json({ order });
  });

  app.post('/api/orders/:id/status', (req, res) => {
    const { status } = req.body as { status?: OrderStatus };
    if (!status || !VALID_STATUSES.has(status)) {
      res.status(400).json({ error: 'Invalid order status.' });
      return;
    }
    const updated = voicePizzaStore.updateOrderStatus(req.params.id, status);
    if (!updated) {
      res.status(404).json({ error: 'Order ticket not found.' });
      return;
    }
    res.json({ order: updated });
  });

  app.post('/api/orders/:id/shopify-draft', (req, res) => {
    const target = voicePizzaStore.getOrders().find((o) => o.id === req.params.id);
    if (!target) {
      res.status(404).json({ error: 'Order ticket not found.' });
      return;
    }
    const payload = buildShopifyCheckoutPayload(target);
    const draftId = `shp_draft_${target.ticketNumber}_${Date.now().toString().slice(-4)}`;
    const updated = voicePizzaStore.markOrderShopifySynced(target.id, draftId);
    res.json({ order: updated, shopifyPayload: payload });
  });

  app.delete('/api/orders/completed', (_req, res) => {
    const removedCount = voicePizzaStore.clearCompletedOrders();
    res.json({ removedCount, orders: voicePizzaStore.getOrders() });
  });

  app.delete('/api/orders/:id', (req, res) => {
    const deleted = voicePizzaStore.deleteOrder(req.params.id);
    if (!deleted) {
      res.status(404).json({ error: 'Order ticket not found.' });
      return;
    }
    res.json({ ok: true, orders: voicePizzaStore.getOrders() });
  });

  app.post('/api/alerts/:id/resolve', (req, res) => {
    const resolved = voicePizzaStore.resolveAlert(req.params.id);
    if (!resolved) {
      res.status(404).json({ error: 'Alert not found.' });
      return;
    }
    res.json({ alert: resolved });
  });

  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: '/api/live' });
  attachLiveWebSocketServer(wss);

  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        allowedHosts: true,
        hmr: process.env.DISABLE_HMR === 'true' ? false : true,
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  const readCliFlag = (flag: string): string | undefined => {
    const args = process.argv.slice(2);
    for (let i = 0; i < args.length; i++) {
      if (args[i] === flag && args[i + 1]) return args[i + 1];
      if (args[i].startsWith(`${flag}=`)) return args[i].slice(flag.length + 1);
    }
    return undefined;
  };

  const PORT = Number(readCliFlag('--port') || process.env.PORT || 3000);
  const HOST = readCliFlag('--host') || process.env.HOST || '0.0.0.0';
  server.listen(PORT, HOST, () => {
    console.log(`VoicePizza server listening on http://${HOST}:${PORT}`);
  });
}

bootstrap().catch((err) => {
  console.error('Failed to start VoicePizza server:', err);
  process.exit(1);
});
