import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { chatMessages, users } from "@/db/schema";
import { eq } from "drizzle-orm";

export const dynamic = "force-dynamic";

const GIF_HOSTS = [
  "media.giphy.com",
  "media0.giphy.com",
  "media1.giphy.com",
  "media2.giphy.com",
  "media3.giphy.com",
  "media4.giphy.com",
  "media.tenor.com",
  "c.tenor.com",
  "i.imgur.com",
  "media.klipy.com",
];

function isGifUrl(value: string) {
  try {
    const u = new URL(value);
    if (u.protocol !== "https:") return false;
    return GIF_HOSTS.some((h) => u.hostname === h || u.hostname.endsWith("." + h));
  } catch {
    return false;
  }
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const userId = String(body.userId ?? "");
  const kind = body.kind === "gif" ? "gif" : "text";
  let content = String(body.content ?? "").trim();

  const UUID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!UUID_RE.test(userId)) {
    return NextResponse.json({ ok: false, error: "Join the party first" }, { status: 401 });
  }
  const found = await db.select().from(users).where(eq(users.id, userId));
  if (!found.length) {
    return NextResponse.json({ ok: false, error: "Join the party first" }, { status: 401 });
  }

  if (kind === "gif") {
    if (!isGifUrl(content)) {
      return NextResponse.json(
        { ok: false, error: "That GIF link is not supported." },
        { status: 400 }
      );
    }
  } else {
    // auto-detect pasted GIF urls
    if (isGifUrl(content)) {
      await db.insert(chatMessages).values({
        userId,
        userName: found[0].name,
        userColor: found[0].color,
        isAdmin: found[0].isAdmin,
        kind: "gif",
        content,
      });
      return NextResponse.json({ ok: true });
    }
    content = content.slice(0, 500);
    if (!content) return NextResponse.json({ ok: false, error: "Empty" }, { status: 400 });
  }

  await db.insert(chatMessages).values({
    userId,
    userName: found[0].name,
    userColor: found[0].color,
    isAdmin: found[0].isAdmin,
    kind,
    content,
  });
  return NextResponse.json({ ok: true });
}
