import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { users } from "@/db/schema";
import { eq } from "drizzle-orm";
import { AVATAR_COLORS } from "@/lib/constants";
import {
  authConfigured,
  configErrorPayload,
  verifyAdminPassword,
  verifyPartyPassword,
} from "@/lib/env";
import { limitKey, rateLimit, RULES } from "@/lib/rate-limit";
import { ensureState, systemMessage } from "@/lib/party";

export const dynamic = "force-dynamic";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function tooMany(retryAfterSec: number) {
  return NextResponse.json(
    {
      ok: false,
      error: `Too many attempts. Try again in ${retryAfterSec}s.`,
    },
    { status: 429, headers: { "Retry-After": String(retryAfterSec) } }
  );
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const action = String(body.action ?? "join");

  // Leaving is not a credential check and must never be rate limited away:
  // a blocked "leave" leaves a ghost in the room for 90 seconds.
  if (action === "leave") {
    const userId = String(body.userId ?? "");
    if (UUID_RE.test(userId)) {
      const found = await db.select().from(users).where(eq(users.id, userId));
      if (found.length) {
        await db.delete(users).where(eq(users.id, userId));
        await systemMessage(`${found[0].name} left the party`);
      }
    }
    return NextResponse.json({ ok: true });
  }

  // No secrets configured → no way in. Fail closed, never fall back to a
  // built-in password.
  if (!authConfigured()) {
    return NextResponse.json(configErrorPayload(), { status: 503 });
  }

  // Password guessing is the one thing worth throttling hard.
  const verdict = rateLimit(limitKey("auth", req.headers), RULES.auth);
  if (!verdict.allowed) return tooMany(verdict.retryAfterSec);

  if (action === "admin") {
    if (verifyAdminPassword(body.password)) {
      return NextResponse.json({ ok: true });
    }
    return NextResponse.json(
      { ok: false, error: "Wrong host password." },
      { status: 401 }
    );
  }

  // --- join ---
  const name = String(body.name ?? "").trim().slice(0, 24);
  const asAdmin = verifyAdminPassword(body.adminPassword);

  const state = await ensureState();

  if (!asAdmin) {
    if (!verifyPartyPassword(body.password)) {
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
