import { fixitBackendUrl } from './fixitProxy';
import { restoOpsBackendUrl } from './opsProxy';

/**
 * Records "past cases" on the resto-ops backend (durable SQLite, nightly Gemini 4 Argon review).
 * AI Studio's filesystem is ephemeral and it cannot run cron, so storage and the overnight job live
 * on the ops backend; this server only reports what happened. Fire-and-forget: a recording failure
 * never affects the user-facing request. Only references to inputs are sent, never media.
 */
export type CaseStatus = 'ok' | 'failed' | 'timeout' | 'disagreement';

export type CaseArea = 'kitchen' | 'front-of-house' | 'inventory' | 'other';

export interface NewCase {
  source: 'fixit' | 'stress';
  status: CaseStatus;
  title: string;
  area?: CaseArea;
  domain_miss?: boolean;
  input?: Record<string, unknown>;
  models?: Record<string, unknown>;
  latency_ms?: number | null;
  error?: string | null;
  replay_of?: string | null;
}

const TIMEOUT_RE = /time(d)?\s?out|deadline|did not respond|ETIMEDOUT|aborted/i;

export function statusForError(message: string): CaseStatus {
  return TIMEOUT_RE.test(message) ? 'timeout' : 'failed';
}

export async function recordCase(entry: NewCase): Promise<void> {
  const body = {
    ...entry,
    title: entry.title.slice(0, 160),
    error: entry.error ? entry.error.slice(0, 2000) : entry.error,
    latency_ms: entry.latency_ms == null ? null : Math.max(0, Math.round(entry.latency_ms)),
  };
  try {
    const res = await fetch(`${restoOpsBackendUrl()}/api/cases`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) console.warn(`[cases] backend refused case (${res.status})`);
  } catch (err) {
    console.warn('[cases] could not record case:', err instanceof Error ? err.message : err);
  }
}

/*
 * Fix-It Cam is used by restaurant staff across the kitchen, dining room and stockroom. Cases are tagged
 * with the area and flagged when the diagnosis or Shop match is consumer / off-domain, so Stress Lab and
 * the overnight review can filter them. Keyword heuristics only; the nightly Argon review re-judges them.
 */
const AREA_WORDS: Array<[CaseArea, RegExp]> = [
  [
    'kitchen',
    /\b(mixer|slicer|oven|fryer|grill|griddle|range|burner|dish ?(washer|machine)|refrigerat\w*|fridge|freezer|cooler|walk-in|ice (machine|maker)|espresso|coffee|brewer|blender|food processor|toaster|microwave|steamer|kettle|hood|thermostat|compressor|gasket|faucet|aerator|sink|drain|disposal|sprayer|prep table|knife|pan|pot|ladle|tongs?|whisk|cutting board|scale|smallwares?|range hood|salamander|proofer|warmer|heat lamp)\b/i,
  ],
  [
    'front-of-house',
    /\b(chair|table ?top|table|booth|stool|bar ?stool|light|bulb|lamp|fixture|sconce|door|pos|register|terminal|menu|display|sign|speaker|high ?chair|toilet|urinal|hand dryer|soap|dispenser|window|blind|host stand|tray|cup holder|napkin)\b/i,
  ],
  ['inventory', /\b(shel(f|ves|ving)|rack|bin|container|cart|dolly|storage|label|pallet|crate|lid|cambro|hotel pan|dunnage)\b/i],
];
const OFF_DOMAIN = /\b(boat|marine|outboard|car|automotive|auto part|brake|bicycle|bike|motorcycle|scooter|drill|dewalt|makita|ryobi|power tool|lawn|mower|guitar|toy|phone case|laptop|aquarium)\b/i;

export function classifyFixIt(texts: Array<string | undefined | null>): { area: CaseArea; domain_miss: boolean } {
  const text = texts.filter(Boolean).join(' · ');
  const area = AREA_WORDS.find(([, re]) => re.test(text))?.[0] ?? 'other';
  return { area, domain_miss: OFF_DOMAIN.test(text) };
}

let fixitModels: { at: number; value: Record<string, string> } | null = null;

