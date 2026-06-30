"""
REQ-004 STAGE 1a — resolution_gateway 골격 contract test.

★ 1b 에서 exact-cascade 가 ★ 추가되어 ★ cascade order 가 바뀜:
  exact → embedding kNN → LLM-classified candidate.
★ 아래 테스트는 ★ 1a 의 ResolvedEntity contract + ★ embedding/candidate
  branch 의 단순 회귀를 ★ 1b cascade 와 양립하도록 ★ exact miss 시나리오로
  ★ 명시화 (★ 1a 의 ★ 단일 path 가 ★ 1b 에서 ★ exact 가 우선이 됐기 때문).
"""
from unittest.mock import MagicMock, patch

from api.structure.resolution_gateway import ResolvedEntity, resolve


@patch.dict("os.environ", {"CROSS_LINGUAL_CANONICAL_ENABLED": "0"})
@patch("api.structure.resolution_gateway.get_embedding")
def test_resolve_returns_ResolvedEntity_contract(mock_emb):
    """★ 1a contract: resolve 가 ResolvedEntity 반환 (★ embedding path).

    ★ PO 2026-06-30: cross-lingual canonical check 가 exact 와 kNN 사이에
    추가되었으므로, ★ 이 단위 test 는 cross-lingual 을 끄고 ★ 순수 kNN
    path 만 검증한다 (★ cross-lingual 검증은 test_cross_lingual_canonical.py).
    """
    mock_emb.return_value = tuple([0.1] * 1536)
    client = MagicMock()
    # ★ exact cascade 4 tier miss → kNN hit (★ 1b cascade)
    client.search.side_effect = [
        {"hits": {"hits": []}},  # primary_label
        {"hits": {"hits": []}},  # name
        {"hits": {"hits": []}},  # name_en
        {"hits": {"hits": []}},  # aliases
        {"hits": {"hits": [{
            "_id": "e1",
            "_score": 0.97,
            "_source": {"name": "한국은행", "class": "organization"},
        }]}},  # kNN
    ]
    result = resolve("한국은행", "ko", "ks-1", client=client)
    assert isinstance(result, ResolvedEntity)
    assert result.entity_id == "e1"
    assert result.canonical_name == "한국은행"
    assert result.entity_type == "organization"
    assert result.source == "embedding"
    assert result.confidence >= 0.95


@patch.dict("os.environ", {"CROSS_LINGUAL_CANONICAL_ENABLED": "0"})
@patch("api.structure.resolution_gateway.get_embedding")
def test_resolve_below_threshold_returns_candidate(mock_emb):
    """★ kNN 낮은 score (< 0.70 disambig floor) → candidate.

    ★ PO 2026-06-30: cross-lingual disabled (★ 이 test 는 ★ kNN path 만).
    """
    mock_emb.return_value = tuple([0.1] * 1536)
    client = MagicMock()
    client.search.side_effect = [
        {"hits": {"hits": []}}, {"hits": {"hits": []}},
        {"hits": {"hits": []}}, {"hits": {"hits": []}},
        {"hits": {"hits": [{
            "_id": "e1",
            "_score": 0.5,  # ★ < 0.70 disambig floor → LLM path
            "_source": {"name": "한국은행", "class": "organization"},
        }]}},
    ]
    result = resolve("어떤 회사", "ko", "ks-1", client=client)
    assert result.source == "candidate"
    # ★ 1c-ii: gateway 가 ES insert 후 entity_id 채움 (non-empty)
    assert result.entity_id, "★ 1c-ii: candidate must carry non-empty entity_id"


@patch("api.structure.resolution_gateway.get_embedding")
def test_resolve_no_hits_returns_candidate(mock_emb):
    """★ exact + kNN 결과 0 → candidate."""
    mock_emb.return_value = tuple([0.1] * 1536)
    client = MagicMock()
    client.search.return_value = {"hits": {"hits": []}}
    result = resolve("새로운 회사", "ko", "ks-1", client=client)
    assert result.source == "candidate"
