"""System prompt + few-shot examples for Claude decomposition (Sprint 3 PR-3-1).

Encodes the DCR-001 7-step algorithm (structure-stage-spec.md Appendix A §A.3),
the 13-concrete-class ontology (PR-1A-2), the 15-or-16 link types (DCR-001
added NEGATES so total is 5 + 4 + 7 = 16), and the Korean + English
negation token lists.

The system prompt is structured so that Anthropic prompt caching can
mark the entire system block as a single ephemeral cache key. The
user prompt carries only the merged_text + source metadata, which
varies per call and is not cached.
"""
from __future__ import annotations

NEGATION_TOKENS_EN = (
    "not", "no", "never", "n't", "prohibit", "forbid", "deny",
    "banned", "illegal", "fail to", "lack", "exclude",
)
NEGATION_TOKENS_KO = (
    "않다", "없다", "아니다", "못하다", "금지", "불가",
    "제외", "안 된다", "없는", "아닌",
)


SYSTEM_PROMPT = """\
You are the Structure stage of Lucid, a validated-knowledge-graph
system. Your job is to decompose a piece of merged_text (an article
body, a transcript, a highlighted selection, an image description,
or a PDF body) into:

  1. A list of Object candidates (people, places, concepts, etc.)
  2. A list of AtomicFact claims (each a single falsifiable statement)
  3. The links between them.

You operate on text the user has already captured into their
personal knowledge graph. The user will validate every output in a
later HITL step, so PRECISION over RECALL — when in doubt, emit
fewer facts rather than guessing.

# Ontology — 13 concrete Object classes

```
concept        abstract idea            (loss aversion, democracy)
person         individual               (Daniel Kahneman, 박기흥)
organization   institution / company    (European Commission, OpenAI)
service        product / service        (ChatGPT, GitHub Actions)
product        physical product         (GPT-5, iPhone 15)
place          geographic location      (Korea, EU, Pittsburgh)
knowledge      domain / discipline      (AI Governance, behavioral economics)
event          dated occurrence         (EU AI Act passage, COVID-19)
procedure      method / process         (facial recognition, fasted cardio)
task           todo / activity          (paper review, market analysis)
metric         measurement              (weekly active users, daily kcal)
resource       material / asset         (U.S. beef, semiconductor exports)
problem        issue / failure mode     (muscle loss, mad cow disease)
```

# Link types — 16 total

Fact ↔ Object (5):
  asserts_property   "X has property Y" (this fact asserts an Object property)
  describes_state    Fact describes the current state of an Object
  addresses          Fact addresses a Problem
  uses               Fact uses a Resource
  involves           Fact involves a Person / Organization

Object ↔ Object (4):
  part_of            Object A is part of Object B
  instance_of        Object A is an instance of Object class B
  located_in         Object A is located in Place B
  has_role           Person A has a role in Organization B

Fact ↔ Fact (7):
  supports           A supports B
  contradicts        A and B make incompatible claims
  example_of         A is an example of B
  derived_from       A is derived from B
  interprets         A interprets B
  supersedes         A replaces B (e.g., updated value)
  negates            A is the explicit negative statement of B (DCR-001)

# DCR-001 7-step algorithm

Run these IN ORDER on the input text:

  Step 1. Identify every Object mention in the text.
  Step 2. Assign each Object a class from the 13 above.
  Step 3. Decompose every assertion into one or more AtomicFact
          candidates (proposition or procedure). Each fact must be a
          SINGLE falsifiable statement.
  Step 3a. COORDINATED SUBJECTS / OBJECTS (B-33):
          When a clause carries a coordinated subject or object
          ("A와 B가 ~", "A and B ~", "A, B, and C did X"), emit ONE
          AtomicFact PER coordinated entity, each with a single
          subject (or object), the SAME predicate, and the SAME
          object value. Keep the original claim text on every emitted
          fact so the audit trail is preserved.
          EXAMPLE — distributive (SPLIT):
            "Goldman Sachs와 Morgan Stanley가 SpaceX의 주관사단에
            포함되어 있다."
            -> 2 facts:
               (Goldman Sachs)  --is_underwriter_for--> (SpaceX IPO)
               (Morgan Stanley) --is_underwriter_for--> (SpaceX IPO)
          EXCEPTION — joint / reciprocal relations (DO NOT SPLIT):
            "Disney와 Fox는 2019년에 합병했다."
            -> 1 fact:
               (Disney) --merged_with--> (Fox)
            Splitting destroys the relation: "Disney merged" alone
            is meaningless. Use these predicate families as the
            non-split signal: merge, partner, collaborate, ally,
            married_to, competed_against, equals, tied_with,
            mutually_*, reciprocally_*.
  Step 4. NEGATION DETECTION (DCR-001):
          - Scan the fact for negation tokens (English: not, no, never,
            n't, prohibit, forbid, deny, banned, illegal, fail to, lack,
            exclude; Korean: 않다, 없다, 아니다, 못하다, 금지, 불가,
            제외, 안 된다, 없는, 아닌).
          - If detected, set negation_flag=true and negation_scope:
              "full"     — the entire claim is negated
                           ("X does not exist")
              "partial"  — only part of the claim is negated
                           ("X is not Y, but X is Z")
          - If you cannot decide between full and partial, set
            negation_flag=true, negation_scope=null, AND set
            failure_reason="negation_ambiguous" at the top level.
          - **Forecast / conditional language** is also negation_ambiguous:
            "X might not happen", "AI might not replace everyone",
            "perhaps not", "It would be unfair to claim that X has no...",
            "할 수도", "할 수 있지만 ...아닐 수도", "만약", "if".
            These speculative or rhetorical negations are NOT decomposable
            facts; emit failure_reason="negation_ambiguous" with no facts.
  Step 5. Extract Fact <-> Object relations using the 5 link types.
  Step 6. Extract Fact <-> Fact relations using the 7 link types.
          NEGATES is directional (the negating party carries
          negation_flag=true and points TO the affirmed statement
          it negates, if both appear in the text).
  Step 7. DO NOT emit time metadata fields on facts. DR-053 retired
          valid_from, valid_until, is_stale, and stale_at from the
          schema. Time information BELONGS INSIDE the claim text and
          the predicate (e.g. "2024-12" as part of the claim string,
          or as_of inside an Object metric's properties dict).
          The structure pipeline's defence layer silently drops
          unknown fact-level keys, so emitting valid_from doesn't
          break the parse — but every token spent on it is wasted.

# Failure modes — be honest

If the text contains nothing decomposable into AtomicFacts, return:

  {
    "objects": [],
    "facts": [],
    "fact_object_links": [],
    "fact_fact_links": [],
    "disambiguation_candidates": [],
    "extraction_status": "no_facts_found",
    "failure_reason": one of:
      "opinion_content"        — the text is subjective opinion or emotion
      "advertisement"          — promotional / marketing copy
      "non_factual_creative"   — fiction, poetry, art
      "ambiguous_attribution"  — speaker / source is unclear
      "non_verifiable"         — metaphysical or unfalsifiable claims
  }

# Output format — strict JSON

Reply with ONE JSON object matching this schema exactly. Do NOT wrap
it in markdown fences. Do NOT include any prose outside the JSON.

```json
{
  "objects": [
    {
      "uid": "obj-1",
      "class": "person",
      "name": "Daniel Kahneman",
      "name_en": "Daniel Kahneman",
      "properties": {}
    }
  ],
  "facts": [
    {
      "uid": "fn-1",
      "type": "proposition",
      "claim": "Daniel Kahneman published Prospect Theory in 1979.",
      "subject_uid": "obj-1",
      "predicate": "published",
      "object_value": "Prospect Theory",
      "negation_flag": false,
      "negation_scope": null,
      "tags_suggested": ["behavioral_economics", "1979"]
    }
  ],
  "fact_object_links": [
    {
      "fact_uid": "fn-1",
      "object_uid": "obj-1",
      "link_type": "involves",
      "properties": {}
    }
  ],
  "fact_fact_links": [],
  "disambiguation_candidates": [],
  "extraction_status": "success",
  "failure_reason": null
}
```
"""


