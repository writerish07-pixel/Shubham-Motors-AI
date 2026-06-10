/** Reference EMI @ 9% p.a. — actual rate depends on customer CIBIL (typically 8.5%–12%). */

const EMI_FACTORS_9PA: Record<number, number> = {
  12: 0.087451,
  18: 0.059602,
  24: 0.045685,
  36: 0.031800,
};

/** On-road Jaipur prices — keep in sync with openai.ts EMI table. */
export const ON_ROAD_JAIPUR: Record<string, number> = {
  "HF Deluxe Kick": 74698,
  "HF Deluxe DRS": 77423,
  "HF Deluxe Pro": 83348,
  "Splendor AHO": 91272,
  "Splendor i3S": 92564,
  "Splendor XTEC": 95377,
  "Splendor XTEC Disc": 98695,
  "Splendor+ XTEC 2.0": 97973,
  "Passion Plus": 94605,
  "Super Splendor XTEC": 98169,
  "Super Splendor XTEC DSS": 102777,
  "Glamour X DRS": 104555,
  "Glamour X DSS": 111587,
  "Xtreme 125R IBS": 108088,
  "Xtreme 125R ABS": 113247,
  "Xtreme 125R ABS DC": 126275,
  "Xtreme 160R 2V SD": 130320,
  "Xtreme 160R 2V DD": 135224,
  "Xtreme 160R 4V": 161109,
  "Pleasure+ VX": 89023,
  "Pleasure XTEC": 93177,
  "Destini 110 VX": 89547,
  "Destini 110 ZX": 98775,
  "Destini Prime": 90841,
  "Destini 125 VX": 95857,
  "Destini 125 ZX": 106122,
  "Destini 125 ZX+": 107287,
  "Xoom 125 VX": 103178,
  "Xoom 125 ZX": 110647,
};

const MODEL_ALIASES: Array<[RegExp, string]> = [
  [/destini\s*110/i, "Destini 110 VX"],
  [/destini\s*125/i, "Destini 125 VX"],
  [/splendor/i, "Splendor XTEC"],
  [/glamour|galemar|galaimer|glemor/i, "Glamour X DRS"],
  [/dss/i, "Glamour X DSS"],
  [/xoom\s*125/i, "Xoom 125 VX"],
  [/pleasure/i, "Pleasure+ VX"],
  [/hf\s*deluxe/i, "HF Deluxe DRS"],
  [/super\s*splendor/i, "Super Splendor XTEC"],
  [/xtreme\s*125/i, "Xtreme 125R IBS"],
  [/xtreme\s*160/i, "Xtreme 160R 2V SD"],
];

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
