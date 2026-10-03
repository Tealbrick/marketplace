"""Marketplace Hermes tool handlers."""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.parse
import urllib.request
from typing import Any


def _json(data: Any) -> str:
    return json.dumps(data, ensure_ascii=False)


def _fail_closed(tool: str, reason: str, **extra: Any) -> str:
    payload = {
        "ok": False,
        "error": "fail_closed",
        "tool": tool,
        "reason": reason,
    }
    payload.update(extra)
    return _json(payload)


def _rules_decision_allows(result: dict[str, Any]) -> bool:
    decision = result.get("decision")
    effect = result.get("effect")
    return (
        result.get("allowed") is True
        or (isinstance(effect, str) and effect.lower() == "allow")
        or (isinstance(decision, str) and decision.lower() in {"allow", "allowed"})
    )


def _rules_decision_denies(result: dict[str, Any]) -> bool:
    decision = result.get("decision")
    effect = result.get("effect")
    return (
        result.get("allowed") is False
        or (isinstance(effect, str) and effect.lower() in {"deny", "denied", "blocked"})
        or (isinstance(decision, str) and decision.lower() in {"deny", "denied", "blocked"})
    )


def _request_url(
    method: str,
    url: str,
    body: dict[str, Any] | None = None,
    *,
    auth_env: str | None = None,
) -> Any:
    headers = {"accept": "application/json"}
    data = None
    if body is not None and method.upper() != "GET":
        data = json.dumps(body).encode("utf-8")
        headers["content-type"] = "application/json"
    if auth_env:
        token = os.environ.get(auth_env, "").strip()
        if token:
            headers["authorization"] = f"Bearer {token}"
    request = urllib.request.Request(url, data=data, method=method.upper(), headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=8) as response:
            text = response.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        text = exc.read().decode("utf-8", errors="replace")
        if exc.code in {404, 501}:
            return {
                "ok": False,
                "error": "program_endpoint_unavailable",
                "status": exc.code,
                "reason": "Marketplace Program endpoint returned not found or not implemented.",
                "body": text,
            }
        return {"ok": False, "error": "http_error", "status": exc.code, "body": text}
    except Exception as exc:
        return {"ok": False, "error": "request_failed", "message": str(exc)}
    if not text.strip():
        return {"ok": True}
    try:
        return json.loads(text)
    except Exception:
        return {"ok": True, "text": text}


def _rules_gate(tool: str, args: dict[str, Any], contract: dict[str, Any]) -> str | None:
    if not contract.get("rules_gate"):
        return None
    posture = str(contract.get("posture", "governed_connector_admin"))
    rules_base = os.environ.get("RULES_BASE_URL", "").strip().rstrip("/")
    if not rules_base:
        return _fail_closed(
            tool,
            "RULES_BASE_URL is required before governed Marketplace tools can run.",
            posture=posture,
            governedCapability=contract.get("governed_capability"),
        )
    payload = {
        "method": "doppelganger.marketplace.tool",
        "params": {
            "tool": tool,
            "posture": posture,
            "governedCapability": contract.get("governed_capability"),
            "actor": {
                "id": os.environ.get("MARKETPLACE_SERVICE_ID", "marketplace-service").strip()
                or "marketplace-service",
                "companyId": os.environ.get("MARKETPLACE_ORGANIZATION_ID", "default").strip()
                or "default",
                "roles": ["service", "marketplace"],
            },
            "target": args.get("target", {}),
            "arguments": args,
        },
    }
    result = _request_url(
        "POST",
        f"{rules_base}/api/rules/gateway/evaluate",
        payload,
        auth_env="RULES_INTERNAL_AUTH_TOKEN",
    )
    if isinstance(result, dict) and result.get("ok") is False:
        return _json(result)
    if isinstance(result, dict):
        if _rules_decision_allows(result):
            return None
        if _rules_decision_denies(result):
            return _fail_closed(tool, "Rules Approvals denied the Marketplace tool call.", decision=result)
    return _fail_closed(tool, "Rules Approvals returned an invalid decision.", decision=result)


def _fill_path(path: str, args: dict[str, Any]) -> tuple[str, dict[str, Any]]:
    remaining = dict(args)
    for key in ("pluginId", "toolName"):
        token = f":{key}"
        if token in path:
            value = remaining.pop(key, None)
            if value is None or str(value).strip() == "":
                raise ValueError(f"{key} is required")
            path = path.replace(token, urllib.parse.quote(str(value), safe=""))
    for synthetic in ("actor", "target"):
        remaining.pop(synthetic, None)
    return path, remaining


