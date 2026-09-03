import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { chatMessages, partyState, queueItems } from "@/db/schema";
import { eq, ne } from "drizzle-orm";
import { ensureState, isAdminKey, STATE_ID, systemMessage, wipeParty } from "@/lib/party";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  if (!isAdminKey(String(body.adminKey ?? ""))) {
    return NextResponse.json({ ok: false, error: "Admin only" }, { status: 401 });
  }
  const action = String(body.action ?? "");
  await ensureState();

  switch (action) {
    case "endParty": {
      await wipeParty(true);
      return NextResponse.json({ ok: true });
    }
    case "openParty": {
      await db
        .update(partyState)
        .set({ isOpen: true, updatedAt: new Date() })
        .where(eq(partyState.id, STATE_ID));
      await systemMessage("The doors are open. The party is LIVE");
      return NextResponse.json({ ok: true });
    }
    case "clearChat": {
      await db.delete(chatMessages);
      await systemMessage("Chat was cleared by the host");
      return NextResponse.json({ ok: true });
    }
    case "clearQueue": {
      // remove upcoming songs but keep what is currently playing
      await db.delete(queueItems).where(ne(queueItems.status, "playing"));
      await systemMessage("The host cleared the queue");
      return NextResponse.json({ ok: true });
    }
    case "clearAll": {
      await wipeParty(false); // reset but keep the doors open
      await systemMessage("Fresh start courtesy of the host");
      return NextResponse.json({ ok: true });
    }
    default:
      return NextResponse.json({ ok: false, error: "Unknown action" }, { status: 400 });
  }
}
