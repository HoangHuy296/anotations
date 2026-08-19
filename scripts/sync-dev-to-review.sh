#!/usr/bin/env bash
set -euo pipefail

# Mirrors Postgres data and MinIO objects from the Dev Docker Compose stack
# (AnnotationPlatformDev) into the Review stack (AnnotationPlatformReview) so
# colleagues can exercise the Review stack against realistic, dev-shaped data
# instead of the empty seed from prisma/review.seed.ts.
#
# Safety model:
#   - Dev is READ-ONLY, always: pg_dump, read-only SQL, and MinIO listing only.
#   - Review is the ONLY destructive target, and only after the operator types
#     the exact confirmation phrase (see CONFIRM_PHRASE below).
#   - Nothing here mounts, copies, or removes a Docker volume. All transfer
#     happens through the running postgres/minio services (docker compose
#     exec / a disposable minio/mc container talking to already-published
#     host ports), never raw volume access.
#   - docker-compose.yaml, docker-compose.review.yaml, .env, and .env.review
#     are read-only inputs; this script never writes to any of them.
#   - There is deliberately NO --skip-confirmation flag. No existing script in
#     this repo has a "force" convention, and this workflow prefers explicit,
#     typed confirmation over a shortcut that could be scripted around.

# --- Constants -------------------------------------------------------------
#
# Compose rejects mixed-case -p values outright ("invalid project name...
# must consist only of lowercase alphanumeric characters..."), so these are
# NOT passed as -p flags. Both compose files already pin their project name
# via a top-level `name:` key, which Compose lowercases automatically — that
# pinned name is what actually identifies each stack. SOURCE_PROJECT_NAME /
# TARGET_PROJECT_NAME below exist for display and the identity assertion, not
# for use as a literal --project-name argument.
readonly SOURCE_PROJECT_NAME="AnnotationPlatformDev"
readonly TARGET_PROJECT_NAME="AnnotationPlatformReview"

readonly REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly DEV_COMPOSE_FILE="${REPO_ROOT}/docker-compose.yaml"
readonly DEV_ENV_FILE="${REPO_ROOT}/.env"
readonly REVIEW_COMPOSE_FILE="${REPO_ROOT}/docker-compose.review.yaml"
readonly REVIEW_ENV_FILE="${REPO_ROOT}/.env.review"
readonly WORKDIR="${REPO_ROOT}/tmp/dev-to-review"
readonly CONFIRM_PHRASE="REPLACE REVIEW DATA"
readonly MC_IMAGE="minio/mc:latest"

if [[ "${SOURCE_PROJECT_NAME}" == "${TARGET_PROJECT_NAME}" ]]; then
  echo "FATAL: source/target project names are identical — refusing to continue" >&2
  exit 1
fi

# --- Logging -----------------------------------------------------------
log()   { printf '%s\n' "$*"; }
fatal() { printf 'FATAL: %s\n' "$*" >&2; exit 1; }

# --- Compose wrappers --------------------------------------------------
#
# Every command against either stack MUST go through one of these two
# functions — never a raw `docker compose` call, never a hand-built
# container-name string. That keeps project/file/env-file selection
# centralized and impossible to typo per call site.
dev_compose()    { docker compose -f "${DEV_COMPOSE_FILE}" --env-file "${DEV_ENV_FILE}" "$@"; }
review_compose() { docker compose -f "${REVIEW_COMPOSE_FILE}" --env-file "${REVIEW_ENV_FILE}" "$@"; }

# --- Usage ---------------------------------------------------------------
print_usage() {
  cat <<EOF
Usage: $(basename "${BASH_SOURCE[0]}") [--dry-run] [--postgres-only | --minio-only]

Mirrors Dev Postgres data and MinIO objects into Review. Dev is read-only;
Review is the only destructive target, gated behind a typed confirmation
phrase (see below). Nothing is ever written to Dev, docker-compose.yaml,
docker-compose.review.yaml, .env, or .env.review.

Options:
  --dry-run         Inspect both stacks and compute the planned changes.
                     Makes zero writes and zero deletes. Skips confirmation.
  --postgres-only    Sync Postgres only; skip the MinIO mirror stage.
  --minio-only       Mirror MinIO only; skip the Postgres dump/restore stages.
  -h, --help         Show this help and exit.

There is deliberately no --skip-confirmation flag.
EOF
}