def _program_call(tool: str, contract: dict[str, Any], args: dict[str, Any]) -> str:
    denied = _rules_gate(tool, args, contract)
    if denied:
        return denied
    base = os.environ.get("MARKETPLACE_BASE_URL", "").strip().rstrip("/")
    if not base:
        return _fail_closed(tool, "MARKETPLACE_BASE_URL is required.")
    try:
        path, remaining = _fill_path(str(contract["path"]), args)
    except ValueError as exc:
        return _fail_closed(tool, str(exc))
    method = str(contract["method"]).upper()
    url = f"{base}{path}"
    if method == "GET":
        if remaining:
            query = urllib.parse.urlencode(
                {key: value for key, value in remaining.items() if value is not None},
                doseq=True,
            )
            if query:
                url = f"{url}?{query}"
        body = None
    else:
        body = remaining
    return _json(
        _request_url(
            method,
            url,
            body,
            auth_env="MARKETPLACE_INTERNAL_AUTH_TOKEN",
        )
    )


def _object_schema(
    properties: dict[str, Any] | None = None,
    required: list[str] | None = None,
) -> dict[str, Any]:
    return {
        "type": "object",
        "properties": properties or {},
        "required": required or [],
        "additionalProperties": False,
    }


PLUGIN_ID_PROPERTY = {
    "type": "string",
    "description": "Marketplace plugin id, for example github-native.",
}
WORKSPACE_PROPERTY = {
    "type": "string",
    "description": "Workspace slug. Use default unless the operator names another workspace.",
    "default": "default",
}
ACTOR_PROPERTY = {
    "type": "string",
    "description": "Actor id requesting the operation.",
    "default": "agent",
}

