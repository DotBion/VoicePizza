import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  FlaskConical,
  GitCompare,
  Loader2,
  Moon,
  Play,
  RefreshCw,
  RotateCcw,
  X,
  XCircle,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

/**
 * Stress Lab "Past Cases" + "Overnight Analysis".
 * Cases (every Fix-It diagnosis, Floor Monitor run, and Stress Lab run) and the nightly Gemini 4 Argon
 * review are stored and scheduled on the resto-ops backend, reached through /api/ops/* (opsProxy).
 */

export type CaseStatus = 'ok' | 'failed' | 'timeout' | 'disagreement';
export type CaseSource = 'fixit' | 'floor' | 'stress';
export type CaseArea = 'kitchen' | 'front-of-house' | 'inventory' | 'other';

export interface PastCase {
  id: string;
  source: CaseSource;
  status: CaseStatus;
  created_ms: number;
  title: string;
  area?: CaseArea;
  domain_miss?: boolean;
  input?: Record<string, unknown> & { replayable?: boolean; level?: number; source_id?: string };
  models?: Record<string, unknown>;
  latency_ms?: number | null;
  error?: string | null;
  errors?: Array<{ code?: string; message?: string; at_ms?: number; phase?: string }>;
  disagreements?: Array<{ at_ms: number; observer: number[]; verifier: number[] }>;
  replay_of?: string | null;
  run_status?: string;
}

interface Counts {
  total: number;
  status: Record<CaseStatus, number>;
  source: Record<CaseSource, number>;
  area?: Record<CaseArea, number>;
  domain_miss?: number;
}

interface ReportGroup {
  cause: string;
  severity: 'high' | 'medium' | 'low';
  sources?: string[];
  case_ids: string[];
  suggested_fix: string;
  count?: number;
}

interface Report {
  id: string;
  created_ms: number;
  finished_ms?: number;
  trigger: 'scheduled' | 'manual';
  status: 'ok' | 'partial' | 'failed' | 'empty' | 'skipped';
  model: string;
  cases_total: number;
  cases_analyzed: number;
  calls: number;
  duration_ms?: number;
  summary: string;
  groups: ReportGroup[];
  regression_tests: Array<{ case_id: string; reason: string; title?: string; source?: string }>;
  errors: string[];
}

interface AnalysisStatus {
  schedule: { enabled: boolean; hour: number; timezone: string; label: string; next_run_ms: number | null };
  model: string;
  thinking_level: string;
  window_hours: number;
  batch_size: number;
  max_calls: number;
  gemini_ready: boolean;
  running: boolean;
  started_ms: number | null;
  cases: Counts;
  known_issues?: Array<{ source: string; issue: string }>;
  cases_last_24h: number;
  latest: Report | null;
}

const ET = 'America/New_York';

export function formatEt(ms: number | null | undefined, withDate = true): string {
  if (!ms) return '—';
  const text = new Date(ms).toLocaleString('en-US', {
    timeZone: ET,
    ...(withDate ? { month: 'short', day: 'numeric' } : {}),
    hour: 'numeric',
    minute: '2-digit',
  });
  return `${text} ET`;
}

function relative(ms: number | null | undefined): string {
  if (!ms) return '';
  const diff = ms - Date.now();
  const abs = Math.abs(diff);
  const unit = abs >= 3_600_000 ? `${Math.round(abs / 3_600_000)} h` : `${Math.max(1, Math.round(abs / 60_000))} min`;
  return diff >= 0 ? `in ${unit}` : `${unit} ago`;
}