# --- Argument parsing ------------------------------------------------------
DRY_RUN=0
POSTGRES_ONLY=0
MINIO_ONLY=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --postgres-only) POSTGRES_ONLY=1; shift ;;
    --minio-only) MINIO_ONLY=1; shift ;;
    -h|--help) print_usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; print_usage; exit 1 ;;
  esac
done

if [[ "${POSTGRES_ONLY}" -eq 1 && "${MINIO_ONLY}" -eq 1 ]]; then
  fatal "--postgres-only and --minio-only are mutually exclusive"
fi

RUN_POSTGRES=1
RUN_MINIO=1
[[ "${MINIO_ONLY}" -eq 1 ]] && RUN_POSTGRES=0
[[ "${POSTGRES_ONLY}" -eq 1 ]] && RUN_MINIO=0

# --- Preflight ---------------------------------------------------------
require_cmd() {
  command -v "$1" >/dev/null 2>&1 || fatal "'$1' is required but not installed"
}
require_cmd docker
require_cmd jq
docker compose version >/dev/null 2>&1 || fatal "docker compose plugin not available"
docker info >/dev/null 2>&1 || fatal "docker daemon not reachable"

mkdir -p "${WORKDIR}"

# --- Temp files & cleanup ----------------------------------------------
DUMP_FILE="${WORKDIR}/dev-postgres-$(date +%Y%m%d-%H%M%S).dump"
MC_ENV_FILE="${WORKDIR}/mc-env-$$.env"
REVIEW_WEB_WORKER_STOPPED=0

cleanup() {
  local exit_code=$?
  rm -f "${MC_ENV_FILE}"
  # Keep the dump file on failure so a human can retry pg_restore without
  # re-dumping Dev; remove it on a clean successful run.
  if [[ ${exit_code} -eq 0 ]]; then
    rm -f "${DUMP_FILE}"
  fi
  if [[ "${REVIEW_WEB_WORKER_STOPPED}" -eq 1 ]]; then
    echo "[cleanup] restarting Review web/worker (best-effort)" >&2
    review_compose start web worker || echo "[cleanup] WARNING: failed to restart web/worker — restart manually with: docker compose -f docker-compose.review.yaml --env-file .env.review start web worker" >&2
  fi
  exit "${exit_code}"
}
trap cleanup EXIT

# =============================================================================
# [1/7] Resolve configuration and health-check both stacks
# =============================================================================
log "[1/7] Resolving configuration and checking both stacks"

DEV_JSON="$(dev_compose config --format json)" || fatal "failed to resolve Dev compose configuration"
REVIEW_JSON="$(review_compose config --format json)" || fatal "failed to resolve Review compose configuration"

resolve() {
  local json="$1" path="$2" label="$3"
  local value
  value="$(jq -r "$path" <<<"${json}")"
  if [[ -z "${value}" || "${value}" == "null" ]]; then
    fatal "could not resolve ${label} from compose configuration (${path})"
  fi
  printf '%s' "${value}"
}

dev_pg_user=$(resolve "${DEV_JSON}" '.services.postgres.environment.POSTGRES_USER' "Dev POSTGRES_USER")
dev_pg_db=$(resolve "${DEV_JSON}" '.services.postgres.environment.POSTGRES_DB' "Dev POSTGRES_DB")
dev_pg_password=$(resolve "${DEV_JSON}" '.services.postgres.environment.POSTGRES_PASSWORD' "Dev POSTGRES_PASSWORD")
dev_pg_host_port=$(resolve "${DEV_JSON}" '.services.postgres.ports[0].published' "Dev postgres host port")

review_pg_user=$(resolve "${REVIEW_JSON}" '.services.postgres.environment.POSTGRES_USER' "Review POSTGRES_USER")
review_pg_db=$(resolve "${REVIEW_JSON}" '.services.postgres.environment.POSTGRES_DB' "Review POSTGRES_DB")
review_pg_password=$(resolve "${REVIEW_JSON}" '.services.postgres.environment.POSTGRES_PASSWORD' "Review POSTGRES_PASSWORD")
review_pg_host_port=$(resolve "${REVIEW_JSON}" '.services.postgres.ports[0].published' "Review postgres host port")

