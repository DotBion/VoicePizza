import {
  AlertTriangle,
  CheckCircle2,
  Mic,
  RefreshCw,
  ShieldCheck,
  Volume2,
  VolumeX,
} from 'lucide-react';
import {
  AUDIO_METER_THRESHOLDS,
  classifyInputVolume,
  type InputVolumeState,
} from '../shared/audioMath';

interface AudioMeterProps {
  active: boolean;
  sourceLabel: string;
  level: number;
  peak: number;
  dbfs: number;
  sustainedLoudMs: number;
  ambientFloor: number;
  voiceThreshold: number;
  calibrating: boolean;
  gateOpen: boolean;
  noiseGateEnabled: boolean;
  isMonitoring: boolean;
  disableMonitorToggle?: boolean;
  onToggleMonitor: () => void;
  onToggleNoiseGate: () => void;
  onRecalibrateNoiseFloor: () => void;
}

const TOTAL_SEGMENTS = 24;

function getSegmentColor(index: number, lit: boolean, active: boolean): string {
  const threshold = (index + 1) / TOTAL_SEGMENTS;
  if (!lit) {
    return active ? 'bg-[#E5E0D8]' : 'bg-[#EAE6DF]';
  }
  if (threshold > AUDIO_METER_THRESHOLDS.CLIPPING_MIN) {
    return 'bg-[#C23B22]';
  }
  if (threshold > AUDIO_METER_THRESHOLDS.LOUD_MIN) {
    return 'bg-[#B45309]';
  }
  if (threshold >= AUDIO_METER_THRESHOLDS.QUIET_MAX) {
    return 'bg-[#1F6E4A]';
  }
  return 'bg-[#737373]';
}

function getStateTone(state: InputVolumeState): {
  textClass: string;
  borderClass: string;
  icon: typeof Mic;
} {
  switch (state) {
    case 'voice_detected':
      return {
        textClass: 'text-[#1F6E4A]',
        borderClass: 'border-[#1F6E4A]/35',
        icon: CheckCircle2,
      };
    case 'too_loud':
      return {
        textClass: 'text-[#B45309]',
        borderClass: 'border-[#B45309]/45',
        icon: AlertTriangle,
      };
    case 'clipping':
      return {
        textClass: 'text-[#C23B22]',
        borderClass: 'border-[#C23B22]/45',
        icon: AlertTriangle,
      };
    case 'too_quiet':
      return {
        textClass: 'text-[#525252]',
        borderClass: 'border-[#E5E0D8]',
        icon: VolumeX,
      };
    case 'standby':
    default:
      return {
        textClass: 'text-[#525252]',
        borderClass: 'border-[#E5E0D8]',
        icon: Volume2,
      };
  }
}

