# S0 teardown of identities and policies (so their absence can be verified independently before the server container is removed).
set -eu
export MC_CONFIG_DIR=/tmp/.mc HOME=/tmp
for key in "$S0_WEB_KEY" "$S0_WORKER_KEY" "$S0_VERIFIER_KEY"; do mc admin user remove local "$key" || true; done
for role in web worker verifier; do mc admin policy remove local "a2-s0-$role" || true; done
mc ilm rule remove --all --force "local/$S0_BUCKET" || true
echo "USERS $(mc admin user list local --json | tr -d '\n')"
echo "POLICIES $(mc admin policy list local --json | tr -d '\n')"
echo S0_DEPROVISION_OK
