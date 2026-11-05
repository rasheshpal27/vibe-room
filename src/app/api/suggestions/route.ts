import { NextRequest, NextResponse } from "next/server";
import { buildSongSuggestions } from "@/lib/suggestions";
import { searchSongs } from "@/lib/youtube";
import type { SongResult } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const artist = (req.nextUrl.searchParams.get("artist") ?? "").trim();
  const title = (req.nextUrl.searchParams.get("title") ?? "").trim();
  const excludeRaw = (req.nextUrl.searchParams.get("exclude") ?? "").trim();
  const excludeIds = excludeRaw
    ? excludeRaw.split(",").map((s) => s.trim()).filter(Boolean)
    : [];

  let dynamicCandidates: SongResult[] = [];
  const seedQuery = artist
    ? `${artist} best songs official`
    : title
      ? `${title} similar songs`
      : "";

  if (seedQuery) {
    try {
      dynamicCandidates = await searchSongs(seedQuery);
    } catch {
      dynamicCandidates = [];
    }
  }

  const suggestions = buildSongSuggestions(dynamicCandidates, excludeIds, 8);
  return NextResponse.json({ suggestions });
}
