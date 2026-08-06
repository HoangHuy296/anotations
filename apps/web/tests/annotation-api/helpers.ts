/**
 * Phase 017 fixtures deliberately reuse the existing password-enabled User
 * helpers. HTTP suites must still authenticate through /api/auth/login; this
 * module never creates a session bypass.
 */
export {
  addWorkspaceMember as addAnnotationMember,
  cleanupWorkspaceFixture as cleanupAnnotationFixture,
  createImageAsset as createAnnotationAsset,
  createImageLabel as createAnnotationLabel,
  createWorkspaceDataset as createAnnotationDataset,
  createWorkspaceUser as createAnnotationUser,
  createWorkspaceSessionPair as createAnnotationSessionPair,
  loginThroughHttp as loginAnnotationThroughHttp,
} from "../workspace/helpers";
