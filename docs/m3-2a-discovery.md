# M3-2a Discovery Report — fact_type-aware graph roles

**Brief**: PO 의뢰서 M3-2a verbatim — discovery only (코드 변경 0).
**Date**: 2026-06-28
**Branch**: `feat/m3-2a-discovery-report`
**Base**: `main` @ `50629ce`
**KS probed**: `4a3a8bb7-5f3f-4a44-bc2d-f8e296966b5b`

이 PR 은 PO 의 새 게이트 (2026-06-28) 대로 **discovery 만** 진행하고 PO 승인을 기다립니다. Implement 는 별도 PR.

---

## A. 현재 entity-link 생성 방식 (★ 의뢰서 핵심)

### A.1 결론 — fact_type **무시**, 일괄 처리

전체 entity-link path 가 **fact_type 을 한 번도 분기하지 않습니다**. ACTION / CLAIM / MEASUREMENT 모두 동일한 4단계를 거칩니다:

1. **LLM raw extract** (`claude_client.py:319-326`)
   prompt 가 모든 fact 에 동일한 `subject_uid` + `predicate` + `object_value` shape 을 강제. CLAIM 의 `speaker_uid` / MEASUREMENT 의 `metric` 등 추가 필드는 fact 안에 평탄하게 박혀 있을 뿐, 별도 분기 처리 없음.

2. **Object matching** (`processor.py:916-930`)
   `decomp.objects` 전체를 fact_type 모름 상태로 한 번에 `_match_object` loop. fact 가 ACTION 의 subject 든 CLAIM 의 speaker 든 MEASUREMENT 의 metric-bearing entity 든, 모두 같은 matcher 경유.

3. **uid_map build + remap** (`processor.py:933-935`, `processor.py:328-432`)
   `_build_uid_mapping` 이 LLM placeholder (obj-N) → canonical UUID 로 변환하는 dict 를 만들고, `_remap_links` 가 `fact_object_links` 와 `fact_fact_links` 의 양끝을 rewrite.

4. **link creation** (`link_creator.py:85-183`)
   `create_links` 가 fact_object/object_object/fact_fact 세 axis 만 알고 fact_type 은 **dict 의 key 도 아님**. `_validate` 가 link_type 만 enum 체크.

Grep `fact_type` `backend/api/structure/link_creator.py` → **0 hit**. Grep `fact_type` `backend/api/structure/processor.py` → 9 hit, 모두 (a) dedup key, (b) measurement-completeness 분기, (c) 기본값 fallback (action), (d) 텔레메트리 로그. **link 생성에는 0 hit**.

### A.2 ★ Critical bug 발견 — speaker_uid 은 uid_map 에 안 들어감

`processor.py:558` 가 `d.setdefault("speaker_uid", d.get("speaker_uid"))` 만 합니다. ACTION 의 subject_uid 는 line 484-486 에서 `uid_map` 으로 remap 되는 반면, CLAIM 의 `speaker_uid` 는 LLM 의 placeholder (`obj-12`, `obj-15`) 그대로 ES 에 저장.

live 검증:

```json
{
  "claim": "베를린 헌법재판소와 독일연방헌법재판소는 ... 판시했다.",
  "speaker_uid": "obj-15",
  "speaker_label": "베를린 헌법재판소와 독일연방헌법재판소"
}
```

★ `speaker_uid` 가 placeholder 인 채로 ES 에 박혀 있으므로 **speaker ↔ canonical entity** 연결이 끊어진 상태입니다. M3-2a 의 "CLAIM = 독립 노드 + related-to entity 점선 엣지" 목표를 만들려면 이 remap 누락부터 고쳐야 합니다.

### A.3 code path map (file:line verbatim)

