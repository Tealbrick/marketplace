#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROGRAM="$ROOT/program"
DATA_DIR="${MARKETPLACE_DATA_DIR:-"$(mktemp -d)"}"

pnpm --dir "$PROGRAM" install --frozen-lockfile
MARKETPLACE_DATA_DIR="$DATA_DIR" pnpm --dir "$PROGRAM" test
MARKETPLACE_DATA_DIR="$DATA_DIR" pnpm --dir "$PROGRAM" typecheck
DOPPELGANGER_DEBUG=1 MARKETPLACE_DATA_DIR="$DATA_DIR" pnpm --dir "$PROGRAM" exec tsx ../smoke/agent-natural-smoke.ts
DOPPELGANGER_DEBUG=1 MARKETPLACE_DATA_DIR="$DATA_DIR" pnpm --dir "$PROGRAM" exec tsx ../smoke/installed-app-home-smoke.ts
