#!/usr/bin/env bash
# One-time setup of the CaCi family test service on a Raspberry Pi (R-010). Run as root: sudo bash deploy/install.sh
# (or from a first checkout). Safe to run again: it creates what is missing, updates the systemd units from the
# checkout, and never overwrites the settings file or any data. Nothing is downloaded and run; nothing is started.
set -euo pipefail
umask 022

APP_USER=caci
APP_HOME=/opt/caci
APP_DIR=/opt/caci/app
DATA_DIR=/var/lib/caci
ENV_DIR=/etc/caci
ENV_FILE=/etc/caci/caci.env
BACKUP_DIR=/var/backups/caci
UNIT_DIR=/etc/systemd/system
DEFAULT_REPO=https://github.com/andymonis/caci.git
UNITS=(caci.service caci-backup.service caci-backup.timer)
# Tests point every path at a scratch folder with this, and stand in for root; a real run sets neither.
ROOT="${CACI_INSTALL_ROOT:-}"

DRY=0
REPO="$DEFAULT_REPO"
DEPLOY_KEY=""

usage() {
  cat <<'USAGE'
Usage: sudo bash deploy/install.sh [--dry-run] [--repo URL] [--deploy-key FILE]

  --dry-run         print what would be done and change nothing
  --repo URL        the git repository to clone (default: the project's GitHub address)
  --deploy-key FILE a read-only deploy key (private key file) to copy for the service account, for a private repository
USAGE
}

say() { printf '%s\n' "$*"; }
fail() { printf 'install: %s\n' "$*" >&2; exit 1; }
bad_usage() { printf 'install: %s\n' "$*" >&2; usage >&2; exit 2; }
p() { printf '%s%s' "$ROOT" "$1"; }
act() {
  if [ "$DRY" = 1 ]; then say "would: $*"; else "$@"; fi
}
as_app() { act runuser -u "$APP_USER" -- "$@"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY=1 ;;
    --help | -h) usage; exit 0 ;;
    --repo)
      [ $# -ge 2 ] || bad_usage "--repo needs a value"
      REPO="$2"; shift
      case "$REPO" in -* | *[[:space:]]* | "") bad_usage "that repository address is not acceptable" ;; esac
      ;;
    --deploy-key)
      [ $# -ge 2 ] || bad_usage "--deploy-key needs a file"
      DEPLOY_KEY="$2"; shift
      [ -f "$DEPLOY_KEY" ] || bad_usage "the deploy key file does not exist"
      ;;
    *) bad_usage "unknown argument: $1" ;;
  esac
  shift
done

# Checks that change nothing.
if [ "$DRY" = 0 ] && [ -z "${CACI_INSTALL_ASSUME_ROOT:-}" ] && [ "$(id -u)" != 0 ]; then
  fail "run this as root (sudo bash deploy/install.sh); use --dry-run to see the plan without root"
fi
for tool in git install cmp systemctl runuser useradd getent node; do
  command -v "$tool" >/dev/null 2>&1 || fail "$tool is needed and was not found"
done
node -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 22 || (a === 22 && b >= 13) ? 0 : 1)' \
  || fail "Node 22.13 or later is needed (node:sqlite); found $(node --version)"

say "CaCi install${ROOT:+ (under $ROOT)}$([ "$DRY" = 1 ] && printf ' (dry run)')"

# 1. The service account: no login, no password.
if getent passwd "$APP_USER" >/dev/null 2>&1; then
  say "ok: the account $APP_USER exists"
else
  act useradd --system --user-group --home-dir "$APP_HOME" --shell /usr/sbin/nologin "$APP_USER"
fi

# 2. Folders and their modes.
act install -d -m 0755 -o "$APP_USER" -g "$APP_USER" "$(p "$APP_HOME")"
act install -d -m 0700 -o "$APP_USER" -g "$APP_USER" "$(p "$DATA_DIR")"
act install -d -m 0700 -o "$APP_USER" -g "$APP_USER" "$(p "$BACKUP_DIR")"
act install -d -m 0750 -o root -g "$APP_USER" "$(p "$ENV_DIR")"

# 3. A deploy key for a private repository, copied once and never overwritten.
KEY_TARGET="$APP_HOME/.ssh/deploy_key"
if [ -n "$DEPLOY_KEY" ]; then
  act install -d -m 0700 -o "$APP_USER" -g "$APP_USER" "$(p "$APP_HOME/.ssh")"
  if [ -e "$(p "$KEY_TARGET")" ]; then
    say "ok: a deploy key is already in place (not replaced)"
  else
    act install -m 0600 -o "$APP_USER" -g "$APP_USER" "$DEPLOY_KEY" "$(p "$KEY_TARGET")"
  fi
fi

# 4. The checkout, cloned once as the service account.
if [ -d "$(p "$APP_DIR")/.git" ]; then
  say "ok: the checkout exists at $APP_DIR"
else
  as_app git clone "$REPO" "$(p "$APP_DIR")"
fi
if [ -n "$DEPLOY_KEY" ]; then
  as_app git -C "$(p "$APP_DIR")" config core.sshCommand "ssh -i $KEY_TARGET -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new"
fi

# 5. The systemd units, from the checkout: installed or updated, reloaded only if something changed.
act install -d -m 0755 -o root -g root "$(p "$UNIT_DIR")"
CHANGED=0
for unit in "${UNITS[@]}"; do
  source_file="$(p "$APP_DIR")/deploy/$unit"
  target_file="$(p "$UNIT_DIR")/$unit"
  if [ "$DRY" = 1 ] && [ ! -f "$source_file" ]; then
    say "would: install the unit $unit from the checkout"
  elif [ ! -f "$source_file" ]; then
    fail "the checkout has no deploy/$unit"
  elif [ -f "$target_file" ] && cmp -s "$source_file" "$target_file"; then
    say "ok: $unit is up to date"
  else
    act install -m 0644 -o root -g root "$source_file" "$target_file"
    CHANGED=1
  fi
done
if [ "$CHANGED" = 1 ] || [ "$DRY" = 1 ]; then act systemctl daemon-reload; fi

# 6. The settings file, from the example, only if there is none. It holds the Anthropic key, so it is never overwritten.
if [ -e "$(p "$ENV_FILE")" ]; then
  say "ok: $ENV_FILE exists (not touched)"
else
  act install -m 0640 -o root -g "$APP_USER" "$(p "$APP_DIR")/deploy/caci.env.example" "$(p "$ENV_FILE")"
fi

# 7. Start at boot (not now: the settings and the key have to be filled in first).
for unit in caci.service caci-backup.timer; do
  if systemctl is-enabled --quiet "$unit" 2>/dev/null; then
    say "ok: $unit is enabled"
  else
    act systemctl enable "$unit"
  fi
done

cat <<NEXT

Done. What is left, by hand:
  1. Edit $ENV_FILE: set ANTHROPIC_API_KEY, and CACI_ALLOWED_HOSTS to the exact names and addresses the family will type.
  2. Build once and start:  sudo -u $APP_USER sh -c 'cd $APP_DIR && npm ci && npm run build'  then  sudo systemctl start caci
  3. Check it:  sudo -u $APP_USER sh -c 'cd $APP_DIR && npm run doctor'
  4. Register yourself first (the first account is the administrator), then the family.
  5. Start the nightly snapshot timer:  sudo systemctl start caci-backup.timer
Later updates: sudo node $APP_DIR/deploy/run.mjs
NEXT
