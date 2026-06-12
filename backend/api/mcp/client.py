"""spike/mcp-streamable-http — round-trip client for the server stub.

Connects to the spike server, lists tools, calls lucid_search_facts,
prints the response, exits 0. Used to produce the reproduction log
attached to the spike PR description.

Usage:
    python -m api.mcp.client [URL] [TOKEN]
Defaults: URL=http://127.0.0.1:9999/mcp, TOKEN=spike-test-token
"""
from __future__ import annotations

import asyncio
import json
import sys

from mcp.client.session import ClientSession
from mcp.client.streamable_http import streamablehttp_client


async def run(url: str, token: str) -> int:
    headers = {"Authorization": f"Bearer {token}"}
    print(f"[client] connecting to {url}", flush=True)
    async with streamablehttp_client(url, headers=headers) as (read, write, _):
        async with ClientSession(read, write) as session:
            init = await session.initialize()
            print(f"[client] session initialized; server: {init.serverInfo.name} "
                  f"v{init.serverInfo.version}", flush=True)

            tools = await session.list_tools()
            tool_names = [t.name for t in tools.tools]
            print(f"[client] tools discovered: {tool_names}", flush=True)
            if "lucid_search_facts" not in tool_names:
                print("[client] ERROR: lucid_search_facts not advertised", flush=True)
                return 2

            result = await session.call_tool(
                "lucid_search_facts",
                {
                    "query": "삼성전자 영업이익",
                    "knowledge_space_id": "ks-spike-001",
                    "limit": 5,
                    "language": "ko",
                },
            )
            print("[client] tool call result:", flush=True)
            for item in result.content:
                # Content blocks may be TextContent or ImageContent etc.;
                # the FastMCP tool returns a JSON-encoded text block.
                text = getattr(item, "text", None)
                if text is not None:
                    print(json.dumps(json.loads(text), ensure_ascii=False, indent=2),
                          flush=True)
                else:
                    print(item, flush=True)
            return 0


def main() -> None:
    url = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:9999/mcp"
    token = sys.argv[2] if len(sys.argv) > 2 else "spike-test-token"
    code = asyncio.run(run(url, token))
    sys.exit(code)


if __name__ == "__main__":
    main()
