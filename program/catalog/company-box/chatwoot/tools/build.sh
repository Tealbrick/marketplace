#!/usr/bin/env bash
# Regenerate ../overlay.json (the real routes missing from the upstream swagger, x-source: code) from the pinned inputs:
#   inputs/routes.rb          config/routes.rb at tag v4.18.0
#   inputs/controllers/**     the controller sources at that tag that a route can resolve to (absent file = not upstream)
#   ../openapi.json           the vendored upstream swagger (pinned in ../entry.json)
# Needs only bash, ruby, python3 and shasum. No network (except --fetch), no absolute paths.
#   ./build.sh           rewrite ../overlay.json, then print its sha256 to pin in ../entry.json
#   ./build.sh --check   build into a temp dir and fail unless ../overlay.json is byte-identical and pinned in ../entry.json
#   ./build.sh --stats   as the default, and print the route/swagger reconciliation counts
#   ./build.sh --fetch   re-download inputs/ from the tag (network), refresh inputs/SHA256SUMS, then rewrite the overlay
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
entry="$here/.."
mode="${1:-write}"
tag="v4.18.0"
raw="https://raw.githubusercontent.com/chatwoot/chatwoot/$tag"

work="$(mktemp -d)"; trap 'rm -rf "$work"' EXIT

sums() { (cd "$here/inputs" && LC_ALL=C find . -type f ! -name SHA256SUMS | LC_ALL=C sort | xargs shasum -a 256 > SHA256SUMS); }

if [ "$mode" = "--fetch" ]; then
  mkdir -p "$here/inputs"
  curl -sSfL -o "$here/inputs/routes.rb" "$raw/config/routes.rb"
  ruby "$here/expand-routes.rb" "$here/inputs/routes.rb" false > "$work/routes.json"
  python3 "$here/gen-overlay.py" "$work/routes.json" "$entry/openapi.json" "$work/none" "$work/ignored.json" --list-candidates > "$work/candidates.txt"
  rm -rf "$here/inputs/controllers"
  while read -r path; do
    mkdir -p "$here/inputs/controllers/$(dirname "$path")"
    curl -sSfL -o "$here/inputs/controllers/$path" "$raw/$path" 2>/dev/null || rm -f "$here/inputs/controllers/$path"
  done < "$work/candidates.txt"
  find "$here/inputs/controllers" -type d -empty -delete
  sums
  mode=write
fi

(cd "$here/inputs" && shasum -a 256 -c SHA256SUMS >/dev/null) || { echo "inputs/ do not match inputs/SHA256SUMS" >&2; exit 1; }
ruby "$here/expand-routes.rb" "$here/inputs/routes.rb" false > "$work/routes.json"
stats=(); [ "$mode" = "--stats" ] && stats=(--stats)
python3 "$here/gen-overlay.py" "$work/routes.json" "$entry/openapi.json" "$here/inputs/controllers" "$work/overlay.json" ${stats[@]+"${stats[@]}"}

if [ "$mode" = "--check" ]; then
  cmp -s "$work/overlay.json" "$entry/overlay.json" || { echo "overlay.json differs from a fresh build" >&2; exit 1; }
  pinned="$(shasum -a 256 "$work/overlay.json" | cut -d' ' -f1)"
  grep -q "\"sha256\": \"$pinned\"" "$entry/entry.json" || { echo "entry.json does not pin $pinned" >&2; exit 1; }
  echo "ok: overlay.json is byte-identical to a fresh build ($pinned)"
else
  cp "$work/overlay.json" "$entry/overlay.json"
  echo "overlay.json sha256: $(shasum -a 256 "$entry/overlay.json" | cut -d' ' -f1)"
fi
