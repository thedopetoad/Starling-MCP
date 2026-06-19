#!/usr/bin/env python3
"""
api-bot.py — a minimal trading bot that drives the Starling Execution MCP with Claude.

What it shows, end to end:
  1. Launch the Starling MCP as a child process over **stdio** (from your local
     clone's built `dist/bin/starling-mcp.js`).
  2. List its tools and hand them to Claude as native tool definitions.
  3. Run a tiny agent loop: the model decides which Starling tool to call, we
     execute it over the MCP connection, feed the result back, repeat.

This is the read-only "prove the handshake" path you should run FIRST: it calls
`auth_check` / `get_wallet_addresses` / `ping`, which never move money. The
money-moving tools (open_position, get_quote, build_bridge, ...) are driven by
the exact same loop — you only change the prompt.

Honest notes:
  * Default network is **testnet** and keys are optional for the read-only tools.
    Funding + real trades need keys (see the repo README) and gas on each chain.
  * The MCP signs locally; THIS bot never sees a private key. It only sees the
    public JSON-RPC tool surface.

Run:
    pip install "mcp>=1.0" "anthropic>=0.40"
    export ANTHROPIC_API_KEY=sk-ant-...
    python examples/api-bot.py "What wallet addresses do you have, and are you authed?"

Requires a local clone built via `npm install` (the prepare script builds to
dist/) and Node 20+ on PATH. Edit STARLING_BIN below to point at YOUR clone.
"""
from __future__ import annotations

import asyncio
import json
import os
import sys

import anthropic
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

# Model id is current as of this example; bump freely.
MODEL = "claude-sonnet-4-5"

# How we launch the Starling MCP. This is the SAME command your mcp.json uses —
# `node <clone>/dist/bin/starling-mcp.js` runs the MCP you built locally with
# `npm install`. Point STARLING_BIN at YOUR clone (or set it in the env).
STARLING_BIN = os.environ.get(
    "STARLING_BIN", "/ABSOLUTE/PATH/TO/Starling-MCP/dist/bin/starling-mcp.js"
)
SERVER = StdioServerParameters(
    command="node",
    args=[STARLING_BIN],
    env={
        **os.environ,
        "STARLING_KEY_SOURCE": os.environ.get("STARLING_KEY_SOURCE", "auto"),
        "STARLING_NETWORK": os.environ.get("STARLING_NETWORK", "testnet"),
    },
)


def to_anthropic_tools(mcp_tools) -> list[dict]:
    """Map MCP tool defs -> Anthropic tool-use schema."""
    return [
        {
            "name": t.name,
            "description": t.description or "",
            "input_schema": t.inputSchema or {"type": "object", "properties": {}},
        }
        for t in mcp_tools
    ]


async def run(user_prompt: str) -> None:
    client = anthropic.Anthropic()  # reads ANTHROPIC_API_KEY

    async with stdio_client(SERVER) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()

            listed = await session.list_tools()
            tools = to_anthropic_tools(listed.tools)
            print(f"[bot] Starling exposes {len(tools)} tools: "
                  f"{', '.join(t['name'] for t in tools)}", file=sys.stderr)

            messages: list[dict] = [{"role": "user", "content": user_prompt}]

            # Agent loop: keep going until the model stops asking for tools.
            for _ in range(8):  # hard cap so a confused model can't spin forever
                resp = client.messages.create(
                    model=MODEL,
                    max_tokens=1024,
                    system=(
                        "You are a trading-ops agent. You can only act through the "
                        "Starling MCP tools provided. Never invent results — call a "
                        "tool to find out. This account is on testnet."
                    ),
                    tools=tools,
                    messages=messages,
                )

                # Surface any prose the model emitted this turn.
                for block in resp.content:
                    if block.type == "text":
                        print(block.text)

                if resp.stop_reason != "tool_use":
                    return  # model is done

                # Execute every tool the model asked for, collect results.
                tool_results = []
                for block in resp.content:
                    if block.type != "tool_use":
                        continue
                    print(f"[bot] -> {block.name}({json.dumps(block.input)})",
                          file=sys.stderr)
                    result = await session.call_tool(block.name, block.input or {})
                    # MCP returns content blocks; flatten the text for the model.
                    text = "".join(
                        c.text for c in result.content if getattr(c, "type", "") == "text"
                    )
                    tool_results.append({
                        "type": "tool_result",
                        "tool_use_id": block.id,
                        "content": text or "(no output)",
                        "is_error": bool(getattr(result, "isError", False)),
                    })

                messages.append({"role": "assistant", "content": resp.content})
                messages.append({"role": "user", "content": tool_results})

            print("[bot] stopped: hit the tool-call cap", file=sys.stderr)


if __name__ == "__main__":
    prompt = " ".join(sys.argv[1:]) or (
        "Run auth_check and get_wallet_addresses, then tell me in one line which "
        "venues have a loaded signer and what their addresses are."
    )
    asyncio.run(run(prompt))
