#!/usr/bin/env bash
# Install or update the recorder and dashboard on an always-on Linux host.
#
#   OWLET_HOST=root@my-server ./box/deploy.sh
#
# Settings (environment):
#   OWLET_HOST           required. SSH destination that logs in as root.
#   OWLET_TIMEZONE       IANA zone that defines a night. Default: UTC.
#   SERVE_PORT           if set, publish the dashboard to your tailnet with
#                        `tailscale serve --http=$SERVE_PORT`. Otherwise it stays
#                        on the host's loopback and you reach it over SSH.
#   OWLET_ALLOWED_HOSTS  extra comma-separated names the dashboard is opened by.
#                        The host's tailnet name and IPs are added automatically
#                        when SERVE_PORT is set.
#   OWLET_URL            if set, the served pages are verified at this base URL.
#
# Deploys the committed HEAD, not uncommitted edits. Idempotent: safe to re-run.
# Creates a dedicated `owlet` user (nologin, 0700 home) and two systemd units
# that run as it. Nothing runs as root and nothing binds a public address.
# Expand these script-owned, validated values locally in remote commands.
# shellcheck disable=SC2029,SC2087
set -euo pipefail

BOX=${OWLET_HOST:?set OWLET_HOST to an SSH destination, e.g. root@my-server}
APP=owlet
REMOTE=/home/$APP/owlet-recorder
DATA=/home/$APP/owlet-data
SECRETS=/home/$APP/secrets
PORT=8400
TIMEZONE=${OWLET_TIMEZONE:-UTC}
SERVE_PORT=${SERVE_PORT:-}
ALLOWED=${OWLET_ALLOWED_HOSTS:-}
ROLLBACK_ROOT=/home/$APP/ui-rollbacks
URL=${OWLET_URL:-}
# Pinned installer, checked before it runs.
UV_INSTALLER=https://astral.sh/uv/0.8.22/install.sh
UV_INSTALLER_SHA256=f1ac30b1849f90b17ca93a9c2d40f74d7ad79cf57ad5a179bc5c9948848a70cd

fail(){ echo "deploy: $*" >&2; exit 1; }
say(){ printf '\n=== %s\n' "$*"; }

# Every value below reaches a root shell on the host, so check it here first.
[[ "$BOX" =~ ^[A-Za-z0-9_.@:-]+$ && "$BOX" != -* ]] ||
  fail "OWLET_HOST must be a plain SSH destination such as root@my-server"
[[ "$TIMEZONE" =~ ^[A-Za-z0-9_+-]+(/[A-Za-z0-9_+-]+)*$ ]] ||
  fail "OWLET_TIMEZONE must be an IANA name such as Europe/Paris"
if command -v python3 >/dev/null; then
  python3 -c 'import sys, zoneinfo; zoneinfo.ZoneInfo(sys.argv[1])' "$TIMEZONE" 2>/dev/null ||
    fail "unknown time zone: $TIMEZONE"
fi
[[ -z "$SERVE_PORT" || ( "$SERVE_PORT" =~ ^[1-9][0-9]{0,4}$ && "$SERVE_PORT" -le 65535 ) ]] ||
  fail "SERVE_PORT must be a port number"
[[ "$ALLOWED" =~ ^[A-Za-z0-9.:,_-]*$ ]] ||
  fail "OWLET_ALLOWED_HOSTS must be comma-separated host names or addresses"

here=$(cd "$(dirname "$0")/.." && pwd)
test -f "$here/.owlet_tokens" || fail "no .owlet_tokens here; run probe.py first"

# Ship exactly what git tracks, so stray local files (token backups, databases)
# never leave this machine.
stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
git -C "$here" archive HEAD | tar -x -C "$stage"
if [[ -n "$(git -C "$here" status --porcelain --untracked-files=no)" ]]; then
  echo "Note: uncommitted changes are not deployed; deploying HEAD $(git -C "$here" rev-parse --short HEAD)."
fi

# shellcheck source=box/ui-assets.sh
source "$stage/box/ui-assets.sh"
validate_ui_assets "$stage/box"

say "Checking we can reach $BOX"
ssh "$BOX" true

say "Creating the $APP user (nologin, 0700 home, own group)"
ssh "$BOX" bash -euo pipefail <<REMOTE_EOF
id -u $APP >/dev/null 2>&1 || useradd --create-home --shell /usr/sbin/nologin $APP
chmod 700 /home/$APP
mkdir -p $DATA $SECRETS
chmod 700 $DATA $SECRETS
chown -R $APP:$APP /home/$APP
REMOTE_EOF

say "Installing uv $UV_INSTALLER for $APP (checksum verified; no system Python packages)"
ssh "$BOX" "runuser -u $APP -- sh -euc 'test -x /home/$APP/.local/bin/uv && exit 0; f=\$(mktemp); curl -LsSf $UV_INSTALLER -o \"\$f\"; echo \"$UV_INSTALLER_SHA256  \$f\" | sha256sum -c --quiet; sh \"\$f\"; rm -f \"\$f\"'"

