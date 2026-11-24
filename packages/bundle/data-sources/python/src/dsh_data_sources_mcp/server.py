"""Credential-free MCP server; descriptors and database object identities stay private."""
from __future__ import annotations

import asyncio
import json
import os
import re
from dataclasses import dataclass
from secrets import token_urlsafe
from time import monotonic
from typing import Any

import duckdb
from mcp.server.fastmcp import FastMCP

mcp = FastMCP("dsh-data-sources")
MAX_FRAME_BYTES = 64 * 1024
BROKER_TIMEOUT_SECONDS = 10
OBJECT_TTL_SECONDS = 300
OBJECT_REGISTRY_CAPACITY = 4096
RELATION = r"[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*"


@dataclass(frozen=True)
class DatabaseObject:
    source_id: str
    revision: str
    query_alias: str
    schema: str
    table: str
    kind: str
    issued_at: float


class ObjectRegistry:
    """Per-child, bounded proof that an object was returned by data_list."""

    def __init__(self, *, now: Any = monotonic) -> None:
        self._items: dict[str, DatabaseObject] = {}
        self._now = now

    def _purge(self) -> None:
        cutoff = self._now() - OBJECT_TTL_SECONDS
        for token, value in list(self._items.items()):
            if value.issued_at < cutoff:
                del self._items[token]

    def issue(self, *, source_id: str, revision: str, query_alias: str, schema: str, table: str, kind: str) -> str:
        self._purge()
        if len(self._items) >= OBJECT_REGISTRY_CAPACITY:
            oldest = min(self._items, key=lambda token: self._items[token].issued_at)
            del self._items[oldest]
        token = token_urlsafe(24)
        self._items[token] = DatabaseObject(source_id, revision, query_alias, schema.lower(), table.lower(), kind, self._now())
        return token

    def resolve(self, token: str, *, source_id: str, revision: str, query_alias: str) -> DatabaseObject:
        self._purge()
        value = self._items.get(token)
        if value is None or (value.source_id, value.revision, value.query_alias) != (source_id, revision, query_alias):
            raise RuntimeError("data-sources object is not admitted")
        return value

    def require_relations(self, targets: list[tuple[str, str, str]], scopes: dict[str, tuple[str, str]]) -> None:
        self._purge()
        admitted = {
            (value.query_alias, value.schema, value.table, value.revision)
            for value in self._items.values()
        }
        for alias, schema, table in targets:
            scope = scopes.get(alias)
            if scope is None or (alias, schema.lower(), table.lower(), scope[1]) not in admitted:
                raise RuntimeError("data-sources query is not admitted")


objects = ObjectRegistry()


async def broker(operation: str, **arguments: Any) -> Any:
    path = os.environ.get("DSH_DATA_SOURCES_BROKER")
    capability = os.environ.get("DSH_DATA_SOURCES_BROKER_CAPABILITY")
    if not path or not capability:
        raise RuntimeError("data-sources broker is unavailable")
    writer = None
    try:
        if path.startswith("tcp://"):
            host, port = path.removeprefix("tcp://").rsplit(":", 1)
            reader, writer = await asyncio.wait_for(asyncio.open_connection(host, int(port)), BROKER_TIMEOUT_SECONDS)
        else:
            reader, writer = await asyncio.wait_for(asyncio.open_unix_connection(path), BROKER_TIMEOUT_SECONDS)
        frame = json.dumps({"capability": capability, "operation": operation, "arguments": arguments}).encode()
        if len(frame) >= MAX_FRAME_BYTES:
            raise RuntimeError("data-sources broker request is invalid")
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
        if writer is not None:
            writer.close()
            await writer.wait_closed()


def _targets(sql: str) -> list[tuple[str, str, str]]:
    return [tuple(target.split(".")) for target in re.findall(rf"\b(?:FROM|JOIN)\s+({RELATION})", sql, re.I)]


def _statement(sql: str, aliases: set[str]) -> str:
    sql = sql.strip()
    match = re.fullmatch(
        rf"SELECT\s+[A-Za-z0-9_.*,\s]+\s+FROM\s+({RELATION})(?:\s+JOIN\s+({RELATION})\s+ON\s+[A-Za-z0-9_.=\s]+)*(?:\s+WHERE\s+[A-Za-z0-9_.=\s]+)?(?:\s+ORDER\s+BY\s+[A-Za-z0-9_.,\s]+)?",
        sql,
        re.I,
    )
    targets = _targets(sql)
    if match is None or not targets or any(alias not in aliases for alias, _schema, _table in targets):
        raise RuntimeError("data-sources query is not admitted")
    return sql


def _limited(statement: str, rows: int) -> str:
    return f"SELECT * FROM ({statement}) AS dsh_scoped_query LIMIT {rows + 1}"


def _dsn(descriptor: dict[str, Any]) -> str:
    secret = json.loads(descriptor["credential"])
    user, password = secret.get("username"), secret.get("password", "")
    if not isinstance(user, str) or not isinstance(password, str):
        raise RuntimeError("data-sources database is unavailable")
    quote = lambda value: str(value).replace("'", "''")
    database_key = "database" if descriptor["kind"] == "mysql" else "dbname"
    return f"host={quote(descriptor['host'])} port={int(descriptor['port'])} user={quote(user)} password={quote(password)} {database_key}={quote(descriptor['database'])}"


