import {
  Activity,
  AlertTriangle,
  Camera,
  CameraOff,
  CheckCircle2,
  Circle,
  Clapperboard,
  Loader2,
  Minus,
  Play,
  ShieldCheck,
  Square,
  TrendingDown,
  TrendingUp,
  Upload,
  Users,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

/* ---------- resto-ops Queue Monitor contract (backend.app.main, proxied at /api/ops/*) ---------- */

type RunStatus = 'running' | 'completed' | 'stopped' | 'interrupted' | 'expired' | 'blocked' | 'failed';

interface OpsSource {
  id: string;
  label: string;
  kind: 'synthetic' | 'cafe' | 'upload' | 'camera';
  duration_ms: number;
  width: number;
  height: number;
}

interface OpsConfig {
  gemini_ready: boolean;
  observer: string;
  verifier: string;
  demo_id: string;
  threshold: number;
  cadence_ms: number;
  max_upload_bytes: number;
}

interface OpsBox {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

interface Observation {
  at_ms: number;
  frame_ms: number;
  queue_min: number | null;
  queue_max: number | null;
  visibility: 'clear' | 'uncertain';
  people: { id: string; box: OpsBox; membership: 'waiting' | 'other' | 'uncertain' }[];
  summary: string;
  current: boolean;
  phase: 'observe' | 'review';
  elapsed_ms: number;
}

interface Decision {
  at_ms: number;
  frame_ms: number;
  queue_min: number | null;
  queue_max: number | null;
  visibility: 'clear' | 'uncertain';
  verified: boolean;
}

interface OpsTask {
  id: string;
  status: 'open' | 'acknowledged' | 'resolved';
  action: 'create' | 'update' | 'resolve' | 'acknowledge';
  created_ms: number;
  updated_ms: number;
  reason: string;
  evidence_ms: number[];
  queue_min?: number | null;
  queue_max?: number | null;
}

interface Review {
  at_ms: number;
  tool: string;
  outcome: string;
  summary: string;
}

type RunEvent =
  | { id: number; type: 'observation'; data: Observation; created_ms: number }
  | { id: number; type: 'decision'; data: Decision; created_ms: number }
  | { id: number; type: 'task'; data: OpsTask; created_ms: number }
  | { id: number; type: 'review_started'; data: { at_ms: number; tool: string }; created_ms: number }
  | { id: number; type: 'review_completed'; data: Review; created_ms: number }
  | { id: number; type: 'run_status'; data: { status: RunStatus }; created_ms: number }
  | { id: number; type: 'error'; data: { code: string; message: string; at_ms: number; phase: string }; created_ms: number };

interface OpsRun {
  id: string;
  source: OpsSource;
  status: RunStatus;
  config: { observer: string; verifier: string; policy: { threshold: number } };
}

interface TimelineItem {
  module: string;
  type: string;
  run_id?: string;
  data: Record<string, unknown>;
  created_ms: number;
}

class OpsError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function ops<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`/api/ops${path}`, init);
  if (!r.ok) {
    const body = (await r.json().catch(() => ({}))) as { detail?: unknown };
    throw new OpsError(r.status, typeof body.detail === 'string' ? body.detail : `Request failed (HTTP ${r.status}).`);
  }
  return r.json() as Promise<T>;
}

