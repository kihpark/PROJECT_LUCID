'use client';

// Web Speech API types — Chromium-only, not in default DOM lib.
// Minimal shapes for the spike harness; full spec at wicg.github.io/speech-api/
interface SpeechRecognitionAlternative {
  transcript: string;
  confidence: number;
}
interface SpeechRecognitionResult {
  [index: number]: SpeechRecognitionAlternative;
}
interface SpeechRecognitionResultList {
  [index: number]: SpeechRecognitionResult;
  length: number;
}
interface SpeechRecognitionEvent extends Event {
  results: SpeechRecognitionResultList;
}
interface SpeechRecognition extends EventTarget {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  onresult: ((e: SpeechRecognitionEvent) => void) | null;
  onerror: ((e: Event) => void) | null;
  onend: (() => void) | null;
}


/**
 * Task 4 voice spike harness. NOT production; not in middleware-protected
 * paths. Visit http://localhost:3000/spike-voice after `pnpm dev`.
 *
 * What this page measures:
 *   1. SpeechRecognition (STT) — 10 Korean sentences from the V1/V2/V3
 *      utterance patterns the DR-084 plan calls out
 *   2. 3 judgment words × 10 repetitions ("수락" / "수정" / "폐기") —
 *      the V3 voice-validation core
 *   3. SpeechSynthesis (TTS) — 5 Korean briefing sentences for
 *      naturalness assessment
 *
 * What it does NOT measure: timing under noisy environment, accent
 * variation across speakers, network-resilience (Web Speech API STT
 * uses a cloud backend; offline behaviour is browser-specific).
 *
 * Output: each row exports a CSV when the PO clicks "Export results".
 */
import { useEffect, useRef, useState } from 'react';

// ---------------------------------------------------------------------------
// Reference sentences — V1 / V2 / V3 mix per DR-083
// ---------------------------------------------------------------------------
const STT_SENTENCES: { tag: string; text: string }[] = [
  // V1: capture commands
  { tag: 'V1', text: '이 페이지 분석해서 저장해줘' },
  { tag: 'V1', text: '한국경제 기사 핵심만 정리해서 넣어줘' },
  { tag: 'V1', text: '이 영상 요점을 캡처해' },
  // V2: briefing replies
  { tag: 'V2', text: '검토 대기 세 건입니다' },
  { tag: 'V2', text: '어제 저장한 기사 다섯 개 중 두 개가 검증되었습니다' },
  // V3: fact-level utterances (reading + judgment)
  { tag: 'V3-fact', text: '한국은행 기준금리는 2024년 12월 기준 3.0퍼센트였다' },
  { tag: 'V3-fact', text: '삼성전자는 2023년 4분기에 23조 원의 영업이익을 기록했다' },
  { tag: 'V3-fact', text: '베타카제인 에이원은 장에서 소화가 잘 되지 않을 수 있다' },
  // Edge: numerals + units
  { tag: 'V1-numeric', text: '오는 칠월 육일부터 원달러를 이십사시간 거래할 수 있게 된다' },
  // Edge: code-switching KR + EN
  { tag: 'V1-mixed', text: '이 깃허브 PR 리뷰 코멘트 좀 정리해줘' },
];

const JUDGMENT_WORDS: string[] = ['수락', '수정', '폐기'];
const JUDGMENT_REPETITIONS = 10;

const TTS_BRIEFING: string[] = [
  '검토 대기 세 건입니다',
  '한국은행 기준금리는 삼점영 퍼센트입니다',
  '삼성전자 영업이익은 이십삼조 원입니다',
  '베타카제인 에이원은 장에서 소화가 잘 되지 않을 수 있습니다',
  '저장된 사실은 오십이 건, 신규 검토 대기는 세 건입니다',
];

// ---------------------------------------------------------------------------
// Browser capability detect — runs once on mount
// ---------------------------------------------------------------------------
interface Capabilities {
  hasSR: boolean;
  hasSyn: boolean;
  voices: { name: string; lang: string }[];
  kr_voices_count: number;
  sr_continuous: boolean;
  sr_interim: boolean;
  userAgent: string;
}