export function AudioMeter({
  active,
  sourceLabel,
  level,
  peak,
  dbfs,
  sustainedLoudMs,
  ambientFloor,
  voiceThreshold,
  calibrating,
  gateOpen,
  noiseGateEnabled,
  isMonitoring,
  disableMonitorToggle = false,
  onToggleMonitor,
  onToggleNoiseGate,
  onRecalibrateNoiseFloor,
}: AudioMeterProps) {
  const classification = classifyInputVolume({
    active,
    level,
    peak,
    sustainedLoudMs,
    ambientFloor,
    voiceThreshold: noiseGateEnabled ? voiceThreshold : AUDIO_METER_THRESHOLDS.QUIET_MAX,
    calibrating: active && noiseGateEnabled && calibrating,
    gateOpen: active ? (noiseGateEnabled ? gateOpen : undefined) : false,
    noiseGateEnabled,
  });

  const tone = getStateTone(classification.state);
  const StateIcon = tone.icon;

  const levelPct = Math.round(Math.max(0, Math.min(1, level)) * 100);
  const peakPct = Math.round(Math.max(0, Math.min(1, peak)) * 100);
  const floorPct = Math.round(Math.max(0, Math.min(1, ambientFloor)) * 100);
  const gatePct = Math.round(Math.max(0, Math.min(1, voiceThreshold)) * 100);
  const litCount = active ? Math.round(level * TOTAL_SEGMENTS) : 0;
  const gateAttr = !noiseGateEnabled
    ? 'bypassed'
    : !active
      ? 'standby'
      : calibrating
        ? 'calibrating'
        : gateOpen
          ? 'open'
          : 'closed';

  return (
    <div
      data-testid="audio-meter"
      data-state={classification.state}
      data-gate={gateAttr}
      className={`rounded-lg border bg-[#F8F7F4] p-4 space-y-3 transition-colors ${tone.borderClass}`}
    >
      {/* Top Status & Controls Row */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <StateIcon className={`h-4 w-4 shrink-0 ${tone.textClass}`} aria-hidden="true" />
          <span className={`font-semibold ${tone.textClass}`}>{classification.label}</span>
          <span className="text-[#A3A3A3]" aria-hidden="true">
            ·
          </span>
          <span className="text-[#525252]">{sourceLabel}</span>
        </div>

        <div className="flex flex-wrap items-center gap-2 text-xs">
          <div className="font-mono-tabular text-[#525252] flex items-center gap-2 whitespace-nowrap mr-1">
            <span>{active ? `${dbfs} dBFS` : '-- dBFS'}</span>
            <span className="text-[#A3A3A3]" aria-hidden="true">
              ·
            </span>
            <span className="font-semibold text-[#171717]">{active ? `${levelPct}%` : '0%'}</span>
            <span className="text-[#A3A3A3]" aria-hidden="true">
              ·
            </span>
            <span>Peak {active ? `${peakPct}%` : '0%'}</span>
          </div>

          <button
            type="button"
            onClick={onToggleNoiseGate}
            aria-pressed={noiseGateEnabled}
            className={`inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-semibold rounded-md border transition-colors whitespace-nowrap shrink-0 ${
              noiseGateEnabled
                ? 'border-[#1F6E4A]/40 bg-[#1F6E4A]/10 text-[#1F6E4A] hover:bg-[#1F6E4A]/15'
                : 'border-[#E5E0D8] bg-white text-[#525252] hover:bg-[#EFECE6]'
            }`}
          >
            <ShieldCheck className="h-3 w-3" aria-hidden="true" />
            {noiseGateEnabled ? 'Auto Gate: On' : 'Auto Gate: Off'}
          </button>

          {active && noiseGateEnabled && (
            <button
              type="button"
              onClick={onRecalibrateNoiseFloor}
              className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium rounded-md border border-[#E5E0D8] bg-white text-[#171717] hover:bg-[#EFECE6] transition-colors whitespace-nowrap shrink-0"
            >
              <RefreshCw className="h-3 w-3" aria-hidden="true" />
              Recalibrate
            </button>
          )}

          <button
            type="button"
            onClick={onToggleMonitor}
            disabled={disableMonitorToggle}
            aria-pressed={isMonitoring}
            className={`inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-semibold rounded-md border transition-colors whitespace-nowrap shrink-0 disabled:opacity-45 ${
              isMonitoring
                ? 'border-[#171717] bg-[#171717] text-white hover:bg-[#2E2E2E]'
                : 'border-[#E5E0D8] bg-white text-[#171717] hover:bg-[#EFECE6]'
            }`}
          >
            <Mic className="h-3 w-3" aria-hidden="true" />
            {isMonitoring ? 'Stop Mic Test' : 'Test Mic'}
          </button>
        </div>
      </div>

      {/* Segmented 24-Bar Acoustic Meter with Dynamic Floor & Voice Gate Marker */}
      <div className="space-y-1.5">
        <div
          role="meter"
          aria-label="Real-time microphone input volume"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={active ? levelPct : 0}
          aria-valuetext={`${classification.label}, ${active ? `${levelPct}% (${dbfs} dBFS)` : 'standby'}`}
          className="relative flex items-center gap-1 h-5"
        >
          {Array.from({ length: TOTAL_SEGMENTS }).map((_, idx) => {
            const lit = idx < litCount;
            return (
              <div
                key={idx}
                className={`flex-1 h-full rounded-[2px] transition-colors duration-75 ${getSegmentColor(
                  idx,
                  lit,
                  active
                )}`}
              />
            );
          })}

          {/* Dynamic Voice Gate Threshold Marker */}
          {noiseGateEnabled && gatePct > 0 && (
            <div
              aria-hidden="true"
              title={`Dynamic voice gate threshold (${gatePct}%)`}
              className="pointer-events-none absolute -top-0.5 -bottom-0.5 w-0.5 bg-[#C23B22]"
              style={{ left: `calc(${Math.min(98, gatePct)}% - 1px)` }}
            />
          )}

          {/* Peak Hold Indicator */}
          {active && peakPct > 2 && (
            <div
              aria-hidden="true"
              className="pointer-events-none absolute top-0 bottom-0 w-0.5 bg-[#171717]"
              style={{ left: `calc(${Math.min(99, peakPct)}% - 1px)` }}
            />
          )}
        </div>

        {/* Dynamic Threshold & Zone Guide */}
        <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-[#737373] font-mono-tabular">
          <span>
            {noiseGateEnabled
              ? active
                ? `Noise Floor ${floorPct}% · Voice Gate ${gatePct}%`
                : `Auto Noise Gate Ready · Default ${gatePct}%`
              : 'Fixed Voice Window (8–72%)'}
          </span>
          <span>
            <span className="text-[#1F6E4A] font-medium">Voice Zone</span>
            <span aria-hidden="true"> · </span>
            <span className="text-[#B45309] font-medium">Overload (&gt;72%)</span>
            <span aria-hidden="true"> · </span>
            <span className="text-[#C23B22] font-medium">Clip</span>
          </span>
        </div>
      </div>

      {/* Staff Guidance Line */}
      <p className="text-xs text-[#525252] leading-snug">{classification.hint}</p>
    </div>
  );
}