if [[ "${RUN_MINIO}" -eq 1 ]]; then
  # MINIO_BUCKET is only set on the web/worker services, not on minio itself.
  dev_minio_access_key=$(resolve "${DEV_JSON}" '.services.minio.environment.MINIO_ROOT_USER' "Dev MINIO_ROOT_USER")
  dev_minio_secret_key=$(resolve "${DEV_JSON}" '.services.minio.environment.MINIO_ROOT_PASSWORD' "Dev MINIO_ROOT_PASSWORD")
  dev_minio_host_port=$(resolve "${DEV_JSON}" '.services.minio.ports[0].published' "Dev minio host port")
  dev_minio_bucket=$(resolve "${DEV_JSON}" '.services.web.environment.MINIO_BUCKET' "Dev MINIO_BUCKET")

  review_minio_access_key=$(resolve "${REVIEW_JSON}" '.services.minio.environment.MINIO_ROOT_USER' "Review MINIO_ROOT_USER")
  review_minio_secret_key=$(resolve "${REVIEW_JSON}" '.services.minio.environment.MINIO_ROOT_PASSWORD' "Review MINIO_ROOT_PASSWORD")
  review_minio_host_port=$(resolve "${REVIEW_JSON}" '.services.minio.ports[0].published' "Review minio host port")
  review_minio_bucket=$(resolve "${REVIEW_JSON}" '.services.web.environment.MINIO_BUCKET' "Review MINIO_BUCKET")
fi

log ""
log "SOURCE STACK (read-only):"
log "  Compose project : ${SOURCE_PROJECT_NAME}"
log "  Postgres        : ${dev_pg_user}@127.0.0.1:${dev_pg_host_port}/${dev_pg_db}"
[[ "${RUN_MINIO}" -eq 1 ]] && log "  MinIO           : ${dev_minio_access_key}@127.0.0.1:${dev_minio_host_port} bucket=${dev_minio_bucket}"
log ""
log "TARGET STACK (destructive writes only after confirmation):"
log "  Compose project : ${TARGET_PROJECT_NAME}"
log "  Postgres        : ${review_pg_user}@127.0.0.1:${review_pg_host_port}/${review_pg_db}"
[[ "${RUN_MINIO}" -eq 1 ]] && log "  MinIO           : ${review_minio_access_key}@127.0.0.1:${review_minio_host_port} bucket=${review_minio_bucket}"
log ""
# Passwords/secret keys above are deliberately never printed.

dev_pg_cid=$(dev_compose ps -q postgres)
review_pg_cid=$(review_compose ps -q postgres)
[[ -z "${dev_pg_cid}" ]] && fatal "Dev postgres is not running (start it with: docker compose -f docker-compose.yaml --env-file .env up -d postgres)"
[[ -z "${review_pg_cid}" ]] && fatal "Review postgres is not running (start it with: docker compose -f docker-compose.review.yaml --env-file .env.review up -d postgres)"
[[ "${dev_pg_cid}" == "${review_pg_cid}" ]] && fatal "Dev and Review postgres resolved to the same container id — refusing to continue"

dev_compose exec -T postgres pg_isready -U "${dev_pg_user}" -d "${dev_pg_db}" >/dev/null </dev/null \
  || fatal "Dev postgres is not accepting connections"
review_compose exec -T postgres pg_isready -U "${review_pg_user}" -d "${review_pg_db}" >/dev/null </dev/null \
  || fatal "Review postgres is not accepting connections"

if [[ "${RUN_MINIO}" -eq 1 ]]; then
  dev_minio_cid=$(dev_compose ps -q minio)
  review_minio_cid=$(review_compose ps -q minio)
  [[ -z "${dev_minio_cid}" ]] && fatal "Dev minio is not running"
  [[ -z "${review_minio_cid}" ]] && fatal "Review minio is not running"
  [[ "${dev_minio_cid}" == "${review_minio_cid}" ]] && fatal "Dev and Review minio resolved to the same container id — refusing to continue"
fi

