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
# prompt v0.2.0-classification-recovery (force fact_type emission)

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
                - related_entity_uids: ★ content_claim 안에 등장한
                                 entity 들의 obj-N placeholder 배열.
                                 (m32a-stage3, PO 2026-06-28 결정 6)

              ★ CLAIM 의 related_entity_uids (의뢰서 verbatim):
                내용 속 entity 들 = claim 노드에서 dotted related-to.
                예: "모스 탄이 aweb 이 6·3선거와 관련있다고 주장했다."
                    → speaker_uid=obj-1 (모스 탄)
                      content_claim="aweb 이 6·3선거와 관련있다"
                      related_entity_uids=[obj-2 (aweb), obj-3 (6·3선거)]

                ★ 별도 fact 만들지 마세요. 같은 claim fact 안 array.
                ★ provenance 게이트: 이 link 들은 검증된 사실이 아니라
                  주장된 연결입니다. AI/시스템이 그 entity 들 간 직접
                  실선 엣지를 만들지 않음 = 점선 related-to.
                ★ 값은 obj-N placeholder (objects 배열에 있는 entity).
                  실제 canonical UID 변환은 downstream 이 처리.
                ★ speaker 본인 (obj-1 같은) 은 related_entity_uids 에
                  넣지 마세요 — speaker_uid 에 이미 있음.
                ★ content_claim 에 entity 가 0 명이면 빈 배열 또는
                  필드 생략.

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

          RULE — 측정(measurement) 완전성 (v0.2.0 step 2.5):

          metric 은 한정어를 **통째로** 포함하세요. 빈약한 토막 금지.

            좋은 예: metric="노사 양측의 최초 요구안 차이 (시급 기준)"
                    metric="ChatGPT 의 월간 활성 사용자 (MAU)"
                    metric="OpenAI 의 분기 매출 (Q1 기준)"
            나쁜 예: metric="차이" (주체·기준 누락)
                    metric="MAU" (주체 누락 — 어떤 서비스의?)
                    metric="매출" (주체·기간 누락)

          주체(누구의) + 대상(무엇의) + 기준(시급/MAU/Q1/WHO 등)을
          metric 에 포함하세요. predicate/object 가 한정어를
          떨어뜨리지 않게 — spo-decomp-completeness 와 같은 원칙.

          RULE — as_of 의미 통일 (v0.2.0 step 2.5):

          as_of 는 **"그 값이 측정/유효한 시점"** 입니다.
          적용 시점, 시행 시점, 발효 시점은 as_of 가 **아닙니다**.

            좋은 예 (측정 시점):
              "ChatGPT MAU 8억" + "2026년 3월 기준" → as_of="2026-03"
              "GDP 성장률 3%" + "2025년 4분기" → as_of="2025-Q4"
              "2026년 6월 미국 실업률 3.4%" → as_of="2026-06"
            모호 (적용/시행/발효 시점):
              "2027년 적용 최저임금 시급 1만 320원" → as_of=null
                (적용 시점이지 측정 시점이 아님)
              "2026년 7월 발효되는 ..." → as_of=null

          측정 시점이 모호하거나 적용/시행/발효 시점이면 as_of=null
          로 두고, 원문은 claim 에 그대로 보존하세요. claim 은 항상
          faithful — 적용 시점 정보가 거기에 남아 있습니다.

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

  Step 2d. RULE — ACTION 의 object_value 는 entity uid 강제
          (v0.2.1 step 2d, action-entity-edge-class, PO 2026-06-29):

          ★ 원칙 (STELLAR v2 원칙 1):
            "모든 ACTION fact = 두 entity 사이의 엣지" — ACTION 의
            의미는 어떤 entity 가 어떤 entity 에게 무엇을 했다 이다.
            그러므로 ACTION 의 subject 와 object 는 **둘 다 entity** 여야
            한다. object 가 자연어 명사구 (literal) 라면 ACTION 이 아니다.

          출력 규칙:
            - fact_type='action' 의 subject_uid : entity 의 obj-N (필수).
            - fact_type='action' 의 object_value :
                * 우선 obj-N placeholder (objects 배열의 entity 가리키).
                * literal 자연어 명사구 ("기준금리", "흑자", "1938년")
                  은 entity 가 아니므로 ACTION object 에 두지 않는다.
                  두 갈래 중 하나:
                    (i) 진짜로 두 entity 사이의 행위면 → object 명사구
                        에 해당하는 entity 를 objects 배열에 만들고
                        object_value = "obj-N" 으로 가리킨다.
                    (ii) 두 entity 행위가 아니라 entity 의 상태/속성/
                         수치이면 → fact_type 을 measurement 또는
                         claim 으로 분류, action 아님.

          예 1 (★ entity 간 ACTION — object 는 obj-N):
            source: "강재호가 이로운몰 설립에 참여했다."
              objects:
                obj-1 person       "강재호"
                obj-2 organization "이로운몰"
              fact:
                fact_type="action"
                subject_uid="obj-1"
                predicate="설립에 참여했다"
                object_value="obj-2"        ★ obj-N — NOT "이로운몰"
                roles={"role": "설립_참여자"}   (선택 — 다항관계 채널)

          예 2 (★ entity 간 ACTION 인데 object 가 명사구 형태로 등장):
            source: "한국은행이 기준금리를 동결했다."
              objects:
                obj-1 organization "한국은행"
                obj-2 metric       "기준금리"
              fact:
                fact_type="action"
                subject_uid="obj-1"
                predicate="동결했다"
                object_value="obj-2"        ★ "기준금리" 도 entity 로
                                              objects 배열에 만들고 obj-N

          예 3 (반례 — object 가 entity 아니면 ACTION 자체가 부적합):
            source: "ChatGPT 의 MAU 는 2026년 3월 8억 명이다."
              → fact_type="measurement"  (NOT action — 수치 + 시점)
              object_value="8억 명" 은 literal 이지만 그래서 ACTION 이 아님

            source: "트럼프 대통령은 관세 인하 가능성을 부인했다."
              → fact_type="claim"  (NOT action — 발화)
              speaker_uid=obj-1 (트럼프), content_claim="관세 인하 가능성"
              object_value 는 발화 내용 literal — claim 이라 OK.

          체크리스트:
            ACTION 이면서 object_value 가 literal 자연어 → 자기검열.
            "이 object 는 entity 인가? 아니면 수치/시점/추상명사인가?"
              entity 다       → objects 배열에 추가 + object_value=obj-N
              수치/시점이다   → fact_type=measurement, 위 필드 강제
              발화 내용이다   → fact_type=claim, speaker/content 강제
              그 외 명사구다  → ACTION 으로 두되 object_value=obj-N
                              (그 명사구도 entity 로 objects 배열에
                              올림 — class=concept / event / knowledge 등)

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
  Step 5a. MULTI-PARTICIPANT ROLE CHANNEL (m32a-stage2, PO 2026-06-28):

          When a claim has participants beyond (subject, object) — a
          recipient, instrument, location, or other auxiliary actor —
          emit a `roles` map on the fact so the auxiliary participant
          is preserved on the graph edge.

          예 1: "모스 탄이 6·3선거를 트럼프에게 알렸다"
                → fact_type=action, S=모스 탄, P=알렸다,
                  O=6·3선거, roles={"recipient": "obj-K"}
                  (obj-K = 트럼프 의 LLM uid)
          예 2: "정부가 칼슘 보조제로 골다공증을 치료한다"
                → S=정부, P=치료한다, O=골다공증,
                  roles={"instrument": "obj-K"}  (obj-K = 칼슘 보조제)
          예 3: "회담은 제네바에서 열렸다"
                → S=회담, P=열렸다, O=null|literal,
                  roles={"location": "obj-K"}    (obj-K = 제네바)

          시작 role 집합 = recipient / instrument / location 3종.
          ★ 그러나 이것은 강제 enum 이 아닙니다. 의미상 새 role 이
          필요하면 (예: "witness", "topic", "co-actor") 그대로
          emit 하세요. 다운스트림 인덱스가 dynamic mapping 으로
          새 role 키를 자동 수용합니다.

          role 의 value 는 obj-N placeholder (그 entity 가
          objects 배열에 있을 때) 또는 literal Korean surface
          ("트럼프", "제네바") 모두 OK. placeholder 가 권장 —
          canonical entity 와 fusion 됩니다.

          `roles` 가 비어 있으면 (단순 SPO) 필드 자체를 생략 OK.
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

