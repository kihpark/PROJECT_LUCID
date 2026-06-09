"""Unit tests for api.structure.processor (PR-3-2 D)."""
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
from api.structure.object_matcher import MatchResult
from api.structure.processor import process_extracted_job

KS = "ks-proc-test"


def _make_job(status: str, text: str = "Sample text",
              meta: dict | None = None) -> MagicMock:
    job = MagicMock()
    job.id = uuid.uuid4()
    job.status = status
    job.extracted_text = text
    job.extracted_metadata = meta or {}
    job.source_url = "https://example.com"
    job.captured_from = "web"
    job.knowledge_space_id = KS
    return job


def _make_decomp(n_facts: int = 1, n_objects: int = 1) -> StructureResult:
    objects = [
        StructureObject(
            uid=f"obj-{i}", class_=ObjectClass.ORGANIZATION,
            name=f"Org-{i}", properties={},
        )
        for i in range(1, n_objects + 1)
    ]
    facts = [
        StructureFact(
            uid=f"fn-{i}", type_="proposition", claim=f"Claim {i}",
            subject_uid="obj-1", predicate="has_property",
            object_value=f"value-{i}",
            negation_flag=False, negation_scope=None,
            tags_suggested=[],
        )
        for i in range(1, n_facts + 1)
    ]
    fo_links = [
        StructureFactObjectLink(
            fact_uid="fn-1", object_uid="obj-1", link_type="involves",
            properties={},
        )
    ] if n_facts and n_objects else []
    return StructureResult(
        objects=objects, facts=facts, fact_object_links=fo_links,
        fact_fact_links=[], disambiguation_candidates=[],
        extraction_status="success", failure_reason=None,
        model_used="claude-sonnet-4-5", latency_ms=1234,
    )


def test_skips_when_job_not_found():
    """Missing job_id → silent return, no exception."""
    session = MagicMock()
    session.get.return_value = None
    with patch(
        "api.structure.processor.make_sessionmaker",
        return_value=lambda: session,
    ):
        process_extracted_job(uuid.uuid4())
    session.commit.assert_not_called()


def test_skips_terminal_states():
    job = _make_job(SourceStatus.STRUCTURED.value)
    session = MagicMock()
    session.get.return_value = job
    with patch(
        "api.structure.processor.make_sessionmaker",
        return_value=lambda: session,
    ):
        process_extracted_job(job.id)
    assert job.status == SourceStatus.STRUCTURED.value
    session.commit.assert_not_called()


def test_skips_non_extracted_state():
    job = _make_job(SourceStatus.PENDING_EXTRACT.value)
    session = MagicMock()
    session.get.return_value = job
    with patch(
        "api.structure.processor.make_sessionmaker",
        return_value=lambda: session,
    ):
        process_extracted_job(job.id)
    assert job.status == SourceStatus.PENDING_EXTRACT.value
    session.commit.assert_not_called()


def test_happy_path_sets_structured_and_writes_telemetry():
    job = _make_job(SourceStatus.EXTRACTED.value, text="Some claim.")
    session = MagicMock()
    session.get.return_value = job
    decomp = _make_decomp(n_facts=2, n_objects=1)

    match_result = MatchResult(
        matched_object_uid="obj-real-1",
        disambiguation_required=False,
        candidates=[], created_new=False,
        new_object_uid=None, decision_reason="exact_match",
    )

    with patch(
        "api.structure.processor.make_sessionmaker",
        return_value=lambda: session,
    ), patch(
        "api.structure.processor.decompose", return_value=decomp,
    ), patch(
        "api.structure.processor.get_embedding",
        return_value=[0.1] * 1536,
    ), patch(
        "api.structure.processor.match_or_create_object",
        return_value=match_result,
    ):
        process_extracted_job(job.id)

    assert job.status == SourceStatus.STRUCTURED.value
    s = job.extracted_metadata["structure"]
    assert s["fact_count"] == 2
    assert s["object_count"] == 1
    assert s["object_auto_matched"] == 1
    assert s["object_created_new"] == 0
    assert s["object_disambig_pending"] == 0


def test_empty_text_records_failure():
    job = _make_job(SourceStatus.EXTRACTED.value, text="   ")
    session = MagicMock()
    session.get.return_value = job
    with patch(
        "api.structure.processor.make_sessionmaker",
        return_value=lambda: session,
    ):
        process_extracted_job(job.id)
    assert job.status == SourceStatus.STRUCTURE_FAILED.value
    assert "empty" in (job.error_message or "")


def test_decompose_exception_records_failure():
    job = _make_job(SourceStatus.EXTRACTED.value, text="real text")
    session = MagicMock()
    session.get.return_value = job
    with patch(
        "api.structure.processor.make_sessionmaker",
        return_value=lambda: session,
    ), patch(
        "api.structure.processor.decompose",
        side_effect=RuntimeError("boom"),
    ):
        process_extracted_job(job.id)
    assert job.status == SourceStatus.STRUCTURE_FAILED.value
    assert "decompose error" in (job.error_message or "")