| step | file:line | 동작 |
|---|---|---|
| LLM call | `claude_client.py:319` | `client.messages.create` |
| JSON parse | `claude_client.py:348` | `_parse_json_safely` |
| schema validate | `claude_client.py:398` | `StructureResult.model_validate` |
| subject-surface map | `processor.py:908` | `_build_surface_map` |
| Object match loop | `processor.py:916-930` | `_match_object` (fact_type 모름) |
| uid_map build | `processor.py:933` | `_build_uid_mapping` |
| fact_uid map | `processor.py:934` | `_build_fact_uid_mapping` |
| **link remap** | `processor.py:935` | `_remap_links` |
| **link create** | `processor.py:936-940` | `create_links` |
| fact serialize | `processor.py:441-711` | `_serialize_struct_fact` |
| ★ subject_uid remap | `processor.py:484-486` | uid_map → canonical UID |
| ★ speaker_uid 누락 | `processor.py:558` | setdefault 만; uid_map 미적용 |

---

## B. fact_type 별 처리 격차

### B.1 ACTION

**현재 (live evidence)**
- `subject_uid` 가 canonical UUID 으로 채워짐 (133/133 = 100%)
- `object_value` 는 86% (114/133) literal string, 14% (19/133) UUID-like reference
- `predicate` 는 한국어 동사구 verbatim, OPL `predicate_code` 매핑 (대부분 `RELATED_TO` 로 격하; 일부 `REGULATES`, `ANNOUNCES` 등)
- 부가 참여자 (recipient/instrument/location) 는 **0** — claim 텍스트 안에만 존재

**M3-2a 목표**
- S─[predicate/about]→O 엣지 데이터 (현 모델 그대로 OK)
- ★ 부가 참여자를 fact role 속성 (recipient/instrument/location) 으로 보존

**격차**
- 모델은 이미 ACTION 의 edge-as-data 형태를 그대로 표현하지만 **fact role 속성을 받을 자리가 없음**. 새 필드 필요.

### B.2 CLAIM

**현재 (live evidence)**
- 100/301 fact = claim (33%)
- `speaker_uid` 99/100 채워짐 — 하지만 ★ 거의 모두 LLM placeholder `obj-N` 형태 (uid_map 미적용 버그, A.2)
- `speaker_label` 100/100 채워짐 (한국어 surface)
- `content_claim` 채워짐 — 하지만 **자유 텍스트일 뿐, 안에 등장한 entity 와 그래프 연결 없음**
- `stance` 정상 (critical / neutral / supportive / mixed / unknown)
- `subject_uid` + `predicate` + `object_value` 도 채워져서 ACTION 과 같은 SPO 엣지를 또 만듦 — **이중 표현**

**M3-2a 목표**
- 독립 노드 + content 안 entity 로 향하는 **related-to (점선/미검증)** 엣지
- provenance 게이트: 화자가 한 발화는 fact 이지만, 발화 내용 안의 주장은 자동 검증되지 않은 dotted edge

**격차**
- (1) ★ CLAIM 노드 자체의 모델링 — 현재는 SPO+claim_fields 평탄 구조, "독립 노드" 의 개념이 graph 에 없음
- (2) ★ content_claim 안 entity 추출 0 — 화자가 언급한 트럼프/이란/MOU 등을 named entity 로 자르고 dotted `related-to` 엣지 만드는 로직 없음
- (3) ★ speaker_uid uid_map remap 누락 (A.2) — 고치지 않으면 CLAIM 노드와 화자 canonical 노드의 연결 불가능
- (4) provenance 점선 표현 — link record 에 `link_status` (`verified` / `unverified` / `claim_only`) 같은 신규 필드 필요

### B.3 MEASUREMENT

**현재 (live evidence)**
- 68/301 fact = measurement (23%)
- `metric` 100% 채워짐 (e.g. 코스피 지수 종가, SK하이닉스 주가, MP 머티리얼즈의 미 국방부로부터 받은 지분 투자)
- `measurement_value` 100% 채워짐 (double)
- `measurement_unit` 분포: %, 달러, 원, 명, 포인트, GHz, V·cm, 곳, 엔, 조달러
- `as_of` 54% (37/68) — 나머지 46% 는 시점 모호로 null (prompt 의 적용/시행/발효 시점은 as_of 아님 룰 적용 결과)
- `subject_uid` 는 측정 대상 entity 의 canonical UID 으로 채워짐

