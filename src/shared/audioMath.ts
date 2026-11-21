export const AUDIO_METER_THRESHOLDS = {
  QUIET_MAX: 0.08,
  LOUD_MIN: 0.72,
  CLIPPING_MIN: 0.92,
  SUSTAINED_NOISE_MS: 650,
} as const;

export const NOISE_GATE_DEFAULTS = {
  CALIBRATION_MS: 750,
  HANGOVER_MS: 450,
  MIN_SPEECH_TURN_MS: 240,
  MIN_FLOOR: 0.02,
  MAX_FLOOR: 0.65,
  SNR_MULTIPLIER: 1.45,
  SNR_OFFSET: 0.07,
  HYSTERESIS_MULTIPLIER: 1.2,
  HYSTERESIS_OFFSET: 0.04,
} as const;

export type InputVolumeState =
  | 'standby'
  | 'too_quiet'
  | 'voice_detected'
  | 'too_loud'
  | 'clipping';

export interface AudioFrameMetrics {
  level: number;
  rms: number;
  peak: number;
  dbfs: number;
}

export interface InputVolumeClassification {
  state: InputVolumeState;
  label: string;
  hint: string;
}

export interface NoiseGateState {
  calibrating: boolean;
  calibratedMs: number;
  calibrationLevels: number[];
  noiseFloor: number;
  openThreshold: number;
  closeThreshold: number;
  gateOpen: boolean;
  hangoverRemainingMs: number;
  speechActiveMs: number;
  peakHold: number;
  sustainedLoudMs: number;
}

export interface NoiseGateFrameResult {
  nextState: NoiseGateState;
  metrics: AudioFrameMetrics;
  gateOpen: boolean;
  justOpened: boolean;
  justClosedWithSpeech: boolean;
  shouldStreamToLive: boolean;
}

export function downsampleFloat32(
  samples: Float32Array,
  inputSampleRate: number,
  targetSampleRate = 16000
): Float32Array {
  if (samples.length === 0 || inputSampleRate <= 0 || targetSampleRate <= 0) {
    return new Float32Array(0);
  }
  if (inputSampleRate === targetSampleRate) {
    return samples;
  }

  const ratio = inputSampleRate / targetSampleRate;
  const outputLength = Math.max(1, Math.floor(samples.length / ratio));
  const output = new Float32Array(outputLength);

  for (let i = 0; i < outputLength; i++) {
    const srcPos = i * ratio;
    const idx0 = Math.floor(srcPos);
    const idx1 = Math.min(idx0 + 1, samples.length - 1);
    const frac = srcPos - idx0;
    output[i] = samples[idx0] * (1 - frac) + samples[idx1] * frac;
  }

  return output;
}

export function computeRmsLevel(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    sum += samples[i] * samples[i];
  }
  const rms = Math.sqrt(sum / samples.length);
  return Math.min(1, Number((rms * 4).toFixed(3)));
}

export function analyzeAudioFrame(samples: Float32Array): AudioFrameMetrics {
  if (samples.length === 0) {
    return { level: 0, rms: 0, peak: 0, dbfs: -60 };
  }

  let sum = 0;
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const val = samples[i];
    const abs = val < 0 ? -val : val;
    if (abs > peak) peak = abs;
    sum += val * val;
  }

  const rms = Math.sqrt(sum / samples.length);
  const level = Math.min(1, Number((rms * 4).toFixed(3)));
  const clampedPeak = Math.min(1, Number(peak.toFixed(3)));
  const dbfs =
    rms <= 0.001
      ? -60
      : Math.max(-60, Math.min(0, Math.round(20 * Math.log10(rms)))) || 0;

  return {
    level,
    rms: Number(rms.toFixed(4)),
    peak: clampedPeak,
    dbfs,
  };
}

export function computeDynamicThresholds(noiseFloor: number): {
  noiseFloor: number;
  openThreshold: number;
  closeThreshold: number;
} {
  const clampedFloor = Math.min(
    NOISE_GATE_DEFAULTS.MAX_FLOOR,
    Math.max(NOISE_GATE_DEFAULTS.MIN_FLOOR, noiseFloor)
  );
  const openThreshold = Math.min(
    0.85,
    Math.max(
      AUDIO_METER_THRESHOLDS.QUIET_MAX,
      Number(
        (
          clampedFloor * NOISE_GATE_DEFAULTS.SNR_MULTIPLIER +
          NOISE_GATE_DEFAULTS.SNR_OFFSET
        ).toFixed(3)
      )
    )
  );
  const closeThreshold = Math.min(
    Math.max(0.05, openThreshold - 0.04),
    Math.max(
      0.05,
      Number(
        (
          clampedFloor * NOISE_GATE_DEFAULTS.HYSTERESIS_MULTIPLIER +
          NOISE_GATE_DEFAULTS.HYSTERESIS_OFFSET
        ).toFixed(3)
      )
    )
  );

  return {
    noiseFloor: Number(clampedFloor.toFixed(3)),
    openThreshold,
    closeThreshold,
  };
}

