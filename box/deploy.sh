#!/usr/bin/env bash
# Install or update the recorder and dashboard on an always-on Linux host.
#
#   OWLET_HOST=root@my-server ./box/deploy.sh
#
# Settings (environment):
#   OWLET_HOST      required. SSH destination that logs in as root.
#   OWLET_TIMEZONE  IANA zone that defines a night. Default: UTC.
#   SERVE_PORT      if set, publish the dashboard to your tailnet with
#                   `tailscale serve --http=$SERVE_PORT`. Otherwise it stays on
#                   the host's loopback and you reach it over an SSH tunnel.
#   OWLET_URL       if set, the served pages are verified at this base URL.
#
# Idempotent: safe to re-run. Creates a dedicated `owlet` user (nologin, 0700
# home) and two systemd units that run as it. Nothing runs as root and nothing
# binds a public address.
# Expand these script-owned paths locally in remote commands.
# shellcheck disable=SC2029,SC2087
set -euo pipefail

BOX=${OWLET_HOST:?set OWLET_HOST to an SSH destination, e.g. root@my-server}
APP=owlet
REMOTE=/home/$APP/owlet-recorder
DATA=/home/$APP/owlet-data
PORT=8400
TIMEZONE=${OWLET_TIMEZONE:-UTC}
SERVE_PORT=${SERVE_PORT:-}
ROLLBACK_ROOT=/home/$APP/ui-rollbacks
URL=${OWLET_URL:-}

here=$(cd "$(dirname "$0")/.." && pwd)
# shellcheck source=box/ui-assets.sh
source "$here/box/ui-assets.sh"
validate_ui_assets "$here/box"

say(){ printf '\n=== %s\n' "$*"; }

say "Checking we can reach $BOX"
ssh "$BOX" true

say "Creating the $APP user (nologin, 0700 home, own group)"
ssh "$BOX" bash -euo pipefail <<REMOTE_EOF
id -u $APP >/dev/null 2>&1 || useradd --create-home --shell /usr/sbin/nologin $APP
chmod 700 /home/$APP
mkdir -p $DATA
chown -R $APP:$APP /home/$APP
REMOTE_EOF

say "Installing uv for $APP (no system Python packages)"
ssh "$BOX" "runuser -u $APP -- sh -c 'test -x /home/$APP/.local/bin/uv || curl -LsSf https://astral.sh/uv/install.sh | sh'"

rollback_id=$(date -u +%Y%m%dT%H%M%SZ)
rollback_dir=$ROLLBACK_ROOT/$rollback_id
printf -v asset_args ' box/%q' "${UI_ASSETS[@]}"
ssh "$BOX" "if test -f '$REMOTE/server.py'; then mkdir -p '$rollback_dir' && cd '$REMOTE' && { tar -czf '$rollback_dir/web.tar.gz' server.py \$(for f in$asset_args; do test -f \"\$f\" && printf '%s ' \"\$f\"; done); } && sha256sum '$rollback_dir/web.tar.gz' > '$rollback_dir/SHA256SUMS'; fi"

say "Delivering code"
rsync -a --delete \
  --exclude '.venv' --exclude 'data' --exclude '__pycache__' \
  --exclude '*.html' --exclude '.owlet_tokens' --exclude '.env' --exclude '.git' \
  --exclude 'node_modules' \
  --exclude 'tests' --exclude 'test-results' --exclude 'playwright-report' \
  --exclude '/box/' \
  "$here/" "$BOX:$REMOTE/"
# The same manifest serves both fresh installs and appearance updates.
ssh "$BOX" "mkdir -p '$REMOTE/box'"
for asset in "${UI_ASSETS[@]}"; do
  rsync -a "$here/box/$asset" "$BOX:$REMOTE/box/"
done

say "Delivering Owlet tokens (0600; your password never leaves this machine)"
test -f "$here/.owlet_tokens" || { echo "no .owlet_tokens here; run probe.py first" >&2; exit 1; }
rsync -a "$here/.owlet_tokens" "$BOX:$REMOTE/.owlet_tokens"
ssh "$BOX" "printf 'OWLET_TIMEZONE=%s\n' '$TIMEZONE' > /home/$APP/owlet.env"
ssh "$BOX" "chown -R $APP:$APP /home/$APP && chmod 600 $REMOTE/.owlet_tokens /home/$APP/owlet.env"

say "Resolving dependencies"
ssh "$BOX" "runuser -u $APP -- sh -c 'cd $REMOTE && /home/$APP/.local/bin/uv sync'"

say "Installing units"
scp "$here/box/owlet-recorder.service" "$here/box/owlet-web.service" "$BOX:/etc/systemd/system/"
ssh "$BOX" "systemctl daemon-reload && systemctl enable owlet-recorder owlet-web && systemctl restart owlet-recorder owlet-web"

say "Waiting for a first sample"
sleep 20
local_sum=$(sha256_file "$here/server.py")
health=$(ssh "$BOX" "curl -sS --max-time 10 http://127.0.0.1:$PORT/healthz") || {
  echo "health check failed; recent logs:" >&2
  ssh "$BOX" "journalctl -u owlet-recorder -u owlet-web -n 40 --no-pager" >&2
  exit 1
}
loaded_sum=$(printf '%s\n' "$health" | health_web_revision)
if [[ "$loaded_sum" != "$local_sum" ]]; then
  echo "Loaded web revision differs from local server.py." >&2
  echo "  expected: $local_sum" >&2
  echo "  loaded:   ${loaded_sum:-missing from /healthz}" >&2
  exit 1
fi

if [[ -n "$SERVE_PORT" ]]; then
  say "Publishing on the tailnet at port $SERVE_PORT (tailnet only, never Funnel)"
  ssh "$BOX" "tailscale serve --bg --http=$SERVE_PORT http://127.0.0.1:$PORT && tailscale serve status"
fi

if [[ -n "$URL" ]]; then
  verify_served_ui "$URL" "$here/box" "$local_sum"
else
  echo "OWLET_URL not set; skipped verifying the served pages."
fi

echo
echo "Deployed. The dashboard listens on $BOX at 127.0.0.1:$PORT."
if [[ -z "$SERVE_PORT" ]]; then
  echo "Reach it with:  ssh -N -L $PORT:127.0.0.1:$PORT $BOX   then open http://127.0.0.1:$PORT/"
fi
echo "Rollback bundle, when a prior install existed: $BOX:$rollback_dir/web.tar.gz"