**M3-2a 목표**
- entity 속성 시계열 — 같은 metric 의 여러 시점이 한 entity 의 속성 history 로 응축
- 수량 ≠ measurement: "3번 참석" 같은 count 는 action+count, measurement 아님

**격차**
- (1) ★ **현재 평탄 fact** 구조 — measurement 가 fact 로 박혀 있지만, entity 속성의 시계열로 응축되는 구조 없음
- (2) 수량 vs measurement 분류는 **prompt 수준에서 잘 작동**: "10곳 (수출통제 대상에 추가)" → action, object_value=…기업 10곳; "MAU 8억" → measurement, metric=MAU, value=8e8. live 데이터에서 오분류 없음 — Step 2c 의 분류 가이드가 충분히 명확
- (3) M3-2a 가 entity 속성으로의 통합을 요구한다면, recall 단에서 metric+subject_uid grouping API 가 필요할 가능성 — 이번 PR scope 외

---

## C. 다항관계 현재 처리

### C.1 결론 — **부가 참여자 0 보존**

다항 fact 는 현재 **(subject, predicate, object)** 트리플 + 평탄 텍스트로만 표현되고, **recipient/instrument/location 의 구조 채널 없음**.

### C.2 live evidence — 의뢰서의 예제

PO 의 acceptance case: **"모스 탄이 6·3선거를 트럼프에게 알렸다"**. KS 안에 가까운 매치: **"탄 교수는 트럼프 1기 행정부에서 국제형사사법대사를 지냈다"**.

```json
{
  "claim": "탄 교수는 트럼프 1기 행정부에서 국제형사사법대사를 지냈다.",
  "subject_uid": "8e68baf5…",
  "predicate": "지냈다",
  "object_value": "국제형사사법대사",
  "fact_type": "action"
}
```

★ 트럼프 (행정부 owner), 1기 행정부 (workplace/instrument) — 어디에도 없음. role 정보 없음.

다항 entity 가 `fact_object_links` 의 `involves` link 로 연결될 가능성을 검증:

```json
{
  "fact_uid": "8d98743b…",
  "link_type": "involves",
  "object_uid": "9981be72…",
  "properties": {}
}
```

`involves` link 는 fact 와 entity 의 연결 자체는 있지만 **role 미분리**. 의뢰서의 trump=recipient, 6·3선거=topic/about, 모스탄=speaker(actor) 의 3중 구조를 표현할 자리 없음.

### C.3 추정 빈도

ACTION 133 + CLAIM 100 = 233 의 fact 중 다항 관계가 자연어로 박혀 있을 추정 빈도는 PO 의 trial 데이터(언론 기사) 특성상 **30-50%**:
- 모든 정치 인용 (X 가 Y 에게 Z 라고 말했다)
- 외교 발표 (A 가 B 와 C 에 대해 협정을 맺었다)
- 경제 행위 (X 가 Y 를 Z 로부터 인수했다)

★ 정확한 빈도 측정은 LLM 기반 detection 이 필요해서 이번 discovery 의 scope 외. 하지만 PO acceptance 의 3 예제 (모스탄 / aweb / 3번참석) 모두 현재 모델에서 잃어버리는 정보가 있음을 확인.

### C.4 누락 시 → role 속성 추가 위치

**현재 schema** — `StructureFactObjectLink` (`models.py:159-178`):

```python
class StructureFactObjectLink(LucidBaseModel):
    fact_uid: UID
    object_uid: UID
    link_type: Literal[
        "asserts_property", "describes_state", "addresses", "uses", "involves"
    ]
    properties: dict[str, Any] = Field(default_factory=dict)
```

**M3-2a 의 자연 확장** — `properties` 안에 `role` key 추가:

