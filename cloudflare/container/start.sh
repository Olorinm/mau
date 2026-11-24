#!/bin/sh
# Runs Mau in a container whose disk is empty at every start.
#
# Configuration is read from the configuration bucket into /config. State lives in /state and is
# copied to the state bucket while Mau runs: SQLite databases by Litestream as they change
# (db/), every other file by rclone when changed and once more after Mau has stopped (files/).
# A start restores both before Mau runs and refuses to run on a partial or unexpectedly empty
# restore, so a failed restore can never be replicated over the saved state.
#
# Environment: R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, CONFIG_BUCKET, STATE_BUCKET,
# and STATE_EXPECTED=1 once this deployment has run with state before.
set -eu
umask 077

: "${R2_ENDPOINT:?}" "${CONFIG_BUCKET:?}" "${STATE_BUCKET:?}"
export RCLONE_CONFIG=/dev/null RCLONE_CONFIG_R2_TYPE=s3 RCLONE_CONFIG_R2_PROVIDER=Cloudflare RCLONE_CONFIG_R2_REGION=auto \
  RCLONE_CONFIG_R2_ENDPOINT="$R2_ENDPOINT" RCLONE_CONFIG_R2_NO_CHECK_BUCKET=true RCLONE_CONFIG_R2_DIRECTORY_MARKERS=true
export STATE_PREFIX="${STATE_PREFIX:-}" STATE_SOURCE="${STATE_SOURCE:-}"
if [ -n "${STATE_CONTROL:-}" ]; then
  export AWS_CONFIG_FILE=/var/lib/litestream/aws-config AWS_SDK_LOAD_CONFIG=true RCLONE_CONFIG_R2_ENV_AUTH=true AWS_EC2_METADATA_DISABLED=true
  for profile in config restore state; do
    printf '[profile %s]\ncredential_process = /usr/bin/curl -fsS --max-time 10 %s/credentials/%s\nregion = auto\n' "$profile" "$STATE_CONTROL" "$profile"
  done > "$AWS_CONFIG_FILE"
else
  : "${R2_ACCESS_KEY_ID:?}" "${R2_SECRET_ACCESS_KEY:?}"
  export RCLONE_CONFIG_R2_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID" RCLONE_CONFIG_R2_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY"
  export LITESTREAM_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID" LITESTREAM_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY"
fi
select_profile() {
  if [ -n "${STATE_CONTROL:-}" ]; then export AWS_PROFILE="$1"; fi
}
control() {
  curl -fsS --retry 2 --retry-all-errors --max-time 5 -X POST "$STATE_CONTROL/$1" > /dev/null
}
here=$(dirname "$0")
export AGENT_LOCAL_LEASE_DIR=/var/lib/litestream/leases
log() { printf '{"event":"%s"%s}\n' "$1" "${2:+,$2}"; }

# Databases and their journals belong to Litestream; uploads in progress are not state. Empty directories are kept
# (as marker objects), so a restored tree has every directory the saved one had.
sync_files() {
  rclone sync /state "r2:$STATE_BUCKET/${STATE_PREFIX}files" --create-empty-src-dirs --fast-list \
    --exclude '*.sqlite' --exclude '*.sqlite-wal' --exclude '*.sqlite-shm' --exclude '/router/tmp/**'
}

# `start.sh seed` moves an existing installation in: with Mau stopped and its state directory mounted at /state, the
# state is copied to an empty state bucket, as a run would have left it. Nothing is started.
if [ "${1:-}" = seed ]; then
  [ -z "$(rclone lsf "r2:$STATE_BUCKET")" ] || { log seed_failed '"reason":"state_bucket_not_empty"'; exit 1; }
  litestream replicate -config "$here/litestream.yml" -once
  sync_files
  log seeded
  exit 0
fi

select_profile config
rclone copy "r2:$CONFIG_BUCKET" /config
[ -f /config/mau.env ] || { log start_failed '"reason":"configuration_missing"'; exit 1; }