## MANDATORY FIELDS PER FACT (★ v0.2.0):

각 fact 객체는 다음 필드를 **반드시** 포함:

  - "fact_type": "action" | "claim" | "measurement"  ← REQUIRED, 누락 금지

If fact_type == "claim", these ADDITIONAL fields are MANDATORY:
  - "speaker_label": <발화 주체, 한국어 surface>
  - "speech_act":    <발화 동사 그대로, e.g. "밝혔다", "주장했다">
  - "content_claim": <발화 내용 문장>
  - "stance":        "supportive" | "critical" | "neutral" | "mixed" | "unknown"
  - "related_entity_uids": [<obj-N>, ...]  ← content_claim 안 entity 의
                              obj-N placeholder 배열 (m32a-stage3,
                              ★ 같은 fact 안 array, 별도 doc 아님).
                              비어 있으면 [] 또는 생략.

If fact_type == "measurement", these ADDITIONAL fields are MANDATORY:
  - "metric":            <측정 대상, 한정어 포함>
  - "measurement_value": <number>
  - "measurement_unit":  <단위 문자열>
  - "as_of":             <시점 ISO 또는 null>

DO NOT OMIT fact_type. If you cannot decide between claim and measurement,
default to "action". Omitting fact_type is a parse failure.

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
      "fact_type": "action",
      "roles": {}
    }
  ],
  // m32a-stage2-role-channel (PO 2026-06-28 decision 4): when a fact
  // has multi-participant structure beyond (subject, object), emit
  // `roles` as a map of role_name -> obj-N (or literal surface).
  // Seed roles = recipient / instrument / location, but new role
  // keys (witness / topic / co-actor / ...) are accepted as-is —
  // NOT a strict enum. Omit or use {} for plain SPO facts.
  // 예: "모스 탄이 6·3선거를 트럼프에게 알렸다"
  //    → "roles": {"recipient": "obj-3"}   // obj-3 = 트럼프
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
  // m32a-stage3-claim-related-entities (PO 2026-06-28 결정 6) —
  // CLAIM 의 내용 속 entity 들. ★ 같은 fact 안 array, 별도 doc 아님.
  //   "related_entity_uids": ["obj-2", "obj-3"]
  // ★ provenance 게이트: 점선 related-to 의 데이터 표현. AI/시스템이
  // 미검증 entity 관계를 실선으로 만들지 않는다.
  // 예 verbatim: "모스 탄이 aweb 이 6·3선거와 관련있다고 주장했다."
  //   → speaker_uid=obj-1, related_entity_uids=[obj-2, obj-3]
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
                 "negation_scope": None, "tags_suggested": ["1979"],
                 "fact_type": "action"},
                {"uid": "fn-2", "type": "proposition",
                 "claim": "프로스펙트 이론에서 손실 회피 계수는 평균 2.25다.",
                 "subject_uid": "obj-2", "predicate": "평균이다",
                 "object_value": "2.25", "negation_flag": False,
                 "negation_scope": None, "tags_suggested": [],
                 "fact_type": "measurement",
                 "metric": "loss aversion coefficient",
                 "measurement_value": 2.25,
                 "measurement_unit": None,
                 "as_of": None},
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
                 "tags_suggested": ["EU", "military"],
                 "fact_type": "action"},
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
    {'input': '한국은행 기준금리는 2024년 12월 기준 3.0%였다.', 'output': {'objects': [{'uid': 'obj-1', 'class': 'organization', 'name': '한국은행', 'name_en': 'Bank of Korea', 'properties': {}}, {'uid': 'obj-2', 'class': 'metric', 'name': '기준금리', 'name_en': 'base interest rate', 'properties': {'value': 3.0, 'unit': 'percent', 'as_of': '2024-12'}}], 'facts': [{'uid': 'fn-1', 'type': 'proposition', 'claim': '한국은행 기준금리는 2024년 12월 기준 3.0%였다.', 'subject_uid': 'obj-1', 'predicate': '기준금리였다', 'object_value': '3.0%', 'negation_flag': False, 'negation_scope': None, 'tags_suggested': ['KR', '2024-12'], 'fact_type': 'measurement', 'metric': '한국은행 기준금리', 'measurement_value': 3.0, 'measurement_unit': '%', 'as_of': '2024-12'}], 'fact_object_links': [{'fact_uid': 'fn-1', 'object_uid': 'obj-1', 'link_type': 'involves', 'properties': {}}, {'fact_uid': 'fn-1', 'object_uid': 'obj-2', 'link_type': 'asserts_property', 'properties': {}}], 'fact_fact_links': [], 'disambiguation_candidates': [], 'extraction_status': 'success', 'failure_reason': None}},
    {'input': '삼성전자는 2023년 4분기에 23조 원의 영업이익을 기록했다. 반도체 부문이 흑자로 전환했고, 디스플레이는 흑자가 축소되었다.', 'output': {'objects': [{'uid': 'obj-1', 'class': 'organization', 'name': '삼성전자', 'name_en': 'Samsung Electronics', 'properties': {}}, {'uid': 'obj-2', 'class': 'metric', 'name': '영업이익', 'name_en': 'operating profit', 'properties': {'value': 23, 'unit': '조원', 'period': '2023Q4'}}, {'uid': 'obj-3', 'class': 'knowledge', 'name': '반도체 부문', 'name_en': 'semiconductor segment', 'properties': {}}, {'uid': 'obj-4', 'class': 'knowledge', 'name': '디스플레이 부문', 'name_en': 'display segment', 'properties': {}}], 'facts': [{'uid': 'fn-1', 'type': 'proposition', 'claim': '삼성전자는 2023년 4분기에 23조 원의 영업이익을 기록했다.', 'subject_uid': 'obj-1', 'predicate': '기록했다', 'object_value': '23조원', 'negation_flag': False, 'negation_scope': None, 'tags_suggested': ['KR', '2023Q4'], 'fact_type': 'measurement', 'metric': '삼성전자 영업이익', 'measurement_value': 23, 'measurement_unit': '조원', 'as_of': '2023-Q4'}, {'uid': 'fn-2', 'type': 'proposition', 'claim': '반도체 부문이 흑자로 전환했다.', 'subject_uid': 'obj-3', 'predicate': '전환했다', 'object_value': '흑자', 'negation_flag': False, 'negation_scope': None, 'tags_suggested': ['KR'], 'fact_type': 'action'}, {'uid': 'fn-3', 'type': 'proposition', 'claim': '디스플레이는 흑자가 축소되었다.', 'subject_uid': 'obj-4', 'predicate': '축소되었다', 'object_value': '흑자', 'negation_flag': False, 'negation_scope': None, 'tags_suggested': ['KR'], 'fact_type': 'action'}], 'fact_object_links': [{'fact_uid': 'fn-1', 'object_uid': 'obj-1', 'link_type': 'involves', 'properties': {}}, {'fact_uid': 'fn-1', 'object_uid': 'obj-2', 'link_type': 'asserts_property', 'properties': {}}, {'fact_uid': 'fn-2', 'object_uid': 'obj-3', 'link_type': 'describes_state', 'properties': {}}, {'fact_uid': 'fn-3', 'object_uid': 'obj-4', 'link_type': 'describes_state', 'properties': {}}], 'fact_fact_links': [{'from_uid': 'fn-2', 'to_uid': 'fn-1', 'link_type': 'supports'}, {'from_uid': 'fn-3', 'to_uid': 'fn-1', 'link_type': 'supports'}], 'disambiguation_candidates': [], 'extraction_status': 'success', 'failure_reason': None}},
    {'input': '삼성은 1938년에 설립된 한국의 대기업 그룹이다.', 'output': {'objects': [{'uid': 'obj-1', 'class': 'organization', 'name': '삼성', 'name_en': 'Samsung', 'properties': {'founded_year': 1938, 'country': 'Korea', 'type': 'conglomerate'}}], 'facts': [{'uid': 'fn-1', 'type': 'proposition', 'claim': '삼성은 1938년에 설립된 한국의 대기업 그룹이다.', 'subject_uid': 'obj-1', 'predicate': '설립되었다', 'object_value': '1938년', 'negation_flag': False, 'negation_scope': None, 'tags_suggested': ['KR', '1938', 'conglomerate'], 'fact_type': 'action'}], 'fact_object_links': [{'fact_uid': 'fn-1', 'object_uid': 'obj-1', 'link_type': 'involves', 'properties': {}}], 'fact_fact_links': [], 'disambiguation_candidates': [{'fact_uid': 'fn-1', 'mention_text': '삼성', 'candidate_object_uids': [], 'scores': []}], 'extraction_status': 'success', 'failure_reason': None}},
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
    # v0.2.0 step 2.5 (measurement-completeness): rich-metric few-shot.
    # The "노사 양측의 최초 요구안 차이" case — the LLM tends to compress
    # metric to "차이" and lose the 주체("노사 양측의") + 기준("시급 기준")
    # qualifiers. This anchor teaches it to KEEP THEM all in the metric
    # string. Also: 적용 시점 (시행/발효/적용/예정) MUST NOT populate as_of —
    # this fact's surface "..." has no measurement timepoint, only an
    # application timepoint that the prompt explicitly rejects.
    {
        'input': '노사 양측의 최초 요구안 차이는 시급 기준 1680원이다.',
        'output': {
            'objects': [
                {'uid': 'obj-1', 'class': 'concept', 'name': '노사 양측', 'name_en': 'labor and management', 'properties': {}},
                {'uid': 'obj-2', 'class': 'metric', 'name': '노사 양측의 최초 요구안 차이 (시급 기준)', 'name_en': 'initial proposal gap between labor and management (hourly basis)', 'properties': {}},
            ],
            'facts': [
                {'uid': 'fn-1', 'type': 'proposition',
                 'claim': '노사 양측의 최초 요구안 차이는 시급 기준 1680원이다.',
                 'subject_uid': 'obj-1', 'predicate': '시급 기준 차이이다',
                 'object_value': '1680원',
                 'negation_flag': False, 'negation_scope': None,
                 'tags_suggested': ['KR', '시급', '최저임금'],
                 'fact_type': 'measurement',
                 'metric': '노사 양측의 최초 요구안 차이 (시급 기준)',
                 'measurement_value': 1680,
                 'measurement_unit': '원',
                 'as_of': None},
            ],
            'fact_object_links': [
                {'fact_uid': 'fn-1', 'object_uid': 'obj-1', 'link_type': 'involves', 'properties': {}},
                {'fact_uid': 'fn-1', 'object_uid': 'obj-2', 'link_type': 'asserts_property', 'properties': {}},
            ],
            'fact_fact_links': [], 'disambiguation_candidates': [],
            'extraction_status': 'success', 'failure_reason': None,
        },
    },
    # v0.2.0 step 2.5 (measurement-completeness): as_of disambiguation
    # few-shot. The source carries an "적용" (application) timepoint, NOT
    # a measurement timepoint. The LLM tends to mis-populate as_of with
    # "2027" here because it sees a year + a number. The rule above
    # says: 적용/시행/발효 → as_of=null. The application-time information
    # remains in the claim text (faithful surface) so no information is
    # lost; only the as_of slot is correctly left empty.
    {
        'input': '2027년 적용 최저임금은 시급 기준 1만 320원이다.',
        'output': {
            'objects': [
                {'uid': 'obj-1', 'class': 'concept', 'name': '최저임금', 'name_en': 'minimum wage', 'properties': {}},
                {'uid': 'obj-2', 'class': 'metric', 'name': '2027년 적용 최저임금 (시급 기준)', 'name_en': '2027 minimum wage (hourly basis)', 'properties': {}},
            ],
            'facts': [
                {'uid': 'fn-1', 'type': 'proposition',
                 'claim': '2027년 적용 최저임금은 시급 기준 1만 320원이다.',
                 'subject_uid': 'obj-1', 'predicate': '시급 기준이다',
                 'object_value': '1만 320원',
                 'negation_flag': False, 'negation_scope': None,
                 'tags_suggested': ['KR', '최저임금', '2027'],
                 'fact_type': 'measurement',
                 'metric': '2027년 적용 최저임금 (시급 기준)',
                 'measurement_value': 10320,
                 'measurement_unit': '원',
                 'as_of': None},
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
    # m32a-stage3-claim-related-entities (PO 2026-06-28 결정 6):
    # CLAIM 의 내용 속 entity 배열. ★ 같은 fact 안 array, 별도 doc
    # 아님. ★ provenance 게이트 — content_claim 안 aweb / 6·3선거
    # 가 진짜 "관련있다"는 보장 X, 모스 탄이 "주장"한 것일 뿐.
    # related_entity_uids = 점선 related-to 의 데이터 표현. PO 의뢰서
    # acceptance case verbatim.
    {
        'input': '모스 탄이 aweb 이 6·3선거와 관련있다고 주장했다.',
        'output': {
            'objects': [
                {'uid': 'obj-1', 'class': 'person', 'name': '모스 탄', 'name_en': 'Morse Tan', 'properties': {}},
                {'uid': 'obj-2', 'class': 'organization', 'name': 'aweb', 'name_en': 'aweb', 'properties': {}},
                {'uid': 'obj-3', 'class': 'event', 'name': '6·3선거', 'name_en': 'June 3 election', 'properties': {}},
            ],
            'facts': [
                {'uid': 'fn-1', 'type': 'proposition',
                 'claim': '모스 탄이 aweb 이 6·3선거와 관련있다고 주장했다.',
                 'subject_uid': 'obj-1', 'predicate': '주장했다',
                 'object_value': 'aweb 이 6·3선거와 관련있다',
                 'negation_flag': False, 'negation_scope': None,
                 'tags_suggested': ['KR'],
                 'fact_type': 'claim',
                 'speaker_uid': 'obj-1', 'speaker_label': '모스 탄',
                 'speech_act': '주장했다',
                 'content_claim': 'aweb 이 6·3선거와 관련있다',
                 'stance': 'neutral',
                 'related_entity_uids': ['obj-2', 'obj-3']},
            ],
            'fact_object_links': [
                {'fact_uid': 'fn-1', 'object_uid': 'obj-1', 'link_type': 'involves', 'properties': {}},
                {'fact_uid': 'fn-1', 'object_uid': 'obj-2', 'link_type': 'addresses', 'properties': {}},
                {'fact_uid': 'fn-1', 'object_uid': 'obj-3', 'link_type': 'addresses', 'properties': {}},
            ],
            'fact_fact_links': [], 'disambiguation_candidates': [],
            'extraction_status': 'success', 'failure_reason': None,
        },
    },
    # m32a-stage2-role-channel (PO 2026-06-28 decision 4): multi-
    # participant fact with a recipient role. The PO's acceptance
    # case verbatim — "모스 탄이 6·3선거를 트럼프에게 알렸다".
    # The fact stays an ACTION (S=모스탄 P=알렸다 O=6·3선거); the
    # auxiliary participant 트럼프 is preserved on `roles.recipient`
    # as an obj-N placeholder so the uid_map resolves it to a
    # canonical Object UID downstream. Seed roles = recipient /
    # instrument / location, but the channel is intentionally NOT a
    # strict enum — new role keys pass through.
    {
        'input': '모스 탄이 6·3선거를 트럼프에게 알렸다.',
        'output': {
            'objects': [
                {'uid': 'obj-1', 'class': 'person', 'name': '모스 탄', 'name_en': 'Morse Tan', 'properties': {}},
                {'uid': 'obj-2', 'class': 'event', 'name': '6·3선거', 'name_en': 'June 3 election', 'properties': {}},
                {'uid': 'obj-3', 'class': 'person', 'name': '트럼프', 'name_en': 'Trump', 'properties': {}},
            ],
            'facts': [
                {'uid': 'fn-1', 'type': 'proposition',
                 'claim': '모스 탄이 6·3선거를 트럼프에게 알렸다.',
                 'subject_uid': 'obj-1', 'predicate': '알렸다',
                 'object_value': 'obj-2',
                 'negation_flag': False, 'negation_scope': None,
                 'tags_suggested': ['KR'],
                 'fact_type': 'action',
                 'roles': {'recipient': 'obj-3'}},
            ],
            'fact_object_links': [
                {'fact_uid': 'fn-1', 'object_uid': 'obj-1', 'link_type': 'involves', 'properties': {}},
                {'fact_uid': 'fn-1', 'object_uid': 'obj-2', 'link_type': 'addresses', 'properties': {}},
                {'fact_uid': 'fn-1', 'object_uid': 'obj-3', 'link_type': 'involves', 'properties': {'role': 'recipient'}},
            ],
            'fact_fact_links': [], 'disambiguation_candidates': [],
            'extraction_status': 'success', 'failure_reason': None,
        },
    },
    # feat/v2-action-entity-edge-class-fix (PO 2026-06-29):
    # ACTION 의 object_value = entity uid (obj-N) 강제. 의뢰서
    # acceptance 케이스 verbatim — "강재호가 이로운몰 설립에 참여"
    # 패턴. object 가 자연어 명사구처럼 보여도, 그것이 entity 이면
    # objects 배열에 올리고 object_value=obj-N 으로 가리켜야 한다.
    # ★ 하드코딩 금지 (원칙 단위) — 같은 패턴이 임의의 (person, org)
    # 쌍에 적용됨.
    {
        'input': '강재호가 이로운몰 설립에 참여했다.',
        'output': {
            'objects': [
                {'uid': 'obj-1', 'class': 'person', 'name': '강재호',
                 'name_en': 'Kang Jae-ho', 'properties': {}},
                {'uid': 'obj-2', 'class': 'organization', 'name': '이로운몰',
                 'name_en': 'Iroun Mall', 'properties': {}},
            ],
            'facts': [
                {'uid': 'fn-1', 'type': 'proposition',
                 'claim': '강재호가 이로운몰 설립에 참여했다.',
                 'subject_uid': 'obj-1', 'predicate': '설립에 참여했다',
                 'object_value': 'obj-2',
                 'negation_flag': False, 'negation_scope': None,
                 'tags_suggested': ['KR'],
                 'fact_type': 'action',
                 'roles': {'role': '설립_참여자'}},
            ],
            'fact_object_links': [
                {'fact_uid': 'fn-1', 'object_uid': 'obj-1',
                 'link_type': 'involves', 'properties': {}},
                {'fact_uid': 'fn-1', 'object_uid': 'obj-2',
                 'link_type': 'addresses', 'properties': {}},
            ],
            'fact_fact_links': [], 'disambiguation_candidates': [],
            'extraction_status': 'success', 'failure_reason': None,
        },
    },
    # action-entity-edge-class: object 가 명사구처럼 보이지만
    # metric/concept entity 면 그것도 obj-N. "기준금리" 는 metric
    # entity → objects 배열에 올리고 object_value=obj-N.
    {
        'input': '한국은행이 기준금리를 동결했다.',
        'output': {
            'objects': [
                {'uid': 'obj-1', 'class': 'organization', 'name': '한국은행',
                 'name_en': 'Bank of Korea', 'properties': {}},
                {'uid': 'obj-2', 'class': 'metric', 'name': '기준금리',
                 'name_en': 'base interest rate', 'properties': {}},
            ],
            'facts': [
                {'uid': 'fn-1', 'type': 'proposition',
                 'claim': '한국은행이 기준금리를 동결했다.',
                 'subject_uid': 'obj-1', 'predicate': '동결했다',
                 'object_value': 'obj-2',
                 'negation_flag': False, 'negation_scope': None,
                 'tags_suggested': ['KR'],
                 'fact_type': 'action'},
            ],
            'fact_object_links': [
                {'fact_uid': 'fn-1', 'object_uid': 'obj-1',
                 'link_type': 'involves', 'properties': {}},
                {'fact_uid': 'fn-1', 'object_uid': 'obj-2',
                 'link_type': 'addresses', 'properties': {}},
            ],
            'fact_fact_links': [], 'disambiguation_candidates': [],
            'extraction_status': 'success', 'failure_reason': None,
        },
    },
    # action-entity-edge-class: 영어 예제 — 같은 원칙이 언어
    # 중립적임을 LLM 에 학습시킴.
    {
        'input': 'Apple released Vision Pro in 2024.',
        'output': {
            'objects': [
                {'uid': 'obj-1', 'class': 'organization', 'name': 'Apple',
                 'name_en': 'Apple', 'properties': {}},
                {'uid': 'obj-2', 'class': 'product', 'name': 'Vision Pro',
                 'name_en': 'Vision Pro', 'properties': {}},
            ],
            'facts': [
                {'uid': 'fn-1', 'type': 'proposition',
                 'claim': 'Apple released Vision Pro in 2024.',
                 'subject_uid': 'obj-1', 'predicate': 'released',
                 'object_value': 'obj-2',
                 'negation_flag': False, 'negation_scope': None,
                 'tags_suggested': ['2024'],
                 'fact_type': 'action'},
            ],
            'fact_object_links': [
                {'fact_uid': 'fn-1', 'object_uid': 'obj-1',
                 'link_type': 'involves', 'properties': {}},
                {'fact_uid': 'fn-1', 'object_uid': 'obj-2',
                 'link_type': 'addresses', 'properties': {}},
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