rollback_id=$(date -u +%Y%m%dT%H%M%SZ)
rollback_dir=$ROLLBACK_ROOT/$rollback_id
printf -v asset_args ' box/%q' "${UI_ASSETS[@]}"
ssh "$BOX" "if test -f '$REMOTE/server.py'; then mkdir -p '$rollback_dir' && cd '$REMOTE' && { tar -czf '$rollback_dir/web.tar.gz' server.py \$(for f in$asset_args; do test -f \"\$f\" && printf '%s ' \"\$f\"; done); } && sha256sum '$rollback_dir/web.tar.gz' > '$rollback_dir/SHA256SUMS'; fi"

# Token and settings go first, so new code never starts without them.
if [[ -n "$SERVE_PORT" ]]; then
  # The dashboard only answers names it expects (DNS-rebinding protection).
  tailnet=$(ssh "$BOX" "tailscale status --json 2>/dev/null | python3 -c 'import json, sys; s = json.load(sys.stdin)[\"Self\"]; d = s[\"DNSName\"].rstrip(\".\"); print(\",\".join([d, d.split(\".\")[0]] + s.get(\"TailscaleIPs\", [])))'" || true)
  [[ "$tailnet" =~ ^[A-Za-z0-9.:,_-]*$ ]] || fail "unexpected tailnet names from the host"
  ALLOWED=${ALLOWED:+$ALLOWED,}$tailnet
fi

say "Delivering Owlet tokens and settings (0600; your password never leaves this machine)"
# Sent on stdin and renamed into place, so it is never briefly missing or
# readable, and no rsync-version-specific options are needed.
ssh "$BOX" "umask 077 && cat > $SECRETS/owlet_tokens.new && chown $APP:$APP $SECRETS/owlet_tokens.new && mv -f $SECRETS/owlet_tokens.new $SECRETS/owlet_tokens" < "$here/.owlet_tokens"
# Values were validated above; they travel on stdin, not through a remote shell.
ssh "$BOX" "cat > /home/$APP/owlet.env" <<ENV_EOF
OWLET_TIMEZONE=$TIMEZONE
OWLET_TOKENS=$SECRETS/owlet_tokens
OWLET_ALLOWED_HOSTS=$ALLOWED
ENV_EOF
ssh "$BOX" "chown $APP:$APP /home/$APP/owlet.env && chmod 600 /home/$APP/owlet.env"

say "Delivering code (HEAD $(git -C "$here" rev-parse --short HEAD))"
rsync -a --delete \
  --exclude '.venv' --exclude '__pycache__' \
  --exclude 'tests' --exclude 'scripts' --exclude 'docs' --exclude '/box/' \
  "$stage/" "$BOX:$REMOTE/"
# The same manifest serves both fresh installs and appearance updates.
ssh "$BOX" "mkdir -p '$REMOTE/box'"
for asset in "${UI_ASSETS[@]}"; do
  rsync -a "$stage/box/$asset" "$BOX:$REMOTE/box/"
done
# Older installs kept the token beside the code (it now lives in $SECRETS) and
# shipped folders the host does not need; --delete leaves excluded paths alone.
ssh "$BOX" "rm -f $REMOTE/.owlet_tokens && rm -rf $REMOTE/docs $REMOTE/scripts $REMOTE/tests && chown -R $APP:$APP $REMOTE"

say "Resolving dependencies (locked)"
ssh "$BOX" "runuser -u $APP -- sh -c 'cd $REMOTE && /home/$APP/.local/bin/uv sync --locked'"

say "Installing units"
scp "$stage/box/owlet-recorder.service" "$stage/box/owlet-web.service" "$BOX:/etc/systemd/system/"
ssh "$BOX" "systemctl daemon-reload && systemctl enable owlet-recorder owlet-web && systemctl restart owlet-recorder owlet-web"

say "Waiting for a first sample"
sleep 20
local_sum=$(sha256_file "$stage/server.py")
health=$(ssh "$BOX" "curl -sS --max-time 10 http://127.0.0.1:$PORT/healthz") || {
  echo "health check failed; recent logs:" >&2
  ssh "$BOX" "journalctl -u owlet-recorder -u owlet-web -n 40 --no-pager" >&2
  exit 1
}
loaded_sum=$(printf '%s\n' "$health" | health_web_revision)
if [[ "$loaded_sum" != "$local_sum" ]]; then
  echo "Loaded web revision differs from the deployed server.py." >&2
  echo "  expected: $local_sum" >&2
  echo "  loaded:   ${loaded_sum:-missing from /healthz}" >&2
  exit 1
fi

if [[ -n "$SERVE_PORT" ]]; then
  say "Publishing on the tailnet at port $SERVE_PORT (tailnet only, never Funnel)"
  ssh "$BOX" "tailscale serve --bg --http=$SERVE_PORT http://127.0.0.1:$PORT && tailscale serve status"
fi

if [[ -n "$URL" ]]; then
  verify_served_ui "$URL" "$stage/box" "$local_sum"
else
  echo "OWLET_URL not set; skipped verifying the served pages."
fi

echo
echo "Deployed. The dashboard listens on $BOX at 127.0.0.1:$PORT."
if [[ -z "$SERVE_PORT" ]]; then
  echo "Reach it with:  ssh -N -L $PORT:127.0.0.1:$PORT $BOX   then open http://127.0.0.1:$PORT/"
fi
echo "Rollback bundle, when a prior install existed: $BOX:$rollback_dir/web.tar.gz"