function detectCapabilities(): Capabilities {
  type ChromeWin = Window & {
    SpeechRecognition?: unknown;
    webkitSpeechRecognition?: unknown;
  };
  const w = window as unknown as ChromeWin;
  const SR = w.SpeechRecognition ?? w.webkitSpeechRecognition;
  const hasSR = typeof SR === 'function';
  const Syn = window.speechSynthesis;
  const hasSyn = typeof Syn !== 'undefined';
  const voices = hasSyn ? Syn.getVoices().map((v) => ({ name: v.name, lang: v.lang })) : [];
  const kr = voices.filter((v) => v.lang.toLowerCase().startsWith('ko'));
  let sr_continuous = false;
  let sr_interim = false;
  if (hasSR) {
    try {
      const inst = new (SR as new () => SpeechRecognition)();
      sr_continuous = 'continuous' in inst;
      sr_interim = 'interimResults' in inst;
    } catch {
      // ignore
    }
  }
  return {
    hasSR,
    hasSyn,
    voices,
    kr_voices_count: kr.length,
    sr_continuous,
    sr_interim,
    userAgent: navigator.userAgent,
  };
}

// ---------------------------------------------------------------------------
// One-shot STT recogniser (returns the first non-empty final transcript)
// ---------------------------------------------------------------------------
function recordOnce(lang = 'ko-KR'): Promise<{ text: string; confidence: number; ms: number }> {
  return new Promise((resolve, reject) => {
    type ChromeWin = Window & {
      SpeechRecognition?: unknown;
      webkitSpeechRecognition?: unknown;
    };
    const w = window as unknown as ChromeWin;
    const SR = w.SpeechRecognition ?? w.webkitSpeechRecognition;
    if (typeof SR !== 'function') {
      reject(new Error('SpeechRecognition not supported'));
      return;
    }
    const SRCtor = SR as new () => SpeechRecognition;
    const r = new SRCtor();
    r.lang = lang;
    r.interimResults = false;
    r.maxAlternatives = 1;
    const t0 = performance.now();
    r.onresult = (e: SpeechRecognitionEvent) => {
      const transcript = e.results[0]?.[0]?.transcript ?? '';
      const confidence = e.results[0]?.[0]?.confidence ?? 0;
      const ms = performance.now() - t0;
      resolve({ text: transcript.trim(), confidence, ms });
    };
    r.onerror = (e: Event) => {
      const err = (e as Event & { error?: string }).error ?? 'unknown';
      reject(new Error(`recognition_error:${err}`));
    };
    r.onend = () => {
      // If no result delivered, resolve as empty so the caller can mark a miss.
      setTimeout(() => resolve({ text: '', confidence: 0, ms: performance.now() - t0 }), 50);
    };
    r.start();
  });
}

function speakOnce(text: string, lang = 'ko-KR'): Promise<void> {
  return new Promise((resolve) => {
    const u = new SpeechSynthesisUtterance(text);
    u.lang = lang;
    u.onend = () => resolve();
    u.onerror = () => resolve();
    window.speechSynthesis.speak(u);
  });
}

interface STTRow {
  tag: string;
  reference: string;
  recognized: string;
  confidence: number;
  ms: number;
  match: 'exact' | 'close' | 'miss' | '-';
}
interface JudgeRow {
  word: string;
  attempt: number;
  recognized: string;
  match: boolean;
}

function classify(reference: string, recognized: string): 'exact' | 'close' | 'miss' {
  const norm = (s: string) => s.replace(/\s+/g, '').replace(/[.,!?]/g, '');
  if (!recognized) return 'miss';
  if (norm(reference) === norm(recognized)) return 'exact';
  // crude similarity — character overlap ratio
  const a = new Set(norm(reference));
  const b = new Set(norm(recognized));
  const inter = [...a].filter((c) => b.has(c)).length;
  const ratio = inter / Math.max(a.size, 1);
  return ratio > 0.7 ? 'close' : 'miss';
}