log "[1/7] Both stacks are healthy and distinct. Continuing."

# =============================================================================
# [2/7] Dump Dev PostgreSQL (read-only against Dev)
# =============================================================================
if [[ "${RUN_POSTGRES}" -eq 1 ]]; then
  log "[2/7] Dumping Dev PostgreSQL (${dev_pg_db}) — read-only"
  dev_compose exec -T -e PGPASSWORD="${dev_pg_password}" postgres \
    pg_dump -U "${dev_pg_user}" -d "${dev_pg_db}" -Fc --no-owner --no-acl \
    < /dev/null > "${DUMP_FILE}"

  if [[ ! -s "${DUMP_FILE}" ]]; then
    fatal "Dev pg_dump produced an empty file — aborting before touching Review"
  fi

  # Structural integrity check, piped back through the Dev container so the
  # dump is never validated by depending on a host-side pg_restore binary.
  # (Deliberately not piped through `head` here: under `set -o pipefail`,
  # `head` closing its stdin early would SIGPIPE pg_restore and make a
  # perfectly valid dump look like a failure.)
  dev_compose exec -T postgres pg_restore --list < "${DUMP_FILE}" >/dev/null \
    || fatal "dump file failed pg_restore --list integrity check"

  dump_size=$(wc -c < "${DUMP_FILE}" | tr -d '[:space:]')
  log "[2/7] Dump OK: ${DUMP_FILE} (${dump_size} bytes)"
else
  log "[2/7] Skipped (--minio-only)"
fi

# =============================================================================
# [3/7] Confirm Review replacement
# =============================================================================
if [[ "${DRY_RUN}" -eq 1 ]]; then
  log "[3/7] Skipped (--dry-run makes no writes, no confirmation needed)"
else
  log "[3/7] Confirming Review replacement"
  log ""
  log "----------------------------------------"
  log "WARNING: REVIEW DATA WILL BE REPLACED"
  log "----------------------------------------"
  log ""
  log "Target:"
  log "  Compose project: ${TARGET_PROJECT_NAME}"
  log ""
  if [[ "${RUN_POSTGRES}" -eq 1 ]]; then
    log "PostgreSQL:"
    log "  Review database '${review_pg_db}' will be replaced with a Dev dump."
  fi
  if [[ "${RUN_MINIO}" -eq 1 ]]; then
    log "MinIO:"
    log "  Review objects in bucket '${review_minio_bucket}' may be deleted/overwritten to mirror Dev's '${dev_minio_bucket}'."
  fi
  log ""
  log "This operation is destructive to REVIEW ONLY."
  log ""
  printf 'Type exactly:\n  %s\n\nContinue? > ' "${CONFIRM_PHRASE}"
  IFS= read -r user_input || user_input=""
  if [[ "${user_input}" != "${CONFIRM_PHRASE}" ]]; then
    fatal "Confirmation phrase did not match exactly. Aborting — no changes made."
  fi
  log "[3/7] Confirmed."
fi

# =============================================================================
# [4/7] Restore Review PostgreSQL
# =============================================================================
if [[ "${RUN_POSTGRES}" -eq 1 ]]; then
  log "[4/7] Restoring Review PostgreSQL"

  if [[ "${DRY_RUN}" -eq 1 ]]; then
    log "  [dry-run] would stop Review web/worker"
    log "  [dry-run] would terminate active Review connections and DROP/CREATE SCHEMA public on ${review_pg_db}"
    log "  [dry-run] would pg_restore $(basename "${DUMP_FILE}") into Review"
  else
    log "  Stopping Review web/worker to avoid dangling connections during restore"
    review_compose stop web worker
    REVIEW_WEB_WORKER_STOPPED=1

    log "  Terminating active Review database connections"
    review_compose exec -T -e PGPASSWORD="${review_pg_password}" postgres \
      psql -U "${review_pg_user}" -d "${review_pg_db}" -v ON_ERROR_STOP=1 -c \
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${review_pg_db}' AND pid <> pg_backend_pid();" < /dev/null

    log "  Resetting Review schema 'public' (database, container, and volume are kept — only schema contents reset)"
    review_compose exec -T -e PGPASSWORD="${review_pg_password}" postgres \
      psql -U "${review_pg_user}" -d "${review_pg_db}" -v ON_ERROR_STOP=1 -c \
      "DROP SCHEMA public CASCADE; CREATE SCHEMA public; GRANT ALL ON SCHEMA public TO ${review_pg_user};" < /dev/null

    log "  Restoring Dev's dump into Review"
    set +e
    review_compose exec -T -e PGPASSWORD="${review_pg_password}" postgres \
      pg_restore -U "${review_pg_user}" -d "${review_pg_db}" --no-owner --no-acl < "${DUMP_FILE}"
    restore_exit=$?
    set -e
    if [[ ${restore_exit} -ne 0 ]]; then
      fatal "pg_restore into Review failed (exit ${restore_exit}). Dev is untouched. Review's schema was already reset and is now in a PARTIAL/inconsistent state — do not assume it is usable. The dump file has been kept at ${DUMP_FILE} for a manual retry."
    fi
  fi
  log "[4/7] Review PostgreSQL restored"