export function createNoiseGateState(): NoiseGateState {
  const initial = computeDynamicThresholds(0.04);
  return {
    calibrating: true,
    calibratedMs: 0,
    calibrationLevels: [],
    noiseFloor: initial.noiseFloor,
    openThreshold: initial.openThreshold,
    closeThreshold: initial.closeThreshold,
    gateOpen: false,
    hangoverRemainingMs: 0,
    speechActiveMs: 0,
    peakHold: 0,
    sustainedLoudMs: 0,
  };
}

export function processNoiseGateFrame(
  prevState: NoiseGateState,
  samples: Float32Array,
  sampleRate: number,
  options?: {
    enabled?: boolean;
    calibrationMs?: number;
    hangoverMs?: number;
    minSpeechTurnMs?: number;
  }
): NoiseGateFrameResult {
  const enabled = options?.enabled ?? true;
  const calibrationMs = options?.calibrationMs ?? NOISE_GATE_DEFAULTS.CALIBRATION_MS;
  const hangoverMs = options?.hangoverMs ?? NOISE_GATE_DEFAULTS.HANGOVER_MS;
  const minSpeechTurnMs = options?.minSpeechTurnMs ?? NOISE_GATE_DEFAULTS.MIN_SPEECH_TURN_MS;

  const metrics = analyzeAudioFrame(samples);
  const frameDurationMs = Math.max(
    1,
    Math.round((samples.length / Math.max(1, sampleRate)) * 1000)
  );

  const peakHold = Number(Math.max(metrics.peak, prevState.peakHold * 0.86).toFixed(3));
  const sustainedLoudMs =
    metrics.level >= AUDIO_METER_THRESHOLDS.LOUD_MIN
      ? Math.min(2500, prevState.sustainedLoudMs + frameDurationMs)
      : Math.max(0, prevState.sustainedLoudMs - Math.round(frameDurationMs * 1.5));

  // If gating is bypassed, track thresholds passively but stream continuously
  if (!enabled) {
    const thresholds = computeDynamicThresholds(prevState.noiseFloor);
    const nextState: NoiseGateState = {
      ...prevState,
      calibrating: false,
      noiseFloor: thresholds.noiseFloor,
      openThreshold: thresholds.openThreshold,
      closeThreshold: thresholds.closeThreshold,
      gateOpen: metrics.level >= AUDIO_METER_THRESHOLDS.QUIET_MAX,
      hangoverRemainingMs: 0,
      speechActiveMs: 0,
      peakHold,
      sustainedLoudMs,
    };
    return {
      nextState,
      metrics,
      gateOpen: true,
      justOpened: !prevState.gateOpen,
      justClosedWithSpeech: false,
      shouldStreamToLive: true,
    };
  }

  // Phase 1: Initial automatic ambient calibration window
  if (prevState.calibrating) {
    const calibrationLevels = [...prevState.calibrationLevels, metrics.level];
    const calibratedMs = prevState.calibratedMs + frameDurationMs;

    // Track 40th percentile so brief incidental bursts don't bias the steady-state floor
    const sorted = [...calibrationLevels].sort((a, b) => a - b);
    const pctIndex = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.4));
    const estimatedFloor = sorted[pctIndex] ?? prevState.noiseFloor;
    const thresholds = computeDynamicThresholds(estimatedFloor);

    const finishedCalibration = calibratedMs >= calibrationMs;
    const nextState: NoiseGateState = {
      calibrating: !finishedCalibration,
      calibratedMs,
      calibrationLevels: finishedCalibration ? [] : calibrationLevels,
      noiseFloor: thresholds.noiseFloor,
      openThreshold: thresholds.openThreshold,
      closeThreshold: thresholds.closeThreshold,
      gateOpen: false,
      hangoverRemainingMs: 0,
      speechActiveMs: 0,
      peakHold,
      sustainedLoudMs,
    };

    return {
      nextState,
      metrics,
      gateOpen: false,
      justOpened: false,
      justClosedWithSpeech: false,
      shouldStreamToLive: false,
    };
  }

  // Phase 2: Post-calibration asymmetric floor adaptation
  let adaptedFloor = prevState.noiseFloor;
  if (!prevState.gateOpen && metrics.level < prevState.openThreshold) {
    if (metrics.level < prevState.noiseFloor) {
      // Room got quieter: recover sensitivity quickly
      adaptedFloor = prevState.noiseFloor * 0.8 + metrics.level * 0.2;
    } else {
      // Steady-state chatter creeping up: adapt smoothly without jumping on bursts
      adaptedFloor = prevState.noiseFloor * 0.92 + metrics.level * 0.08;
    }
  } else if (prevState.gateOpen && metrics.level < prevState.noiseFloor) {
    // Allow downward floor tracking even during hangover pauses, never upward during speech
    adaptedFloor = prevState.noiseFloor * 0.95 + metrics.level * 0.05;
  }

  const thresholds = computeDynamicThresholds(adaptedFloor);

  // Phase 3: Schmitt trigger gate + hangover timer
  let gateOpen = prevState.gateOpen;
  let justOpened = false;
  let justClosedWithSpeech = false;
  let hangoverRemainingMs = prevState.hangoverRemainingMs;
  let speechActiveMs = prevState.speechActiveMs;

  if (!prevState.gateOpen) {
    if (metrics.level >= thresholds.openThreshold) {
      gateOpen = true;
      justOpened = true;
      hangoverRemainingMs = hangoverMs;
      speechActiveMs = frameDurationMs;
    } else {
      hangoverRemainingMs = 0;
      speechActiveMs = 0;
    }
  } else {
    if (metrics.level >= thresholds.closeThreshold) {
      hangoverRemainingMs = hangoverMs;
      speechActiveMs = prevState.speechActiveMs + frameDurationMs;
    } else {
      hangoverRemainingMs = Math.max(0, prevState.hangoverRemainingMs - frameDurationMs);
      if (hangoverRemainingMs === 0) {
        gateOpen = false;
        justClosedWithSpeech = prevState.speechActiveMs >= minSpeechTurnMs;
        speechActiveMs = 0;
      } else {
        speechActiveMs = prevState.speechActiveMs + frameDurationMs;
      }
    }
  }

  const nextState: NoiseGateState = {
    calibrating: false,
    calibratedMs: prevState.calibratedMs,
    calibrationLevels: [],
    noiseFloor: thresholds.noiseFloor,
    openThreshold: thresholds.openThreshold,
    closeThreshold: thresholds.closeThreshold,
    gateOpen,
    hangoverRemainingMs,
    speechActiveMs,
    peakHold,
    sustainedLoudMs,
  };

  return {
    nextState,
    metrics,
    gateOpen,
    justOpened,
    justClosedWithSpeech,
    shouldStreamToLive: gateOpen,
  };
}

