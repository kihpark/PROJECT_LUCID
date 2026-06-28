"""Unit tests for m32a-stage1-speaker-uid-hotfix.

The M3-2a discovery report (commit 7cc4656, docs/m3-2a-discovery.md)
measured that 99 of 100 CLAIM facts on live KS 4a3a8bb7 carried a
raw LLM placeholder ``speaker_uid=obj-N`` because
``_serialize_struct_fact`` never ran ``speaker_uid`` through the
``uid_map`` — unlike ``subject_uid`` and the obj-N-shaped
``object_value``. This broke entity-graph fusion for CLAIM facts:
two claims by the same speaker would not join because each carried
its own per-decompose placeholder instead of the KS-scoped canonical
Object UID.

These tests mirror the style of ``test_serialize_struct_fact_b35.py``
(the B-35 remap that introduced the subject_uid path the hotfix now
extends to speaker_uid).
"""
from __future__ import annotations

from api.structure.models import StructureFact
from api.structure.processor import _serialize_struct_fact


def _claim(*, uid: str, subject_uid: str, speaker_uid: str | None,
           object_value: str = "literal") -> StructureFact:
    """Build a CLAIM-typed StructureFact with the minimum required fields.

    fact_type='claim' is the live path that exposed the bug; the
    serializer's uid_map block runs identically for any fact_type, so
    the regression assertions hold for action/measurement too.
    """
    return StructureFact.model_validate(
        {
            "uid": uid,
            "type": "proposition",
            "claim": "x",
            "subject_uid": subject_uid,
            "predicate": "said",
            "object_value": object_value,
            "negation_flag": False,
            "negation_scope": None,
            "tags_suggested": [],
            "fact_type": "claim",
            "speaker_uid": speaker_uid,
            "speaker_label": "Speaker A" if speaker_uid else None,
            "speech_act": "assert",
            "content_claim": "y",
        },
    )


def test_speaker_uid_remapped_through_uid_map():
    """The PO's reproduction target — when speaker_uid is an obj-N
    placeholder present in uid_map, the canonical Object UID replaces
    it. This is the case that the live KS 4a3a8bb7 measurement caught
    failing on 99 / 100 CLAIM docs."""
    f = _claim(uid="fn-1", subject_uid="obj-1", speaker_uid="obj-2")
    uid_map = {
        "obj-1": "obj-canonical-spacex",
        "obj-2": "obj-canonical-elon-musk",
    }
    d = _serialize_struct_fact(f, uid_map=uid_map)
    assert d["speaker_uid"] == "obj-canonical-elon-musk"


def test_speaker_uid_not_in_uid_map_is_preserved():
    """If the LLM emits a speaker_uid the matcher never produced a
    mapping for (e.g. disambiguation pending, or a None on a non-claim
    payload), the original value is preserved verbatim — the same
    fall-through behaviour subject_uid uses for unmapped placeholders.
    """
    # Unmapped obj-N placeholder: preserved.
    f1 = _claim(uid="fn-1", subject_uid="obj-1", speaker_uid="obj-99")
    d1 = _serialize_struct_fact(f1, uid_map={"obj-1": "obj-canonical-spacex"})
    assert d1["speaker_uid"] == "obj-99"

    # None speaker_uid (non-claim or unset): stays None.
    f2 = _claim(uid="fn-2", subject_uid="obj-1", speaker_uid=None)
    d2 = _serialize_struct_fact(f2, uid_map={"obj-1": "obj-canonical-spacex"})
    assert d2["speaker_uid"] is None


def test_subject_and_object_remap_unchanged_by_speaker_fix():
    """Regression guard: the B-35 subject_uid + object_value(obj-N)
    remap paths must be byte-identical after the hotfix. We construct
    a fact whose subject, object_value, and speaker all live in the
    same uid_map and assert all three resolve independently to their
    canonical UIDs (no cross-contamination)."""
    f = _claim(
        uid="fn-1",
        subject_uid="obj-1",
        speaker_uid="obj-3",
        object_value="obj-2",
    )
    uid_map = {
        "obj-1": "obj-canonical-spacex",
        "obj-2": "obj-canonical-ipo",
        "obj-3": "obj-canonical-elon-musk",
    }
    d = _serialize_struct_fact(f, uid_map=uid_map)
    assert d["subject_uid"] == "obj-canonical-spacex"
    assert d["object_value"] == "obj-canonical-ipo"
    assert d["speaker_uid"] == "obj-canonical-elon-musk"

    # And a literal object_value still escapes the obj-N shape check
    # exactly the way B-35 specified — the speaker fix must not have
    # widened the shape-gate on object_value.
    f_lit = _claim(
        uid="fn-2",
        subject_uid="obj-1",
        speaker_uid="obj-3",
        object_value="85.7 billion USD",
    )
    uid_map_lit = {
        "obj-1": "obj-canonical-spacex",
        "obj-3": "obj-canonical-elon-musk",
        "85.7 billion USD": "obj-canonical-fake",  # must be ignored
    }
    d_lit = _serialize_struct_fact(f_lit, uid_map=uid_map_lit)
    assert d_lit["subject_uid"] == "obj-canonical-spacex"
    assert d_lit["object_value"] == "85.7 billion USD"
    assert d_lit["speaker_uid"] == "obj-canonical-elon-musk"
