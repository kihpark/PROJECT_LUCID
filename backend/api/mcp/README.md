# spike/mcp-streamable-http

**This package is a sealed reconnaissance spike. NOT mounted on the
production FastAPI app.**

Per **DR-081** (Lucid integrates the personal-AI ecosystem at the MCP
boundary), the path forward is a first-party Lucid MCP server. Before
committing the Phase 2 budget for the full implementation (~4 engineer-weeks),
this spike answers one question:

> Does the Anthropic-maintained `mcp` Python SDK's `streamable_http`
> transport compose with Lucid's existing FastAPI / Bearer-JWT stack
> well enough to be the production transport choice?

## AGPL containment

CORE (`github.com/RedPlanetHQ/core`) is licensed AGPL 3.0. This spike
was authored without reading any CORE source. The only external
references consulted were:

- The Model Context Protocol public specification (`modelcontextprotocol.io`)
- The Anthropic-maintained `mcp` Python SDK on PyPI

## Reproduction (~30 seconds)

```sh
# 1. Install deps (mcp added to backend/requirements.txt)
pip install -r backend/requirements.txt

# 2. Start the spike server (one tool: lucid_search_facts, returns dummy facts)
cd backend
python -m api.mcp.server
# → starts uvicorn at http://127.0.0.1:9999/mcp

# 3. From a second shell, run the client
cd backend
python -m api.mcp.client http://127.0.0.1:9999/mcp spike-test-token
# → connects, initializes, lists tools, calls lucid_search_facts,
#   prints the dummy fact JSON, exits 0
```

## Auth

The spike server requires `Authorization: Bearer <token>`. Two tokens
accepted:

- The literal `spike-test-token` (default for the round-trip check)
- Anything you set in the `LUCID_MCP_SPIKE_TOKEN` env var

No DB lookup. The production path will reuse
`api.security.dependencies.get_current_user` which decodes the real
Lucid JWT and confirms the user; for the spike that's overkill.

## Why "not mounted"

`api/mcp/__init__.py` and `server.py` live in the codebase but
`api/main.py` does NOT register the MCP router. Running
`uvicorn api.main:app` continues to expose only the existing routes.
The spike server only starts when `python -m api.mcp.server` is
explicitly invoked.

## What this spike does NOT prove

- ES `lucid_facts` round-trip (this stub returns hardcoded dicts)
- Production JWT decode (this stub uses a fixed allowlist)
- Per-user quota / audit logs (Phase 2 work)
- streamable_http behavior under load (1-RT only)
- Compatibility with every MCP client implementation (only verified
  against the official `mcp` Python SDK client)
