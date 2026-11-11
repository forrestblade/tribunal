#!/usr/bin/env bash
# Installs or updates the bot on a Debian/Ubuntu VM. Run as root (sudo).
#
#   sudo deploy/install.sh            # from a checkout of this repo
#
# First run: installs Node 22, creates the tribunal user, /opt/tribunal and /etc/tribunal/env,
# then stops so you can fill in the token and config. Later runs: pull, build, restart.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
APP_DIR=/opt/tribunal
ENV_FILE=/etc/tribunal/env

if [ "$(id -u)" -ne 0 ]; then
  echo "run with sudo" >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1 || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  echo "installing Node 22"
  apt-get update -qq
  apt-get install -y -qq ca-certificates curl gnupg >/dev/null
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
echo "node $(node --version)"

id tribunal >/dev/null 2>&1 || useradd --system --home-dir "$APP_DIR" --shell /usr/sbin/nologin tribunal

mkdir -p "$APP_DIR" /etc/tribunal
rsync -a --delete --exclude node_modules --exclude dist --exclude data --exclude config.json --exclude .git "$REPO_DIR/" "$APP_DIR/"
mkdir -p "$APP_DIR/data/backups"

cd "$APP_DIR"
npm ci --omit=dev --no-audit --no-fund >/dev/null
npm install --no-save --no-audit --no-fund typescript >/dev/null
npx tsc -p tsconfig.build.json
rm -rf node_modules/typescript
chown -R tribunal:tribunal "$APP_DIR"

install -m 644 deploy/tribunal.service deploy/tribunal-backup.service deploy/tribunal-backup.timer /etc/systemd/system/
systemctl daemon-reload

first_run=0
if [ ! -f "$ENV_FILE" ]; then
  first_run=1
  cat > "$ENV_FILE" <<'EOF'
# Bot token from the Discord Developer Portal. Keep this file root-only.
DISCORD_TOKEN=
# Optional: Cloud Storage bucket name for nightly backups (no gs:// prefix).
BACKUP_BUCKET=
EOF
  chmod 600 "$ENV_FILE"
fi
if [ ! -f "$APP_DIR/config.json" ]; then
  first_run=1
  cp "$APP_DIR/config.example.json" "$APP_DIR/config.json"
  chown tribunal:tribunal "$APP_DIR/config.json"
fi

if [ "$first_run" -eq 1 ]; then
  cat <<EOF

First install done. Now:
  1. Put the bot token in $ENV_FILE
  2. Fill in $APP_DIR/config.json (application id, server id, channel ids, rules)
  3. cd $APP_DIR && sudo -u tribunal env \$(grep -v '^#' $ENV_FILE | xargs) node dist/register.js
  4. sudo systemctl enable --now tribunal tribunal-backup.timer
  5. sudo journalctl -u tribunal -f
EOF
else
  systemctl restart tribunal
  systemctl enable --now tribunal-backup.timer >/dev/null
  sleep 2
  systemctl --no-pager --lines=5 status tribunal || true
fi
