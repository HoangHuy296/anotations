import { NextResponse } from "next/server";
import { revokeSession } from "@/lib/auth";
export async function POST() { await revokeSession(); const response = new NextResponse(null, { status: 204, headers: { "Cache-Control": "no-store" } }); response.cookies.set("fieldframe_session", "", { httpOnly: true, path: "/", expires: new Date(0), sameSite: "lax" }); return response; }
