import {
  AUDIO_METER_THRESHOLDS,
  NOISE_GATE_DEFAULTS,
  analyzeAudioFrame,
  classifyInputVolume,
  computeDynamicThresholds,
  computeRmsLevel,
  createNoiseGateState,
  downsampleFloat32,
  processNoiseGateFrame,
  type NoiseGateFrameResult,
  type NoiseGateState,
} from '../shared/audioMath';

export {
  AUDIO_METER_THRESHOLDS,
  NOISE_GATE_DEFAULTS,
  analyzeAudioFrame,
  classifyInputVolume,
  computeDynamicThresholds,
  computeRmsLevel,
  createNoiseGateState,
  downsampleFloat32,
  processNoiseGateFrame,
  type NoiseGateFrameResult,
  type NoiseGateState,
};

export function float32ToInt16Base64(float32: Float32Array): string {
  const int16 = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    const clamped = Math.max(-1, Math.min(1, float32[i]));
    int16[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
  }
  const bytes = new Uint8Array(int16.buffer);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

export function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export function encodeWavFromFloat32(samples: Float32Array, sampleRate = 16000): Uint8Array {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);

  const writeStr = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  };

  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  writeStr(22, ''); // placeholder overwritten immediately below
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, samples.length * 2, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    offset += 2;
  }

  return new Uint8Array(buffer);
}

export function uint8ToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

export class LivePcmPlayer {
  private ctx: AudioContext | null = null;
  private nextStartTime = 0;
  private activeSources = new Set<AudioBufferSourceNode>();

  private ensureContext(): AudioContext {
    if (!this.ctx || this.ctx.state === 'closed') {
      this.ctx = new AudioContext({ sampleRate: 24000 });
    }
    if (this.ctx.state === 'suspended') {
      void this.ctx.resume();
    }
    return this.ctx;
  }

  unlock() {
    const ctx = this.ensureContext();
    if (ctx.state === 'suspended') {
      void ctx.resume();
    }
  }

  enqueuePcm24kBase64(base64: string) {
    const ctx = this.ensureContext();
    const bytes = base64ToUint8Array(base64);
    const int16 = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2));
    if (int16.length === 0) return;

    const float32 = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) {
      float32[i] = int16[i] / 32768;
    }

    const buffer = ctx.createBuffer(1, float32.length, 24000);
    buffer.getChannelData(0).set(float32);

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);

    const now = ctx.currentTime;
    const startAt = Math.max(now + 0.015, this.nextStartTime);
    this.nextStartTime = startAt + buffer.duration;

    this.activeSources.add(source);
    source.onended = () => {
      this.activeSources.delete(source);
    };
    source.start(startAt);
  }

  stopAll() {
    for (const src of this.activeSources) {
      try {
        src.stop();
      } catch {
        // ignore already stopped
      }
    }
    this.activeSources.clear();
    this.nextStartTime = 0;
  }

  dispose() {
    this.stopAll();
    if (this.ctx && this.ctx.state !== 'closed') {
      void this.ctx.close();
    }
    this.ctx = null;
  }
}

export async function mixSynthesizedTracksTo16k(
  tracks: Array<{ audioBase64: string; delaySeconds: number }>
): Promise<{ wavBase64: string; pcm16kSamples: Float32Array; durationSeconds: number }> {
  const decodeCtx = new AudioContext();
  try {
    const decodedBuffers = await Promise.all(
      tracks.map(async (t) => {
        const bytes = base64ToUint8Array(t.audioBase64);
        const copy = new Uint8Array(bytes.byteLength);
        copy.set(bytes);
        const audioBuffer = await decodeCtx.decodeAudioData(copy.buffer);
        return { buffer: audioBuffer, delaySeconds: t.delaySeconds };
      })
    );

    const totalDuration = Math.max(
      1,
      ...decodedBuffers.map((d) => d.delaySeconds + d.buffer.duration)
    );
    const sampleRate = 16000;
    const length = Math.ceil(totalDuration * sampleRate);
    const offline = new OfflineAudioContext(1, length, sampleRate);

    for (const item of decodedBuffers) {
      const src = offline.createBufferSource();
      src.buffer = item.buffer;
      const gain = offline.createGain();
      gain.gain.value = 0.85;
      src.connect(gain);
      gain.connect(offline.destination);
      src.start(item.delaySeconds);
    }

    const rendered = await offline.startRendering();
    const samples = rendered.getChannelData(0);
    const wavBytes = encodeWavFromFloat32(samples, sampleRate);
    return {
      wavBase64: uint8ToBase64(wavBytes),
      pcm16kSamples: samples,
      durationSeconds: totalDuration,
    };
  } finally {
    await decodeCtx.close();
  }
}

export function playAudioBase64(base64: string, mimeType = 'audio/wav'): HTMLAudioElement {
  const bytes = base64ToUint8Array(base64);
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const blob = new Blob([copy.buffer], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const audio = new Audio(url);
  audio.onended = () => URL.revokeObjectURL(url);
  void audio.play();
  return audio;
}