else
  log "[4/7] Skipped (--minio-only)"
fi

# =============================================================================
# [5/7] Rewrite storageBucket/cacheBucket references (Review only) + restart web/worker
# =============================================================================
if [[ "${RUN_POSTGRES}" -eq 1 ]]; then
  log "[5/7] Rewriting Asset/AssetVersion storageBucket/cacheBucket references (Review only)"

  if [[ "${DRY_RUN}" -eq 1 ]]; then
    log "  [dry-run] would run 4 UPDATE statements against Asset/AssetVersion.storageBucket/cacheBucket on Review"
  else
    rewrite_sql="UPDATE \"Asset\" SET \"storageBucket\" = '${review_minio_bucket}' WHERE \"storageBucket\" = '${dev_minio_bucket}';
UPDATE \"Asset\" SET \"cacheBucket\" = '${review_minio_bucket}' WHERE \"cacheBucket\" = '${dev_minio_bucket}';
UPDATE \"AssetVersion\" SET \"storageBucket\" = '${review_minio_bucket}' WHERE \"storageBucket\" = '${dev_minio_bucket}';
UPDATE \"AssetVersion\" SET \"cacheBucket\" = '${review_minio_bucket}' WHERE \"cacheBucket\" = '${dev_minio_bucket}';"
    review_compose exec -T -e PGPASSWORD="${review_pg_password}" postgres \
      psql -U "${review_pg_user}" -d "${review_pg_db}" -v ON_ERROR_STOP=1 -c "${rewrite_sql}" < /dev/null \
      || fatal "bucket-name rewrite UPDATE failed against Review. Dev is untouched. Review's Postgres content was restored but Asset/AssetVersion bucket references were NOT rewritten — do not assume Review is fully usable."

    log "  Restarting Review web/worker"
    review_compose start web worker
    REVIEW_WEB_WORKER_STOPPED=0
  fi
  log "[5/7] Bucket references rewritten; Postgres sync stage complete"
else
  log "[5/7] Skipped (--minio-only)"
fi

