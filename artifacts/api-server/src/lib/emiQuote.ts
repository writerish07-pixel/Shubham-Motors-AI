/** Reference EMI @ 9% p.a. — actual rate depends on customer CIBIL (typically 8.5%–12%). */

import { MODEL_ALIASES, ON_ROAD_JAIPUR as CATALOG_ON_ROAD } from "@workspace/db/heroCatalog";

const EMI_FACTORS_9PA: Record<number, number> = {
  12: 0.087451,
  18: 0.059602,
  24: 0.045685,
  36: 0.031800,
};

/** On-road Jaipur prices — single source: @workspace/db/heroCatalog */
export const ON_ROAD_JAIPUR: Record<string, number> = CATALOG_ON_ROAD;

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

export function computeEmi(principal: number, months: number, annualRate = 0.09): number {
  if (principal <= 0) return 0;
  const factor = EMI_FACTORS_9PA[months];
  if (factor != null) return Math.round(principal * factor);
  const r = annualRate / 12;
  return Math.round(principal * (r * Math.pow(1 + r, months)) / (Math.pow(1 + r, months) - 1));
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
  if (/36|छत्तीस|treis/i.test(t)) return 36;
  if (/24|चौबीस|do\s*saal|two\s*year/i.test(t)) return 24;
  if (/18|अठारह/i.test(t)) return 18;
  if (/12|बारह|ek\s*saal|one\s*year/i.test(t)) return 12;
  if (/kitne\s*(mahine|month|मही)/i.test(t)) return 24; // default explain 24 when they ask tenure generically
  return null;
}

export function formatEmiQuote(
  model: string,
  onRoad: number,
  down: number,
  months: number,
): string {
  const loan = Math.max(0, onRoad - down);
  if (loan <= 0) {
    return `${model} ki on-road लगभग ₹${onRoad.toLocaleString("en-IN")} है — ₹${down.toLocaleString("en-IN")} down payment par loan amount zero ya bahut kam hoga.`;
  }
  const emi = computeEmi(loan, months);
  return `${model} — on-road ₹${onRoad.toLocaleString("en-IN")}, ₹${down.toLocaleString("en-IN")} down par loan ₹${loan.toLocaleString("en-IN")}, ${months} mahine ki reference EMI ₹${emi.toLocaleString("en-IN")}/month (@ 9% reference). Actual rate CIBIL par 8.5%–12% ho sakta hai.`;
}

export const FINANCE_PARTNERS_LIST =
  "Humare paas finance options hain: Hero FinCorp, HDFC Bank, IDBI Bank, Hinduja Leyland Finance, aur RBL Bank — aap showroom par inme se koi bhi choose kar sakte hain.";
