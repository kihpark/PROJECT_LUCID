"""ACTION fact entity-edge enforcement — STELLAR v2 원칙 1 위반 클래스 fix.

PO 의뢰서 (2026-06-29, feat/v2-action-entity-edge-class-fix):

    "ENTITY 간 엣지 전무함. 단, CLAIM 보기 했을때 발언 노드가 화자와
    연결되며 나타남."

위반 클래스 정의:
    ACTION fact 의 ``object_value`` 가 entity_uid (UUID / obj-N
    placeholder) 가 아니라 literal (자연어 명사구) → STELLAR adapter
    가 entity-edge 를 못 그림 → 그래프 상 ACTION 노드/엣지 전무.

원칙:
    "모든 ACTION fact = entity 간 엣지" — ACTION 의 의미는 두 entity
    사이의 행위. object 가 entity 가 아니면 ACTION 의미가 깨진다.
    LLM 이 literal 을 흘리면 후처리에서 결정론적으로 매칭해 obj-N
    placeholder 로 치환한다.

★ PO 작업 철학 (의뢰서 verbatim):
    "특정 케이스 (강재호 / 축구협회 / 손흥민) 하드코딩 금지. 원칙 단위 fix."

원칙 단위 매칭 규칙:
    1. ACTION fact 의 object_value 가 obj-N placeholder 면 → 무변경.
    2. literal 이면 같은 StructureResult.objects 배열에서:
        (a) name exact (case-fold).
        (b) name_en exact (case-fold).
        (c) aliases 중 exact (case-fold).
        (d) literal 가 obj.name / obj.name_en 의 substring 포함.
        (e) obj.name / obj.name_en 가 literal 의 substring 포함.
       매칭 성공 → object_value 를 매칭된 obj.uid 로 대체 + 그 obj 에
       대한 addresses fact_object_link 추가.
    3. 매칭 실패 → 무변경 (자동 재분류 안 함).

CLAIM / MEASUREMENT 무변경:
    CLAIM 의 object_value 는 의도적으로 발화 내용 (literal).
    MEASUREMENT 의 object_value 는 수치 표현 (literal).

회귀 방지:
    - 이미 obj-N 인 ACTION 무변경.
    - 부분일치는 길이>=2 의 surface 일 때만 (1-char 거짓 매칭 차단).
    - subject == match 면 self-edge 방지로 스킵.
"""
from __future__ import annotations

import logging
import re
from collections.abc import Iterable

from api.structure.models import (
    StructureFact,
    StructureFactObjectLink,
    StructureObject,
    StructureResult,
)

logger = logging.getLogger("lucid.structure.action_object_resolver")

_OBJ_PLACEHOLDER_RE = re.compile(r"^obj-\d+$", re.IGNORECASE)
_UUID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
    re.IGNORECASE,
)

# Right-edge Korean particles we peel off literal object_value before
# substring matching ("트럼프에게" -> "트럼프"). Sorted longest-first
# in _strip_trailing_particles so multi-char particles win.
_KO_TRAILING_PARTICLES = (
    "에게서", "에서", "에게", "께서", "으로", "로서", "로써",
    "이라고", "라고", "이라는", "라는",
    "은", "는", "이", "가", "을", "를", "와", "과", "도",
    "로", "에", "의",
)

_MIN_OBJ_SURFACE_LEN_FOR_REVERSE = 2


def _strip_trailing_particles(s: str) -> str:
    bare = (s or "").strip()
    for p in sorted(_KO_TRAILING_PARTICLES, key=len, reverse=True):
        if len(bare) > len(p) and bare.endswith(p):
            return bare[: -len(p)].strip()
    return bare


def _normalize_for_match(s: str) -> str:
    return _strip_trailing_particles((s or "").strip()).lower()


def _candidate_surfaces(obj: StructureObject) -> Iterable[str]:
    if obj.name:
        yield obj.name
    if obj.name_en:
        yield obj.name_en
    for alias in obj.aliases or ():
        if alias:
            yield alias