# =============================================================================
# [6/7] Mirror MinIO (Dev bucket -> Review bucket)
# =============================================================================
if [[ "${RUN_MINIO}" -eq 1 ]]; then
  log "[6/7] Comparing MinIO objects: Dev bucket '${dev_minio_bucket}' vs Review bucket '${review_minio_bucket}'"

  umask 077
  {
    printf 'MC_HOST_dev=http://%s:%s@host.docker.internal:%s\n' "${dev_minio_access_key}" "${dev_minio_secret_key}" "${dev_minio_host_port}"
    printf 'MC_HOST_review=http://%s:%s@host.docker.internal:%s\n' "${review_minio_access_key}" "${review_minio_secret_key}" "${review_minio_host_port}"
  } > "${MC_ENV_FILE}"
  chmod 600 "${MC_ENV_FILE}"

  docker pull "${MC_IMAGE}" >/dev/null 2>&1 || fatal "failed to pull ${MC_IMAGE} — check network/registry access"

  mc_run() {
    docker run --rm --add-host=host.docker.internal:host-gateway \
      --env-file "${MC_ENV_FILE}" "${MC_IMAGE}" "$@"
  }

  # Verify source/target buckets explicitly rather than letting a missing
  # bucket masquerade as "0 objects" (mc ls -r against a nonexistent bucket
  # and against an existing-but-empty bucket both print nothing).
  #
  # A failed `mc stat` is only treated as "bucket does not exist" when mc
  # itself says so. Any other failure (transient network hiccup on a
  # cold-started helper container, auth error, etc.) is a hard error — it
  # must NOT be silently reinterpreted as "nothing to mirror", which would
  # make the script falsely report success while copying nothing.
  check_bucket_exists() {
    local target="$1" output
    if output=$(mc_run stat "${target}" 2>&1); then
      return 0
    fi
    if grep -qi "does not exist" <<<"${output}"; then
      return 1
    fi
    fatal "Could not determine whether bucket '${target}' exists (not a clean 404): ${output}"
  }

  dev_bucket_exists=1
  check_bucket_exists "dev/${dev_minio_bucket}" || dev_bucket_exists=0
  review_bucket_exists=1
  check_bucket_exists "review/${review_minio_bucket}" || review_bucket_exists=0

  if [[ "${dev_bucket_exists}" -eq 0 ]]; then
    log "  Dev bucket '${dev_minio_bucket}' does not exist — nothing to mirror (no assets uploaded/exported in Dev yet)."
  fi

  if [[ "${review_bucket_exists}" -eq 0 ]]; then
    if [[ "${DRY_RUN}" -eq 1 ]]; then
      log "  [dry-run] Review bucket '${review_minio_bucket}' does not exist — would create it before mirroring."
    else
      log "  Review bucket '${review_minio_bucket}' does not exist — creating it."
      mc_run mb --ignore-existing "review/${review_minio_bucket}" \
        || fatal "failed to create Review bucket '${review_minio_bucket}'"
      review_bucket_exists=1
    fi
  fi

  if [[ "${dev_bucket_exists}" -eq 1 ]]; then
    dev_object_count=$(mc_run ls -r "dev/${dev_minio_bucket}" 2>/dev/null | wc -l | tr -d '[:space:]')
  else
    dev_object_count=0
  fi
  if [[ "${review_bucket_exists}" -eq 1 ]]; then
    review_object_count=$(mc_run ls -r "review/${review_minio_bucket}" 2>/dev/null | wc -l | tr -d '[:space:]')
  else
    review_object_count=0
  fi

  log "  Dev objects: ${dev_object_count}"
  log "  Review objects: ${review_object_count}"

  if [[ "${dev_bucket_exists}" -eq 1 && ( "${review_bucket_exists}" -eq 1 || "${DRY_RUN}" -eq 1 ) ]]; then
    log ""
    log "  Planned mirror actions (dry-run preview):"
    mc_run mirror --dry-run --overwrite --remove "dev/${dev_minio_bucket}" "review/${review_minio_bucket}" || true

    if [[ "${DRY_RUN}" -eq 1 ]]; then
      log ""
      log "  [dry-run] no objects were uploaded, overwritten, or deleted"
    else
      log ""
      log "  Proceeding with real mirror (overwrite + delete extras)..."
      set +e
      mc_run mirror --overwrite --remove "dev/${dev_minio_bucket}" "review/${review_minio_bucket}"
      mirror_exit=$?
      set -e
      if [[ ${mirror_exit} -ne 0 ]]; then
        fatal "mc mirror failed (exit ${mirror_exit}). Postgres sync (if it ran) already completed successfully; MinIO is now in a PARTIAL or unsynced state. Re-run with --minio-only after investigating."
      fi

      # A zero exit code from `mc mirror` is not, on its own, trustworthy
      # proof that objects actually moved — a transient listing glitch on a
      # cold-started helper container can make mc report "nothing to do"
      # without erroring. Re-list both sides post-mirror and require an
      # exact match; this is what an "exact mirror" actually means and is
      # cheap to verify.
      dev_object_count_after=$(mc_run ls -r "dev/${dev_minio_bucket}" 2>/dev/null | wc -l | tr -d '[:space:]')
      review_object_count_after=$(mc_run ls -r "review/${review_minio_bucket}" 2>/dev/null | wc -l | tr -d '[:space:]')
      log "  Post-mirror object counts: Dev=${dev_object_count_after} Review=${review_object_count_after}"
      if [[ "${dev_object_count_after}" != "${review_object_count_after}" ]]; then
        fatal "Post-mirror verification failed: Dev has ${dev_object_count_after} objects but Review has ${review_object_count_after} after mirroring. mc reported success but the buckets do not match — re-run with --minio-only."
      fi
    fi
  else
    log "  Skipping mirror: Dev bucket does not exist, nothing to copy."
  fi
  log "[6/7] MinIO mirror stage complete"
