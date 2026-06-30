"""
REQ-004 STAGE 1b — Entity resolution gateway 가 5 resolver 기능 흡수.

★ v3 §2·§5 verbatim:
- 모든 entity 참조 = entity_id (★ 문자열 저장 경로 제거)
- 전역 검색: 임베딩 유사도 + alias 표면형
- 확신 → 기존 entity_id / 새것 → 새 entity / 애매 → 새 + "후보" (P2)
- 타입 10종 분류 (+ confidence)

★ STAGE 1b 범위 (★ PO verbatim):
- 1b-i  exact match cascade (★ entity_resolver 의 5-tier 흡수, ★ 호출 X 로직 재구현)
- 1b-ii LLM type 분류 (★ v3 10종 closed set, ★ stub 으로 시작)
- 1b-iii brand alias 17개 + 한국어 particles strip 흡수 (★ pre-resolve normalize)
- 1b-iv kNN 다단계 band (★ object_matcher 의 0.70-0.95 흡수)
- 1b-v  action_object_resolver STOP guard ★ 유지 (★ 1c 에서 제거)

★ DO NOT call 5 resolver from gateway (★ 로직만 재구현).
"""

from dataclasses import dataclass
from typing import Any, Literal, Optional

import logging
import os
import re

from elasticsearch import Elasticsearch

from api.models.base import new_uid
from api.storage.elasticsearch.client import LUCID_OBJECTS, get_client
from api.storage.elasticsearch.embeddings import get_embedding

logger = logging.getLogger("lucid.structure.resolution_gateway")


# ★ PO 2026-06-30: cross-lingual canonical 보강. 옛 "삼성전자" / "Samsung
# Electronics" 가 ★ 따로 entity 로 떨어진 문제 → exact-match miss 후 ★ Claude
# 에게 "동일 entity?" 묻고 ★ alias 자동 추가. STEP 0 진단:
#   - cosine('삼성전자','Samsung Electronics') = 0.6439 (★ < DISAMBIG_FLOOR 0.70)
#   - cosine('SK하이닉스','SK Hynix')          = 0.4378
#   - 게다가 ★ 옛 entity 169개 중 0개만 embedding 보유 → kNN ★ 무의미
# 결론: ★ Option C (★ embedding + Claude). kNN 으로 후보 잡고 Claude 가 결정.
# ★ env CROSS_LINGUAL_CANONICAL_ENABLED=0 로 끌 수 있음 (★ test default off).
def _cross_lingual_enabled() -> bool:
    raw = os.getenv("CROSS_LINGUAL_CANONICAL_ENABLED", "1").strip().lower()
    return raw not in ("", "0", "false", "no", "off")


# v3 §3: 10종 closed set
ENTITY_TYPE_V3 = Literal[
    "person", "organization", "group",
    "knowledge", "resource", "task", "concept", "event", "metric",
    "location",
]

_ENTITY_TYPE_V3_SET: frozenset[str] = frozenset({
    "person", "organization", "group",
    "knowledge", "resource", "task", "concept", "event", "metric",
    "location",
})


# ★ 1b-iii: brand_resolver 흡수 (★ 17개 한글→영문 brand alias verbatim)
# ★ DO NOT call brand_resolver; ★ 로직 재구현.
_KOREAN_BRAND_ALIAS: dict[str, str] = {
    # Tech / aerospace
    "스페이스X": "SpaceX",
    "스페이스엑스": "SpaceX",
    "오픈AI": "OpenAI",
    "오픈에이아이": "OpenAI",
    "아이비엠": "IBM",
    "엔비디아": "Nvidia",
    "구글": "Google",
    "애플": "Apple",
    "마이크로소프트": "Microsoft",
    "메타": "Meta",
    "테슬라": "Tesla",
    "아마존": "Amazon",
    "트위터": "Twitter",
    "페이스북": "Facebook",
    "인텔": "Intel",
    # Add-2 for parity with brand_resolver curated list (17 spec):
    "삼성": "Samsung",
    "현대": "Hyundai",
}


# ★ 1b-iii: subject_recovery / entity_resolver 흡수 — 한국어 particles strip
# ★ DO NOT call subject_recovery; ★ 로직 재구현.
_KOREAN_PARTICLES_RE = re.compile(
    r"(은|는|이|가|을|를|의|에|에서|로|으로|와|과|도|만|까지|부터|에게|한테)$"
)


def _normalize_surface(surface: str, lang: str) -> str:
    """★ 1b-iii: pre-resolve surface 정규화.

    Order:
      1. strip whitespace
      2. brand alias lookup (★ Korean transliteration → English canonical)
      3. Korean particles strip (★ "한국은행이" → "한국은행")
    """
    if not surface:
        return ""
    s = surface.strip()
    if not s:
        return ""
    # brand alias 우선 (★ exact lookup, ★ pre-particle-strip)
    if s in _KOREAN_BRAND_ALIAS:
        return _KOREAN_BRAND_ALIAS[s]
    # 한국어 particles strip (★ at most one trailing particle)
    if lang == "ko":
        stripped = _KOREAN_PARTICLES_RE.sub("", s).strip()
        # brand alias 재시도 (★ particle strip 후 다시 match 가능)
        if stripped in _KOREAN_BRAND_ALIAS:
            return _KOREAN_BRAND_ALIAS[stripped]
        s = stripped or s
    return s


