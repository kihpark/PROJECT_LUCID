"""feat/spo-decomp-completeness — end-to-end pipeline tests.

PO directive (2026-06-23): when the LLM's decomp drops modifiers or
target phrases, the completeness validator flags `needs_review=True`
on the serialized fact AND attaches a `completeness` field. We do NOT
re-decompose — flag only.

Three cases:
  1. Bad decomp (PO live case: 10곳 / 올렸다) → needs_review True,
     completeness.complete False, missing tokens include 수출통제 /
     대상 / 미국 / 기업.
  2. Bad decomp 2 (방산·드론·희토류 dropped) → needs_review True.
  3. Good decomp (PO correct form) → completeness.complete True;
     needs_review not flagged by the completeness check.
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

KS = "ks-completeness-test"


def _make_job(text: str) -> MagicMock:
    job = MagicMock()
    job.id = uuid.uuid4()
    job.status = SourceStatus.EXTRACTED.value
    job.extracted_text = text
    job.extracted_metadata = {}
    job.source_url = "https://example.com"
    job.captured_from = "web"
    job.knowledge_space_id = KS
    job.user_id = uuid.uuid4()
    return job


def _build_decomp(
    *,
    claim: str,
    subject_name: str,
    predicate: str,
    object_value: str,
    subject_surface: str | None = None,
) -> StructureResult:
    """Build a single-fact decomp result with the SPO we want to test."""
    return StructureResult(
        objects=[
            StructureObject(
                uid="obj-1",
                **{"class": ObjectClass.ORGANIZATION.value},
                name=subject_name,
                name_en=subject_name,
            ),
        ],
        facts=[
            StructureFact(
                uid="fn-1",
                **{"type": "proposition"},
                claim=claim,
                subject_uid="obj-1",
                subject_surface=subject_surface or subject_name,
                predicate=predicate,
                object_value=object_value,
            ),
        ],
        fact_object_links=[
            StructureFactObjectLink(
                fact_uid="fn-1", object_uid="obj-1",
                link_type="involves", properties={},
            ),
        ],
        fact_fact_links=[],
        disambiguation_candidates=[],
        extraction_status="success",
        failure_reason=None,
        model_used="claude-sonnet-4-5",
        latency_ms=100,
    )


def _drive_pipeline(decomp: StructureResult, job_text: str) -> dict:
    """Run process_extracted_job end-to-end with ES mocked."""
    job = _make_job(job_text)
    session = MagicMock()
    session.get.return_value = job

    mock_es = MagicMock()
    mock_es.search.return_value = {"hits": {"hits": []}}
    mock_es.exists.return_value = False
    persisted_bodies: dict[str, dict] = {}

    def _fake_get(*, index: str, id: str) -> dict:  # noqa: A002
        return {"_source": persisted_bodies.get(id, {})}

    def _fake_index(*, index: str, id: str, document: dict, **kwargs):  # noqa: A002
        persisted_bodies[id] = document

    mock_es.get.side_effect = _fake_get
    mock_es.index.side_effect = _fake_index

    with patch(
        "api.structure.processor.make_sessionmaker",
        return_value=lambda: session,
    ), patch(
        "api.structure.processor.decompose", return_value=decomp,
    ), patch(
        "api.structure.processor.get_embedding",
        return_value=[0.1] * 1536,
    ), patch(
        "api.structure.entity_resolver.get_client", return_value=mock_es,
    ), patch(
        "api.storage.elasticsearch.client.get_client", return_value=mock_es,
    ), patch(
        "api.metrics.precision.record_structure_metrics",
    ):
        process_extracted_job(job.id)

    assert job.status == SourceStatus.STRUCTURED.value, (
        f"job.status={job.status}, error={job.error_message}"
    )
    return job.extracted_metadata["structure"]


# ---------------------------------------------------------------------------
# 1 — Bad decomp (PO live evidence): "10곳" / "올렸다" — flag fires
# ---------------------------------------------------------------------------


def test_bad_decomp_10gok_flags_needs_review() -> None:
    """PO's exact live case: claim contains 수출통제 / 대상 / 미국 / 기업
    but SPO drops them all. The completeness validator must flag
    needs_review=True on the serialized fact.
    """
    claim = "중국 정부가 미국 기업 10곳을 수출통제 대상에 올렸다."
    decomp = _build_decomp(
        claim=claim,
        subject_name="중국",
        predicate="올렸다",
        object_value="10곳",
    )
    structure = _drive_pipeline(decomp, claim)
    facts = structure["facts"]
    assert len(facts) == 1
    f = facts[0]
    # needs_review must be flagged
    assert f["needs_review"] is True
    # completeness metadata must be attached
    assert "completeness" in f
    c = f["completeness"]
    assert c["complete"] is False
    assert c["coverage"] < 0.7
    # The big modifiers must be reported as missing
    missing = set(c["missing"])
    assert "수출통제" in missing
    assert "대상" in missing
    assert "기업" in missing


# ---------------------------------------------------------------------------
# 2 — Bad decomp 2: 방산·드론·희토류 dropped
# ---------------------------------------------------------------------------


def test_bad_decomp_drops_compound_modifiers_flags_needs_review() -> None:
    """PO's second case: 방산·드론·희토류 dropped from object."""
    claim = "중국 정부가 미국 방산·드론·희토류 관련 기업에 대한 추가 제재에 나섰다."
    decomp = _build_decomp(
        claim=claim,
        subject_name="중국",
        predicate="제재",
        object_value="추가 제재",
    )
    structure = _drive_pipeline(decomp, claim)
    f = structure["facts"][0]
    assert f["needs_review"] is True
    assert f["completeness"]["complete"] is False


# ---------------------------------------------------------------------------
# 3 — Good decomp: completeness.complete True, no flag from this check
# ---------------------------------------------------------------------------


def test_good_decomp_passes_completeness_check() -> None:
    """When the LLM produces the CORRECT SPO, completeness.complete is
    True and the completeness check does NOT contribute to needs_review.

    (Other checks — predicate_violation, surface_violation, etc — may
    still flag needs_review, but this fact has none of those.)
    """
    claim = "중국 정부가 미국 기업 10곳을 수출통제 대상에 올렸다."
    decomp = _build_decomp(
        claim=claim,
        subject_name="중국 정부",
        predicate="수출통제 대상에 올렸다",
        object_value="미국 기업 10곳",
    )
    structure = _drive_pipeline(decomp, claim)
    f = structure["facts"][0]
    assert "completeness" in f
    assert f["completeness"]["complete"] is True
    assert f["completeness"]["coverage"] >= 0.7