export function classifyInputVolume(params: {
  active: boolean;
  level: number;
  peak: number;
  sustainedLoudMs?: number;
  ambientFloor?: number;
  voiceThreshold?: number;
  calibrating?: boolean;
  gateOpen?: boolean;
  noiseGateEnabled?: boolean;
}): InputVolumeClassification {
  const {
    active,
    level,
    peak,
    sustainedLoudMs = 0,
    ambientFloor = 0,
    voiceThreshold = AUDIO_METER_THRESHOLDS.QUIET_MAX,
    calibrating = false,
    gateOpen,
    noiseGateEnabled = false,
  } = params;

  if (!active) {
    return {
      state: 'standby',
      label: 'Mic Standby',
      hint: 'Start voice capture or run Test Mic to auto-calibrate pizzeria noise and verify voice pickup.',
    };
  }

  if (calibrating) {
    return {
      state: 'too_quiet',
      label: 'Calibrating Noise Floor',
      hint: 'Sampling steady-state pizzeria chatter for ~0.75s so Gemini Live only triggers on voice.',
    };
  }

  if (peak >= AUDIO_METER_THRESHOLDS.CLIPPING_MIN) {
    return {
      state: 'clipping',
      label: 'Clipping · Too Loud',
      hint: 'Input peak is distorting — step back from the mic or reduce counter gain.',
    };
  }

  if (
    level >= AUDIO_METER_THRESHOLDS.LOUD_MIN ||
    sustainedLoudMs >= AUDIO_METER_THRESHOLDS.SUSTAINED_NOISE_MS ||
    (ambientFloor >= 0.48 && level >= 0.48)
  ) {
    return {
      state: 'too_loud',
      label: 'Background Too Loud',
      hint: 'High ambient noise detected — speak closer to the mic or tap Reply Now to force a turn.',
    };
  }

  const effectiveGateOpen =
    typeof gateOpen === 'boolean' ? gateOpen : level >= voiceThreshold;

  if (effectiveGateOpen) {
    return {
      state: 'voice_detected',
      label: noiseGateEnabled ? 'Voice Detected · Live Gate Open' : 'Voice Detected',
      hint: noiseGateEnabled
        ? 'Human speech cleared the calibrated noise floor and is streaming to the agent.'
        : 'Clear speech level inside the target detection window.',
    };
  }

  if (noiseGateEnabled && level >= AUDIO_METER_THRESHOLDS.QUIET_MAX) {
    const pct = Math.round(voiceThreshold * 100);
    return {
      state: 'too_quiet',
      label: 'Background Chatter Ignored',
      hint: `Steady room noise suppressed below ${pct}% gate — speak closer to trigger Gemini Live.`,
    };
  }

  return {
    state: 'too_quiet',
    label: 'Too Quiet · Listening',
    hint: 'Waiting for clear speech — move closer to the mic or check hardware mute.',
  };
}
