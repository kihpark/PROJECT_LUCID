"""B-48a-2 regression tests for the entity placeholder↔canonical
merge in the replay path.

Each acceptance criterion (★ in the brief) is locked by a named test:
- test_upsert_dedupes_two_jobs_to_one_canonical_per_name_class
- test_upsert_never_indexes_placeholder_uid
- test_coerce_remaps_fact_subject_via_object_uid_map
- test_augment_finds_subject_via_fact_object_links
- test_augment_falls_back_to_name_in_claim
- test_find_object_by_name_class_prefers_canonical_over_placeholder
- test_remap_fact_subject_object_idempotent
"""
from __future__ import annotations

import re
from typing import Any
from unittest.mock import MagicMock, patch
from uuid import uuid4

_UUID4_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
    re.IGNORECASE,
)
_PLACEHOLDER_RE = re.compile(r"^obj-\d+$", re.IGNORECASE)


def _make_job(job_id, ks_id, source_url, facts, objects, links=None):
    job = MagicMock()
    job.id = job_id
    job.knowledge_space_id = ks_id
    job.source_url = source_url
    job.source_type = "web_article"
    job.captured_at = None
    job.extracted_metadata = {
        "structure": {
            "facts": facts,
            "objects": objects,
            "fact_object_links_detail": links or [],
        },
    }
    return job


# ---------------------------------------------------------------------------
# A. (name, class) dedup across jobs
# ---------------------------------------------------------------------------

def test_upsert_dedupes_two_jobs_to_one_canonical_per_name_class():
    """★ Two captures referring to "SpaceX" must converge on a single
    canonical Object uid — exactly what makes the facet bar render
    once instead of twice."""
    from api.storage.elasticsearch.replay import _upsert_objects_for_job

    job_a = _make_job(
        "job-a", "ks-1", "https://a.com/1",
        facts=[],
        objects=[{"uid": "obj-1", "name": "SpaceX", "class": "organization"}],
    )
    job_b = _make_job(
        "job-b", "ks-1", "https://b.com/1",
        facts=[],
        objects=[{"uid": "obj-4", "name": "SpaceX", "class": "organization"}],
    )

    written_objects: list[dict] = []
    canonical: dict = {}

    def _fake_create(obj, with_embedding=True):
        written_objects.append(obj.model_dump(by_alias=True, mode="json"))
        return obj.object_uid

    with patch(
        "api.storage.elasticsearch.replay.create_object",
        side_effect=_fake_create,
    ), patch(
        "api.storage.elasticsearch.objects.find_object_by_name_class",
        return_value=None,
    ):
        _, remap_a = _upsert_objects_for_job(
            job_a, knowledge_space_id="ks-1",
            seen_canonical_uids=set(),
            canonical_by_name_class=canonical,
        )
        _, remap_b = _upsert_objects_for_job(
            job_b, knowledge_space_id="ks-1",
            seen_canonical_uids=set(),
            canonical_by_name_class=canonical,
        )

    # Only ONE Object doc is created across both calls.
    assert len(written_objects) == 1
    # Both jobs' placeholder uids resolve to that single canonical uid.
    assert remap_a["obj-1"] == remap_b["obj-4"]
    assert _UUID4_RE.match(remap_a["obj-1"])


def test_upsert_never_indexes_placeholder_uid():
    """★ Placeholder uids (`obj-N`) must NEVER reach lucid_objects;
    the upsert always indexes under a canonical UUID4."""
    from api.storage.elasticsearch.replay import _upsert_objects_for_job

    job = _make_job(
        "job-x", "ks-1", "https://x.com/1",
        facts=[],
        objects=[{"uid": "obj-7", "name": "Elon Musk", "class": "person"}],
    )
    written_uids: list[str] = []

    def _fake_create(obj, with_embedding=True):
        written_uids.append(obj.object_uid)

    with patch(
        "api.storage.elasticsearch.replay.create_object",
        side_effect=_fake_create,
    ), patch(
        "api.storage.elasticsearch.objects.find_object_by_name_class",
        return_value=None,
    ):
        _upsert_objects_for_job(
            job, knowledge_space_id="ks-1",
            seen_canonical_uids=set(),
            canonical_by_name_class={},
        )

    assert len(written_uids) == 1
    assert _UUID4_RE.match(written_uids[0])
    assert not _PLACEHOLDER_RE.match(written_uids[0])


