"""spike/mcp-streamable-http — minimal MCP server stub.

ONE tool exposed: lucid_search_facts. Returns hardcoded dummy FactNode-shaped
dicts. No ES, no Postgres, no real auth backend. The objective of this spike
is to verify the MCP streamable_http transport composes with the existing
FastAPI/Bearer-JWT pattern; nothing about the dummy payload is real.

AGPL note: this file was authored without reading any RedPlanetHQ/core
source. Only the public Model Context Protocol specification
(modelcontextprotocol.io) and the Anthropic-maintained `mcp` Python SDK
were consulted.

Run:
    python -m api.mcp.server
Then exercise from another shell:
    python -m api.mcp.client http://localhost:9999/mcp test-token-xyz
"""
from __future__ import annotations

import logging
import os
import sys

from mcp.server.fastmcp import FastMCP

logger = logging.getLogger("lucid.mcp.spike")


# ---------------------------------------------------------------------------
# Spike-only Bearer-token allowlist. NOT touching api.security.dependencies
# so the production auth path stays untouched. Two acceptable tokens:
#   1) The env LUCID_MCP_SPIKE_TOKEN, if set
#   2) The literal 'spike-test-token' fallback for the round-trip check
# ---------------------------------------------------------------------------
_SPIKE_TOKEN_FALLBACK = "spike-test-token"


def _expected_tokens() -> set[str]:
    tokens = {_SPIKE_TOKEN_FALLBACK}
    env = os.environ.get("LUCID_MCP_SPIKE_TOKEN")
    if env:
        tokens.add(env)
    return tokens


def _verify_bearer(authorization: str | None) -> None:
    if not authorization or not authorization.lower().startswith("bearer "):
        raise PermissionError("missing_bearer_token")
    token = authorization.split(" ", 1)[1].strip()
    if token not in _expected_tokens():
        raise PermissionError("invalid_bearer_token")


# ---------------------------------------------------------------------------
# FastMCP server
# ---------------------------------------------------------------------------
mcp = FastMCP(
    "lucid-spike",
    host="127.0.0.1",
    port=9999,
    streamable_http_path="/mcp",
    stateless_http=True,
)


@mcp.tool()
def lucid_search_facts(
    query: str,
    knowledge_space_id: str,
    limit: int = 10,
    kNN_threshold: float = 0.72,
    language: str = "any",
) -> dict:
    """Spike stub: returns two hardcoded validated facts.

    The production tool (Phase 2 per DR-081) will hit lucid_facts ES
    with validation_method='manual' filter. This stub exists solely to
    verify MCP transport + auth round-trips against Lucid's stack.
    """
    logger.info(
        "lucid_search_facts called: q=%r ks=%s limit=%d k=%s lang=%s",
        query, knowledge_space_id, limit, kNN_threshold, language,
    )

    dummy_facts = [
        {
            "fact_uid": "fn-spike-1",
            "claim": "삼성전자는 2024년 4분기에 영업이익 6조5천억 원을 기록했다.",
            "claim_en": "Samsung Electronics recorded KRW 6.5T operating profit in Q4 2024.",
            "type": "proposition",
            "subject_uid": "obj-samsung-electronics",
            "predicate": "operating_profit",
            "object_value": "KRW 6.5T",
            "source_uids": ["src-hankyung-2025-01-31"],
            "validated_at": "2025-02-01T10:00:00Z",
            "validator_id": "user-spike-demo",
            "validation_method": "manual",
            "knowledge_space_id": knowledge_space_id,
            "score": 0.87,
            "negation_flag": False,
            "negation_scope": None,
        },
        {
            "fact_uid": "fn-spike-2",
            "claim": "한국은행 기준금리는 2024년 12월 기준 3.0%였다.",
            "claim_en": "Bank of Korea base rate was 3.0% as of December 2024.",
            "type": "proposition",
            "subject_uid": "obj-bok",
            "predicate": "base_rate",
            "object_value": "3.0%",
            "source_uids": ["src-yonhap-2024-12-15"],
            "validated_at": "2024-12-16T08:30:00Z",
            "validator_id": "user-spike-demo",
            "validation_method": "manual",
            "knowledge_space_id": knowledge_space_id,
            "score": 0.79,
            "negation_flag": False,
            "negation_scope": None,
        },
    ]

    return {
        "results": dummy_facts[: max(1, min(limit, len(dummy_facts)))],
        "query": query,
        "language_filter": language,
        "spike_note": "All facts are dummy data; production path lands in Phase 2 (DR-081).",
    }


# ---------------------------------------------------------------------------
# Bearer auth middleware — wraps the streamable-http ASGI app
# ---------------------------------------------------------------------------
def make_auth_middleware(app):
    """Reject MCP requests lacking the spike Bearer token."""
    async def auth_app(scope, receive, send):
        if scope.get("type") != "http":
            return await app(scope, receive, send)
        headers = {k.decode().lower(): v.decode() for k, v in scope.get("headers", [])}
        try:
            _verify_bearer(headers.get("authorization"))
        except PermissionError as exc:
            body = (f'{{"error":"{exc}"}}').encode()
            await send({
                "type": "http.response.start",
                "status": 401,
                "headers": [
                    (b"content-type", b"application/json"),
                    (b"content-length", str(len(body)).encode()),
                ],
            })
            await send({"type": "http.response.body", "body": body})
            return
        await app(scope, receive, send)
    return auth_app


def main() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="[%(asctime)s] %(name)s %(levelname)s %(message)s",
        stream=sys.stdout,
    )
    logger.info("starting lucid MCP spike server on http://127.0.0.1:9999/mcp")
    logger.info("expected Bearer tokens: %s", sorted(_expected_tokens()))

    # FastMCP exposes the streamable_http ASGI app via .streamable_http_app()
    # We wrap that ASGI app in a Bearer-token middleware and serve it via uvicorn.
    import uvicorn
    inner = mcp.streamable_http_app()
    app = make_auth_middleware(inner)
    uvicorn.run(app, host="127.0.0.1", port=9999, log_level="info")


if __name__ == "__main__":
    main()