@dataclass
class ResolvedEntity:
    """Gateway 의 단일 contract — 모든 호출이 이 type 반환."""
    entity_id: str
    canonical_name: str
    entity_type: str  # ENTITY_TYPE_V3 (★ 1b-ii 부터 closed enforcement)
    confidence: float
    source: Literal["embedding", "exact", "new", "candidate"]
    # ★ "candidate" = 애매 → 새 entity + P2 사용자 통합 대기


def resolve(
    surface: str,
    lang: str,
    knowledge_space_id: str,
    *,
    client: Optional[Elasticsearch] = None,
) -> ResolvedEntity:
    """
    REQ-004 STAGE 1b — Gateway 가 5 resolver 기능 흡수.

    Cascade:
      0. surface 정규화 (★ 1b-iii: brand alias + KO particles strip)
      1. exact match cascade (★ 1b-i: name / name_en / aliases / primary_label)
      2. embedding kNN (★ 1a 보존 + 1b-iv 다단계 band)
      3. LLM type 분류 + candidate fallback (★ 1b-ii)

    ★ Constraints:
    - 5 resolver ★ 호출 X (★ 로직 재구현)
    - action_object_resolver ★ STOP guard 유지 (★ 1b-v, 1c 에서 제거)
    - ES insert ★ 안 함 (★ 1c 에서 저장 경로 통합)
    """
    if client is None:
        client = get_client()

    normalized = _normalize_surface(surface, lang)
    if not normalized:
        return ResolvedEntity(
            entity_id="",
            canonical_name="",
            entity_type="concept",
            confidence=0.0,
            source="candidate",
        )

    # ★ 1b-i: exact match cascade (★ entity_resolver 의 5-tier 흡수)
    exact_hit = _exact_match_cascade(
        client=client,
        normalized=normalized,
        knowledge_space_id=knowledge_space_id,
    )
    if exact_hit is not None:
        return exact_hit

    # ★ PO 2026-06-30 cross-lingual canonical: ★ exact miss 후, ★ embedding
    # kNN 진입 전에 BM25 후보 → Claude "동일 entity?" 게이트.
    # ★ 옛 entity 들이 embedding 없음 + 한/영 cosine 0.4-0.6 → kNN 가 ★ 못 잡음.
    # 따라서 ★ 텍스트 후보 + Claude 가 ★ 유일한 cross-lingual canonical 경로.
    cross_hit = _cross_lingual_canonical_check(
        client=client,
        surface=surface,
        normalized=normalized,
        lang=lang,
        knowledge_space_id=knowledge_space_id,
    )
    if cross_hit is not None:
        return cross_hit

    # ★ 1a 보존 + 1b-iv: embedding kNN 다단계 band
    knn_hit = _embedding_knn_match(
        client=client,
        normalized=normalized,
        knowledge_space_id=knowledge_space_id,
    )
    if knn_hit is not None:
        # ★ 1c-ii: kNN disambig band returns source="candidate" with
        # entity_id="". Persist the new candidate entity so the caller
        # never receives an empty entity_id (★ v3 entity_id only).
        if knn_hit.source == "candidate" and not knn_hit.entity_id:
            entity_id = _insert_candidate_entity(
                client=client,
                normalized=knn_hit.canonical_name or normalized,
                lang=lang,
                knowledge_space_id=knowledge_space_id,
                entity_type=knn_hit.entity_type,
                confidence=knn_hit.confidence,
                merge_provenance={
                    "source": "gateway_knn_disambig",
                    "stage": "1c-ii",
                    "disambig_score": float(knn_hit.confidence),
                },
            )
            return ResolvedEntity(
                entity_id=entity_id,
                canonical_name=knn_hit.canonical_name or normalized,
                entity_type=knn_hit.entity_type,
                confidence=knn_hit.confidence,
                source="candidate",
            )
        return knn_hit

    # ★ 1b-ii: LLM type 분류 (★ candidate 의 type 결정)
    entity_type, type_confidence = _classify_type_with_llm(normalized, lang)

    # ★ 1c-ii: candidate 새 entity ES insert. ★ v3 §2 verbatim:
    # "모든 entity 참조 = entity_id. ★ 문자열 저장 경로 제거." 따라서
    # gateway 는 ★ 반드시 entity_id 를 반환해야 한다 — 빈 문자열 path 폐기.
    entity_id = _insert_candidate_entity(
        client=client,
        normalized=normalized,
        lang=lang,
        knowledge_space_id=knowledge_space_id,
        entity_type=entity_type,
        confidence=type_confidence,
        merge_provenance={"source": "gateway_candidate", "stage": "1c-ii"},
    )

    return ResolvedEntity(
        entity_id=entity_id,
        canonical_name=normalized,
        entity_type=entity_type,
        confidence=type_confidence,
        source="candidate",
    )


