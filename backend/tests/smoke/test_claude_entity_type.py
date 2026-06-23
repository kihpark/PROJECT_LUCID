"""feat/entity-layer-restore — live Claude entity_type smoke.

PO directive (2026-06-23) symptoms (2) and (7): the LLM is supposed to
classify each emitted Object into one of the 13 ObjectClass values
(person / organization / place / event / ...). The prompt was already
correct; the regression was downstream (entity_resolver hardcoded
"concept"). This smoke pins the LLM-side invariant so a future prompt
edit that silently changes the contract (e.g. drops the class
instruction) is caught.

Gated by LUCID_LIVE_LLM_SMOKE=1 so CI doesn't spend ~$0.01 per run.
PO runs it manually before merging this PR.

Two cases:

  1. Korean article with named organizations + a person → at least one
     Object emitted with `class=organization` AND at least one with
     `class=person`. Concept-only output would mean the LLM is no
     longer classifying.
  2. Korean article about an abstract concept → at least one Object
     with `class=concept`. Symmetry check — proves we're not over-
     fitting to "everything must be a person/org".
"""
from __future__ import annotations

import os

import pytest

LIVE = os.getenv("LUCID_LIVE_LLM_SMOKE") == "1"
pytestmark = pytest.mark.skipif(
    not LIVE, reason="set LUCID_LIVE_LLM_SMOKE=1 to run live"
)


_KOREAN_NAMED_ENTITIES_ARTICLE = (
    "2026년 6월 22일, 중국 상무부는 미국 기업 10곳을 수출통제 명단에 "
    "올렸다고 발표했다. 한동훈 전 법무부 장관은 이에 대해 강한 우려를 "
    "표명했다."
)

_KOREAN_CONCEPT_ARTICLE = (
    "손실 회피는 행동경제학의 핵심 개념이다. 사람들은 같은 크기의 이득보다 "
    "손실에 더 민감하게 반응한다."
)


def test_korean_named_entities_get_correct_classes() -> None:
    """Korean article with 중국 상무부 (organization) + 한동훈 (person):
    the LLM must classify them correctly. Pre-fix this contract was
    fine in the LLM output; the failure was downstream. This smoke
    pins the LLM-side invariant."""
    from api.structure.decomposer import decompose

    result = decompose(_KOREAN_NAMED_ENTITIES_ARTICLE)
    assert result.extraction_status == "success", (
        f"expected success, got {result.extraction_status} "
        f"(failure_reason={result.failure_reason!r})"
    )

    classes = {obj.class_ for obj in result.objects}
    assert "organization" in {c.value for c in classes}, (
        f"expected at least one organization, got {[c.value for c in classes]}; "
        f"named entities article should include 중국 상무부"
    )
    assert "person" in {c.value for c in classes}, (
        f"expected at least one person, got {[c.value for c in classes]}; "
        f"named entities article should include 한동훈"
    )


def test_korean_concept_article_emits_concept_class() -> None:
    """Symmetry — a concept-only article should yield concept-class
    entities. Confirms the classifier isn't biased to person/org."""
    from api.structure.decomposer import decompose

    result = decompose(_KOREAN_CONCEPT_ARTICLE)
    assert result.extraction_status == "success", (
        f"expected success, got {result.extraction_status}"
    )

    class_values = {obj.class_.value for obj in result.objects}
    # We don't pin the exact set — knowledge / concept are both
    # legitimate buckets for "손실 회피". The invariant is that
    # NOT every entity is forced into person/organization/place.
    abstract_classes = {"concept", "knowledge"}
    assert class_values & abstract_classes, (
        f"expected at least one abstract class in {abstract_classes}, "
        f"got {class_values}"
    )
