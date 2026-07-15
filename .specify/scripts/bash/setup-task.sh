#!/usr/bin/env bash
# Linux/macOS equivalent of ../powershell/setup-tasks.ps1.
set -euo pipefail

json=false

usage() {
  printf '%s\n' 'Usage: setup-task.sh [--json] [--help]'
}

for argument in "$@"; do
  case "$argument" in
    --json|-Json) json=true ;;
    --help|-Help|-h) usage; exit 0 ;;
    *) printf 'ERROR: Unknown option: %s\n' "$argument" >&2; usage >&2; exit 2 ;;
  esac
done

find_root() {
  local dir="${SPECIFY_INIT_DIR:-$PWD}"
  dir="$(cd "$dir" && pwd)"
  while [[ "$dir" != "/" ]]; do
    [[ -d "$dir/.specify" ]] && { printf '%s\n' "$dir"; return; }
    dir="$(dirname "$dir")"
  done
  printf 'ERROR: Not a Spec Kit project (no .specify directory found).\n' >&2
  exit 1
}

repo_root="$(find_root)"
feature_dir="${SPECIFY_FEATURE_DIRECTORY:-}"
if [[ -z "$feature_dir" ]]; then
  feature_json="$repo_root/.specify/feature.json"
  if [[ ! -f "$feature_json" ]]; then
    printf 'ERROR: Feature directory not found. Set SPECIFY_FEATURE_DIRECTORY or create .specify/feature.json.\n' >&2
    exit 1
  fi
  feature_dir="$(node -e 'const fs=require("fs"); const value=JSON.parse(fs.readFileSync(process.argv[1], "utf8")).feature_directory; if (!value) process.exit(2); process.stdout.write(value)' "$feature_json")" || {
    printf 'ERROR: Failed to read feature_directory from .specify/feature.json.\n' >&2
    exit 1
  }
fi
[[ "$feature_dir" = /* ]] || feature_dir="$repo_root/$feature_dir"
feature_dir="$(cd "$feature_dir" 2>/dev/null && pwd)" || {
  printf 'ERROR: Feature directory not found: %s\n' "$feature_dir" >&2
  exit 1
}

for required in plan.md spec.md; do
  if [[ ! -f "$feature_dir/$required" ]]; then
    printf 'ERROR: %s not found in %s\n' "$required" "$feature_dir" >&2
    exit 1
  fi
done

# The standard override → core resolution used by this repository. Preset and
# extension templates remain opt-in; their directories are checked first when
# present without interpreting their configuration.
template=""
for candidate in \
  "$repo_root/.specify/templates/overrides/tasks-template.md" \
  "$repo_root/.specify/templates/tasks-template.md"; do
  [[ -f "$candidate" ]] && { template="$candidate"; break; }
done
if [[ -z "$template" ]]; then
  printf 'ERROR: Tasks template not found under .specify/templates/.\n' >&2
  exit 1
fi

docs=()
[[ -f "$feature_dir/research.md" ]] && docs+=(research.md)
[[ -f "$feature_dir/data-model.md" ]] && docs+=(data-model.md)
[[ -d "$feature_dir/contracts" ]] && [[ -n "$(find "$feature_dir/contracts" -mindepth 1 -print -quit)" ]] && docs+=(contracts/)
[[ -f "$feature_dir/quickstart.md" ]] && docs+=(quickstart.md)

if "$json"; then
  node -e 'process.stdout.write(JSON.stringify({FEATURE_DIR:process.argv[1],AVAILABLE_DOCS:process.argv.slice(3),TASKS_TEMPLATE:process.argv[2]}))' \
    "$feature_dir" "$template" "${docs[@]}"
  printf '\n'
else
  printf 'FEATURE_DIR: %s\nTASKS_TEMPLATE: %s\nAVAILABLE_DOCS:\n' "$feature_dir" "$template"
  printf '  %s\n' "${docs[@]}"
fi
