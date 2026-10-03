#!/usr/bin/env bash
set -euo pipefail

PLUGIN_NAME="marketplace"
HERMES_PLUGIN_DIR="${1:-${HERMES_PLUGIN_DIR:-${HOME}/.doppelganger/agent/plugins}}"
SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/remote-plugin/${PLUGIN_NAME}" && pwd)"
TARGET_DIR="${HERMES_PLUGIN_DIR}/${PLUGIN_NAME}"
CONFIG_FILE="${HERMES_PLUGIN_DIR}/config.yaml"

if [[ ! -f "${SOURCE_DIR}/plugin.yaml" || ! -f "${SOURCE_DIR}/__init__.py" ]]; then
  echo "Remote Hermes plugin source is incomplete: ${SOURCE_DIR}" >&2
  exit 2
fi

mkdir -p "${HERMES_PLUGIN_DIR}"
TMP_DIR="${TARGET_DIR}.tmp.$$"
rm -rf "${TMP_DIR}"
mkdir -p "${TMP_DIR}"
cp -R "${SOURCE_DIR}/." "${TMP_DIR}/"
rm -rf "${TARGET_DIR}"
mv "${TMP_DIR}" "${TARGET_DIR}"

python3 - "${CONFIG_FILE}" "${PLUGIN_NAME}" <<'PY'
from pathlib import Path
import re
import sys

config_file = Path(sys.argv[1])
plugin_name = sys.argv[2]
config_file.parent.mkdir(parents=True, exist_ok=True)
text = config_file.read_text(encoding="utf-8") if config_file.exists() else ""
if re.search(rf"(?m)^\s*-\s*{re.escape(plugin_name)}\s*$", text):
    raise SystemExit(0)
if not text.strip():
    config_file.write_text(f"plugins:\n  enabled:\n  - {plugin_name}\n", encoding="utf-8")
elif "plugins:" not in text:
    config_file.write_text(text.rstrip() + f"\nplugins:\n  enabled:\n  - {plugin_name}\n", encoding="utf-8")
elif "  enabled:" not in text:
    config_file.write_text(text.rstrip() + f"\n  enabled:\n  - {plugin_name}\n", encoding="utf-8")
else:
    config_file.write_text(text.rstrip() + f"\n  - {plugin_name}\n", encoding="utf-8")
PY

echo "Installed ${PLUGIN_NAME} into ${TARGET_DIR}"
echo "Enabled ${PLUGIN_NAME} in ${CONFIG_FILE}"