function postJson<T>(path: string, body: unknown): Promise<T> {
  return ops<T>(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function countLabel(min: number | null | undefined, max: number | null | undefined): string {
  if (min == null || max == null) return '–';
  return min === max ? String(min) : `${min}–${max}`;
}

function rangesAgree(a?: Observation, b?: Observation): boolean | null {
  if (!a || !b || a.queue_min == null || a.queue_max == null || b.queue_min == null || b.queue_max == null) return null;
  return a.queue_min <= b.queue_max && b.queue_min <= a.queue_max;
}

function wallTime(ms: number): string {
  return new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' });
}

function timelineText(item: TimelineItem): { title: string; detail: string } {
  const d = item.data as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  if (item.module === 'queue') {
    if (item.type === 'task')
      return { title: `Line task ${({ create: 'raised', update: 'updated', resolve: 'resolved', acknowledge: 'acknowledged' } as Record<string, string>)[String(d.action)] ?? String(d.action)}`, detail: String(d.reason ?? '') };
    if (item.type === 'review_completed')
      return { title: `Argon review · ${String(d.outcome ?? '').replace(/_/g, ' ')}`, detail: String(d.summary ?? '') };
    if (item.type === 'run_status') return { title: `Monitor ${d.status}`, detail: '' };
    if (item.type === 'error') return { title: 'Monitor error', detail: String(d.message ?? '') };
  }
  if (item.type === 'fixit.diagnosis') {
    const diag = (d.diagnosis ?? {}) as Record<string, unknown>;
    return { title: 'Fix-It diagnosis', detail: [diag.item, diag.broken_part].filter(Boolean).join(' · ') };
  }
  if (item.type === 'fixit.results') return { title: 'Fix-It parts found', detail: `${(d.top as unknown[] | undefined)?.length ?? 0} replacements ranked` };
  if (item.type === 'fixit.buy_click') return { title: 'Fix-It buy clicked', detail: String(d.title ?? d.shop ?? '') };
  if (item.type === 'fixit.checkout_created') return { title: 'Fix-It checkout created', detail: String(d.shop ?? '') };
  if (item.type === 'fixit.error') return { title: 'Fix-It error', detail: String(d.message ?? '') };
  return { title: `${item.module} · ${item.type}`, detail: '' };
}

export function FloorMonitor() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const feedRef = useRef<EventSource | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const runRef = useRef<OpsRun | null>(null);
  const statusRef = useRef<RunStatus>('stopped');
  const lastSentRef = useRef(-500);
  const advancingRef = useRef(false);
  const pendingRef = useRef<{ at: number; final: boolean } | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const viewedRunRef = useRef<string | null>(null);

  const [backendOk, setBackendOk] = useState<boolean | null>(null);
  const [config, setConfig] = useState<OpsConfig | null>(null);
  const [sources, setSources] = useState<OpsSource[]>([]);
  const [source, setSource] = useState<OpsSource | null>(null);
  const [cameraMode, setCameraMode] = useState(false);
  const [run, setRun] = useState<OpsRun | null>(null);
  const [status, setStatus] = useState<RunStatus>('stopped');
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [timeline, setTimeline] = useState<TimelineItem[]>([]);
  const [starting, setStarting] = useState(false);
  const [uploadPct, setUploadPct] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [feedDropped, setFeedDropped] = useState(false);
  const [aspect, setAspect] = useState(16 / 9);

  // Sample café footage always first, then the most recent uploads.
  const realSources = useMemo(() => {
    const list = sources.filter((s) => s.kind !== 'synthetic' && s.kind !== 'camera');
    const demo = list.filter((s) => s.id === config?.demo_id);
    return [...demo, ...list.filter((s) => s.id !== config?.demo_id)];
  }, [sources, config]);

  /* ---------- bootstrap + timeline polling ---------- */
  const loadTimeline = useCallback(() => {
    // Only show queue events from real (Gemini) runs: resto-ops also keeps authored fixture runs of its
    // synthetic demo scene, which must not appear as real floor activity.
    Promise.all([
      ops<TimelineItem[]>('/timeline?limit=60'),
      ops<Array<{ id: string; config: { provider: string } }>>('/runs'),
    ])
      .then(([items, runs]) => {
        const real = new Set(runs.filter((r) => r.config.provider === 'gemini').map((r) => r.id));
        if (runRef.current) real.add(runRef.current.id);
        setTimeline(items.filter((item) => item.module !== 'queue' || (item.run_id && real.has(item.run_id))));
        setBackendOk(true);
      })
      .catch(() => setBackendOk(false));
  }, []);

  useEffect(() => {
    let cancelled = false;
    Promise.all([ops<{ ok: boolean }>('/health'), ops<OpsConfig>('/config'), ops<OpsSource[]>('/sources')])
      .then(([health, cfg, list]) => {
        if (cancelled) return;
        setBackendOk(!!health.ok);
        setConfig(cfg);
        setSources(list);
        const real = list.filter((s) => s.kind !== 'synthetic');
        setSource(real.find((s) => s.id === cfg.demo_id) ?? real[0] ?? null);
      })
      .catch((e: Error) => {
        if (cancelled) return;
        setBackendOk(false);
        setError(e.message);
      });
    loadTimeline();
    const timer = window.setInterval(loadTimeline, 5000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [loadTimeline]);

  /* ---------- run lifecycle ---------- */
  const closeCamera = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (videoRef.current?.srcObject) videoRef.current.srcObject = null;
  }, []);

  const stopRun = useCallback(() => {
    const current = runRef.current;
    if (current && statusRef.current === 'running') {
      void postJson(`/runs/${current.id}/stop`, {}).catch(() => undefined);
    }
    runRef.current = null;
    statusRef.current = 'stopped';
    pendingRef.current = null;
    videoRef.current?.pause();
  }, []);

  useEffect(
    () => () => {
      viewedRunRef.current = null;
      feedRef.current?.close();
      stopRun();
      closeCamera();
    },
    [stopRun, closeCamera],
  );

  const lastIdRef = useRef(0);
  const pollTimerRef = useRef<number | null>(null);
  const watchdogRef = useRef<number | null>(null);

  const stopFeeds = useCallback(() => {
    feedRef.current?.close();
    feedRef.current = null;
    if (pollTimerRef.current) window.clearTimeout(pollTimerRef.current);
    if (watchdogRef.current) window.clearTimeout(watchdogRef.current);
    pollTimerRef.current = null;
    watchdogRef.current = null;
  }, []);

  useEffect(() => stopFeeds, [stopFeeds]);

  function ingest(update: RunEvent) {
    if (!update || typeof update.id !== 'number' || update.id <= lastIdRef.current) return;
    lastIdRef.current = update.id;
    setEvents((prev) => (prev.length && prev[prev.length - 1].id >= update.id ? prev : [...prev.slice(-599), update]));
    if (update.type === 'run_status') {
      statusRef.current = update.data.status;
      setStatus(update.data.status);
      if (update.data.status !== 'running') {
        loadTimeline();
        if (update.data.status === 'blocked' || update.data.status === 'failed') {
          videoRef.current?.pause();
          closeCamera();
        }
      }
    }
  }

  /** Polling fallback for hosts whose proxy buffers or drops Server-Sent Events. */
  function startPolling(runId: string) {
    feedRef.current?.close();
    feedRef.current = null;
    if (watchdogRef.current) window.clearTimeout(watchdogRef.current);
    if (pollTimerRef.current) return;
    setFeedDropped(false);
    let finalPollDone = false;
    const tick = async () => {
      pollTimerRef.current = null;
      if (runRef.current?.id !== runId && viewedRunRef.current !== runId) return;
      try {
        const r = await fetch(`/api/ops/runs/${runId}/poll?after=${lastIdRef.current}`, { cache: 'no-store' });
        if (r.ok) {
          const body = (await r.json()) as { events: RunEvent[] };
          body.events.forEach(ingest);
          setFeedDropped(false);
        } else {
          setFeedDropped(true);
        }
      } catch {
        setFeedDropped(true);
      }
      if (viewedRunRef.current !== runId) return;
      if (statusRef.current !== 'running') {
        if (finalPollDone) return;
        finalPollDone = true;
      }
      pollTimerRef.current = window.setTimeout(tick, 1500);
    };
    pollTimerRef.current = window.setTimeout(tick, 0);
  }

  function attach(next: OpsRun) {
    stopFeeds();
    lastIdRef.current = 0;
    viewedRunRef.current = next.id;
    setEvents([]);
    setFeedDropped(false);
    setRun(next);
    setStatus(next.status);
    runRef.current = next;
    statusRef.current = next.status;
    const forcePoll =
      typeof window !== 'undefined' &&
      (new URLSearchParams(window.location.search).has('nosse') || typeof EventSource === 'undefined');
    if (forcePoll) {
      startPolling(next.id);
      return;
    }
    const feed = new EventSource(`/api/ops/runs/${next.id}/events`);
    feedRef.current = feed;
    // If nothing arrives within 4 s (buffering proxy), switch to polling.
    watchdogRef.current = window.setTimeout(() => {
      if (lastIdRef.current === 0 && viewedRunRef.current === next.id) startPolling(next.id);
    }, 4000);
    feed.onopen = () => setFeedDropped(false);
    feed.onerror = () => {
      if (feedRef.current === feed && viewedRunRef.current === next.id) startPolling(next.id);
    };
    feed.onmessage = (message) => {
      if (feedRef.current !== feed) return;
      try {
        ingest(JSON.parse(message.data) as RunEvent);
      } catch {
        /* ignore malformed frame */
      }
    };
  }

  async function flushAdvance() {
    if (advancingRef.current) return;
    advancingRef.current = true;
    try {
      while (pendingRef.current) {
        const next = pendingRef.current;
        pendingRef.current = null;
        const current = runRef.current;
        if (!current || statusRef.current !== 'running') continue;
        try {
          await postJson(`/runs/${current.id}/advance`, { at_ms: next.at, final: next.final });
        } catch (e) {
          if (!(e instanceof OpsError && e.status === 409)) setError((e as Error).message);
        }
      }
    } finally {
      advancingRef.current = false;
    }
  }

  function reportPlayhead(atMs: number, final = false) {
    const current = runRef.current;
    if (!current || statusRef.current !== 'running' || current.source.kind === 'camera') return;
    const at = Math.min(current.source.duration_ms, Math.max(lastSentRef.current, atMs));
    if (!final && at - lastSentRef.current < 375) return;
    lastSentRef.current = at;
    pendingRef.current = { at, final };
    void flushAdvance();
  }

  async function startVideoRun() {
    if (!source || starting) return;
    setError(null);
    setStarting(true);
    try {
      stopRun();
      const next = await postJson<OpsRun>('/runs', {
        source_id: source.id,
        provider: 'gemini',
        strategy: 'agent',
        threshold: config?.threshold,
      });
      lastSentRef.current = -500;
      attach(next);
      const v = videoRef.current;
      if (v) {
        v.currentTime = 0;
        await v.play().catch(() => undefined);
        reportPlayhead(0);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setStarting(false);
    }
  }

  async function startCameraRun() {
    if (starting) return;
    if (!navigator.mediaDevices?.getUserMedia) {
      setError('Camera access needs HTTPS or localhost.');
      return;
    }
    setError(null);
    setStarting(true);
    stopRun();
    closeCamera();
    let incoming: MediaStream | null = null;
    try {
      incoming = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 960 } },
      });
      const next = await postJson<OpsRun>('/runs', {
        source_id: 'camera',
        provider: 'gemini',
        strategy: 'agent',
        threshold: config?.threshold,
      });
      streamRef.current = incoming;
      setCameraMode(true);
      attach(next);
    } catch (e) {
      incoming?.getTracks().forEach((t) => t.stop());
      const denied = e instanceof DOMException && e.name === 'NotAllowedError';
      setError(denied ? 'Allow camera access to monitor the line live.' : (e as Error).message);
    } finally {
      setStarting(false);
    }
  }

  // Live camera: preview + send a JPEG frame every 625 ms while the run is active (same cadence as resto-ops).
  useEffect(() => {
    const player = videoRef.current;
    const stream = streamRef.current;
    if (!cameraMode || !run || run.source.kind !== 'camera' || !player || !stream) return;
    player.srcObject = stream;
    void player.play().catch(() => undefined);
    const canvas = document.createElement('canvas');
    const started = performance.now();
    let sending = false;
    const timer = window.setInterval(() => {
      if (sending || statusRef.current !== 'running' || !player.videoWidth) return;
      const at = Math.round(performance.now() - started);
      canvas.width = Math.min(960, player.videoWidth);
      canvas.height = Math.round((player.videoHeight * canvas.width) / player.videoWidth);
      canvas.getContext('2d')?.drawImage(player, 0, 0, canvas.width, canvas.height);
      sending = true;
      canvas.toBlob(
        (blob) => {
          if (!blob) {
            sending = false;
            return;
          }
          fetch(`/api/ops/runs/${run.id}/frame?at_ms=${at}`, {
            method: 'POST',
            body: blob,
            headers: { 'Content-Type': 'image/jpeg' },
          })
            .then(async (r) => {
              if (!r.ok && r.status !== 409) {
                const body = (await r.json().catch(() => ({}))) as { detail?: string };
                setError(body.detail || `Frame upload failed (HTTP ${r.status}).`);
              }
            })
            .catch(() => setError('Lost connection while sending camera frames.'))
            .finally(() => {
              sending = false;
            });
        },
        'image/jpeg',
        0.8,
      );
    }, 625);
    return () => window.clearInterval(timer);
  }, [cameraMode, run]);

  function stopAll() {
    stopRun();
    if (cameraMode) closeCamera();
    setStatus((s) => (s === 'running' ? 'stopped' : s));
  }

  function chooseSource(next: OpsSource) {
    stopFeeds();
    viewedRunRef.current = null;
    stopRun();
    closeCamera();
    setCameraMode(false);
    setRun(null);
    setEvents([]);
    setStatus('stopped');
    setError(null);
    setSource(next);
  }

  function uploadClip(file: File) {
    if (config && file.size > config.max_upload_bytes) {
      setError('Choose a video smaller than 150 MiB.');
      return;
    }
    setError(null);
    setUploadPct(0);
    const form = new FormData();
    form.append('video', file, file.name);
    form.append('kind', 'upload');
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/ops/sources');
    xhr.upload.onprogress = (e) => e.lengthComputable && setUploadPct(Math.round((100 * e.loaded) / e.total));
    xhr.onload = () => {
      setUploadPct(null);
      try {
        const body = JSON.parse(xhr.responseText) as OpsSource & { detail?: string };
        if (xhr.status !== 201 && xhr.status !== 200) throw new Error(body.detail || `Upload failed (HTTP ${xhr.status}).`);
        setSources((list) => [body, ...list]);
        chooseSource(body);
      } catch (e) {
        setError((e as Error).message);
      }
    };
    xhr.onerror = () => {
      setUploadPct(null);
      setError('Upload failed: restaurant ops backend unreachable.');
    };
    xhr.send(form);
  }

  /* ---------- derived state from the event stream ---------- */
  const derived = useMemo(() => {
    const observations: Observation[] = [];
    const decisions: Decision[] = [];
    const tasks = new Map<string, OpsTask>();
    const reviews: Review[] = [];
    let lastError: string | null = null;
    let reviewing = false;
    for (const ev of events) {
      if (ev.type === 'observation') observations.push(ev.data);
      else if (ev.type === 'decision') decisions.push(ev.data);
      else if (ev.type === 'task') tasks.set(ev.data.id, ev.data);
      else if (ev.type === 'review_started') reviewing = true;
      else if (ev.type === 'review_completed') {
        reviews.push(ev.data);
        reviewing = false;
      } else if (ev.type === 'error') lastError = ev.data.message;
    }
    const latestObservation = [...observations].reverse().find((o) => o.current) ?? observations[observations.length - 1];
    const lastObserve = [...observations].reverse().find((o) => o.phase === 'observe');
    const lastReview = [...observations].reverse().find((o) => o.phase === 'review');
    const pairFor = (atMs: number) => ({
      hydrogen: observations.find((o) => o.at_ms === atMs && o.phase === 'observe'),
      argon: observations.find((o) => o.at_ms === atMs && o.phase === 'review'),
    });
    return { observations, decisions, tasks: [...tasks.values()].reverse(), reviews, lastError, reviewing, latestObservation, lastObserve, lastReview, pairFor };
  }, [events]);

  const latestDecision = derived.decisions[derived.decisions.length - 1];
  const previousDecision = derived.decisions[derived.decisions.length - 2];
  const threshold = run?.config.policy.threshold ?? config?.threshold ?? 4;
  const mid = (d?: Decision) => (d && d.queue_min != null && d.queue_max != null ? (d.queue_min + d.queue_max) / 2 : null);
  const trend =
    mid(latestDecision) != null && mid(previousDecision) != null ? Math.sign(mid(latestDecision)! - mid(previousDecision)!) : 0;
  const overThreshold = latestDecision?.queue_min != null && latestDecision.queue_min >= threshold;
  const running = status === 'running';
  const observer = run?.config.observer ?? config?.observer ?? 'gemini-4-hydrogen';
  const verifier = run?.config.verifier ?? config?.verifier ?? 'gemini-4-argon';
  const shortModel = (m: string) => m.replace(/^gemini-4-/, '').replace(/^./, (c) => c.toUpperCase());

  const sparkline = derived.decisions.slice(-16);
  const sparkMax = Math.max(threshold + 1, ...sparkline.map((d) => d.queue_max ?? 0));

  function taskPair(task: OpsTask) {
    const d = [...derived.decisions].reverse().find((x) => x.frame_ms === task.updated_ms) ??
      [...derived.decisions].reverse().find((x) => x.frame_ms === task.created_ms);
    return d ? derived.pairFor(d.at_ms) : { hydrogen: undefined, argon: undefined };
  }

  function acknowledge(taskId: string) {
    if (!run) return;
    postJson(`/runs/${run.id}/tasks/${taskId}/acknowledge`, {}).catch((e: Error) => setError(e.message));
  }

  const overlay = derived.latestObservation;
  const showVideo = !!source && !cameraMode;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-4 border-b border-[#E5E0D8] pb-4">
        <div className="space-y-1">
          <p className="text-xs font-medium tracking-wide text-[#737373]">
            Front-of-House Line Monitor · {shortModel(observer)} observer + {shortModel(verifier)} verifier
          </p>
          <h1 className="font-display text-2xl font-bold text-[#171717]">Floor Monitor</h1>
          <p className="text-sm text-[#525252]">
            Watches the counter line in real time. When {threshold} or more guests are waiting and a second model
            confirms it, a staff task is raised and logged to the ops timeline.
          </p>
        </div>
        <span
          className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-semibold whitespace-nowrap shrink-0 ${
            backendOk === false ? 'border-[#C23B22]/30 bg-[#C23B22]/8 text-[#8F2411]' : 'border-[#E5E0D8] bg-white text-[#525252]'
          }`}
        >
          <span
            className={`h-2 w-2 rounded-full ${backendOk === null ? 'bg-[#D4CFC6]' : backendOk ? 'bg-[#1F6E4A]' : 'bg-[#C23B22]'}`}
            aria-hidden="true"
          />
          {backendOk === null ? 'Checking ops backend…' : backendOk ? 'Ops backend online' : 'Ops backend offline'}
        </span>
      </div>

      {error && (
        <div role="alert" className="flex items-center justify-between gap-4 rounded-xl border border-[#C23B22]/30 bg-[#C23B22]/8 px-5 py-3 text-sm text-[#8F2411]">
          <span className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
            {error}
          </span>
          <button type="button" onClick={() => setError(null)} className="text-xs font-semibold hover:underline whitespace-nowrap shrink-0">
            Dismiss
          </button>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* Feed */}
        <section className="lg:col-span-8 rounded-xl border border-[#E5E0D8] bg-white p-6 space-y-5">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <h2 className="font-display text-lg font-semibold text-[#171717]">Counter Feed</h2>
              <p className="text-xs text-[#737373]">
                {cameraMode
                  ? 'Live rear camera · a frame every 0.6 s goes to the observer'
                  : source
                    ? `${source.label} · ${clock(source.duration_ms)}`
                    : 'Pick real café footage, upload a clip, or go live with the rear camera.'}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2.5">
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                disabled={running || uploadPct !== null || !backendOk}
                className="inline-flex items-center gap-2 px-4 py-2.5 text-sm font-semibold rounded-lg border border-[#E5E0D8] bg-white text-[#171717] hover:bg-[#F8F7F4] disabled:opacity-50 transition-colors whitespace-nowrap shrink-0"
              >
                <Upload className="h-4 w-4" aria-hidden="true" />
                {uploadPct !== null ? `Uploading ${uploadPct}%` : 'Upload Clip'}
              </button>
              <input
                ref={fileRef}
                type="file"
                accept="video/*"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) uploadClip(f);
                  e.target.value = '';
                }}
              />
              <button
                type="button"
                onClick={cameraMode ? () => { stopAll(); closeCamera(); setCameraMode(false); } : startCameraRun}
                disabled={starting || !backendOk || !config?.gemini_ready}
                className="inline-flex items-center gap-2 px-4 py-2.5 text-sm font-semibold rounded-lg border border-[#E5E0D8] bg-white text-[#171717] hover:bg-[#F8F7F4] disabled:opacity-50 transition-colors whitespace-nowrap shrink-0"
              >
                {cameraMode ? <CameraOff className="h-4 w-4" aria-hidden="true" /> : <Camera className="h-4 w-4" aria-hidden="true" />}
                {cameraMode ? 'Stop Live Camera' : 'Live Rear Camera'}
              </button>
            </div>
          </div>

          {realSources.length > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-medium text-[#737373]">Footage</span>
              <div role="group" aria-label="Footage source" className="inline-flex flex-wrap items-center gap-1 rounded-lg bg-[#EFECE6] p-1">
                {realSources.slice(0, 4).map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    disabled={running}
                    onClick={() => chooseSource(s)}
                    className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-colors whitespace-nowrap shrink-0 disabled:opacity-60 ${
                      !cameraMode && source?.id === s.id ? 'bg-white text-[#171717] shadow-xs' : 'text-[#525252] hover:text-[#171717]'
                    }`}
                  >
                    {s.id === config?.demo_id ? 'Sample café footage' : s.label.slice(0, 28)}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Viewer with live overlay */}
          <div className="w-full overflow-hidden rounded-lg border border-[#E5E0D8] bg-[#171717]">
            <div
              className="relative mx-auto w-full"
              style={{ aspectRatio: String(cameraMode ? aspect : source && source.width ? source.width / source.height : 16 / 9) }}
            >
              <video
                key={cameraMode ? 'camera' : source?.id ?? 'none'}
                ref={videoRef}
                src={showVideo ? `/api/ops/sources/${source!.id}/video` : undefined}
                muted
                playsInline
                preload="auto"
                onLoadedMetadata={(e) => {
                  const v = e.currentTarget;
                  if (v.videoWidth) setAspect(v.videoWidth / v.videoHeight);
                }}
                onTimeUpdate={(e) => !cameraMode && reportPlayhead(Math.round(e.currentTarget.currentTime * 1000))}
                onEnded={() => source && !cameraMode && reportPlayhead(source.duration_ms, true)}
                className={`absolute inset-0 h-full w-full object-fill ${showVideo || cameraMode ? 'block' : 'hidden'}`}
              />
              {overlay?.people.map((p) => (
                <div
                  key={`${overlay.at_ms}-${overlay.phase}-${p.id}`}
                  className={`pointer-events-none absolute rounded-sm border-2 ${
                    p.membership === 'waiting'
                      ? 'border-[#C23B22] bg-[#C23B22]/10'
                      : p.membership === 'uncertain'
                        ? 'border-[#E0A33A] bg-[#E0A33A]/10'
                        : 'border-white/50'
                  }`}
                  style={{
                    left: `${p.box.x1 * 100}%`,
                    top: `${p.box.y1 * 100}%`,
                    width: `${(p.box.x2 - p.box.x1) * 100}%`,
                    height: `${(p.box.y2 - p.box.y1) * 100}%`,
                  }}
                />
              ))}
              {!showVideo && !cameraMode && (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 text-center">
                  <span className="flex h-12 w-12 items-center justify-center rounded-full bg-white/10">
                    <Clapperboard className="h-5 w-5 text-white" aria-hidden="true" />
                  </span>
                  <p className="text-sm font-semibold text-white">
                    {backendOk === false ? 'Restaurant ops backend is offline' : 'No footage selected'}
                  </p>
                  <p className="max-w-sm text-xs text-white/60">
                    {backendOk === false
                      ? 'Start resto-ops (port 8100) and its tunnel, then reload this tab.'
                      : 'Upload a counter clip or start the live rear camera.'}
                  </p>
                </div>
              )}
              {running && (
                <div className="absolute left-3 top-3 inline-flex items-center gap-2 rounded-full bg-[#C23B22] px-3 py-1 text-xs font-semibold text-white">
                  <span className="h-2 w-2 animate-pulse rounded-full bg-white" aria-hidden="true" />
                  MONITORING
                </div>
              )}
              {overlay && (
                <div className="absolute bottom-3 left-3 right-3 flex items-center justify-between gap-3 rounded-md bg-black/60 px-3 py-1.5 text-[11px] text-white">
                  <span className="truncate">{overlay.summary}</span>
                  <span className="font-mono-tabular whitespace-nowrap shrink-0">
                    {overlay.phase === 'review' ? shortModel(verifier) : shortModel(observer)} · frame {clock(overlay.frame_ms)}
                  </span>
                </div>
              )}
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[#EFECE6] pt-4">
            <div className="flex flex-wrap items-center gap-4 text-xs text-[#525252]">
              <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm border-2 border-[#C23B22]" />Waiting in line</span>
              <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm border-2 border-[#E0A33A]" />Uncertain</span>
              <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm border-2 border-[#A3A3A3]" />Other guests</span>
            </div>
            {running ? (
              <button
                type="button"
                onClick={stopAll}
                className="inline-flex items-center gap-2 px-4 py-2.5 text-sm font-semibold rounded-lg bg-[#171717] text-white hover:bg-[#2E2E2E] transition-colors whitespace-nowrap shrink-0"
              >
                <Square className="h-4 w-4" aria-hidden="true" />
                Stop Monitoring
              </button>
            ) : (
              <button
                type="button"
                onClick={startVideoRun}
                disabled={!source || cameraMode || starting || !backendOk || !config?.gemini_ready}
                className="inline-flex items-center gap-2 px-4 py-2.5 text-sm font-semibold rounded-lg bg-[#C23B22] text-white hover:bg-[#A6311B] disabled:opacity-50 transition-colors whitespace-nowrap shrink-0"
              >
                {starting ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Play className="h-4 w-4" aria-hidden="true" />}
                {status === 'stopped' && !run ? 'Start Monitoring' : 'Run Again'}
              </button>
            )}
          </div>
          {config && !config.gemini_ready && (
            <p className="text-xs font-medium text-[#C23B22]">The ops backend has no GEMINI_API_KEY, so monitoring can’t start.</p>
          )}
        </section>

        {/* Right rail */}
        <aside className="lg:col-span-4 space-y-6">
          {/* Line count */}
          <section className="rounded-xl border border-[#E5E0D8] bg-white p-5 space-y-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="font-display text-base font-semibold text-[#171717]">Line Right Now</h2>
                <p className="text-xs text-[#737373]">Guests waiting at the counter · alert at {threshold}+</p>
              </div>
              <span className="inline-flex items-center gap-1 rounded-md bg-[#EFECE6] px-2 py-0.5 text-[11px] font-semibold text-[#525252] whitespace-nowrap shrink-0">
                {running ? <Activity className="h-3 w-3 text-[#C23B22]" aria-hidden="true" /> : <Circle className="h-3 w-3" aria-hidden="true" />}
                {status}
              </span>
            </div>
            <div className="flex items-end justify-between gap-3">
              <div className="flex items-end gap-2">
                <span className={`font-display text-6xl font-bold leading-none ${overThreshold ? 'text-[#C23B22]' : 'text-[#171717]'}`}>
                  {latestDecision ? countLabel(latestDecision.queue_min, latestDecision.queue_max) : '–'}
                </span>
                <Users className="mb-1 h-5 w-5 text-[#737373]" aria-hidden="true" />
              </div>
              {latestDecision && (
                <span
                  className={`inline-flex items-center gap-1 text-xs font-semibold ${
                    trend > 0 ? 'text-[#C23B22]' : trend < 0 ? 'text-[#1F6E4A]' : 'text-[#737373]'
                  }`}
                >
                  {trend > 0 ? <TrendingUp className="h-4 w-4" /> : trend < 0 ? <TrendingDown className="h-4 w-4" /> : <Minus className="h-4 w-4" />}
                  {trend > 0 ? 'Growing' : trend < 0 ? 'Shrinking' : 'Steady'}
                </span>
              )}
            </div>
            {latestDecision ? (
              <p className="text-xs text-[#525252]">
                {latestDecision.visibility === 'clear' ? 'Clear view' : 'Partly hidden, so this is a range'} · frame{' '}
                {clock(latestDecision.frame_ms)}
                {latestDecision.verified ? ' · verified by ' + shortModel(verifier) : ''}
              </p>
            ) : (
              <p className="text-xs text-[#737373]">
                {running ? `${shortModel(observer)} is counting the first window…` : 'Start monitoring to count the line.'}
              </p>
            )}
            {sparkline.length > 1 && (
              <div className="space-y-1 border-t border-[#EFECE6] pt-3">
                <div className="relative flex h-14 items-end gap-1">
                  <div
                    className="absolute left-0 right-0 border-t border-dashed border-[#C23B22]/50"
                    style={{ bottom: `${(threshold / sparkMax) * 100}%` }}
                    aria-hidden="true"
                  />
                  {sparkline.map((d, i) => (
                    <div
                      key={i}
                      className={`flex-1 rounded-t-sm ${d.queue_min != null && d.queue_min >= threshold ? 'bg-[#C23B22]' : 'bg-[#171717]/70'}`}
                      style={{ height: `${Math.max(4, (((d.queue_min ?? 0) + (d.queue_max ?? 0)) / 2 / sparkMax) * 100)}%` }}
                      title={`${clock(d.frame_ms)} · ${countLabel(d.queue_min, d.queue_max)}`}
                    />
                  ))}
                </div>
                <p className="text-[11px] text-[#737373]">Last {sparkline.length} decisions · dashed line = threshold</p>
              </div>
            )}
          </section>

          {/* Model agreement */}
          <section className="rounded-xl border border-[#E5E0D8] bg-white p-5 space-y-3">
            <div>
              <h2 className="font-display text-base font-semibold text-[#171717]">Observer vs Verifier</h2>
              <p className="text-xs text-[#737373]">
                {observer} counts every window; {verifier} double-checks before a task is raised
              </p>
            </div>
            <div className="grid grid-cols-2 gap-3 text-xs">
              {[
                { label: shortModel(observer), obs: derived.lastObserve },
                { label: shortModel(verifier), obs: derived.lastReview },
              ].map(({ label, obs }) => (
                <div key={label} className="rounded-lg border border-[#E5E0D8] bg-[#F8F7F4] p-3 space-y-1">
                  <p className="font-semibold text-[#737373]">{label}</p>
                  <p className="font-display text-2xl font-bold text-[#171717]">{obs ? countLabel(obs.queue_min, obs.queue_max) : '–'}</p>
                  <p className="text-[11px] text-[#737373]">{obs ? `frame ${clock(obs.frame_ms)} · ${(obs.elapsed_ms / 1000).toFixed(1)}s` : label === shortModel(verifier) ? (derived.reviewing ? 'reviewing…' : `called only at ${threshold}+`) : 'no call yet'}</p>
                </div>
              ))}
            </div>
            {derived.reviews.length > 0 && (
              <p className="border-t border-[#EFECE6] pt-2.5 text-xs text-[#525252]">
                <span className="font-semibold text-[#171717]">Last review:</span>{' '}
                {derived.reviews[derived.reviews.length - 1].outcome.replace(/_/g, ' ')} ·{' '}
                {derived.reviews[derived.reviews.length - 1].summary}
              </p>
            )}
            {derived.lastError && <p className="text-xs font-medium text-[#C23B22]">{derived.lastError}</p>}
            {feedDropped && running && <p className="text-xs font-medium text-[#C23B22]">Event stream interrupted, reconnecting…</p>}
          </section>
        </aside>
      </div>

      {/* Tasks */}
      <section className="space-y-4">
        <div className="flex flex-wrap items-end justify-between gap-3 border-b border-[#E5E0D8] pb-3">
          <div>
            <h2 className="font-display text-lg font-semibold text-[#171717]">Line Alerts</h2>
            <p className="text-xs text-[#737373]">Raised only when the line holds at {threshold}+ and both models agree</p>
          </div>
        </div>
        {derived.tasks.length === 0 ? (
          <p className="rounded-xl border border-[#E5E0D8] bg-white p-5 text-sm text-[#525252]">
            {run ? 'No line alert in this run yet.' : 'Alerts from the current run will show here.'}
          </p>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {derived.tasks.map((task) => {
              const { hydrogen, argon } = taskPair(task);
              const agree = rangesAgree(hydrogen, argon);
              return (
                <article key={task.id} className="flex flex-col justify-between rounded-xl border border-[#E5E0D8] bg-white p-5 space-y-3">
                  <div className="space-y-2">
                    <div className="flex items-center justify-between gap-2">
                      <span
                        className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-semibold ${
                          task.status === 'open'
                            ? 'bg-[#C23B22]/10 text-[#C23B22]'
                            : task.status === 'acknowledged'
                              ? 'bg-[#B7791F]/10 text-[#8A5A12]'
                              : 'bg-[#1F6E4A]/10 text-[#1F6E4A]'
                        }`}
                      >
                        {task.status === 'resolved' ? <CheckCircle2 className="h-3 w-3" /> : <AlertTriangle className="h-3 w-3" />}
                        {task.status === 'open' ? 'Line needs attention' : task.status === 'acknowledged' ? 'Acknowledged' : 'Resolved'}
                      </span>
                      <span className="font-mono-tabular text-xs text-[#737373]">
                        {clock(task.created_ms)}
                        {task.updated_ms !== task.created_ms ? `–${clock(task.updated_ms)}` : ''}
                      </span>
                    </div>
                    <p className="font-display text-base font-semibold text-[#171717] leading-snug">{task.reason}</p>
                    {task.queue_min != null && (
                      <p className="text-xs text-[#525252]">Line: {countLabel(task.queue_min, task.queue_max)} guests</p>
                    )}
                  </div>
                  <div className="flex items-center justify-between gap-2 border-t border-[#EFECE6] pt-2.5 text-xs">
                    <span className="text-[#525252]">
                      {shortModel(observer)} <b className="font-mono-tabular text-[#171717]">{hydrogen ? countLabel(hydrogen.queue_min, hydrogen.queue_max) : '–'}</b> ·{' '}
                      {shortModel(verifier)} <b className="font-mono-tabular text-[#171717]">{argon ? countLabel(argon.queue_min, argon.queue_max) : '–'}</b>
                    </span>
                    {agree !== null && (
                      <span className={`inline-flex items-center gap-1 font-semibold ${agree ? 'text-[#1F6E4A]' : 'text-[#8A5A12]'}`}>
                        <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />
                        {agree ? 'Agree' : 'Disagree'}
                      </span>
                    )}
                  </div>
                  {task.status === 'open' && (
                    <button
                      type="button"
                      onClick={() => acknowledge(task.id)}
                      className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg bg-[#171717] px-4 py-2 text-xs font-semibold text-white hover:bg-[#2E2E2E] transition-colors"
                    >
                      Acknowledge
                    </button>
                  )}
                </article>
              );
            })}
          </div>
        )}
      </section>

      {/* Ops timeline */}
      <section className="rounded-xl border border-[#E5E0D8] bg-white p-5 space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="font-display text-base font-semibold text-[#171717]">Ops Timeline</h2>
            <p className="text-xs text-[#737373]">Line tasks, verifier reviews, monitor runs, and Fix-It scans from resto-ops</p>
          </div>
          <button type="button" onClick={loadTimeline} className="text-xs font-semibold text-[#C23B22] hover:underline whitespace-nowrap shrink-0">
            Refresh
          </button>
        </div>
        {timeline.length === 0 ? (
          <p className="py-3 text-xs text-[#737373]">{backendOk === false ? 'Timeline unavailable while the backend is offline.' : 'Nothing logged yet.'}</p>
        ) : (
          <ol className="divide-y divide-[#EFECE6]">
            {timeline.slice(0, 20).map((item, i) => {
              const t = timelineText(item);
              return (
                <li key={`${item.created_ms}-${i}`} className="flex items-start gap-3 py-2.5 text-xs">
                  <span className="w-20 shrink-0 font-mono-tabular text-[#737373]">{wallTime(item.created_ms)}</span>
                  <span
                    className={`shrink-0 rounded-md px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
                      item.module === 'queue' ? 'bg-[#EFECE6] text-[#525252]' : 'bg-[#C23B22]/10 text-[#C23B22]'
                    }`}
                  >
                    {item.module === 'queue' ? 'Line' : item.module}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold text-[#171717]">{t.title}</p>
                    {t.detail && <p className="truncate text-[#525252]">{t.detail}</p>}
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </section>
    </div>
  );
}
