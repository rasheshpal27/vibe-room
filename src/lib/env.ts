/**
 * Server-side secrets.
 *
 * There are deliberately NO fallback passwords here. This file used to ship
 * `?? "hirashesh"` / `?? "adminrasheshadmin"`, which meant a public repo was
 * also a public key to the room — and because the old constants module is
 * imported by client components, the literal was bundled into the browser JS
 * as well. Missing configuration now fails closed: nobody can join, nobody can
 * become host, and the process says so loudly at boot.
 */

import { createHash, timingSafeEqual } from "node:crypto";

export type SecretName = "PARTY_PASSWORD" | "ADMIN_PASSWORD";

function read(name: SecretName): string | null {
  const raw = process.env[name];
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

const PARTY_PASSWORD = read("PARTY_PASSWORD");
const ADMIN_PASSWORD = read("ADMIN_PASSWORD");

/** Which required secrets are missing right now. */
export function missingSecrets(): SecretName[] {
  const missing: SecretName[] = [];
  if (!PARTY_PASSWORD) missing.push("PARTY_PASSWORD");
  if (!ADMIN_PASSWORD) missing.push("ADMIN_PASSWORD");
  return missing;
}

export function authConfigured(): boolean {
  return missingSecrets().length === 0;
}

// Boot-time shout. Serverless platforms give us no other startup hook, so the
// first evaluation of this module is "boot" for every cold lambda.
if (!authConfigured()) {
  console.error(
    `[vibe-room] CONFIG ERROR: ${missingSecrets().join(" and ")} not set. ` +
      "The room is locked: joining and host mode are disabled until the " +
      "environment provides them. See .env.example."
  );
}

/**
 * Constant-time secret comparison.
 *
 * Both sides are hashed first so the buffers are always 32 bytes: that keeps
 * `timingSafeEqual` from throwing on a length mismatch *and* stops the length
 * of the real password leaking through the comparison.
 */
export function secretEquals(input: unknown, secret: string | null): boolean {
  if (typeof input !== "string" || input.length === 0) return false;
  if (!secret) return false;
  const a = createHash("sha256").update(input, "utf8").digest();
  const b = createHash("sha256").update(secret, "utf8").digest();
  return timingSafeEqual(a, b);
}

export function verifyPartyPassword(input: unknown): boolean {
  return secretEquals(input, PARTY_PASSWORD);
}

export function verifyAdminPassword(input: unknown): boolean {
  return secretEquals(input, ADMIN_PASSWORD);
}

/** 503 body used by every route that cannot work without the secrets. */
export function configErrorPayload() {
  return {
    ok: false as const,
    error:
      "This room is not configured yet. The host needs to set " +
      `${missingSecrets().join(" and ")} on the server.`,
    code: "not-configured" as const,
  };
}