# ---------------------------------------------------------------------------
# ★ 1b-i: exact match cascade (★ entity_resolver 의 5-tier verbatim 흡수)
# ---------------------------------------------------------------------------

# ★ 1b-i 의 5-tier (★ entity_resolver 의 verbatim 흡수):
#   1. primary_label
#   2. name
#   3. name_en
#   4. aliases
#   (★ co_mention_en 는 gateway 외부 — 1c 에서 caller 가 책임)
_EXACT_FIELDS: tuple[str, ...] = (
    "primary_label",
    "name",
    "name_en",
    "aliases",
)


def _exact_match_cascade(
    *,
    client: Any,
    normalized: str,
    knowledge_space_id: str,
) -> Optional[ResolvedEntity]:
    """★ 1b-i: 5-tier exact-match path (★ entity_resolver._lookup_by_field 로직).

    Returns ResolvedEntity(source="exact", confidence=1.0) on hit, else None.
    ★ entity_resolver.py 호출 X — ★ 로직만 재구현.
    """
    for field in _EXACT_FIELDS:
        try:
            resp = client.search(
                index=LUCID_OBJECTS,
                size=1,
                query={"bool": {"filter": [
                    {"term": {"knowledge_space_id": knowledge_space_id}},
                    {"term": {field: normalized}},
                ]}},
            )
        except Exception:  # noqa: BLE001 — gateway 가 raise X (★ degrade quietly)
            continue
        hits = (resp.get("hits") or {}).get("hits") or []
        if not hits:
            continue
        top = hits[0]
        src = top.get("_source") or {}
        # ★ entity_id = _id 우선, object_uid fallback (★ 두 path 모두 entity_resolver 에 존재)
        entity_id = top.get("_id") or src.get("object_uid") or ""
        # ★ entity_type: entity_type 필드 우선 (★ entity-layer-restore), class fallback
        entity_type_raw = (
            src.get("entity_type")
            or src.get("class")
            or "concept"
        )
        return ResolvedEntity(
            entity_id=entity_id,
            canonical_name=src.get("primary_label") or src.get("name") or normalized,
            entity_type=_coerce_to_v3(entity_type_raw),
            confidence=1.0,
            source="exact",
        )
    return None


# ---------------------------------------------------------------------------
# ★ PO 2026-06-30: cross-lingual canonical check (★ 삼성전자 ↔ Samsung Electronics)
# ---------------------------------------------------------------------------

# ★ BM25 후보 수 — 너무 크면 Claude 입력 토큰 폭주, 너무 작으면 cross-lingual
# 후보 누락. 8 = 한 KS 안 동일 class 의 자주 거론된 entity 다 잡기 충분.
CROSS_LINGUAL_CANDIDATE_K: int = 8

# ★ Claude 호출 비용 절감: 후보 0 개면 호출 skip.
# ★ Claude 가 너무 자주 "같다" 라고 거짓 양성을 내면 ★ off 로 켜는 env knob.
_CROSS_LINGUAL_SYSTEM_PROMPT = (
    "You are a cross-lingual entity canonicalizer. Given a new surface form "
    "and a list of existing entities (with names, name_en, aliases, class), "
    "decide if the new surface refers to the SAME REAL-WORLD ENTITY as one "
    "of the candidates.\n\n"
    "★ Cross-lingual focus: 삼성전자 = Samsung Electronics, SK하이닉스 = "
    "SK Hynix, 현대자동차 = Hyundai Motor. Also handle abbreviation "
    "(SK Inc. ≠ SK하이닉스), translation variants (한국은행 = Bank of "
    "Korea), and transliteration (스페이스X = SpaceX).\n\n"
    "★ Rules:\n"
    "- ONLY match if you are HIGHLY confident the two surfaces denote the "
    "  same legal/real entity (not just a related entity).\n"
    "- '삼성' (parent) ≠ '삼성전자' (subsidiary).\n"
    "- 'Samsung Group' ≠ 'Samsung Electronics'.\n"
    "- 'SK' alone is ambiguous — DO NOT match to 'SK하이닉스' or 'SK텔레콤' "
    "  unless context disambiguates.\n"
    "- Different classes (organization vs person) → NEVER match.\n\n"
    "Output ONLY a single JSON object: "
    '{"match_index": <int or null>, "confidence": <0.0-1.0>, '
    '"reason": "<short string>"}\n'
    "- match_index = 0-based index into the candidates list, or null if no "
    "  match.\n"
    "- confidence < 0.85 → treat as null (the caller will ignore).\n"
    "★ no prose, no markdown fence."
)

# ★ 같은 entity 로 판정되려면 Claude confidence ≥ 0.85 필요. 너무 낮추면
# false-positive (옛 SK Inc. 와 SK하이닉스 잘못 묶임), 너무 높이면 false-negative.
CROSS_LINGUAL_MIN_CONFIDENCE: float = 0.85


