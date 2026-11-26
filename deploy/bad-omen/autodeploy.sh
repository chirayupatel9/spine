#!/usr/bin/env bash
# Album Viewer: put what's on main live. A systemd user timer runs this on the server every 2
# minutes (install.sh sets it up). It only ever fast-forwards. When main has moved, it pulls,
# rebuilds and restarts the container, then waits up to a minute for /healthz. If the new version
# isn't healthy by then, it goes back to the version that was running and leaves that commit alone
# until main moves again. Changes that only touch the Android app, tests or docs are pulled without
# a rebuild.
#
# Settings (environment): ALBUM_VIEWER_DIR (default ~/album-viewer), HEALTH_URL
# (default http://127.0.0.1:8090/healthz), DEPLOY_BRANCH (default main).

main() {
  set -euo pipefail
  local dir="${ALBUM_VIEWER_DIR:-$HOME/album-viewer}"
  local health="${HEALTH_URL:-http://127.0.0.1:8090/healthz}"
  local branch="${DEPLOY_BRANCH:-main}"
  local state="${XDG_STATE_HOME:-$HOME/.local/state}/album-viewer-deploy"
  mkdir -p "$state"
  exec 9>"$state/lock"
  flock -n 9 || return 0                        # a deploy is already running
  cd "$dir"

  git fetch --quiet origin "$branch"
  local live new
  live=$(git rev-parse HEAD)
  new=$(git rev-parse "origin/$branch")
  [ "$live" = "$new" ] && return 0
  [ "$(cat "$state/skip" 2>/dev/null || true)" = "$new" ] && return 0   # failed before: wait for a newer commit
  if ! git merge-base --is-ancestor "$live" "$new"; then
    echo "$branch was rewritten (it doesn't continue from $(git rev-parse --short "$live")); not deploying" >&2
    return 1
  fi
  if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
    echo "the checkout has local changes to tracked files; not deploying" >&2
    return 1
  fi

  local what
  what=$(git log -1 --format='%h %s' "$new")
  if git diff --quiet "$live" "$new" -- . ':(exclude)android' ':(exclude)tests' ':(exclude).github' ':(exclude)deploy' ':(exclude)*.md'; then
    git merge --ff-only --quiet "$new"
    echo "pulled $what (nothing the server runs changed)"
    return 0
  fi

  echo "deploying $what"
  git merge --ff-only --quiet "$new"
  export VERSION   # the commit, built into the image: /healthz reports it
  VERSION=$(git rev-parse --short HEAD)
  if docker compose up -d --build --quiet-pull 2>&1 | tail -n 3 && healthy "$health"; then
    rm -f "$state/skip"
    echo "live: $what"
    return 0
  fi

  echo "$(git rev-parse --short "$new") isn't healthy; going back to $(git rev-parse --short "$live")" >&2
  echo "$new" > "$state/skip"
  git reset --hard --quiet "$live"
  VERSION=$(git rev-parse --short HEAD)
  docker compose up -d --build --quiet-pull 2>&1 | tail -n 3 || true
  if healthy "$health"; then echo "back on $(git log -1 --format='%h %s')" >&2; fi
  return 1
}

# Up to a minute for the health check to answer.
healthy() {
  local i tries="${HEALTH_TRIES:-30}"
  for i in $(seq 1 "$tries"); do
    curl -fsS -o /dev/null --max-time 3 "$1" 2>/dev/null && return 0
    sleep 2
  done
  return 1
}

# Everything above is read before anything runs, so a pull that changes this file can't trip up
# the run that pulled it.
main "$@"; exit
