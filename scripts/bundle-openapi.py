#!/usr/bin/env python3
"""Bundle specs/api/openapi.yaml + specs/api/schemas/*.yaml into one
self-contained document: specs/api/dist/openapi.bundle.yaml.

The source document is deliberately split into multiple files for
maintainability (see specs/api/README.md); a bundle with every relative
`$ref` resolved into a single file is what most standalone tools (a static
Swagger UI page, editor.swagger.io, a colleague's own tooling) expect. This
script performs pure, mechanical $ref rewriting -- it does not add, remove,
or alter any documented path, schema, or field. Re-run this after any change
to specs/api/openapi.yaml or specs/api/schemas/*.yaml; the bundle is a build
artifact (see .gitignore) and is not itself the source of truth.

Uses the system python3 + PyYAML rather than a Node/npm bundler package
(@redocly/cli, swagger-cli, ...), per AGENTS.md's "do not add npm packages
without explicit permission" -- consistent with scripts/validate-openapi.py.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

try:
    import yaml
except ImportError:
    print("PyYAML is required (system python3 -m pip install pyyaml).", file=sys.stderr)
    sys.exit(2)

REPO_ROOT = Path(__file__).resolve().parents[1]
SPEC_DIR = REPO_ROOT / "specs" / "api"
SCHEMAS_DIR = SPEC_DIR / "schemas"
OPENAPI_FILE = SPEC_DIR / "openapi.yaml"
OUTPUT_DIR = SPEC_DIR / "dist"
OUTPUT_FILE = OUTPUT_DIR / "openapi.bundle.yaml"

# Matches "./schemas/X.yaml#/Y" (from openapi.yaml) or "./X.yaml#/Y" (from a
# schemas/*.yaml file, cross-file) or "#/Y" (from within a schemas/*.yaml
# file, same-file). Already-global "#/components/schemas/Y" refs (used in
# openapi.yaml's paths) are left untouched by construction: the pattern below
# never matches a ref that already starts with "#/components/".
LOCAL_REF_RE = re.compile(r"^(?:\./(?:schemas/)?([A-Za-z0-9_.-]+)\.yaml)?#/([A-Za-z0-9_]+)$")


def load_yaml(path: Path) -> dict:
    with path.open("r", encoding="utf-8") as handle:
        return yaml.safe_load(handle)


def rewrite_refs(node):
    """Recursively rewrites every local/relative $ref into the single global
    '#/components/schemas/<Name>' form used by the bundle."""
    if isinstance(node, dict):
        out = {}
        for key, value in node.items():
            if key == "$ref" and isinstance(value, str):
                match = LOCAL_REF_RE.match(value)
                if match:
                    out[key] = f"#/components/schemas/{match.group(2)}"
                    continue
            out[key] = rewrite_refs(value)
        return out
    if isinstance(node, list):
        return [rewrite_refs(item) for item in node]
    return node


def main() -> int:
    spec = load_yaml(OPENAPI_FILE)

    schema_files = sorted(SCHEMAS_DIR.glob("*.yaml"))
    merged_schemas: dict[str, object] = {}
    for path in schema_files:
        doc = load_yaml(path)
        for name, definition in doc.items():
            if name in merged_schemas:
                print(f"FATAL: duplicate schema name '{name}' also defined in an earlier file.", file=sys.stderr)
                return 1
            merged_schemas[name] = definition

    # Rewrite $refs everywhere: inside every merged schema definition, and
    # throughout the root document (paths, existing components.responses,
    # etc). The root document's own components.schemas -- currently a set of
    # single-entry $ref pointers into schemas/*.yaml -- is discarded and
    # replaced wholesale by the fully-resolved merged_schemas map below.
    bundled_schemas = rewrite_refs(merged_schemas)
    bundled_spec = rewrite_refs(spec)
    bundled_spec.setdefault("components", {})["schemas"] = bundled_schemas

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    with OUTPUT_FILE.open("w", encoding="utf-8") as handle:
        handle.write("# GENERATED FILE -- do not edit by hand.\n")
        handle.write("# Produced by scripts/bundle-openapi.py from specs/api/openapi.yaml and\n")
        handle.write("# specs/api/schemas/*.yaml. Re-run that script after editing the source files.\n")
        yaml.safe_dump(bundled_spec, handle, sort_keys=False, allow_unicode=True, width=100)

    print(f"Bundled {len(schema_files)} schema file(s), {len(bundled_schemas)} schema(s) -> {OUTPUT_FILE.relative_to(REPO_ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
