"""Authenticated HDDA Capabilities provider adapter for the Marketplace Program.

The gateway authenticates the operator before this dashboard-plugin router is
entered. This adapter adds the private Program bearer and proxies only the
versioned normalized-record contract. It never writes the gateway registry or
renders a replacement Capabilities tab.
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

try:
    from fastapi import APIRouter, HTTPException, Request
    from fastapi.responses import JSONResponse
except Exception as exc:  # pragma: no cover - gateway import dependency
    raise RuntimeError("marketplace-hub requires FastAPI") from exc


router = APIRouter()


def _program_config() -> tuple[str, str]:
    base_url = os.environ.get("MARKETPLACE_BASE_URL", "").strip().rstrip("/")
    token = os.environ.get("MARKETPLACE_INTERNAL_AUTH_TOKEN", "").strip()
    if not base_url or not token:
        raise HTTPException(
            status_code=503,
            detail="Marketplace Program URL and internal auth token are required.",
        )
    return base_url, token


def _proxy(
    method: str,
    path: str,
    *,
    query: dict[str, str] | None = None,
    body: Any = None,
) -> JSONResponse:
    base_url, token = _program_config()
    url = f"{base_url}{path}"
    if query:
        url = f"{url}?{urllib.parse.urlencode(query)}"
    payload = None if body is None else json.dumps(body).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=payload,
        method=method,
        headers={
            "accept": "application/json",
            "authorization": f"Bearer {token}",
            **({"content-type": "application/json"} if payload is not None else {}),
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=12) as response:
            status = response.status
            raw = response.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        status = exc.code
        raw = exc.read().decode("utf-8", errors="replace")
    except Exception as exc:
        raise HTTPException(
            status_code=502,
            detail=f"Marketplace Program unavailable: {exc}",
        ) from exc
    try:
        data = json.loads(raw) if raw else {"ok": status < 400}
    except json.JSONDecodeError:
        data = {"ok": status < 400, "text": raw}
    return JSONResponse(data, status_code=status)


def _workspace(request: Request) -> dict[str, str]:
    return {"workspaceSlug": request.query_params.get("workspaceSlug", "default")}


@router.get("/records")
def records(request: Request) -> JSONResponse:
    return _proxy("GET", "/api/marketplace/hub/records", query=_workspace(request))


@router.get("/plugins/{plugin_id}")
def plugin(plugin_id: str, request: Request) -> JSONResponse:
    return _proxy(
        "GET",
        f"/api/marketplace/hub/plugins/{urllib.parse.quote(plugin_id, safe='')}",
        query=_workspace(request),
    )


@router.post("/plugins/mcp")
async def create_mcp(request: Request) -> JSONResponse:
    return _proxy("POST", "/api/marketplace/hub/plugins/mcp", body=await request.json())


@router.patch("/plugins/{plugin_id}")
async def update_plugin(plugin_id: str, request: Request) -> JSONResponse:
    return _proxy(
        "PATCH",
        f"/api/marketplace/hub/plugins/{urllib.parse.quote(plugin_id, safe='')}",
        query=_workspace(request),
        body=await request.json(),
    )


@router.delete("/plugins/{plugin_id}")
def delete_plugin(plugin_id: str, request: Request) -> JSONResponse:
    return _proxy(
        "DELETE",
        f"/api/marketplace/hub/plugins/{urllib.parse.quote(plugin_id, safe='')}",
        query=_workspace(request),
    )


@router.post("/plugins/{plugin_id}/lifecycle")
async def lifecycle(plugin_id: str, request: Request) -> JSONResponse:
    return _proxy(
        "POST",
        f"/api/marketplace/hub/plugins/{urllib.parse.quote(plugin_id, safe='')}/lifecycle",
        body=await request.json(),
    )


@router.post("/reconcile")
async def reconcile(request: Request) -> JSONResponse:
    return _proxy("POST", "/api/marketplace/hub/reconcile", body=await request.json())