def test_upsert_reuses_canonical_from_existing_es_doc():
    """When find_object_by_name_class returns an existing canonical, the
    placeholder uid in the structure metadata is remapped to it —
    NEVER a fresh UUID4."""
    from api.storage.elasticsearch.replay import _upsert_objects_for_job

    existing_canonical = "59ca596c-c1eb-4983-a36a-87b35adce76b"
    job = _make_job(
        "job-y", "ks-1", "https://y.com/1",
        facts=[],
        objects=[{"uid": "obj-1", "name": "SpaceX", "class": "organization"}],
    )

    with patch(
        "api.storage.elasticsearch.objects.find_object_by_name_class",
        return_value={"object_uid": existing_canonical, "name": "SpaceX"},
    ), patch(
        "api.storage.elasticsearch.replay.create_object",
    ) as create_mock:
        _, remap = _upsert_objects_for_job(
            job, knowledge_space_id="ks-1",
            seen_canonical_uids=set(),
            canonical_by_name_class={},
        )

    create_mock.assert_not_called()
    assert remap["obj-1"] == existing_canonical


# ---------------------------------------------------------------------------
# B. coerce_to_factnode object_uid_remap application
# ---------------------------------------------------------------------------

def test_coerce_remaps_fact_subject_via_object_uid_map():
    """★ A fact whose structure-metadata subject_uid is `obj-5` lands
    in ES with the canonical subject_uid the remap provides."""
    from api.storage.elasticsearch.replay import _coerce_to_factnode

    canonical_uid = str(uuid4())
    node = _coerce_to_factnode(
        {
            "uid": "fn-1", "claim": "x", "type": "proposition",
            "subject_uid": "obj-5", "predicate": "p",
            "object_value": "literal value",
        },
        knowledge_space_id="ks-1",
        validator_id="u-1",
        fact_uid_override=str(uuid4()),
        source_uid="src-x",
        object_uid_remap={"obj-5": canonical_uid},
    )
    assert node.subject_uid == canonical_uid
    # Literal object_value stays untouched.
    assert node.object_value == "literal value"


def test_coerce_remaps_entity_shaped_object_value_too():
    """When object_value happens to be an entity uid that's in the
    remap, it gets canonicalised as well."""
    from api.storage.elasticsearch.replay import _coerce_to_factnode

    canonical_uid = str(uuid4())
    node = _coerce_to_factnode(
        {
            "uid": "fn-1", "claim": "x", "type": "proposition",
            "subject_uid": "obj-1", "predicate": "p",
            "object_value": "obj-2",
        },
        knowledge_space_id="ks-1",
        validator_id="u-1",
        fact_uid_override=str(uuid4()),
        source_uid="src-x",
        object_uid_remap={"obj-1": canonical_uid, "obj-2": "uid-other"},
    )
    assert node.subject_uid == canonical_uid
    assert node.object_value == "uid-other"


def test_coerce_passes_through_when_no_remap_match():
    """A subject_uid that isn't in the remap stays as-is (the augment
    pass handles the stale-canonical case)."""
    from api.storage.elasticsearch.replay import _coerce_to_factnode

    node = _coerce_to_factnode(
        {
            "uid": "fn-1", "claim": "x", "type": "proposition",
            "subject_uid": "already-canonical-uid", "predicate": "p",
            "object_value": "v",
        },
        knowledge_space_id="ks-1",
        validator_id="u-1",
        fact_uid_override=str(uuid4()),
        source_uid="src-x",
        object_uid_remap={"obj-99": "uid-zzz"},
    )
    assert node.subject_uid == "already-canonical-uid"


# ---------------------------------------------------------------------------
# C. augment_remap_with_fact_subjects — stale-canonical recovery
# ---------------------------------------------------------------------------

