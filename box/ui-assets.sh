#!/usr/bin/env bash
# Shared delivery list. Paths are relative to box/.
UI_ASSETS=(
  live.css
  chart.js
  live.js
  night.js
  recording-context.js
  trends.js
  plotly.min.js
  live.html
  week.html
  trends.html
)

validate_ui_assets() {
  local asset asset_dir=$1 html imported found manifest_asset
  for asset in "${UI_ASSETS[@]}"; do
    if [[ ! -s "$asset_dir/$asset" ]]; then
      echo "Missing or empty UI asset: $asset" >&2
      return 1
    fi
    if [[ "$asset" == *.html ]] && ! grep -q '</html>' "$asset_dir/$asset"; then
      echo "$asset looks truncated" >&2
      return 1
    fi
  done

  # Every local /static import in production HTML must be delivered by the
  # manifest. This catches a new script or stylesheet before a partial UI push.
  for asset in "${UI_ASSETS[@]}"; do
    [[ "$asset" == *.html ]] || continue
    html=$asset_dir/$asset
    while IFS= read -r imported; do
      imported=${imported#/static/}
      [[ -n "$imported" ]] || continue
      if [[ ! -f "$asset_dir/$imported" ]]; then
        echo "Missing local file for $(basename "$html") import: $imported" >&2
        return 1
      fi
      found=false
      for manifest_asset in "${UI_ASSETS[@]}"; do
        if [[ "$manifest_asset" == "$imported" ]]; then
          found=true
          break
        fi
      done
      if [[ "$found" != true ]]; then
        echo "Unlisted UI asset imported by $(basename "$html"): $imported" >&2
        return 1
      fi
    done < <(grep -Eo '/static/[A-Za-z0-9._/-]+' "$html" | sort -u || true)
  done
}


sha256_file() {
  shasum -a 256 "$1" | cut -d' ' -f1
}


health_web_revision() {
  sed -nE 's/.*"web_revision"[[:space:]]*:[[:space:]]*"([0-9a-f]{64})".*/\1/p'
}


verify_loaded_backend() {
  local health_url=$1 expected=$2 health loaded
  # /healthz returns 503 for an inactive recorder; the web revision is still
  # valid evidence of the loaded code. Report freshness separately.
  health=$(curl -sS -m 10 "$health_url")
  loaded=$(printf '%s\n' "$health" | health_web_revision)
  if [[ "$loaded" != "$expected" ]]; then
    echo "Loaded web revision differs from local server.py." >&2
    echo "  expected: $expected" >&2
    echo "  loaded:   ${loaded:-missing from /healthz}" >&2
    return 1
  fi
  printf '%s\n' "$health"
}


verify_served_ui() (
  local base_url=$1 asset_dir=$2 expected_revision=$3
  local asset route expected actual headers body tmp_dir
  tmp_dir=$(mktemp -d)
  trap 'rm -rf "$tmp_dir"' EXIT

  verify_loaded_backend "$base_url/healthz" "$expected_revision" >/dev/null
  for asset in "${UI_ASSETS[@]}"; do
    case "$asset" in
      live.html) route=/ ;;
      week.html) route=/week ;;
      trends.html) route=/trends ;;
      *) route=/static/$asset ;;
    esac
    headers="$tmp_dir/headers"
    body="$tmp_dir/body"
    curl -fsS -m 20 -D "$headers" -o "$body" "$base_url$route"
    if ! grep -Eiq '^cache-control:.*(^|[,[:space:]])no-cache([,[:space:]]|$)' "$headers"; then
      echo "Missing Cache-Control: no-cache for $route" >&2
      return 1
    fi
    expected=$(sha256_file "$asset_dir/$asset")
    actual=$(sha256_file "$body")
    if [[ "$actual" != "$expected" ]]; then
      echo "Served hash differs for $route ($asset)." >&2
      echo "  expected: $expected" >&2
      echo "  served:   $actual" >&2
      return 1
    fi
    printf 'verified %-24s %s\n' "$route" "$actual"
  done
)
