#!/usr/bin/env python3
"""Validate specs/api/openapi.yaml against the actual Next.js route inventory.

This intentionally avoids adding a Node/npm dependency (see AGENTS.md's "do not add
npm packages without explicit permission") by using the system Python 3 + PyYAML
instead of a JS OpenAPI-parser package. It performs:

  1. YAML syntax validation for openapi.yaml and every schemas/*.yaml file it $refs.
  2. Structural checks: openapi version, required tags present.
  3. Dangling-$ref check across the split schema files.
  4. Route-inventory cross-check: every documented path+method must correspond to an
     actual `export function <METHOD>` / `export async function <METHOD>` in a
     apps/web/src/app/api/**/route.ts file, and vice versa is reported (routes that
     exist but are not documented are listed as "excluded", not failed -- this repo's
     API surface is intentionally larger than this initial documentation pass).
  5. Specific assertions required by the task: the Asset-scoped annotation path
     exists with GET+PUT, and a flattened /api/annotations path does NOT appear.

Exit code is non-zero if any hard check fails.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

try:
    import yaml
except ImportError:
    print("PyYAML is required to run this script (system python3 -m pip install pyyaml).", file=sys.stderr)
    sys.exit(2)

REPO_ROOT = Path(__file__).resolve().parents[1]
SPEC_DIR = REPO_ROOT / "specs" / "api"
OPENAPI_FILE = SPEC_DIR / "openapi.yaml"
API_ROUTES_DIR = REPO_ROOT / "apps" / "web" / "src" / "app" / "api"

REQUIRED_TAGS = {
    "Authentication", "Assets", "Annotations", "AI", "Jobs", "Dataset", "Labels",
    "Import / Repository", "Media",
}
METHOD_RE = re.compile(r"export\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\s*\(")
REF_RE = re.compile(r"\$ref:\s*['\"]?([^'\"\s]+)['\"]?")

failures: list[str] = []
notes: list[str] = []


def fail(message: str) -> None:
    failures.append(message)


def note(message: str) -> None:
    notes.append(message)


# --- 1. YAML syntax ---------------------------------------------------------

def load_yaml(path: Path) -> dict:
    try:
        with path.open("r", encoding="utf-8") as handle:
            return yaml.safe_load(handle)
    except yaml.YAMLError as error:
        fail(f"YAML syntax error in {path.relative_to(REPO_ROOT)}: {error}")
        return {}


if not OPENAPI_FILE.exists():
    print(f"FATAL: {OPENAPI_FILE} does not exist.", file=sys.stderr)
    sys.exit(2)

spec = load_yaml(OPENAPI_FILE)

schema_files = {p.name: load_yaml(p) for p in sorted((SPEC_DIR / "schemas").glob("*.yaml"))}

# --- 2. Structural checks ----------------------------------------------------

version = spec.get("openapi", "")
if not version.startswith("3.1"):
    fail(f"openapi version is {version!r}, expected 3.1.x")

declared_tags = {tag.get("name") for tag in spec.get("tags", [])}
missing_tags = REQUIRED_TAGS - declared_tags
if missing_tags:
    fail(f"Missing required tags: {sorted(missing_tags)}")

extra_tags = declared_tags - REQUIRED_TAGS
if extra_tags:
    note(f"Tags beyond the required set were declared: {sorted(extra_tags)} (only fail if unjustified by the route inventory).")

security_schemes = spec.get("components", {}).get("securitySchemes", {})
session_cookie = security_schemes.get("sessionCookie", {})
if session_cookie.get("type") != "apiKey" or session_cookie.get("in") != "cookie":
    fail("sessionCookie security scheme must be type=apiKey, in=cookie (matches the actual cookie-based session mechanism).")
if session_cookie.get("name") != "fieldframe_session":
    fail(f"sessionCookie name is {session_cookie.get('name')!r}, expected 'fieldframe_session' (apps/web/src/lib/auth.ts SESSION_COOKIE).")

# --- 3. Dangling $ref check across split schema files ------------------------

def resolve_target(ref: str, from_dir: Path) -> tuple[Path, str] | None:
    if "#/" not in ref:
        return None
    file_part, pointer = ref.split("#/", 1)
    target_path = (from_dir / file_part).resolve() if file_part else None
    return target_path, pointer


def check_refs_in(obj, source_dir: Path, source_label: str) -> None:
    if isinstance(obj, dict):
        for key, value in obj.items():
            if key == "$ref" and isinstance(value, str) and value.startswith("./"):
                resolved = resolve_target(value, source_dir)
                if resolved is None:
                    continue
                target_path, pointer = resolved
                if not target_path.exists():
                    fail(f"{source_label}: $ref target file does not exist: {value}")
                    continue
                target_doc = schema_files.get(target_path.name)
                if target_doc is None:
                    target_doc = load_yaml(target_path)
                top_key = pointer.split("/", 1)[0]
                if top_key not in target_doc:
                    fail(f"{source_label}: $ref {value} points at missing key '{top_key}' in {target_path.name}")
            else:
                check_refs_in(value, source_dir, source_label)
    elif isinstance(obj, list):
        for item in obj:
            check_refs_in(item, source_dir, source_label)


check_refs_in(spec, SPEC_DIR, "openapi.yaml")
for name, doc in schema_files.items():
    check_refs_in(doc, SPEC_DIR / "schemas", f"schemas/{name}")

# --- 4. Route-inventory cross-check ------------------------------------------

def next_path_to_openapi(route_file: Path) -> str:
    rel = route_file.relative_to(API_ROUTES_DIR).parent
    parts = ["api"] + list(rel.parts)
    converted = []
    for part in parts:
        if part.startswith("[") and part.endswith("]"):
            converted.append("{" + part[1:-1] + "}")
        else:
            converted.append(part)
    return "/" + "/".join(converted)


actual_routes: dict[str, set[str]] = {}
for route_file in API_ROUTES_DIR.rglob("route.ts"):
    path = next_path_to_openapi(route_file)
    methods = set(METHOD_RE.findall(route_file.read_text(encoding="utf-8")))
    actual_routes.setdefault(path, set()).update(methods)

documented_paths: dict[str, set[str]] = {}
for path, operations in (spec.get("paths") or {}).items():
    methods = {m.upper() for m in operations.keys() if m.lower() in {"get", "post", "put", "patch", "delete"}}
    documented_paths[path] = methods

for path, methods in documented_paths.items():
    if path not in actual_routes:
        fail(f"Documented path {path} does not correspond to any apps/web/src/app/api route file.")
        continue
    missing_methods = methods - actual_routes[path]
    if missing_methods:
        fail(f"Documented path {path} declares methods {sorted(missing_methods)} that the route file does not export.")

undocumented = sorted(set(actual_routes) - set(documented_paths))
if undocumented:
    note(f"{len(undocumented)} actual route(s) are not documented in this pass (expected -- see report for the excluded-route rationale): {undocumented}")

# --- 5. Task-specific assertions ---------------------------------------------

ANNOTATIONS_PATH = "/api/assets/{assetId}/annotations"
if ANNOTATIONS_PATH not in documented_paths:
    fail(f"{ANNOTATIONS_PATH} must be documented.")
elif documented_paths[ANNOTATIONS_PATH] != {"GET", "PUT"}:
    fail(f"{ANNOTATIONS_PATH} must document exactly GET and PUT, found {sorted(documented_paths[ANNOTATIONS_PATH])}.")

if "/api/annotations" in documented_paths:
    fail("/api/annotations must NOT be documented -- no such route exists in the repository.")

if "/api/annotations" in actual_routes:
    fail("Unexpected: a /api/annotations route now exists in the repository but this script's assumptions were not updated.")

# --- report --------------------------------------------------------------

print(f"Checked {OPENAPI_FILE.relative_to(REPO_ROOT)} against {len(actual_routes)} actual route file(s).")
print(f"Documented paths: {len(documented_paths)}")

for message in notes:
    print(f"NOTE: {message}")

if failures:
    print(f"\n{len(failures)} FAILURE(S):")
    for message in failures:
        print(f" - {message}")
    sys.exit(1)

print("\nOK: OpenAPI document is internally consistent and matches the route inventory.")
