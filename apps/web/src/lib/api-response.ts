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
  | "DATASET_NOT_FOUND"
  | "JOB_NOT_FOUND"
  | "JOB_CONFLICT"
  | "IMPORT_INCOMPLETE"
  | "IMPORT_COMMIT_TIMEOUT"
  | "IMPORT_PREPARATION_CONFLICT"
  | "IDEMPOTENCY_KEY_CONFLICT"
  | "SOURCE_URL_UNSAFE"
  | "SOURCE_DESTINATION_NOT_ALLOWED"
  | "SOURCE_ROOT_PATH_UNSAFE"
  | "SOURCE_IMPORT_LIMIT_EXCEEDED"
  | "SOURCE_CONNECTION_UNSUPPORTED"
  | "SOURCE_CONNECTION_EXISTS"
  | "SOURCE_TOKEN_EXPIRED"
  | "SOURCE_TOKEN_INVALID"
  | "SOURCE_PROVIDER_UNAVAILABLE"
  | "SOURCE_CONNECTION_IN_USE"
  | "SOURCE_CONNECTION_NOT_FOUND"
  | "UNSUPPORTED_PROVIDER"
  | "UNSAFE_REPOSITORY_URL"
  | "REPOSITORY_NOT_FOUND"
  | "REPOSITORY_ACCESS_DENIED"
  | "REF_NOT_FOUND"
  | "ROOT_PATH_NOT_FOUND"
  | "ONE_TIME_PAT_REQUIRES_SAVE_FOR_ASYNC_IMPORT"
  | "GITEA_IMPORT_DEPRECATED"
  | "SOURCE_IMPORT_JOBS_DEPRECATED"
  | "IMAGE_CONTENT_DEPRECATED"
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
