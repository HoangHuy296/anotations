# S0 provisioning (runs inside the digest-pinned, receipt-owned minio/mc container; the supervisor passes everything by env name).
# Idempotent: bucket --ignore-existing, policy create overwrites, user add updates, lifecycle import replaces the whole configuration.
set -eu
export MC_CONFIG_DIR=/tmp/.mc HOME=/tmp
mkdir -p /tmp/pol
# The supervisor renders the bucket name into the policies (the mc image has no sed/grep).
printf '%s' "$S0_POLICY_WEB" > /tmp/pol/web.json
printf '%s' "$S0_POLICY_WORKER" > /tmp/pol/worker.json
printf '%s' "$S0_POLICY_VERIFIER" > /tmp/pol/verifier.json
printf '%s' "$S0_LIFECYCLE" > /tmp/pol/lifecycle.json
mc mb --ignore-existing "local/$S0_BUCKET"
for role in web worker verifier; do
  mc admin policy create local "a2-s0-$role" "/tmp/pol/$role.json"
done
mc admin user add local "$S0_WEB_KEY" "$S0_WEB_SECRET"
mc admin user add local "$S0_WORKER_KEY" "$S0_WORKER_SECRET"
mc admin user add local "$S0_VERIFIER_KEY" "$S0_VERIFIER_SECRET"
for pair in "web:$S0_WEB_KEY" "worker:$S0_WORKER_KEY" "verifier:$S0_VERIFIER_KEY"; do
  role="${pair%%:*}"; key="${pair#*:}"
  info="$(mc admin user info local "$key" --json | tr -d '\n')"
  case "$info" in
    *"\"policyName\":\"a2-s0-$role\""*) ;;
    *) mc admin policy attach local "a2-s0-$role" --user "$key" ;;
  esac
done
mc ilm rule import "local/$S0_BUCKET" < /tmp/pol/lifecycle.json
echo S0_PROVISION_OK
