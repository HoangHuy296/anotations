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

/** The live video/tracking model of the same canonical service (catalog `type: video`, `task_name: tracking`). */
export const SANCTIONED_AIOZ_TRACKING_REGISTRATION = Object.freeze({
  provider: "aioz-company",
  key: "cb29e022-1ba7-4349-9dce-4fb3074e84d6",
  displayName: "ByteTrack YOLOX_S COCO",
  modality: "VIDEO",
  taskType: "TRACKING",
} as const);

export const SANCTIONED_AIOZ_REGISTRATIONS = Object.freeze([SANCTIONED_AIOZ_REGISTRATION, SANCTIONED_AIOZ_TRACKING_REGISTRATION]);

export class RegistrationNotSanctionedError extends Error {
  constructor() { super("REGISTRATION_NOT_SANCTIONED"); this.name = "RegistrationNotSanctionedError"; }
}

/** `--apply <uuid> <name>` must name exactly one sanctioned model; anything else fails closed before any database access. */
export function requireSanctionedRegistration(argv: readonly string[]) {
  const [flag, key, displayName, ...extra] = argv;
  const match = SANCTIONED_AIOZ_REGISTRATIONS.find((entry) => entry.key === key && entry.displayName === displayName);
  if (flag !== "--apply" || extra.length || !match) throw new RegistrationNotSanctionedError();
  return match;
}