def _fetch_cross_lingual_candidates(
    *,
    client: Any,
    surface: str,
    normalized: str,
    knowledge_space_id: str,
) -> list[dict[str, Any]]:
    """★ BM25 후보 수집 (★ name / name_en / aliases / primary_label).

    ★ 두 surface 다 시도 (★ "삼성전자" 입력 → name_en 분석기는 koren X →
    한국어 surface 가 name_en 분석기로 안 잡혀도 ★ name 분석기로 잡힘).
    ★ multi_match 의 best_fields 로 OR 결합.
    """
    # ★ 입력 surface 와 정규화된 surface 둘 다 BM25 — normalize 가 brand alias
    # 영문 변환을 이미 했으면 영문 surface 가 name_en 에 hit 가능.
    queries = [normalized]
    if surface and surface.strip() and surface.strip() != normalized:
        queries.append(surface.strip())

    hits: list[dict[str, Any]] = []
    seen_ids: set[str] = set()
    for q in queries:
        try:
            resp = client.search(
                index=LUCID_OBJECTS,
                size=CROSS_LINGUAL_CANDIDATE_K,
                query={
                    "bool": {
                        "filter": [
                            {"term": {"knowledge_space_id": knowledge_space_id}},
                        ],
                        "must": [
                            {
                                "multi_match": {
                                    "query": q,
                                    "fields": [
                                        "name^2",
                                        "name_en^2",
                                        "aliases",
                                        "primary_label",
                                    ],
                                    "type": "best_fields",
                                }
                            }
                        ],
                    }
                },
            )
        except Exception:  # noqa: BLE001 - degrade quietly
            continue
        for h in (resp.get("hits") or {}).get("hits") or []:
            hid = h.get("_id")
            if not hid or hid in seen_ids:
                continue
            seen_ids.add(hid)
            hits.append(h)
            if len(hits) >= CROSS_LINGUAL_CANDIDATE_K:
                break
        if len(hits) >= CROSS_LINGUAL_CANDIDATE_K:
            break
    return hits


def _cross_lingual_canonical_check(
    *,
    client: Any,
    surface: str,
    normalized: str,
    lang: str,
    knowledge_space_id: str,
) -> Optional[ResolvedEntity]:
    """★ PO 2026-06-30: BM25 후보 → Claude "동일 entity?" → alias 추가.

    Returns ResolvedEntity(source="exact", confidence=conf) if Claude
    confirms cross-lingual canonical match, else None.

    ★ Degrade quietly: Claude 호출 실패 / claude_client import 실패 /
    환경변수로 disabled / candidate 0개 → None (★ 후속 kNN / candidate path).

    ★ Match 성공 시: 새 surface 를 ★ 기존 entity 의 aliases 에 추가
    (★ best-effort, 실패는 silent — match 자체는 유효).
    """
    if not _cross_lingual_enabled():
        return None
    # ★ Short-circuit when Claude is unreachable so we don't burn ES
    # searches in test envs / no-key envs. The check needs Claude — without
    # it, BM25 alone isn't a canonical decision (★ false-positive 위험).
    if not os.getenv("ANTHROPIC_API_KEY"):
        return None

    candidates = _fetch_cross_lingual_candidates(
        client=client,
        surface=surface,
        normalized=normalized,
        knowledge_space_id=knowledge_space_id,
    )
    if not candidates:
        return None

    # ★ Claude 입력으로 펴치기 (★ 한국어 + 영어 surface 다 포함)
    candidate_view: list[dict[str, Any]] = []
    for h in candidates:
        s = h.get("_source") or {}
        candidate_view.append({
            "name": s.get("name") or "",
            "name_en": s.get("name_en") or "",
            "aliases": list(s.get("aliases") or [])[:6],
            "class": s.get("class") or s.get("entity_type") or "",
            "primary_lang": s.get("primary_lang") or "",
        })

    try:
        from api.structure.claude_client import call_claude_structured
    except Exception as exc:  # noqa: BLE001
        logger.info(
            "cross-lingual canonical: claude_client import failed for %r: %s",
            normalized, exc,
        )
        return None

    import json as _json
    user_prompt = (
        f"new_surface: {normalized!r}\n"
        f"original_input: {surface!r}\n"
        f"source language: {lang}\n\n"
        "candidates (0-indexed):\n"
        + _json.dumps(candidate_view, ensure_ascii=False, indent=2)
        + "\n\nWhich candidate (if any) denotes the SAME entity? JSON only."
    )

    try:
        import os as _os
        chosen_model = _os.getenv(
            "CLAUDE_CANONICAL_MODEL",
            _os.getenv("CLAUDE_CLASSIFY_MODEL", "claude-sonnet-4-6"),
        )
        parsed = call_claude_structured(
            system_prompt=_CROSS_LINGUAL_SYSTEM_PROMPT,
            user_prompt=user_prompt,
            max_tokens=120,
            model=chosen_model,
        )
    except Exception as exc:  # noqa: BLE001
        logger.info(
            "cross-lingual canonical Claude call failed for %r: %s",
            normalized, exc,
        )
        return None

    if not isinstance(parsed, dict):
        return None
    match_index = parsed.get("match_index")
    raw_conf = parsed.get("confidence")
    reason = parsed.get("reason") if isinstance(parsed.get("reason"), str) else ""

    if match_index is None:
        return None
    if not isinstance(match_index, int):
        try:
            match_index = int(match_index)
        except (TypeError, ValueError):
            return None
    if match_index < 0 or match_index >= len(candidates):
        return None
    try:
        confidence = float(raw_conf) if raw_conf is not None else 0.0
    except (TypeError, ValueError):
        confidence = 0.0
    if confidence < CROSS_LINGUAL_MIN_CONFIDENCE:
        logger.info(
            "cross-lingual canonical: low confidence %.3f for %r → reject "
            "(reason=%s)", confidence, normalized, reason[:80],
        )
        return None

    matched = candidates[match_index]
    src = matched.get("_source") or {}
    entity_id = matched.get("_id") or src.get("object_uid") or ""
    if not entity_id:
        return None
    entity_type_raw = (
        src.get("entity_type")
        or src.get("class")
        or "concept"
    )

    # ★ Best-effort alias 추가 — 실패해도 match 자체는 유효.
    _append_alias_best_effort(
        client=client,
        entity_id=entity_id,
        new_surface=surface.strip() if surface and surface.strip() else normalized,
        existing_aliases=list(src.get("aliases") or []),
    )

    logger.info(
        "cross-lingual canonical match: %r → entity_id=%s confidence=%.3f "
        "(reason=%s)", normalized, entity_id[:8], confidence, reason[:80],
    )
    return ResolvedEntity(
        entity_id=entity_id,
        canonical_name=src.get("primary_label") or src.get("name") or normalized,
        entity_type=_coerce_to_v3(entity_type_raw),
        confidence=confidence,
        # ★ source="exact" — caller / downstream metrics 가 ★ 동일하게 취급.
        # cross-lingual canonical 은 ★ exact 의 한 종류 (★ Claude 가 별칭 동치 확인).
        source="exact",
    )


