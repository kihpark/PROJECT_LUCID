# Discovery — feat/spo-subject-language-by-type

PO directive 2026-06-22: type-based language dispatch for subject/object
entities. Replaces the unconditional violation+recovery branch from the
6th round (`feat/spo-subject-claim-recovery`, `de9e66b`) with a 4-way
dispatch keyed on the LLM-emitted entity_type.

## 0.1 LLM `entity_type` emission — status BEFORE this PR

### Prompt (`backend/api/structure/prompts.py`)

The current prompt **does NOT ask the LLM to emit a separate
`entity_type` field per subject/object**.

The closest existing concept is `class` (the 13-element ontology in
`models.objects.ObjectClass`): `concept / person / organization /
service / product / place / knowledge / event / procedure / task /
metric / resource / problem`. This is emitted on each `StructureObject`
but is too coarse for the new dispatch:
  - `organization` covers BOTH "company" (AeroVironment, SpaceX,
    Samsung) — should stay English — AND "government / institution"
    (중국 상무부, 한국은행, 국방부) — should stay Korean.
  - `place` covers BOTH country ("일본") and city.

So we cannot reuse `class` directly. We need a NEW LLM-supplied
field. This PR adds:
  - `entity_type` on `StructureObject` — orthogonal to `class`,
    optional, only consulted by `_match_object` dispatch.
  - `person_origin` on `StructureObject` — only meaningful when
    `entity_type == "person"`.

Both default to `None` for backward-compat. When `None`, the
`_match_object` dispatch falls through to the 6th-round behavior
(violation detection + claim recovery) so older captures don't break.

### Model (`backend/api/structure/models.py`)

`StructureObject` exposes:
  - `uid: UID`
  - `class_: ObjectClass = Field(alias="class")`
  - `name: str`
  - `name_en: str | None = None`
  - `aliases: list[str] = Field(default_factory=list)`
  - `properties: dict[str, Any] = Field(default_factory=dict)`

No `entity_type`, no `person_origin`. We add both as optional fields.
`claude_client.py::_build_result` hydrates via
`StructureResult.model_validate(parsed)`, so adding fields to the
Pydantic model is sufficient — there is no manual field-by-field
marshalling.

## 0.2 6th-round violation+recovery wire location

`backend/api/structure/processor.py::_match_object` lines 146-298 (the
function), with the unconditional violation+recovery branch at lines
207-272. The dispatch replaces the linear flow:

  surface_seed → strip_korean_particles → brand_resolver → detect_violation
                                                          → recover_korean_subject_from_claim
                                                          → needs_review

with a 4-way branch on `entity_type`:

  - "company" / "brand" / "product"  → brand_resolver + LLM English `name`, NO recovery.
  - "person" with person_origin == "ko" → 6th-round behavior (claim recovery).
  - "person" with person_origin != "ko" → trust LLM English/canonical, NO recovery.
  - "country" / "government" / "institution" / "concept" / "policy" / "event" / "location"
      → 6th-round behavior (claim recovery).
  - else (None / unknown) → 6th-round behavior (safe default for legacy captures).

## 0.3 brand_resolver state

`backend/api/structure/brand_resolver.py::_KO_TO_EN_BRAND` has 15
entries (SpaceX, OpenAI, IBM, Nvidia, Google, Apple, Microsoft, Meta,
Tesla, Amazon, Twitter, Facebook, Intel, OpenAI variants).

"에이비옥스" is **not** in this map, and per the PO directive we
**must not** add it. The fix:
  - `entity_type=="company"` + `brand_resolver(strip_korean_particles(surface))` returns
    something → use that ("스페이스X" → "SpaceX", known).
  - Otherwise → trust the LLM's English `name` field. The LLM
    correctly extracted "AeroVironment" for the Korean text
    "에이비옥스가 거래 종목에 포함되었다", and we keep that.

Why this works: the LLM is good at company canonicalization (its
training data covers AeroVironment, Lockheed Martin, etc.). The
dictionary handles only the cases where the LLM might fail (Korean
transliterations that happen to roundtrip to canonical English).
