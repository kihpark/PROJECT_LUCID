"""Relabel legacy lucid_objects entries where:

  - primary_label is English (detected lang == 'en')
  - at least one alias OR the legacy ``name`` field is Korean
  - the English primary is NOT a brand shape (``_looks_like_brand``
    returns False)

For each match:
  - Swap ``primary_label`` to the Korean form.
  - Push the prior English primary into ``aliases`` (if not already
    there).
  - Update ``primary_lang`` to ``"ko"``.
  - Append a ``relabel_history`` audit entry.
  - Leave ``name``/``name_en`` legacy fields untouched (back-compat
    with old recall paths).

Dry-run by default; pass ``--apply`` to actually write.
Idempotent: safe to re-run. Only relabels what still matches the
predicate; on a second pass the just-relabeled docs have a Korean
``primary_lang`` and are skipped.

This is the B-62-fix follow-up that pairs with the PR-B
``pick_natural_primary`` defense. The predicate must match PR-B's
heuristic exactly, so the script imports ``_detect_lang`` and
``_looks_like_brand`` from that module rather than re-implementing
them.

Usage::

    docker compose exec backend python -m scripts.relabel_legacy_korean_entities
    docker compose exec backend python -m scripts.relabel_legacy_korean_entities --apply
"""
from __future__ import annotations

import argparse
import logging
import re
import sys
from datetime import UTC, datetime
from typing import Any

from api.storage.elasticsearch.client import LUCID_OBJECTS, get_client


# REQ-004 STAGE 1d (PO 2026-06-30): entity_resolver.py DELETE 와 함께 옛
# import 끊김. 두 helper 는 이 script 만 쓰므로 inline (★ 5-10 lines, 다른
# 의존 0). gateway 의 normalize 와는 의도가 달라 (★ B-62-fix 의 brand-defense
# vs gateway 의 surface 정규화) 별도 유지.
_BRAND_SHAPE_RE = re.compile(r"^[A-Za-z][A-Za-z0-9]{1,15}$")


def _detect_lang(text: str) -> str:
    """Crude heuristic — Hangul 한 글자라도 있으면 ko, 아니면 en."""
    if not text:
        return "en"
    for ch in text:
        if "가" <= ch <= "힣" or "ᄀ" <= ch <= "ᇿ" or "㄰" <= ch <= "㆏":
            return "ko"
    return "en"


def _looks_like_brand(text: str | None) -> bool:
    """B-62-fix: single Latin token, 2-16 chars = brand. 공백 있으면 X."""
    if not text:
        return False
    s = str(text).strip()
    if not s:
        return False
    return bool(_BRAND_SHAPE_RE.match(s))

logger = logging.getLogger("lucid.scripts.relabel_legacy")

_SCAN_SIZE = 2000


def _alias_label(a: Any) -> str:
    """Aliases in lucid_objects are plain strings today; accept dict
    shape defensively too and always return the bare label."""
    if isinstance(a, dict):
        return str(a.get("label", "") or "")
    return str(a or "")


def find_candidates(client: Any) -> list[dict[str, Any]]:
    """Return list of {id, current_primary, korean_alias, doc} for
    relabel."""
    res = client.search(
        index=LUCID_OBJECTS,
        size=_SCAN_SIZE,
        query={"match_all": {}},
    )
    out: list[dict[str, Any]] = []
    for h in res["hits"]["hits"]:
        s = h["_source"]
        primary = s.get("primary_label") or s.get("name", "")
        primary_lang = s.get("primary_lang") or _detect_lang(primary)
        if primary_lang != "en":
            continue
        if _looks_like_brand(primary):
            continue
        aliases = s.get("aliases") or []
        ko_alias: str | None = None
        for a in aliases:
            label = _alias_label(a)
            if label and _detect_lang(label) == "ko":
                ko_alias = label
                break
        if not ko_alias:
            legacy_name = s.get("name", "")
            if (
                legacy_name
                and _detect_lang(legacy_name) == "ko"
                and legacy_name != primary
            ):
                ko_alias = legacy_name
        if not ko_alias:
            continue
        out.append({
            "id": h["_id"],
            "current_primary": primary,
            "korean_alias": ko_alias,
            "doc": s,
        })
    return out


def relabel(client: Any, item: dict[str, Any]) -> None:
    """Write the swap for one candidate."""
    old_primary = item["current_primary"]
    new_primary = item["korean_alias"]
    doc = item["doc"]

    raw_aliases = list(doc.get("aliases") or [])
    new_aliases: list[str] = []
    seen_lc: set[str] = set()
    for a in raw_aliases:
        label = _alias_label(a)
        if not label:
            continue
        if label == new_primary or label.lower() == new_primary.lower():
            continue
        if label.lower() in seen_lc:
            continue
        seen_lc.add(label.lower())
        new_aliases.append(label)

    if old_primary and old_primary.lower() not in seen_lc:
        new_aliases.append(old_primary)
        seen_lc.add(old_primary.lower())

    prior_history = list(doc.get("relabel_history") or [])
    update_body: dict[str, Any] = {
        "primary_label": new_primary,
        "primary_lang": "ko",
        "aliases": new_aliases,
        "relabel_history": [
            *prior_history,
            {
                "at": datetime.now(UTC).isoformat(),
                "from_primary": old_primary,
                "to_primary": new_primary,
                "reason": "B-62-fix legacy Korean common-noun relabel",
            },
        ],
    }

    client.update(
        index=LUCID_OBJECTS,
        id=item["id"],
        doc=update_body,
        refresh="wait_for",
    )


def ensure_relabel_history_mapping(client: Any) -> None:
    """Non-destructively register the ``relabel_history`` nested field
    on the LUCID_OBJECTS index. ``put_mapping`` is purely additive."""
    try:
        client.indices.put_mapping(
            index=LUCID_OBJECTS,
            properties={
                "relabel_history": {
                    "type": "nested",
                    "properties": {
                        "at": {"type": "date"},
                        "from_primary": {"type": "keyword"},
                        "to_primary": {"type": "keyword"},
                        "reason": {"type": "keyword"},
                    },
                },
            },
        )
    except Exception as e:  # noqa: BLE001
        logger.warning("put_mapping for relabel_history skipped: %s", e)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--apply",
        action="store_true",
        help="Commit the relabels. Without this, dry-run only.",
    )
    args = parser.parse_args(argv)

    logging.basicConfig(level=logging.INFO, format="%(message)s")

    client = get_client()
    candidates = find_candidates(client)

    print(f"Found {len(candidates)} entity/entities to relabel:")
    for c_ in candidates:
        print(
            f"  {str(c_['id'])[:8]}  '{c_['current_primary']}'  ->  "
            f"'{c_['korean_alias']}'"
        )

    if not args.apply:
        print("\n[dry-run] Pass --apply to commit the changes.")
        return 0

    ensure_relabel_history_mapping(client)

    if not candidates:
        print("\n[apply] nothing to do.")
        return 0

    print(f"\n[apply] Writing changes to {LUCID_OBJECTS}...")
    for c_ in candidates:
        relabel(client, c_)
        print(f"  relabeled {str(c_['id'])[:8]}")

    print(f"\nDone. {len(candidates)} entity/entities relabeled.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
