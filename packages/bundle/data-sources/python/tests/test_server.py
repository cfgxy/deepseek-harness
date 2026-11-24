from __future__ import annotations

import asyncio
import json
import os
import tempfile
import unittest
from pathlib import Path

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client


from dsh_data_sources_mcp.server import ObjectRegistry, _statement


class ObjectRegistryTests(unittest.TestCase):
    def test_requires_an_enumerated_current_object_for_describe_and_query(self) -> None:
        clock = [1000.0]
        registry = ObjectRegistry(now=lambda: clock[0])
        token = registry.issue(source_id="sales-db", revision="1", query_alias="src_sales", schema="public", table="orders", kind="BASE TABLE")
        record = registry.resolve(token, source_id="sales-db", revision="1", query_alias="src_sales")
        self.assertEqual(record.table, "orders")
        registry.require_relations([("src_sales", "public", "orders")], {"src_sales": ("sales-db", "1")})
        with self.assertRaisesRegex(RuntimeError, "not admitted"):
            registry.require_relations([("src_sales", "public", "payments")], {"src_sales": ("sales-db", "1")})
        with self.assertRaisesRegex(RuntimeError, "not admitted"):
            registry.resolve(token, source_id="other-db", revision="1", query_alias="src_sales")
        clock[0] += 301
        with self.assertRaisesRegex(RuntimeError, "not admitted"):
            registry.resolve(token, source_id="sales-db", revision="1", query_alias="src_sales")


class QueryAdmissionTests(unittest.TestCase):
    def test_rejects_table_functions_and_unadmitted_relations(self) -> None:
        aliases = {"pg"}
        with self.assertRaisesRegex(RuntimeError, "not admitted"):
            _statement("SELECT * FROM read_csv_auto('secret.csv')", aliases)
        with self.assertRaisesRegex(RuntimeError, "not admitted"):
            _statement("SELECT * FROM pg.public.orders JOIN other.public.payments ON orders.id = payments.id", aliases)

    def test_accepts_only_admitted_three_part_relations(self) -> None:
        self.assertIn("pg.public.orders", _statement("SELECT pg.public.orders.id FROM pg.public.orders", {"pg"}))


class BrokeredMcpTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.directory = tempfile.TemporaryDirectory()
        self.socket = str(Path(self.directory.name) / "broker.sock")
        self.mode = "reject"

        async def handle(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
            frame = await reader.readline()
            message = json.loads(frame)
            if self.mode == "timeout":
                await asyncio.sleep(11)
            elif message.get("capability") == "expected":
                writer.write(b'{"ok":true,"result":{"visible":true}}\n')
            else:
                writer.write(b'{"ok":false}\n')
            await writer.drain()
            writer.close()

        self.server = await asyncio.start_unix_server(handle, self.socket)

    async def asyncTearDown(self) -> None:
        self.server.close()
        await self.server.wait_closed()
        self.directory.cleanup()

    async def call_source_list(self, capability: str):
        environment = dict(os.environ)
        environment.update({"DSH_DATA_SOURCES_BROKER": self.socket, "DSH_DATA_SOURCES_BROKER_CAPABILITY": capability})
        parameters = StdioServerParameters(command="uv", args=["run", "dsh-data-sources-mcp"], env=environment)
        async with stdio_client(parameters) as (read, write):
            async with ClientSession(read, write) as session:
                await session.initialize()
                return await session.call_tool("source_list", {})

    async def test_wrong_capability_becomes_a_generic_mcp_error(self) -> None:
        result = await self.call_source_list("wrong")
        self.assertTrue(result.isError)
        self.assertNotIn("expected", str(result.content))

    async def test_valid_capability_forwards_only_the_admitted_response(self) -> None:
        result = await self.call_source_list("expected")
        self.assertFalse(result.isError)
        self.assertIn("visible", str(result.content))

    async def test_broker_timeout_becomes_a_generic_mcp_error(self) -> None:
        self.mode = "timeout"
        result = await self.call_source_list("expected")
        self.assertTrue(result.isError)
        self.assertNotIn("timeout", str(result.content).lower())
