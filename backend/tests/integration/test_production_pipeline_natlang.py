"""B-62-fix-v2 resolver-wiring integration tests.

These pin the contract that the production extraction pipeline
(`processor.process_extracted_job`) routes Korean subject/object
surfaces through `resolve_entity` so the v2 defenses fire on real
captures, not just in unit tests of resolve_entity.
"""
from __future__ import annotations

import uuid
from unittest.mock import MagicMock, patch

from api.models.objects import ObjectClass
from api.models.source_job import SourceStatus
from api.structure.models import (
    StructureFact,
    StructureFactObjectLink,
    StructureObject,
    StructureResult,
)
from api.structure.processor import process_extracted_job

KS = "ks-natlang-pipeline"


def _make_job(text: str = "Korean article body") -> MagicMock:
    job = MagicMock()
    job.id = uuid.uuid4()
    job.status = SourceStatus.EXTRACTED.value
    job.extracted_text = text
    job.extracted_metadata = {}
    job.source_url = "https://example.com/ko-article"
    job.captured_from = "web"
    job.knowledge_space_id = KS
    return job


def _decomp_with_surface(
    *,
    obj_name: str,
    obj_name_en: str | None,
    subject_surface: str,
) -> StructureResult:
    """One-object, one-fact decomp where the subject carries a
    source-language surface distinct from the (possibly translated)
    obj.name. Mirrors the LLM payload after v2 prompt change."""
    obj = StructureObject(
        uid="obj-1",
        class_=ObjectClass.ORGANIZATION,
        name=obj_name,
        name_en=obj_name_en,
        properties={},
    )
    fact = StructureFact(
        uid="fn-1",
        type_="proposition",
        claim="발표했다.",
        subject_uid="obj-1",
        subject_surface=subject_surface,
        object_surface=None,
        predicate="announced",
        object_value="policy",
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
        latency_ms=100,
    )


def _patched_session(job):
    session = MagicMock()
    session.get.return_value = job
    return session


def _run(job, decomp, *, resolve_entity_mock):
    """Run process_extracted_job with decompose stubbed and
    resolve_entity intercepted so we can assert how it was called
    AND control its return value without standing up real ES."""
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
        side_effect=resolve_entity_mock,
    ):
        process_extracted_job(job.id)
    return session


def test_korean_common_noun_routes_surface_to_resolver():
    """The LLM gives an English name (translated) but a Korean
    subject_surface. The processor must pass the KOREAN surface
    (not the English name) into resolve_entity, so the v2 picker
    keeps the Korean primary_label.
    """
    job = _make_job(text="중국 상무부는 발표했다.")
    decomp = _decomp_with_surface(
        obj_name="Ministry of Commerce",
        obj_name_en="Ministry of Commerce",
        subject_surface="중국 상무부",
    )
    captured: dict = {}

    def resolve_entity_mock(surface, lang, *, space_id, co_mention_en=None,
                            llm_name=None, es_client=None):
        captured["surface"] = surface
        captured["lang"] = lang
        captured["space_id"] = space_id
        captured["co_mention_en"] = co_mention_en
        captured["llm_name"] = llm_name
        return ("entity-uid-1", True)

    _run(job, decomp, resolve_entity_mock=resolve_entity_mock)

    # The PIN: production path calls resolve_entity with the Korean
    # surface, NOT the LLM English translation.
    assert captured["surface"] == "중국 상무부"
    assert captured["lang"] == "ko"
    assert captured["space_id"] == KS
    # The LLM translated name goes into llm_name (pick_natural_primary
    # then defends the Korean surface against the English translation).
    assert captured["llm_name"] == "Ministry of Commerce"
    assert captured["co_mention_en"] == "Ministry of Commerce"


def test_brand_subject_surface_still_routes_through_resolver():
    """SpaceX captured with Korean surface 스페이스X - the surface
    still flows to resolve_entity. The brand guard inside the
    resolver decides what becomes primary; the wiring contract is
    that the production path delegates that decision."""
    job = _make_job(text="스페이스X는 발표했다.")
    decomp = _decomp_with_surface(
        obj_name="SpaceX",
        obj_name_en="SpaceX",
        subject_surface="스페이스X",
    )
    captured: dict = {}

    def resolve_entity_mock(surface, lang, *, space_id, co_mention_en=None,
                            llm_name=None, es_client=None):
        captured["surface"] = surface
        captured["llm_name"] = llm_name
        return ("entity-uid-spx", True)

    _run(job, decomp, resolve_entity_mock=resolve_entity_mock)
    assert captured["surface"] == "스페이스X"
    assert captured["llm_name"] == "SpaceX"


