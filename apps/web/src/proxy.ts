import { timingSafeEqual } from "node:crypto";

import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

const DEFAULT_EMAIL_HEADER = "x-auth-request-email";
const DEFAULT_SECRET_HEADER = "x-fieldframe-proxy-secret";
const INTERNAL_EMAIL_HEADER = "x-fieldframe-auth-email";
const INTERNAL_VERIFIED_HEADER = "x-fieldframe-proxy-verified";
const DEFAULT_DEVELOPMENT_EMAIL = "developer@localhost";

function secureEquals(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}

function unauthorized(request: NextRequest, configurationError = false) {
  if (request.nextUrl.pathname.startsWith("/api/")) {
    return NextResponse.json(
      {
        error: {
          code: configurationError ? "AUTH_CONFIGURATION_ERROR" : "AUTH_REQUIRED",
          message: configurationError
            ? "Authentication is not configured."
            : "Authentication is required.",
        },
      },
      {
        status: configurationError ? 503 : 401,
        headers: {
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        },
      },
    );
  }

  const url = request.nextUrl.clone();
  url.pathname = "/unauthorized";
  url.search = configurationError ? "?reason=configuration" : "";
  return NextResponse.redirect(url);
}

export function proxy(request: NextRequest) {
  if (request.nextUrl.pathname === "/api/health") {
    return NextResponse.next();
  }

  const emailHeader =
    process.env.AUTH_EMAIL_HEADER?.trim().toLowerCase() ??
    DEFAULT_EMAIL_HEADER;
  const secretHeader =
    process.env.AUTH_PROXY_SECRET_HEADER?.trim().toLowerCase() ??
    DEFAULT_SECRET_HEADER;
  const developmentEmail =
    process.env.NODE_ENV !== "production"
      ? process.env.DEV_AUTH_EMAIL?.trim().toLowerCase()
      : undefined;

  let email: string | null = null;

  if (process.env.NODE_ENV === "production") {
    const configuredSecret = process.env.AUTH_PROXY_SECRET;
    const suppliedSecret = request.headers.get(secretHeader);
    const suppliedEmail = request.headers.get(emailHeader)?.trim().toLowerCase();

    if (!configuredSecret) {
      return unauthorized(request, true);
    }

    if (
      !suppliedSecret ||
      !secureEquals(suppliedSecret, configuredSecret) ||
      !suppliedEmail
    ) {
      return unauthorized(request);
    }

    email = suppliedEmail;
  } else {
    email =
      request.headers.get(emailHeader)?.trim().toLowerCase() ??
      developmentEmail ??
      DEFAULT_DEVELOPMENT_EMAIL;
  }

  const requestHeaders = new Headers(request.headers);
  requestHeaders.delete(emailHeader);
  requestHeaders.delete(secretHeader);
  requestHeaders.delete(INTERNAL_EMAIL_HEADER);
  requestHeaders.delete(INTERNAL_VERIFIED_HEADER);
  requestHeaders.set(INTERNAL_EMAIL_HEADER, email);
  requestHeaders.set(INTERNAL_VERIFIED_HEADER, "1");

  return NextResponse.next({
    request: {
      headers: requestHeaders,
    },
  });
}

export const config = {
  matcher: [
    "/dashboard/:path*",
    "/datasets/:path*",
    "/imports/:path*",
    "/labels/:path*",
    "/exports/:path*",
    "/workspace/:path*",
    "/api/:path*",
  ],
};