def test_disambig_pending_recorded_in_metadata():
    job = _make_job(SourceStatus.EXTRACTED.value, text="삼성에 대한 글.")
    session = MagicMock()
    session.get.return_value = job
    decomp = _make_decomp(n_facts=1, n_objects=1)
    match_result = MatchResult(
        matched_object_uid=None,
        disambiguation_required=True,
        candidates=[],
        created_new=False, new_object_uid=None,
        decision_reason="exact_match_multi",
    )
    with patch(
        "api.structure.processor.make_sessionmaker",
        return_value=lambda: session,
    ), patch(
        "api.structure.processor.decompose", return_value=decomp,
    ), patch(
        "api.structure.processor.get_embedding",
        return_value=[0.1] * 1536,
    ), patch(
        "api.structure.processor.match_or_create_object",
        return_value=match_result,
    ):
        process_extracted_job(job.id)

    s = job.extracted_metadata["structure"]
    assert s["object_disambig_pending"] == 1
    assert len(s["disambiguation_pending"]) == 1


def test_invalid_uuid_string_returns_silently():
    """A string that can't parse → log + return, no crash."""
    with patch(
        "api.structure.processor.make_sessionmaker"
    ) as mock_sm:
        process_extracted_job("not-a-uuid")
    mock_sm.assert_not_called()


def test_processor_persists_facts_content():
    """chore 5 — every fact's content lands in extracted_metadata.structure.facts."""
    job = _make_job(SourceStatus.EXTRACTED.value, text="content.")
    session = MagicMock()
    session.get.return_value = job
    decomp = _make_decomp(n_facts=3, n_objects=2)
    match_result = MatchResult(
        matched_object_uid="obj-X", decision_reason="exact_match",
    )

    with patch(
        "api.structure.processor.make_sessionmaker",
        return_value=lambda: session,
    ), patch(
        "api.structure.processor.decompose", return_value=decomp,
    ), patch(
        "api.structure.processor.get_embedding",
        return_value=[0.1] * 1536,
    ), patch(
        "api.structure.processor.match_or_create_object",
        return_value=match_result,
    ):
        process_extracted_job(job.id)

    s = job.extracted_metadata["structure"]
    assert len(s["facts"]) == 3
    for i, fact in enumerate(s["facts"], start=1):
        # by_alias resolves type_ -> type
        assert fact["type"] == "proposition"
        assert fact["claim"].startswith("Claim ")
        assert fact["subject_uid"] == "obj-1"
        assert fact["predicate"] == "has_property"
        assert fact["fact_uid"] == f"fn-{i}"
        # The original Pydantic field also lands so the route's
        # `facts.uid` fallback keeps working.
        assert fact["uid"] == f"fn-{i}"


def test_processor_persists_objects_with_class_alias():
    """chore 5 — objects[] uses 'class' (alias of class_) for the ObjectClass enum."""
    job = _make_job(SourceStatus.EXTRACTED.value, text="content.")
    session = MagicMock()
    session.get.return_value = job
    decomp = _make_decomp(n_facts=1, n_objects=2)
    match_result = MatchResult(
        matched_object_uid="obj-X", decision_reason="exact_match",
    )

    with patch(
        "api.structure.processor.make_sessionmaker",
        return_value=lambda: session,
    ), patch(
        "api.structure.processor.decompose", return_value=decomp,
    ), patch(
        "api.structure.processor.get_embedding",
        return_value=[0.1] * 1536,
    ), patch(
        "api.structure.processor.match_or_create_object",
        return_value=match_result,
    ):
        process_extracted_job(job.id)

    s = job.extracted_metadata["structure"]
    assert len(s["objects"]) == 2
    for o in s["objects"]:
        assert o["class"] == "organization"   # alias resolved, NOT class_
        assert o["name"].startswith("Org-")
        assert "uid" in o
        assert "properties" in o


def test_processor_persists_links_detail():
    """chore 5 — fact_object_links_detail + fact_fact_links_detail carry full records."""
    job = _make_job(SourceStatus.EXTRACTED.value, text="content.")
    session = MagicMock()
    session.get.return_value = job
    decomp = _make_decomp(n_facts=1, n_objects=1)
    match_result = MatchResult(
        matched_object_uid="obj-X", decision_reason="exact_match",
    )

    with patch(
        "api.structure.processor.make_sessionmaker",
        return_value=lambda: session,
    ), patch(
        "api.structure.processor.decompose", return_value=decomp,
    ), patch(
        "api.structure.processor.get_embedding",
        return_value=[0.1] * 1536,
    ), patch(
        "api.structure.processor.match_or_create_object",
        return_value=match_result,
    ):
        process_extracted_job(job.id)

    s = job.extracted_metadata["structure"]
    # _make_decomp emits exactly one fact_object_link (involves).
    assert len(s["fact_object_links_detail"]) == 1
    link = s["fact_object_links_detail"][0]
    assert link["link_type"] == "involves"
    assert link["fact_uid"] == "fn-1"
    # Object uid is remapped via uid_map to the matched_object_uid.
    assert link["object_uid"] == "obj-X"
    # fact_fact_links is empty in _make_decomp by default.
    assert s["fact_fact_links_detail"] == []
