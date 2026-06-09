/** Canonical 10-digit Indian mobile (no country prefix). */
export function normalizePhone(raw: string): string | null {
  const digits = raw.replace(/\D/g, "");
  if (digits.length < 10) return null;
  return digits.slice(-10);
}

/** Variants stored historically in CRM — lookup tries all of them. */
export function phoneLookupVariants(raw: string): string[] {
  const n = normalizePhone(raw);
  if (!n) return [];
  return [n, `+91${n}`, `91${n}`];
}
