import { NextRequest, NextResponse } from "next/server";
import { getSnapshot } from "@/lib/party";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const u = req.nextUrl.searchParams.get("u");
  const snapshot = await getSnapshot(u);
  return NextResponse.json(snapshot, {
    headers: { "Cache-Control": "no-store" },
  });
}
