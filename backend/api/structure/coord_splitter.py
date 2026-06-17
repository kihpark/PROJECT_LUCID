"""B-33: split coordinated subjects into atomic facts.

Background
----------
The Claude decomposer sometimes emits a single fact for a claim that
mentions multiple coordinated subjects ("Goldman Sachs와 Morgan
Stanley가 SpaceX의 주관사단에 포함되어 있다."). The graph then carries
one triple where two are appropriate, so the second subject becomes
invisible to recall / Stellar even though it was recognised as an
Object at the same time.

The Step 3a prompt rule (prompts.py) asks the LLM to split such
claims itself. This module is the deterministic safety net that fires
when the LLM emits exactly one fact for a clearly-coordinated claim.

Distributive coordination -> SPLIT (one atomic per subject)
Joint / reciprocal relation -> KEEP (splitting destroys the relation)

Heuristic
---------
1. The claim text must contain >=2 named Objects from `result.objects`,
   of the SAME class as the LLM-picked subject (so e.g. "SpaceX와 IPO"
   doesn't qualify because IPO is `event`, not `organization`).
2. The names appear in claim-order as a coordination chain: the subject
   plus all candidates form a contiguous run separated only by coord
   punctuation / conjunctions / whitespace. This is what handles
   "Alpha, Bravo, and Charlie" cleanly while rejecting
   "Apple's CEO ..., in a private meeting, ... Google's Sundar Pichai."
3. The predicate must NOT be on the joint-relation list — that list
   captures relations whose meaning IS the pair (merge, partner,
   collaborate, married_to, competed_against, …). Splitting those
   would generate factual nonsense.

Every emitted-by-splitter fact carries `tags_suggested += "coord_split"`
so the Decide overlay shows it as a derived fact the PO can audit and
discard if the heuristic over-fired.
"""
from __future__ import annotations

import re

from api.structure.models import (
    StructureFact,
    StructureFactObjectLink,
    StructureObject,
    StructureResult,
)

# Joint / reciprocal relations: predicate substrings that mean
# "splitting would destroy the relation". Conservative — easier to add
# false negatives (we miss a split) than false positives (we split a
# merger). Match as substring + case-insensitive on the predicate snake
# string the LLM emits (e.g. "merged_with", "partnered_with").
JOINT_PREDICATE_MARKERS: tuple[str, ...] = (
    "merge",         # merged_with, merger_of
    "partner",       # partnered_with
    "collab",        # collaborated_with
    "compete",       # competed_against
    "ally",          # allied_with
    "allied",
    "married",       # married_to
    "reciproc",      # reciprocal_*
    "mutual",        # mutual_*
    "tied",          # tied_with
    "equal",         # equals, equal_to
    "symmetric",
    "vs_",
    "versus",
    "against",
    "agreed_with",
    "shared_with",   # shared 50/50
    "twin",
)


# A "pure coord separator" is text between two named entities that
# contains nothing but coord punctuation, conjunction tokens, and
# whitespace. The chain check (below) walks consecutive named-entity
# positions and requires every gap to match this pattern.
#
# Note the use of \b around the English conjunction so "and" only
# matches as a standalone word — "Bondhand" wouldn't qualify.
_PURE_COORD_BETWEEN = re.compile(
    r"^\s*(?:[,·&]|\band\b|[와과및])(?:\s*[,·&]|\s*\band\b|\s*[와과및])*\s*$",
    re.IGNORECASE,
)


def _is_joint_predicate(predicate: str | None) -> bool:
    if not predicate:
        return False
    p = predicate.lower()
    return any(m in p for m in JOINT_PREDICATE_MARKERS)


def _first_pos(claim: str, name: str) -> int | None:
    """Index of the first occurrence of `name` in `claim`, or None."""
    if not name:
        return None
    idx = claim.find(name)
    return idx if idx >= 0 else None


def _strip_names(text: str, names: list[str]) -> str:
    """Remove every occurrence of every name from `text`, longest first
    so a longer name doesn't leave a partial substring behind. Used to
    mask intermediate object names from the between-region before the
    pure-coord-separator check ("Alpha, Bravo, and Charlie" -> the
    between-region between Alpha and Charlie reads ", Bravo, and ",
    which becomes ", , and " after masking Bravo, and THAT IS a pure
    coord separator)."""
    out = text
    for n in sorted({n for n in names if n}, key=len, reverse=True):
        out = out.replace(n, "")
    return out


