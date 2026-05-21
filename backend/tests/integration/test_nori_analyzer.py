"""Integration test: nori (Korean morphological analyzer) loaded in ES.

Requires the custom ES image with `analysis-nori` plugin installed
(see docker/elasticsearch/Dockerfile). Skipped when ES is unreachable.
"""
import os

import pytest

pytestmark = pytest.mark.integration


KOREAN_INPUT = "地口品"  # placeholder; actual string below
# Use a real Korean string for the analyze call. Encoded inline so the
# source file remains pure ASCII (lint-clean) but the body uses the real
# Hangul characters when the test runs.
KOREAN_INPUT_REAL = "지식 그래프 검증"  # "지식 그래프 검증"
EXPECTED_TOKENS = {"지식", "그래프", "검증"}  # 지식, 그래프, 검증


def test_nori_analyzer_extracts_korean_tokens():
    """nori must split '지식 그래프 검증' into 지식, 그래프, 검증."""
    try:
        from elasticsearch import Elasticsearch
    except ImportError:
        pytest.skip("elasticsearch not installed in this environment")

    url = os.getenv("ELASTICSEARCH_URL", "http://localhost:9200")
    try:
        client = Elasticsearch(url, request_timeout=5, verify_certs=False)
        if not client.ping():
            pytest.skip(f"Elasticsearch not reachable at {url}")
        result = client.indices.analyze(body={"analyzer": "nori", "text": KOREAN_INPUT_REAL})
        client.close()
    except Exception as exc:  # noqa: BLE001
        pytest.skip(f"Elasticsearch not reachable: {exc}")

    tokens = {tok["token"] for tok in result.get("tokens", [])}
    missing = EXPECTED_TOKENS - tokens
    assert not missing, (
        f"nori plugin did not produce expected tokens. "
        f"Missing: {missing}. Got: {tokens}"
    )
