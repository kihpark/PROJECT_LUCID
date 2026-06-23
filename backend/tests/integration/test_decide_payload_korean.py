"""feat/spo-decide-payload-wire — end-to-end pipeline tests.

PO directive (2026-06-23): the prior bug surfaced as 'Korean Red Cross'
in the Decide UI even though `_match_object` had corrected
`lucid_objects.primary_label` to '대한적십자사'. This module drives
the full `process_extracted_job` pipeline through a mocked LLM that
returns the LLM-raw English anglicization on a Korean claim, and
asserts the JSONB facts/objects payload that the Decide UI reads
ends up with the CORRECTED Korean surface, not the LLM raw.
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

KS = "ks-decide-payload-test"


def _make_job(status: str, text: str = "") -> MagicMock:
    job = MagicMock()
    job.id = uuid.uuid4()
    job.status = status
    job.extracted_text = text
    job.extracted_metadata = {}
    job.source_url = "https://example.com"
    job.captured_from = "web"
    job.knowledge_space_id = KS
    return job


def _decomp_anglicized_subject(claim: str, llm_name: str, name_en: str) -> StructureResult:
    """Build a StructureResult where the LLM emitted an English subject
    name on a Korean claim — the exact PR-3 bug case."""
    return StructureResult(
        objects=[
            StructureObject(
                uid="obj-1",
                **{"class": ObjectClass.ORGANIZATION.value},
                name=llm_name,
                name_en=name_en,
            ),
        ],
        facts=[
            StructureFact(
                uid="fn-1",
                **{"type": "proposition"},
                claim=claim,
                subject_uid="obj-1",
                subject_surface=llm_name,
                predicate="발표했다",
                object_value="조치",
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
    """Run process_extracted_job end-to-end with ES mocked. Returns
    the final job.extracted_metadata['structure'] dict."""
    job = _make_job(SourceStatus.EXTRACTED.value, text=job_text)
    session = MagicMock()
    session.get.return_value = job

    mock_es = MagicMock()
    mock_es.search.return_value = {"hits": {"hits": []}}
    mock_es.exists.return_value = False
    # When entity_resolver looks up the persisted entity by uid
    # (B-62-decide-payload-wire `_try_lookup_primary_label`), return
    # the chosen primary label so resolve_entity_match echos correctly.
    # The create path doesn't hit `client.get`; this is only meaningful
    # for the match path. For unit-level we let it return whatever the
    # resolver actually persisted via mock_es.index.
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
# 1. PO's reproduction case — Korean Red Cross / 대한적십자사
# ---------------------------------------------------------------------------


def test_decide_payload_korean_red_cross_recovery() -> None:
    """LLM emits subject_name='Korean Red Cross' on the Korean claim
    '대한적십자사는 ...'. claim_recovery should override; the JSONB
    payload the Decide UI reads must show the Korean form.
    """
    claim = "대한적십자사는 22일 새 회장을 선출했다고 발표했다."
    decomp = _decomp_anglicized_subject(
        claim=claim,
        llm_name="Korean Red Cross",
        name_en="Korean Red Cross",
    )
    structure = _drive_pipeline(decomp, claim)

    facts = structure["facts"]
    objects = structure["objects"]
    assert len(facts) == 1
    assert len(objects) == 1

    # The Decide UI reads objects[i].name to render the subject label;
    # it must be the recovered Korean form.
    assert objects[0]["name"] == "대한적십자사", (
        f"objects_payload[0].name={objects[0]['name']!r} — expected "
        f"recovered Korean form '대한적십자사'"
    )
    # And the per-fact subject_label / subject_surface mirror it.
    assert facts[0]["subject_label"] == "대한적십자사"
    assert facts[0]["subject_surface"] == "대한적십자사"
    # The LLM-raw English lives on in aliases so cross-language alias
    # search continues to work.
    assert "Korean Red Cross" in objects[0].get("aliases", [])


# ---------------------------------------------------------------------------
# 2. Japan recovery — single-token English anglicization
# ---------------------------------------------------------------------------


def test_decide_payload_japan_recovery() -> None:
    """LLM emitted subject_name='Japan' on '일본은 ...' claim. The
    primary-fix acceptance from PR-1."""
    claim = "일본은 무기 수출 규제를 완화했다고 발표했다."
    decomp = _decomp_anglicized_subject(
        claim=claim,
        llm_name="Japan",
        name_en="Japan",
    )
    structure = _drive_pipeline(decomp, claim)

    facts = structure["facts"]
    objects = structure["objects"]
    assert objects[0]["name"] == "일본"
    assert facts[0]["subject_label"] == "일본"


# ---------------------------------------------------------------------------
# 3. SpaceX brand path — must NOT be corrected
# ---------------------------------------------------------------------------


def test_decide_payload_spacex_preserves_english_brand() -> None:
    """SpaceX in a Korean claim — the brand path is the legitimate
    "English stays English" case (verbatim substring of source AND
    brand-shaped). The Decide UI must see 'SpaceX', not some Korean
    fallback.
    """
    claim = "SpaceX는 보통주를 매각해 750억달러를 조달했다."
    decomp = _decomp_anglicized_subject(
        claim=claim,
        llm_name="SpaceX",
        name_en="SpaceX",
    )
    structure = _drive_pipeline(decomp, claim)

    facts = structure["facts"]
    objects = structure["objects"]
    assert objects[0]["name"] == "SpaceX"
    # subject_label reflects same — no spurious Korean rewrite.
    assert facts[0]["subject_label"] == "SpaceX"
    # And needs_review is False because there is no violation
    # (substring + brand-shape both exempt).
    assert facts[0]["needs_review"] is False
