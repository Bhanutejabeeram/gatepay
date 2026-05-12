import { customAlphabet } from "nanoid";

// Channel slugs are URL-safe lowercase, no ambiguous chars.
const slugMaker = customAlphabet("abcdefghjkmnpqrstuvwxyz23456789", 8);
const nonceMaker = customAlphabet("abcdefghjkmnpqrstuvwxyz23456789", 6);

export function generateSlug(): string {
  return slugMaker();
}

// customOrderId format: "{tgUserId}:{channelId}:{durationDays}:{nonce}"
// The nonce makes every payment attempt unique so we can re-issue links
// without colliding on KIRAPAY's per-link single-viewer lock.
export function buildCustomOrderId(
  telegramUserId: bigint,
  channelId: string,
  durationDays: number,
): string {
  return `${telegramUserId}:${channelId}:${durationDays}:${nonceMaker()}`;
}

export function parseCustomOrderId(value: string):
  | { telegramUserId: bigint; channelId: string; durationDays: number }
  | null {
  const parts = value.split(":");
  // Accept both legacy 3-segment and new 4-segment forms.
  if (parts.length !== 3 && parts.length !== 4) return null;
  const [tgRaw, channelId, durationRaw] = parts;
  if (!tgRaw || !channelId || !durationRaw) return null;
  try {
    const telegramUserId = BigInt(tgRaw);
    const durationDays = parseInt(durationRaw, 10);
    if (!Number.isFinite(durationDays) || durationDays <= 0) return null;
    return { telegramUserId, channelId, durationDays };
  } catch {
    return null;
  }
}
