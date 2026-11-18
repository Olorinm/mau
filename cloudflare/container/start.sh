#!/bin/sh
# Runs Mau in a container whose disk is empty at every start.
#
# Configuration is read from the configuration bucket into /config. State lives in /state and is
# copied to the state bucket while Mau runs: SQLite databases by Litestream as they change
# (db/), every other file by rclone every 30 seconds and once more after Mau has stopped (files/).
# A start restores both before Mau runs and refuses to run on a partial or unexpectedly empty
# restore, so a failed restore can never be replicated over the saved state.
#
# Environment: R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, CONFIG_BUCKET, STATE_BUCKET,
# and STATE_EXPECTED=1 once this deployment has run with state before.
set -eu
umask 077

: "${R2_ENDPOINT:?}" "${R2_ACCESS_KEY_ID:?}" "${R2_SECRET_ACCESS_KEY:?}" "${CONFIG_BUCKET:?}" "${STATE_BUCKET:?}"
# The remote is defined by these variables alone; rclone has no configuration file to look for.
export RCLONE_CONFIG=/dev/null RCLONE_CONFIG_R2_TYPE=s3 RCLONE_CONFIG_R2_PROVIDER=Cloudflare RCLONE_CONFIG_R2_REGION=auto \
  RCLONE_CONFIG_R2_ENDPOINT="$R2_ENDPOINT" RCLONE_CONFIG_R2_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID" \
  RCLONE_CONFIG_R2_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY" RCLONE_CONFIG_R2_NO_CHECK_BUCKET=true \
  RCLONE_CONFIG_R2_DIRECTORY_MARKERS=true
export LITESTREAM_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID" LITESTREAM_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY"
here=$(dirname "$0")
log() { printf '{"event":"%s"%s}\n' "$1" "${2:+,$2}"; }

# Databases and their journals belong to Litestream; uploads in progress are not state. Empty directories are kept
# (as marker objects), so a restored tree has every directory the saved one had.
sync_files() {
  rclone sync /state "r2:$STATE_BUCKET/files" --create-empty-src-dirs --fast-list \
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

rclone copy "r2:$CONFIG_BUCKET" /config
[ -f /config/mau.env ] || { log start_failed '"reason":"configuration_missing"'; exit 1; }

# What the state bucket holds: "db/" and "files/" once a run has saved state, nothing before the first one.
saved=$(rclone lsf --dirs-only "r2:$STATE_BUCKET")
databases=
case "$saved" in *db/*) databases=$(rclone lsf --recursive --dirs-only "r2:$STATE_BUCKET/db" | sed -n 's#\.sqlite/$#.sqlite#p') ;; esac
if [ -z "$databases" ] && [ "${STATE_EXPECTED:-}" = 1 ]; then
  log start_failed '"reason":"state_missing"'; exit 1
fi
case "$saved" in *files/*) rclone copy "r2:$STATE_BUCKET/files" /state --create-empty-src-dirs ;; esac
# The databases are restored side by side: one after another, they are most of the time a start takes.
count=0 restores=
for database in $databases; do
  mkdir -p "$(dirname "/state/$database")"
  litestream restore -o "/state/$database" "s3://$STATE_BUCKET/db/$database?endpoint=$R2_ENDPOINT&region=auto" &
  restores="$restores $!"
  count=$((count + 1))
done
for restore in $restores; do wait "$restore"; done
log state_restored "\"databases\":$count"

# Litestream runs beside Mau, not around it, so this script decides the order of a stop: Mau first, then the last
# copy of the databases, then the last copy of the files.
litestream replicate -config "$here/litestream.yml" &
replicator=$!
node --env-file=/config/mau.env dist/main.js &
mau=$!
(
  trap 'exit 0' TERM
  while :; do
    sleep 30 & wait $!
    sync_files || log file_sync_failed
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
while kill -0 "$mau" 2>/dev/null; do
  # Without the replicator nothing Mau writes is saved: stop rather than run on.
  kill -0 "$replicator" 2>/dev/null || { [ -n "$stopping" ] || log replicator_exited; stop; }
  sleep 1 & wait $! || true
done
wait "$mau" && status=0 || status=$?
kill -TERM "$syncer" 2>/dev/null && wait "$syncer" || true
kill -TERM "$replicator" 2>/dev/null && wait "$replicator" || true
# The replicator finds a new database about a second after it is created and sends it a second later. One pass over
# every database sends those it had not reached.
litestream replicate -config "$here/litestream.yml" -once
sync_files
log stopped "\"status\":$status"
exit "$status"