TOOL_PARAMETERS: dict[str, dict[str, Any]] = {
    "marketplace_health": _object_schema(),
    "marketplace_status": _object_schema(),
    "marketplace_events": _object_schema(),
    "marketplace_catalog_list": _object_schema(),
    "marketplace_listing_get": _object_schema(
        {
            "pluginId": PLUGIN_ID_PROPERTY,
            "workspaceSlug": WORKSPACE_PROPERTY,
        },
        ["pluginId"],
    ),
    "marketplace_provider_health": _object_schema({"workspaceSlug": WORKSPACE_PROPERTY}),
    "marketplace_plugin_register": _object_schema(
        {
            "pluginId": PLUGIN_ID_PROPERTY,
            "workspaceSlug": WORKSPACE_PROPERTY,
            "actorId": ACTOR_PROPERTY,
        },
        ["pluginId", "workspaceSlug"],
    ),
    "marketplace_plugin_unregister": _object_schema(
        {
            "pluginId": PLUGIN_ID_PROPERTY,
            "workspaceSlug": WORKSPACE_PROPERTY,
            "actorId": ACTOR_PROPERTY,
        },
        ["pluginId", "workspaceSlug"],
    ),
    "marketplace_plugin_install": _object_schema(
        {
            "pluginId": PLUGIN_ID_PROPERTY,
            "workspaceSlug": WORKSPACE_PROPERTY,
            "actorId": ACTOR_PROPERTY,
        },
        ["pluginId", "workspaceSlug"],
    ),
    "marketplace_plugin_uninstall": _object_schema(
        {
            "pluginId": PLUGIN_ID_PROPERTY,
            "workspaceSlug": WORKSPACE_PROPERTY,
            "actorId": ACTOR_PROPERTY,
        },
        ["pluginId", "workspaceSlug"],
    ),
    "marketplace_connection_register": _object_schema(
        {
            "pluginId": PLUGIN_ID_PROPERTY,
            "workspaceSlug": WORKSPACE_PROPERTY,
            "actorId": ACTOR_PROPERTY,
            "provider": {"type": "string", "description": "Connector provider."},
            "backend": {
                "type": "string",
                "enum": ["nango", "activepieces", "composio", "native"],
                "default": "composio",
            },
            "credentialRef": {"type": "string"},
            "toolkit": {"type": "string"},
            "authConfigId": {"type": "string"},
            "callbackUrl": {"type": "string"},
            "callbackBaseUrl": {"type": "string"},
            "userId": {"type": "string"},
            "alias": {"type": "string"},
            "connectionData": {"type": "object"},
        },
        ["pluginId", "workspaceSlug", "provider"],
    ),
    "marketplace_capability_bind": _object_schema(
        {
            "pluginId": PLUGIN_ID_PROPERTY,
            "workspaceSlug": WORKSPACE_PROPERTY,
            "capability": {
                "type": "string",
                "enum": ["connector.observe", "connector.dispatch", "connector.admin"],
            },
            "enabled": {"type": "boolean", "default": True},
        },
        ["pluginId", "workspaceSlug", "capability"],
    ),
    "marketplace_action_bind": _object_schema(
        {
            "pluginId": PLUGIN_ID_PROPERTY,
            "workspaceSlug": WORKSPACE_PROPERTY,
            "actionKey": {
                "type": "string",
                "description": "Action key from the listing, for example github.repositories.list.",
            },
            "enabled": {"type": "boolean", "default": True},
        },
        ["pluginId", "workspaceSlug", "actionKey"],
    ),
    "marketplace_plugin_execute": _object_schema(
        {
            "pluginId": PLUGIN_ID_PROPERTY,
            "workspaceSlug": WORKSPACE_PROPERTY,
            "actorId": ACTOR_PROPERTY,
            "capability": {
                "type": "string",
                "enum": ["connector.observe", "connector.dispatch", "connector.admin"],
                "description": "Required connector capability for this action.",
            },
            "action": {
                "type": "object",
                "description": "Action payload. Must include type, for example {\"type\":\"github.repositories.list\"}.",
            },
            "runId": {"type": "string"},
            "sessionId": {"type": "string"},
        },
        ["pluginId", "workspaceSlug", "capability", "action"],
    ),
    "marketplace_agent_capabilities": _object_schema(
        {"workspaceSlug": WORKSPACE_PROPERTY},
        [],
    ),
    "marketplace_audit_list": _object_schema(
        {
            "workspaceSlug": WORKSPACE_PROPERTY,
            "pluginId": PLUGIN_ID_PROPERTY,
            "provider": {"type": "string"},
            "limit": {"type": "integer", "minimum": 1, "maximum": 500},
        }
    ),
    "marketplace_debug_events": _object_schema(
        {
            "workspaceSlug": WORKSPACE_PROPERTY,
            "pluginId": PLUGIN_ID_PROPERTY,
            "provider": {"type": "string"},
            "limit": {"type": "integer", "minimum": 1, "maximum": 500},
        }
    ),
    "marketplace_debug_logs": _object_schema(
        {"tail": {"type": "integer", "minimum": 1, "maximum": 500}}
    ),
    "marketplace_activepieces_catalog": _object_schema(),
    "marketplace_agent_tool_call": _object_schema(
        {
            "toolName": {
                "type": "string",
                "description": "Agent capability tool name, for example marketplace.github.repositories.list.",
            },
            "pluginId": PLUGIN_ID_PROPERTY,
            "workspaceSlug": WORKSPACE_PROPERTY,
            "actorId": ACTOR_PROPERTY,
            "input": {
                "type": "object",
                "description": "Tool-specific input object.",
                "default": {},
            },
        },
        ["toolName", "pluginId", "workspaceSlug"],
    ),
    "marketplace_activepieces_scaffold": _object_schema(
        {
            "workspaceSlug": WORKSPACE_PROPERTY,
            "actorId": ACTOR_PROPERTY,
            "pieceName": {"type": "string"},
            "packId": {"type": "string"},
        },
        ["workspaceSlug"],
    ),
    "marketplace_composio_import": _object_schema(
        {
            "workspaceSlug": WORKSPACE_PROPERTY,
            "actorId": ACTOR_PROPERTY,
            "toolkit": {"type": "string"},
            "pluginId": PLUGIN_ID_PROPERTY,
            "displayName": {"type": "string"},
            "description": {"type": "string"},
            "actionKeys": {"type": "array", "items": {"type": "string"}},
            "autoEnable": {"type": "boolean", "default": True},
        },
        ["workspaceSlug", "toolkit"],
    ),
    "marketplace_composio_tools": _object_schema(
        {
            "toolkit": {
                "type": "string",
                "description": "Composio toolkit slug, for example gmail.",
            },
            "limit": {"type": "integer", "minimum": 1, "maximum": 250},
        },
        ["toolkit"],
    ),
    "marketplace_composio_catalog": _object_schema(),
}


