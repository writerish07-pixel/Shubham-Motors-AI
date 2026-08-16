/** Live reducing-balance EMI. On-road prices still come from the Hero catalog. */

import { MODEL_ALIASES, ON_ROAD_JAIPUR as CATALOG_ON_ROAD } from "@workspace/db/heroCatalog";

/** On-road Jaipur prices — single source: @workspace/db/heroCatalog */
export const ON_ROAD_JAIPUR: Record<string, number> = CATALOG_ON_ROAD;

export const DEFAULT_ANNUAL_RATE = 0.09;
export const RATE_BAND_LOW = 0.085;
export const RATE_BAND_HIGH = 0.12;

export function resolveModelOnRoad(text: string, fallback?: string): { model: string; onRoad: number } | null {
  const hay = `${text} ${fallback ?? ""}`;
  for (const [re, key] of MODEL_ALIASES) {
    if (re.test(hay) && ON_ROAD_JAIPUR[key]) return { model: key, onRoad: ON_ROAD_JAIPUR[key]! };
  }
  for (const [key, price] of Object.entries(ON_ROAD_JAIPUR)) {
    if (hay.toLowerCase().includes(key.toLowerCase().split(" ")[0]!)) {
      return { model: key, onRoad: price };
    }
  }
  return null;
}

/**
 * Standard reducing-balance monthly EMI:
 *   EMI = P × r × (1+r)^n / ((1+r)^n − 1)
 * where r = annualRate / 12. Any tenure 6–60 months, any rate 7%–18%.
 */
export function computeEmi(principal: number, months: number, annualRate = DEFAULT_ANNUAL_RATE): number {
  if (principal <= 0) return 0;
  const n = Math.min(60, Math.max(6, Math.round(months) || 24));
  const annual = Number.isFinite(annualRate) ? Math.min(0.18, Math.max(0.07, annualRate)) : DEFAULT_ANNUAL_RATE;
  const r = annual / 12;
  if (r <= 0) return Math.round(principal / n);
  const pow = Math.pow(1 + r, n);
  return Math.round(principal * (r * pow) / (pow - 1));
}

export function parseDownPayment(text: string): number | null {
  const t = text.toLowerCase();
  const lakh = t.match(/(\d+(?:\.\d+)?)\s*(?:lakh|lac|लाख)/);
  if (lakh) return Math.round(parseFloat(lakh[1]!) * 100000);
  const hajar = t.match(/(\d+)\s*(?:hajar|hazaar|hazar|हज़ार|हजार|k\b)/);
  if (hajar) return parseInt(hajar[1]!, 10) * 1000;
  const raw = t.match(/(?:down\s*payment|डाउन)\s*(?:₹|rs\.?|rup)?\s*(\d[\d,]*)/);
  if (raw) return parseInt(raw[1]!.replace(/,/g, ""), 10);
  const num = t.match(/\b(\d{4,6})\b/);
  if (num) {
    const n = parseInt(num[1]!, 10);
    if (n >= 5000 && n <= 500000) return n;
  }
  return null;
}

export function parseTenureMonths(text: string): number | null {
  const t = text.toLowerCase();
  if (/60|साठ|five\s*year|5\s*saal/i.test(t)) return 60;
  if (/48|अड़तालीस|char\s*saal|four\s*year/i.test(t)) return 48;
  if (/36|छत्तीस|treis|teen\s*saal|three\s*year/i.test(t)) return 36;
  if (/30|तीस/i.test(t) && /mahine|month|मही/i.test(t)) return 30;
  if (/24|चौबीस|do\s*saal|two\s*year/i.test(t)) return 24;
  if (/18|अठारह/i.test(t)) return 18;
  if (/12|बारह|ek\s*saal|one\s*year/i.test(t)) return 12;
  if (/kitne\s*(mahine|month|मही)/i.test(t)) return 24;
  return null;
}

/** Spoken "10 percent" / "11%" / "das percent" → annual decimal. */
export function parseAnnualRate(text: string): number | null {
  const t = text.toLowerCase();
  const pct = t.match(/(\d+(?:\.\d+)?)\s*(?:%|percent|per\s*cent|फ़ीसदी|फीसदी|percent)/i);
  if (pct) {
    const n = parseFloat(pct[1]!);
    if (n >= 7 && n <= 18) return n / 100;
  }
  return null;
}

export function formatEmiQuote(
  model: string,
  onRoad: number,
  down: number,
  months: number,
  annualRate = DEFAULT_ANNUAL_RATE,
): string {
  const loan = Math.max(0, onRoad - down);
  if (loan <= 0) {
    return `${model} की ऑन-रोड लगभग ₹${onRoad.toLocaleString("en-IN")} है — इतना डाउन देने पर लोन लगभग शून्य रहेगा।`;
  }
  const emi = computeEmi(loan, months, annualRate);
  const low = computeEmi(loan, months, RATE_BAND_LOW);
  const high = computeEmi(loan, months, RATE_BAND_HIGH);
  return (
    `${model} की ऑन-रोड लगभग ₹${onRoad.toLocaleString("en-IN")} है, ₹${down.toLocaleString("en-IN")} डाउन पर ${months} महीने की ई एम आई लगभग ₹${emi.toLocaleString("en-IN")}। ` +
    `सिबिल के हिसाब से साढ़े आठ प्रतिशत पर लगभग ₹${low.toLocaleString("en-IN")} और बारह प्रतिशत पर लगभग ₹${high.toLocaleString("en-IN")} — सटीक बैंक रेट शोरूम पर लगेगा।`
  );
}

export const FINANCE_PARTNERS_LIST =
  "हमारे पास फाइनेंस ऑप्शन हैं: हीरो फिनकॉर्प, एच डी एफ सी, आई डी बी आई, हिंदुजा, और आर बी एल — शोरूम पर आप चुन सकते हैं।";
