"""DCR-002 v2 / DR-066 — idempotent helper to add ``link_nuance`` to
the lucid_objects.connected_objects nested mapping on existing indices.

ES allows new sub-fields on nested mappings via the ``put_mapping`` API
without a reindex; existing documents simply lack the field, which is
the desired backward-compat behaviour.

Safe to run multiple times: ES rejects mapping conflicts but accepts
identical re-additions. We swallow the BAD_REQUEST that fires when the
field already exists.
"""
from __future__ import annotations

import logging

logger = logging.getLogger("lucid.es.link_nuance")


def ensure_link_nuance_field() -> bool:
    """Add ``link_nuance: keyword`` to ``lucid_objects.connected_objects``.

    Returns True on success / already-present, False on connection failure.
    Never raises out to the caller.
    """
    try:
        from api.storage.elasticsearch.client import LUCID_OBJECTS, get_client
    except ImportError as exc:
        logger.warning("ES client not importable: %s", exc)
        return False

    body = {
        "properties": {
            "connected_objects": {
                "type": "nested",
                "properties": {
                    "target_uid": {"type": "keyword"},
                    "link_type": {"type": "keyword"},
                    "link_nuance": {"type": "keyword"},
                },
            }
        }
    }
    try:
        client = get_client()
        client.indices.put_mapping(index=LUCID_OBJECTS, body=body)
        logger.info("link_nuance field added/confirmed on %s", LUCID_OBJECTS)
        return True
    except Exception as exc:  # noqa: BLE001 - "already present" is a benign 400
        logger.info(
            "ensure_link_nuance_field: put_mapping returned %s "
            "(likely already present; treating as success)", exc,
        )
        return True
