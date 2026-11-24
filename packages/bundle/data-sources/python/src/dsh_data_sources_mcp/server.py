"""MCP stdio server that never owns source credentials or connection strings."""

from __future__ import annotations

import asyncio
import json
import os
from typing import Any

from mcp.server.fastmcp import FastMCP

mcp = FastMCP("dsh-data-sources")


MAX_FRAME_BYTES = 64 * 1024
BROKER_TIMEOUT_SECONDS = 10


async def broker(operation: str, **arguments: Any) -> Any:
    """Forward one short-lived admitted operation to the Host-private Unix broker.

    The Host validates every operation and resolves credentials only after
    admission. On Windows it selects an authenticated loopback endpoint;
    elsewhere it supplies a mode-0600 Unix socket.
    """
    path = os.environ.get("DSH_DATA_SOURCES_BROKER")
    capability = os.environ.get("DSH_DATA_SOURCES_BROKER_CAPABILITY")
    if not path or not capability:
        raise RuntimeError("data-sources broker is unavailable")
    try:
        if path.startswith("tcp://"):
            host, port = path.removeprefix("tcp://").rsplit(":", 1)
            reader, writer = await asyncio.wait_for(asyncio.open_connection(host, int(port)), BROKER_TIMEOUT_SECONDS)
        else:
            reader, writer = await asyncio.wait_for(asyncio.open_unix_connection(path), BROKER_TIMEOUT_SECONDS)
        frame = json.dumps({"capability": capability, "operation": operation, "arguments": arguments}).encode()
        if len(frame) > MAX_FRAME_BYTES:
            raise RuntimeError("data-sources broker request exceeds the frame limit")
        writer.write(frame + b"\n")
        await asyncio.wait_for(writer.drain(), BROKER_TIMEOUT_SECONDS)
        line = await asyncio.wait_for(reader.readline(), BROKER_TIMEOUT_SECONDS)
        if not line or len(line) > MAX_FRAME_BYTES:
            raise RuntimeError("data-sources broker response is invalid")
        response = json.loads(line)
        if response.get("ok") is not True:
            raise RuntimeError("data-sources broker rejected the operation")
        return response["result"]
    finally:
        if "writer" in locals():
            writer.close()
            await writer.wait_closed()


@mcp.tool()
async def source_list() -> Any:
    """List visible source metadata and capabilities without credentials."""
    return await broker("source_list")


@mcp.tool()
async def source_info(source_id: str) -> Any:
    """Describe one visible source policy and capabilities."""
    return await broker("source_info", source_id=source_id)


@mcp.tool()
async def source_probe(source_id: str) -> Any:
    """Probe one source without returning credentials or provider errors."""
    return await broker("source_probe", source_id=source_id)


@mcp.tool()
async def data_list(source_id: str, object_id: str | None = None, max_rows: int | None = None) -> Any:
    """List admitted catalog or directory objects. Object IDs remain Host-revalidated."""
    return await broker("data_list", source_id=source_id, object_id=object_id, max_rows=max_rows)


@mcp.tool()
async def data_describe(source_id: str, object_id: str) -> Any:
    """Describe an admitted file or table without fetching its full contents."""
    return await broker("data_describe", source_id=source_id, object_id=object_id)


@mcp.tool()
async def data_read(source_id: str, object_id: str, max_bytes: int | None = None) -> Any:
    """Read only a Host-admitted object with a tightened byte budget."""
    return await broker("data_read", source_id=source_id, object_id=object_id, max_bytes=max_bytes)


@mcp.tool()
async def data_query(source_id: str, sql: str, max_rows: int | None = None) -> Any:
    """Run Host-admitted read-only SQL; source IDs may name an admitted federated session."""
    return await broker("data_query", source_id=source_id, sql=sql, max_rows=max_rows)


@mcp.tool()
async def file_search(source_id: str, query: str, max_rows: int | None = None) -> Any:
    """Search file names through a bounded, Host-admitted file adapter."""
    return await broker("file_search", source_id=source_id, query=query, max_rows=max_rows)


def main() -> None:
    mcp.run(transport="stdio")
