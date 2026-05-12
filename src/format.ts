// Small formatting helpers for user-facing bot messages.

export function fmtDate(d: Date): string {
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function daysUntil(d: Date): number {
  return Math.max(0, Math.ceil((d.getTime() - Date.now()) / (24 * 60 * 60 * 1000)));
}

export function fmtExpiry(d: Date): string {
  const days = daysUntil(d);
  if (days === 0) return `${fmtDate(d)} (today)`;
  if (days === 1) return `${fmtDate(d)} (in 1 day)`;
  return `${fmtDate(d)} (in ${days} days)`;
}

// Escape characters that have special meaning in Telegram's legacy Markdown.
// Apply to user-supplied content (channel titles, etc.) before splicing into messages.
export function mdEscape(s: string): string {
  return s.replace(/([*_`[\]])/g, "\\$1");
}

// Solana addresses are base58 (no 0/O/I/l) and 32-44 chars long.
// This validates structure only — not whether the account actually exists on-chain.
export function isValidSolanaAddress(s: string): boolean {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s.trim());
}
