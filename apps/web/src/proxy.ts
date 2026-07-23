import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getActorFromSessionToken } from "@/lib/auth";
import { safeReturnTarget } from "@/lib/auth-redirect";

const publicApi = new Set(["/api/health", "/api/auth/signup", "/api/auth/login", "/api/auth/logout", "/api/auth/refresh", "/api/auth/me"]);
export async function proxy(request: NextRequest) {
  if (publicApi.has(request.nextUrl.pathname)) return NextResponse.next();
  const token = request.cookies.get("fieldframe_session")?.value;
  if (token && await getActorFromSessionToken(token)) return NextResponse.next();
  if (request.nextUrl.pathname.startsWith("/api/")) return NextResponse.json({ error: { code: "AUTH_REQUIRED", message: "Authentication is required." } }, { status: 401, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
  const url = request.nextUrl.clone();
  url.pathname = "/login";
  url.search = "";
  const target = safeReturnTarget(`${request.nextUrl.pathname}${request.nextUrl.search}`);
  url.searchParams.set("returnTo", target);
  return NextResponse.redirect(url);
}
export const config = { matcher: ["/dashboard/:path*", "/datasets/:path*", "/labels/:path*", "/exports/:path*", "/workspace/:path*", "/account/:path*", "/api/:path*"] };
