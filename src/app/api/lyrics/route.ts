import { NextRequest, NextResponse } from "next/server";

export async function GET(req: NextRequest) {
  const title = req.nextUrl.searchParams.get("title")?.trim();
  const artist = req.nextUrl.searchParams.get("artist")?.trim();
  if (!title || title.length > 300 || (artist?.length ?? 0) > 300) {
    return NextResponse.json({ error: "Invalid track" }, { status: 400 });
  }
  // Same-origin proxy avoids provider CORS differences across browsers.
  const params = new URLSearchParams({ track_name: title });
  if (artist) params.set("artist_name", artist);
  try {
    const response = await fetch(`https://lrclib.net/api/get?${params}`, {
      signal: AbortSignal.timeout(8000), next: { revalidate: 86400 },
    });
    if (response.status === 404) return NextResponse.json({ unavailable: true });
    if (!response.ok) throw new Error("Provider unavailable");
    const data = await response.json();
    return NextResponse.json({
      syncedLyrics: typeof data.syncedLyrics === "string" ? data.syncedLyrics : null,
      plainLyrics: typeof data.plainLyrics === "string" ? data.plainLyrics : null,
      instrumental: data.instrumental === true,
    });
  } catch {
    return NextResponse.json({ error: "Lyrics provider unavailable" }, { status: 503 });
  }
}
