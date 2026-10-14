import { CalendarError } from "../errors";
import type { GitHubIdentity } from "./github";

/**
 * Allows exactly one GitHub account, compared by immutable numeric ID. A
 * matching username alone is never sufficient. Fails closed when the allowlist
 * is missing or malformed.
 */
export function assertAllowedIdentity(identity: Pick<GitHubIdentity, "id">, allowedUserId: unknown): void {
  if (typeof allowedUserId !== "string" || !/^[1-9]\d{0,19}$/.test(allowedUserId.trim())) {
    throw new CalendarError("forbidden", "This server has no allowed account configured.");
  }
  if (!Number.isSafeInteger(identity.id) || String(identity.id) !== allowedUserId.trim()) {
    throw new CalendarError("forbidden");
  }
}

export function isAllowedUserId(userId: unknown, allowedUserId: unknown): boolean {
  if (typeof userId !== "string" && typeof userId !== "number") return false;
  try {
    assertAllowedIdentity({ id: Number(userId) }, allowedUserId);
    return String(userId) === String(Number(userId));
  } catch {
    return false;
  }
}
