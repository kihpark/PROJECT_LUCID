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

  Step 2a. B-52 — PRESERVE THE SOURCE-LANGUAGE SURFACE FORM.

          FAITHFUL DECOMPOSITION RULE (PO 2026-06-23):

          각 fact 의 subject / predicate / object 는 **소스 텍스트의
          언어 그대로** 표현하세요. 번역·정규화·canonical 변환·
          로마자화 자체가 위반입니다.

            한국어 기사 → subject "중국", predicate "발표했다",
                          object "발표 내용" 등 모두 한국어로.
            영어 기사   → subject "OpenAI", predicate "announced",
                          object "GPT-5" 모두 영어로.
            일본어 기사 → 일본어 그대로.

          브랜드/회사명이 영어 표기로 원문에 등장하면 영어 그대로
          유지하세요 (SpaceX, Lockheed Martin). 한국어 음역으로
          등장하면 (스페이스X) 그것도 그대로. 번역하지 마세요.

          Object 의 `name` 도 위 규칙을 따릅니다. 한국어 기사의
          "중국 상무부"는 name="중국 상무부". 영어 정규형을 만들고
          싶으면 `name_en`(선택)에 적고, 한국어 원문 표기를 `aliases`
          배열에 함께 보관하세요. 예:
            source: "중국 상무부는 ..."
              → {"name":"중국 상무부",
                 "name_en":"Ministry of Commerce of China",
                 "aliases":[]}
            source: "Bank of Korea announced ..."
              → {"name":"Bank of Korea", "name_en":"Bank of Korea",
                 "aliases":[]}
            source: "삼성전자는 ..."
              → {"name":"삼성전자",
                 "name_en":"Samsung Electronics", "aliases":[]}

  Step 2b. B-53 — KEEP FACT TEXT IN THE SOURCE LANGUAGE.
          The fact's `claim`, `predicate`, and `object_value` MUST all
          be written in the same language as the source text. Do
          NOT translate numbers, units, idioms, or quoted phrases.

          PREDICATE 도 동사구 그대로 (PO 2026-06-23, decide-payload-wire):
          predicate 는 source 언어의 동사·서술어를 그대로 사용:
            한국어 기사: "선출했다", "출신이다", "발표했다", "올렸다",
                         "조달했다", "축소되었다"
            영어  기사: "elected", "is_former_member_of", "announced",
                         "raised_funding"
          한국어 기사에 snake_case 영어 predicate (예: "elected_president",
          "imposed_export_control_on", "announces_export_control") 출력
          금지. 한국어 기사면 한국어 동사구만, 영어 기사면 영어만.

          RULE — 완전성 (PO 2026-06-23, decomp-completeness):

          각 fact 의 subject, predicate, object 가 **합쳐서 원문 문장의
          핵심 의미를 보존**해야 합니다. 핵심 명사·수식구가 셋 중 어디에도
          안 들어가면 분해 부실입니다.

            - predicate = **의미적으로 완전한 술어구** (동사만 자르지 마세요)
              "10곳을 수출통제 대상에 올렸다" → predicate = "수출통제 대상에 올렸다"
              NOT "올렸다" (수식·목적구 누락)

            - object = **완전한 명사구** (빈약 토막 아님)
              "미국 기업 10곳을" → object = "미국 기업 10곳"
              NOT "10곳" (수식어 누락)

            - 의미 변형·요약 금지. 원문에 있는 단어만 사용.
              자르기만, 내용 추가 금지.

          원칙: subject + predicate + object 텍스트를 합치면 원문의 핵심을
          누락 없이 담아야 합니다. 동사 하나, 명사 한 토막으로 줄이지 마세요.

          예 1:
            source: "중국 정부가 미국 기업 10곳을 수출통제 대상에 올렸다."
              OK    S="중국 정부", P="수출통제 대상에 올렸다", O="미국 기업 10곳"
              NOT   S="중국",       P="올렸다",                 O="10곳"
          예 2:
            source: "중국 정부가 미국 방산·드론·희토류 관련 기업에 대한
                     추가 제재에 나섰다."
              OK    S="중국 정부", P="추가 제재에 나섰다",
                    O="미국 방산·드론·희토류 관련 기업"
              NOT   S="중국",       P="제재",                   O="추가 제재"

          One example to anchor the rule:
            source: "SpaceX는 750억달러를 조달했다."
              OK    "predicate":"조달했다", "object_value":"750억달러"
              NOT   "predicate":"raised_funding"           # English on Korean
              NOT   "object_value":"75 billion USD"        # translation

  Step 2c. RULE — fact 유형 분류 (Action / Claim / Measurement — v0.2.0 step 2):

          각 fact 가 다음 셋 중 어디에 속하는지 분류하세요. fact_type 필드.

            - action: 사건/행위 — "X가 Y를 했다", "X가 발표했다"
            - claim:  발화/주장/관측 — "X가 ~라고 말했다",
                                       "X가 ~할 것이라 전망했다"

              'claim' 의 본질 = "누가 무엇을 말했나" (one-hop provenance).
              Lucid 는 화자의 말 자체를 fact 로 인정하되, 그 내용 진실은
              보증하지 않음.

              fact_type='claim' 이면 추가 필드:
                - speaker:       발화 주체 (한국어 surface)
                - speech_act:    발화 행위 (원문 동사 그대로 — 강제 enum 없음)
                - content_claim: 발화 내용 (한국어 문장)
                - stance:        supportive | critical | neutral | mixed | unknown

            - measurement: 시점에 매인 수치값 —
                "X 의 metric 은 시점에 value unit 이다/이었다"

              핵심: as_of(시점). 같은 metric 의 여러 시점 → 시계열.
              조건: numeric value + unit + (가능시) as_of 시점 명시.

              예: "ChatGPT 의 MAU 는 2026년 3월 8억 명이다"
                  → fact_type='measurement', metric='MAU',
                    measurement_value=800000000, measurement_unit='명',
                    as_of='2026-03'
              예: "삼성전자가 2026년 1분기에 매출 70조 원을 기록했다"
                  → fact_type='measurement', metric='매출',
                    measurement_value=70, measurement_unit='조 원',
                    as_of='2026-Q1'
              예: "2026년 6월 미국 실업률은 3.4%였다"
                  → fact_type='measurement', metric='실업률',
                    measurement_value=3.4, measurement_unit='%',
                    as_of='2026-06'

              fact_type='measurement' 이면 추가 필드:
                - metric:            측정 대상 (한국어 자연어 — "MAU",
                                     "매출", "실업률", "사용자 수")
                - measurement_value: 숫자 (float; 단위는 따로)
                - measurement_unit:  단위 (자연어 — "명", "조 원", "%",
                                     "달러")
                - as_of:             시점 (ISO 권장 — "2026", "2026-03",
                                     "2026-Q1", "2026-03-23")
                - entity (subject_uid 활용): 측정 대상 엔티티

              metric / measurement_unit / as_of 는 강제 enum 없음 —
              원문 표기 그대로 자연어 OK.

          분류 가이드:
            - 동사 '발표했다', '추가했다', '올렸다', '발사했다' = action
            - 동사 '밝혔다', '주장했다', '말했다', '전망했다',
                  '예측했다', '논평했다' = claim
            - "X가 [Y는 ...]고 말했다" = claim (content 분명)
            - 동사 '이다/있다/기록했다/달성했다' + 숫자 + 단위 = measurement
            - 시점 (분기/년/월/일) 명시 + 측정값 = measurement 핵심
            - "10곳을 올렸다" 같은 행위 + 숫자 = action (object 안 수량)
            - "발표했다" + 수치 (publisher action) = action
              (발표 행위 자체가 핵심, 수치는 발표 내용)
            - 수치이지만 시점 없음 + entity 의 상태 = measurement 약함
              (action 으로 fallback OK)
            - 한 문장에서 둘 이상 나오면 별도 fact 두 개 이상

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
      "aliases": [],
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
      "tags_suggested": ["behavioral_economics", "1979"],
      "fact_type": "action"
    }
  ],
  // v0.2.0 step 1 — when fact_type == "claim", emit these extra fields
  // on the fact object (omitted entirely for action facts):
  //   "fact_type": "claim",
  //   "speaker_uid": "obj-1",
  //   "speaker_label": "안도걸 의원",
  //   "speech_act": "밝혔다",
  //   "content_claim": "디지털자산기본법 제정에 속도를 낼 것",
  //   "stance": "neutral"   // supportive | critical | neutral | mixed | unknown
  // speech_act is open natural-language — DO NOT force into an enum.
  //
  // v0.2.0 step 2 — when fact_type == "measurement", emit these extra
  // fields (omit them entirely for action / claim facts):
  //   "fact_type": "measurement",
  //   "metric": "MAU",
  //   "measurement_value": 800000000,
  //   "measurement_unit": "명",
  //   "as_of": "2026-03"
  // metric / measurement_unit / as_of are open natural-language strings —
  // DO NOT force into enums. as_of accepts year / year-month / quarter /
  // date granularity ("2026" / "2026-03" / "2026-Q1" / "2026-03-23").
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
                 "subject_uid": "obj-2", "predicate": "평균이다",
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
                 "subject_uid": "obj-1", "predicate": "적용되지 않는다",
                 "object_value": "군사 분야",
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
    {'input': '한국은행 기준금리는 2024년 12월 기준 3.0%였다.', 'output': {'objects': [{'uid': 'obj-1', 'class': 'organization', 'name': '한국은행', 'name_en': 'Bank of Korea', 'properties': {}}, {'uid': 'obj-2', 'class': 'metric', 'name': '기준금리', 'name_en': 'base interest rate', 'properties': {'value': 3.0, 'unit': 'percent', 'as_of': '2024-12'}}], 'facts': [{'uid': 'fn-1', 'type': 'proposition', 'claim': '한국은행 기준금리는 2024년 12월 기준 3.0%였다.', 'subject_uid': 'obj-1', 'predicate': '기준금리였다', 'object_value': '3.0%', 'negation_flag': False, 'negation_scope': None, 'tags_suggested': ['KR', '2024-12']}], 'fact_object_links': [{'fact_uid': 'fn-1', 'object_uid': 'obj-1', 'link_type': 'involves', 'properties': {}}, {'fact_uid': 'fn-1', 'object_uid': 'obj-2', 'link_type': 'asserts_property', 'properties': {}}], 'fact_fact_links': [], 'disambiguation_candidates': [], 'extraction_status': 'success', 'failure_reason': None}},
    {'input': '삼성전자는 2023년 4분기에 23조 원의 영업이익을 기록했다. 반도체 부문이 흑자로 전환했고, 디스플레이는 흑자가 축소되었다.', 'output': {'objects': [{'uid': 'obj-1', 'class': 'organization', 'name': '삼성전자', 'name_en': 'Samsung Electronics', 'properties': {}}, {'uid': 'obj-2', 'class': 'metric', 'name': '영업이익', 'name_en': 'operating profit', 'properties': {'value': 23, 'unit': '조원', 'period': '2023Q4'}}, {'uid': 'obj-3', 'class': 'knowledge', 'name': '반도체 부문', 'name_en': 'semiconductor segment', 'properties': {}}, {'uid': 'obj-4', 'class': 'knowledge', 'name': '디스플레이 부문', 'name_en': 'display segment', 'properties': {}}], 'facts': [{'uid': 'fn-1', 'type': 'proposition', 'claim': '삼성전자는 2023년 4분기에 23조 원의 영업이익을 기록했다.', 'subject_uid': 'obj-1', 'predicate': '기록했다', 'object_value': '23조원', 'negation_flag': False, 'negation_scope': None, 'tags_suggested': ['KR', '2023Q4']}, {'uid': 'fn-2', 'type': 'proposition', 'claim': '반도체 부문이 흑자로 전환했다.', 'subject_uid': 'obj-3', 'predicate': '전환했다', 'object_value': '흑자', 'negation_flag': False, 'negation_scope': None, 'tags_suggested': ['KR']}, {'uid': 'fn-3', 'type': 'proposition', 'claim': '디스플레이는 흑자가 축소되었다.', 'subject_uid': 'obj-4', 'predicate': '축소되었다', 'object_value': '흑자', 'negation_flag': False, 'negation_scope': None, 'tags_suggested': ['KR']}], 'fact_object_links': [{'fact_uid': 'fn-1', 'object_uid': 'obj-1', 'link_type': 'involves', 'properties': {}}, {'fact_uid': 'fn-1', 'object_uid': 'obj-2', 'link_type': 'asserts_property', 'properties': {}}, {'fact_uid': 'fn-2', 'object_uid': 'obj-3', 'link_type': 'describes_state', 'properties': {}}, {'fact_uid': 'fn-3', 'object_uid': 'obj-4', 'link_type': 'describes_state', 'properties': {}}], 'fact_fact_links': [{'from_uid': 'fn-2', 'to_uid': 'fn-1', 'link_type': 'supports'}, {'from_uid': 'fn-3', 'to_uid': 'fn-1', 'link_type': 'supports'}], 'disambiguation_candidates': [], 'extraction_status': 'success', 'failure_reason': None}},
    {'input': '삼성은 1938년에 설립된 한국의 대기업 그룹이다.', 'output': {'objects': [{'uid': 'obj-1', 'class': 'organization', 'name': '삼성', 'name_en': 'Samsung', 'properties': {'founded_year': 1938, 'country': 'Korea', 'type': 'conglomerate'}}], 'facts': [{'uid': 'fn-1', 'type': 'proposition', 'claim': '삼성은 1938년에 설립된 한국의 대기업 그룹이다.', 'subject_uid': 'obj-1', 'predicate': '설립되었다', 'object_value': '1938년', 'negation_flag': False, 'negation_scope': None, 'tags_suggested': ['KR', '1938', 'conglomerate']}], 'fact_object_links': [{'fact_uid': 'fn-1', 'object_uid': 'obj-1', 'link_type': 'involves', 'properties': {}}], 'fact_fact_links': [], 'disambiguation_candidates': [{'fact_uid': 'fn-1', 'mention_text': '삼성', 'candidate_object_uids': [], 'scores': []}], 'extraction_status': 'success', 'failure_reason': None}},
    # v0.2.0 step 1 (fact-claim-layer-v1): Action vs Claim few-shots.
    # The classifier should learn (a) action default; (b) claim
    # with speaker_label + speech_act + content_claim + stance; (c)
    # critical stance from "부인했다" semantics. speech_act is open
    # natural-language — DO NOT force an enum.
    {
        'input': '중국 상무부가 미국 기업 10곳을 수출통제 대상에 올렸다.',
        'output': {
            'objects': [
                {'uid': 'obj-1', 'class': 'organization', 'name': '중국 상무부', 'name_en': 'Ministry of Commerce of China', 'properties': {}},
                {'uid': 'obj-2', 'class': 'organization', 'name': '미국 기업 10곳', 'name_en': '10 US companies', 'properties': {}},
            ],
            'facts': [
                {'uid': 'fn-1', 'type': 'proposition',
                 'claim': '중국 상무부가 미국 기업 10곳을 수출통제 대상에 올렸다.',
                 'subject_uid': 'obj-1', 'predicate': '수출통제 대상에 올렸다',
                 'object_value': 'obj-2', 'negation_flag': False, 'negation_scope': None,
                 'tags_suggested': ['KR'], 'fact_type': 'action'},
            ],
            'fact_object_links': [
                {'fact_uid': 'fn-1', 'object_uid': 'obj-1', 'link_type': 'involves', 'properties': {}},
                {'fact_uid': 'fn-1', 'object_uid': 'obj-2', 'link_type': 'addresses', 'properties': {}},
            ],
            'fact_fact_links': [], 'disambiguation_candidates': [],
            'extraction_status': 'success', 'failure_reason': None,
        },
    },
    {
        'input': '안도걸 의원은 디지털자산기본법 제정에 속도를 낼 것이라고 밝혔다.',
        'output': {
            'objects': [
                {'uid': 'obj-1', 'class': 'person', 'name': '안도걸 의원', 'name_en': 'Rep. Ahn Do-geol', 'properties': {}},
                {'uid': 'obj-2', 'class': 'knowledge', 'name': '디지털자산기본법', 'name_en': 'Digital Asset Framework Act', 'properties': {}},
            ],
            'facts': [
                {'uid': 'fn-1', 'type': 'proposition',
                 'claim': '안도걸 의원은 디지털자산기본법 제정에 속도를 낼 것이라고 밝혔다.',
                 'subject_uid': 'obj-1', 'predicate': '밝혔다',
                 'object_value': '디지털자산기본법 제정에 속도를 낼 것',
                 'negation_flag': False, 'negation_scope': None,
                 'tags_suggested': ['KR'],
                 'fact_type': 'claim',
                 'speaker_uid': 'obj-1', 'speaker_label': '안도걸 의원',
                 'speech_act': '밝혔다',
                 'content_claim': '디지털자산기본법 제정에 속도를 낼 것',
                 'stance': 'neutral'},
            ],
            'fact_object_links': [
                {'fact_uid': 'fn-1', 'object_uid': 'obj-1', 'link_type': 'involves', 'properties': {}},
                {'fact_uid': 'fn-1', 'object_uid': 'obj-2', 'link_type': 'addresses', 'properties': {}},
            ],
            'fact_fact_links': [], 'disambiguation_candidates': [],
            'extraction_status': 'success', 'failure_reason': None,
        },
    },
    {
        'input': '트럼프 대통령은 관세 인하 가능성을 부인했다.',
        'output': {
            'objects': [
                {'uid': 'obj-1', 'class': 'person', 'name': '트럼프 대통령', 'name_en': 'President Trump', 'properties': {}},
                {'uid': 'obj-2', 'class': 'knowledge', 'name': '관세 인하 가능성', 'name_en': 'tariff reduction possibility', 'properties': {}},
            ],
            'facts': [
                {'uid': 'fn-1', 'type': 'proposition',
                 'claim': '트럼프 대통령은 관세 인하 가능성을 부인했다.',
                 'subject_uid': 'obj-1', 'predicate': '부인했다',
                 'object_value': '관세 인하 가능성',
                 'negation_flag': False, 'negation_scope': None,
                 'tags_suggested': ['KR'],
                 'fact_type': 'claim',
                 'speaker_uid': 'obj-1', 'speaker_label': '트럼프 대통령',
                 'speech_act': '부인했다',
                 'content_claim': '관세 인하 가능성',
                 'stance': 'critical'},
            ],
            'fact_object_links': [
                {'fact_uid': 'fn-1', 'object_uid': 'obj-1', 'link_type': 'involves', 'properties': {}},
                {'fact_uid': 'fn-1', 'object_uid': 'obj-2', 'link_type': 'addresses', 'properties': {}},
            ],
            'fact_fact_links': [], 'disambiguation_candidates': [],
            'extraction_status': 'success', 'failure_reason': None,
        },
    },
    # v0.2.0 step 2 (fact-measurement-layer-v1): measurement few-shots.
    # The classifier should learn (a) numeric value + unit + as_of timepoint =
    # fact_type='measurement'; (b) metric / measurement_unit / as_of are open
    # Korean strings — no enum at extraction time. The measurement object is
    # ALSO recorded in the objects array (class='metric') so it can be linked
    # via asserts_property — same pattern as the existing
    # behavioral-economics + samsung few-shots above.
    {
        'input': 'ChatGPT 의 MAU 는 2026년 3월 기준 8억 명이다.',
        'output': {
            'objects': [
                {'uid': 'obj-1', 'class': 'service', 'name': 'ChatGPT', 'name_en': 'ChatGPT', 'properties': {}},
                {'uid': 'obj-2', 'class': 'metric', 'name': 'MAU', 'name_en': 'monthly active users', 'properties': {}},
            ],
            'facts': [
                {'uid': 'fn-1', 'type': 'proposition',
                 'claim': 'ChatGPT 의 MAU 는 2026년 3월 기준 8억 명이다.',
                 'subject_uid': 'obj-1', 'predicate': 'MAU 이다',
                 'object_value': '8억 명',
                 'negation_flag': False, 'negation_scope': None,
                 'tags_suggested': ['KR', '2026-03', 'MAU'],
                 'fact_type': 'measurement',
                 'metric': 'MAU',
                 'measurement_value': 800000000,
                 'measurement_unit': '명',
                 'as_of': '2026-03'},
            ],
            'fact_object_links': [
                {'fact_uid': 'fn-1', 'object_uid': 'obj-1', 'link_type': 'involves', 'properties': {}},
                {'fact_uid': 'fn-1', 'object_uid': 'obj-2', 'link_type': 'asserts_property', 'properties': {}},
            ],
            'fact_fact_links': [], 'disambiguation_candidates': [],
            'extraction_status': 'success', 'failure_reason': None,
        },
    },
    {
        'input': '2026년 6월 미국 실업률은 3.4%였다.',
        'output': {
            'objects': [
                {'uid': 'obj-1', 'class': 'place', 'name': '미국', 'name_en': 'United States', 'properties': {}},
                {'uid': 'obj-2', 'class': 'metric', 'name': '실업률', 'name_en': 'unemployment rate', 'properties': {}},
            ],
            'facts': [
                {'uid': 'fn-1', 'type': 'proposition',
                 'claim': '2026년 6월 미국 실업률은 3.4%였다.',
                 'subject_uid': 'obj-1', 'predicate': '실업률이었다',
                 'object_value': '3.4%',
                 'negation_flag': False, 'negation_scope': None,
                 'tags_suggested': ['KR', '2026-06', '실업률'],
                 'fact_type': 'measurement',
                 'metric': '실업률',
                 'measurement_value': 3.4,
                 'measurement_unit': '%',
                 'as_of': '2026-06'},
            ],
            'fact_object_links': [
                {'fact_uid': 'fn-1', 'object_uid': 'obj-1', 'link_type': 'involves', 'properties': {}},
                {'fact_uid': 'fn-1', 'object_uid': 'obj-2', 'link_type': 'asserts_property', 'properties': {}},
            ],
            'fact_fact_links': [], 'disambiguation_candidates': [],
            'extraction_status': 'success', 'failure_reason': None,
        },
    },
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
        "NO prose outside the JSON.\n"
        "\n"
        "## 출력 형식 (STRICT)\n"
        "  - JSON 객체 하나만 출력. 마크다운 fence ```json ... ``` 금지.\n"
        "  - 설명 / 주석 / 인사말 / \"Here's the JSON:\" 등 부가 텍스트 절대 금지.\n"
        "  - 답변 전체 = { ... } 만."
    )