```python
properties: dict[str, Any]
# = {"role": "recipient" | "instrument" | "location" | "topic" | ...}
```

확장 위치:
- (a) prompt — Step 5 (Fact↔Object link) 에 role 채널 추가
- (b) `StructureFactObjectLink.properties` 의 의미 정의 + Pydantic 검증
- (c) `link_creator.create_links` 의 link record 에 `role` 보존
- (d) ES `lucid_facts.fact_object_links_detail` (현재 SourceJob meta JSONB)

---

## D. ES schema 변경 영향

### D.1 lucid_facts mapping (현재)

`mappings.py:36-192` LUCID_FACTS_MAPPING — `dynamic: "strict"`. 이미 존재하는 fact_type 관련 field:
- `fact_type`, `speaker_uid`, `speaker_label`, `speech_act`, `content_claim`, `stance` (CLAIM 용)
- `metric`, `measurement_value`, `measurement_unit`, `as_of` (MEASUREMENT 용)
- `subject_uid`, `predicate_code`, `object_canonical`, `canonical_key` (canonical layer)

### D.2 M3-2a 가 필요한 신규 field

| field | 위치 | 타입 | 용도 |
|---|---|---|---|
| `related_entity_uids` | fact doc | keyword array | ★ CLAIM 의 content_claim 안 entity 의 canonical UID 목록 (related-to dotted edge 용) |
| `fact_object_role` | fact_object_links_detail 의 properties.role | keyword | recipient / instrument / location / topic 등 fact role 속성 |
| `link_status` | fact_object_links_detail | keyword | verified / unverified / claim_only (점선/실선 표현 + provenance 게이트) |

### D.3 mapping migration

- `lucid_facts` 의 `related_entity_uids` 추가 — additive, 기존 doc null 허용. **migration 필요** (put_mapping 호출).
- `fact_object_links_detail` 은 현재 SourceJob `extracted_metadata` JSONB 안의 nested array — ES strict mapping 의 대상이 **아님**. 추가 안전.
- 만약 별도 `lucid_links` index 가 신설된다면 fresh mapping 필요. 현재로서는 JSONB 유지가 가장 가벼움.

### D.4 mapping migration 영향 — 회귀 위험

- ★ canonical-layer 영향 0 — `canonical_key` / `predicate_code` 미터치
- ★ dedup 영향 0 — `fact_dedup` 의 키 ((subject, fact_type, predicate_norm, object)) 미터치
- ★ recall 영향 0 — 새 field 는 기본 NULL, 기존 query 통과
- ★ 영향만 있는 path: 새 field 를 적극 활용하는 Decide UI 에서 표시 로직 추가 (이번 PR scope 외)

---

## E. live data 분포

KS `4a3a8bb7-5f3f-4a44-bc2d-f8e296966b5b` snapshot (2026-06-28):

### E.1 fact_type 분포

| type | count | % |
|---|---|---|
| action | 133 | 44.2% |
| claim | 100 | 33.2% |
| measurement | 68 | 22.6% |
| **total** | **301** | 100% |

(★ 의뢰서가 ACTION 318 vs CLAIM 57 vs MEASUREMENT 23 라고 적혀 있었지만 실제 KS 현재 상태는 위와 같음. CLAIM/MEASUREMENT 가 의뢰서 시점보다 더 많이 적립되어 있음 — fact-classification-recovery prompt 의 효과가 보이는 분포.)

### E.2 subject_uid / object_value 비율
- ACTION 의 `subject_uid` 채워진 비율: 133/133 = 100%
- ACTION 의 `object_value` 가 UUID-like (다른 entity 참조): 19/133 = 14%
- ACTION 의 `object_value` 가 literal: 114/133 = 86%
- CLAIM 의 `object_value` 가 UUID-like: 1/100 = 1% — **거의 모두 literal (발화 내용 평탄 텍스트)** ★ B.2 의 entity 추출 0 가설 확인

