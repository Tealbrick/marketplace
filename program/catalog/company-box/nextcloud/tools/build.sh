#!/usr/bin/env bash
# Regenerate the vendored Nextcloud files from the pinned inputs:
#   ../sources/{webdav,activity,serverinfo}.json  (hand-authored, from gen-handauthored.py)
#   ../openapi.json                               (merge of inputs/*.json and ../sources/*.json)
# Needs only bash, python3, node and shasum. No network, no absolute paths.
#   ./build.sh          rewrite the vendored files, then print the openapi.json sha256 to pin in ../entry.json
#   ./build.sh --check  build into a temp dir and fail unless the vendored files are byte-identical
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
entry="$here/.."
mode="${1:-write}"

(cd "$here/inputs" && shasum -a 256 -c SHA256SUMS >/dev/null) || { echo "inputs/ do not match inputs/SHA256SUMS" >&2; exit 1; }

if [ "$mode" = "--check" ]; then work="$(mktemp -d)"; trap 'rm -rf "$work"' EXIT; else work="$entry"; fi
mkdir -p "$work/sources"
python3 "$here/gen-handauthored.py" "$work/sources" >/dev/null

args=()
for f in "$here"/inputs/*.json; do args+=("$(basename "$f" .json)=$f"); done
for a in activity serverinfo webdav; do args+=("$a=$work/sources/$a.json"); done
node "$here/merge-ocs.mjs" "$work/openapi.json" "${args[@]}" >/dev/null

if [ "$mode" = "--check" ]; then
  for f in openapi.json sources/activity.json sources/serverinfo.json sources/webdav.json; do
    cmp -s "$work/$f" "$entry/$f" || { echo "$f differs from the vendored file" >&2; exit 1; }
  done
  pinned="$(shasum -a 256 "$work/openapi.json" | cut -d' ' -f1)"
  grep -q "\"sha256\": \"$pinned\"" "$entry/entry.json" || { echo "entry.json does not pin $pinned" >&2; exit 1; }
  echo "ok: vendored files are byte-identical to a fresh build ($pinned)"
else
  echo "openapi.json sha256: $(shasum -a 256 "$entry/openapi.json" | cut -d' ' -f1)"
fi