function toCsv(stt: STTRow[], judge: JudgeRow[]): string {
  const lines: string[] = [];
  lines.push('section,index,tag,reference,recognized,confidence,ms,match');
  stt.forEach((r, i) => {
    lines.push(
      `stt,${i + 1},${r.tag},"${r.reference}","${r.recognized}",${r.confidence.toFixed(2)},${r.ms.toFixed(0)},${r.match}`,
    );
  });
  judge.forEach((r, i) => {
    lines.push(`judge,${i + 1},${r.word},"${r.word}","${r.recognized}",,,${r.match ? 'exact' : 'miss'}`);
  });
  return lines.join('\n');
}

export default function VoiceSpikePage() {
  const [caps, setCaps] = useState<Capabilities | null>(null);
  const [stt, setStt] = useState<STTRow[]>(
    STT_SENTENCES.map((s) => ({
      tag: s.tag,
      reference: s.text,
      recognized: '',
      confidence: 0,
      ms: 0,
      match: '-',
    })),
  );
  const [judge, setJudge] = useState<JudgeRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [activeIdx, setActiveIdx] = useState<number | null>(null);
  const audioCheckedRef = useRef(false);

  useEffect(() => {
    // SpeechSynthesis voices populate async on some browsers.
    const refresh = () => setCaps(detectCapabilities());
    refresh();
    if (typeof window !== 'undefined' && window.speechSynthesis) {
      window.speechSynthesis.onvoiceschanged = refresh;
    }
  }, []);

  // Encourage user gesture for mic permission once.
  useEffect(() => {
    if (audioCheckedRef.current) return;
    const onFirstClick = () => {
      audioCheckedRef.current = true;
      window.removeEventListener('click', onFirstClick);
    };
    window.addEventListener('click', onFirstClick);
    return () => window.removeEventListener('click', onFirstClick);
  }, []);

  const runSttRow = async (i: number) => {
    setBusy(true);
    setActiveIdx(i);
    try {
      const r = await recordOnce();
      const m = classify(stt[i]!.reference, r.text);
      setStt((prev) => {
        const next = [...prev];
        next[i] = { ...next[i]!, recognized: r.text, confidence: r.confidence, ms: r.ms, match: m };
        return next;
      });
    } catch (err) {
      setStt((prev) => {
        const next = [...prev];
        next[i] = { ...next[i]!, recognized: `ERR: ${(err as Error).message}`, match: 'miss' };
        return next;
      });
    } finally {
      setActiveIdx(null);
      setBusy(false);
    }
  };

  const runJudgmentRound = async (word: string) => {
    setBusy(true);
    const rows: JudgeRow[] = [];
    for (let i = 0; i < JUDGMENT_REPETITIONS; i++) {
      setActiveIdx(i);
      try {
        const r = await recordOnce();
        rows.push({ word, attempt: i + 1, recognized: r.text, match: r.text === word });
        setJudge((prev) => [...prev, rows[rows.length - 1]!]);
        await new Promise((s) => setTimeout(s, 400));
      } catch (err) {
        rows.push({
          word,
          attempt: i + 1,
          recognized: `ERR: ${(err as Error).message}`,
          match: false,
        });
        setJudge((prev) => [...prev, rows[rows.length - 1]!]);
      }
    }
    setBusy(false);
    setActiveIdx(null);
  };

  const exportCsv = () => {
    const blob = new Blob([toCsv(stt, judge)], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `voice-spike-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <main className="min-h-screen p-6 max-w-4xl mx-auto text-sm">
      <h1 className="text-2xl mb-4">Voice Spike — DR-084 평가 harness</h1>
      <p className="text-text-secondary mb-6">
        이 페이지는 일회용 측정 도구입니다. 결과는 CSV 로 export 후 PR
        에 첨부해 DR-084 결정에 사용하세요.
      </p>

      <section className="mb-8">
        <h2 className="font-medium mb-2">1. Browser capability</h2>
        {caps ? (
          <ul className="text-xs font-mono">
            <li>SpeechRecognition supported: <strong>{String(caps.hasSR)}</strong></li>
            <li>SpeechSynthesis supported: <strong>{String(caps.hasSyn)}</strong></li>
            <li>Korean (ko-*) voices: <strong>{caps.kr_voices_count}</strong></li>
            <li>continuous: <strong>{String(caps.sr_continuous)}</strong>, interim: <strong>{String(caps.sr_interim)}</strong></li>
            <li className="text-text-muted">UA: {caps.userAgent}</li>
          </ul>
        ) : (
          <p>Loading…</p>
        )}
      </section>

      <section className="mb-8">
        <h2 className="font-medium mb-2">2. STT — 10 Korean sentences</h2>
        <p className="text-text-muted text-xs mb-2">
          각 행의 "Record" 를 누르고 reference 문장을 한 번 또박또박 말하세요. ko-KR.
        </p>
        <table className="w-full text-xs border border-border-subtle">
          <thead>
            <tr className="bg-bg-elevated">
              <th className="text-left p-1">#</th>
              <th className="text-left p-1">Tag</th>
              <th className="text-left p-1">Reference</th>
              <th className="text-left p-1">Recognized</th>
              <th className="text-left p-1">conf</th>
              <th className="text-left p-1">ms</th>
              <th className="text-left p-1">match</th>
              <th className="text-left p-1"></th>
            </tr>
          </thead>
          <tbody>
            {stt.map((r, i) => (
              <tr key={i} className={activeIdx === i ? 'bg-accent-cool/10' : ''}>
                <td className="p-1">{i + 1}</td>
                <td className="p-1 font-mono">{r.tag}</td>
                <td className="p-1">{r.reference}</td>
                <td className="p-1 font-mono">{r.recognized || '—'}</td>
                <td className="p-1">{r.confidence ? r.confidence.toFixed(2) : '—'}</td>
                <td className="p-1">{r.ms ? r.ms.toFixed(0) : '—'}</td>
                <td className="p-1">{r.match}</td>
                <td className="p-1">
                  <button
                    disabled={busy}
                    onClick={() => runSttRow(i)}
                    className="px-2 py-0.5 border border-border-subtle rounded hover:bg-bg-card-hover disabled:opacity-50"
                  >
                    Record
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="mb-8">
        <h2 className="font-medium mb-2">3. Judgment words × 10</h2>
        <p className="text-text-muted text-xs mb-2">
          각 단어 round 를 누르고 10초 동안 그 단어만 짧게 반복해서 말하세요.
        </p>
        <div className="flex gap-2 mb-3">
          {JUDGMENT_WORDS.map((w) => (
            <button
              key={w}
              disabled={busy}
              onClick={() => runJudgmentRound(w)}
              className="px-3 py-1 border border-border-subtle rounded hover:bg-bg-card-hover disabled:opacity-50"
            >
              Round: {w}
            </button>
          ))}
        </div>
        <ul className="text-xs font-mono">
          {judge.map((j, i) => (
            <li key={i} className={j.match ? 'text-accent-success' : 'text-accent-error'}>
              {j.word} #{j.attempt}: "{j.recognized}" — {j.match ? 'match' : 'MISS'}
            </li>
          ))}
        </ul>
      </section>

      <section className="mb-8">
        <h2 className="font-medium mb-2">4. TTS — 한국어 자연성 체감</h2>
        <p className="text-text-muted text-xs mb-2">
          5문장을 한 번씩 듣고 1=부자연, 5=자연으로 주관 평가하세요.
        </p>
        <ul className="space-y-2">
          {TTS_BRIEFING.map((t, i) => (
            <li key={i} className="flex items-center gap-3">
              <button
                disabled={busy}
                onClick={() => speakOnce(t)}
                className="px-2 py-0.5 border border-border-subtle rounded hover:bg-bg-card-hover"
              >
                ▶
              </button>
              <span>{t}</span>
            </li>
          ))}
        </ul>
      </section>

      <section>
        <button
          onClick={exportCsv}
          className="px-4 py-2 bg-accent-cool text-bg-base rounded font-medium"
        >
          Export results CSV
        </button>
      </section>
    </main>
  );
}
