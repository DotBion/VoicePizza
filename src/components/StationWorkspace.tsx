import {
  Camera,
  CameraOff,
  Check,
  Languages,
  Mic,
  MicOff,
  Phone,
  Radio,
  Send,
  Square,
  Store,
  Volume2,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type {
  ChaosScenario,
  NonOrderAlert,
  OrderTicket,
  SessionState,
  StationChannel,
  TranscriptEntry,
  VoiceArchitecture,
} from '../types/voicepizza';
import {
  type DetectedLanguageInfo,
  detectStreamLanguages,
  getLanguageLabel,
  normalizeLanguageBase,
} from '../shared/languageDetect';
import {
  formatCurrency,
  formatOrderTimestamp,
  ORDER_STAGE_META,
} from '../shared/orderEngine';
import { AudioMeter } from './AudioMeter';
import {
  AUDIO_METER_THRESHOLDS,
  analyzeAudioFrame,
  createNoiseGateState,
  downsampleFloat32,
  encodeWavFromFloat32,
  float32ToInt16Base64,
  mixSynthesizedTracksTo16k,
  playAudioBase64,
  processNoiseGateFrame,
  type NoiseGateState,
  uint8ToBase64,
} from '../utils/audioEngine';

interface StationWorkspaceProps {
  session: SessionState;
  scenarios: ChaosScenario[];
  transcripts: TranscriptEntry[];
  orders: OrderTicket[];
  alerts: NonOrderAlert[];
  liveInterimUser: string;
  liveInterimAgent: string;
  liveDetectedLanguages: DetectedLanguageInfo[];
  onSelectArchitecture: (arch: VoiceArchitecture) => void;
  onSelectChannel: (ch: StationChannel) => void;
  onStartSession: () => Promise<void>;
  onStopSession: () => Promise<void>;
  onSubmitCascadedAudio: (payload: {
    audioBase64?: string;
    audioMimeType?: string;
    imageBase64?: string;
    textInput?: string;
  }) => Promise<void>;
  onSendLiveAudioChunk: (pcm16kBase64: string) => void;
  onSendLiveVideoFrame: (jpegBase64: string) => void;
  onSendLiveText: (text: string) => void;
  onFinishLiveTurn: () => void;
  onResolveAlert: (id: string) => Promise<void>;
  onAdvanceOrderStatus: (order: OrderTicket) => Promise<void>;
  onOpenOrdersBoard: () => void;
  errorBanner: string | null;
  onDismissError: () => void;
}

export function StationWorkspace({
  session,
  scenarios,
  transcripts,
  orders,
  alerts,
  liveInterimUser,
  liveInterimAgent,
  liveDetectedLanguages,
  onSelectArchitecture,
  onSelectChannel,
  onStartSession,
  onStopSession,
  onSubmitCascadedAudio,
  onSendLiveAudioChunk,
  onSendLiveVideoFrame,
  onSendLiveText,
  onFinishLiveTurn,
  onResolveAlert,
  onAdvanceOrderStatus,
  onOpenOrdersBoard,
  errorBanner,
  onDismissError,
}: StationWorkspaceProps) {
  const [micActive, setMicActive] = useState(false);
  const [micMode, setMicMode] = useState<'agent' | 'transcribe' | 'monitor'>('agent');
  const [micLevel, setMicLevel] = useState(0);
  const [micPeak, setMicPeak] = useState(0);
  const [micDbfs, setMicDbfs] = useState(-60);
  const [sustainedLoudMs, setSustainedLoudMs] = useState(0);
  const [ambientFloor, setAmbientFloor] = useState(0.04);
  const [voiceThreshold, setVoiceThreshold] = useState(0.128);
  const [calibrating, setCalibrating] = useState(false);
  const [gateOpen, setGateOpen] = useState(false);
  const [noiseGateEnabled, setNoiseGateEnabled] = useState(true);
  const [chaosMeterActive, setChaosMeterActive] = useState(false);
  const [micError, setMicError] = useState<string | null>(null);
  const [quickTranscript, setQuickTranscript] = useState<{
    text: string;
    latencyMs: number;
  } | null>(null);
  const [cameraActive, setCameraActive] = useState(false);
  const [processingTurn, setProcessingTurn] = useState(false);
  const [synthesizingChaos, setSynthesizingChaos] = useState(false);
  const [broadcastStatus, setBroadcastStatus] = useState<string | null>(null);
  const [utteranceInput, setUtteranceInput] = useState('');
  const [cameraSnapshotNotice, setCameraSnapshotNotice] = useState<string | null>(null);

  const micStreamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const cascadedBuffersRef = useRef<Float32Array[]>([]);
  const micSampleRateRef = useRef<number>(16000);
  const micModeRef = useRef<'agent' | 'transcribe' | 'monitor'>('agent');
  micModeRef.current = micMode;
  const noiseGateEnabledRef = useRef(true);
  noiseGateEnabledRef.current = noiseGateEnabled;
  const noiseGateStateRef = useRef<NoiseGateState>(createNoiseGateState());
  const preRoll16kRef = useRef<Float32Array | null>(null);
  const hadSpeechInLiveGateRef = useRef(false);
  const peakHoldRef = useRef(0);
  const sustainedLoudRef = useRef(0);
  const ambientFloorRef = useRef(0);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const cameraStreamRef = useRef<MediaStream | null>(null);
  const cameraTimerRef = useRef<number | null>(null);

  const activeSessionRef = useRef(session);
  activeSessionRef.current = session;

  const matchingScenario =
    scenarios.find((s) => s.channel === session.channel) ?? scenarios[0];

  const latestTriage = transcripts.find((t) => t.triage)?.triage;
  const openAlerts = alerts.filter((a) => !a.resolved);
  const activeOrders = orders.filter((o) => o.status !== 'paid');
  const latestOrder = activeOrders[0] ?? null;

  const liveStreamLanguages =
    liveDetectedLanguages.length > 0
      ? liveDetectedLanguages
      : liveInterimUser.trim()
        ? detectStreamLanguages(liveInterimUser).languages
        : [];

  const transcribeLanguages = quickTranscript?.text
    ? detectStreamLanguages(quickTranscript.text).languages
    : [];

  const committedTurnLanguages: DetectedLanguageInfo[] = (() => {
    const latest = transcripts[0];
    if (!latest) return [];
    const seen = new Set<string>();
    const list: DetectedLanguageInfo[] = [];

    const triageChoice = latest.triage?.primaryLanguage?.choice;
    if (triageChoice && normalizeLanguageBase(triageChoice) !== 'other') {
      const base = normalizeLanguageBase(triageChoice);
      seen.add(base);
      list.push({
        code: base,
        label: getLanguageLabel(base),
        confidence: latest.triage!.primaryLanguage.confidence,
      });
    }

    for (const seg of latest.segments) {
      const base = normalizeLanguageBase(seg.languageCode);
      if (base && base !== 'other' && !seen.has(base)) {
        seen.add(base);
        list.push({
          code: base,
          label: getLanguageLabel(base),
          confidence: 0.9,
        });
      }
    }

    if (list.length === 0 && latest.rawTranscript.trim()) {
      const streamDetected = detectStreamLanguages(latest.rawTranscript).languages;
      if (streamDetected.length > 0) {
        return streamDetected;
      }
    }

    if (list.length === 0 && triageChoice) {
      const base = normalizeLanguageBase(triageChoice);
      list.push({
        code: base,
        label: getLanguageLabel(base),
        confidence: latest.triage!.primaryLanguage.confidence,
      });
    }
    return list;
  })();

  const activeLanguageDisplay = (() => {
    if (liveStreamLanguages.length > 0) {
      return {
        status: 'detected' as const,
        languages: liveStreamLanguages,
        source: 'Live Voice Stream',
      };
    }
    if (micActive && micMode !== 'monitor') {
      return {
        status: 'listening' as const,
        languages: [] as DetectedLanguageInfo[],
        source:
          micMode === 'transcribe'
            ? 'Listening · gemini-3.5-transcribe'
            : session.architecture === 'gemini-live'
              ? 'Listening · Gemini Live'
              : 'Listening · Cascaded Turn',
      };
    }
    if (transcribeLanguages.length > 0) {
      return {
        status: 'detected' as const,
        languages: transcribeLanguages,
        source: 'Audio Transcription',
      };
    }
    if (committedTurnLanguages.length > 0) {
      return {
        status: 'detected' as const,
        languages: committedTurnLanguages,
        source: transcripts[0]?.triage?.primaryLanguage
          ? 'Latest Turn · Decisions API'
          : 'Latest Voice Turn',
      };
    }
    return {
      status: 'standby' as const,
      languages: [] as DetectedLanguageInfo[],
      source: '90+ Gemini Languages · Auto-Detect Ready',
    };
  })();

  useEffect(() => {
    return () => {
      stopMicCapture(true);
      stopCamera();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Stop active agent mic stream when switching or stopping session
  useEffect(() => {
    if (
      !session.active &&
      micActive &&
      micModeRef.current === 'agent' &&
      session.architecture === 'gemini-live'
    ) {
      stopMicCapture(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.active, session.architecture]);

  function captureLatestCameraFrame(): string | undefined {
    const video = videoRef.current;
    if (!video || !cameraActive || video.videoWidth === 0) return undefined;
    const canvas = document.createElement('canvas');
    canvas.width = 640;
    canvas.height = Math.round((video.videoHeight / video.videoWidth) * 640) || 360;
    const ctx = canvas.getContext('2d');
    if (!ctx) return undefined;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL('image/jpeg', 0.75);
    return dataUrl.split(',')[1];
  }

  async function toggleCamera() {
    if (cameraActive) {
      stopCamera();
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: 640, height: 360 },
      });
      cameraStreamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      setCameraActive(true);
      setCameraSnapshotNotice('Counter camera ready (1 FPS in Live, frame attached on Cascaded turns).');

      cameraTimerRef.current = window.setInterval(() => {
        if (
          activeSessionRef.current.active &&
          activeSessionRef.current.architecture === 'gemini-live'
        ) {
          const frame = captureLatestCameraFrame();
          if (frame) onSendLiveVideoFrame(frame);
        }
      }, 1000);
    } catch (err) {
      setCameraSnapshotNotice(
        err instanceof Error ? `Camera unavailable: ${err.message}` : 'Camera permission denied.'
      );
    }
  }

  function stopCamera() {
    if (cameraTimerRef.current !== null) {
      window.clearInterval(cameraTimerRef.current);
      cameraTimerRef.current = null;
    }
    if (cameraStreamRef.current) {
      cameraStreamRef.current.getTracks().forEach((t) => t.stop());
      cameraStreamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    setCameraActive(false);
  }

  function processAudioFrameWithGate(samples: Float32Array, sampleRate: number) {
    const result = processNoiseGateFrame(
      noiseGateStateRef.current,
      samples,
      sampleRate,
      { enabled: noiseGateEnabledRef.current }
    );
    noiseGateStateRef.current = result.nextState;

    setMicLevel(result.metrics.level);
    setMicPeak(result.nextState.peakHold);
    setMicDbfs(result.metrics.dbfs);
    setSustainedLoudMs(result.nextState.sustainedLoudMs);
    setAmbientFloor(result.nextState.noiseFloor);
    setVoiceThreshold(result.nextState.openThreshold);
    setCalibrating(result.nextState.calibrating);
    setGateOpen(result.gateOpen);

    return result;
  }

  function updateVisualMeterOnly(samples: Float32Array, sampleRate: number) {
    const metrics = analyzeAudioFrame(samples);
    const frameDurationMs = Math.round((samples.length / Math.max(1, sampleRate)) * 1000);
    peakHoldRef.current = Math.max(metrics.peak, peakHoldRef.current * 0.86);
    ambientFloorRef.current =
      ambientFloorRef.current === 0
        ? metrics.level
        : Number((ambientFloorRef.current * 0.88 + metrics.level * 0.12).toFixed(3));
    if (metrics.level >= AUDIO_METER_THRESHOLDS.LOUD_MIN) {
      sustainedLoudRef.current = Math.min(2500, sustainedLoudRef.current + frameDurationMs);
    } else {
      sustainedLoudRef.current = Math.max(0, sustainedLoudRef.current - frameDurationMs * 1.5);
    }
    setMicLevel(metrics.level);
    setMicPeak(Number(peakHoldRef.current.toFixed(3)));
    setMicDbfs(metrics.dbfs);
    setSustainedLoudMs(Math.round(sustainedLoudRef.current));
    setAmbientFloor(ambientFloorRef.current);
    setCalibrating(false);
    setGateOpen(true);
  }

  function resetMeterMetrics() {
    const freshGate = createNoiseGateState();
    noiseGateStateRef.current = freshGate;
    preRoll16kRef.current = null;
    hadSpeechInLiveGateRef.current = false;
    peakHoldRef.current = 0;
    sustainedLoudRef.current = 0;
    ambientFloorRef.current = 0;
    setMicLevel(0);
    setMicPeak(0);
    setMicDbfs(-60);
    setSustainedLoudMs(0);
    setAmbientFloor(freshGate.noiseFloor);
    setVoiceThreshold(freshGate.openThreshold);
    setCalibrating(false);
    setGateOpen(false);
  }

  function handleRecalibrateNoiseFloor() {
    const freshGate = createNoiseGateState();
    noiseGateStateRef.current = freshGate;
    preRoll16kRef.current = null;
    hadSpeechInLiveGateRef.current = false;
    setAmbientFloor(freshGate.noiseFloor);
    setVoiceThreshold(freshGate.openThreshold);
    setCalibrating(true);
    setGateOpen(false);
  }

  function handleToggleNoiseGate() {
    setNoiseGateEnabled((prev) => {
      const next = !prev;
      noiseGateEnabledRef.current = next;
      if (next) {
        handleRecalibrateNoiseFloor();
      } else {
        setCalibrating(false);
      }
      return next;
    });
  }

  async function startMicCapture(mode: 'agent' | 'transcribe' | 'monitor' = 'agent') {
    if (micActive) {
      await stopMicCapture(true);
    }
    setMicError(null);
    setMicMode(mode);
    micModeRef.current = mode;
    resetMeterMetrics();
    if (noiseGateEnabledRef.current) {
      setCalibrating(true);
    }

    // Create and unlock AudioContext synchronously inside user click gesture
    const ctx = new AudioContext();
    audioCtxRef.current = ctx;
    if (ctx.state === 'suspended') {
      await ctx.resume();
    }
    micSampleRateRef.current = ctx.sampleRate;

    try {
      if (mode === 'agent' && !activeSessionRef.current.active) {
        await onStartSession();
      }

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      micStreamRef.current = stream;

      if (ctx.state === 'suspended') {
        await ctx.resume();
      }

      const source = ctx.createMediaStreamSource(stream);
      const processor = ctx.createScriptProcessor(4096, 1, 1);
      const silentGain = ctx.createGain();
      silentGain.gain.value = 0;

      processorRef.current = processor;
      cascadedBuffersRef.current = [];

      processor.onaudioprocess = (event) => {
        const rawChannel = event.inputBuffer.getChannelData(0);
        const gateResult = processAudioFrameWithGate(rawChannel, ctx.sampleRate);

        if (micModeRef.current === 'monitor') {
          return;
        }

        const downsampled16k = downsampleFloat32(rawChannel, ctx.sampleRate, 16000);

        if (
          micModeRef.current === 'agent' &&
          activeSessionRef.current.architecture === 'gemini-live'
        ) {
          if (gateResult.shouldStreamToLive) {
            hadSpeechInLiveGateRef.current = true;
            if (gateResult.justOpened && preRoll16kRef.current) {
              onSendLiveAudioChunk(float32ToInt16Base64(preRoll16kRef.current));
              preRoll16kRef.current = null;
            }
            onSendLiveAudioChunk(float32ToInt16Base64(downsampled16k));
          } else {
            preRoll16kRef.current = new Float32Array(downsampled16k);
            if (gateResult.justClosedWithSpeech) {
              hadSpeechInLiveGateRef.current = false;
              onFinishLiveTurn();
            }
          }
        } else {
          cascadedBuffersRef.current.push(new Float32Array(downsampled16k));
        }
      };

      source.connect(processor);
      processor.connect(silentGain);
      silentGain.connect(ctx.destination);
      setMicActive(true);
    } catch (err) {
      if (ctx.state !== 'closed') {
        await ctx.close();
      }
      audioCtxRef.current = null;
      resetMeterMetrics();
      setMicError(
        err instanceof Error ? err.message : 'Unable to access microphone. Check browser permissions.'
      );
    }
  }

  async function stopMicCapture(discard = false) {
    const shouldFlushLiveTurn =
      !discard &&
      micModeRef.current === 'agent' &&
      activeSessionRef.current.architecture === 'gemini-live' &&
      hadSpeechInLiveGateRef.current;

    resetMeterMetrics();
    if (processorRef.current) {
      processorRef.current.disconnect();
      processorRef.current = null;
    }
    if (micStreamRef.current) {
      micStreamRef.current.getTracks().forEach((t) => t.stop());
      micStreamRef.current = null;
    }
    if (audioCtxRef.current && audioCtxRef.current.state !== 'closed') {
      await audioCtxRef.current.close();
      audioCtxRef.current = null;
    }
    setMicActive(false);

    if (shouldFlushLiveTurn) {
      onFinishLiveTurn();
    }

    if (discard || micModeRef.current === 'monitor') {
      cascadedBuffersRef.current = [];
      return;
    }

    const chunks = cascadedBuffersRef.current;
    cascadedBuffersRef.current = [];

    if (micModeRef.current === 'transcribe') {
      const totalLen = chunks.reduce((acc, c) => acc + c.length, 0);
      if (totalLen > 800) {
        const merged = new Float32Array(totalLen);
        let offset = 0;
        for (const c of chunks) {
          merged.set(c, offset);
          offset += c.length;
        }
        const wavBytes = encodeWavFromFloat32(merged, 16000);
        const wavBase64 = uint8ToBase64(wavBytes);
        setProcessingTurn(true);
        try {
          const res = await fetch('/api/transcribe', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ audioBase64: wavBase64, audioMimeType: 'audio/wav' }),
          });
          const data = await res.json();
          if (!res.ok) {
            setMicError(data.error || 'Transcription failed');
          } else {
            setQuickTranscript({
              text: data.transcript || '(No intelligible speech detected)',
              latencyMs: data.latencyMs ?? 0,
            });
          }
        } finally {
          setProcessingTurn(false);
        }
      }
      return;
    }

    if (activeSessionRef.current.architecture === 'cascaded') {
      const totalLen = chunks.reduce((acc, c) => acc + c.length, 0);
      if (totalLen > 800) {
        const merged = new Float32Array(totalLen);
        let offset = 0;
        for (const c of chunks) {
          merged.set(c, offset);
          offset += c.length;
        }
        const wavBytes = encodeWavFromFloat32(merged, 16000);
        const wavBase64 = uint8ToBase64(wavBytes);
        const frame = captureLatestCameraFrame();
        setProcessingTurn(true);
        try {
          await onSubmitCascadedAudio({
            audioBase64: wavBase64,
            audioMimeType: 'audio/wav',
            imageBase64: frame,
          });
        } finally {
          setProcessingTurn(false);
        }
      }
    }
  }

  async function handleToggleMic() {
    if (micActive && micMode === 'agent') {
      await stopMicCapture(false);
    } else {
      await startMicCapture('agent');
    }
  }

  async function handleToggleTranscribeMic() {
    if (micActive && micMode === 'transcribe') {
      await stopMicCapture(false);
    } else {
      await startMicCapture('transcribe');
    }
  }

  async function handleToggleMonitorMic() {
    if (micActive && micMode === 'monitor') {
      await stopMicCapture(true);
    } else {
      await startMicCapture('monitor');
    }
  }

  async function handleBroadcastChaosAudio() {
    if (!matchingScenario) return;
    setSynthesizingChaos(true);
    setBroadcastStatus('Synthesizing multi-language speakers via Gemini 3.8 TTS...');
    try {
      if (!session.active) {
        await onStartSession();
      }
      const res = await fetch('/api/chaos/synthesize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scenarioId: matchingScenario.id }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to synthesize multi-language audio');
      }

      setBroadcastStatus('Mixing overlapping acoustic streams at 16kHz...');
      const mixed = await mixSynthesizedTracksTo16k(data.tracks);

      // Play the actual overlapping multi-speaker acoustic mix in the browser
      playAudioBase64(mixed.wavBase64, 'audio/wav');

      if (activeSessionRef.current.architecture === 'cascaded') {
        setBroadcastStatus('Running Cascaded pipeline (Transcribe → Decisions API → Gemini 4 Neon & Hydrogen → TTS)...');
        setProcessingTurn(true);
        try {
          const frame = captureLatestCameraFrame();
          await onSubmitCascadedAudio({
            audioBase64: mixed.wavBase64,
            audioMimeType: 'audio/wav',
            imageBase64: frame,
          });
          setBroadcastStatus(null);
        } finally {
          setProcessingTurn(false);
        }
      } else {
        setBroadcastStatus('Streaming real 16kHz PCM acoustic mix into Gemini Live WebSocket...');
        setChaosMeterActive(true);
        // Stream 16kHz PCM in 4096-sample chunks so Gemini Live processes the overlapping audio in real time
        const samples = mixed.pcm16kSamples;
        const step = 4096;
        try {
          for (let i = 0; i < samples.length; i += step) {
            const slice = samples.subarray(i, Math.min(i + step, samples.length));
            updateVisualMeterOnly(slice, 16000);
            onSendLiveAudioChunk(float32ToInt16Base64(slice));
            await new Promise((r) => setTimeout(r, 120));
          }
          onFinishLiveTurn();
          setBroadcastStatus(null);
        } finally {
          setChaosMeterActive(false);
          resetMeterMetrics();
        }
      }
    } catch (err) {
      setBroadcastStatus(err instanceof Error ? err.message : 'Acoustic broadcast failed');
    } finally {
      setSynthesizingChaos(false);
    }
  }

  async function handleSendTextTurn(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = utteranceInput.trim();
    if (!trimmed) return;
    if (!session.active) {
      await onStartSession();
    }
    setUtteranceInput('');

    if (activeSessionRef.current.architecture === 'gemini-live') {
      onSendLiveText(trimmed);
    } else {
      setProcessingTurn(true);
      try {
        const frame = captureLatestCameraFrame();
        await onSubmitCascadedAudio({ textInput: trimmed, imageBase64: frame });
      } finally {
        setProcessingTurn(false);
      }
    }
  }

  return (
    <div className="space-y-6">
      {/* Compact Hero / Context Banner with Editorial Pizzeria Visual */}
      <section className="grid grid-cols-1 lg:grid-cols-12 items-stretch gap-6 border border-[#E5E0D8] bg-white rounded-xl overflow-hidden">
        <div className="lg:col-span-7 p-6 lg:p-8 flex flex-col justify-between gap-5">
          <div className="space-y-2.5">
            <p className="text-xs font-medium tracking-wide text-[#737373]">
              Multilingual Phone &amp; Counter Dispatch · Gemini 4 Orchestration
            </p>
            <h1 className="font-display text-3xl lg:text-4xl font-bold tracking-tight text-[#171717] text-balance">
              Take every phone and counter order in any language at once.
            </h1>
            <p className="text-sm leading-relaxed text-[#525252] max-w-2xl">
              Switch between Cascaded and Gemini Live architectures on the same station across 90+
              Gemini languages. Separate British English callers, German companions, Greek queue
              guests, and Mandarin supplier deliveries in one acoustic pass.
            </p>
          </div>

          {/* Workspace Mode Toolbar (kept strictly outside the Top Bar) */}
          <div className="flex flex-wrap items-center gap-4 pt-2 border-t border-[#EFECE6]">
            {/* Architecture Switch */}
            <div className="space-y-1.5">
              <span className="block text-xs font-medium text-[#737373]">Voice Architecture</span>
              <div
                role="group"
                aria-label="Voice Architecture Switch"
                className="inline-flex items-center gap-1 rounded-lg bg-[#EFECE6] p-1"
              >
                <button
                  type="button"
                  onClick={() => onSelectArchitecture('cascaded')}
                  className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-colors whitespace-nowrap shrink-0 ${
                    session.architecture === 'cascaded'
                      ? 'bg-white text-[#171717] shadow-xs'
                      : 'text-[#525252] hover:text-[#171717]'
                  }`}
                >
                  Cascaded
                </button>
                <button
                  type="button"
                  onClick={() => onSelectArchitecture('gemini-live')}
                  className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-colors whitespace-nowrap shrink-0 ${
                    session.architecture === 'gemini-live'
                      ? 'bg-white text-[#171717] shadow-xs'
                      : 'text-[#525252] hover:text-[#171717]'
                  }`}
                >
                  Gemini Live
                </button>
              </div>
            </div>

            {/* Channel Priority Switch */}
            <div className="space-y-1.5">
              <span className="block text-xs font-medium text-[#737373]">Station Priority</span>
              <div
                role="group"
                aria-label="Station Channel Switch"
                className="inline-flex items-center gap-1 rounded-lg bg-[#EFECE6] p-1"
              >
                <button
                  type="button"
                  onClick={() => onSelectChannel('phone')}
                  className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-md transition-colors whitespace-nowrap shrink-0 ${
                    session.channel === 'phone'
                      ? 'bg-white text-[#171717] shadow-xs'
                      : 'text-[#525252] hover:text-[#171717]'
                  }`}
                >
                  <Phone className="h-3.5 w-3.5" aria-hidden="true" />
                  P1 · Phone Line
                </button>
                <button
                  type="button"
                  onClick={() => onSelectChannel('counter')}
                  className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-md transition-colors whitespace-nowrap shrink-0 ${
                    session.channel === 'counter'
                      ? 'bg-white text-[#171717] shadow-xs'
                      : 'text-[#525252] hover:text-[#171717]'
                  }`}
                >
                  <Store className="h-3.5 w-3.5" aria-hidden="true" />
                  P2 · Counter Chaos
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* Editorial Right Photograph */}
        <div className="lg:col-span-5 relative min-h-[220px] bg-[#1C1917]">
          <img
            src="/src/assets/images/hero_pizzeria_counter_1795280909275.jpg"
            alt="Artisan wood-fired pizza counter during peak service"
            referrerPolicy="no-referrer"
            className="h-full w-full object-cover"
          />
          <div className="absolute inset-0 bg-gradient-to-t from-black/75 via-black/20 to-transparent" />
          <div className="absolute bottom-4 left-5 right-5 flex items-end justify-between gap-4 text-white">
            <div>
              <p className="text-xs font-medium text-white/80">
                {session.active ? 'Session Live' : 'Standby'} ·{' '}
                {session.architecture === 'cascaded'
                  ? 'Transcribe → Decisions → Neon → TTS'
                  : 'Gemini 3.8 Live Bidirectional PCM'}
              </p>
              <p className="font-display text-lg font-semibold">
                {session.channel === 'phone'
                  ? 'P1 Takeaway Phone Line'
                  : 'P2 Front Counter Terminal'}
              </p>
            </div>
            <button
              type="button"
              onClick={session.active ? onStopSession : onStartSession}
              className="px-3.5 py-2 text-xs font-semibold rounded-lg bg-white text-[#171717] hover:bg-[#F5F5F4] transition-colors whitespace-nowrap shrink-0"
            >
              {session.active ? 'End Call / Shift' : 'Connect Station'}
            </button>
          </div>
        </div>
      </section>

      {errorBanner && (
        <div
          role="alert"
          className="flex items-center justify-between gap-4 rounded-xl border border-[#C23B22]/30 bg-[#C23B22]/8 px-5 py-3 text-sm text-[#8F2411]"
        >
          <span>{errorBanner}</span>
          <button
            type="button"
            onClick={onDismissError}
            className="text-xs font-semibold underline underline-offset-2 whitespace-nowrap shrink-0"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Main 12-Column Operational Station */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* Left/Center 8 cols: Audio/Camera Capture + Live Transcript */}
        <div className="lg:col-span-8 space-y-6">
          {/* Capture & Real Acoustic Chaos Controls */}
          <section className="rounded-xl border border-[#E5E0D8] bg-white p-6 space-y-5">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div>
                <h2 className="font-display text-lg font-semibold text-[#171717]">
                  Audio &amp; Vision Capture
                </h2>
                <p className="text-xs text-[#737373]">
                  {session.architecture === 'cascaded'
                    ? 'Record live speech or broadcast a multi-speaker WAV mix through the Cascaded Gemini 4 pipeline.'
                    : 'Stream 16kHz PCM microphone audio + 1 FPS counter camera directly into Gemini Live with instant barge-in.'}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2.5">
                <button
                  type="button"
                  onClick={handleToggleMic}
                  disabled={processingTurn}
                  className={`inline-flex items-center gap-2 px-4 py-2.5 text-sm font-semibold rounded-lg transition-colors whitespace-nowrap shrink-0 ${
                    micActive && micMode === 'agent'
                      ? 'bg-[#171717] text-white hover:bg-[#2E2E2E]'
                      : 'bg-[#C23B22] text-white hover:bg-[#A6311B]'
                  }`}
                >
                  {micActive && micMode === 'agent' ? (
                    <>
                      {session.architecture === 'cascaded' ? (
                        <Square className="h-4 w-4" aria-hidden="true" />
                      ) : (
                        <MicOff className="h-4 w-4" aria-hidden="true" />
                      )}
                      {session.architecture === 'cascaded'
                        ? 'Stop & Process Turn'
                        : 'Stop Live Mic'}
                    </>
                  ) : (
                    <>
                      <Mic className="h-4 w-4" aria-hidden="true" />
                      {session.architecture === 'cascaded'
                        ? 'Record Voice Turn'
                        : 'Stream Live Mic'}
                    </>
                  )}
                </button>

                {micActive && micMode === 'agent' && session.architecture === 'gemini-live' && (
                  <button
                    type="button"
                    onClick={onFinishLiveTurn}
                    className="inline-flex items-center gap-1.5 px-3.5 py-2.5 text-sm font-semibold rounded-lg bg-[#1F6E4A] text-white hover:bg-[#19593C] transition-colors whitespace-nowrap shrink-0"
                  >
                    Reply Now
                  </button>
                )}

                <button
                  type="button"
                  onClick={handleToggleTranscribeMic}
                  disabled={processingTurn || (micActive && micMode === 'agent')}
                  className={`inline-flex items-center gap-2 px-3.5 py-2.5 text-sm font-medium rounded-lg border transition-colors whitespace-nowrap shrink-0 ${
                    micActive && micMode === 'transcribe'
                      ? 'border-[#C23B22] bg-[#C23B22]/10 text-[#C23B22]'
                      : 'border-[#E5E0D8] bg-[#F8F7F4] text-[#171717] hover:bg-[#EFECE6]'
                  }`}
                >
                  <Mic className="h-4 w-4" aria-hidden="true" />
                  {micActive && micMode === 'transcribe' ? 'Finish Transcribe' : 'Transcribe Audio'}
                </button>

                <button
                  type="button"
                  onClick={toggleCamera}
                  className={`inline-flex items-center gap-2 px-3.5 py-2.5 text-sm font-medium rounded-lg border transition-colors whitespace-nowrap shrink-0 ${
                    cameraActive
                      ? 'border-[#1F6E4A] bg-[#1F6E4A]/10 text-[#1F6E4A]'
                      : 'border-[#E5E0D8] bg-[#F8F7F4] text-[#171717] hover:bg-[#EFECE6]'
                  }`}
                >
                  {cameraActive ? (
                    <>
                      <CameraOff className="h-4 w-4" aria-hidden="true" />
                      Stop Counter Cam
                    </>
                  ) : (
                    <>
                      <Camera className="h-4 w-4" aria-hidden="true" />
                      Counter Cam
                    </>
                  )}
                </button>
              </div>
            </div>

            {/* Real-time Visual Audio Meter & Dynamic Noise Floor Gate */}
            <AudioMeter
              active={micActive || chaosMeterActive}
              sourceLabel={
                chaosMeterActive
                  ? 'Chaos 16kHz PCM Stream'
                  : !micActive
                    ? 'Ready'
                    : micMode === 'monitor'
                      ? 'Mic Level Check'
                      : micMode === 'transcribe'
                        ? 'gemini-3.5-transcribe'
                        : session.architecture === 'gemini-live'
                          ? 'Live 16kHz PCM'
                          : 'Cascaded Turn Recording'
              }
              level={micLevel}
              peak={micPeak}
              dbfs={micDbfs}
              sustainedLoudMs={sustainedLoudMs}
              ambientFloor={ambientFloor}
              voiceThreshold={voiceThreshold}
              calibrating={calibrating}
              gateOpen={gateOpen}
              noiseGateEnabled={noiseGateEnabled && !chaosMeterActive}
              isMonitoring={micActive && micMode === 'monitor'}
              disableMonitorToggle={
                processingTurn || chaosMeterActive || (micActive && micMode !== 'monitor')
              }
              onToggleMonitor={handleToggleMonitorMic}
              onToggleNoiseGate={handleToggleNoiseGate}
              onRecalibrateNoiseFloor={handleRecalibrateNoiseFloor}
            />

            {/* Real-time Detected Language Readout from Incoming Voice Stream */}
            <div
              data-testid="detected-language"
              data-status={activeLanguageDisplay.status}
              className="rounded-lg border border-[#E5E0D8] bg-[#F8F7F4] px-4 py-2.5 flex flex-wrap items-center justify-between gap-3 text-xs"
            >
              <div className="flex flex-wrap items-center gap-2">
                <Languages
                  className={`h-4 w-4 shrink-0 ${
                    activeLanguageDisplay.status === 'standby'
                      ? 'text-[#737373]'
                      : 'text-[#1F6E4A]'
                  }`}
                  aria-hidden="true"
                />
                <span className="text-[#525252] font-medium">Detected Language:</span>
                {activeLanguageDisplay.status === 'detected' ? (
                  <span className="font-semibold text-[#171717]">
                    {activeLanguageDisplay.languages
                      .map((lang) => `${lang.label} (${lang.code.toUpperCase()})`)
                      .join(' · ')}
                  </span>
                ) : activeLanguageDisplay.status === 'listening' ? (
                  <span className="font-semibold text-[#1F6E4A]">
                    Detecting incoming speech...
                  </span>
                ) : (
                  <span className="font-medium text-[#525252]">
                    Waiting for incoming voice
                  </span>
                )}
              </div>

              <div className="font-mono-tabular text-[#525252] flex items-center gap-2 whitespace-nowrap">
                <span>{activeLanguageDisplay.source}</span>
                {activeLanguageDisplay.status === 'detected' &&
                  activeLanguageDisplay.languages[0] && (
                    <>
                      <span className="text-[#A3A3A3]" aria-hidden="true">
                        ·
                      </span>
                      <span className="font-semibold text-[#1F6E4A]">
                        {Math.round(activeLanguageDisplay.languages[0].confidence * 100)}%
                      </span>
                    </>
                  )}
              </div>
            </div>

            {micError && (
              <p role="alert" className="text-xs font-medium text-[#C23B22]">
                {micError}
              </p>
            )}

            {quickTranscript && (
              <div className="rounded-lg border border-[#E5E0D8] bg-[#F8F7F4] p-3.5 flex items-start justify-between gap-3 text-xs">
                <div className="space-y-1">
                  <p className="font-semibold text-[#171717]">
                    gemini-3.5-transcribe · {quickTranscript.latencyMs} ms
                  </p>
                  <p className="text-sm text-[#171717]">{quickTranscript.text}</p>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setUtteranceInput(quickTranscript.text);
                    setQuickTranscript(null);
                  }}
                  className="text-xs font-semibold text-[#C23B22] hover:underline whitespace-nowrap shrink-0"
                >
                  Send to Order Agent
                </button>
              </div>
            )}

            {/* Optional Counter Camera Preview */}
            <div className={cameraActive ? 'block' : 'hidden'}>
              <div className="grid grid-cols-1 sm:grid-cols-12 gap-4 items-center rounded-lg border border-[#E5E0D8] bg-[#F8F7F4] p-3">
                <video
                  ref={videoRef}
                  muted
                  playsInline
                  className="sm:col-span-4 w-full h-28 object-cover rounded-md bg-black"
                />
                <div className="sm:col-span-8 space-y-1">
                  <p className="text-xs font-semibold text-[#171717]">Counter Vision Active</p>
                  <p className="text-xs text-[#525252]">
                    {cameraSnapshotNotice ||
                      'Hold up a written allergen note, delivery invoice, or pizza box to let Gemini 4 inspect it alongside speech.'}
                  </p>
                </div>
              </div>
            </div>

            {/* Acoustic Multi-Speaker Chaos Broadcaster */}
            {matchingScenario && (
              <div className="rounded-lg border border-[#E5E0D8] bg-[#F8F7F4] p-4 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <p className="text-sm font-semibold text-[#171717]">
                      {matchingScenario.title}
                    </p>
                    <p className="text-xs text-[#525252]">{matchingScenario.subtitle}</p>
                  </div>
                  <button
                    type="button"
                    disabled={synthesizingChaos || processingTurn}
                    onClick={handleBroadcastChaosAudio}
                    className="inline-flex items-center gap-2 px-3.5 py-2 text-xs font-semibold rounded-lg bg-[#171717] text-white hover:bg-[#2E2E2E] disabled:opacity-50 transition-colors whitespace-nowrap shrink-0"
                  >
                    <Radio className="h-3.5 w-3.5" aria-hidden="true" />
                    {synthesizingChaos
                      ? 'Synthesizing & Mixing...'
                      : `Broadcast Real ${matchingScenario.tracks.length}-Speaker Audio`}
                  </button>
                </div>

                {/* Clean unboxed speaker roster */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1.5 pt-1 text-xs text-[#525252]">
                  {matchingScenario.tracks.map((track) => (
                    <div key={track.id} className="truncate">
                      <span className="font-semibold text-[#171717]">{track.speakerLabel}</span>
                      <span aria-hidden="true"> · </span>
                      <span>“{track.text}”</span>
                    </div>
                  ))}
                </div>

                {broadcastStatus && (
                  <p className="text-xs font-medium text-[#C23B22]">{broadcastStatus}</p>
                )}
              </div>
            )}

            {/* Direct Utterance Input (works in both Cascaded & Gemini Live) */}
            <form onSubmit={handleSendTextTurn} className="flex items-center gap-2.5">
              <label htmlFor="station-utterance" className="sr-only">
                Send spoken or typed multi-language turn
              </label>
              <input
                id="station-utterance"
                type="text"
                value={utteranceInput}
                onChange={(e) => setUtteranceInput(e.target.value)}
                placeholder="Or type a multi-language turn (e.g., 'One Margherita please' + 'Und für mich eine Diavola glutenfrei')"
                className="flex-1 rounded-lg border border-[#E5E0D8] bg-white px-3.5 py-2.5 text-sm text-[#171717] placeholder:text-[#8A8A8A] focus:border-[#C23B22] focus:outline-none"
              />
              <button
                type="submit"
                disabled={processingTurn || !utteranceInput.trim()}
                className="inline-flex items-center gap-1.5 px-4 py-2.5 text-sm font-semibold rounded-lg border border-[#E5E0D8] bg-white text-[#171717] hover:bg-[#EFECE6] disabled:opacity-50 transition-colors whitespace-nowrap shrink-0"
              >
                <Send className="h-4 w-4" aria-hidden="true" />
                {processingTurn ? 'Processing...' : 'Send Turn'}
              </button>
            </form>
          </section>

          {/* Live Transcript & Multi-Speaker Attribution */}
          <section className="rounded-xl border border-[#E5E0D8] bg-white p-6 space-y-4">
            <div className="flex items-center justify-between gap-4 border-b border-[#EFECE6] pb-3">
              <div>
                <h2 className="font-display text-lg font-semibold text-[#171717]">
                  Live Transcript &amp; Attribution
                </h2>
                <p className="text-xs text-[#737373]">
                  Shared conversation timeline across Cascaded and Gemini Live sessions.
                </p>
              </div>
              <span className="font-mono-tabular text-xs text-[#737373]">
                {transcripts.length} {transcripts.length === 1 ? 'turn' : 'turns'}
              </span>
            </div>

            {/* Live streaming interim captions from Gemini Live */}
            {(liveInterimUser || liveInterimAgent) && (
              <div className="rounded-lg border border-[#1F6E4A]/30 bg-[#1F6E4A]/5 p-4 space-y-2 text-sm">
                {liveInterimUser && (
                  <p className="text-[#171717]">
                    <span className="font-semibold">
                      Live Input
                      {liveStreamLanguages.length > 0
                        ? ` (${liveStreamLanguages.map((l) => `${l.label} ${l.code.toUpperCase()}`).join(' + ')})`
                        : ''}
                      :
                    </span>{' '}
                    {liveInterimUser}
                  </p>
                )}
                {liveInterimAgent && (
                  <p className="text-[#1F6E4A]">
                    <span className="font-semibold">VoicePizza Live:</span> {liveInterimAgent}
                  </p>
                )}
              </div>
            )}

            {processingTurn && (
              <div className="rounded-lg border border-[#E5E0D8] bg-[#F8F7F4] p-4 text-xs text-[#525252]">
                Orchestrating speaker separation, Decisions API triage, Gemini 4 Neon &amp;
                Hydrogen extraction, and multilingual TTS reply...
              </div>
            )}

            {transcripts.length === 0 && !liveInterimUser && !liveInterimAgent ? (
              <div className="py-10 text-center space-y-2">
                <p className="text-sm font-medium text-[#171717]">
                  Station ready for incoming phone or counter audio.
                </p>
                <p className="text-xs text-[#737373] max-w-md mx-auto">
                  Record with your microphone, broadcast a real multi-language scenario above, or
                  send a bilingual turn to watch speaker separation and Decisions API triage run live.
                </p>
              </div>
            ) : (
              <div className="divide-y divide-[#EFECE6]">
                {transcripts.map((entry) => (
                  <article key={entry.id} className="py-4 first:pt-1 last:pb-0 space-y-3">
                    <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-[#737373]">
                      <span>
                        {entry.architecture === 'cascaded' ? 'Cascaded' : 'Gemini Live'}
                        <span aria-hidden="true"> · </span>
                        {entry.channel === 'phone' ? 'P1 Phone Line' : 'P2 Counter'}
                        <span aria-hidden="true"> · </span>
                        <span className="font-mono-tabular">
                          {entry.latencyMs > 0 ? `${entry.latencyMs} ms` : 'Real-time stream'}
                        </span>
                        <span aria-hidden="true"> · </span>
                        {entry.modelsUsed.join(' / ')}
                      </span>
                      {entry.replyAudioBase64 && (
                        <button
                          type="button"
                          onClick={() =>
                            playAudioBase64(entry.replyAudioBase64!, entry.replyAudioMimeType)
                          }
                          className="inline-flex items-center gap-1 text-xs font-semibold text-[#C23B22] hover:underline whitespace-nowrap shrink-0"
                        >
                          <Volume2 className="h-3.5 w-3.5" aria-hidden="true" />
                          Play Reply Audio
                        </button>
                      )}
                    </div>

                    <p className="text-sm text-[#171717]">
                      <span className="font-semibold">Heard:</span> {entry.rawTranscript}
                    </p>

                    {entry.segments.length > 0 && (
                      <div className="space-y-2 pl-3 border-l border-[#E5E0D8]">
                        {entry.segments.map((seg, idx) => (
                          <div key={idx} className="text-xs space-y-0.5">
                            <p className="text-[#171717]">
                              <span className="font-semibold">{seg.speakerLabel}</span>
                              <span className="text-[#737373]">
                                {' '}
                                ({seg.languageCode} · {seg.role})
                              </span>
                              : {seg.utterance}
                            </p>
                            {seg.extractedItems.length > 0 && (
                              <p className="text-[#1F6E4A] font-medium">
                                Order mapped:{' '}
                                {seg.extractedItems
                                  .map(
                                    (i) =>
                                      `${i.quantity}x ${i.menuItemId}${
                                        i.modifiers.length ? ` [${i.modifiers.join(', ')}]` : ''
                                      }`
                                  )
                                  .join(', ')}
                              </p>
                            )}
                          </div>
                        ))}
                      </div>
                    )}

                    {entry.agentReplySummary && (
                      <p className="text-sm text-[#1F6E4A]">
                        <span className="font-semibold">VoicePizza Replied:</span>{' '}
                        {entry.agentReplySummary}
                      </p>
                    )}
                  </article>
                ))}
              </div>
            )}
          </section>
        </div>

        {/* Right Rail 4 cols: Decisions API Triage + Staff Alerts + Latest Order */}
        <aside className="lg:col-span-4 space-y-6">
          {/* Decisions API (gemini-decision-1) Triage */}
          <section className="rounded-xl border border-[#E5E0D8] bg-white p-5 space-y-4">
            <div>
              <h2 className="font-display text-base font-semibold text-[#171717]">
                Decisions API Triage
              </h2>
              <p className="text-xs text-[#737373]">
                Zero-output-token calibrated routing via gemini-decision-1
              </p>
            </div>

            {!latestTriage ? (
              <p className="text-xs text-[#737373] py-3">
                Run any voice or chaos turn to inspect calibrated probabilities for order intent,
                dominant speaker role, language, and acoustic chaos rubric.
              </p>
            ) : (
              <div className="space-y-3 text-xs">
                <div className="space-y-1">
                  <div className="flex justify-between">
                    <span className="text-[#525252]">Order Intent (noul)</span>
                    <span className="font-mono-tabular font-semibold text-[#171717]">
                      {Math.round(latestTriage.isOrderIntent.probability * 100)}%
                    </span>
                  </div>
                  <div className="h-1.5 w-full rounded-full bg-[#EFECE6] overflow-hidden">
                    <div
                      className="h-full bg-[#1F6E4A]"
                      style={{ width: `${Math.round(latestTriage.isOrderIntent.probability * 100)}%` }}
                    />
                  </div>
                </div>

                <div className="flex items-center justify-between border-t border-[#EFECE6] pt-2.5">
                  <span className="text-[#525252]">Speaker Role</span>
                  <span className="font-mono-tabular font-semibold text-[#171717]">
                    {latestTriage.speakerRole.choice} ({Math.round(latestTriage.speakerRole.confidence * 100)}%)
                  </span>
                </div>

                <div className="flex items-center justify-between border-t border-[#EFECE6] pt-2.5">
                  <span className="text-[#525252]">Primary Language</span>
                  <span className="font-mono-tabular font-semibold text-[#171717]">
                    {latestTriage.primaryLanguage.choice.toUpperCase()} (
                    {Math.round(latestTriage.primaryLanguage.confidence * 100)}%)
                  </span>
                </div>

                <div className="space-y-1 border-t border-[#EFECE6] pt-2.5">
                  <div className="flex justify-between">
                    <span className="text-[#525252]">Acoustic Chaos Score</span>
                    <span className="font-mono-tabular font-semibold text-[#C23B22]">
                      {latestTriage.chaosSeverity.score.toFixed(2)} / 3.00
                    </span>
                  </div>
                  <p className="text-[11px] text-[#737373] leading-snug">
                    {latestTriage.chaosSeverity.label}
                  </p>
                </div>
              </div>
            )}
          </section>

          {/* Staff Alerts for Non-Order Voices (Spanish Clerk & Italian Owner) */}
          <section className="rounded-xl border border-[#E5E0D8] bg-white p-5 space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="font-display text-base font-semibold text-[#171717]">
                Counter &amp; Supplier Alerts
              </h2>
              <span className="font-mono-tabular text-xs text-[#737373]">
                {openAlerts.length} open
              </span>
            </div>

            {openAlerts.length === 0 ? (
              <p className="text-xs text-[#737373]">
                Supplier deliveries and queue complaints separated from pizza orders appear here in
                Spanish and Italian for the shop team.
              </p>
            ) : (
              <div className="divide-y divide-[#EFECE6]">
                {openAlerts.map((alert) => (
                  <div key={alert.id} className="py-3 first:pt-0 last:pb-0 space-y-1.5 text-xs">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-semibold text-[#C23B22]">
                        {alert.role} · {alert.languageCode}
                      </span>
                      <button
                        type="button"
                        onClick={() => onResolveAlert(alert.id)}
                        className="inline-flex items-center gap-1 font-semibold text-[#1F6E4A] hover:underline whitespace-nowrap shrink-0"
                      >
                        <Check className="h-3 w-3" aria-hidden="true" />
                        Resolve
                      </button>
                    </div>
                    <p className="text-[#171717]">{alert.summary}</p>
                    <p className="text-[#525252]">
                      <span className="font-semibold">ES:</span> {alert.staffActionEs}
                    </p>
                    <p className="text-[#525252]">
                      <span className="font-semibold">IT:</span> {alert.staffActionIt}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* Latest Active Ticket Snapshot */}
          <section className="rounded-xl border border-[#E5E0D8] bg-white p-5 space-y-3">
            <div className="flex items-center justify-between gap-2">
              <h2 className="font-display text-base font-semibold text-[#171717]">
                Latest Active Ticket
              </h2>
              <button
                type="button"
                onClick={onOpenOrdersBoard}
                className="text-xs font-semibold text-[#C23B22] hover:underline whitespace-nowrap shrink-0"
              >
                Active Orders ({activeOrders.length})
              </button>
            </div>

            {!latestOrder ? (
              <p className="text-xs text-[#737373]">
                No active orders yet. Speak or send an order to generate a confirmed ticket with
                exact pricing and timestamp.
              </p>
            ) : (
              <div className="space-y-3 text-xs">
                <div className="border-b border-[#EFECE6] pb-2.5 space-y-1.5">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <p className="font-semibold text-[#171717]">
                        Ticket #{latestOrder.ticketNumber} · {latestOrder.partyLabel}
                      </p>
                      <p className="text-[#525252]">
                        {latestOrder.languages.join(', ')} ·{' '}
                        <span className="font-semibold text-[#1F6E4A]">
                          {ORDER_STAGE_META[latestOrder.status].shortLabel}
                        </span>
                      </p>
                    </div>
                    <span className="font-mono-tabular text-sm font-bold text-[#171717]">
                      {formatCurrency(latestOrder.totalCents)}
                    </span>
                  </div>
                  <p
                    data-testid="station-order-confirmed-timestamp"
                    className="font-mono-tabular text-[11px] text-[#525252]"
                  >
                    Confirmed: {formatOrderTimestamp(latestOrder.confirmedAt)}
                  </p>
                </div>

                <ul className="space-y-1.5">
                  {latestOrder.items.map((item, idx) => (
                    <li key={idx} className="flex items-start justify-between gap-2">
                      <div>
                        <p className="font-medium text-[#171717]">
                          {item.quantity}x {item.name}
                        </p>
                        <p className="text-[11px] text-[#737373]">
                          {item.assignedTo} ({item.languageCode}) ·{' '}
                          {formatCurrency(item.unitPriceCents)} ea
                          {item.modifiers.length > 0 ? ` · ${item.modifiers.join(', ')}` : ''}
                        </p>
                      </div>
                      <span className="font-mono-tabular font-medium text-[#171717]">
                        {formatCurrency(item.unitPriceCents * item.quantity)}
                      </span>
                    </li>
                  ))}
                </ul>

                <div className="border-t border-[#EFECE6] pt-2 space-y-1 font-mono-tabular text-[11px]">
                  <div className="flex items-center justify-between text-[#525252]">
                    <span>Subtotal</span>
                    <span>{formatCurrency(latestOrder.subtotalCents)}</span>
                  </div>
                  <div className="flex items-center justify-between text-[#525252]">
                    <span>Sales Tax (8.5%)</span>
                    <span>{formatCurrency(latestOrder.taxCents)}</span>
                  </div>
                  <div className="flex items-center justify-between text-xs font-bold text-[#171717] pt-0.5">
                    <span>Exact Total</span>
                    <span>{formatCurrency(latestOrder.totalCents)}</span>
                  </div>
                </div>

                {latestOrder.allergenFlag && (
                  <p className="font-semibold text-[#C23B22]">
                    Allergen / Dietary Modification Detected — Verify before baking
                  </p>
                )}

                <div className="rounded-lg bg-[#F8F7F4] p-2.5 space-y-1 text-[11px] text-[#525252]">
                  <p>
                    <span className="font-semibold text-[#171717]">Cucina IT:</span>{' '}
                    {latestOrder.kitchenNoteIt}
                  </p>
                  <p>
                    <span className="font-semibold text-[#171717]">Mostrador ES:</span>{' '}
                    {latestOrder.counterNoteEs}
                  </p>
                </div>

                {ORDER_STAGE_META[latestOrder.status].nextActionLabel && (
                  <button
                    type="button"
                    onClick={() => onAdvanceOrderStatus(latestOrder)}
                    className="w-full py-2 text-xs font-semibold rounded-lg bg-[#171717] text-white hover:bg-[#2E2E2E] transition-colors"
                  >
                    {ORDER_STAGE_META[latestOrder.status].nextActionLabel}
                  </button>
                )}
              </div>
            )}
          </section>
        </aside>
      </div>
    </div>
  );
}