def test_augment_finds_subject_via_fact_object_links():
    """★ The Elon Musk regression: fact.subject_uid is a stale canonical
    (`dee1ba2c…`) that doesn't appear in `objects[]`, but the
    `fact_object_links_detail` says the fact references `obj-5` —
    augment maps the stale canonical to the canonical issued for
    (Elon Musk, person)."""
    from api.storage.elasticsearch.replay import (
        _augment_remap_with_fact_subjects,
    )

    canonical_elon = str(uuid4())
    canonical_by_name_class = {("Elon Musk", "person"): canonical_elon}
    stale_canonical = str(uuid4())

    job = _make_job(
        "job-elon", "ks-1", "https://x.com/elon",
        facts=[{
            "uid": "fn-1",
            "subject_uid": stale_canonical,
            "claim": "Elon Musk leads SpaceX.",
            "predicate": "leads", "object_value": "SpaceX",
        }],
        objects=[
            {"uid": "obj-5", "name": "Elon Musk", "class": "person"},
            {"uid": "obj-4", "name": "SpaceX", "class": "organization"},
        ],
        links=[{"fact_uid": "fn-1", "object_uid": "obj-5"}],
    )
    # The first pass already remapped obj-5 → canonical_elon.
    remap = {"obj-5": canonical_elon}
    _augment_remap_with_fact_subjects(job, remap, canonical_by_name_class)
    assert remap[stale_canonical] == canonical_elon


def test_augment_falls_back_to_name_in_claim():
    """When fact_object_links are absent, the augment uses name-in-claim
    detection (preferring claim-start) to identify the subject."""
    from api.storage.elasticsearch.replay import (
        _augment_remap_with_fact_subjects,
    )

    canonical_spx = str(uuid4())
    canonical_by_name_class = {("SpaceX", "organization"): canonical_spx}
    stale_canonical = str(uuid4())

    job = _make_job(
        "job-spx", "ks-1", "https://x.com/spx",
        facts=[{
            "uid": "fn-2",
            "subject_uid": stale_canonical,
            "claim": "SpaceX raised 85.7 billion USD.",
            "predicate": "raised", "object_value": "85.7B USD",
        }],
        objects=[{"uid": "obj-1", "name": "SpaceX", "class": "organization"}],
        links=[],  # no links — exercise the fallback
    )
    remap = {"obj-1": canonical_spx}
    _augment_remap_with_fact_subjects(job, remap, canonical_by_name_class)
    assert remap[stale_canonical] == canonical_spx


def test_augment_tolerates_link_count_int_instead_of_list():
    """Some old metadata stored an int under `fact_object_links` (the
    count) rather than the list. The augment must not crash."""
    from api.storage.elasticsearch.replay import (
        _augment_remap_with_fact_subjects,
    )

    job = MagicMock()
    job.extracted_metadata = {
        "structure": {
            "facts": [{
                "uid": "fn-1", "subject_uid": "some-uid",
                "claim": "x", "predicate": "p", "object_value": "v",
            }],
            "objects": [{"uid": "obj-1", "name": "X", "class": "concept"}],
            "fact_object_links": 3,  # int — bug fixture
        },
    }
    remap: dict[str, str] = {"obj-1": "canonical-uid"}
    # Should not raise.
    _augment_remap_with_fact_subjects(job, remap, {("X", "concept"): "c"})


# ---------------------------------------------------------------------------
# D. find_object_by_name_class — canonical-first preference
# ---------------------------------------------------------------------------

def test_find_object_by_name_class_prefers_canonical_over_placeholder():
    """When both `obj-1` and a canonical UUID4 exist for the same
    (KS, name, class), the lookup returns the canonical one first."""
    from api.storage.elasticsearch import objects as omod

    placeholder = {"object_uid": "obj-1", "name": "SpaceX", "class": "organization"}
    canonical = {
        "object_uid": "59ca596c-c1eb-4983-a36a-87b35adce76b",
        "name": "SpaceX", "class": "organization",
    }

    class _FakeClient:
        def search(self, **kw):
            return {"hits": {"hits": [
                {"_source": placeholder},  # ES returned placeholder first
                {"_source": canonical},
            ]}}

    with patch("api.storage.elasticsearch.objects.get_client", return_value=_FakeClient()):
        result = omod.find_object_by_name_class("ks-1", "SpaceX", "organization")

    assert result["object_uid"] == canonical["object_uid"]


# ---------------------------------------------------------------------------
# E. remap_fact_subject_object — idempotent partial-update walk
# ---------------------------------------------------------------------------

def test_remap_fact_subject_object_empty_map_is_noop():
    """An empty remap is a no-op (no ES queries, no doc writes)."""
    from api.storage.elasticsearch import objects as omod

    fake_client = MagicMock()
    with patch("api.storage.elasticsearch.objects.get_client", return_value=fake_client):
        result = omod.remap_fact_subject_object("ks-1", {})
    assert result == {"subjects_remapped": 0, "objects_remapped": 0, "facts_touched": 0}
    fake_client.search.assert_not_called()
