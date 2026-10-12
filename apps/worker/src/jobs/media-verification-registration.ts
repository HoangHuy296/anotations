import type { VerifierDeps } from "../verification/types.js";

/**
 * A2.4: a `VERIFY_UPLOADED_MEDIA` processor is registered only when the verifier dependencies exist, which requires `MEDIA_VERIFICATION_ENABLED=1` AND a ready,
 * distinct I-VERIFIER identity (see `readiness.ts`). Otherwise the router refuses (skips, before any claim) a delivery of that type instead of claiming a Job it
 * cannot process, so such a Job can never be left RUNNING by a worker that lacks the sealed-namespace authority.
 */
export const isMediaVerificationProcessorRegistered = (verifier: VerifierDeps | null | undefined): verifier is VerifierDeps => Boolean(verifier);
