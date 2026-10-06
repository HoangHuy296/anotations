/**
 * The only registration this operator utility may perform under a G1 receipt. The scope is exact (no wildcard model, provider or capability): the
 * canonical MVP AI service `10.0.0.186:7000` returns this one IMAGE/detection model. Replacing it is a reviewed change to this constant AND to the
 * pinned `seed:register-aioz-model:yolo26s-coco` catalog entry, never a command-line or environment choice.
 */
export const SANCTIONED_AIOZ_REGISTRATION = Object.freeze({
  provider: "aioz-company",
  key: "68d7f474-6982-446c-8c5a-121d56d12dc9",
  displayName: "YOLO26s_COCO",
  modality: "IMAGE",
  taskType: "DETECTION",
} as const);

export class RegistrationNotSanctionedError extends Error {
  constructor() { super("REGISTRATION_NOT_SANCTIONED"); this.name = "RegistrationNotSanctionedError"; }
}

/** `--apply <uuid> <name>` must name exactly the sanctioned model; anything else fails closed before any database access. */
export function requireSanctionedRegistration(argv: readonly string[]) {
  const [flag, key, displayName, ...extra] = argv;
  if (flag !== "--apply" || extra.length || key !== SANCTIONED_AIOZ_REGISTRATION.key || displayName !== SANCTIONED_AIOZ_REGISTRATION.displayName) throw new RegistrationNotSanctionedError();
  return SANCTIONED_AIOZ_REGISTRATION;
}
