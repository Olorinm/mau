#!/bin/sh
# Runs the image as the deployment does, against buckets served by the image's own rclone:
# a first start, a stop and a start that restores, a kill, a start refused on a lost bucket, and `seed`.
#
# Usage: cloudflare/test/container.sh <image>   (needs Docker; uses the configuration in examples/)
set -eu
image=${1:?usage: container.sh <image>}
root=$(cd "$(dirname "$0")/../.." && pwd)
name=mau-container-test-$$
s3=$name-s3 mau=$name-mau
work=$(mktemp -d)
cleanup() {
  docker rm -f "$s3" "$mau" >/dev/null 2>&1 || true
  docker network rm "$name" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT
fail() { echo "FAILED: $1" >&2; docker logs "$mau" 2>&1 | grep -v 'level=INFO' | tail -20 >&2 || true; exit 1; }
step() { echo "== $1"; }

# The configuration bucket: the repository's examples, an Environment provider that is never called, and mau.env.
mkdir -p "$work/config/cloud"
node -e '
  const fs = require("node:fs"), [examples, out] = process.argv.slice(1);
  const config = JSON.parse(fs.readFileSync(examples + "/mau.json", "utf8"));
  for (const profile of config.environments.profiles) profile.files = [];
  fs.writeFileSync(out + "/mau.json", JSON.stringify(config));
  fs.writeFileSync(out + "/providers.json", JSON.stringify({ providers: [{ id: "cloudflare", kind: "cloudflare", apiUrl: "https://gateway.invalid", apiKeyFile: "gateway-key" }] }));
  fs.writeFileSync(out + "/gateway-key", "not-a-key\n");
' "$root/examples" "$work/config"
cp "$root/examples/cloud/host-profile.json" "$work/config/cloud/"
cat > "$work/config/mau.env" <<'EOF'
MATRIX_SERVER_NAME=mau.example.com
AGENT_SERVICE_URL=http://localhost:8790/_agent-router/v1
EOF

docker network create "$name" >/dev/null
docker run -d --name "$s3" --network "$name" --entrypoint sh "$image" -c \
  'mkdir -p /tmp/s3/config /tmp/s3/state && exec rclone serve s3 --auth-key test,test-secret --addr :9000 /tmp/s3' >/dev/null
docker cp "$work/config/." "$s3:/tmp/s3/config/"
# What is in the state bucket, and emptying it.
bucket() {
  docker exec -e RCLONE_CONFIG=/dev/null -e RCLONE_CONFIG_S3_TYPE=s3 -e RCLONE_CONFIG_S3_PROVIDER=Rclone -e RCLONE_CONFIG_S3_ENDPOINT=http://127.0.0.1:9000 \
    -e RCLONE_CONFIG_S3_ACCESS_KEY_ID=test -e RCLONE_CONFIG_S3_SECRET_ACCESS_KEY=test-secret "$s3" rclone "$@"
}
saved() { bucket lsf --recursive --files-only s3:state | wc -l | tr -d ' '; }
empty() { for part in db files; do bucket purge "s3:state/$part"; done; }

# run <STATE_EXPECTED> [command…]: the container as the Durable Object starts it.
run() {
  expected=$1; shift
  docker rm -f "$mau" >/dev/null 2>&1 || true
  docker run -d --name "$mau" --network "$name" -e R2_ENDPOINT="http://$s3:9000" -e R2_ACCESS_KEY_ID=test \
    -e R2_SECRET_ACCESS_KEY=test-secret -e CONFIG_BUCKET=config -e STATE_BUCKET=state -e STATE_EXPECTED="$expected" "$@" >/dev/null
}
running() { [ "$(docker inspect -f '{{.State.Running}}' "$mau")" = true ]; }
ready() {
  for _ in $(seq 1 90); do
    docker exec "$mau" curl -fsS -o /dev/null http://127.0.0.1:8790/health/live 2>/dev/null && return 0
    running || return 1
    sleep 1
  done
  return 1
}
exited() { for _ in $(seq 1 90); do running || return 0; sleep 1; done; return 1; }
logged() { docker logs "$mau" 2>&1 | grep -q "$1"; }
# A database Mau does not know, as one created while it runs: rows are added and counted through node:sqlite.
rows() {
  docker exec "$mau" node -e '
    const { DatabaseSync } = require("node:sqlite"), db = new DatabaseSync("/state/probe/rows.sqlite");
    db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; CREATE TABLE IF NOT EXISTS rows (id INTEGER PRIMARY KEY)");
    for (let i = 0; i < Number(process.argv[1]); i++) db.exec("INSERT INTO rows DEFAULT VALUES");
    console.log(db.prepare("SELECT count(*) AS n FROM rows").get().n);
  ' "$1"
}

step "first start on empty buckets"
run 0 "$image"
ready || fail "Mau did not start"
logged '"state_restored","databases":0' || fail "a first start restores nothing"
docker exec "$mau" sh -c 'mkdir -p /state/probe/empty && echo kept > /state/probe/file'
[ "$(rows 3)" = 3 ] || fail "rows not written"

step "stop: Mau closes, then the state is copied a last time"
docker stop -t 60 "$mau" >/dev/null
[ "$(docker inspect -f '{{.State.ExitCode}}' "$mau")" = 0 ] || fail "stop exit code"
logged '"event":"stopped","status":0' || fail "stop was not orderly"
logged stop_forced && fail "Mau did not close within 30 seconds"

step "start restores databases, files and empty directories"
run 1 "$image"
ready || fail "Mau did not start on restored state"
logged '"state_restored","databases":0' && fail "no database restored"
[ "$(docker exec "$mau" cat /state/probe/file)" = kept ] || fail "file not restored"
docker exec "$mau" test -d /state/probe/empty || fail "empty directory not restored"
[ "$(docker exec "$mau" stat -c %a /state/probe/file)" = 600 ] || fail "restored file is not private"
[ "$(rows 2)" = 5 ] || fail "rows not restored"

step "kill: what was committed seconds before is restored"
sleep 5
docker kill "$mau" >/dev/null
# A killed Mau leaves its coordination lease, and the next one refuses to start until it expires (30 seconds).
sleep 30
run 1 "$image"
ready || fail "Mau did not start after a kill"
[ "$(rows 0)" = 5 ] || fail "rows lost by a kill"

step "replicator gone: the container stops instead of running unsaved"
docker exec "$mau" sh -c 'for p in /proc/[0-9]*; do grep -q "^litestream" "$p/comm" 2>/dev/null && kill -KILL "${p#/proc/}"; done; true'
exited || fail "container kept running without its replicator"
logged replicator_exited || fail "replicator exit not reported"

step "lost state bucket: the start is refused"
empty
run 1 "$image"
exited || fail "container ran on an empty bucket"
logged '"reason":"state_missing"' || fail "refusal not reported"
[ "$(saved)" = 0 ] || fail "an empty state was written to the bucket"

step "seed: a state directory is copied to the empty bucket and restored by the next start"
run 0 --entrypoint sleep "$image" 600
docker exec "$mau" sh -c 'mkdir -p /state/probe && echo seeded > /state/probe/file'
[ "$(rows 4)" = 4 ] || fail "seed rows not written"
docker exec "$mau" /app/container/start.sh seed > "$work/seed.log" 2>&1 || { grep -v level=INFO "$work/seed.log" >&2; bucket lsf --recursive s3:state >&2; fail "seed failed"; }
docker exec "$mau" /app/container/start.sh seed >/dev/null 2>&1 && fail "seed wrote to a bucket that is not empty"
run 1 "$image"
ready || fail "Mau did not start on seeded state"
[ "$(docker exec "$mau" cat /state/probe/file)" = seeded ] || fail "seeded file not restored"
[ "$(rows 0)" = 4 ] || fail "seeded rows not restored"

echo "ok"
