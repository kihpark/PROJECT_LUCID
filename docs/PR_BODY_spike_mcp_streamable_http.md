# spike/mcp-streamable-http — MCP transport reconnaissance

**Branch off `main`. 1-day budget. Production paths unaffected.**

Per DR-081 (Lucid integrates the personal-AI ecosystem at the MCP boundary, NOT the storage layer), this spike answers ONE binary question before committing the Phase 2 budget:

> **Does the Anthropic-maintained `mcp` Python SDK's `streamable_http` transport compose with Lucid's existing FastAPI + Bearer-JWT stack well enough to be the production transport choice?**

## Binary conclusion: ✅ COMPATIBLE

Three round-trips captured in this PR (full logs in the squash commit body). No protocol-level gap. Existing FastAPI + ASGI middleware + Bearer-token enforcement integrate naturally with the SDK's `streamable_http_app()` ASGI app.

## AGPL containment

CORE (`github.com/RedPlanetHQ/core`) is licensed AGPL 3.0. **This spike was authored without reading any CORE source.** The only references consulted were:

- The Model Context Protocol public specification (`modelcontextprotocol.io`)
- The Anthropic-maintained `mcp` Python SDK on PyPI

## Three reproduction round-trips

### Round-trip 1 — valid Bearer token → 200 + JSON

```
[client] connecting to http://127.0.0.1:9999/mcp
[client] session initialized; server: lucid-spike v1.27.2
[client] tools discovered: ['lucid_search_facts']
[client] tool call result:
{
  "results": [
    { "fact_uid": "fn-spike-1", "claim": "삼성전자는 2024년 4분기에…", "validation_method": "manual", … },
    { "fact_uid": "fn-spike-2", "claim": "한국은행 기준금리는 2024년 12월 기준 3.0%였다.", "validation_method": "manual", … }
  ],
  "query": "삼성전자 영업이익",
  "language_filter": "ko",
  "spike_note": "All facts are dummy data; production path lands in Phase 2 (DR-081)."
}
```

### Round-trip 2 — invalid Bearer token → 401

```
[client] connecting to http://127.0.0.1:9999/mcp
httpx.HTTPStatusError: Client error '401 Unauthorized' for url 'http://127.0.0.1:9999/mcp'
```

### Round-trip 3 — no Authorization header (raw curl) → 401

```sh
$ curl -sS -X POST http://127.0.0.1:9999/mcp \
       -H "Content-Type: application/json" \
       -d '{"jsonrpc":"2.0","method":"initialize","id":1}' \
       -w "\nHTTP %{http_code}\n"
{"error":"missing_bearer_token"}
HTTP 401
```

## What this spike does NOT prove

| Out of scope | Why | Where it lands |
|--------------|-----|----------------|
| ES `lucid_facts` round-trip | hardcoded dummy returned | Phase 2 production work |
| Production JWT decode | spike uses fixed allowlist; `api.security.dependencies.get_current_user` untouched | Phase 2 |
| Per-user quota / audit logs | not the spike's question | Phase 2 |
| Behavior under load | single round-trip only | Phase 2 perf review |
| Cross-client compatibility | only the official `mcp` Python SDK exercised; not Claude Code CLI / Cursor / Codex | Phase 3 provider docs |

## Files

| Path | Role |
|------|------|
| `backend/requirements.txt` | adds `mcp>=1.0` as declared dep (Anthropic SDK; PyPI maintainer = Anthropic) |
| `backend/api/mcp/__init__.py` | package marker; documents that the router is intentionally NOT registered with `api/main.py` |
| `backend/api/mcp/server.py` | FastMCP server with ONE tool (`lucid_search_facts`) returning hardcoded dummy facts. ASGI middleware enforces Bearer auth via a fixed allowlist (`spike-test-token` literal + optional `LUCID_MCP_SPIKE_TOKEN` env). uvicorn on `127.0.0.1:9999/mcp`. |
| `backend/api/mcp/client.py` | streamable_http client used to capture the reproduction logs |
| `backend/api/mcp/README.md` | reproduction steps + what the spike does NOT prove |

**The spike package is NOT registered with `api/main.py`** — running `uvicorn api.main:app` continues to expose only the existing routes. The spike server only starts when `python -m api.mcp.server` is explicitly invoked. Acceptance criterion "프로덕션 코드 경로에 영향 없음" satisfied.

## DoD

| Check | Result |
|-------|--------|
| `ruff check .` | All checks passed |
| `pytest tests/unit -q` | **226 passed** (unchanged vs main) |
| `mypy .` | 1 error in `extractors/youtube_transcript.py:85` — **pre-existing on main** (verified by `git stash + git checkout main + mypy`); a `youtube-transcript-api` v1.x API-shape change that the upgraded package now exposes to mypy. **Not introduced by this spike.** Flagged for a separate chore PR. |
| MCP round-trip (valid token) | ✅ tool listing + call returns dummy facts |
| MCP round-trip (invalid token) | ✅ 401 |
| MCP round-trip (no header, raw curl) | ✅ 401 |

## Spike-only artifacts that would NOT ship to production

- The Bearer token allowlist (`'spike-test-token'`) — production binds to `api.security.dependencies.get_current_user`
- The hardcoded dummy facts — production reads from `lucid_facts` ES with `validation_method='manual'` filter
- The standalone `uvicorn` entrypoint — production mounts the MCP ASGI subapp on the main FastAPI app under `/api/v1/mcp/`

## What the spike DOES tell PO for the Phase 2 decision

1. The `mcp` Python SDK's `streamable_http_app()` returns an ASGI app that composes cleanly with FastAPI / Starlette middleware. **No transport rewrite needed.**
2. Bearer auth at the ASGI layer works — JWT decoding can sit in the same middleware shape, just replacing the allowlist check with `api.security.dependencies.get_current_user`.
3. `FastMCP.tool()` decorator → JSON tool returns are handled by the SDK as MCP `TextContent` blocks; the FastNode shape requires no protocol-level mapping.
4. **No identifiable AGPL/source-disclosure risk** from using the SDK. SDK is MIT-licensed (Anthropic-maintained); MCP is an open spec.

## Recommended next step (for PO)

If beta cohort N=10 signals positive wedge validation (per DR-081 Phase 1 gate), Phase 2 can proceed against the same SDK + ASGI shape. The total transport-level risk going into Phase 2 is materially lower than before this spike.

If the answer is "wedge not validated," the spike code stays in the branch but does no harm in `main` — it isn't mounted.

## Commit

```
<sha>  spike(mcp): minimal streamable_http server stub + round-trip client
```

## Follow-ups (out of scope here)

- chore: fix `extractors/youtube_transcript.py:85` against `youtube-transcript-api` ≥1.0 (instance method, not class method)
- chore: documentation defect — DR-053's entry body mentions only wedge-discovery; staleness retirement is implied via DR-051/052 supersession notes + `models/facts.py` docstring. Either expand DR-053 body or add DR-053.b. Spotted while addressing B-17 Task 3.
