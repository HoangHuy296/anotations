# S0 read-only snapshot of the provisioned state (policies, users' attachments, lifecycle). No secrets are printed.
set -eu
export MC_CONFIG_DIR=/tmp/.mc HOME=/tmp
for role in web worker verifier; do
  echo "POLICY $role $(mc admin policy info local "a2-s0-$role" --json | tr -d '\n')"
done
for pair in "web:$S0_WEB_KEY" "worker:$S0_WORKER_KEY" "verifier:$S0_VERIFIER_KEY"; do
  role="${pair%%:*}"; key="${pair#*:}"
  echo "USER $role $(mc admin user info local "$key" --json | tr -d '\n')"
done
echo "LIFECYCLE $(mc ilm rule export "local/$S0_BUCKET" | tr -d '\n')"
echo "BUCKETS $(mc ls local --json | tr -d '\n')"
echo S0_SNAPSHOT_OK
