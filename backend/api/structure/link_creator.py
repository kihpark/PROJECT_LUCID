"""Create the 16 link-type edges emitted by the Structure decomposer.

Inputs from the decomposer (`StructureResult`):
  fact_object_links   5 link types (asserts_property, describes_state,
                                    addresses, uses, involves)
  fact_fact_links     7 link types (supports, contradicts, example_of,
                                    derived_from, interprets, supersedes,
                                    negates ← DCR-001)
  + implicit Object<->Object links inferred by callers (PART_OF,
    INSTANCE_OF, LOCATED_IN, HAS_ROLE) — 4 link types

Object<->Object link creation uses the existing
`api.storage.elasticsearch.objects.link_objects()` from PR-1A-3,
which is already symmetric (writes the edge into both A and B's
`connected_objects` nested arrays).

Fact<->Fact and Fact<->Object edges are stored as `LinkRecord` rows
in PR-1A-2's Pydantic shape and persisted alongside the FactNode
ES document. This module returns the LinkRecord list; the structure
processor (PR-3-2 D) wires them onto the source job's
`extracted_metadata['structure']['links']` payload.

NEGATES (DCR-001):
  - directional (from negating fact -> negated target)
  - the negating fact's `negation_flag` is True and `negation_scope`
    is 'full' or 'partial' (asserted by the decomposer; this module
    does not re-derive)
  - separate from CONTRADICTS, which is symmetric value-mismatch
"""
from __future__ import annotations

import logging
from collections.abc import Iterable
from datetime import datetime
from typing import Any

from pydantic import Field

from api.models.base import UID, LucidBaseModel, new_uid, utc_now

logger = logging.getLogger("lucid.structure.linker")


FACT_OBJECT_LINK_TYPES = frozenset(
    {"asserts_property", "describes_state", "addresses", "uses", "involves"}
)
OBJECT_OBJECT_LINK_TYPES = frozenset(
    {"part_of", "instance_of", "located_in", "has_role"}
)
FACT_FACT_LINK_TYPES = frozenset(
    {"supports", "contradicts", "example_of", "derived_from",
     "interprets", "supersedes", "negates"}
)


class CreatedLink(LucidBaseModel):
    """One persisted graph edge produced by the linker."""

    link_uid: UID = Field(default_factory=new_uid)
    from_uid: UID
    to_uid: UID
    link_type: str
    axis: str  # "fact_object" | "object_object" | "fact_fact"
    created_at: datetime = Field(default_factory=utc_now)


class LinkCreationResult(LucidBaseModel):
    """Per-batch summary returned by `create_links`."""

    fact_object_count: int = 0
    object_object_count: int = 0
    fact_fact_count: int = 0
    negates_count: int = 0
    skipped_count: int = 0
    links: list[CreatedLink] = Field(default_factory=list)


def _validate(link_type: str, allowed: Iterable[str], axis: str) -> bool:
    if link_type in allowed:
        return True
    logger.warning("link skipped: invalid %s link_type %r", axis, link_type)
    return False


def create_links(
    *,
    fact_object_links: list[dict[str, Any]] | None = None,
    object_object_links: list[dict[str, Any]] | None = None,
    fact_fact_links: list[dict[str, Any]] | None = None,
    knowledge_space_id: str | None = None,
    es_update_object_adjacency: bool = True,
) -> LinkCreationResult:
    """Build the 16-axis link set.

    Each input list is a list of {from_uid, to_uid, link_type, ...} dicts.
    For Fact<->Object the dict uses `fact_uid` / `object_uid` keys.

    When `es_update_object_adjacency=True`, Object<->Object links also call
    `api.storage.elasticsearch.objects.link_objects()` to write the
    symmetric edge into both sides' `connected_objects` nested array.
    Pure unit tests pass `es_update_object_adjacency=False` so the ES
    client is never invoked.
    """
    out = LinkCreationResult()

    for raw in fact_object_links or []:
        link_type = (raw.get("link_type") or "").lower()
        if not _validate(link_type, FACT_OBJECT_LINK_TYPES, "fact_object"):
            out.skipped_count += 1
            continue
        from_uid = str(raw.get("fact_uid") or raw.get("from_uid") or "")
        to_uid = str(raw.get("object_uid") or raw.get("to_uid") or "")
        if not from_uid or not to_uid:
            out.skipped_count += 1
            continue
        out.links.append(
            CreatedLink(
                from_uid=from_uid, to_uid=to_uid,
                link_type=link_type, axis="fact_object",
            )
        )
        out.fact_object_count += 1

    if object_object_links:
        if es_update_object_adjacency:
            try:
                from api.storage.elasticsearch.objects import (
                    link_objects as es_link_objects,
                )
            except ImportError as exc:
                logger.warning("ES link_objects import failed: %s", exc)
                es_link_objects = None  # type: ignore[assignment]
        else:
            es_link_objects = None  # type: ignore[assignment]

        for raw in object_object_links:
            link_type = (raw.get("link_type") or "").lower()
            if not _validate(link_type, OBJECT_OBJECT_LINK_TYPES, "object_object"):
                out.skipped_count += 1
                continue
            from_uid = str(raw.get("from_uid") or "")
            to_uid = str(raw.get("to_uid") or "")
            if not from_uid or not to_uid or from_uid == to_uid:
                out.skipped_count += 1
                continue
            out.links.append(
                CreatedLink(
                    from_uid=from_uid, to_uid=to_uid,
                    link_type=link_type, axis="object_object",
                )
            )
            out.object_object_count += 1

            if es_link_objects is not None:
                try:
                    es_link_objects(from_uid, to_uid, link_type)
                except Exception as exc:  # noqa: BLE001
                    logger.warning(
                        "ES symmetric link_objects(%s, %s, %s) failed: %s",
                        from_uid, to_uid, link_type, exc,
                    )

    for raw in fact_fact_links or []:
        link_type = (raw.get("link_type") or "").lower()
        if not _validate(link_type, FACT_FACT_LINK_TYPES, "fact_fact"):
            out.skipped_count += 1
            continue
        from_uid = str(raw.get("from_uid") or "")
        to_uid = str(raw.get("to_uid") or "")
        if not from_uid or not to_uid:
            out.skipped_count += 1
            continue
        out.links.append(
            CreatedLink(
                from_uid=from_uid, to_uid=to_uid,
                link_type=link_type, axis="fact_fact",
            )
        )
        out.fact_fact_count += 1
        if link_type == "negates":
            out.negates_count += 1

    return out
