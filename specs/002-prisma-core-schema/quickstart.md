# Phase 2 Validation Guide

Planning is read-only. No commands are required in this phase.

After explicit implementation approval, validate with `pnpm exec prisma validate`, apply the approved migration in the private Compose network, generate the client, and verify: nullable dataset/label modality, required asset fingerprint/modality, encrypted source credentials only, annotation geometry/version, common Job plus four queue fields, and absence of specialized Job models.