# ★ Alias 비대 가드 — 너무 많아지면 ES doc bloat. 32 = 충분히 크고
# 한 entity 의 cross-lingual / abbreviation / typo variant 다 잡기 충분.
ALIAS_MAX_PER_ENTITY: int = 32


def _append_alias_best_effort(
    *,
    client: Any,
    entity_id: str,
    new_surface: str,
    existing_aliases: list[str],
) -> None:
    """★ Best-effort: append new_surface to entity.aliases if absent.

    ★ Silent degrade — ES update 실패해도 caller 는 ★ 영향 받지 않음.
    ★ Dedup: existing aliases 안에 이미 있으면 skip.
    ★ Cap: ALIAS_MAX_PER_ENTITY 초과 시 skip (★ doc bloat 방지).
    """
    if not entity_id or not new_surface:
        return
    surface = new_surface.strip()
    if not surface:
        return
    # ★ dedup (case-insensitive 한 비교 — 한국어는 그대로, 영어는 lower)
    existing_lower = {str(a).strip().lower() for a in existing_aliases if a}
    if surface.lower() in existing_lower:
        return
    if len(existing_aliases) >= ALIAS_MAX_PER_ENTITY:
        logger.info(
            "alias cap reached for entity_id=%s (%d aliases) — skip %r",
            entity_id[:8], len(existing_aliases), surface,
        )
        return
    try:
        client.update(
            index=LUCID_OBJECTS,
            id=entity_id,
            script={
                "source": (
                    "if (ctx._source.aliases == null) { "
                    "ctx._source.aliases = []; "
                    "} "
                    "if (!ctx._source.aliases.contains(params.alias)) { "
                    "ctx._source.aliases.add(params.alias); "
                    "}"
                ),
                "lang": "painless",
                "params": {"alias": surface},
            },
            refresh="wait_for",
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning(
            "alias append best-effort failed for entity_id=%s alias=%r: %s",
            entity_id[:8], surface, exc,
        )


# ---------------------------------------------------------------------------
# ★ 1b-iv: embedding kNN 다단계 band (★ object_matcher 0.70-0.95 흡수)
# ---------------------------------------------------------------------------

# ★ object_matcher 의 DCR-001 / DR-065 threshold verbatim:
#   AUTO_THRESHOLD_TIGHT = 0.98  (Person / Organization / Service)
#   AUTO_THRESHOLD_STANDARD = 0.95
#   DISAMBIG_FLOOR = 0.70
# ★ Gateway 의 1a stub = 0.85 → 1b-iv 의 ★ 다단계 band 로 교체.
#
# ★ Gateway 가 candidate_class 를 모르므로 STANDARD threshold 사용.
# ★ 1c 에서 caller 가 class hint 주입 시 TIGHT 적용.
KNN_AUTO_THRESHOLD: float = 0.95   # ★ object_matcher AUTO_THRESHOLD_STANDARD
KNN_DISAMBIG_FLOOR: float = 0.70   # ★ object_matcher DISAMBIG_FLOOR


def _embedding_knn_match(
    *,
    client: Any,
    normalized: str,
    knowledge_space_id: str,
) -> Optional[ResolvedEntity]:
    """★ 1b-iv: embedding kNN 검색 + 다단계 band 판정.

    Band:
      score >= 0.95  → source="embedding" auto-merge
      0.70 ≤ score < 0.95 → source="candidate" (★ disambig — P2 사용자 통합)
      score < 0.70   → ★ no match (★ candidate via LLM classification)

    ★ object_matcher.py 호출 X — ★ 로직만 재구현.
    """
    vec = get_embedding(normalized)
    if vec is None:
        return None

    try:
        knn_resp = client.search(
            index=LUCID_OBJECTS,
            size=3,
            query={"bool": {"filter": [
                {"term": {"knowledge_space_id": knowledge_space_id}},
            ]}},
            knn={
                "field": "embedding",
                "query_vector": list(vec),
                "k": 3,
                "num_candidates": 50,
            },
        )
    except Exception:  # noqa: BLE001
        return None

    hits = (knn_resp.get("hits") or {}).get("hits") or []
    if not hits:
        return None

    top = hits[0]
    score = float(top.get("_score") or 0.0)
    src = top.get("_source") or {}

    # ★ Auto band: 0.95+
    if score >= KNN_AUTO_THRESHOLD:
        entity_id = top.get("_id") or src.get("object_uid") or ""
        entity_type_raw = (
            src.get("entity_type")
            or src.get("class")
            or "concept"
        )
        return ResolvedEntity(
            entity_id=entity_id,
            canonical_name=src.get("primary_label") or src.get("name") or normalized,
            entity_type=_coerce_to_v3(entity_type_raw),
            confidence=score,
            source="embedding",
        )

    # ★ Disambig band: 0.70-0.95 (★ candidate + 후보 표시 — P2)
    if score >= KNN_DISAMBIG_FLOOR:
        # ★ 1b-iv 의 ★ 후보 표시: entity_id 비움 (★ caller 가 candidate 처리),
        # canonical_name 은 top hit 의 surface 보존 (★ 사용자에게 보여줄 후보 label)
        entity_type_raw = (
            src.get("entity_type")
            or src.get("class")
            or "concept"
        )
        return ResolvedEntity(
            entity_id="",
            canonical_name=normalized,  # ★ 입력 surface 유지 (★ candidate 의 정체)
            entity_type=_coerce_to_v3(entity_type_raw),
            confidence=score,
            source="candidate",
        )

    # ★ < 0.70 → ★ no match (★ LLM 분류 path 로 fallthrough)
    return None


# ---------------------------------------------------------------------------
# ★ 1b-ii: LLM type 분류 (★ v3 10종 closed set)
# ---------------------------------------------------------------------------

# ★ Heuristic hints (★ stub — 1b-ii final 에서 Claude structured output 으로 교체)
# ★ Patterns are deliberate ★ closed-set safe (모두 v3 10종 안).
_TYPE_HINT_PATTERNS: tuple[tuple[str, tuple[str, ...]], ...] = (
    # organization
    ("organization", (
        "주식회사", "협회", "법인", "기관", "위원회", "재단",
        "ltd", "inc", "corp", "company", "co.", "llc", "gmbh",
    )),
    # location
    ("location", (
        "시", "도", "구", "동", "읍", "면", "리",
        "city", "country", "state", "province",
    )),
    # person (★ titles / honorifics)
    ("person", (
        "씨", "님", "박사", "교수", "의원", "대통령", "총리", "장관",
        "mr.", "ms.", "dr.", "prof.",
    )),
    # event
    ("event", (
        "회의", "회담", "정상회담", "컨퍼런스", "summit", "conference",
        "meeting", "workshop",
    )),
    # metric
    ("metric", (
        "지수", "비율", "rate", "index", "ratio", "kpi",
    )),
    # task
    ("task", (
        "작업", "업무", "과제", "task", "todo",
    )),
    # resource (★ documents / artifacts)
    ("resource", (
        "보고서", "문서", "기사", "논문", "report", "document",
        "paper", "article",
    )),
)


_LLM_CLASSIFY_SYSTEM_PROMPT = (
    "You are an entity-type classifier. Given a single surface form, "
    "classify it into EXACTLY ONE of the v3 10-type closed set:\n"
    "  person, organization, group, knowledge, resource, task, "
    "concept, event, metric, location\n\n"
    "★ v3 Carley 분류 기준:\n"
    "- person: 사람 이름 (홍길동, Elon Musk)\n"
    "- organization: 공식·법적 실체 (Samsung, 한국은행, 보건복지부)\n"
    "- group: 비공식·창발 묶음 (지지층, 시민단체)\n"
    "- knowledge: 전문영역·노하우·정보자산 (반도체 기술, AI, 청사진)\n"
    "- resource: 예산·자원·물자·제품 (예산, 희토류, Vision Pro, 메모리 팹)\n"
    "- task: 정책·절차·법안·역할·프로젝트 (탄핵 의결, 메가프로젝트, 종합계획)\n"
    "- concept: 추상개념·주제 (자본주의, 민주주의)\n"
    "- event: 명명된 사건 거점 (6·3부정선거, IMF사태, 팬데믹)\n"
    "- metric: 지표 (GDP, MAU, 환율, 시세)\n"
    "- location: 장소 (서울, 광주·전남, 미국)\n\n"
    "Output ONLY a single JSON object: "
    '{"type": "<one_of_10>", "confidence": <0.0-1.0>}\n'
    "★ no prose, no explanation, no markdown fence."
)


def _classify_type_with_llm(surface: str, lang: str) -> tuple[str, float]:
    """
    ★ 1b-ii final: Claude structured output 으로 entity_type 분류.

    Returns (entity_type, confidence).

    PO 2026-06-30: heuristic stub (★ 한국어 명사구 분류 불가) → ★ 진짜
    Claude 호출. ANTHROPIC_API_KEY 없거나 호출 실패 시 heuristic fallback.

    Resilience:
      - API key 미설정 / SDK 미설치 / 호출 실패 → heuristic fallback
        (confidence 0.3 로 표시 — 낮은 신뢰)
      - LLM JSON 깨짐 → heuristic fallback
      - v3 10종 외 type → concept (confidence 감소 0.3 floor)
    """
    if not surface:
        return ("concept", 0.0)

    bare = surface.strip()
    if not bare:
        return ("concept", 0.0)

    # ★ Claude 진짜 호출 (★ call_claude_structured = claude_client 의 helper)
    # ★ import locally so the gateway module stays importable without the
    # anthropic SDK installed (e.g. lightweight test envs).
    try:
        from api.structure.claude_client import call_claude_structured
    except Exception as exc:  # noqa: BLE001
        logger.warning(
            "LLM classify: claude_client import failed for %r: %s — "
            "fallback heuristic", bare, exc,
        )
        return (_classify_type_heuristic(bare, lang), 0.3)

    user_prompt = (
        f"surface: {bare!r}\n"
        f"source language: {lang}\n\n"
        "Classify into one of the 10 v3 types. JSON only."
    )

    try:
        # ★ PO 2026-06-30 dogfood: Haiku 4.5 = 한국 정치 entity 약함
        # (이준석 대표/선관위 → "기타"). ★ Sonnet 4.6 상향 = 분류 품질 = 메타네트워크
        # 입구. 분류는 캡처당 1회라 비용 영향 작음. (★ 나머지 요약 등은 Haiku 유지 — 분류만)
        # CLAUDE_CLASSIFY_MODEL env 로 override 가능.
        import os as _os
        chosen_model = _os.getenv("CLAUDE_CLASSIFY_MODEL", "claude-sonnet-4-6")
        parsed = call_claude_structured(
            system_prompt=_LLM_CLASSIFY_SYSTEM_PROMPT,
            user_prompt=user_prompt,
            max_tokens=80,
            model=chosen_model,
        )
    except Exception as exc:  # noqa: BLE001 - any failure -> heuristic fallback
        logger.warning(
            "LLM classify Claude call failed for %r: %s — fallback heuristic",
            bare, exc,
        )
        return (_classify_type_heuristic(bare, lang), 0.3)

    raw_type = parsed.get("type") if isinstance(parsed, dict) else None
    raw_conf = parsed.get("confidence") if isinstance(parsed, dict) else None

    if not isinstance(raw_type, str):
        logger.warning(
            "LLM classify: missing/non-string 'type' for %r (got %r) — "
            "fallback heuristic", bare, parsed,
        )
        return (_classify_type_heuristic(bare, lang), 0.3)

    entity_type = raw_type.strip().lower()
    try:
        confidence = float(raw_conf) if raw_conf is not None else 0.5
    except (TypeError, ValueError):
        confidence = 0.5
    # clamp [0.0, 1.0]
    if confidence < 0.0:
        confidence = 0.0
    elif confidence > 1.0:
        confidence = 1.0

    # ★ v3 10종 외 → concept fallback, confidence 감소 (floor 0.3)
    if entity_type not in _ENTITY_TYPE_V3_SET:
        logger.info(
            "LLM classify: out-of-set type %r for %r — coerce to 'concept'",
            entity_type, bare,
        )
        return ("concept", min(confidence, 0.3))

    return (entity_type, confidence)


def _classify_type_heuristic(surface: str, lang: str) -> str:
    """★ Heuristic fallback (★ Claude 호출 실패 시 보존).

    ★ 옛 stub 의 명백한 패턴 매칭만 — Korean 명사구 일반은 'concept' 로 떨어진다.
    Claude 호출이 성공하면 호출되지 않는다.
    """
    if not surface:
        return "concept"
    s = surface.lower()
    for entity_type, patterns in _TYPE_HINT_PATTERNS:
        for pat in patterns:
            if pat in s:
                return entity_type
    return "concept"


# ---------------------------------------------------------------------------
# ★ 1c-ii: candidate entity ES insert (★ entity_id 채움)
# ---------------------------------------------------------------------------

def _insert_candidate_entity(
    *,
    client: Any,
    normalized: str,
    lang: str,
    knowledge_space_id: str,
    entity_type: str,
    confidence: float,
    merge_provenance: dict[str, Any] | None = None,
) -> str:
    """★ 1c-ii: persist a candidate (★ source="candidate") entity to
    lucid_objects and return its fresh entity_id.

    ★ v3 §2 verbatim:
        "Entity (노드의 원천): entity_id (canonical, 영구), type (★ 10종
         closed), canonical_name, aliases[], attributes,
         merge_provenance (통합/분리 이력 — 되돌릴 수 있게)"

    Writes the canonical v3 entity fields PLUS the legacy back-compat
    fields (`class` / `entity_type` / `name` / `primary_label`) so the
    existing recall / Decide UI display paths keep resolving labels.

    Errors degrade quietly to a fresh new_uid() so the caller never sees
    a blank entity_id (★ contract: entity_id always non-empty). The ES
    insert failure is logged at WARNING.
    """
    entity_id = new_uid()
    # REQ-004 STAGE 1b-ii final (★ PO 2026-06-30): confidence < 0.5 →
    # needs_review marker. Claude classifier may emit a low-confidence
    # type when the surface is ambiguous (e.g. "AI 코리아" — knowledge?
    # task? resource?). ES `lucid_objects` index has strict_dynamic_mapping
    # = top-level new fields rejected — so the needs_review / confidence
    # signal goes into `properties` (a dynamic_object field) instead.
    needs_review = bool(confidence < 0.5)
    # ★ PO 2026-06-30: 옛 entity 169 / 0 = embedding 누락. ★ candidate
    # insert 시 embedding 생성해서 ★ future kNN 가능하게. get_embedding 은
    # OPENAI_API_KEY 없으면 None — None 이면 field 생략 (★ mapping strict O,
    # 다만 embedding 은 optional dense_vector).
    embedding_vec = None
    try:
        _ev = get_embedding(normalized)
        if _ev is not None:
            embedding_vec = list(_ev)
    except Exception as exc:  # noqa: BLE001
        logger.info(
            "candidate insert: embedding generation failed for %r: %s "
            "(persist without embedding)", normalized, exc,
        )

    body: dict[str, Any] = {
        "object_uid": entity_id,
        # v3 §3 closed-set type (★ 10종)
        "class": entity_type,
        "entity_type": entity_type,
        # Canonical natural surface — recall display reads `name`.
        "name": normalized,
        "primary_label": normalized,
        "primary_lang": lang,
        "aliases": [],
        "properties": {
            # ★ STAGE 1b-ii final: confidence + needs_review under properties
            # (★ strict_dynamic_mapping safe — properties is dynamic_object).
            "type_confidence": float(confidence),
            "needs_review": needs_review,
            # ★ STAGE 1c-ii hotfix (PO 2026-06-30): relabel_history mapping
            # 은 strict + {at, from_primary, to_primary, reason} 만 허용.
            # 따라서 lang / confidence / merge_provenance 는 strict reject →
            # entity ES insert 전체 실패 (★ orphan UUID 양산). v3 schema
            # 변경 없이 hotfix 하기 위해 부가 정보를 dynamic_object 인
            # `properties` 로 옮긴다 (mapping migration 불필요).
            "candidate_insert_lang": lang,
            "candidate_insert_confidence": float(confidence),
            "candidate_insert_merge_provenance": dict(merge_provenance or {}),
        },
        "fact_uids": [],
        "connected_objects": [],
        "knowledge_space_id": knowledge_space_id,
        # ★ 1c-ii hotfix: relabel_history 는 strict mapping —
        # {at, from_primary, to_primary, reason} 만 허용. 다른 필드
        # (to_primary_lang / confidence / merge_provenance) 는 strict
        # reject → entity insert 전체 실패. 부가 정보는 properties 로
        # 이동했고, 여기서는 옛 schema 의 허용 필드만 기록한다.
        "relabel_history": [
            {
                "from_primary": "",
                "to_primary": normalized,
                "reason": "REQ-004 STAGE 1c-ii gateway candidate insert",
            }
        ],
    }
    if embedding_vec is not None:
        body["embedding"] = embedding_vec
    try:
        client.index(
            index=LUCID_OBJECTS,
            id=entity_id,
            document=body,
            refresh="wait_for",
        )
    except Exception as exc:  # noqa: BLE001 - gateway must never raise out
        logger.warning(
            "REQ-004-1c-ii candidate insert failed for %r (type=%s): %s — "
            "returning entity_id without ES persistence.",
            normalized, entity_type, exc,
        )
    return entity_id


def _coerce_to_v3(entity_type_raw: Any) -> str:
    """★ ES 의 legacy class/entity_type 값을 ★ v3 10종 closed set 으로 강제.

    ★ Out-of-set 값 (★ "PROCEDURE", "PROBLEM", "CT", "place" 등) → "concept".
    ★ This is the v3 §3 closed-set enforcement at the gateway boundary.
    """
    if not isinstance(entity_type_raw, str):
        return "concept"
    candidate = entity_type_raw.strip().lower()
    if candidate in _ENTITY_TYPE_V3_SET:
        return candidate
    # ★ legacy mapping (★ "place" → "location" 같은 안전 변환은 1c 에서 검토)
    return "concept"