# Few-shot examples (kept short to control token cost).  Each example
# carries the source text + the expected JSON, in order:
#   1. Korean + English proposition with no negation
#   2. Korean partial negation
#   3. Opinion / non-decomposable failure

FEW_SHOT_EXAMPLES = [
    {
        "input": (
            "Daniel Kahneman published Prospect Theory in 1979. "
            "프로스펙트 이론에서 손실 회피 계수는 평균 2.25다."
        ),
        "output": {
            "objects": [
                {"uid": "obj-1", "class": "person", "name": "Daniel Kahneman",
                 "name_en": "Daniel Kahneman", "properties": {}},
                {"uid": "obj-2", "class": "knowledge", "name": "Prospect Theory",
                 "name_en": "Prospect Theory", "properties": {}},
                {"uid": "obj-3", "class": "metric",
                 "name": "loss aversion coefficient",
                 "name_en": "loss aversion coefficient",
                 "properties": {"value": 2.25}},
            ],
            "facts": [
                {"uid": "fn-1", "type": "proposition",
                 "claim": "Daniel Kahneman published Prospect Theory in 1979.",
                 "subject_uid": "obj-1", "predicate": "published",
                 "object_value": "Prospect Theory", "negation_flag": False,
                 "negation_scope": None, "tags_suggested": ["1979"]},
                {"uid": "fn-2", "type": "proposition",
                 "claim": "프로스펙트 이론에서 손실 회피 계수는 평균 2.25다.",
                 "subject_uid": "obj-2", "predicate": "average_value_of",
                 "object_value": "2.25", "negation_flag": False,
                 "negation_scope": None, "tags_suggested": []},
            ],
            "fact_object_links": [
                {"fact_uid": "fn-1", "object_uid": "obj-1",
                 "link_type": "involves", "properties": {}},
                {"fact_uid": "fn-2", "object_uid": "obj-2",
                 "link_type": "describes_state", "properties": {}},
                {"fact_uid": "fn-2", "object_uid": "obj-3",
                 "link_type": "asserts_property", "properties": {}},
            ],
            "fact_fact_links": [
                {"from_uid": "fn-2", "to_uid": "fn-1",
                 "link_type": "supports"}
            ],
            "disambiguation_candidates": [],
            "extraction_status": "success",
            "failure_reason": None,
        },
    },
    {
        "input": "EU AI Act는 군사 분야에는 적용되지 않는다.",
        "output": {
            "objects": [
                {"uid": "obj-1", "class": "event", "name": "EU AI Act",
                 "name_en": "EU AI Act", "properties": {}},
                {"uid": "obj-2", "class": "knowledge", "name": "military domain",
                 "name_en": "military domain", "properties": {}},
            ],
            "facts": [
                {"uid": "fn-1", "type": "proposition",
                 "claim": "EU AI Act는 군사 분야에는 적용되지 않는다.",
                 "subject_uid": "obj-1", "predicate": "applies_to",
                 "object_value": "military",
                 "negation_flag": True, "negation_scope": "partial",
                 "tags_suggested": ["EU", "military"]},
            ],
            "fact_object_links": [
                {"fact_uid": "fn-1", "object_uid": "obj-1",
                 "link_type": "describes_state", "properties": {}},
                {"fact_uid": "fn-1", "object_uid": "obj-2",
                 "link_type": "addresses", "properties": {}},
            ],
            "fact_fact_links": [],
            "disambiguation_candidates": [],
            "extraction_status": "success",
            "failure_reason": None,
        },
    },
    {
        "input": "오늘 아침 커피가 정말 맛있었다. 인생은 너무 짧다.",
        "output": {
            "objects": [],
            "facts": [],
            "fact_object_links": [],
            "fact_fact_links": [],
            "disambiguation_candidates": [],
            "extraction_status": "no_facts_found",
            "failure_reason": "opinion_content",
        },
    },
    {'input': '한국은행 기준금리는 2024년 12월 기준 3.0%였다.', 'output': {'objects': [{'uid': 'obj-1', 'class': 'organization', 'name': '한국은행', 'name_en': 'Bank of Korea', 'properties': {}}, {'uid': 'obj-2', 'class': 'metric', 'name': '기준금리', 'name_en': 'base interest rate', 'properties': {'value': 3.0, 'unit': 'percent', 'as_of': '2024-12'}}], 'facts': [{'uid': 'fn-1', 'type': 'proposition', 'claim': '한국은행 기준금리는 2024년 12월 기준 3.0%였다.', 'subject_uid': 'obj-1', 'predicate': 'base_rate_value', 'object_value': '3.0%', 'negation_flag': False, 'negation_scope': None, 'tags_suggested': ['KR', '2024-12']}], 'fact_object_links': [{'fact_uid': 'fn-1', 'object_uid': 'obj-1', 'link_type': 'involves', 'properties': {}}, {'fact_uid': 'fn-1', 'object_uid': 'obj-2', 'link_type': 'asserts_property', 'properties': {}}], 'fact_fact_links': [], 'disambiguation_candidates': [], 'extraction_status': 'success', 'failure_reason': None}},
    {'input': '삼성전자는 2023년 4분기에 23조 원의 영업이익을 기록했다. 반도체 부문이 흑자로 전환했고, 디스플레이는 흑자가 축소되었다.', 'output': {'objects': [{'uid': 'obj-1', 'class': 'organization', 'name': '삼성전자', 'name_en': 'Samsung Electronics', 'properties': {}}, {'uid': 'obj-2', 'class': 'metric', 'name': '영업이익', 'name_en': 'operating profit', 'properties': {'value': 23, 'unit': '조원', 'period': '2023Q4'}}, {'uid': 'obj-3', 'class': 'knowledge', 'name': '반도체 부문', 'name_en': 'semiconductor segment', 'properties': {}}, {'uid': 'obj-4', 'class': 'knowledge', 'name': '디스플레이 부문', 'name_en': 'display segment', 'properties': {}}], 'facts': [{'uid': 'fn-1', 'type': 'proposition', 'claim': '삼성전자는 2023년 4분기에 23조 원의 영업이익을 기록했다.', 'subject_uid': 'obj-1', 'predicate': 'operating_profit', 'object_value': '23조원', 'negation_flag': False, 'negation_scope': None, 'tags_suggested': ['KR', '2023Q4']}, {'uid': 'fn-2', 'type': 'proposition', 'claim': '반도체 부문이 흑자로 전환했다.', 'subject_uid': 'obj-3', 'predicate': 'transition_to', 'object_value': '흑자', 'negation_flag': False, 'negation_scope': None, 'tags_suggested': ['KR']}, {'uid': 'fn-3', 'type': 'proposition', 'claim': '디스플레이는 흑자가 축소되었다.', 'subject_uid': 'obj-4', 'predicate': 'profit_change', 'object_value': '축소', 'negation_flag': False, 'negation_scope': None, 'tags_suggested': ['KR']}], 'fact_object_links': [{'fact_uid': 'fn-1', 'object_uid': 'obj-1', 'link_type': 'involves', 'properties': {}}, {'fact_uid': 'fn-1', 'object_uid': 'obj-2', 'link_type': 'asserts_property', 'properties': {}}, {'fact_uid': 'fn-2', 'object_uid': 'obj-3', 'link_type': 'describes_state', 'properties': {}}, {'fact_uid': 'fn-3', 'object_uid': 'obj-4', 'link_type': 'describes_state', 'properties': {}}], 'fact_fact_links': [{'from_uid': 'fn-2', 'to_uid': 'fn-1', 'link_type': 'supports'}, {'from_uid': 'fn-3', 'to_uid': 'fn-1', 'link_type': 'supports'}], 'disambiguation_candidates': [], 'extraction_status': 'success', 'failure_reason': None}},
    {'input': '삼성은 1938년에 설립된 한국의 대기업 그룹이다.', 'output': {'objects': [{'uid': 'obj-1', 'class': 'organization', 'name': '삼성', 'name_en': 'Samsung', 'properties': {'founded_year': 1938, 'country': 'Korea', 'type': 'conglomerate'}}], 'facts': [{'uid': 'fn-1', 'type': 'proposition', 'claim': '삼성은 1938년에 설립된 한국의 대기업 그룹이다.', 'subject_uid': 'obj-1', 'predicate': 'founded_year', 'object_value': '1938', 'negation_flag': False, 'negation_scope': None, 'tags_suggested': ['KR', '1938', 'conglomerate']}], 'fact_object_links': [{'fact_uid': 'fn-1', 'object_uid': 'obj-1', 'link_type': 'involves', 'properties': {}}], 'fact_fact_links': [], 'disambiguation_candidates': [{'fact_uid': 'fn-1', 'mention_text': '삼성', 'candidate_object_uids': [], 'scores': []}], 'extraction_status': 'success', 'failure_reason': None}},
]


def build_user_message(merged_text: str, metadata: dict | None = None) -> str:
    """Build the per-call user message containing the merged_text + meta."""
    metadata = metadata or {}
    source_url = metadata.get("source_url", "(no source)")
    captured_from = metadata.get("captured_from", "(unknown)")
    return (
        "## Source\n"
        f"source_url: {source_url}\n"
        f"captured_from: {captured_from}\n"
        "\n"
        "## Text\n"
        f"{merged_text}\n"
        "\n"
        "Decompose this text per the 7-step algorithm above and reply "
        "with a single JSON object matching the schema. NO markdown fences, "
        "NO prose outside the JSON."
    )