else
  log "[6/7] Skipped (--postgres-only)"
fi

# =============================================================================
# [7/7] Validate
# =============================================================================
log "[7/7] Validating: comparing row counts across all public-schema tables"

table_list_sql="SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name;"

dev_tables=$(dev_compose exec -T -e PGPASSWORD="${dev_pg_password}" postgres \
  psql -U "${dev_pg_user}" -d "${dev_pg_db}" -t -A -c "${table_list_sql}" < /dev/null | tr -d '\r')
review_tables=$(review_compose exec -T -e PGPASSWORD="${review_pg_password}" postgres \
  psql -U "${review_pg_user}" -d "${review_pg_db}" -t -A -c "${table_list_sql}" < /dev/null | tr -d '\r')

all_tables=$(printf '%s\n%s\n' "${dev_tables}" "${review_tables}" | sed '/^$/d' | sort -u)

log ""
printf '%-30s %12s %12s %10s\n' "TABLE" "DEV COUNT" "REVIEW CT" "STATUS"
mismatch_found=0
# Named tables the user specifically asked to be called out. TextAsset was
# renamed from TextDocument by migration
# 20260817000000_rename_text_document_to_text_asset.
named_tables="User Dataset Asset Annotation Label Job JobEvent ImageAsset VideoAsset AudioAsset TextAsset SourceConnection AiTask AiModel"
named_summary=""

for t in ${all_tables}; do
  dev_count=$(dev_compose exec -T -e PGPASSWORD="${dev_pg_password}" postgres \
    psql -U "${dev_pg_user}" -d "${dev_pg_db}" -t -A -c "SELECT count(*) FROM \"${t}\";" < /dev/null 2>/dev/null | tr -d '\r' || echo "N/A")
  review_count=$(review_compose exec -T -e PGPASSWORD="${review_pg_password}" postgres \
    psql -U "${review_pg_user}" -d "${review_pg_db}" -t -A -c "SELECT count(*) FROM \"${t}\";" < /dev/null 2>/dev/null | tr -d '\r' || echo "N/A")
  status="ok"
  if [[ "${RUN_POSTGRES}" -eq 1 && "${DRY_RUN}" -eq 0 && "${dev_count}" != "${review_count}" ]]; then
    status="MISMATCH"
    mismatch_found=1
  fi
  printf '%-30s %12s %12s %10s\n' "${t}" "${dev_count}" "${review_count}" "${status}"
  if [[ " ${named_tables} " == *" ${t} "* ]]; then
    named_summary="${named_summary}  ${t}: Dev=${dev_count} Review=${review_count}\n"
  fi
done

if [[ -n "${named_summary}" ]]; then
  log ""
  log "Named application tables:"
  printf '%b' "${named_summary}"
fi

log ""
log "NOTE: SourceConnection rows (if any) store credentials encrypted with"
log "SOURCE_CONNECTION_ENCRYPTION_KEY, which differs between .env and .env.review."
log "Any copied SourceConnection rows will NOT decrypt correctly under Review's key."
log "This script does not attempt to re-encrypt them — treat such rows as broken"
log "until manually recreated in Review."
log ""
log "NOTE: --skip-confirmation was deliberately not implemented; there is no"
log "existing repo convention for it and this workflow prefers explicit typed"
log "confirmation."

if [[ "${RUN_POSTGRES}" -eq 1 && "${DRY_RUN}" -eq 0 && "${mismatch_found}" -eq 1 ]]; then
  fatal "row-count mismatch(es) detected after restore — see table above. Not declaring success."
fi

log ""
log "[✓] Synchronization complete"