function latency(ms: number | null | undefined): string {
  if (ms == null) return '—';
  return ms >= 10_000 ? `${(ms / 1000).toFixed(0)} s` : ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${ms} ms`;
}

const STATUS_META: Record<CaseStatus, { label: string; cls: string; Icon: typeof CheckCircle2 }> = {
  ok: { label: 'OK', cls: 'border-[#1F6E4A]/25 bg-[#1F6E4A]/8 text-[#1F6E4A]', Icon: CheckCircle2 },
  failed: { label: 'Failed', cls: 'border-[#C23B22]/30 bg-[#C23B22]/8 text-[#8F2411]', Icon: XCircle },
  timeout: { label: 'Timed out', cls: 'border-[#E0A33A]/40 bg-[#E0A33A]/10 text-[#8A5A12]', Icon: Clock },
  disagreement: { label: 'Models disagree', cls: 'border-[#E0A33A]/40 bg-[#E0A33A]/10 text-[#8A5A12]', Icon: GitCompare },
};

const SOURCE_LABEL: Record<CaseSource, string> = { fixit: 'Fix-It Cam', floor: 'Floor Monitor', stress: 'Stress Lab' };
const AREA_LABEL: Record<CaseArea, string> = {
  kitchen: 'Kitchen',
  'front-of-house': 'Front of house',
  inventory: 'Inventory',
  other: 'Other',
};

function AreaTag({ area, miss }: { area?: CaseArea; miss?: boolean }) {
  return (
    <>
      {area && (
        <span className="inline-flex rounded-md border border-[#E5E0D8] bg-white px-1.5 py-0.5 text-[11px] text-[#525252] whitespace-nowrap shrink-0">
          {AREA_LABEL[area] ?? area}
        </span>
      )}
      {miss && (
        <span
          title="The diagnosis or Shop match is not restaurant / commercial-kitchen relevant"
          className="inline-flex rounded-md border border-[#C23B22]/30 bg-[#C23B22]/8 px-1.5 py-0.5 text-[11px] font-semibold text-[#8F2411] whitespace-nowrap shrink-0"
        >
          Off-domain
        </span>
      )}
    </>
  );
}

function StatusPill({ status }: { status: CaseStatus }) {
  const meta = STATUS_META[status] ?? STATUS_META.failed;
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-semibold whitespace-nowrap shrink-0 ${meta.cls}`}>
      <meta.Icon className="h-3 w-3" aria-hidden="true" />
      {meta.label}
    </span>
  );
}

function SourceTag({ source }: { source: CaseSource }) {
  return (
    <span className="inline-flex rounded-md border border-[#E5E0D8] bg-[#F8F7F4] px-1.5 py-0.5 text-[11px] font-medium text-[#525252] whitespace-nowrap shrink-0">
      {SOURCE_LABEL[source] ?? source}
    </span>
  );
}

async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    /* not JSON */
  }
  if (!res.ok) {
    const detail = (body as { detail?: unknown; error?: unknown } | null)?.detail ?? (body as { error?: unknown } | null)?.error;
    throw new Error(typeof detail === 'string' ? detail : `Ops backend returned ${res.status}`);
  }
  return body as T;
}

export function canReplay(c: PastCase): boolean {
  if (c.source === 'floor') return Boolean(c.input?.replayable && c.input?.source_id);
  if (c.source === 'stress') return c.input?.replayable !== false && typeof c.input?.level === 'number';
  return false;
}

function replayHint(c: PastCase): string {
  if (c.source === 'fixit') return 'Fix-It clips are never stored. Re-film the part in Fix-It Cam to retry it.';
  if (c.source === 'floor' && !canReplay(c)) return 'Live camera frames are not kept, so this run cannot be replayed.';
  if (c.source === 'stress' && !canReplay(c)) return 'Custom audio uploads are not stored, so this run cannot be replayed.';
  return '';
}

/* ------------------------------------------------------------------------------------------- */

interface Props {
  /** Bumped by the parent after each Stress Lab run so the list refreshes. */
  refreshKey: number;
  /** Re-run a Stress Lab level against the current stack. */
  onReplayStress: (level: 1 | 2 | 3, replayOf: string) => Promise<void>;
  stressBusy: boolean;
}

