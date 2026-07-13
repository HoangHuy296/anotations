import { NextResponse } from "next/server";

import { getWebReadiness } from "@/lib/readiness";

export const dynamic = "force-dynamic";

export async function GET() {
  const status = await getWebReadiness();
  return NextResponse.json(
    { status },
    { status: status === "ready" ? 200 : 503 },
  );
}
