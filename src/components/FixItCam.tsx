import {
  AlertTriangle,
  Camera,
  CameraOff,
  CheckCircle2,
  Circle,
  ExternalLink,
  ImageIcon,
  Loader2,
  RotateCcw,
  ScanSearch,
  ShoppingBag,
  Square,
  Star,
  Upload,
  Video,
  Wrench,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

/* ---------- Fix-It backend contract (DotBion/fixitcam, proxied at /api/fixit/*) ---------- */

interface FixItSpec {
  name: string;
  value: string;
  source?: string;
}

interface FixItEvidence {
  t: string;
  observation: string;
}

interface FixItDiagnosis {
  item?: string;
  broken_part?: string;
  failure?: string;
  replace?: string;
  repair_tip?: string;
  confidence?: number;
  specs?: FixItSpec[];
  evidence?: FixItEvidence[];
  uncertainties?: string[];
}

interface FixItProduct {
  title?: string;
  variant_title?: string;
  price_minor?: number | null;
  currency?: string;
  image_url?: string | null;
  product_url?: string | null;
  checkout_url?: string | null;
  seller_name?: string | null;
  shop?: string | null;
  variant_id?: string | null;
  rating?: number | null;
  rating_count?: number | null;
  fit?: number;
  reason?: string;
  check?: string;
}

interface FixItTimings {
  upload_s?: number;
  diagnose_s?: number;
  search_s?: number;
  gate_s?: number;
  rank_s?: number;
  total_s?: number;
}

type FixItEvent =
  | { event: 'stage'; stage: string; label: string }
  | { event: 'diagnosis'; diagnosis: FixItDiagnosis; timings?: FixItTimings }
  | { event: 'results'; top: FixItProduct[]; considered: number; timings?: FixItTimings }
  | { event: 'error'; message: string };

interface StageEntry {
  id: string;
  label: string;
}

type Phase = 'idle' | 'recording' | 'ready' | 'running' | 'done';

const CLIP_SECONDS = 8;
const PIPELINE: Array<{ id: string; label: string }> = [
  { id: 'send', label: 'Upload footage' },
  { id: 'diagnose', label: 'Gemini 4 diagnosis' },
  { id: 'search', label: 'Shop catalog search' },
  { id: 'gate', label: 'Decisions API fit check' },
  { id: 'rank', label: 'Rank top 3' },
];

function formatMoney(minor: number | null | undefined, currency = 'USD'): string {
  if (minor == null) return '';
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(minor / 100);
  } catch {
    return `$${(minor / 100).toFixed(2)}`;
  }
}

function formatSize(bytes: number): string {
  return bytes >= 1 << 20 ? `${(bytes / (1 << 20)).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`;
}

function pickRecorderMime(): string | undefined {
  if (typeof MediaRecorder === 'undefined') return undefined;
  const options = ['video/mp4', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
  return options.find((m) => MediaRecorder.isTypeSupported(m));
}

function openCheckout(url: string, preopened?: Window | null) {
  // URL is used exactly as returned by Shop; payment always happens on the merchant's page.
  if (preopened) {
    preopened.location.href = url;
    return;
  }
  const w = window.open(url, '_blank', 'noopener,noreferrer');
  if (!w) window.location.href = url;
}

/** POST multipart to the proxy with upload progress and incremental NDJSON parsing. */
function streamAnalyze(
  form: FormData,
  onUploadProgress: (loaded: number, total: number) => void,
  onEvent: (ev: FixItEvent) => void,
): { promise: Promise<void>; abort: () => void } {
  const xhr = new XMLHttpRequest();
  const promise = new Promise<void>((resolve, reject) => {
    let offset = 0;
    let buffer = '';
    const drain = () => {
      const text = xhr.responseText;
      buffer += text.slice(offset);
      offset = text.length;
      let idx: number;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        try {
          onEvent(JSON.parse(line) as FixItEvent);
        } catch {
          /* ignore partial / non-JSON lines */
        }
      }
    };
    xhr.open('POST', '/api/fixit/analyze');
    xhr.upload.onprogress = (e) => onUploadProgress(e.loaded, e.lengthComputable ? e.total : 0);
    xhr.onprogress = () => {
      if (xhr.status === 200) drain();
    };
    xhr.onload = () => {
      if (xhr.status !== 200) {
        let message = `Fix-It backend returned ${xhr.status}`;
        try {
          const body = JSON.parse(xhr.responseText) as { detail?: string; error?: string };
          message = body.detail || body.error || message;
        } catch {
          /* keep default */
        }
        reject(new Error(message));
        return;
      }
      drain();
      if (buffer.trim()) {
        buffer += '\n';
        drain();
      }
      resolve();
    };
    xhr.onerror = () => reject(new Error('Network error while talking to the Fix-It backend.'));
    xhr.onabort = () => reject(new Error('Cancelled.'));
    xhr.send(form);
  });
  return { promise, abort: () => xhr.abort() };
}

