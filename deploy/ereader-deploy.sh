#!/usr/bin/env bash
# Update the eReader checkout to origin/main, install dependencies and restart the service.
#
# Runs on the server as the deploy user: by hand, or as the forced command of the SSH key that the
# GitHub Actions workflow (.github/workflows/deploy.yml) uses. See "Deploying on merge" in the README
# for the one-time setup. Settings can be overridden with environment variables:
#   EREADER_DIR      checkout to update            (default /opt/ereader)
#   EREADER_BRANCH   branch to deploy              (default main)
#   EREADER_SERVICE  systemd unit to restart       (default ereader)
#   EREADER_HEALTH   URL that must answer 200      (default http://127.0.0.1:<PORT of the unit>/api/health)
set -euo pipefail

# Dependencies are reinstalled unless node_modules was installed from exactly the current lockfile.
# A stamp with the lockfile's hash records that; npm ci empties node_modules, so a failed or manual
# install leaves no stamp behind and the next deploy installs again.
STAMP=node_modules/.deploy-lockfile

main() {
  local dir=${EREADER_DIR:-/opt/ereader}
  local branch=${EREADER_BRANCH:-main}
  local service=${EREADER_SERVICE:-ereader}
  local health=${EREADER_HEALTH:-http://127.0.0.1:$(service_port "$service")/api/health}

  cd "$dir"
  git fetch --quiet origin "$branch"
  local before after
  before=$(git rev-parse HEAD)
  after=$(git rev-parse "origin/$branch")
  if [ "$before" = "$after" ]; then
    if deps_current; then
      echo "already at ${after:0:7}, nothing to deploy (restart by hand with: sudo systemctl restart $service)"
      return 0
    fi
    echo "at ${after:0:7} but node_modules does not match the lockfile, installing"
  else
    echo "deploying ${before:0:7} -> ${after:0:7}: $(git log -1 --format=%s "$after")"
  fi
  git reset --quiet --hard "$after"
  if install_and_restart "$service" && healthy "$health"; then
    echo "deployed ${after:0:7}, $service answers on $health"
    return 0
  fi

  echo "$service did not come up after the update, rolling back to ${before:0:7}" >&2
  systemctl status "$service" --no-pager --lines=20 >&2 || true
  git reset --quiet --hard "$before"
  if install_and_restart "$service" && healthy "$health"; then
    echo "rolled back to ${before:0:7}, $service is up again" >&2
  else
    echo "rollback did not bring $service up either, look at: journalctl -u $service -n 100" >&2
  fi
  return 1
}

lockfile_hash() { sha256sum package-lock.json | cut -d' ' -f1; }

deps_current() { [ -f "$STAMP" ] && [ "$(cat "$STAMP")" = "$(lockfile_hash)" ]; }

install_and_restart() {
  local service=$1
  if deps_current; then
    echo "dependencies unchanged"
  else
    npm ci --omit=dev --no-audit --no-fund --loglevel=error || return 1
    lockfile_hash > "$STAMP"
  fi
  sudo systemctl restart "$service" || return 1
}

# Wait up to 30 seconds for the health URL to answer.
healthy() {
  local i
  for i in $(seq 1 30); do
    if curl --fail --silent --max-time 2 "$1" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  return 1
}

# The PORT the systemd unit sets, or the app's default.
service_port() {
  local env
  env=$(systemctl show -p Environment --value "$1" 2>/dev/null || true)
  if [[ $env =~ (^|[[:space:]])PORT=([0-9]+) ]]; then echo "${BASH_REMATCH[2]}"; else echo 8080; fi
}

main "$@"
