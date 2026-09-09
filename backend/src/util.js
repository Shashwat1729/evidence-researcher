// Shared micro-utilities (no dependencies).
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Truncate text to n chars with ellipsis (for prompts/logs, never evidence). */
export function trunc(s, n = 500) {
  const t = String(s || '');
  return t.length > n ? t.slice(0, n) + '…' : t;
}
