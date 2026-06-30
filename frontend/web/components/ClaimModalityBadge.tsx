/**
 * ★ REQ-004 결함 2 (PO 2026-06-30) — claim modality 표시 전 화면 일관.
 *
 * Re-usable modality badge. Centralises:
 *   - classify(): speech_act string → 'assertion' | 'judgment' | 'opinion' | null
 *   - MODALITY_LABEL: KR display label (단정 / 판단 / 의견)
 *   - <ClaimModalityBadge />: styled chip for surfaces that render fact lists
 *     using Tailwind (FactCard / RecallFactCard / LedgerCard / FactDetailModal).
 *
 * The classify() helper + MODALITY_LABEL constant mirror the existing
 * exports in StellarHoverCard.tsx so STELLAR surfaces remain the canonical
 * source for the inline-style hover/card variants. This module is the
 * single source of truth for the "list / strip / badge" variant that
 * lives outside the STELLAR canvas.
 *
 * Modality semantics (★ 데이터모델 v2, PO 2026-06-28):
 *   - assertion : 단정    (자기 책임으로 사실로 단언)
 *   - judgment  : 판단    (평가·견해)
 *   - opinion   : 의견    (추측·선호)
 *
 * Why the badge needs to surface in lists too:
 *   STELLAR HoverCard / EntityCard already show 양태 because they're the
 *   "한 발언 자세히" surface. RecallFactCard / FactCard / LedgerCard render
 *   CLAIM facts WITHOUT any modality cue — the same fact looks identical
 *   across 단정 / 판단 / 의견 in the list views. Class-wide fix: every
 *   surface that draws the [CLAIM] badge MUST also draw [단정/판단/의견]
 *   right next to it so the user can read 양태 at a glance everywhere.
 */
'use client';

export type ClaimModality = 'assertion' | 'judgment' | 'opinion';

export const MODALITY_LABEL: Record<ClaimModality, string> = {
  assertion: '단정',
  judgment: '판단',
  opinion: '의견',
};

export const MODALITY_TOOLTIP: Record<ClaimModality, string> = {
  assertion: '단정 — 화자가 자기 책임으로 사실로 단언한 발언',
  judgment: '판단 — 화자의 평가·견해',
  opinion: '의견 — 화자의 추측·선호',
};

/** speech_act 자유 텍스트 → 양태 분류. 매핑 안 되면 null.
 *  ★ StellarHoverCard.classifyClaimModality 와 동일 결과를 보장한다 — 한
 *  곳에서 바꾸면 다른 곳도 같이 바꿔야 한다. 두 곳 모두 영문 키워드
 *  (assertion / judgment / opinion + 동의어) 만 인식. v3 backend
 *  표준화 후 합쳐질 예정. */
export function classifyClaimModality(
  speechAct: string | null | undefined,
): ClaimModality | null {
  if (!speechAct) return null;
  const v = speechAct.trim().toLowerCase();
  if (v === 'assertion' || v === 'assert' || v === 'assertions') return 'assertion';
  if (v === 'judgment' || v === 'judgement' || v === 'judge') return 'judgment';
  if (v === 'opinion' || v === 'opine' || v === 'opinions') return 'opinion';
  return null;
}

/** Tailwind-styled chip used by surfaces outside the STELLAR canvas
 *  (FactCard, RecallFactCard, LedgerCard, FactDetailModal). Each modality
 *  has its own accent so the user can distinguish 단정/판단/의견 at a
 *  glance — teal for assertion, amber for judgment, violet for opinion.
 *
 *  No-op when modality is null / undefined / unclassifiable. */
export function ClaimModalityBadge({
  modality,
  factUid,
}: {
  modality: ClaimModality | null | undefined;
  factUid?: string;
}) {
  if (!modality) return null;
  const cls =
    modality === 'assertion'
      ? 'text-accent-cool bg-accent-cool/10 border-accent-cool/40'
      : modality === 'judgment'
        ? 'text-accent-warm bg-accent-warm/10 border-accent-warm/40'
        : 'text-violet-300 bg-violet-500/10 border-violet-400/40';
  const testId = factUid
    ? `fact-claim-modality-${modality}-${factUid}`
    : `fact-claim-modality-${modality}`;
  return (
    <span
      data-testid={testId}
      data-modality={modality}
      className={[
        'inline-flex items-center text-xxs font-mono rounded px-1.5 py-0.5 border',
        cls,
      ].join(' ')}
      title={MODALITY_TOOLTIP[modality]}
    >
      {MODALITY_LABEL[modality]}
    </span>
  );
}

/** Convenience: classify + render in one step. Callers that already
 *  have the ClaimModality value should use <ClaimModalityBadge /> directly. */
export function ClaimModalityBadgeFromSpeechAct({
  speechAct,
  factUid,
}: {
  speechAct: string | null | undefined;
  factUid?: string;
}) {
  const modality = classifyClaimModality(speechAct);
  return <ClaimModalityBadge modality={modality} factUid={factUid} />;
}
