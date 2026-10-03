#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROGRAM_DIR="$(cd "${SCRIPT_DIR}/../program" && pwd)"
RUN_DIR="${MARKETPLACE_DATA_DIR:-$(mktemp -d "${TMPDIR:-/tmp}/marketplace-provider-sidecars.XXXXXX")}"
LOG_FILE="${RUN_DIR}/server.log"

export MARKETPLACE_DATA_DIR="${RUN_DIR}"
export MARKETPLACE_PORT=0
export ACTIVEPIECES_BASE_URL="${ACTIVEPIECES_BASE_URL:?ACTIVEPIECES_BASE_URL must point at a live Activepieces sidecar}"
export NANGO_BASE_URL="${NANGO_BASE_URL:?NANGO_BASE_URL must point at a live Nango sidecar}"

pnpm --dir "${PROGRAM_DIR}" install --frozen-lockfile >/dev/null
pnpm --dir "${PROGRAM_DIR}" exec tsx src/index.ts >"${LOG_FILE}" 2>&1 &
SERVER_PID=$!
trap 'kill "${SERVER_PID}" >/dev/null 2>&1 || true' EXIT

BASE_URL=""
for _ in $(seq 1 120); do
  if [[ -s "${LOG_FILE}" ]]; then
    BASE_URL="$(node -e '
      const fs = require("fs");
      const lines = fs.readFileSync(process.argv[1], "utf8").trim().split(/\n+/).filter(Boolean);
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line);
          if (parsed.baseUrl) {
            console.log(parsed.baseUrl);
            process.exit(0);
          }
        } catch {}
      }
      process.exit(1);
    ' "${LOG_FILE}" 2>/dev/null || true)"
  fi
  if [[ -n "${BASE_URL}" ]]; then
    break
  fi
  sleep 0.1
done

if [[ -z "${BASE_URL}" ]]; then
  echo "Marketplace Program did not print a dynamic listen URL" >&2
  cat "${LOG_FILE}" >&2 || true
  exit 1
fi

node - "${BASE_URL}" <<'NODE'
const baseUrl = process.argv[2];

async function get(route) {
  const response = await fetch(new URL(route, baseUrl), {
    headers: { "x-trace-id": "trace_marketplace_provider_sidecars" },
  });
  const body = await response.json();
  if (!response.ok) {
    throw new Error(`${route} returned ${response.status}: ${JSON.stringify(body, null, 2)}`);
  }
  return body;
}

const health = await get("/api/marketplace/provider-health?workspaceSlug=provider-sidecar-smoke");
if (!health.providers.nango.reachable || health.providers.nango.statusCode !== 200) {
  throw new Error(`Nango health was not reachable: ${JSON.stringify(health.providers.nango, null, 2)}`);
}
if (!health.providers.activepieces.reachable || health.providers.activepieces.statusCode !== 200) {
  throw new Error(`Activepieces health was not reachable: ${JSON.stringify(health.providers.activepieces, null, 2)}`);
}

const catalog = await get("/api/marketplace/catalog/activepieces");
if (!Array.isArray(catalog.items) || catalog.items.length === 0) {
  throw new Error(`Activepieces catalog did not return items: ${JSON.stringify(catalog, null, 2)}`);
}
const github = catalog.items.find((item) => item.name === "@activepieces/piece-github");
if (!github) {
  throw new Error("Activepieces catalog did not expose the GitHub piece");
}

console.log(JSON.stringify({
  ok: true,
  baseUrl,
  nango: {
    baseUrl: health.providers.nango.baseUrl,
    statusCode: health.providers.nango.statusCode,
    reachable: health.providers.nango.reachable,
    configured: health.providers.nango.configured,
  },
  activepieces: {
    baseUrl: health.providers.activepieces.baseUrl,
    statusCode: health.providers.activepieces.statusCode,
    reachable: health.providers.activepieces.reachable,
    configured: health.providers.activepieces.configured,
    catalogItems: catalog.items.length,
    githubPiece: github.displayName,
  },
}, null, 2));
NODE