def _schema(name: str, description: str) -> dict[str, Any]:
    return {
        "name": name,
        "description": description,
        "parameters": TOOL_PARAMETERS[name],
    }


CONTRACTS: dict[str, dict[str, Any]] = {
    "marketplace_health": {"method": "GET", "path": "/healthz"},
    "marketplace_status": {"method": "GET", "path": "/api/status"},
    "marketplace_events": {"method": "GET", "path": "/events"},
    "marketplace_catalog_list": {"method": "GET", "path": "/api/marketplace/catalog"},
    "marketplace_listing_get": {"method": "GET", "path": "/api/marketplace/plugins/:pluginId"},
    "marketplace_plugin_register": {
        "method": "POST",
        "path": "/api/marketplace/plugins/:pluginId/register",
        "rules_gate": True,
        "governed_capability": "connector.admin",
        "posture": "governed_connector_admin",
    },
    "marketplace_plugin_unregister": {
        "method": "POST",
        "path": "/api/marketplace/plugins/:pluginId/unregister",
        "rules_gate": True,
        "governed_capability": "connector.admin",
        "posture": "governed_connector_admin",
    },
    "marketplace_plugin_install": {
        "method": "POST",
        "path": "/api/marketplace/plugins/:pluginId/install",
        "rules_gate": True,
        "governed_capability": "connector.admin",
        "posture": "governed_connector_admin",
    },
    "marketplace_plugin_uninstall": {
        "method": "POST",
        "path": "/api/marketplace/plugins/:pluginId/uninstall",
        "rules_gate": True,
        "governed_capability": "connector.admin",
        "posture": "governed_connector_admin",
    },
    "marketplace_provider_health": {"method": "GET", "path": "/api/marketplace/provider-health"},
    "marketplace_connection_register": {
        "method": "POST",
        "path": "/api/marketplace/plugins/:pluginId/connection",
        "rules_gate": True,
        "governed_capability": "connector.admin",
        "posture": "governed_connection_setup",
    },
    "marketplace_capability_bind": {
        "method": "POST",
        "path": "/api/marketplace/plugins/:pluginId/capability-binding",
        "rules_gate": True,
        "governed_capability": "connector.admin",
        "posture": "governed_connector_admin",
    },
    "marketplace_action_bind": {
        "method": "POST",
        "path": "/api/marketplace/plugins/:pluginId/action-binding",
        "rules_gate": True,
        "governed_capability": "connector.admin",
        "posture": "governed_connector_admin",
    },
    "marketplace_plugin_execute": {
        "method": "POST",
        "path": "/api/marketplace/plugins/:pluginId/execute",
        "rules_gate": True,
        "governed_capability": "request.capability",
        "posture": "governed_connector_execution",
    },
    "marketplace_agent_capabilities": {"method": "GET", "path": "/api/agent/capabilities"},
    "marketplace_agent_tool_call": {"method": "POST", "path": "/api/agent/tools/:toolName"},
    "marketplace_audit_list": {"method": "GET", "path": "/api/marketplace/audit"},
    "marketplace_debug_events": {"method": "GET", "path": "/api/debug/events"},
    "marketplace_debug_logs": {"method": "GET", "path": "/api/debug/logs"},
    "marketplace_activepieces_catalog": {"method": "GET", "path": "/api/marketplace/catalog/activepieces"},
    "marketplace_activepieces_scaffold": {
        "method": "POST",
        "path": "/api/marketplace/catalog/activepieces/scaffold",
        "rules_gate": True,
        "governed_capability": "connector.admin",
        "posture": "governed_connector_admin",
    },
    "marketplace_composio_catalog": {"method": "GET", "path": "/api/marketplace/catalog/composio"},
    "marketplace_composio_tools": {
        "method": "GET",
        "path": "/api/marketplace/catalog/composio/tools",
    },
    "marketplace_composio_import": {
        "method": "POST",
        "path": "/api/marketplace/catalog/composio/import",
        "rules_gate": True,
        "governed_capability": "connector.admin",
        "posture": "governed_connector_admin",
    },
}


def _make_handler(tool: str, contract: dict[str, Any]):
    def _handler(args: dict[str, Any] | None = None, **_kw) -> str:
        return _program_call(tool, contract, args or {})

    return _handler


TOOLS = tuple(
    (
        name,
        _schema(name, f"Call Marketplace Program API tool `{name}`."),
        _make_handler(name, contract),
    )
    for name, contract in CONTRACTS.items()
)