### E.3 CLAIM speaker 채움률
- `speaker_uid` 채워짐: 99/100 = 99%
- `speaker_label` 채워짐: 100/100 = 100%
- ★ 단, `speaker_uid` 의 거의 모두가 LLM placeholder `obj-N` (A.2)

### E.4 MEASUREMENT field 채움률
- `metric` 채워짐: 68/68 = 100%
- `measurement_value` 채워짐: 68/68 = 100%
- `as_of` 채워짐: 37/68 = 54%

### E.5 다항관계 빈도 추정
- ACTION 133 + CLAIM 100 의 30-50% 가 자연어 안에 ≥3 entity 가짐 추정 (정확한 측정은 LLM 검출 필요, discovery scope 외)
- 의뢰서 의 acceptance case 모스 탄이 6·3선거를 트럼프에게 알렸다 같은 패턴이 live data 의 정치/외교 기사에 빈출 — 현재 모두 **데이터 손실 상태**

---

## F. M3-2a Implement 의 제안 path (★ PO 검토용)

★ 코드 변경 0, PO 승인 대기. 아래 path 는 PO 가 implement scope 를 검토하기 위한 자료.

### F.1 변경 위치 (file:line, lines 추정)

**Stage 1 — CLAIM 의 speaker_uid uid_map remap (★ critical bug fix)**

- `backend/api/structure/processor.py:558` (6 line edit)

  현재:
  ```python
  d.setdefault("speaker_uid", d.get("speaker_uid"))
  ```

  변경:
  ```python
  speaker = d.get("speaker_uid")
  if isinstance(speaker, str) and speaker in uid_map:
      d["speaker_uid"] = uid_map[speaker]
  else:
      d.setdefault("speaker_uid", speaker)
  ```

  - 변경 크기: 6 lines
  - 회귀 위험: 0 — uid_map 에 없으면 setdefault 그대로 fallback
  - replay 필요: 기존 99 개 CLAIM 의 `speaker_uid=obj-N` 은 fix 후 backfill script 또는 재캡처 시 자연 정정

**Stage 2 — fact_object_links 의 role 속성 channel**

- `backend/api/structure/prompts.py:317-318` (Step 5 — Fact↔Object link types) — `involves` link 의 properties 에 `role` 옵션 추가. 변경 크기: 약 25 lines (prompt 추가 + 예제 1개)
- `backend/api/structure/models.py:159-178` `StructureFactObjectLink.properties` 의 의미 정의 (validation 없음, pass-through). 변경 0 lines (schema 가 이미 `dict[str, Any]`).
- `backend/api/structure/link_creator.py:106-122` — `CreatedLink` 에 `role` 옵션 추가, raw dict 에서 보존. 변경 크기: 약 10 lines
- `backend/api/structure/processor.py:992-1000` `fact_object_links_detail` serialize 시 `properties.role` 통과. 변경 크기: 약 3 lines (이미 properties dict 통째로 통과 중)

**Stage 3 — CLAIM 의 related-to dotted edge**

- `backend/api/structure/prompts.py` — Step 5/6 에 CLAIM 의 content 안 entity 추출 + related-to link 추가 가이드. 변경 크기: 약 40 lines
- `backend/api/structure/models.py` — `StructureFact` 에 `related_entity_uids: list[UID]` 옵션 추가. 변경 크기: 약 5 lines
- `backend/api/structure/processor.py:548-563` — fact 직렬화 시 related entity uid 들도 uid_map 으로 remap. 변경 크기: 약 10 lines
- `backend/api/storage/elasticsearch/mappings.py:36-192` — LUCID_FACTS 에 `related_entity_uids` keyword array 추가. 변경 크기: 1 line
- migration script: 새 mapping put — additive (기존 doc null OK)

**Stage 4 — link_status 점선/미검증 표현**

- `fact_object_links_detail` 의 link 객체에 `link_status` (verified / unverified / claim_only) 추가
- `backend/api/structure/link_creator.py:56-64` `CreatedLink` 에 추가. 변경 크기: 약 5 lines
- Decide / Stellar UI 에서 점선 표현 — 별도 PR (FE scope)

