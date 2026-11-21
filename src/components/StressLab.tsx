import { Play, Upload } from 'lucide-react';
import { useState } from 'react';
import type { StressLevelResult } from '../types/voicepizza';
import { mixSynthesizedTracksTo16k } from '../utils/audioEngine';

interface StressLabProps {
  onStressCompleted?: () => void;
}

export function StressLab({ onStressCompleted }: StressLabProps) {
  const [runningLevel, setRunningLevel] = useState<number | null>(null);
  const [results, setResults] = useState<StressLevelResult[]>([]);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [useRealMixedAudio, setUseRealMixedAudio] = useState(true);
  const [customAudioName, setCustomAudioName] = useState<string | null>(null);
  const [customAudioPayload, setCustomAudioPayload] = useState<{
    base64: string;
    mimeType: string;
  } | null>(null);

  async function runLevel(level: 1 | 2 | 3) {
    setRunningLevel(level);
    setErrorMsg(null);
    try {
      let audioBase64 = customAudioPayload?.base64;
      let audioMimeType = customAudioPayload?.mimeType;

      if (!audioBase64 && useRealMixedAudio) {
        const synthRes = await fetch('/api/chaos/synthesize', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ scenarioId: 'p2-counter-6lang' }),
        });
        const synthData = await synthRes.json();
        if (!synthRes.ok) {
          throw new Error(synthData.error || 'Failed to synthesize acoustic tracks');
        }
        const sliceCount = level === 1 ? 2 : level === 2 ? 4 : 6;
        const mixed = await mixSynthesizedTracksTo16k(synthData.tracks.slice(0, sliceCount));
        audioBase64 = mixed.wavBase64;
        audioMimeType = 'audio/wav';
      }

      const res = await fetch('/api/stress/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scenarioId: 'p2-counter-6lang',
          level,
          audioBase64,
          audioMimeType,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Stress run failed');
      }

      setResults((prev) => [
        data.result as StressLevelResult,
        ...prev.filter((r) => r.level !== level),
      ].sort((a, b) => a.level - b.level));

      onStressCompleted?.();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Stress benchmark error');
    } finally {
      setRunningLevel(null);
    }
  }

  async function handleRunAllProgressive() {
    for (const lvl of [1, 2, 3] as const) {
      await runLevel(lvl);
    }
  }

  function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || '');
      const base64 = result.split(',')[1];
      if (base64) {
        setCustomAudioName(file.name);
        setCustomAudioPayload({ base64, mimeType: file.type || 'audio/wav' });
      }
    };
    reader.readAsDataURL(file);
  }

  return (
    <div className="space-y-6">
      <section className="rounded-xl border border-[#E5E0D8] bg-white p-6 space-y-5">
        <div className="flex flex-wrap items-start justify-between gap-4 border-b border-[#EFECE6] pb-4">
          <div className="space-y-1 max-w-2xl">
            <h1 className="font-display text-2xl font-bold text-[#171717]">
              Element 119 Stress Lab — Where It Breaks
            </h1>
            <p className="text-sm text-[#525252]">
              Measure a single-model uncalibrated baseline (Gemini 4 Hydrogen) against the
              VoicePizza multi-model stack (Decisions API + Gemini 4 Neon + Hydrogen) on real
              overlapping multi-language acoustic mixes.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2.5">
            <label className="inline-flex items-center gap-2 px-3 py-2 text-xs font-medium rounded-lg border border-[#E5E0D8] bg-[#F8F7F4] text-[#171717] cursor-pointer hover:bg-[#EFECE6] whitespace-nowrap shrink-0">
              <Upload className="h-3.5 w-3.5" aria-hidden="true" />
              {customAudioName ? `Audio: ${customAudioName}` : 'Upload Custom Audio'}
              <input
                type="file"
                accept="audio/*"
                onChange={handleFileUpload}
                className="sr-only"
              />
            </label>

            <button
              type="button"
              disabled={runningLevel !== null}
              onClick={handleRunAllProgressive}
              className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold rounded-lg bg-[#C23B22] text-white hover:bg-[#A6311B] disabled:opacity-50 transition-colors whitespace-nowrap shrink-0"
            >
              <Play className="h-3.5 w-3.5" aria-hidden="true" />
              {runningLevel !== null ? `Running Level ${runningLevel}...` : 'Run All 3 Escalation Levels'}
            </button>
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-4 text-xs text-[#525252]">
          <label className="inline-flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={useRealMixedAudio}
              onChange={(e) => setUseRealMixedAudio(e.target.checked)}
              className="rounded border-[#E5E0D8] accent-[#C23B22]"
            />
            <span>
              Synthesize and mix real overlapping Gemini TTS WAV audio for each escalation level
            </span>
          </label>

          <div className="flex items-center gap-2">
            {([1, 2, 3] as const).map((lvl) => (
              <button
                key={lvl}
                type="button"
                disabled={runningLevel !== null}
                onClick={() => runLevel(lvl)}
                className="px-3 py-1.5 text-xs font-semibold rounded-lg border border-[#E5E0D8] bg-white text-[#171717] hover:bg-[#EFECE6] disabled:opacity-50 whitespace-nowrap shrink-0"
              >
                Run Level {lvl}
              </button>
            ))}
          </div>
        </div>

        {errorMsg && (
          <div role="alert" className="rounded-lg border border-[#C23B22]/30 bg-[#C23B22]/8 p-3 text-xs text-[#8F2411]">
            {errorMsg}
          </div>
        )}
      </section>

      {/* Benchmark Comparison Table */}
      <section className="rounded-xl border border-[#E5E0D8] bg-white overflow-hidden">
        <div className="px-6 py-4 border-b border-[#EFECE6]">
          <h2 className="font-display text-lg font-semibold text-[#171717]">
            Measured Baseline vs. Orchestrated Results
          </h2>
        </div>

        {results.length === 0 ? (
          <div className="p-10 text-center space-y-2">
            <p className="text-sm font-medium text-[#171717]">No stress runs executed yet.</p>
            <p className="text-xs text-[#737373]">
              Click “Run All 3 Escalation Levels” to test 2, 4, and 6 simultaneous speakers in real
              time against the Gemini 4 models and Decisions API.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-[#F8F7F4] text-[#525252] border-b border-[#E5E0D8]">
                <tr>
                  <th className="px-5 py-3 font-semibold">Escalation Level</th>
                  <th className="px-5 py-3 font-semibold text-right">Speakers</th>
                  <th className="px-5 py-3 font-semibold text-right">Baseline Recall</th>
                  <th className="px-5 py-3 font-semibold text-right">Baseline Latency</th>
                  <th className="px-5 py-3 font-semibold text-right">VoicePizza Recall</th>
                  <th className="px-5 py-3 font-semibold text-right">Decisions Conf.</th>
                  <th className="px-5 py-3 font-semibold text-right">VoicePizza Latency</th>
                  <th className="px-5 py-3 font-semibold">Observed Breakdown / Insight</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#EFECE6]">
                {results.map((r) => (
                  <tr key={r.level} className="hover:bg-[#F8F7F4]/60">
                    <td className="px-5 py-3.5 font-semibold text-[#171717]">{r.label}</td>
                    <td className="px-5 py-3.5 text-right font-mono-tabular">
                      {r.concurrentSpeakers} ({r.noiseDbLabel})
                    </td>
                    <td className="px-5 py-3.5 text-right font-mono-tabular font-semibold text-[#C23B22]">
                      {Math.round(r.baselineRecall * 100)}%
                    </td>
                    <td className="px-5 py-3.5 text-right font-mono-tabular text-[#525252]">
                      {r.baselineLatencyMs} ms
                    </td>
                    <td className="px-5 py-3.5 text-right font-mono-tabular font-semibold text-[#1F6E4A]">
                      {Math.round(r.orchestratedRecall * 100)}%
                    </td>
                    <td className="px-5 py-3.5 text-right font-mono-tabular">
                      {Math.round(r.decisionTriageConfidence * 100)}%
                    </td>
                    <td className="px-5 py-3.5 text-right font-mono-tabular text-[#525252]">
                      {r.orchestratedLatencyMs} ms
                    </td>
                    <td className="px-5 py-3.5 text-[#525252] max-w-xs">
                      {r.baselineErrorNote}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Honest Failure Analysis (Element 119 Questions) */}
      <section className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <article className="rounded-xl border border-[#E5E0D8] bg-white p-5 space-y-2">
          <h3 className="font-display text-base font-semibold text-[#171717]">
            What Raw Audio Gives Us That Text Loses
          </h3>
          <p className="text-xs leading-relaxed text-[#525252]">
            A flat transcript erases overlapping speaker cadence, vocal urgency (the Greek guest
            yelling about Table 4 vs. a calm takeaway request), and sub-second bilingual
            code-switching between partners on one handset.
          </p>
        </article>
        <article className="rounded-xl border border-[#E5E0D8] bg-white p-5 space-y-2">
          <h3 className="font-display text-base font-semibold text-[#171717]">
            Where Single-Model Extraction Breaks
          </h3>
          <p className="text-xs leading-relaxed text-[#525252]">
            Around 4+ concurrent speakers, a single fast prompt merges the Italian chef shouting
            “Diavola del tavolo due!” into the English/German takeaway cart, creating phantom
            pizzas.
          </p>
        </article>
        <article className="rounded-xl border border-[#E5E0D8] bg-white p-5 space-y-2">
          <h3 className="font-display text-base font-semibold text-[#171717]">
            How Decisions API + Neon Get Past It
          </h3>
          <p className="text-xs leading-relaxed text-[#525252]">
            Gemini Decisions API scores speaker role, language, and chaos severity with zero output
            tokens first, guiding Gemini 4 Neon to separate customer carts from supplier and staff
            chatter before Hydrogen formats bilingual kitchen notes.
          </p>
        </article>
      </section>
    </div>
  );
}