def _all_in_coord_chain(
    claim: str,
    names: list[str],
    mask_intermediate: list[str] | None = None,
) -> bool:
    """True iff every name in `names` appears in `claim` AND, taken in
    claim-order, every consecutive pair is separated by only coord
    punctuation / conjunctions / whitespace.

    `mask_intermediate` lets the caller hide other known object names
    from the between-region check, so a claim like
    "Goldman Sachs and Morgan Stanley underwrote the SpaceX IPO." still
    qualifies Goldman + Morgan as coord even when SpaceX (a same-class
    organisation) is also in the claim — SpaceX sits outside the coord
    run, not in the between-region.

    Rejects "Apple's CEO ..., in a private meeting, ... Google's
    Sundar Pichai." because the masked between-region still contains
    real prose, not just coord punctuation.
    """
    positions: list[tuple[int, int]] = []
    for n in names:
        pos = _first_pos(claim, n)
        if pos is None:
            return False
        positions.append((pos, pos + len(n)))
    positions.sort()
    mask_set = list(mask_intermediate or [])
    for i in range(len(positions) - 1):
        between = claim[positions[i][1] : positions[i + 1][0]]
        if mask_set:
            between = _strip_names(between, mask_set)
        if not _PURE_COORD_BETWEEN.match(between):
            return False
    return True


def _name_indices(objects: list[StructureObject]) -> dict[str, StructureObject]:
    """Build `name -> object` and `name_en -> object` lookups. Longer
    names win on key collision so `"Goldman Sachs"` is preferred over
    `"Goldman"` if both exist."""
    out: dict[str, StructureObject] = {}
    by_length = sorted(objects, key=lambda o: len(o.name or ""), reverse=True)
    for o in by_length:
        if o.name and o.name not in out:
            out[o.name] = o
        if o.name_en and o.name_en not in out:
            out[o.name_en] = o
    return out


def _next_uid_suffix(index: int) -> str:
    """0->'a', 1->'b', ... 25->'z', 26->'aa', 27->'ab', ..."""
    if index < 0:
        raise ValueError("suffix index must be >= 0")
    out = ""
    n = index
    while True:
        out = chr(ord("a") + n % 26) + out
        n = n // 26 - 1
        if n < 0:
            break
    return out


def _name_in_claim(obj: StructureObject, claim: str) -> str | None:
    """Pick the longest of (name, name_en) that actually appears in
    `claim`. Returns None if neither does."""
    candidates = [n for n in (obj.name, obj.name_en) if n and n in claim]
    if not candidates:
        return None
    return max(candidates, key=len)


def split_coordinated_subjects(result: StructureResult) -> StructureResult:
    """Return a new StructureResult whose `facts` and
    `fact_object_links` include any coord-split derivations.

    Original facts are preserved unchanged at their original positions;
    split-derived facts are appended after each source fact. All other
    fields of the StructureResult are returned untouched.
    """
    if not result.facts or not result.objects:
        return result

    name_to_obj = _name_indices(result.objects)
    uid_to_obj = {o.uid: o for o in result.objects}

    new_facts: list[StructureFact] = []
    derived_links: list[StructureFactObjectLink] = []

    for f in result.facts:
        new_facts.append(f)

        if _is_joint_predicate(f.predicate):
            continue

        subject_obj = uid_to_obj.get(f.subject_uid)
        if subject_obj is None:
            continue

        subject_name = _name_in_claim(subject_obj, f.claim)
        if subject_name is None:
            continue

        # Candidate Objects: same class as the subject, name(s) actually
        # appear in claim, and uid differs from subject.
        candidates: list[tuple[StructureObject, str]] = []
        seen_uids = {subject_obj.uid}
        for _name, obj in name_to_obj.items():
            if obj.uid in seen_uids:
                continue
            if obj.class_ != subject_obj.class_:
                continue
            picked = _name_in_claim(obj, f.claim)
            if picked is None:
                continue
            candidates.append((obj, picked))
            seen_uids.add(obj.uid)

        if not candidates:
            continue

        # Per-candidate test: keep only candidates that lie on a
        # pure-coord chain with the subject. Each candidate is tested
        # independently so a same-class noun that happens to appear
        # OUTSIDE the coord run (e.g. "SpaceX IPO" later in the claim)
        # doesn't disqualify a real coord pair earlier in the claim.
        # Other candidates' names that fall between subject and the
        # candidate under test are masked so "A, B, and C" admits all
        # three as a coord chain.
        all_candidate_names = [n for _, n in candidates]
        accepted: list[tuple[StructureObject, str]] = []
        for obj, picked in candidates:
            mask = [n for n in all_candidate_names if n != picked]
            if _all_in_coord_chain(
                f.claim, [subject_name, picked], mask_intermediate=mask,
            ):
                accepted.append((obj, picked))
        if not accepted:
            continue

        existing_tags = list(f.tags_suggested or [])
        for idx, (obj, _picked) in enumerate(accepted):
            new_uid = f"{f.uid}-{_next_uid_suffix(idx)}"
            new_fact = f.model_copy(
                update={
                    "uid": new_uid,
                    "subject_uid": obj.uid,
                    "tags_suggested": existing_tags + ["coord_split"],
                },
            )
            new_facts.append(new_fact)
            derived_links.append(
                StructureFactObjectLink(
                    fact_uid=new_uid,
                    object_uid=obj.uid,
                    link_type="involves",
                    properties={},
                ),
            )

    return result.model_copy(
        update={
            "facts": new_facts,
            "fact_object_links": list(result.fact_object_links) + derived_links,
        },
    )
