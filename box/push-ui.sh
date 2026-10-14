#!/usr/bin/env bash
# Push dashboard appearance changes to an installed host.
#
#   OWLET_HOST=root@my-server OWLET_URL=http://my-server:8443 ./box/push-ui.sh
#
# server.py serves box/live.html with web.FileResponse on every request, so the
# new file is live as soon as it lands -- no systemd restart, no dropped
# samples. The recorder is never touched. OWLET_URL is where the dashboard is
# reachable from here (a tailnet name, or an SSH tunnel to 127.0.0.1:8400).
set -euo pipefail
BOX=${OWLET_HOST:?set OWLET_HOST to the SSH destination used by deploy.sh}
[[ "$BOX" =~ ^[A-Za-z0-9_.@:-]+$ && "$BOX" != -* ]] ||
  { echo "OWLET_HOST must be a plain SSH destination" >&2; exit 1; }
here=$(cd "$(dirname "$0")/.." && pwd)
URL=${OWLET_URL:?set OWLET_URL to the dashboard base URL}
REMOTE=/home/owlet/owlet-recorder
ROLLBACK_ROOT=/home/owlet/ui-rollbacks

# shellcheck source=box/ui-assets.sh
source "$here/box/ui-assets.sh"
validate_ui_assets "$here/box"

# Compare against the code loaded by the running process. A disk hash alone can
# approve a stale process after server.py was copied without a restart.
local_sum=$(sha256_file "$here/server.py")
before=$(verify_loaded_backend "$URL/healthz" "$local_sum")

rollback_id=$(date -u +%Y%m%dT%H%M%SZ)
rollback_dir=$ROLLBACK_ROOT/$rollback_id
printf -v asset_args ' box/%q' "${UI_ASSETS[@]}"
# Keep rollback data outside REMOTE so deploy.sh --delete cannot remove it.
# Missing assets are expected when a release introduces a new file.
# shellcheck disable=SC2029
ssh "$BOX" "mkdir -p '$rollback_dir' && cd '$REMOTE' && { tar -czf '$rollback_dir/web.tar.gz' server.py \$(for f in$asset_args; do test -f \"\$f\" && printf '%s ' \"\$f\"; done); } && sha256sum '$rollback_dir/web.tar.gz' > '$rollback_dir/SHA256SUMS'"

for f in "${UI_ASSETS[@]}"; do
  rsync -a "$here/box/$f" "$BOX:$REMOTE/box/$f"
  # The asset name comes from the local manifest, not the remote shell.
  # shellcheck disable=SC2029
  ssh "$BOX" "chown owlet:owlet $REMOTE/box/$f"
done

after=$(verify_loaded_backend "$URL/healthz" "$local_sum")
verify_served_ui "$URL" "$here/box" "$local_sum"

echo
echo "recorder:  $before"
echo "        -> $after"
echo "rollback:  $BOX:$rollback_dir/web.tar.gz"
echo
echo "Assets delivered. Recorder was not restarted."
echo "Served routes, asset hashes, cache headers, and the loaded backend revision match."
echo "The copy is not atomic. If it failed before these checks, restore the saved bundle before accepting the release."
