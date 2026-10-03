"""Focused Marketplace Agent adapter tests; no live Program required."""

from __future__ import annotations

import importlib.util
import json
import os
import unittest
from pathlib import Path


TOOLS_PATH = Path(__file__).parents[1] / "remote-plugin" / "marketplace" / "tools.py"
SPEC = importlib.util.spec_from_file_location("marketplace_tools", TOOLS_PATH)
assert SPEC and SPEC.loader
tools = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(tools)


class MarketplaceToolsTest(unittest.TestCase):
    def setUp(self) -> None:
        self.previous_request = tools._request_url
        self.previous_environment = dict(os.environ)
        self.calls: list[tuple[str, str, dict | None]] = []
        os.environ["MARKETPLACE_BASE_URL"] = "https://marketplace.example"

        def fake_request(method: str, url: str, body: dict | None = None, **_kwargs):
            self.calls.append((method, url, body))
            return {"ok": True}

        tools._request_url = fake_request

    def tearDown(self) -> None:
        tools._request_url = self.previous_request
        os.environ.clear()
        os.environ.update(self.previous_environment)

    def test_zero_argument_gets_never_send_a_body(self) -> None:
        health = next(handler for name, _schema, handler in tools.TOOLS if name == "marketplace_health")
        catalog = next(handler for name, _schema, handler in tools.TOOLS if name == "marketplace_catalog_list")

        health({})
        catalog({})

        self.assertEqual(self.calls[0], ("GET", "https://marketplace.example/healthz", None))
        self.assertEqual(self.calls[1], ("GET", "https://marketplace.example/api/marketplace/catalog", None))

    def test_composio_tools_forwards_typed_query(self) -> None:
        handler = next(handler for name, _schema, handler in tools.TOOLS if name == "marketplace_composio_tools")

        result = json.loads(handler({"toolkit": "gmail", "limit": 5}))

        self.assertTrue(result["ok"])
        self.assertEqual(
            self.calls,
            [("GET", "https://marketplace.example/api/marketplace/catalog/composio/tools?toolkit=gmail&limit=5", None)],
        )

    def test_all_tools_publish_closed_typed_schemas(self) -> None:
        schemas = {name: schema["parameters"] for name, schema, _handler in tools.TOOLS}

        self.assertEqual(set(schemas), set(tools.CONTRACTS))
        self.assertTrue(all(schema["additionalProperties"] is False for schema in schemas.values()))
        self.assertEqual(schemas["marketplace_composio_tools"]["required"], ["toolkit"])
        self.assertEqual(
            schemas["marketplace_agent_tool_call"]["required"],
            ["toolName", "pluginId", "workspaceSlug"],
        )


if __name__ == "__main__":
    unittest.main()
