/**
 * A2 foundation: whether a private processor for `VERIFY_UPLOADED_MEDIA` is registered. It is NOT in this increment, so the router refuses (skips, before any claim)
 * a delivery of that type instead of claiming a Job it cannot process. The A2 runtime increment flips this together with its processor, router branch and tests.
 */
export const MEDIA_VERIFICATION_PROCESSOR_REGISTERED: boolean = false;
