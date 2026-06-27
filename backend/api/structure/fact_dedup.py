"""Structure-stage fact dedup (fix/fact-dedup-on-structure-output).

PO 2026-06-27 — the LLM occasionally multi-emits the same atomic fact
under different fact_uids when (a) the source repeats the same claim
across paragraphs and (b) the deterministic predicate mapper degrades
the verb to RELATED_TO (so two facts that should differ via predicate
collapse to the same canonical tuple). Live evidence
(job_id=3bab7b79-3fdc-4a87-a9ec-5e7273e76847): 14 facts emitted, four
exact (subject, RELATED_TO, None) duplicates clutter the Decide UI.

`dedup_facts` runs over the serialized `facts_payload` (the dicts
written to `extracted_metadata.structure.facts`) and keeps the first
occurrence of each canonical (subject, predicate_code, object) tuple.
The match is case- and whitespace-insensitive, and `object_label`
(entity reference) takes precedence over `object_value` (literal) —
matching the precedence the recall surface uses to display the object
side.

The dropped fact_uids are returned so the caller can also filter the
`fact_object_links_detail` / `fact_fact_links_detail` cross-references
that point at them — leaving dangling edges would surface ghost rows
in the Decide overlay.
"""
from __future__ import annotations

from typing import Any


def _norm_lower(value: Any) -> str:
    """Whitespace-strip + lowercase a value for tuple-key normalization.

    None / non-string values collapse to empty string so the tuple
    stays comparable. The empty tuple ("", "", "") is itself unique —
    the caller keeps the first such fact.
    """
    if value is None:
        return ""
    text = str(value).strip().lower()
    return text


def _norm_upper(value: Any) -> str:
    """Same as _norm_lower but uppercased — used for the predicate_code
    segment so the OPL code ("RELATED_TO") normalizes consistently
    regardless of source casing.
    """
    if value is None:
        return ""
    return str(value).strip().upper()


def _fact_key(fact: dict[str, Any]) -> tuple[str, str, str]:
    """Build the canonical dedup tuple for one serialized fact dict.

    Field precedence mirrors the recall surface:
      subject: subject_label > subject_uid
      predicate: predicate_code > predicate
      object: object_label > object_value
    """
    subject = fact.get("subject_label") or fact.get("subject_uid")
    predicate = fact.get("predicate_code") or fact.get("predicate")
    obj = fact.get("object_label") or fact.get("object_value")
    return (_norm_lower(subject), _norm_upper(predicate), _norm_lower(obj))


def dedup_facts(
    facts: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], set[str]]:
    """Drop duplicate facts by canonical (subject, predicate, object) tuple.

    Keep the first occurrence; collect the dropped facts' uids (both
    `fact_uid` and `uid` aliases are checked, since the processor's
    serializer projects both onto the dict). Returns the deduped list
    and the set of dropped uids so the caller can cascade-filter the
    detail-link lists.

    The function never mutates the input list (the caller may want it
    for telemetry).
    """
    if not facts:
        return [], set()

    seen: set[tuple[str, str, str]] = set()
    kept: list[dict[str, Any]] = []
    dropped_uids: set[str] = set()
    for fact in facts:
        if not isinstance(fact, dict):
            # Defensive — shouldn't happen given the serializer, but
            # we don't want a stray non-dict to crash the structure
            # pipeline. Pass it through untouched.
            kept.append(fact)
            continue
        key = _fact_key(fact)
        if key in seen:
            for uid_field in ("fact_uid", "uid"):
                val = fact.get(uid_field)
                if isinstance(val, str) and val:
                    dropped_uids.add(val)
            continue
        seen.add(key)
        kept.append(fact)
    return kept, dropped_uids


def filter_links_by_fact_uids(
    links: list[dict[str, Any]],
    dropped_uids: set[str],
    *,
    uid_fields: tuple[str, ...],
) -> list[dict[str, Any]]:
    """Drop any link whose `uid_fields` reference a dropped fact.

    Used to cascade-filter `fact_object_links_detail` (uid_fields=
    ("fact_uid",)) and `fact_fact_links_detail` (uid_fields=
    ("from_uid", "to_uid")) so the structure metadata stays internally
    consistent after fact dedup.
    """
    if not dropped_uids or not links:
        return list(links)
    out: list[dict[str, Any]] = []
    for link in links:
        if not isinstance(link, dict):
            out.append(link)
            continue
        if any(link.get(field) in dropped_uids for field in uid_fields):
            continue
        out.append(link)
    return out


__all__ = ["dedup_facts", "filter_links_by_fact_uids"]