async def _acquire_database_scope(source_ids: list[str], intent: str, max_rows: int | None = None, max_bytes: int | None = None):
    connection = None
    try:
        descriptors = await broker("database.acquire", source_ids=source_ids, intent=intent, max_rows=max_rows, max_bytes=max_bytes)
        connection = duckdb.connect()
        for descriptor in descriptors:
            alias = descriptor["queryAlias"]
            if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", alias):
                raise ValueError()
            extension = "mysql" if descriptor["kind"] == "mysql" else "postgres"
            connection.execute(f"INSTALL {extension}; LOAD {extension}")
            connection.execute(f"ATTACH '{_dsn(descriptor)}' AS {alias} (TYPE {extension.upper()}, READ_ONLY)")
        scopes = {item["queryAlias"]: (item["id"], item["revision"]) for item in descriptors}
        yield connection, min(item["maxRows"] for item in descriptors), min(item["maxBytes"] for item in descriptors), scopes
    except Exception:
        raise RuntimeError("data-sources database is unavailable") from None
    finally:
        if connection is not None:
            connection.close()


def _rows(cursor: Any, rows: int, bytes_: int) -> dict[str, Any]:
    result, size, truncated = [], 0, False
    while True:
        row = cursor.fetchone()
        if row is None:
            break
        encoded = json.dumps(row, default=str).encode()
        if len(result) >= rows or size + len(encoded) > bytes_:
            truncated = True
            break
        result.append(list(row))
        size += len(encoded)
    return {"columns": [column[0] for column in cursor.description], "rows": result, "truncated": truncated}


def _catalog(cursor: Any, source_id: str, revision: str, alias: str, rows: int, bytes_: int) -> dict[str, Any]:
    result, size, truncated = [], 0, False
    while True:
        row = cursor.fetchone()
        if row is None:
            break
        catalog, schema, table, kind = (str(value) for value in row)
        # token_urlsafe(24) is a 32-byte ASCII token; reserve it before minting.
        item = {"catalog": catalog, "schema": schema, "name": table, "kind": kind, "object_id": "x" * 32}
        encoded = json.dumps(item).encode()
        if len(result) >= rows or size + len(encoded) > bytes_:
            truncated = True
            break
        item["object_id"] = objects.issue(source_id=source_id, revision=revision, query_alias=alias, schema=schema, table=table, kind=kind)
        result.append(item)
        size += len(encoded)
    return {"objects": result, "truncated": truncated}


@mcp.tool()
async def source_list() -> Any:
    return await broker("source_list")


@mcp.tool()
async def source_info(source_id: str) -> Any:
    return await broker("source_info", source_id=source_id)


@mcp.tool()
async def source_probe(source_id: str) -> Any:
    return await broker("source_probe", source_id=source_id)


@mcp.tool()
async def data_list(source_id: str, max_rows: int | None = None) -> Any:
    async for connection, rows, bytes_, scopes in _acquire_database_scope([source_id], "list", max_rows=max_rows):
        alias, revision = next((alias, revision) for alias, (id_, revision) in scopes.items() if id_ == source_id)
        cursor = connection.execute(
            f"SELECT table_catalog, table_schema, table_name, table_type FROM information_schema.tables WHERE table_catalog = ? AND table_schema NOT IN ('information_schema', 'pg_catalog') ORDER BY 1,2,3 LIMIT {rows + 1}",
            [alias],
        )
        return _catalog(cursor, source_id, revision, alias, rows, bytes_)


@mcp.tool()
async def data_describe(source_id: str, object_id: str) -> Any:
    async for connection, rows, bytes_, scopes in _acquire_database_scope([source_id], "describe"):
        alias, revision = next((alias, revision) for alias, (id_, revision) in scopes.items() if id_ == source_id)
        object_ = objects.resolve(object_id, source_id=source_id, revision=revision, query_alias=alias)
        cursor = connection.execute(
            f"SELECT column_name, data_type, ordinal_position FROM information_schema.columns WHERE table_catalog = ? AND table_schema = ? AND table_name = ? ORDER BY ordinal_position LIMIT {rows + 1}",
            [alias, object_.schema, object_.table],
        )
        return _rows(cursor, rows, bytes_)


@mcp.tool()
async def data_query(source_ids: list[str], sql: str, max_rows: int | None = None, max_bytes: int | None = None) -> Any:
    async for connection, rows, bytes_, scopes in _acquire_database_scope(source_ids, "query", max_rows, max_bytes):
        statement = _statement(sql, set(scopes))
        objects.require_relations(_targets(statement), scopes)
        return _rows(connection.execute(_limited(statement, rows)), rows, bytes_)


@mcp.tool()
async def data_read(source_id: str, object_id: str, max_bytes: int | None = None) -> Any:
    return await broker("data_read", source_id=source_id, object_id=object_id, max_bytes=max_bytes)


@mcp.tool()
async def file_search(source_id: str, query: str, max_rows: int | None = None) -> Any:
    return await broker("file_search", source_id=source_id, query=query, max_rows=max_rows)


def main() -> None:
    mcp.run(transport="stdio")
