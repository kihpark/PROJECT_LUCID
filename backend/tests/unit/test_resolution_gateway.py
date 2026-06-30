"""
REQ-004 STAGE 1a — resolution_gateway 골격 contract test.
"""
from unittest.mock import MagicMock, patch

from api.structure.resolution_gateway import ResolvedEntity, resolve


@patch("api.structure.resolution_gateway.get_embedding")
def test_resolve_returns_ResolvedEntity_contract(mock_emb):
    """★ 1a contract: resolve 가 ResolvedEntity 반환."""
    mock_emb.return_value = tuple([0.1] * 1536)
    client = MagicMock()
    client.search.return_value = {
        "hits": {"hits": [{
            "_id": "e1",
            "_score": 0.95,
            "_source": {"name": "한국은행", "class": "organization"},
        }]}
    }
    result = resolve("한국은행", "ko", "ks-1", client=client)
    assert isinstance(result, ResolvedEntity)
    assert result.entity_id == "e1"
    assert result.canonical_name == "한국은행"
    assert result.entity_type == "organization"
    assert result.source == "embedding"
    assert result.confidence >= 0.85


@patch("api.structure.resolution_gateway.get_embedding")
def test_resolve_below_threshold_returns_candidate(mock_emb):
    """★ kNN 낮은 score → candidate (★ 1c 에서 새 entity 저장)."""
    mock_emb.return_value = tuple([0.1] * 1536)
    client = MagicMock()
    client.search.return_value = {
        "hits": {"hits": [{
            "_id": "e1",
            "_score": 0.5,
            "_source": {"name": "한국은행", "class": "organization"},
        }]}
    }
    result = resolve("어떤 회사", "ko", "ks-1", client=client)
    assert result.source == "candidate"
    assert result.entity_id == ""  # ★ 1c 에서 채움


@patch("api.structure.resolution_gateway.get_embedding")
def test_resolve_no_hits_returns_candidate(mock_emb):
    """★ kNN 결과 0 → candidate."""
    mock_emb.return_value = tuple([0.1] * 1536)
    client = MagicMock()
    client.search.return_value = {"hits": {"hits": []}}
    result = resolve("새로운 회사", "ko", "ks-1", client=client)
    assert result.source == "candidate"
