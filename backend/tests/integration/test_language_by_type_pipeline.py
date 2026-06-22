"""B-62-fix-v7 end-to-end pipeline tests (PO 2026-06-22).

feat/spo-subject-language-by-type — type-based language dispatch.

Each test drives `process_extracted_job` with a fully mocked DB session
(mirroring `test_production_pipeline_natlang.py`) and a decompose stub
that emits a synthetic `StructureResult` carrying a specific
`entity_type` / `person_origin`. We intercept `resolve_entity` to
assert what surface + candidate_name landed in the resolver call —
which determines the final `primary_label`.

Categories covered (PO's ★ acceptance):

  1. Korean company (에이비옥스 → AeroVironment)
  2. Korean country (일본 → 일본)
  3. Korean government (중국 상무부 → 중국 상무부)
  4. Korean person (안도걸 의원 → 안도걸 의원)
  5. Non-Korean person (Trump → Donald Trump)
  6. Legacy entity_type=None falls back to 6th-round behavior.
"""
from __future__ import annotations

import uuid
from unittest.mock import MagicMock, patch

import pytest

from api.models.objects import ObjectClass
from api.models.source_job import SourceStatus
from api.structure.models import (
    StructureFact,
    StructureFactObjectLink,
    StructureObject,
    StructureResult,
)
from api.structure.processor import process_extracted_job

pytestmark = pytest.mark.integration

KS = "ks-language-by-type-pipeline"


def _make_job(text: str) -> MagicMock:
    job = MagicMock()
    job.id = uuid.uuid4()
    job.status = SourceStatus.EXTRACTED.value
    job.extracted_text = text
    job.extracted_metadata = {}
    job.source_url = "https://example.com/article"
    job.captured_from = "web"
    job.knowledge_space_id = KS
    return job


def _decomp(
    *,
    name: str,
    name_en: str | None,
    obj_class: ObjectClass,
    entity_type: str | None,
    person_origin: str | None,
    claim: str,
    subject_surface: str | None,
) -> StructureResult:
    obj = StructureObject(
        uid="obj-1",
        class_=obj_class,
        name=name,
        name_en=name_en,
        entity_type=entity_type,
        person_origin=person_origin,
        properties={},
    )
    fact = StructureFact(
        uid="fn-1",
        type_="proposition",
        claim=claim,
        subject_uid="obj-1",
        subject_surface=subject_surface,
        object_surface=None,
        predicate="announces",
        object_value="결과",
        negation_flag=False,
        negation_scope=None,
        tags_suggested=[],
    )
    link = StructureFactObjectLink(
        fact_uid="fn-1",
        object_uid="obj-1",
        link_type="involves",
        properties={},
    )
    return StructureResult(
        objects=[obj],
        facts=[fact],
        fact_object_links=[link],
        fact_fact_links=[],
        disambiguation_candidates=[],
        extraction_status="success",
        failure_reason=None,
        model_used="claude-sonnet-4-5",
        latency_ms=10,
    )


def _patched_session(job):
    session = MagicMock()
    session.get.return_value = job
    return session


def _capture_resolver_call(job, decomp) -> dict:
    """Run the pipeline. Intercept `resolve_entity` to capture the
    kwargs it was called with. Returns a dict with:
      - `surface`:    first positional arg to resolve_entity (the
                      verbatim source-text span the dispatch resolved to)
      - `lang`:       second positional arg
      - `space_id`:   kwarg
      - `co_mention_en`: kwarg (LLM `name_en`)
      - `llm_name`:   kwarg (candidate_name from processor = obj.name
                      or override)

    `resolve_entity` returns `(entity_uid, was_created)`; the mock
    returns a deterministic tuple so `match_or_create_object` can
    build a `MatchResult` and the pipeline continues.
    """
    captured: dict = {}

    def _resolve_entity_mock(surface, lang, *, space_id, co_mention_en=None,
                              llm_name=None, **kwargs):
        captured["surface"] = surface
        captured["lang"] = lang
        captured["space_id"] = space_id
        captured["co_mention_en"] = co_mention_en
        captured["llm_name"] = llm_name
        # match_or_create_object expects (entity_uid, was_created).
        return (str(uuid.uuid4()), True)

    session = _patched_session(job)
    with patch(
        "api.structure.processor.make_sessionmaker",
        return_value=lambda: session,
    ), patch(
        "api.structure.processor.decompose", return_value=decomp,
    ), patch(
        "api.structure.processor.get_embedding",
        return_value=[0.1] * 1536,
    ), patch(
        "api.structure.object_matcher.resolve_entity",
        side_effect=_resolve_entity_mock,
    ):
        process_extracted_job(job.id)
    return captured


# ─── 1. Korean company → English canonical ───────────────────────────