def _find_entity_for_literal(
    literal: str,
    candidates: list[StructureObject],
    subject_uid: str | None,
) -> StructureObject | None:
    """Return the StructureObject best matching `literal`, else None.

    Specificity tiers (higher wins, ties broken by first-seen):
        1_000_000+ = exact (post-normalize) match
        100_000+   = surface ⊂ literal ("트럼프" in "트럼프에게")
        10_000+    = literal ⊂ surface ("축구협회" in "대한축구협회")
    `subject_uid` excluded as self-edge defense.
    """
    norm_literal = _normalize_for_match(literal)
    if not norm_literal:
        return None
    best: tuple[int, StructureObject] | None = None
    for obj in candidates:
        if obj.uid == subject_uid:
            continue
        for surface in _candidate_surfaces(obj):
            norm_surface = _normalize_for_match(surface)
            if not norm_surface:
                continue
            spec = 0
            if norm_surface == norm_literal:
                spec = 1_000_000 + len(norm_surface)
            elif (
                len(norm_surface) >= _MIN_OBJ_SURFACE_LEN_FOR_REVERSE
                and norm_surface in norm_literal
            ):
                spec = 100_000 + len(norm_surface)
            elif (
                len(norm_literal) >= _MIN_OBJ_SURFACE_LEN_FOR_REVERSE
                and norm_literal in norm_surface
            ):
                spec = 10_000 + len(norm_literal)
            if spec and (best is None or spec > best[0]):
                best = (spec, obj)
    return best[1] if best else None


def _augment_links_with_object_edge(
    result: StructureResult, fact_uid: str, object_uid: str,
) -> bool:
    for fo in result.fact_object_links:
        if fo.fact_uid == fact_uid and fo.object_uid == object_uid:
            return False
    result.fact_object_links.append(
        StructureFactObjectLink(
            fact_uid=fact_uid,
            object_uid=object_uid,
            link_type="addresses",
            properties={"resolved_from_literal": True},
        )
    )
    return True


def resolve_action_object_to_entity(result: StructureResult) -> StructureResult:
    """Mutate `result` in place so every ACTION fact's object_value
    references an entity (obj-N placeholder) when at all possible.

    Decision tree per fact:
      fact_type != "action"           -> skip
      object_value already obj-N      -> skip
      object_value empty / non-str    -> skip
      object_value is a UUID4 already -> skip (defensive — never loop)
      else find a matching object     -> rewrite + emit addresses link
      no match                        -> leave as-is (no silent loss)

    Returns the same `result` for chaining.
    """
    if not result or not result.facts:
        return result
    candidates = list(result.objects or ())
    if not candidates:
        return result

    rewrites = 0
    misses = 0
    for fact in result.facts:
        if fact.fact_type != "action":
            continue
        ov = fact.object_value
        if not isinstance(ov, str):
            continue
        bare = ov.strip()
        if not bare:
            continue
        if _OBJ_PLACEHOLDER_RE.match(bare):
            continue
        if _UUID_RE.match(bare):
            continue

        matched = _find_entity_for_literal(bare, candidates, fact.subject_uid)
        if matched is None:
            misses += 1
            logger.info(
                "action-object-resolver MISS fact_uid=%s subject_uid=%s "
                "object_value=%r (no candidate among %d objects)",
                fact.uid, fact.subject_uid, bare[:60], len(candidates),
            )
            continue
        old_value = fact.object_value
        fact.object_value = matched.uid
        if not fact.object_surface:
            fact.object_surface = old_value
        _augment_links_with_object_edge(result, fact.uid, matched.uid)
        rewrites += 1
        logger.info(
            "action-object-resolver REWRITE fact_uid=%s subject_uid=%s "
            "object_value %r -> %s (matched %r)",
            fact.uid, fact.subject_uid, old_value[:60], matched.uid,
            (matched.name or "")[:40],
        )

    if rewrites or misses:
        action_total = sum(1 for f in result.facts if f.fact_type == "action")
        logger.info(
            "action-object-resolver summary: rewrites=%d misses=%d "
            "(over %d ACTION facts)",
            rewrites, misses, action_total,
        )
    return result


__all__ = ["resolve_action_object_to_entity"]
