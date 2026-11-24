"""Credential-free MCP server; attachment descriptors never leave local scope."""
from __future__ import annotations
import asyncio
import json
import os
import re
from typing import Any
import duckdb
from mcp.server.fastmcp import FastMCP

mcp = FastMCP("dsh-data-sources")
MAX_FRAME_BYTES = 64 * 1024
BROKER_TIMEOUT_SECONDS = 10

async def broker(operation: str, **arguments: Any) -> Any:
    path = os.environ.get("DSH_DATA_SOURCES_BROKER")
    capability = os.environ.get("DSH_DATA_SOURCES_BROKER_CAPABILITY")
    if not path or not capability: raise RuntimeError("data-sources broker is unavailable")
    writer = None
    try:
        if path.startswith("tcp://"):
            host, port = path.removeprefix("tcp://").rsplit(":", 1)
            reader, writer = await asyncio.wait_for(asyncio.open_connection(host, int(port)), BROKER_TIMEOUT_SECONDS)
        else:
            reader, writer = await asyncio.wait_for(asyncio.open_unix_connection(path), BROKER_TIMEOUT_SECONDS)
        frame = json.dumps({"capability": capability, "operation": operation, "arguments": arguments}).encode()
        if len(frame) >= MAX_FRAME_BYTES: raise RuntimeError("data-sources broker request is invalid")
        writer.write(frame + b"\n"); await asyncio.wait_for(writer.drain(), BROKER_TIMEOUT_SECONDS)
        line = await asyncio.wait_for(reader.readline(), BROKER_TIMEOUT_SECONDS)
        if not line or len(line) > MAX_FRAME_BYTES: raise RuntimeError("data-sources broker response is invalid")
        response = json.loads(line)
        if response.get("ok") is not True: raise RuntimeError("data-sources broker rejected the operation")
        return response["result"]
    finally:
        if writer is not None:
            writer.close(); await writer.wait_closed()

RELATION = r"[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*"


def _statement(sql: str, aliases: set[str]) -> str:
    sql = sql.strip()
    # Phase-one grammar intentionally excludes CTEs, subqueries, functions,
    # expressions and comments. Every target is parsed as a three-part relation.
    match = re.fullmatch(
        rf"SELECT\s+[A-Za-z0-9_.*,\s]+\s+FROM\s+({RELATION})(?:\s+JOIN\s+({RELATION})\s+ON\s+[A-Za-z0-9_.=\s]+)*(?:\s+WHERE\s+[A-Za-z0-9_.=\s]+)?(?:\s+ORDER\s+BY\s+[A-Za-z0-9_.,\s]+)?",
        sql, re.I,
    )
    if match is None: raise RuntimeError("data-sources query is not admitted")
    targets = re.findall(rf"\b(?:FROM|JOIN)\s+({RELATION})", sql, re.I)
    if not targets or any(target.split(".", 1)[0] not in aliases for target in targets):
        raise RuntimeError("data-sources query is not admitted")
    return sql


def _limited(statement: str, rows: int) -> str:
    return f"SELECT * FROM ({statement}) AS dsh_scoped_query LIMIT {rows + 1}"

def _dsn(d: dict[str, Any]) -> str:
    secret = json.loads(d["credential"])
    user, password = secret.get("username"), secret.get("password", "")
    if not isinstance(user, str) or not isinstance(password, str): raise RuntimeError("data-sources database is unavailable")
    q = lambda v: str(v).replace("'", "''")
    database_key = "database" if d["kind"] == "mysql" else "dbname"
    return f"host={q(d['host'])} port={int(d['port'])} user={q(user)} password={q(password)} {database_key}={q(d['database'])}"

async def _acquire_database_scope(source_ids: list[str], intent: str, max_rows: int | None = None, max_bytes: int | None = None):
    con = None
    try:
        # Descriptor acquisition, DSN composition and attach are one private
        # region: no driver message can cross the public MCP boundary.
        descriptors = await broker("database.acquire", source_ids=source_ids, intent=intent, max_rows=max_rows, max_bytes=max_bytes)
        con = duckdb.connect()
        for d in descriptors:
            alias = d["queryAlias"]
            if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", alias): raise ValueError()
            extension = "mysql" if d["kind"] == "mysql" else "postgres"
            con.execute(f"INSTALL {extension}; LOAD {extension}")
            con.execute(f"ATTACH '{_dsn(d)}' AS {alias} (TYPE {extension.upper()}, READ_ONLY)")
        yield con, min(d["maxRows"] for d in descriptors), min(d["maxBytes"] for d in descriptors), {d["id"]: d["queryAlias"] for d in descriptors}
    except Exception:
        raise RuntimeError("data-sources database is unavailable") from None
    finally:
        if con is not None: con.close()

def _rows(cursor: Any, rows: int, bytes_: int) -> dict[str, Any]:
    result, size, truncated = [], 0, False
    while True:
        row = cursor.fetchone()
        if row is None: break
        encoded = json.dumps(row, default=str).encode()
        if len(result) >= rows or size + len(encoded) > bytes_:
            truncated = True; break
        result.append(list(row)); size += len(encoded)
    return {"columns": [c[0] for c in cursor.description], "rows": result, "truncated": truncated}

@mcp.tool()
async def source_list() -> Any: return await broker("source_list")
@mcp.tool()
async def source_info(source_id: str) -> Any: return await broker("source_info", source_id=source_id)
@mcp.tool()
async def source_probe(source_id: str) -> Any: return await broker("source_probe", source_id=source_id)
@mcp.tool()
async def data_list(source_id: str, max_rows: int | None = None) -> Any:
    async for con, rows, bytes_, _aliases in _acquire_database_scope([source_id], "list", max_rows=max_rows):
        return _rows(con.execute(f"SELECT table_catalog, table_schema, table_name, table_type FROM information_schema.tables ORDER BY 1,2,3 LIMIT {rows + 1}"), rows, bytes_)
@mcp.tool()
async def data_describe(source_id: str, object_id: str) -> Any:
    if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*", object_id): raise RuntimeError("data-sources object is not admitted")
    async for con, rows, bytes_, aliases in _acquire_database_scope([source_id], "describe"):
        alias = aliases[source_id]
        return _rows(con.execute(f"DESCRIBE {alias}.{object_id}"), rows, bytes_)
@mcp.tool()
async def data_query(source_ids: list[str], sql: str, max_rows: int | None = None, max_bytes: int | None = None) -> Any:
    async for con, rows, bytes_, source_aliases in _acquire_database_scope(source_ids, "query", max_rows, max_bytes):
        return _rows(con.execute(_limited(_statement(sql, set(source_aliases.values())), rows)), rows, bytes_)
@mcp.tool()
async def data_read(source_id: str, object_id: str, max_bytes: int | None = None) -> Any: return await broker("data_read", source_id=source_id, object_id=object_id, max_bytes=max_bytes)
@mcp.tool()
async def file_search(source_id: str, query: str, max_rows: int | None = None) -> Any: return await broker("file_search", source_id=source_id, query=query, max_rows=max_rows)
def main() -> None: mcp.run(transport="stdio")