def test_pipeline_company_keeps_english_canonical() -> None:
    """Primary acceptance: 에이비옥스가 ... → AeroVironment.

    The 6th round (`feat/spo-subject-claim-recovery`) would have
    over-corrected via claim recovery → '에이비옥스'. With
    entity_type='company' dispatch, the LLM English `name` is
    preserved as candidate_name, and surface is the LLM's verbatim
    Korean (still routed for alias seeding, but `pick_natural_primary`
    accepts the brand-shaped Latin canonical)."""
    claim = "에이비옥스가 거래 종목에 포함되었다."
    decomp = _decomp(
        name="AeroVironment",
        name_en="AeroVironment",
        obj_class=ObjectClass.ORGANIZATION,
        entity_type="company",
        person_origin=None,
        claim=claim,
        subject_surface="에이비옥스",
    )
    job = _make_job(claim)
    captured = _capture_resolver_call(job, decomp)
    # `llm_name` is the candidate_name the processor handed to the
    # resolver. company dispatch keeps the LLM English canonical.
    assert captured["llm_name"] == "AeroVironment"
    # `surface` is the verbatim source-text span — the LLM-supplied
    # Korean. The English canonical wins as primary_label via
    # `pick_natural_primary` because "AeroVironment" is brand-shaped
    # (single Latin token, 13 chars).
    assert captured["surface"] == "에이비옥스"
    assert captured["co_mention_en"] == "AeroVironment"


# ─── 2. Korean country → Korean ──────────────────────────────────────


def test_pipeline_country_recovers_korean() -> None:
    """country dispatch fires claim recovery; candidate_name is
    overridden with the recovered Korean."""
    claim = "일본은 무기 수출 규제를 완화했다."
    decomp = _decomp(
        name="Japan",
        name_en="Japan",
        obj_class=ObjectClass.PLACE,
        entity_type="country",
        person_origin=None,
        claim=claim,
        subject_surface="Japan",
    )
    job = _make_job(claim)
    captured = _capture_resolver_call(job, decomp)
    # country dispatch overrode the candidate_name with the recovered
    # Korean; surface is the recovered Korean too.
    assert captured["llm_name"] == "일본"
    assert captured["surface"] == "일본"
    assert captured["lang"] == "ko"


# ─── 3. Korean government → Korean ──────────────────────────────────


def test_pipeline_government_recovers_korean() -> None:
    """government dispatch fires claim recovery; '22일' is stripped."""
    claim = "22일 중국 상무부는 미국의 수출통제에 대응했다."
    decomp = _decomp(
        name="Ministry of Commerce of China",
        name_en="Ministry of Commerce of China",
        obj_class=ObjectClass.ORGANIZATION,
        entity_type="government",
        person_origin=None,
        claim=claim,
        subject_surface="Ministry of Commerce of China",
    )
    job = _make_job(claim)
    captured = _capture_resolver_call(job, decomp)
    assert captured["llm_name"] == "중국 상무부"
    assert captured["surface"] == "중국 상무부"
    assert captured["lang"] == "ko"


# ─── 4. Korean person → Korean ──────────────────────────────────────


def test_pipeline_korean_person_recovers_korean() -> None:
    """person + person_origin='ko' → claim recovery."""
    claim = "안도걸 더불어민주당 의원은 청문회에서 발언했다."
    decomp = _decomp(
        name="Ahn Do-geol",
        name_en="Ahn Do-geol",
        obj_class=ObjectClass.PERSON,
        entity_type="person",
        person_origin="ko",
        claim=claim,
        subject_surface="Ahn Do-geol",
    )
    job = _make_job(claim)
    captured = _capture_resolver_call(job, decomp)
    assert captured["llm_name"] == "안도걸 더불어민주당 의원"
    assert captured["surface"] == "안도걸 더불어민주당 의원"
    assert captured["lang"] == "ko"


# ─── 5. Non-Korean person → English ──────────────────────────────────


def test_pipeline_non_korean_person_keeps_english() -> None:
    """person + person_origin='en' → trust LLM English canonical.
    Claim recovery is NOT triggered. The Korean transliteration
    '트럼프' is NOT promoted to candidate_name."""
    claim = "트럼프 대통령은 행정명령에 서명했다."
    decomp = _decomp(
        name="Donald Trump",
        name_en="Donald Trump",
        obj_class=ObjectClass.PERSON,
        entity_type="person",
        person_origin="en",
        claim=claim,
        subject_surface="Trump",
    )
    job = _make_job(claim)
    captured = _capture_resolver_call(job, decomp)
    # candidate_name stays the LLM English canonical; no recovery.
    # surface remains the LLM-supplied "Trump" (verbatim Latin span
    # the LLM extracted from "트럼프"). `pick_natural_primary` then
    # picks "Donald Trump" (the candidate_name) as primary_label
    # because it is brand-shaped Latin.
    assert captured["llm_name"] == "Donald Trump"
    assert captured["surface"] == "Trump"


# ─── 6. Legacy entity_type=None → 6th-round fallback ─────────────────


def test_pipeline_legacy_no_entity_type_falls_back() -> None:
    """Older captures without entity_type → else branch preserves
    the 6th-round violation+recovery flow."""
    claim = "일본은 무기 수출 규제를 완화했다."
    decomp = _decomp(
        name="Japan",
        name_en="Japan",
        obj_class=ObjectClass.PLACE,
        entity_type=None,  # legacy capture
        person_origin=None,
        claim=claim,
        subject_surface="Japan",
    )
    job = _make_job(claim)
    captured = _capture_resolver_call(job, decomp)
    # else branch fires the same recovery as 6th round → llm_name and
    # surface are both the recovered Korean.
    assert captured["llm_name"] == "일본"
    assert captured["surface"] == "일본"