export function PastCasesAndAnalysis({ refreshKey, onReplayStress, stressBusy }: Props) {
  const [cases, setCases] = useState<PastCase[] | null>(null);
  const [counts, setCounts] = useState<Counts | null>(null);
  const [status, setStatus] = useState<AnalysisStatus | null>(null);
  const [offline, setOffline] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<CaseStatus | 'all'>('all');
  const [sourceFilter, setSourceFilter] = useState<CaseSource | 'all'>('all');
  const [areaFilter, setAreaFilter] = useState<CaseArea | 'all'>('all');
  const [openCase, setOpenCase] = useState<PastCase | null>(null);
  const [replaying, setReplaying] = useState<Record<string, string>>({});
  const [replayMsg, setReplayMsg] = useState<string | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [requested, setRequested] = useState(false);
  const [posting, setPosting] = useState(false);
  const mounted = useRef(true);

  const loadCases = useCallback(async () => {
    const qs = new URLSearchParams({ limit: '60' });
    if (statusFilter !== 'all') qs.set('status', statusFilter);
    if (sourceFilter !== 'all') qs.set('source', sourceFilter);
    if (areaFilter !== 'all') qs.set('area', areaFilter);
    try {
      const data = await getJson<{ cases: PastCase[]; counts: Counts }>(`/api/ops/cases?${qs}`);
      if (!mounted.current) return;
      setCases(data.cases);
      setCounts(data.counts);
      setOffline(null);
    } catch (err) {
      if (!mounted.current) return;
      setOffline(err instanceof Error ? err.message : 'Ops backend unreachable');
    }
  }, [statusFilter, sourceFilter, areaFilter]);

  const loadStatus = useCallback(async () => {
    try {
      const data = await getJson<AnalysisStatus>('/api/ops/analysis/latest');
      if (mounted.current) setStatus(data);
    } catch (err) {
      if (mounted.current) setOffline(err instanceof Error ? err.message : 'Ops backend unreachable');
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    void loadCases();
    const t = window.setInterval(loadCases, 15_000);
    return () => window.clearInterval(t);
  }, [loadCases, refreshKey]);

  const running = Boolean(status?.running) || requested || posting;
  useEffect(() => {
    void loadStatus();
    const t = window.setInterval(loadStatus, running ? 3000 : 30_000);
    return () => window.clearInterval(t);
  }, [loadStatus, running, refreshKey]);

  useEffect(() => {
    if (requested && status && !status.running) {
      setRequested(false);
      void loadCases();
    }
  }, [requested, status, loadCases]);

  async function runNow() {
    setRunError(null);
    setPosting(true);
    try {
      const data = await getJson<AnalysisStatus & { started: boolean }>('/api/ops/analysis/run', { method: 'POST' });
      setStatus(data);
      setRequested(data.running);
    } catch (err) {
      setRunError(err instanceof Error ? err.message : 'Could not start the analysis.');
    } finally {
      setPosting(false);
    }
  }

  async function replay(c: PastCase) {
    setReplayMsg(null);
    if (c.source === 'stress') {
      setReplaying((r) => ({ ...r, [c.id]: 'running' }));
      try {
        await onReplayStress(c.input!.level as 1 | 2 | 3, c.id);
        setReplayMsg(`Replayed “${c.title}”. The new run is at the top of the list.`);
      } finally {
        setReplaying((r) => {
          const { [c.id]: _, ...rest } = r;
          return rest;
        });
        void loadCases();
      }
      return;
    }
    try {
      const started = await getJson<{ run_id: string; case_id: string }>(`/api/ops/cases/${c.id}/replay`, { method: 'POST' });
      setReplaying((r) => ({ ...r, [c.id]: started.case_id }));
      setReplayMsg(`Replaying “${c.title}” on the current stack. Results appear here when the clip finishes.`);
      const deadline = Date.now() + 10 * 60_000;
      while (mounted.current && Date.now() < deadline) {
        await new Promise((r) => window.setTimeout(r, 3000));
        try {
          // The case is written when the replay run ends; poll the list (no 404 noise while it runs).
          const recent = await getJson<{ cases: PastCase[] }>('/api/ops/cases?source=floor&limit=20');
          const done = recent.cases.find((x) => x.id === started.case_id);
          if (done) {
            setReplayMsg(`Replay finished: ${STATUS_META[done.status]?.label ?? done.status} · ${done.title}`);
            break;
          }
        } catch {
          /* backend hiccup: keep waiting */
        }
      }
    } catch (err) {
      setReplayMsg(err instanceof Error ? err.message : 'Replay failed.');
    } finally {
      setReplaying((r) => {
        const { [c.id]: _, ...rest } = r;
        return rest;
      });
      void loadCases();
    }
  }

  async function openById(id: string) {
    try {
      setOpenCase(await getJson<PastCase>(`/api/ops/cases/${id}`));
    } catch {
      /* case was pruned */
    }
  }

  const statusChips: Array<{ id: CaseStatus | 'all'; label: string; n?: number }> = [
    { id: 'all', label: 'All', n: counts?.total },
    { id: 'failed', label: 'Failed', n: counts?.status.failed },
    { id: 'timeout', label: 'Timed out', n: counts?.status.timeout },
    { id: 'disagreement', label: 'Models disagree', n: counts?.status.disagreement },
  ];
  const sourceChips: Array<{ id: CaseSource | 'all'; label: string; n?: number }> = [
    { id: 'all', label: 'All sources' },
    { id: 'fixit', label: 'Fix-It', n: counts?.source.fixit },
    { id: 'floor', label: 'Floor', n: counts?.source.floor },
    { id: 'stress', label: 'Stress', n: counts?.source.stress },
  ];
  const areaChips: Array<{ id: CaseArea | 'all'; label: string; n?: number }> = [
    { id: 'all', label: 'All areas' },
    ...(['kitchen', 'front-of-house', 'inventory', 'other'] as CaseArea[]).map((a) => ({
      id: a,
      label: AREA_LABEL[a],
      n: counts?.area?.[a],
    })),
  ];

  return (
    <>
      <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-start">
        <OvernightCard
          status={status}
          offline={offline}
          running={running}
          runError={runError}
          onRun={runNow}
          onOpenCase={openById}
        />

        {/* Past cases */}
        <section className="xl:col-span-7 rounded-xl border border-[#E5E0D8] bg-white overflow-hidden" aria-labelledby="past-cases-title">
          <div className="px-6 py-4 border-b border-[#EFECE6] space-y-3">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 id="past-cases-title" className="font-display text-lg font-semibold text-[#171717]">
                  Past Cases
                </h2>
                <p className="text-xs text-[#737373]">
                  Every Fix-It diagnosis, Floor Monitor run, and Stress Lab run is saved here with each model’s output,
                  latency, and errors. Media is never stored.
                </p>
              </div>
              <button
                type="button"
                onClick={() => void loadCases()}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-[#E5E0D8] bg-white text-[#171717] hover:bg-[#F8F7F4] whitespace-nowrap shrink-0"
              >
                <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
                Refresh
              </button>
            </div>
            <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Filter by outcome">
              {statusChips.map((chip) => (
                <FilterChip key={chip.id} active={statusFilter === chip.id} onClick={() => setStatusFilter(chip.id)} label={chip.label} n={chip.n} />
              ))}
              <span className="mx-1 h-4 w-px bg-[#E5E0D8]" aria-hidden="true" />
              {sourceChips.map((chip) => (
                <FilterChip key={chip.id} active={sourceFilter === chip.id} onClick={() => setSourceFilter(chip.id)} label={chip.label} n={chip.n} />
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Filter by restaurant area">
              {areaChips.map((chip) => (
                <FilterChip key={chip.id} active={areaFilter === chip.id} onClick={() => setAreaFilter(chip.id)} label={chip.label} n={chip.n} />
              ))}
              {Boolean(counts?.domain_miss) && (
                <span className="text-[11px] text-[#8F2411] whitespace-nowrap">· {counts?.domain_miss} off-domain match{counts?.domain_miss === 1 ? '' : 'es'}</span>
              )}
            </div>
            {replayMsg && (
              <p className="rounded-lg border border-[#E5E0D8] bg-[#F8F7F4] px-3 py-2 text-xs text-[#525252]" role="status">
                {replayMsg}
              </p>
            )}
          </div>

          {offline && !cases ? (
            <EmptyState
              title="Ops backend offline"
              body={`Past cases are stored on the restaurant ops backend (RESTO_OPS_BACKEND_URL). ${offline}`}
            />
          ) : cases === null ? (
            <div className="p-10 flex justify-center text-[#737373]">
              <Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" />
            </div>
          ) : cases.length === 0 ? (
            <EmptyState
              title={counts?.total ? 'No cases match these filters.' : 'Case recording is on. No cases yet.'}
              body={
                counts?.total
                  ? 'Try All to see every recorded case.'
                  : 'Run a Stress Lab level, diagnose a part in Fix-It Cam, or monitor a clip in Floor Monitor. Each run lands here automatically and is reviewed by the overnight analysis.'
              }
            />
          ) : (
            <ul className="divide-y divide-[#EFECE6] max-h-[560px] overflow-y-auto">
              {cases.map((c) => {
                const busy = Boolean(replaying[c.id]) || (c.source === 'stress' && stressBusy);
                return (
                  <li key={c.id} className="px-6 py-3 hover:bg-[#F8F7F4]/60">
                    <div className="flex items-start gap-3">
                      <button type="button" onClick={() => setOpenCase(c)} className="flex-1 min-w-0 text-left space-y-1">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <StatusPill status={c.status} />
                          <SourceTag source={c.source} />
                          <AreaTag area={c.area} miss={c.domain_miss} />
                          {c.replay_of && (
                            <span className="text-[11px] text-[#737373] whitespace-nowrap">replay</span>
                          )}
                          <span className="text-[11px] text-[#737373] font-mono-tabular whitespace-nowrap">
                            {formatEt(c.created_ms)} · {latency(c.latency_ms)}
                          </span>
                        </div>
                        <p className="text-sm font-medium text-[#171717] truncate">{c.title}</p>
                        <p className="text-xs text-[#737373] truncate">
                          {Object.keys(c.models ?? {}).join(' · ') || 'No model output'}
                        </p>
                        {c.error && <p className="text-xs text-[#8F2411] line-clamp-2">{c.error}</p>}
                      </button>
                      <button
                        type="button"
                        disabled={!canReplay(c) || busy}
                        onClick={() => void replay(c)}
                        title={canReplay(c) ? 'Re-run this case against the current stack' : replayHint(c)}
                        className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-semibold rounded-lg border border-[#E5E0D8] bg-white text-[#171717] hover:bg-[#EFECE6] disabled:opacity-40 disabled:cursor-not-allowed whitespace-nowrap shrink-0"
                      >
                        {replaying[c.id] ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />}
                        Replay
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>

      {openCase && (
        <CaseDrawer
          c={openCase}
          onClose={() => setOpenCase(null)}
          onReplay={() => void replay(openCase)}
          replayBusy={Boolean(replaying[openCase.id]) || (openCase.source === 'stress' && stressBusy)}
        />
      )}
    </>
  );
}

function FilterChip({ active, onClick, label, n }: { active: boolean; onClick: () => void; label: string; n?: number }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium rounded-full border whitespace-nowrap shrink-0 transition-colors ${
        active ? 'border-[#171717] bg-[#171717] text-white' : 'border-[#E5E0D8] bg-white text-[#525252] hover:bg-[#F8F7F4]'
      }`}
    >
      {label}
      {typeof n === 'number' && <span className={`font-mono-tabular ${active ? 'text-white/70' : 'text-[#A3A3A3]'}`}>{n}</span>}
    </button>
  );
}

function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div className="p-10 text-center space-y-2">
      <FlaskConical className="mx-auto h-6 w-6 text-[#D4CFC6]" aria-hidden="true" />
      <p className="text-sm font-medium text-[#171717]">{title}</p>
      <p className="text-xs text-[#737373] max-w-md mx-auto">{body}</p>
    </div>
  );
}

/* ------------------------------------------------------------------------------------------- */

const REPORT_STATUS: Record<Report['status'], { label: string; cls: string }> = {
  ok: { label: 'Completed', cls: 'border-[#1F6E4A]/25 bg-[#1F6E4A]/8 text-[#1F6E4A]' },
  partial: { label: 'Partial', cls: 'border-[#E0A33A]/40 bg-[#E0A33A]/10 text-[#8A5A12]' },
  failed: { label: 'Failed', cls: 'border-[#C23B22]/30 bg-[#C23B22]/8 text-[#8F2411]' },
  empty: { label: 'No cases', cls: 'border-[#E5E0D8] bg-[#F8F7F4] text-[#525252]' },
  skipped: { label: 'Skipped', cls: 'border-[#E5E0D8] bg-[#F8F7F4] text-[#525252]' },
};

const SEVERITY_CLS: Record<string, string> = {
  high: 'border-[#C23B22]/30 bg-[#C23B22]/8 text-[#8F2411]',
  medium: 'border-[#E0A33A]/40 bg-[#E0A33A]/10 text-[#8A5A12]',
  low: 'border-[#E5E0D8] bg-[#F8F7F4] text-[#525252]',
};

function OvernightCard({
  status,
  offline,
  running,
  runError,
  onRun,
  onOpenCase,
}: {
  status: AnalysisStatus | null;
  offline: string | null;
  running: boolean;
  runError: string | null;
  onRun: () => void;
  onOpenCase: (id: string) => void;
}) {
  const report = status?.latest ?? null;
  const reportMeta = report ? REPORT_STATUS[report.status] ?? REPORT_STATUS.failed : null;
  const enabled = status?.schedule.enabled ?? true;

  return (
    <section
      className="xl:col-span-5 xl:order-last rounded-xl border border-[#E5E0D8] bg-white overflow-hidden"
      aria-labelledby="overnight-title"
    >
      <div className="px-6 py-4 border-b border-[#EFECE6] space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-0.5">
            <h2 id="overnight-title" className="font-display text-lg font-semibold text-[#171717] inline-flex items-center gap-2">
              <Moon className="h-4 w-4 text-[#525252]" aria-hidden="true" />
              Overnight Analysis
            </h2>
            <p className="text-xs text-[#737373]">
              {status ? status.model : 'gemini-4-argon'} reviews the last {status?.window_hours ?? 24} h of past cases,
              groups failures by cause, flags parts that aren’t restaurant or commercial-kitchen relevant, and
              suggests a fix for each.
            </p>
          </div>
          <span
            className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold whitespace-nowrap shrink-0 ${
              offline && !status
                ? 'border-[#C23B22]/30 bg-[#C23B22]/8 text-[#8F2411]'
                : 'border-[#E5E0D8] bg-white text-[#525252]'
            }`}
          >
            <span
              className={`h-2 w-2 rounded-full ${offline && !status ? 'bg-[#C23B22]' : enabled ? 'bg-[#1F6E4A]' : 'bg-[#D4CFC6]'}`}
              aria-hidden="true"
            />
            {offline && !status ? 'Backend offline' : enabled ? 'Scheduled' : 'Schedule off'}
          </span>
        </div>

        <dl className="grid grid-cols-2 gap-2 text-xs">
          <Stat label="Schedule" value={status?.schedule.label ?? 'Nightly at 2:00 AM ET'} />
          <Stat
            label="Next run"
            value={status?.schedule.next_run_ms ? formatEt(status.schedule.next_run_ms) : enabled ? '—' : 'Off'}
            hint={relative(status?.schedule.next_run_ms)}
          />
          <Stat
            label="Last run"
            value={report ? formatEt(report.created_ms) : 'Not run yet'}
            hint={report ? `${report.trigger === 'manual' ? 'manual' : 'nightly'} · ${reportMeta?.label}` : undefined}
          />
          <Stat
            label="Cases analyzed"
            value={report ? `${report.cases_analyzed} of ${report.cases_total}` : '—'}
            hint={`${status?.cases_last_24h ?? 0} in the last 24 h`}
          />
        </dl>

        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-[11px] text-[#737373]">
            Thinking {status?.thinking_level ?? 'HIGH'} · batches of {status?.batch_size ?? 40} · max {status?.max_calls ?? 6} calls
            per run{status && !status.gemini_ready ? ' · GEMINI_API_KEY missing on backend' : ''}
          </p>
          <button
            type="button"
            onClick={onRun}
            disabled={running || (Boolean(offline) && !status)}
            className="inline-flex items-center gap-2 px-3.5 py-2 text-xs font-semibold rounded-lg bg-[#C23B22] text-white hover:bg-[#A6311B] disabled:opacity-50 transition-colors whitespace-nowrap shrink-0"
          >
            {running ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <Play className="h-3.5 w-3.5" aria-hidden="true" />}
            {running ? 'Analyzing…' : 'Run analysis now'}
          </button>
        </div>
        {runError && (
          <p role="alert" className="rounded-lg border border-[#C23B22]/30 bg-[#C23B22]/8 px-3 py-2 text-xs text-[#8F2411]">
            {runError}
          </p>
        )}
        {status?.known_issues && status.known_issues.length > 0 && (
          <details className="rounded-lg border border-[#EFECE6] bg-[#F8F7F4]/60 px-3 py-2 text-xs">
            <summary className="cursor-pointer font-medium text-[#171717]">
              Known issues the review checks against ({status.known_issues.length})
            </summary>
            <ul className="mt-2 space-y-1 text-[#525252]">
              {status.known_issues.map((k) => (
                <li key={k.issue}>
                  <span className="font-medium text-[#171717]">{SOURCE_LABEL[k.source as CaseSource] ?? k.source}:</span> {k.issue}
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>

      {!report ? (
        <div className="p-8 text-center space-y-2">
          <Moon className="mx-auto h-6 w-6 text-[#D4CFC6]" aria-hidden="true" />
          <p className="text-sm font-medium text-[#171717]">
            {offline && !status ? 'Waiting for the ops backend' : 'No report yet'}
          </p>
          <p className="text-xs text-[#737373] max-w-sm mx-auto">
            {offline && !status
              ? 'The nightly job runs on the restaurant ops backend. Start it, then this card shows its schedule and reports.'
              : `The first nightly review runs ${formatEt(status?.schedule.next_run_ms)}. Use “Run analysis now” to get a report right away.`}
          </p>
        </div>
      ) : (
        <div className="px-6 py-4 space-y-4 max-h-[560px] overflow-y-auto">
          <div className="space-y-1.5">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className={`inline-flex rounded-full border px-2 py-0.5 text-[11px] font-semibold ${reportMeta?.cls}`}>
                {reportMeta?.label}
              </span>
              <span className="text-[11px] text-[#737373] font-mono-tabular">
                {report.model} · {report.calls} call{report.calls === 1 ? '' : 's'} · {latency(report.duration_ms)}
              </span>
            </div>
            <p className="text-sm text-[#2E2E2E] leading-relaxed">{report.summary}</p>
            {report.errors?.map((e) => (
              <p key={e} className="text-xs text-[#8F2411]">
                {e}
              </p>
            ))}
          </div>

          {report.groups.length > 0 && (
            <div className="space-y-2">
              <h3 className="text-xs font-semibold tracking-wide text-[#525252] uppercase">Failures by cause</h3>
              <ol className="space-y-2">
                {report.groups.map((g) => (
                  <li key={g.cause} className="rounded-lg border border-[#EFECE6] bg-[#F8F7F4]/60 p-3 space-y-1.5">
                    <div className="flex items-start justify-between gap-2">
                      <p className="text-sm font-semibold text-[#171717]">{g.cause}</p>
                      <span className={`inline-flex rounded-full border px-2 py-0.5 text-[11px] font-semibold capitalize whitespace-nowrap shrink-0 ${SEVERITY_CLS[g.severity] ?? SEVERITY_CLS.low}`}>
                        {g.severity}
                      </span>
                    </div>
                    <p className="text-xs text-[#525252] leading-relaxed">
                      <span className="font-semibold text-[#171717]">Fix: </span>
                      {g.suggested_fix}
                    </p>
                    <div className="flex flex-wrap items-center gap-1">
                      <span className="text-[11px] text-[#737373]">
                        {g.count ?? g.case_ids.length} case{(g.count ?? g.case_ids.length) === 1 ? '' : 's'}
                        {g.sources?.length ? ` · ${g.sources.map((s) => SOURCE_LABEL[s as CaseSource] ?? s).join(', ')}` : ''}:
                      </span>
                      {g.case_ids.slice(0, 6).map((id) => (
                        <button
                          key={id}
                          type="button"
                          onClick={() => onOpenCase(id)}
                          className="rounded-md border border-[#E5E0D8] bg-white px-1.5 py-0.5 text-[11px] font-mono-tabular text-[#525252] hover:bg-[#EFECE6]"
                        >
                          {id.slice(0, 14)}
                        </button>
                      ))}
                    </div>
                  </li>
                ))}
              </ol>
            </div>
          )}

          {report.regression_tests.length > 0 && (
            <div className="space-y-2">
              <h3 className="text-xs font-semibold tracking-wide text-[#525252] uppercase">Add as regression tests</h3>
              <ul className="space-y-1.5">
                {report.regression_tests.map((r) => (
                  <li key={r.case_id}>
                    <button
                      type="button"
                      onClick={() => onOpenCase(r.case_id)}
                      className="w-full text-left rounded-lg border border-[#EFECE6] px-3 py-2 hover:bg-[#F8F7F4] space-y-0.5"
                    >
                      <p className="text-xs font-medium text-[#171717] truncate">
                        {r.title ?? r.case_id}
                        {r.source && <span className="text-[#737373] font-normal"> · {SOURCE_LABEL[r.source as CaseSource] ?? r.source}</span>}
                      </p>
                      <p className="text-[11px] text-[#525252]">{r.reason}</p>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg border border-[#EFECE6] bg-[#F8F7F4] px-3 py-2">
      <dt className="text-[11px] text-[#737373]">{label}</dt>
      <dd className="text-xs font-semibold text-[#171717] font-mono-tabular">{value}</dd>
      {hint && <dd className="text-[11px] text-[#737373]">{hint}</dd>}
    </div>
  );
}

/* ------------------------------------------------------------------------------------------- */

function CaseDrawer({ c, onClose, onReplay, replayBusy }: { c: PastCase; onClose: () => void; onReplay: () => void; replayBusy: boolean }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const input = useMemo(() => Object.entries(c.input ?? {}).filter(([k]) => k !== 'replayable'), [c]);

  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" aria-labelledby="case-drawer-title">
      <button type="button" aria-label="Close case details" className="absolute inset-0 bg-[#171717]/30" onClick={onClose} />
      <aside className="relative h-full w-full max-w-xl overflow-y-auto bg-white border-l border-[#E5E0D8] shadow-xl">
        <div className="sticky top-0 bg-white border-b border-[#EFECE6] px-6 py-4 flex items-start justify-between gap-3">
          <div className="space-y-1 min-w-0">
            <div className="flex flex-wrap items-center gap-1.5">
              <StatusPill status={c.status} />
              <SourceTag source={c.source} />
              <AreaTag area={c.area} miss={c.domain_miss} />
            </div>
            <h2 id="case-drawer-title" className="font-display text-lg font-semibold text-[#171717] break-words">
              {c.title}
            </h2>
            <p className="text-xs text-[#737373] font-mono-tabular">
              {formatEt(c.created_ms)} · {latency(c.latency_ms)} · {c.id}
            </p>
          </div>
          <button type="button" onClick={onClose} className="p-1.5 rounded-lg hover:bg-[#F8F7F4]" aria-label="Close">
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>

        <div className="px-6 py-4 space-y-5 text-xs">
          {c.error && (
            <div className="rounded-lg border border-[#C23B22]/30 bg-[#C23B22]/8 p-3 text-[#8F2411] flex gap-2">
              <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
              <span>{c.error}</span>
            </div>
          )}

          <div className="flex items-center justify-between gap-3">
            <p className="text-[#737373]">{canReplay(c) ? 'Re-run this case against the current models and settings.' : replayHint(c)}</p>
            <button
              type="button"
              disabled={!canReplay(c) || replayBusy}
              onClick={onReplay}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg bg-[#C23B22] text-white hover:bg-[#A6311B] disabled:opacity-40 whitespace-nowrap shrink-0"
            >
              {replayBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />}
              Replay
            </button>
          </div>

          <section className="space-y-1.5">
            <h3 className="font-semibold text-[#525252] uppercase tracking-wide">Input</h3>
            <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1">
              {input.map(([k, v]) => (
                <div key={k} className="contents">
                  <dt className="text-[#737373]">{k.replace(/_/g, ' ')}</dt>
                  <dd className="text-[#171717] font-mono-tabular break-all">{String(v ?? '—')}</dd>
                </div>
              ))}
              {c.replay_of && (
                <div className="contents">
                  <dt className="text-[#737373]">replay of</dt>
                  <dd className="text-[#171717] font-mono-tabular">{c.replay_of}</dd>
                </div>
              )}
            </dl>
          </section>

          {c.disagreements && c.disagreements.length > 0 && (
            <section className="space-y-1.5">
              <h3 className="font-semibold text-[#525252] uppercase tracking-wide">Where the models disagreed</h3>
              <ul className="space-y-1">
                {c.disagreements.map((d) => (
                  <li key={d.at_ms} className="font-mono-tabular text-[#171717]">
                    {(d.at_ms / 1000).toFixed(1)} s: observer {d.observer.join('–')} vs verifier {d.verifier.join('–')}
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section className="space-y-2">
            <h3 className="font-semibold text-[#525252] uppercase tracking-wide">Model outputs</h3>
            {Object.entries(c.models ?? {}).length === 0 && <p className="text-[#737373]">No model output was recorded.</p>}
            {Object.entries(c.models ?? {}).map(([model, output]) => (
              <div key={model} className="rounded-lg border border-[#EFECE6]">
                <p className="px-3 py-2 border-b border-[#EFECE6] bg-[#F8F7F4] font-semibold text-[#171717]">{model}</p>
                <pre className="px-3 py-2 overflow-x-auto whitespace-pre-wrap break-words text-[11px] leading-relaxed text-[#2E2E2E] font-mono-tabular">
                  {JSON.stringify(output, null, 2)}
                </pre>
              </div>
            ))}
          </section>

          {c.errors && c.errors.length > 0 && (
            <section className="space-y-1.5">
              <h3 className="font-semibold text-[#525252] uppercase tracking-wide">Errors</h3>
              <ul className="space-y-1">
                {c.errors.map((e, i) => (
                  <li key={i} className="text-[#8F2411]">
                    {e.at_ms != null ? `${(e.at_ms / 1000).toFixed(1)} s · ` : ''}
                    {e.phase ? `${e.phase} · ` : ''}
                    {e.code}: {e.message}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      </aside>
    </div>
  );
}