export function FixItCam() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const timerRef = useRef<number | null>(null);
  const abortRef = useRef<(() => void) | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const [cameraOn, setCameraOn] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [secondsLeft, setSecondsLeft] = useState(CLIP_SECONDS);
  const [clip, setClip] = useState<File | null>(null);
  const [clipUrl, setClipUrl] = useState<string | null>(null);
  const [note, setNote] = useState('');

  const [stages, setStages] = useState<StageEntry[]>([]);
  const [uploadPct, setUploadPct] = useState<number | null>(null);
  const [diagnosis, setDiagnosis] = useState<FixItDiagnosis | null>(null);
  const [products, setProducts] = useState<FixItProduct[] | null>(null);
  const [considered, setConsidered] = useState(0);
  const [timings, setTimings] = useState<FixItTimings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [backendOk, setBackendOk] = useState<boolean | null>(null);
  const [buyingIdx, setBuyingIdx] = useState<number | null>(null);
  const [buyError, setBuyError] = useState<string | null>(null);

  // Backend health indicator
  useEffect(() => {
    let cancelled = false;
    fetch('/api/fixit/health')
      .then((r) => r.json().then((j: { ok?: boolean }) => !cancelled && setBackendOk(r.ok && !!j.ok)))
      .catch(() => !cancelled && setBackendOk(false));
    return () => {
      cancelled = true;
    };
  }, []);

  const stopCamera = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setCameraOn(false);
  }, []);

  useEffect(
    () => () => {
      if (timerRef.current) window.clearInterval(timerRef.current);
      if (recorderRef.current && recorderRef.current.state !== 'inactive') recorderRef.current.stop();
      abortRef.current?.();
      streamRef.current?.getTracks().forEach((t) => t.stop());
    },
    [],
  );

  useEffect(() => {
    if (!clip) {
      setClipUrl(null);
      return;
    }
    const url = URL.createObjectURL(clip);
    setClipUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [clip]);

  function resetResults() {
    setStages([]);
    setUploadPct(null);
    setDiagnosis(null);
    setProducts(null);
    setTimings(null);
    setError(null);
    setBuyError(null);
  }

  async function startCamera() {
    setCameraError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play().catch(() => undefined);
      }
      setCameraOn(true);
    } catch (err) {
      setCameraError(
        err instanceof Error && err.name === 'NotAllowedError'
          ? 'Camera permission was denied. Allow camera access, or upload a clip instead.'
          : 'No camera available here. Upload a clip or photo instead.',
      );
    }
  }

  function acceptFile(file: File) {
    resetResults();
    setClip(file);
    setPhase('ready');
  }

  function startRecording() {
    const stream = streamRef.current;
    if (!stream) return;
    const mimeType = pickRecorderMime();
    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(stream, mimeType ? { mimeType, videoBitsPerSecond: 2_500_000 } : undefined);
    } catch {
      setCameraError('Recording is not supported in this browser. Snap a photo or upload a clip.');
      return;
    }
    const chunks: Blob[] = [];
    recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    recorder.onstop = () => {
      if (timerRef.current) window.clearInterval(timerRef.current);
      timerRef.current = null;
      const type = (recorder.mimeType || mimeType || 'video/webm').split(';')[0];
      const ext = type.includes('mp4') ? 'mp4' : 'webm';
      if (chunks.length) acceptFile(new File(chunks, `fixit-clip.${ext}`, { type }));
      else setPhase('idle');
    };
    recorderRef.current = recorder;
    resetResults();
    setClip(null);
    recorder.start(250);
    setPhase('recording');
    setSecondsLeft(CLIP_SECONDS);
    const startedAt = Date.now();
    timerRef.current = window.setInterval(() => {
      const left = CLIP_SECONDS - Math.floor((Date.now() - startedAt) / 1000);
      setSecondsLeft(Math.max(0, left));
      if (left <= 0 && recorder.state !== 'inactive') recorder.stop();
    }, 200);
  }

  function stopRecording() {
    if (recorderRef.current && recorderRef.current.state !== 'inactive') recorderRef.current.stop();
  }

  function snapPhoto() {
    const video = videoRef.current;
    if (!video || !video.videoWidth) return;
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d')?.drawImage(video, 0, 0);
    canvas.toBlob(
      (blob) => blob && acceptFile(new File([blob], 'fixit-photo.jpg', { type: 'image/jpeg' })),
      'image/jpeg',
      0.9,
    );
  }

  async function runDiagnosis() {
    if (!clip) return;
    resetResults();
    setPhase('running');
    setStages([{ id: 'send', label: `Uploading ${clip.type.startsWith('image/') ? 'photo' : 'clip'} (${formatSize(clip.size)})` }]);
    setUploadPct(0);

    const form = new FormData();
    form.append('files', clip, clip.name);
    form.append('note', note);

    const { promise, abort } = streamAnalyze(
      form,
      (loaded, total) => setUploadPct(total ? Math.round((100 * loaded) / total) : null),
      (ev) => {
        if (ev.event === 'stage') {
          if (ev.stage === 'upload') return; // covered by our own upload step
          setUploadPct(100);
          setStages((prev) => [...prev, { id: ev.stage, label: ev.label }]);
        } else if (ev.event === 'diagnosis') {
          setDiagnosis(ev.diagnosis);
        } else if (ev.event === 'results') {
          setProducts(ev.top || []);
          setConsidered(ev.considered || 0);
          setTimings(ev.timings || null);
        } else if (ev.event === 'error') {
          setError(ev.message);
        }
      },
    );
    abortRef.current = abort;
    try {
      await promise;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      abortRef.current = null;
      setPhase('done');
    }
  }

  async function buy(product: FixItProduct, idx: number) {
    setBuyError(null);
    if (product.checkout_url) {
      openCheckout(product.checkout_url);
      return;
    }
    if (!product.shop || !product.variant_id) {
      if (product.product_url) openCheckout(product.product_url);
      else setBuyError('This offer has no checkout link.');
      return;
    }
    // Open synchronously so popup blockers allow it, then point it at the returned checkout URL.
    const preopened = window.open('about:blank', '_blank');
    setBuyingIdx(idx);
    try {
      const r = await fetch('/api/fixit/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ shop: product.shop, variant_id: product.variant_id }),
      });
      const j = (await r.json()) as { continue_url?: string; error?: string };
      if (!r.ok || !j.continue_url) throw new Error(j.error || 'Checkout could not be created.');
      openCheckout(j.continue_url, preopened);
    } catch (err) {
      preopened?.close();
      setBuyError(err instanceof Error ? err.message : 'Checkout failed.');
    } finally {
      setBuyingIdx(null);
    }
  }

  const running = phase === 'running';
  const doneIds = new Set(stages.slice(0, running ? -1 : undefined).map((s) => s.id));
  const activeId = running ? stages[stages.length - 1]?.id : undefined;
  const stageLabel = (id: string) => stages.find((s) => s.id === id)?.label;
  const confidencePct = Math.round((diagnosis?.confidence ?? 0) * 100);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-4 border-b border-[#E5E0D8] pb-4">
        <div className="space-y-1">
          <p className="text-xs font-medium tracking-wide text-[#737373]">
            Kitchen Equipment Repair · Gemini 4 Vision + Shop Catalog
          </p>
          <h1 className="font-display text-2xl font-bold text-[#171717]">Fix-It Cam</h1>
          <p className="text-sm text-[#525252]">
            Film the broken part on a mixer, oven, or slicer. Gemini 4 names the exact part and Shop
            finds the three best replacements you can buy right now.
          </p>
        </div>
        <span
          className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-semibold whitespace-nowrap shrink-0 ${
            backendOk === false
              ? 'border-[#C23B22]/30 bg-[#C23B22]/8 text-[#8F2411]'
              : 'border-[#E5E0D8] bg-white text-[#525252]'
          }`}
        >
          <span
            className={`h-2 w-2 rounded-full ${
              backendOk === null ? 'bg-[#D4CFC6]' : backendOk ? 'bg-[#1F6E4A]' : 'bg-[#C23B22]'
            }`}
            aria-hidden="true"
          />
          {backendOk === null ? 'Checking Fix-It backend…' : backendOk ? 'Fix-It backend online' : 'Fix-It backend offline'}
        </span>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* Capture */}
        <section className="lg:col-span-7 rounded-xl border border-[#E5E0D8] bg-white p-6 space-y-5">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <h2 className="font-display text-lg font-semibold text-[#171717]">Rear Camera Capture</h2>
              <p className="text-xs text-[#737373]">
                Record a {CLIP_SECONDS}-second clip close to the label or connector, snap a photo, or upload
                footage.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2.5">
              <button
                type="button"
                onClick={cameraOn ? stopCamera : startCamera}
                disabled={phase === 'recording' || running}
                className="inline-flex items-center gap-2 px-4 py-2.5 text-sm font-semibold rounded-lg border border-[#E5E0D8] bg-white text-[#171717] hover:bg-[#F8F7F4] disabled:opacity-50 transition-colors whitespace-nowrap shrink-0"
              >
                {cameraOn ? (
                  <>
                    <CameraOff className="h-4 w-4" aria-hidden="true" />
                    Stop Camera
                  </>
                ) : (
                  <>
                    <Camera className="h-4 w-4" aria-hidden="true" />
                    Start Camera
                  </>
                )}
              </button>
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={phase === 'recording' || running}
                className="inline-flex items-center gap-2 px-4 py-2.5 text-sm font-semibold rounded-lg border border-[#E5E0D8] bg-white text-[#171717] hover:bg-[#F8F7F4] disabled:opacity-50 transition-colors whitespace-nowrap shrink-0"
              >
                <Upload className="h-4 w-4" aria-hidden="true" />
                Upload Clip
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept="video/*,image/*"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) acceptFile(f);
                  e.target.value = '';
                }}
              />
            </div>
          </div>

          {/* Viewfinder */}
          <div className="relative aspect-video w-full overflow-hidden rounded-lg border border-[#E5E0D8] bg-[#171717]">
            <video
              ref={videoRef}
              muted
              playsInline
              className={`h-full w-full object-cover ${cameraOn && !(clipUrl && phase !== 'recording') ? 'block' : 'hidden'}`}
            />
            {clipUrl && phase !== 'recording' && clip?.type.startsWith('video/') && (
              <video src={clipUrl} controls playsInline muted className="h-full w-full object-contain bg-black" />
            )}
            {clipUrl && phase !== 'recording' && clip?.type.startsWith('image/') && (
              <img src={clipUrl} alt="Captured part" className="h-full w-full object-contain bg-black" />
            )}
            {!cameraOn && !clipUrl && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 text-center">
                <span className="flex h-12 w-12 items-center justify-center rounded-full bg-white/10">
                  <Video className="h-5 w-5 text-white" aria-hidden="true" />
                </span>
                <p className="text-sm font-semibold text-white">Point the rear camera at the broken part</p>
                <p className="max-w-sm text-xs text-white/60">
                  Start the camera, or upload a phone clip. Show the model label and the damaged area up close.
                </p>
              </div>
            )}
            {phase === 'recording' && (
              <div className="absolute left-3 top-3 inline-flex items-center gap-2 rounded-full bg-[#C23B22] px-3 py-1 text-xs font-semibold text-white">
                <span className="h-2 w-2 animate-pulse rounded-full bg-white" aria-hidden="true" />
                REC · <span className="font-mono-tabular">0:{String(secondsLeft).padStart(2, '0')}</span>
              </div>
            )}
            {clip && phase !== 'recording' && (
              <div className="absolute right-3 top-3 rounded-full bg-black/60 px-3 py-1 text-[11px] font-medium text-white">
                {clip.type.startsWith('image/') ? 'Photo' : 'Clip'} · {formatSize(clip.size)}
              </div>
            )}
          </div>

          {cameraError && (
            <p role="alert" className="text-xs font-medium text-[#C23B22]">
              {cameraError}
            </p>
          )}

          {/* Camera actions */}
          {cameraOn && (
            <div className="flex flex-wrap items-center gap-2.5">
              {phase === 'recording' ? (
                <button
                  type="button"
                  onClick={stopRecording}
                  className="inline-flex items-center gap-2 px-4 py-2.5 text-sm font-semibold rounded-lg bg-[#171717] text-white hover:bg-[#2E2E2E] transition-colors whitespace-nowrap shrink-0"
                >
                  <Square className="h-4 w-4" aria-hidden="true" />
                  Stop Recording
                </button>
              ) : (
                <button
                  type="button"
                  onClick={startRecording}
                  disabled={running}
                  className="inline-flex items-center gap-2 px-4 py-2.5 text-sm font-semibold rounded-lg bg-[#C23B22] text-white hover:bg-[#A6311B] disabled:opacity-50 transition-colors whitespace-nowrap shrink-0"
                >
                  <Circle className="h-4 w-4 fill-current" aria-hidden="true" />
                  {clip ? 'Record Again' : `Record ${CLIP_SECONDS}s Clip`}
                </button>
              )}
              <button
                type="button"
                onClick={snapPhoto}
                disabled={phase === 'recording' || running}
                className="inline-flex items-center gap-2 px-4 py-2.5 text-sm font-semibold rounded-lg border border-[#E5E0D8] bg-white text-[#171717] hover:bg-[#F8F7F4] disabled:opacity-50 transition-colors whitespace-nowrap shrink-0"
              >
                <ImageIcon className="h-4 w-4" aria-hidden="true" />
                Snap Photo
              </button>
              {clip && phase !== 'recording' && (
                <button
                  type="button"
                  onClick={() => {
                    setClip(null);
                    setPhase('idle');
                    resetResults();
                  }}
                  disabled={running}
                  className="inline-flex items-center gap-1 text-xs font-semibold text-[#C23B22] hover:underline disabled:opacity-50 whitespace-nowrap shrink-0"
                >
                  <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
                  Back to live view
                </button>
              )}
            </div>
          )}

          {/* Note + analyze */}
          <div className="space-y-3 border-t border-[#EFECE6] pt-4">
            <label className="block space-y-1.5">
              <span className="block text-xs font-medium text-[#737373]">Optional note for Gemini</span>
              <input
                type="text"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="e.g. KitchenAid stand mixer, grinding noise then the beater stopped"
                className="w-full rounded-lg border border-[#E5E0D8] bg-white px-3.5 py-2.5 text-sm text-[#171717] placeholder:text-[#8A8A8A] focus:border-[#C23B22] focus:outline-none"
              />
            </label>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-xs text-[#737373]">
                {clip
                  ? `Ready: ${clip.name} (${formatSize(clip.size)})`
                  : 'No footage yet. Record, snap, or upload to continue.'}
              </p>
              <button
                type="button"
                onClick={runDiagnosis}
                disabled={!clip || running || phase === 'recording'}
                className="inline-flex items-center gap-2 px-4 py-2.5 text-sm font-semibold rounded-lg bg-[#171717] text-white hover:bg-[#2E2E2E] disabled:opacity-50 transition-colors whitespace-nowrap shrink-0"
              >
                {running ? (
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                ) : (
                  <ScanSearch className="h-4 w-4" aria-hidden="true" />
                )}
                {running ? 'Diagnosing…' : 'Diagnose & Find Parts'}
              </button>
            </div>
          </div>
        </section>

        {/* Right rail: pipeline + diagnosis */}
        <aside className="lg:col-span-5 space-y-6">
          <section className="rounded-xl border border-[#E5E0D8] bg-white p-5 space-y-4">
            <div>
              <h2 className="font-display text-base font-semibold text-[#171717]">Diagnosis Pipeline</h2>
              <p className="text-xs text-[#737373]">
                Gemini 4 vision · Shop catalog · gemini-decision-1 fit gate · Gemini 4 ranking
              </p>
            </div>
            <ol className="space-y-2.5 text-xs">
              {PIPELINE.map((step) => {
                const done = doneIds.has(step.id) || (phase === 'done' && !error && stageLabel(step.id) !== undefined);
                const active = activeId === step.id;
                return (
                  <li key={step.id} className="flex items-start gap-2.5">
                    {active ? (
                      <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-[#C23B22]" aria-hidden="true" />
                    ) : done ? (
                      <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-[#1F6E4A]" aria-hidden="true" />
                    ) : (
                      <Circle className="mt-0.5 h-4 w-4 shrink-0 text-[#D4CFC6]" aria-hidden="true" />
                    )}
                    <div className="min-w-0 flex-1">
                      <p className={`font-semibold ${active || done ? 'text-[#171717]' : 'text-[#8A8A8A]'}`}>
                        {step.label}
                      </p>
                      {(active || done) && stageLabel(step.id) && (
                        <p className="text-[11px] text-[#737373] leading-snug">{stageLabel(step.id)}</p>
                      )}
                      {step.id === 'send' && active && uploadPct !== null && (
                        <div className="mt-1.5 h-1.5 w-full rounded-full bg-[#EFECE6] overflow-hidden">
                          <div className="h-full bg-[#C23B22] transition-all" style={{ width: `${uploadPct}%` }} />
                        </div>
                      )}
                    </div>
                  </li>
                );
              })}
            </ol>
            {timings?.total_s != null && (
              <p className="border-t border-[#EFECE6] pt-2.5 font-mono-tabular text-[11px] text-[#737373]">
                diagnose {timings.diagnose_s}s · search {timings.search_s}s · gate {timings.gate_s ?? '–'}s · rank{' '}
                {timings.rank_s}s · total {timings.total_s}s
              </p>
            )}
          </section>

          {error && (
            <div
              role="alert"
              className="flex items-start gap-3 rounded-xl border border-[#C23B22]/30 bg-[#C23B22]/8 px-5 py-3 text-sm text-[#8F2411]"
            >
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              <div className="space-y-1">
                <p className="font-semibold">Fix-It couldn’t finish</p>
                <p className="text-xs">{error}</p>
              </div>
            </div>
          )}

          <section className="rounded-xl border border-[#E5E0D8] bg-white p-5 space-y-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="font-display text-base font-semibold text-[#171717]">Diagnosis</h2>
                <p className="text-xs text-[#737373]">What’s broken and what to replace</p>
              </div>
              {diagnosis && (
                <span className="font-mono-tabular text-xs font-semibold text-[#1F6E4A] whitespace-nowrap shrink-0">
                  {confidencePct}% confident
                </span>
              )}
            </div>
            {!diagnosis ? (
              <p className="text-xs text-[#737373] py-3">
                {running
                  ? 'Gemini 4 is watching the footage…'
                  : 'Run a diagnosis to see the identified appliance, failed part, specs read from the label, and a repair tip.'}
              </p>
            ) : (
              <div className="space-y-3 text-xs">
                <div className="space-y-1">
                  <p className="text-[#737373]">{diagnosis.item}</p>
                  <p className="font-display text-lg font-semibold text-[#171717] leading-snug">
                    {diagnosis.broken_part}
                  </p>
                  {diagnosis.failure && <p className="text-sm text-[#525252]">{diagnosis.failure}</p>}
                </div>
                <div className="h-1.5 w-full rounded-full bg-[#EFECE6] overflow-hidden">
                  <div className="h-full bg-[#1F6E4A]" style={{ width: `${confidencePct}%` }} />
                </div>
                {diagnosis.replace && (
                  <div className="flex items-center justify-between gap-3 border-t border-[#EFECE6] pt-2.5">
                    <span className="text-[#525252]">Replace with</span>
                    <span className="text-right font-semibold text-[#171717]">{diagnosis.replace}</span>
                  </div>
                )}
                {!!diagnosis.specs?.length && (
                  <div className="flex flex-wrap gap-1.5 border-t border-[#EFECE6] pt-2.5">
                    {diagnosis.specs.map((s, i) => (
                      <span
                        key={`${s.name}-${i}`}
                        className="rounded-md bg-[#EFECE6] px-2 py-1 text-[11px] text-[#171717]"
                        title={s.source}
                      >
                        <span className="text-[#737373]">{s.name}:</span> {s.value}
                      </span>
                    ))}
                  </div>
                )}
                {!!diagnosis.evidence?.length && (
                  <div className="space-y-1 border-t border-[#EFECE6] pt-2.5">
                    {diagnosis.evidence.slice(0, 4).map((e, i) => (
                      <p key={i} className="text-[#525252] leading-snug">
                        <span className="font-mono-tabular font-semibold text-[#C23B22]">{e.t}</span> {e.observation}
                      </p>
                    ))}
                  </div>
                )}
                {diagnosis.repair_tip && (
                  <div className="flex items-start gap-2 rounded-lg border border-[#E5E0D8] bg-[#F8F7F4] p-3">
                    <Wrench className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#171717]" aria-hidden="true" />
                    <p className="text-[#171717] leading-snug">{diagnosis.repair_tip}</p>
                  </div>
                )}
                {!!diagnosis.uncertainties?.length && (
                  <p className="text-[11px] text-[#737373]">Not sure about: {diagnosis.uncertainties.join(' · ')}</p>
                )}
              </div>
            )}
          </section>
        </aside>
      </div>

      {/* Replacement parts */}
      {(products || (running && diagnosis)) && (
        <section className="space-y-4">
          <div className="flex flex-wrap items-end justify-between gap-3 border-b border-[#E5E0D8] pb-3">
            <div>
              <h2 className="font-display text-lg font-semibold text-[#171717]">Top Replacement Parts</h2>
              <p className="text-xs text-[#737373]">
                {products
                  ? `Ranked from ${considered} live Shop offers · you review and pay on the merchant’s checkout`
                  : 'Searching the Shop catalog and checking fit…'}
              </p>
            </div>
          </div>
          {buyError && (
            <p role="alert" className="text-xs font-medium text-[#C23B22]">
              {buyError}
            </p>
          )}
          {!products ? (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              {[0, 1, 2].map((i) => (
                <div key={i} className="h-80 animate-pulse rounded-xl border border-[#E5E0D8] bg-white" />
              ))}
            </div>
          ) : products.length === 0 ? (
            <p className="rounded-xl border border-[#E5E0D8] bg-white p-5 text-sm text-[#525252]">
              No matching part in the live catalog. Try a clip that shows the model label or connector up close.
            </p>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              {products.slice(0, 3).map((p, i) => (
                <article
                  key={`${p.variant_id ?? p.title}-${i}`}
                  className="flex flex-col justify-between overflow-hidden rounded-xl border border-[#E5E0D8] bg-white transition-transform duration-150 hover:-translate-y-0.5"
                >
                  <div>
                    <div className="relative aspect-[4/3] w-full bg-white overflow-hidden border-b border-[#EFECE6]">
                      {p.image_url ? (
                        <img
                          src={p.image_url}
                          alt={p.title ?? ''}
                          referrerPolicy="no-referrer"
                          loading="lazy"
                          className="h-full w-full object-contain p-3"
                        />
                      ) : (
                        <div className="flex h-full w-full items-center justify-center bg-[#EFECE6]">
                          <ShoppingBag className="h-8 w-8 text-[#A3A3A3]" aria-hidden="true" />
                        </div>
                      )}
                      <span className="absolute left-3 top-3 rounded-md bg-[#171717] px-2 py-0.5 text-xs font-bold text-white">
                        #{i + 1}
                      </span>
                      {p.fit != null && (
                        <span
                          className={`absolute right-3 top-3 rounded-md px-2 py-0.5 font-mono-tabular text-xs font-semibold ${
                            p.fit >= 0.6 ? 'bg-[#1F6E4A]/10 text-[#1F6E4A]' : 'bg-[#B7791F]/10 text-[#8A5A12]'
                          }`}
                        >
                          fit {Math.round(p.fit * 100)}%
                        </span>
                      )}
                    </div>
                    <div className="p-5 space-y-2">
                      <p className="text-xs text-[#737373] truncate">
                        {p.seller_name || p.shop}
                        {p.rating ? (
                          <span className="inline-flex items-center gap-0.5 align-middle">
                            {' '}
                            · <Star className="h-3 w-3 fill-current text-[#B7791F]" aria-hidden="true" /> {p.rating}
                            {p.rating_count ? ` (${p.rating_count})` : ''}
                          </span>
                        ) : null}
                      </p>
                      <div className="flex items-baseline justify-between gap-2">
                        <h3 className="font-display text-base font-semibold text-[#171717] leading-snug line-clamp-2">
                          {p.title}
                        </h3>
                        <span className="font-mono-tabular text-base font-bold text-[#171717] whitespace-nowrap">
                          {formatMoney(p.price_minor, p.currency)}
                        </span>
                      </div>
                      {p.reason && <p className="text-xs leading-relaxed text-[#525252]">{p.reason}</p>}
                      {p.check && (
                        <p className="flex items-start gap-1.5 text-[11px] text-[#8A5A12]">
                          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
                          {p.check}
                        </p>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 px-5 pb-5">
                    <button
                      type="button"
                      onClick={() => buy(p, i)}
                      disabled={buyingIdx === i}
                      className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-[#C23B22] px-4 py-2 text-xs font-semibold text-white hover:bg-[#A6311B] disabled:opacity-50 transition-colors"
                    >
                      <ShoppingBag className="h-3.5 w-3.5" aria-hidden="true" />
                      {buyingIdx === i ? 'Creating checkout…' : 'Buy'}
                    </button>
                    {p.product_url && (
                      <a
                        href={p.product_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 rounded-lg border border-[#E5E0D8] px-3 py-2 text-xs font-semibold text-[#171717] hover:bg-[#F8F7F4] transition-colors whitespace-nowrap shrink-0"
                      >
                        View
                        <ExternalLink className="h-3 w-3" aria-hidden="true" />
                      </a>
                    )}
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
