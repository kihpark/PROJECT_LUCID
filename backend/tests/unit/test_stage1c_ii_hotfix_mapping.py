"""
REQ-004 STAGE 1c-ii hotfix — relabel_history strict_dynamic_mapping reject.

★ Root cause (★ live log, PO 2026-06-30):
    BadRequestError(400, 'strict_dynamic_mapping_exception',
    '[1:659] mapping set to strict, dynamic introduction of [to_primary_lang]
     within [relabel_history] is not allowed')

★ ES `lucid_objects` 의 ★ relabel_history mapping 은 ★ strict + 허용 필드 =
  {at, from_primary, to_primary, reason}. 따라서 gateway 가 보낸
  to_primary_lang / confidence / merge_provenance 는 ★ ★ ★ 모두 reject →
  ★ ★ entity ES insert 전체 실패 → ★ ★ orphan UUID 양산.

★ 본 test 는 ★ 케이스가 아닌 ★ 원칙을 가드한다:
  1. _insert_candidate_entity 가 ES 로 보내는 relabel_history 의 모든
     entry 는 ★ mapping 의 허용 keyword set 안에 있어야 한다.
  2. 부가 정보 (lang / confidence / merge_provenance) 는 dynamic_object 인
     `properties` 로 흘러 가야 한다.
  3. ES insert 가 strict_dynamic_mapping_exception 없이 통과해야 한다.
"""
from unittest.mock import MagicMock, patch

from api.structure.resolution_gateway import _insert_candidate_entity, resolve


# ★ relabel_history mapping 의 strict 허용 필드 (★ mappings.py:313-321 verbatim)
_ALLOWED_RELABEL_HISTORY_FIELDS = {"at", "from_primary", "to_primary", "reason"}


def test_candidate_insert_relabel_history_uses_only_strict_allowed_fields():
    """★ _insert_candidate_entity 의 relabel_history 엔트리는 ★ mapping
    strict 허용 필드만 포함해야 한다 (★ to_primary_lang / confidence /
    merge_provenance 같은 reject 필드 부재).
    """
    client = MagicMock()
    client.index.return_value = {"result": "created"}

    _insert_candidate_entity(
        client=client,
        normalized="선관위",
        lang="ko",
        knowledge_space_id="ks-1",
        entity_type="organization",
        confidence=0.42,
        merge_provenance={"source": "gateway", "stage": "1c-ii"},
    )

    assert client.index.called, "★ ES index 호출되어야 함"
    body = client.index.call_args.kwargs["document"]
    rh_entries = body.get("relabel_history", [])
    assert rh_entries, "★ relabel_history 엔트리는 ★ 최소 1 개"

    for entry in rh_entries:
        extra = set(entry.keys()) - _ALLOWED_RELABEL_HISTORY_FIELDS
        assert not extra, (
            f"★ relabel_history 에 strict reject 필드 발견: {extra}. "
            f"허용: {_ALLOWED_RELABEL_HISTORY_FIELDS}"
        )


def test_candidate_insert_moves_lang_confidence_provenance_to_properties():
    """★ hotfix 의 두 번째 원칙: ★ relabel_history 에서 제거된 부가
    정보 (lang / confidence / merge_provenance) 는 ★ dynamic_object 인
    `properties` 로 흘러 가야 한다 (★ 정보 손실 X).
    """
    client = MagicMock()
    client.index.return_value = {"result": "created"}

    merge_prov = {"source": "gateway", "stage": "1c-ii"}
    _insert_candidate_entity(
        client=client,
        normalized="이준석 대표",
        lang="ko",
        knowledge_space_id="ks-1",
        entity_type="person",
        confidence=0.55,
        merge_provenance=merge_prov,
    )

    body = client.index.call_args.kwargs["document"]
    props = body.get("properties", {})

    # ★ lang
    assert props.get("candidate_insert_lang") == "ko"
    # ★ confidence
    assert float(props.get("candidate_insert_confidence")) == 0.55
    # ★ merge_provenance (★ dict)
    assert props.get("candidate_insert_merge_provenance") == merge_prov


def test_candidate_insert_es_index_called_without_strict_reject_payload():
    """★ end-to-end: ES index 호출 시 ★ document 안의 모든 nested
    필드는 strict mapping 정합. relabel_history 의 keyset 이 ★ 허용
    set 의 부분집합이어야 한다.
    """
    client = MagicMock()
    client.index.return_value = {"result": "created"}

    _insert_candidate_entity(
        client=client,
        normalized="새로운 단체",
        lang="ko",
        knowledge_space_id="ks-1",
        entity_type="organization",
        confidence=0.7,
        merge_provenance=None,
    )

    body = client.index.call_args.kwargs["document"]
    for entry in body["relabel_history"]:
        assert set(entry.keys()).issubset(_ALLOWED_RELABEL_HISTORY_FIELDS), (
            f"★ relabel_history entry keyset {set(entry.keys())} "
            f"⊄ allowed {_ALLOWED_RELABEL_HISTORY_FIELDS}"
        )


@patch("api.structure.resolution_gateway.get_embedding")
def test_resolve_candidate_path_does_not_raise_on_strict_mapping(mock_emb):
    """★ resolve() 의 candidate path 가 ES strict_dynamic_mapping 으로
    실패하지 않음 — _insert_candidate_entity 가 ★ 정상 종료.
    """
    mock_emb.return_value = tuple([0.1] * 1536)
    client = MagicMock()
    # ★ 모든 search 미스 → candidate path
    client.search.return_value = {"hits": {"hits": []}}
    client.index.return_value = {"result": "created"}

    result = resolve("선관위", "ko", "ks-1", client=client)
    assert result.source == "candidate"
    assert result.entity_id, "★ candidate entity_id 는 non-empty"
    assert client.index.called, "★ ES insert 시도되어야 함"

    body = client.index.call_args.kwargs["document"]
    for entry in body["relabel_history"]:
        assert set(entry.keys()).issubset(_ALLOWED_RELABEL_HISTORY_FIELDS)
