#!/usr/bin/env bash
set -euo pipefail

# Prisma 6.19.3 emits a small number of whitespace-only documentation lines.
# Keep generated output tracked while making the repository check deterministic.
find lib/generated/prisma -type f -name '*.ts' -print0 |
  xargs -0 sed -i 's/[[:blank:]]\+$//'
