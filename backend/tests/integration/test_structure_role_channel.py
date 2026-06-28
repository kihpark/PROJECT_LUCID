"""Integration tests for m32a-stage2-role-channel (PO 2026-06-28 decision 4).

Locks the PO acceptance case verbatim:

  "모스 탄이 6·3선거를 트럼프에게 알렸다." →
      fact_type=action,
      subject=모스탄, predicate=알렸다, object=6·3선거,
      fact_object_role.recipient=트럼프 (canonical UID via uid_map)

The discovery report (docs/m3-2a-discovery.md C.2) measured 100% empty
`involves` link properties on live KS 4a3a8bb7 — multi-participant
facts lose auxiliary participants entirely. The integration test
catches a regression to that state.
"""
from __future__ import annotations

import pytest

from api.structure.models import StructureFact
from api.structure.processor import _serialize_struct_fact

pytestmark = pytest.mark.integration


def test_mose_tan_acceptance_case_recipient_role_preserved() -> None:
    """PO 의뢰서 verbatim acceptance: the 모스 탄 fact carries a
    recipient role pointing at 트럼프's canonical UID after the
    serializer runs."""
    f = StructureFact.model_validate({
        "uid": "fn-1",
        "type": "proposition",
        "claim": "모스 탄이 6·3선거를 트럼프에게 알렸다.",
        "subject_uid": "obj-1",       # 모스 탄
        "predicate": "알렸다",
        "object_value": "obj-2",      # 6·3선거
        "negation_flag": False,
        "negation_scope": None,
        "tags_suggested": ["KR"],
        "fact_type": "action",
        "roles": {"recipient": "obj-3"},  # 트럼프
    })
    uid_map = {
        "obj-1": "obj-canonical-mose-tan",
        "obj-2": "obj-canonical-june-3-election",
        "obj-3": "obj-canonical-trump",
    }
    d = _serialize_struct_fact(f, uid_map=uid_map)

    # action type preserved.
    assert d["fact_type"] == "action"
    # subject + object also remapped (regression guard for Stage 1).
    assert d["subject_uid"] == "obj-canonical-mose-tan"
    assert d["object_value"] == "obj-canonical-june-3-election"
    # ★ the acceptance assertion — recipient = 트럼프's canonical UID.
    assert d["fact_object_role"] == {"recipient": "obj-canonical-trump"}


def test_simple_spo_no_roles_emits_empty_role_dict() -> None:
    """Regression guard: a plain SPO fact (no multi-participant
    structure) still emits `fact_object_role: {}`. The dynamic mapping
    on the field needs an object every time — never null — to keep
    auto-indexing of unseed roles predictable."""
    f = StructureFact.model_validate({
        "uid": "fn-2",
        "type": "proposition",
        "claim": "중국 상무부가 미국 기업 10곳을 수출통제 대상에 올렸다.",
        "subject_uid": "obj-1",
        "predicate": "수출통제 대상에 올렸다",
        "object_value": "obj-2",
        "negation_flag": False,
        "negation_scope": None,
        "tags_suggested": ["KR"],
        "fact_type": "action",
    })
    uid_map = {
        "obj-1": "obj-canonical-china-mofcom",
        "obj-2": "obj-canonical-10-us-companies",
    }
    d = _serialize_struct_fact(f, uid_map=uid_map)
    assert d["fact_object_role"] == {}
