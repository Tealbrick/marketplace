"""Teal Brick Marketplace Hermes plugin."""

from __future__ import annotations

from .tools import TOOLS


def register(ctx) -> None:
    """Register Marketplace tools through Hermes PluginContext."""
    for name, schema, handler in TOOLS:
        ctx.register_tool(
            name=name,
            toolset="marketplace",
            schema=schema,
            handler=handler,
        )
