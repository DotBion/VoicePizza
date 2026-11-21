import { useCallback, useEffect, useRef, useState } from 'react';
import { ChatAssistant } from './components/ChatAssistant';
import { MenuCatalog } from './components/MenuCatalog';
import { OrdersBoard } from './components/OrdersBoard';
import { StationWorkspace } from './components/StationWorkspace';
import { FixItCam } from './components/FixItCam';
import { StressLab } from './components/StressLab';
import { type ActiveView, TopBar } from './components/TopBar';
import {
  type DetectedLanguageInfo,
  getLanguageLabel,
  normalizeLanguageBase,
} from './shared/languageDetect';
import { CHAOS_SCENARIOS, PIZZERIA_MENU } from './shared/menu';
import { canSwitchArchitecture, nextOrderStatus } from './shared/orderEngine';
import type {
  ChaosScenario,
  NonOrderAlert,
  OrderTicket,
  PizzaMenuItem,
  SessionState,
  StationChannel,
  TranscriptEntry,
  VoiceArchitecture,
} from './types/voicepizza';
import { LivePcmPlayer } from './utils/audioEngine';

export default function App() {
  const [activeView, setActiveView] = useState<ActiveView>('station');
  const [session, setSession] = useState<SessionState>({
    sessionId: null,
    active: false,
    architecture: 'cascaded',
    channel: 'phone',
    startedAt: null,
  });
  const [sessionBusy, setSessionBusy] = useState(false);
  const [menu, setMenu] = useState<PizzaMenuItem[]>(PIZZERIA_MENU);
  const [scenarios, setScenarios] = useState<ChaosScenario[]>(CHAOS_SCENARIOS);
  const [orders, setOrders] = useState<OrderTicket[]>([]);
  const [transcripts, setTranscripts] = useState<TranscriptEntry[]>([]);
  const [alerts, setAlerts] = useState<NonOrderAlert[]>([]);
  const [liveInterimUser, setLiveInterimUser] = useState('');
  const [liveInterimAgent, setLiveInterimAgent] = useState('');
  const [liveDetectedLanguages, setLiveDetectedLanguages] = useState<DetectedLanguageInfo[]>([]);
  const [errorBanner, setErrorBanner] = useState<string | null>(null);

  const liveWsRef = useRef<WebSocket | null>(null);
  const pcmPlayerRef = useRef<LivePcmPlayer | null>(null);
  const sessionRef = useRef(session);
  sessionRef.current = session;

  const refreshState = useCallback(async () => {
    try {
      const res = await fetch('/api/state');
      if (!res.ok) return;
      const data = await res.json();
      if (data.session) setSession(data.session);
      if (Array.isArray(data.orders)) setOrders(data.orders);
      if (Array.isArray(data.transcripts)) setTranscripts(data.transcripts);
      if (Array.isArray(data.alerts)) setAlerts(data.alerts);
      if (Array.isArray(data.menu)) setMenu(data.menu);
      if (Array.isArray(data.scenarios)) setScenarios(data.scenarios);
    } catch {
      // ignore initial hydration transient error
    }
  }, []);

  useEffect(() => {
    void refreshState();
    return () => {
      if (liveWsRef.current) {
        liveWsRef.current.close();
        liveWsRef.current = null;
      }
      pcmPlayerRef.current?.dispose();
    };
  }, [refreshState]);

  const stopActiveSession = useCallback(async () => {
    setSessionBusy(true);
    try {
      if (liveWsRef.current) {
        liveWsRef.current.close();
        liveWsRef.current = null;
      }
      pcmPlayerRef.current?.stopAll();
      setLiveInterimUser('');
      setLiveInterimAgent('');
      setLiveDetectedLanguages([]);

      const res = await fetch('/api/session/stop', { method: 'POST' });
      const data = await res.json();
      if (data.session) {
        setSession(data.session);
      }
    } finally {
      setSessionBusy(false);
    }
  }, []);

  const startActiveSession = useCallback(async () => {
    const current = sessionRef.current;
    setSessionBusy(true);
    setErrorBanner(null);

    if (current.architecture === 'gemini-live') {
      if (!pcmPlayerRef.current) {
        pcmPlayerRef.current = new LivePcmPlayer();
      }
      pcmPlayerRef.current.unlock();
    }

    try {
      if (current.architecture === 'cascaded') {
        const res = await fetch('/api/session/start', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            architecture: 'cascaded',
            channel: current.channel,
          }),
        });
        const data = await res.json();
        if (!res.ok) {
          throw new Error(data.error || 'Failed to start Cascaded session');
        }
        setSession(data.session);
      } else {
        // Connect Gemini Live WebSocket
        if (!pcmPlayerRef.current) {
          pcmPlayerRef.current = new LivePcmPlayer();
        }
        const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = `${proto}//${window.location.host}/api/live?channel=${current.channel}`;

        await new Promise<void>((resolve, reject) => {
          const ws = new WebSocket(wsUrl);
          liveWsRef.current = ws;

          ws.onopen = () => {
            // Wait for server session_started message
          };

          ws.onmessage = (event) => {
            const msg = JSON.parse(event.data as string);
            if (msg.type === 'session_started') {
              setSession(msg.session);
              resolve();
            } else if (msg.type === 'audio' && msg.data) {
              pcmPlayerRef.current?.enqueuePcm24kBase64(msg.data);
            } else if (msg.type === 'interrupted') {
              pcmPlayerRef.current?.stopAll();
              setLiveInterimAgent('');
            } else if (msg.type === 'input_transcript') {
              setLiveInterimUser((prev) => `${prev}${msg.text}`);
              if (Array.isArray(msg.detectedLanguages) && msg.detectedLanguages.length > 0) {
                setLiveDetectedLanguages(msg.detectedLanguages as DetectedLanguageInfo[]);
              }
            } else if (msg.type === 'language_detected' && msg.languageCode) {
              const code = normalizeLanguageBase(String(msg.languageCode));
              const label = getLanguageLabel(code);
              setLiveDetectedLanguages((prev) => {
                const rest = prev.filter((item) => item.code !== code);
                return [{ code, label, confidence: 0.96 }, ...rest].slice(0, 4);
              });
            } else if (msg.type === 'output_transcript') {
              setLiveInterimAgent((prev) => `${prev}${msg.text}`);
            } else if (msg.type === 'turn_committed') {
              setLiveInterimUser('');
              setLiveInterimAgent('');
              setLiveDetectedLanguages([]);
              void refreshState();
            } else if (msg.type === 'order_updated') {
              if (msg.order) {
                const updated = msg.order as OrderTicket;
                setOrders((prev) => [updated, ...prev.filter((o) => o.id !== updated.id)]);
              }
              void refreshState();
            } else if (msg.type === 'alert_created') {
              void refreshState();
            } else if (msg.type === 'session_stopped') {
              setLiveDetectedLanguages([]);
              setSession((prev) => ({ ...prev, active: false, sessionId: null }));
            } else if (msg.type === 'error') {
              setErrorBanner(msg.message || 'Gemini Live error');
              reject(new Error(msg.message || 'Gemini Live error'));
            }
          };

          ws.onerror = () => {
            reject(new Error('Unable to connect to Gemini Live WebSocket.'));
          };

          ws.onclose = () => {
            liveWsRef.current = null;
            setSession((prev) => ({ ...prev, active: false, sessionId: null }));
          };
        });
      }
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : 'Unable to start session');
    } finally {
      setSessionBusy(false);
    }
  }, [refreshState]);

  const handleToggleSession = useCallback(async () => {
    if (sessionRef.current.active) {
      await stopActiveSession();
    } else {
      await startActiveSession();
    }
  }, [startActiveSession, stopActiveSession]);

  const handleSelectArchitecture = useCallback(
    async (arch: VoiceArchitecture) => {
      if (arch === sessionRef.current.architecture) return;
      const check = canSwitchArchitecture(sessionRef.current.active);
      if (!check.allowed) {
        // Stop active session cleanly before switching, preserving cleanup
        await stopActiveSession();
      }
      setErrorBanner(null);
      const res = await fetch('/api/session/preferences', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          architecture: arch,
          channel: sessionRef.current.channel,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setErrorBanner(data.error || 'Cannot switch architecture');
        return;
      }
      setSession(data.session);
    },
    [stopActiveSession]
  );

  const handleSelectChannel = useCallback(async (ch: StationChannel) => {
    if (ch === sessionRef.current.channel) return;
    if (sessionRef.current.active && sessionRef.current.architecture === 'gemini-live') {
      setErrorBanner('Stop the active Gemini Live session before switching between Phone and Counter.');
      return;
    }
    const res = await fetch('/api/session/preferences', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        architecture: sessionRef.current.architecture,
        channel: ch,
      }),
    });
    const data = await res.json();
    if (res.ok && data.session) {
      setSession(data.session);
    }
  }, []);

  const handleSubmitCascadedAudio = useCallback(
    async (payload: {
      audioBase64?: string;
      audioMimeType?: string;
      imageBase64?: string;
      textInput?: string;
    }) => {
      setErrorBanner(null);
      const res = await fetch('/api/cascaded/turn', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          channel: sessionRef.current.channel,
          ...payload,
          enableTtsReply: true,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setErrorBanner(data.error || 'Cascaded turn failed');
        return;
      }
      await refreshState();
      if (data.transcriptEntry?.replyAudioBase64) {
        const { playAudioBase64 } = await import('./utils/audioEngine');
        playAudioBase64(
          data.transcriptEntry.replyAudioBase64,
          data.transcriptEntry.replyAudioMimeType
        );
      }
    },
    [refreshState]
  );

  const handleSendLiveAudioChunk = useCallback((pcm16kBase64: string) => {
    const ws = liveWsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ audio: pcm16kBase64 }));
    }
  }, []);

  const handleSendLiveVideoFrame = useCallback((jpegBase64: string) => {
    const ws = liveWsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ video: jpegBase64 }));
    }
  }, []);

  const handleSendLiveText = useCallback((text: string) => {
    const ws = liveWsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ text }));
    }
  }, []);

  const handleFinishLiveTurn = useCallback(() => {
    const ws = liveWsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ audioStreamEnd: true }));
    }
  }, []);

  const handleResolveAlert = useCallback(
    async (id: string) => {
      await fetch(`/api/alerts/${id}/resolve`, { method: 'POST' });
      await refreshState();
    },
    [refreshState]
  );

  const handleAdvanceOrderStatus = useCallback(
    async (order: OrderTicket) => {
      const next = nextOrderStatus(order.status);
      await fetch(`/api/orders/${order.id}/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: next }),
      });
      await refreshState();
    },
    [refreshState]
  );

  const handleSyncShopify = useCallback(
    async (orderId: string) => {
      const res = await fetch(`/api/orders/${orderId}/shopify-draft`, {
        method: 'POST',
      });
      const data = await res.json();
      await refreshState();
      return (data.shopifyPayload as Record<string, unknown>) ?? null;
    },
    [refreshState]
  );

  const handleDeleteOrder = useCallback(
    async (orderId: string) => {
      await fetch(`/api/orders/${orderId}`, { method: 'DELETE' });
      await refreshState();
    },
    [refreshState]
  );

  const handleClearCompletedOrders = useCallback(async () => {
    await fetch('/api/orders/completed', { method: 'DELETE' });
    await refreshState();
  }, [refreshState]);

  const handleQuickAddMenuItem = useCallback(
    async (item: PizzaMenuItem) => {
      await fetch('/api/orders/manual-add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          menuItemId: item.id,
          quantity: 1,
          channel: sessionRef.current.channel,
          partyLabel: 'Counter Walk-In',
        }),
      });
      await refreshState();
      setActiveView('orders');
    },
    [refreshState]
  );

  const openOrdersCount = orders.filter((o) => o.status !== 'paid').length;

  return (
    <div className="min-h-screen flex flex-col bg-[#F8F7F4] text-[#171717]">
      <TopBar
        activeView={activeView}
        onNavigate={setActiveView}
        session={session}
        onToggleSession={handleToggleSession}
        sessionBusy={sessionBusy}
        openOrdersCount={openOrdersCount}
      />

      <main className="flex-1 mx-auto w-full max-w-[1440px] px-6 py-6">
        {activeView === 'station' && (
          <StationWorkspace
            session={session}
            scenarios={scenarios}
            transcripts={transcripts}
            orders={orders}
            alerts={alerts}
            liveInterimUser={liveInterimUser}
            liveInterimAgent={liveInterimAgent}
            liveDetectedLanguages={liveDetectedLanguages}
            onSelectArchitecture={handleSelectArchitecture}
            onSelectChannel={handleSelectChannel}
            onStartSession={startActiveSession}
            onStopSession={stopActiveSession}
            onSubmitCascadedAudio={handleSubmitCascadedAudio}
            onSendLiveAudioChunk={handleSendLiveAudioChunk}
            onSendLiveVideoFrame={handleSendLiveVideoFrame}
            onSendLiveText={handleSendLiveText}
            onFinishLiveTurn={handleFinishLiveTurn}
            onResolveAlert={handleResolveAlert}
            onAdvanceOrderStatus={handleAdvanceOrderStatus}
            onOpenOrdersBoard={() => setActiveView('orders')}
            errorBanner={errorBanner}
            onDismissError={() => setErrorBanner(null)}
          />
        )}

        {activeView === 'orders' && (
          <OrdersBoard
            orders={orders}
            onAdvanceStatus={handleAdvanceOrderStatus}
            onSyncShopify={handleSyncShopify}
            onDeleteOrder={handleDeleteOrder}
            onClearCompleted={handleClearCompletedOrders}
          />
        )}

        {activeView === 'stress' && <StressLab onStressCompleted={refreshState} />}

        {activeView === 'menu' && (
          <MenuCatalog menu={menu} onQuickAdd={handleQuickAddMenuItem} />
        )}

        {activeView === 'assistant' && <ChatAssistant />}

        {activeView === 'fixit' && <FixItCam />}
      </main>

      <footer className="border-t border-[#E5E0D8] bg-[#F8F7F4] py-4">
        <div className="mx-auto flex max-w-[1440px] flex-wrap items-center justify-between gap-4 px-6 text-xs text-[#737373]">
          <span>VoicePizza — P1 Phone Line &amp; P2 Counter Multilingual Agent</span>
          <span>
            Active Architecture:{' '}
            {session.architecture === 'cascaded' ? 'Cascaded' : 'Gemini Live'}
          </span>
        </div>
      </footer>
    </div>
  );
}
