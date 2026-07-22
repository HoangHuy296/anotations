import { NextResponse } from "next/server";

export type ApiErrorCode =
  | "AUTH_REQUIRED"
  | "FORBIDDEN"
  | "INVALID_REQUEST"
  | "GITEA_CONFIGURATION_ERROR"
  | "GITEA_UNAVAILABLE"
  | "GITEA_NOT_FOUND"
  | "GITEA_RATE_LIMITED"
  | "GITEA_RESPONSE_INVALID"
  | "UPLOAD_CONFLICT"
  | "UPLOAD_NOT_READY"
  | "UNSUPPORTED_MEDIA"
  | "INVALID_MEDIA"
  | "ASSET_UNAVAILABLE"
  | "JOB_NOT_FOUND"
  | "JOB_CONFLICT"
  | "IMPORT_INCOMPLETE"
  | "IMPORT_COMMIT_TIMEOUT"
  | "IMPORT_PREPARATION_CONFLICT"
  | "INTERNAL_ERROR";

export function apiError(
  status: number,
  code: ApiErrorCode,
  message: string,
  fieldErrors?: Record<string, string[]>,
) {
  return NextResponse.json(
    {
      error: {
        code,
        message,
        ...(fieldErrors ? { fieldErrors } : {}),
      },
    },
    {
      status,
      headers: {
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    },
  );
}

export function apiSuccess<T>(data: T, init?: ResponseInit) {
  const headers = new Headers(init?.headers);
  headers.set("Cache-Control", "no-store");
  headers.set("X-Content-Type-Options", "nosniff");

  return NextResponse.json(
    { data },
    {
      ...init,
      headers,
    },
  );
}