def test_no_surface_emitted_falls_back_to_obj_name():
    """Pre-v2 decomp payloads have no subject_surface. The processor
    must still resolve the entity by passing obj.name as the surface
    (or pass surface=None - verifying the fallback contract)."""
    job = _make_job()
    obj = StructureObject(
        uid="obj-1", class_=ObjectClass.ORGANIZATION,
        name="Toyota", properties={},
    )
    # No subject_surface set on the fact.
    fact = StructureFact(
        uid="fn-1", type_="proposition", claim="Released Q3 results.",
        subject_uid="obj-1", predicate="reported",
        object_value="results",
        negation_flag=False, negation_scope=None,
        tags_suggested=[],
    )
    link = StructureFactObjectLink(
        fact_uid="fn-1", object_uid="obj-1", link_type="involves",
        properties={},
    )
    decomp = StructureResult(
        objects=[obj], facts=[fact], fact_object_links=[link],
        fact_fact_links=[], disambiguation_candidates=[],
        extraction_status="success", failure_reason=None,
        model_used="claude-sonnet-4-5", latency_ms=50,
    )
    captured: dict = {}

    def resolve_entity_mock(surface, lang, *, space_id, co_mention_en=None,
                            llm_name=None, es_client=None):
        captured["surface"] = surface
        captured["llm_name"] = llm_name
        return ("entity-uid-toy", True)

    _run(job, decomp, resolve_entity_mock=resolve_entity_mock)
    # Fallback: with no subject_surface, the obj.name flows in as the
    # surface so resolve_entity still gets a valid lookup string.
    assert captured["surface"] == "Toyota"
    assert captured["llm_name"] == "Toyota"


def test_object_surface_also_threaded_for_obj_placeholder_object_values():
    """When fact.object_value is an obj-N placeholder (entity ref)
    and the fact has object_surface, the surface threads to the
    object resolve_entity call."""
    job = _make_job()
    subject_obj = StructureObject(
        uid="obj-1", class_=ObjectClass.ORGANIZATION,
        name="Korean Government", properties={},
    )
    target_obj = StructureObject(
        uid="obj-2", class_=ObjectClass.ORGANIZATION,
        name="Samsung Electronics", properties={},
    )
    fact = StructureFact(
        uid="fn-1", type_="proposition", claim="...",
        subject_uid="obj-1", subject_surface="한국 정부",
        predicate="regulates", object_value="obj-2",
        object_surface="삼성전자",
        negation_flag=False, negation_scope=None,
        tags_suggested=[],
    )
    link = StructureFactObjectLink(
        fact_uid="fn-1", object_uid="obj-2", link_type="involves",
        properties={},
    )
    decomp = StructureResult(
        objects=[subject_obj, target_obj],
        facts=[fact], fact_object_links=[link],
        fact_fact_links=[], disambiguation_candidates=[],
        extraction_status="success", failure_reason=None,
        model_used="claude-sonnet-4-5", latency_ms=50,
    )

    captured_surfaces: list[str] = []

    def resolve_entity_mock(surface, lang, *, space_id, co_mention_en=None,
                            llm_name=None, es_client=None):
        captured_surfaces.append(surface)
        return (f"entity-uid-{surface}", True)

    _run(job, decomp, resolve_entity_mock=resolve_entity_mock)

    # Both objects resolve_entity calls saw the Korean surface (not
    # the LLM translated name).
    assert "한국 정부" in captured_surfaces
    assert "삼성전자" in captured_surfaces


def test_resolve_entity_result_flows_into_match_result():
    """The processor must wrap resolve_entity (uid, was_created)
    into a MatchResult so the rest of the pipeline keeps working."""
    job = _make_job()
    decomp = _decomp_with_surface(
        obj_name="Ministry of Commerce",
        obj_name_en="Ministry of Commerce",
        subject_surface="중국 상무부",
    )

    def resolve_entity_mock(surface, lang, *, space_id, co_mention_en=None,
                            llm_name=None, es_client=None):
        # First call: existing match (was_created=False)
        return ("existing-entity-uid", False)

    _run(job, decomp, resolve_entity_mock=resolve_entity_mock)

    # The processor stamped the structure metadata with a matched
    # object count of 1 (created_new=False -> matched_object_uid set).
    s = job.extracted_metadata["structure"]
    assert s["object_count"] == 1
    assert s["object_auto_matched"] == 1
    assert s["object_created_new"] == 0
