import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { users } from "@/db/schema";
import { eq } from "drizzle-orm";
import { ADMIN_PASSWORD, AVATAR_COLORS, PARTY_PASSWORD } from "@/lib/constants";
import { ensureState, isAdminKey, systemMessage } from "@/lib/party";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const action = String(body.action ?? "join");

  if (action === "admin") {
    // Verify host password
    if (isAdminKey(body.password)) return NextResponse.json({ ok: true });
    return NextResponse.json(
      { ok: false, error: "Wrong host password." },
      { status: 401 }
    );
  }

  if (action === "leave") {
    const userId = String(body.userId ?? "");
    const UUID_RE =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (UUID_RE.test(userId)) {
      const found = await db.select().from(users).where(eq(users.id, userId));
      if (found.length) {
        await db.delete(users).where(eq(users.id, userId));
        await systemMessage(`${found[0].name} left the party`);
      }
    }
    return NextResponse.json({ ok: true });
  }

  // --- join ---
  const password = String(body.password ?? "");
  const adminPassword = String(body.adminPassword ?? "");
  const name = String(body.name ?? "").trim().slice(0, 24);
  const asAdmin = isAdminKey(adminPassword);

  const state = await ensureState();

  if (!asAdmin) {
    if (password !== PARTY_PASSWORD) {
      return NextResponse.json(
        { ok: false, error: "Wrong password. Ask the host for the vibe code." },
        { status: 401 }
      );
    }
    if (!state.isOpen) {
      return NextResponse.json(
        { ok: false, error: "The party is closed right now. Check back soon!" },
        { status: 403 }
      );
    }
  }
  if (!name) {
    return NextResponse.json(
      { ok: false, error: "Tell us your name first." },
      { status: 400 }
    );
  }

  const color =
    AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)];

  // Re-use an existing user with the same name to avoid dupes on refresh.
  const existing = await db
    .select()
    .from(users)
    .where(eq(users.name, name))
    .limit(1);

  let user;
  if (existing.length) {
    const [u] = await db
      .update(users)
      .set({ lastSeen: new Date(), isAdmin: asAdmin || existing[0].isAdmin })
      .where(eq(users.id, existing[0].id))
      .returning();
    user = u;
  } else {
    const [u] = await db
      .insert(users)
      .values({ name, isAdmin: asAdmin, color })
      .returning();
    user = u;
    await systemMessage(`${name} joined the party`);
  }

  return NextResponse.json({
    ok: true,
    user: {
      id: user.id,
      name: user.name,
      isAdmin: user.isAdmin,
      color: user.color,
    },
  });
}
