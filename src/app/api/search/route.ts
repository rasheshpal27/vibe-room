import { NextRequest, NextResponse } from "next/server";
import { resolvePlaylist, resolveVideoId, searchSongs } from "@/lib/youtube";
import { parseYouTubeTarget } from "@/lib/youtube-url";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const q = (req.nextUrl.searchParams.get("q") ?? "").trim();
  if (!q) return NextResponse.json({ results: [] });

  // A pasted link skips search entirely: resolve it straight to a song.
  const target = parseYouTubeTarget(q);
  if (target) {
    try {
      if (target.kind === "video") {
        const song = await resolveVideoId(target.videoId);
        const extra =
          target.listId && song
            ? await resolvePlaylist(target.listId).catch(() => [])
            : [];
        const results = [
          ...(song ? [song] : []),
          ...extra.filter((s) => s.videoId !== target.videoId),
        ];
        if (results.length) {
          return NextResponse.json({ results, source: "link" });
        }
      } else {
        const results = await resolvePlaylist(target.listId);
        if (results.length) {
          return NextResponse.json({ results, source: "playlist" });
        }
      }
    } catch {
      /* fall through to a normal search */
    }
  }

  try {
    const results = await searchSongs(q);
    return NextResponse.json({ results });
  } catch {
    return NextResponse.json({ results: [] });
  }
}