/** Model names the Fix-It backend reports (cached 10 min); falls back to the documented defaults. */
export async function fixitModelNames(): Promise<Record<string, string>> {
  if (fixitModels && Date.now() - fixitModels.at < 600_000) return fixitModels.value;
  const fallback = { identify: 'gemini-4-hydrogen', rank: 'gemini-4-argon', gate: 'gemini-decision-1' };
  try {
    const res = await fetch(`${fixitBackendUrl()}/api/health`, { signal: AbortSignal.timeout(4000) });
    const j = (await res.json()) as { identify_model?: string; rank_model?: string; gate_model?: string };
    const value = {
      identify: j.identify_model || fallback.identify,
      rank: j.rank_model || fallback.rank,
      gate: j.gate_model || fallback.gate,
    };
    fixitModels = { at: Date.now(), value };
    return value;
  } catch {
    return fallback;
  }
}

interface FixItEventLite {
  event?: string;
  diagnosis?: {
    item?: string;
    broken_part?: string;
    replace?: string;
    confidence?: number;
    uncertainties?: string[];
  };
  top?: Array<{ title?: string; fit?: number; reason?: string; check?: string; price_minor?: number | null }>;
  considered?: number;
  timings?: Record<string, number>;
  message?: string;
}

/** Turn the NDJSON events of one Fix-It analysis into a case and record it. */
export async function recordFixItCase(opts: {
  events: FixItEventLite[];
  clip: string;
  bytes: number | null;
  startedMs: number;
  transportError?: string | null;
  httpStatus?: number;
}) {
  const { events, clip, bytes, startedMs } = opts;
  const diagnosis = [...events].reverse().find((e) => e.event === 'diagnosis')?.diagnosis;
  const results = [...events].reverse().find((e) => e.event === 'results');
  const errorEv = events.find((e) => e.event === 'error');
  const error =
    opts.transportError ||
    errorEv?.message ||
    (opts.httpStatus && opts.httpStatus !== 200 ? `Fix-It backend returned HTTP ${opts.httpStatus}` : null);
  const top = results?.top || [];
  const confidence = typeof diagnosis?.confidence === 'number' ? diagnosis.confidence : null;
  let status: CaseStatus = 'ok';
  let note: string | null = null;
  if (error) status = statusForError(error);
  else if (!diagnosis) {
    status = 'failed';
    note = 'No diagnosis was returned.';
  } else if (confidence !== null && confidence < 0.4) {
    status = 'failed';
    note = `Low-confidence diagnosis (${Math.round(confidence * 100)}%).`;
  } else if (!top.length) {
    status = 'failed';
    note = 'No replacement part passed the fit check.';
  } else if (typeof top[0].fit === 'number' && top[0].fit < 0.5) {
    // The ranking model put a product first that the Decisions API scored as a poor fit.
    status = 'disagreement';
    note = `Top-ranked part has a low fit score (${Math.round(top[0].fit * 100)}%).`;
  }
  const names = await fixitModelNames();
  const timings = results?.timings || [...events].reverse().find((e) => e.timings)?.timings || {};
  const part = diagnosis?.broken_part || diagnosis?.replace;
  const fromDiagnosis = classifyFixIt([diagnosis?.item, diagnosis?.broken_part, diagnosis?.replace]);
  const fromProducts = classifyFixIt(top.slice(0, 3).map((p) => p.title));
  const area = fromDiagnosis.area !== 'other' ? fromDiagnosis.area : fromProducts.area;
  const domainMiss = fromDiagnosis.domain_miss || fromProducts.domain_miss;
  if (domainMiss && status === 'ok') {
    note = 'Diagnosis or Shop match is not restaurant / commercial-kitchen relevant.';
  }
  await recordCase({
    source: 'fixit',
    status,
    area,
    domain_miss: domainMiss,
    title: `${diagnosis?.item || 'Unknown item'}${part ? ` · ${part}` : ''}`,
    input: { clip, bytes, replayable: false },
    models: {
      [names.identify]: {
        role: 'diagnosis',
        item: diagnosis?.item,
        broken_part: diagnosis?.broken_part,
        replace: diagnosis?.replace,
        confidence,
        uncertainties: diagnosis?.uncertainties?.slice(0, 6),
        seconds: timings.diagnose_s,
      },
      [`${names.gate} (fit check)`]: { role: 'Shop product fit', considered: results?.considered ?? null, seconds: timings.gate_s },
      [`${names.rank} (ranking)`]: {
        role: 'top-3 ranking',
        top: top.slice(0, 3).map((p) => ({ title: p.title, fit: p.fit, reason: p.reason })),
        seconds: timings.rank_s,
      },
    },
    latency_ms: typeof timings.total_s === 'number' ? timings.total_s * 1000 : Date.now() - startedMs,
    error: error || note,
  });
}