### F.2 회귀 영향 확인

| 회귀 영역 | 영향 | 근거 |
|---|---|---|
| canonical-layer | ★ 없음 | `canonical_key` / `predicate_code` / `object_canonical` 미터치 |
| dedup | ★ 없음 | `fact_dedup._canonical_dedup_key` 의 키 미터치 |
| recall | ★ 없음 | 새 field 모두 nullable, 기존 query path 통과 |
| Decide UI 기존 표시 | ★ 없음 | 새 field 추가 시 기존 표현 미터치 |
| migration | ★ 안전 | additive — 기존 doc 에 null 로 채워짐 |

### F.3 live Claude smoke 시나리오 (3-4 case)

PO acceptance 의 3 case 를 그대로 + 1 추가:

1. **"모스 탄이 6·3선거를 트럼프에게 알렸다"** (action + recipient role) — Expected: ACTION fact, subject=모스탄, predicate=알리다, object=6·3선거, fact_object_links 에 (involves, 트럼프, role=recipient)
2. **"aweb 관련 주장"** (claim + dotted related-to) — Expected: CLAIM fact, speaker=주장한자, content_claim=주장 내용, content 안의 aweb → related_entity_uids=[aweb_uid], fact_object_links 에 (involves, aweb, link_status=unverified)
3. **"3번 참석"** (action + count, measurement 아님) — Expected: ACTION fact, object_value 안에 "3번" literal 보존, fact_type=action (NOT measurement)
4. **신규**: **"척 슈머가 트럼프 4명의 공화당 패배자 들을 비난했다"** (다항 — speaker + addressee + count 베이킹) — Expected: ACTION fact + (involves, 트럼프, role=topic) + (involves, 공화당 패배자, role=co-target)

### F.4 단계화 권장

PO 의 점진 도입 원칙대로:
1. Stage 1 단독 PR (1-line bug fix) — 즉시 가능
2. Stage 2 단독 PR (role channel) — Stage 1 후
3. Stage 3 단독 PR (CLAIM related-to) — Stage 2 후
4. Stage 4 단독 PR (link_status) — Stage 3 후

각 단계 끝에 live Claude smoke 4 case 재실행.

---

## ★ PO 의 결정 요청 항목

1. **Stage 1 (speaker_uid bug fix) 를 별도 hotfix PR 로 즉시 진행?** 현재 KS 4a3a8bb7… 의 99 개 CLAIM 이 모두 placeholder 상태.

2. **fact role 속성 schema 합의** — recipient / instrument / location 외에 어떤 role 까지 1차 도입? 제안: recipient, instrument, location, topic, co-actor (5 종)

3. **CLAIM 의 related-to 자동 추출** — LLM 단계에서 content_claim 안 entity 를 자동 자르고 dotted edge 만드는 것을 prompt 기반으로 진행? 아니면 별도 named-entity extraction layer ? 제안: prompt 기반 (token 비용 적음)

4. **mapping migration 의 timing** — Stage 3 의 `related_entity_uids` field 는 mapping put 1회 필요. live ES 에 즉시 적용해도 안전? 제안: additive 라 즉시 적용 OK

5. **replay/backfill** — 기존 301 fact 의 speaker_uid 와 measurement subject 를 fix 후 다시 돌리기? 제안: Stage 1 fix 후 backfill script 1회 실행, 이후 자연 수정

6. **다음 PR 의 단계화** — Stage 1-4 각각 별도 PR? 또는 1+2 묶기? 제안: Stage 1 즉시 hotfix, Stage 2-3 묶어서 한 PR, Stage 4 별도

---

## 다음 단계

★ **Implement 는 PO 승인 후 별도 PR**

이 PR (`feat/m3-2a-discovery-report`) 은 discovery report only. 코드 변경 0. 본 보고서 검토 + 위 결정 요청 6 항목 회신 후 별도 branch 에서 Stage 1-4 진행 예정.