select_profile restore
source="r2:$STATE_BUCKET/${STATE_SOURCE%/}"
saved=$(rclone lsf --dirs-only "$source")
inventory=/var/lib/litestream/restore-list
: > "$inventory"
case "$saved" in *db/*) python3 "$here/list-databases.py" "r2:$STATE_BUCKET/${STATE_SOURCE}db" > "$inventory" ;; esac
if [ ! -s "$inventory" ] && [ "${STATE_EXPECTED:-}" = 1 ]; then
  log start_failed '"reason":"state_missing"'; exit 1
fi
case "$saved" in *files/*) rclone copy "r2:$STATE_BUCKET/${STATE_SOURCE}files" /state --create-empty-src-dirs ;; esac
# Limit peak memory during restoration. Do not start the application until every database passes.
count=0 restores=
while IFS= read -r database; do
  mkdir -p "$(dirname "/state/$database")"
  (
    litestream restore -o "/state/$database" "s3://$STATE_BUCKET/${STATE_SOURCE}db/$database?endpoint=$R2_ENDPOINT&region=auto&signAcceptEncoding=false" &&
      python3 "$here/verify-restore.py" "/state/$database" "$database"
  ) &
  restores="$restores $!"
  count=$((count + 1))
  if [ $((count % 2)) -eq 0 ]; then
    for restore in $restores; do wait "$restore"; done
    restores=
  fi
done < "$inventory"
for restore in $restores; do wait "$restore"; done
log state_restored "\"databases\":$count"

select_profile state
if [ -n "${STATE_CONTROL:-}" ]; then
  if [ "$STATE_SOURCE" != "$STATE_PREFIX" ]; then
    if [ "$count" -gt 0 ]; then
      litestream replicate -config "$here/litestream.yml" -once
      while IFS= read -r database; do
        litestream restore -dry-run -o /var/lib/litestream/restore-check "s3://$STATE_BUCKET/${STATE_PREFIX}db/$database?endpoint=$R2_ENDPOINT&region=auto&signAcceptEncoding=false" > /dev/null
      done < "$inventory"
    fi
    sync_files
  fi
  control publish
fi

# Litestream runs beside Mau, not around it, so this script decides the order of a stop: Mau first, then the last
# copy of the databases, then the last copy of the files.
litestream replicate -config "$here/litestream.yml" &
replicator=$!
node --env-file=/config/mau.env dist/main.js &
mau=$!
(
  trap 'exit 0' TERM
  previous=
  verified=0
  while :; do
    if current=$(python3 "$here/file-state.py" /state); then
      now=$(date +%s)
      if [ "$current" != "$previous" ] || [ $((now - verified)) -ge 3600 ]; then
        if sync_files; then
          previous=$current
          verified=$now
        else
          log file_sync_failed
        fi
      fi
    else
      log file_scan_failed
    fi
    sleep 5 & wait $!
  done
) &
syncer=$!

# Asked to stop, Mau gets 30 seconds to finish. What it has committed is on disk either way and is copied below.
stopping=
stop() {
  [ -z "$stopping" ] || return 0
  stopping=1
  kill -TERM "$mau" 2>/dev/null || return 0
  ( sleep 30; kill -KILL "$mau" 2>/dev/null && log stop_forced ) &
}
trap stop TERM INT
watcher=
if [ -n "${STATE_CONTROL:-}" ]; then
  supervisor=$$
  (
    failures=0
    while :; do
      code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 4 "$STATE_CONTROL/status") || code=000
      case "$code" in
        200) failures=0 ;;
        409) break ;;
        *) failures=$((failures + 1)); [ "$failures" -lt 3 ] || break ;;
      esac
      sleep 10
    done
    log replica_ownership_lost
    kill -TERM "$supervisor"
  ) &
  watcher=$!
fi
while kill -0 "$mau" 2>/dev/null; do
  # Without the replicator nothing Mau writes is saved: stop rather than run on.
  kill -0 "$replicator" 2>/dev/null || { [ -n "$stopping" ] || log replicator_exited; stop; }
  sleep 1 & wait $! || true
done
wait "$mau" && status=0 || status=$?
if [ -n "$watcher" ]; then kill -TERM "$watcher" 2>/dev/null || true; wait "$watcher" || true; fi
kill -TERM "$syncer" 2>/dev/null && wait "$syncer" || true
kill -TERM "$replicator" 2>/dev/null && wait "$replicator" || true
# The replicator finds a new database about a second after it is created and sends it a second later. One pass over
# every database sends those it had not reached.
litestream replicate -config "$here/litestream.yml" -once
sync_files
if [ -n "${STATE_CONTROL:-}" ]; then control released; fi
log stopped "\"status\":$status"
exit "$status"
