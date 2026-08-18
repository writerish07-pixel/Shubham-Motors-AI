/**
 * Canonical Hero MotoCorp catalog for Shubham Motors (Jaipur).
 * On-road ₹ are dealer list as of 16-May-2026. Do not invent prices —
 * null onRoadJaipur means “confirm at showroom / indent from factory”.
 * EMI math and DEFAULT_HERO_KNOWLEDGE must read from here, not copy-paste.
 */

export const HERO_CATALOG_SOURCE = "hero-catalog-2026-08";
export const HERO_PRICE_AS_OF = "16-May-2026";

export type HeroKind = "bike" | "scooter" | "electric";

export type HeroVariant = {
  family: string;
  name: string;
  cc: number;
  kind: HeroKind;
  onRoadJaipur: number | null;
  mileageKmpl: number | null;
  features: string;
  inStock: boolean;
};

export const HERO_VARIANTS: HeroVariant[] = [
  // ── 100cc bikes ──────────────────────────────────────────────────────────
  { family: "HF Deluxe", name: "HF Deluxe Kick", cc: 97.2, kind: "bike", onRoadJaipur: 74698, mileageKmpl: 83, features: "Kick start, drum brakes, highest Hero mileage commuter, OBD-2", inStock: true },
  { family: "HF Deluxe", name: "HF Deluxe DRS", cc: 97.2, kind: "bike", onRoadJaipur: 77423, mileageKmpl: 83, features: "Self + kick, alloy, i3S on higher trims, OBD-2", inStock: true },
  { family: "HF Deluxe", name: "HF Deluxe DRS All Black", cc: 97.2, kind: "bike", onRoadJaipur: 79100, mileageKmpl: 83, features: "All-black graphics, DRS self start", inStock: true },
  { family: "HF Deluxe", name: "HF Deluxe DRS i3S", cc: 97.2, kind: "bike", onRoadJaipur: 79578, mileageKmpl: 83, features: "i3S idle-stop, self start", inStock: true },
  { family: "HF Deluxe", name: "HF Deluxe Pro", cc: 97.2, kind: "bike", onRoadJaipur: 83348, mileageKmpl: 82, features: "Top HF Deluxe — better seat and graphics", inStock: true },

  { family: "Splendor", name: "Splendor AHO", cc: 97.2, kind: "bike", onRoadJaipur: 91272, mileageKmpl: 80, features: "Always Headlamp On, India's volume commuter, OBD-2", inStock: true },
  { family: "Splendor", name: "Splendor i3S", cc: 97.2, kind: "bike", onRoadJaipur: 92564, mileageKmpl: 80, features: "i3S idle-stop, OBD-2", inStock: true },
  { family: "Splendor", name: "Splendor i3S Additional", cc: 97.2, kind: "bike", onRoadJaipur: 94815, mileageKmpl: 80, features: "i3S plus extra fitment pack", inStock: true },
  { family: "Splendor", name: "Splendor XTEC", cc: 97.2, kind: "bike", onRoadJaipur: 95377, mileageKmpl: 80, features: "XTEC digital console / USB, OBD-2", inStock: true },
  { family: "Splendor", name: "Splendor XTEC Disc", cc: 97.2, kind: "bike", onRoadJaipur: 98695, mileageKmpl: 80, features: "Front disc + XTEC", inStock: true },
  { family: "Splendor", name: "Splendor+ XTEC 2.0", cc: 97.2, kind: "bike", onRoadJaipur: 97973, mileageKmpl: 80, features: "Splendor+ XTEC 2.0 Bluetooth-ready console", inStock: true },
  { family: "Splendor", name: "Splendor+ 01", cc: 97.2, kind: "bike", onRoadJaipur: 92693, mileageKmpl: 80, features: "Splendor+ base Plus trim", inStock: true },

  { family: "Passion Plus", name: "Passion Plus", cc: 113.2, kind: "bike", onRoadJaipur: 94605, mileageKmpl: 70, features: "Taller comfort commuter, OBD-2, tubeless", inStock: true },

  // ── 125cc bikes ──────────────────────────────────────────────────────────
  { family: "Super Splendor", name: "Super Splendor XTEC", cc: 124.7, kind: "bike", onRoadJaipur: 98169, mileageKmpl: 65, features: "125cc family commuter, XTEC, OBD-2, ~65 kmpl", inStock: true },
  { family: "Super Splendor", name: "Super Splendor XTEC DSS", cc: 124.7, kind: "bike", onRoadJaipur: 102777, mileageKmpl: 65, features: "DSS comfort pack on Super Splendor XTEC", inStock: true },

  { family: "Glamour X", name: "Glamour X DRS", cc: 124.7, kind: "bike", onRoadJaipur: 104555, mileageKmpl: 55, features: "LED headlamp, digital-analog cluster, i3S, COMBI BRAKE, tubeless. NO cruise control on DRS", inStock: true },
  { family: "Glamour X", name: "Glamour X DSS", cc: 124.7, kind: "bike", onRoadJaipur: 111587, mileageKmpl: 55, features: "DRS features PLUS CRUISE CONTROL — confirm DSS if customer asks cruise", inStock: true },

  { family: "Xtreme 125R", name: "Xtreme 125R IBS", cc: 124.7, kind: "bike", onRoadJaipur: 108088, mileageKmpl: 60, features: "Sporty 125, IBS brakes, aggressive stance", inStock: true },
  { family: "Xtreme 125R", name: "Xtreme 125R ABS", cc: 124.7, kind: "bike", onRoadJaipur: 113247, mileageKmpl: 60, features: "Single-channel ABS, sporty 125", inStock: true },
  { family: "Xtreme 125R", name: "Xtreme 125R ABS DC", cc: 124.7, kind: "bike", onRoadJaipur: 126275, mileageKmpl: 58, features: "Dual-channel ABS, top Xtreme 125R", inStock: true },

  // ── 160cc+ bikes ─────────────────────────────────────────────────────────
  { family: "Xtreme 160R", name: "Xtreme 160R 2V SD", cc: 163.2, kind: "bike", onRoadJaipur: 130320, mileageKmpl: 45, features: "163cc 2-valve, single disc, sporty daily", inStock: true },
  { family: "Xtreme 160R", name: "Xtreme 160R 2V DD", cc: 163.2, kind: "bike", onRoadJaipur: 135224, mileageKmpl: 45, features: "2-valve double disc", inStock: true },
  { family: "Xtreme 160R", name: "Xtreme 160R 4V", cc: 163.2, kind: "bike", onRoadJaipur: 161109, mileageKmpl: 42, features: "4-valve premium Xtreme, more power", inStock: true },

  { family: "Xpulse", name: "Xpulse 200 4V", cc: 199.6, kind: "bike", onRoadJaipur: null, mileageKmpl: 40, features: "Adventure / off-road, long-travel suspension, 4V. On-road Jaipur confirm at showroom", inStock: false },
  { family: "Xpulse", name: "Xpulse 210", cc: 210, kind: "bike", onRoadJaipur: null, mileageKmpl: 38, features: "Latest adventure Xpulse. Indent from factory if not in yard — never say Hero doesn't make it", inStock: false },

  { family: "Karizma", name: "Karizma XMR", cc: 210, kind: "bike", onRoadJaipur: null, mileageKmpl: 35, features: "Premium sport-tourer. Showroom demo / indent — quote only after stock check", inStock: false },
  { family: "Mavrick", name: "Mavrick 440", cc: 440, kind: "bike", onRoadJaipur: null, mileageKmpl: 28, features: "Hero 440cc roadster. Premium; confirm allocation at Lal Kothi", inStock: false },

  // ── 110cc scooters ───────────────────────────────────────────────────────
  { family: "Pleasure+", name: "Pleasure+ VX", cc: 110.9, kind: "scooter", onRoadJaipur: 89023, mileageKmpl: 55, features: "Light city scooter, female-friendly, VX Fi digi-analog", inStock: true },
  { family: "Pleasure+", name: "Pleasure XTEC", cc: 110.9, kind: "scooter", onRoadJaipur: 93177, mileageKmpl: 55, features: "Pleasure XTEC console / USB", inStock: true },

  { family: "Destini 110", name: "Destini 110 VX", cc: 110.9, kind: "scooter", onRoadJaipur: 89547, mileageKmpl: 50, features: "Family 110 scooter, underseat storage", inStock: true },
  { family: "Destini 110", name: "Destini 110 ZX", cc: 110.9, kind: "scooter", onRoadJaipur: 98775, mileageKmpl: 50, features: "ZX top 110 Destini", inStock: true },
  { family: "Destini 110", name: "Destini Prime", cc: 110.9, kind: "scooter", onRoadJaipur: 90841, mileageKmpl: 50, features: "Destini Prime OBD-2 premium 110", inStock: true },

  // ── 125cc scooters ───────────────────────────────────────────────────────
  { family: "Destini 125", name: "Destini 125 VX", cc: 124.6, kind: "scooter", onRoadJaipur: 95857, mileageKmpl: 48, features: "Family 125 scooter, wide seat", inStock: true },
  { family: "Destini 125", name: "Destini 125 ZX", cc: 124.6, kind: "scooter", onRoadJaipur: 106122, mileageKmpl: 48, features: "ZX family 125 — preferred when kids/pillion", inStock: true },
  { family: "Destini 125", name: "Destini 125 ZX+", cc: 124.6, kind: "scooter", onRoadJaipur: 107287, mileageKmpl: 48, features: "ZX+ top Destini 125", inStock: true },

  { family: "Xoom 125", name: "Xoom 125 VX", cc: 124.6, kind: "scooter", onRoadJaipur: 103178, mileageKmpl: 50, features: "Sporty youthful 125 scooter", inStock: true },
  { family: "Xoom 125", name: "Xoom 125 ZX", cc: 124.6, kind: "scooter", onRoadJaipur: 110647, mileageKmpl: 50, features: "ZX sporty 125 scooter", inStock: true },
  { family: "Xoom 160", name: "Xoom 160", cc: 160, kind: "scooter", onRoadJaipur: null, mileageKmpl: 45, features: "Hero's 160cc scooter. Confirm on-road at showroom", inStock: false },

  // ── Electric (Vida) ──────────────────────────────────────────────────────
  { family: "Vida", name: "Vida V1 Pro", cc: 0, kind: "electric", onRoadJaipur: null, mileageKmpl: null, features: "City EV, ~110 km range/charge, home charging. Zero petrol. On-road confirm at showroom", inStock: false },
  { family: "Vida", name: "Vida V2", cc: 0, kind: "electric", onRoadJaipur: null, mileageKmpl: null, features: "Newer Vida EV. Range/price confirm at Lal Kothi — never say we don't sell Vida", inStock: false },
];

export const ON_ROAD_JAIPUR: Record<string, number> = Object.fromEntries(
  HERO_VARIANTS
    .filter((v): v is HeroVariant & { onRoadJaipur: number } => v.onRoadJaipur != null)
    .map((v) => [v.name, v.onRoadJaipur]),
);

/** First match wins — keep specific names before generic family names. */
export const MODEL_ALIASES: Array<[RegExp, string]> = [
  [/destini\s*125/i, "Destini 125 VX"],
  [/destini\s*110/i, "Destini 110 VX"],
  [/destini\s*prime/i, "Destini Prime"],
  [/xoom\s*160/i, "Xoom 160"],
  [/xoom\s*125/i, "Xoom 125 VX"],
  [/xpulse\s*210/i, "Xpulse 210"],
  [/xpulse/i, "Xpulse 200 4V"],
  [/karizma/i, "Karizma XMR"],
  [/mavrick|maverick/i, "Mavrick 440"],
  [/vida/i, "Vida V1 Pro"],
  [/glamour|galemar|galaimer|glemor/i, "Glamour X DRS"],
  [/\bdss\b/i, "Glamour X DSS"],
  [/super\s*splendor/i, "Super Splendor XTEC"],
  [/splendor/i, "Splendor XTEC"],
  [/pleasure/i, "Pleasure+ VX"],
  [/hf\s*deluxe|deluxe/i, "HF Deluxe DRS"],
  [/passion/i, "Passion Plus"],
  [/xtreme\s*160|एक्सट्रीम\s*160/i, "Xtreme 160R 2V SD"],
  [/xtreme\s*125r?\s*abs\s*dc|xtreme\s*125r?\s*dual/i, "Xtreme 125R ABS DC"],
  [/xtreme\s*125r?\s*abs/i, "Xtreme 125R ABS"],
  [/xtreme\s*125|एक्सट्रीम\s*125|एक्सट्रीम/i, "Xtreme 125R IBS"],
];

export function pricedVariants(): Array<{ name: string; onRoad: number }> {
  return HERO_VARIANTS
    .filter((v): v is HeroVariant & { onRoadJaipur: number } => v.onRoadJaipur != null)
    .map((v) => ({ name: v.name, onRoad: v.onRoadJaipur }));
}

export function pricedVariantsInFamily(familyOrModel: string): Array<HeroVariant & { onRoadJaipur: number }> {
  const hay = familyOrModel.toLowerCase();
  if (!hay.trim()) return [];
  const fam =
    HERO_VARIANTS.find((v) => v.family.toLowerCase() === hay || v.name.toLowerCase() === hay)?.family
    ?? HERO_VARIANTS.find((v) => hay.includes(v.family.toLowerCase()))?.family
    ?? HERO_VARIANTS.find((v) => hay.includes(v.name.toLowerCase()))?.family;
  if (!fam) return [];
  return HERO_VARIANTS.filter((v): v is HeroVariant & { onRoadJaipur: number } =>
    v.family === fam && v.onRoadJaipur != null
  );
}

function spokenTrimLabel(name: string): string {
  if (/abs\s*dc|dual/i.test(name)) return "डुअल ए बी एस";
  if (/\babs\b/i.test(name)) return "ए बी एस";
  if (/\bibs\b/i.test(name)) return "आई बी एस";
  const tail = name.replace(/^Hero\s+/i, "").split(" ").slice(-2).join(" ");
  return tail || name;
}

/** Call 23: never quote one Xtreme number then "correct" it to another variant. */
export function spokenFamilyOnRoad(familyOrModel: string): string | null {
  const vs = pricedVariantsInFamily(familyOrModel);
  if (vs.length === 0) return null;
  if (vs.length === 1) {
    return `${vs[0].name} जयपुर ऑन-रोड ₹${inr(vs[0].onRoadJaipur)}। कैश लेंगे या ई एम आई देखें?`;
  }
  const parts = vs.map((v) => `${spokenTrimLabel(v.name)} ₹${inr(v.onRoadJaipur)}`);
  return `${vs[0].family} में ${vs.length} वेरिएंट — ${parts.join(", ")}। कौन सा देख रहे हो?`;
}

export function catalogOnRoadAmounts(): Set<number> {
  return new Set(
    HERO_VARIANTS.map((v) => v.onRoadJaipur).filter((n): n is number => n != null),
  );
}

function inr(n: number): string {
  return n.toLocaleString("en-IN");
}

/** Families the customer named (Glamour X DSS → Glamour X; "HF Deluxe, Splendor XTEC" → both). */
export function variantsForEnquiry(raw: string): HeroVariant[] {
  const hay = (raw || "").trim();
  if (!hay) return [];
  const families = new Set<string>();
  let remaining = hay.toLowerCase();

  const familyNames = [...new Set(HERO_VARIANTS.map((v) => v.family))].sort((a, b) => b.length - a.length);
  for (const family of familyNames) {
    const needle = family.toLowerCase();
    if (remaining.includes(needle)) {
      families.add(family);
      remaining = remaining.split(needle).join(" ");
    }
  }
  for (const v of HERO_VARIANTS) {
    const needle = v.name.toLowerCase();
    if (needle && remaining.includes(needle)) {
      families.add(v.family);
      remaining = remaining.split(needle).join(" ");
    }
  }
  for (const [re, name] of MODEL_ALIASES) {
    if (re.test(remaining)) {
      const hit = HERO_VARIANTS.find((v) => v.name === name);
      if (hit) families.add(hit.family);
      remaining = remaining.replace(re, " ");
    }
  }
  return HERO_VARIANTS.filter((v) => families.has(v.family));
}

/** WhatsApp catalog for the model(s) enquired — prices, mileage, key features. */
export function formatWhatsAppModelCatalog(raw: string, language = "hi"): string {
  const vars = variantsForEnquiry(raw);
  if (!vars.length) return "";
  const isHi = language.startsWith("hi");
  const lines: string[] = [];
  lines.push(
    isHi
      ? `🏍️ *आपकी enquiry — Hero catalog (Jaipur on-road, ${HERO_PRICE_AS_OF})*`
      : `🏍️ *Your enquiry — Hero catalog (Jaipur on-road, ${HERO_PRICE_AS_OF})*`,
  );

  let lastFamily = "";
  for (const v of vars) {
    if (v.family !== lastFamily) {
      lastFamily = v.family;
      const kind =
        v.kind === "bike" ? (isHi ? "बाइक" : "bike")
        : v.kind === "scooter" ? (isHi ? "स्कूटर" : "scooter")
        : "EV";
      const cc = v.cc ? `${v.cc}cc ` : "";
      lines.push("");
      lines.push(`*${v.family}* (${cc}${kind})`);
    }
    const price = v.onRoadJaipur != null ? `₹${inr(v.onRoadJaipur)}` : (isHi ? "शोरूम पर confirm" : "confirm at showroom");
    const mpg = v.mileageKmpl != null ? ` | ~${v.mileageKmpl} kmpl` : "";
    lines.push(`• *${v.name}* — ${price}${mpg}`);
    lines.push(`  ${v.features}`);
  }
  return lines.join("\n");
}

function groupByFamily(kind: HeroKind): Map<string, HeroVariant[]> {
  const map = new Map<string, HeroVariant[]>();
  for (const v of HERO_VARIANTS) {
    if (v.kind !== kind) continue;
    const list = map.get(v.family) ?? [];
    list.push(v);
    map.set(v.family, list);
  }
  return map;
}

export function formatDefaultHeroKnowledge(): string {
  const lines: string[] = [];
  lines.push("[SHOWROOM DETAILS]");
  lines.push("Shubham Motors, authorised Hero MotoCorp dealership, Lal Kothi, Tonk Road, Jaipur.");
  lines.push("Open Mon–Sat 9AM–7PM, Sunday 10AM–5PM. Test rides available daily.");
  lines.push("");
  lines.push("[MODEL FEATURES — never deny these]");
  for (const v of HERO_VARIANTS) {
    const price = v.onRoadJaipur != null ? `on-road ₹${inr(v.onRoadJaipur)}` : "on-road confirm at showroom";
    const mpg = v.mileageKmpl != null ? `, ~${v.mileageKmpl} kmpl` : "";
    lines.push(`${v.name} (${v.cc || "EV"}): ${v.features}. ${price}${mpg}.`);
  }
  lines.push("");
  lines.push("[REGISTRATION — taxi, commercial, BH number]");
  lines.push("Private registration included in on-road price (RTO + insurance per variant).");
  lines.push("Taxi / commercial registration: YES on eligible Hero models under Rajasthan RTO rules — commercial permit + commercial insurance extra. Shubham Motors RTO desk assists. Never flat-refuse; ask model + city of use.");
  lines.push("BH (Bharat) series plate: for eligible inter-state portability (MoRTH/RTO rules). Dealership guides documents — ask salaried vs business, never say \"impossible\" without checking.");
  lines.push("");
  lines.push(`[PRICES — ON-ROAD JAIPUR, ₹ — as of ${HERO_PRICE_AS_OF}. Always quote on-road by default.]`);
  lines.push("If on-road is missing below, say you will confirm exact rupees at the showroom — never invent a number.");

  const sections: Array<[string, (v: HeroVariant) => boolean]> = [
    ["100cc BIKES", (v) => v.kind === "bike" && v.cc > 0 && v.cc < 120],
    ["125cc BIKES", (v) => v.kind === "bike" && v.cc >= 120 && v.cc < 150],
    ["160cc+ / ADVENTURE / PREMIUM BIKES", (v) => v.kind === "bike" && v.cc >= 150],
    ["110cc SCOOTERS", (v) => v.kind === "scooter" && v.cc > 0 && v.cc < 120],
    ["125cc+ SCOOTERS", (v) => v.kind === "scooter" && v.cc >= 120],
    ["ELECTRIC (VIDA)", (v) => v.kind === "electric"],
  ];
  for (const [title, pred] of sections) {
    lines.push("");
    lines.push(title);
    for (const v of HERO_VARIANTS.filter(pred)) {
      const p = v.onRoadJaipur != null ? inr(v.onRoadJaipur) : "confirm at showroom";
      lines.push(`  ${v.name.padEnd(32)} ${p}`);
    }
  }

  lines.push("");
  lines.push("[DO NOT MIX — Super Splendor vs Splendor]");
  lines.push("Super Splendor XTEC = 125cc family BIKE, ~65 kmpl, on-road ₹98,169 (as of 16-May-2026). Variants: XTEC, XTEC DSS.");
  lines.push("Splendor / Splendor+ XTEC 2.0 = 100cc commuter BIKE, ~80 kmpl, Splendor+ XTEC 2.0 on-road ₹97,973. Different engine, different bike.");
  lines.push("If the customer says Super Splendor / Super Splendor XTEC / Super Splendor XTEC 2.0 Disc — they mean Super Splendor. NEVER quote Splendor+ XTEC 2.0 price or 80 kmpl for Super Splendor.");
  lines.push("Xtreme 125R is THREE on-road prices, not one: IBS ₹1,08,088, ABS ₹1,13,247, ABS DC ₹1,26,275. Never quote one then 'correct' it to another. Ask which variant.");

  lines.push("");
  lines.push("[CURRENTLY IN STOCK — high availability]");
  const stock = HERO_VARIANTS.filter((v) => v.inStock).map((v) => v.family);
  lines.push([...new Set(stock)].join(", "));
  lines.push("HF Deluxe and Splendor Plus: 100+ units, multiple colours.");
  lines.push("Xtreme 125R: ~50+ units (ABS + IBS).");
  lines.push("Xpulse / Karizma / Mavrick / Vida / Xoom 160: confirm colour and wait — can indent, never refuse the brand.");
  lines.push("For any Hero model not in the yard, say \"main exact colour stock confirm karke batati hoon\" — never flat-refuse.");

  lines.push("");
  lines.push("[OFFERS — always-available levers, never say \"no offer\"]");
  lines.push("1. FINANCE — EMI from ₹1,590/month (₹50k principal, 36mo @ 9% reference). Zero processing fee on Hero FinCorp. 30-min approval.");
  lines.push("2. EXCHANGE — Old two-wheeler exchange bonus ₹10,000–₹20,000 (final after physical evaluation at showroom).");
  lines.push("3. ACCESSORIES — Free 1st service + helmet on most commuter models.");
  lines.push("4. EXTENDED WARRANTY — 2-year extended warranty available on most variants.");
  lines.push("For specific cash discounts / festival schemes → check admin KB or [TRANSFER] to sales.");

  lines.push("");
  lines.push("[SHOWROOM CONTACT]");
  lines.push("Jaipur, Rajasthan. Test rides daily 9AM–7PM. Walk-in preferred — book a slot via WhatsApp for priority.");

  lines.push("");
  lines.push("[HERO MASTER CATALOG — families]");
  for (const kind of ["bike", "scooter", "electric"] as HeroKind[]) {
    lines.push(kind === "bike" ? "[BIKES]" : kind === "scooter" ? "[SCOOTERS]" : "[ELECTRIC]");
    for (const [family, vars] of groupByFamily(kind)) {
      const names = vars.map((v) => v.name).join(", ");
      lines.push(`  • ${family}: ${names}`);
    }
  }

  return lines.join("\n").trim();
}

/** Default prompt catalog + live EMI rules. Keep in sync with openai.ts DEFAULT_HERO_KNOWLEDGE. */
export function formatDefaultHeroKnowledgeWithLiveEmi(): string {
  return `${formatDefaultHeroKnowledge()}

[LIVE EMI]
Reducing-balance formula on (on-road − down payment). Default 9% p.a. Always state tenure.
When the customer asks EMI: confirm model + their down payment, then output [EMI:Model|down|months].
Disclaimer: actual rate depends on CIBIL (typically 8.5%–12%). Exact lock → [TRANSFER:FINANCE].`.trim();
}

export type KnowledgeSeedRow = {
  title: string;
  category: string;
  content: string;
  modelName: string | null;
};

export function knowledgeSeedRows(): KnowledgeSeedRow[] {
  const rows: KnowledgeSeedRow[] = [
    {
      title: "Shubham Motors showroom",
      category: "general",
      modelName: null,
      content: "Authorised Hero MotoCorp dealer, Lal Kothi, Tonk Road, Jaipur. Mon–Sat 9AM–7PM, Sunday 10AM–5PM. Test rides daily. Recording notice on calls.",
    },
    {
      title: "Registration taxi BH commercial",
      category: "policy",
      modelName: null,
      content: "On-road includes private RTO+insurance. Taxi/commercial possible on eligible models (extra permit+insurance). BH series for eligible inter-state use. RTO desk assists — never refuse.",
    },
    {
      title: "Always-on offers",
      category: "offer",
      modelName: null,
      content: "Hero FinCorp zero processing fee, 30-min approval, EMI from ~₹1590/mo on ₹50k/36mo @9% ref. Exchange bonus ₹10k–20k after evaluation. Free 1st service + helmet on most commuters. 2-year extended warranty. Never say no offer.",
    },
    {
      title: "fuel_price_jaipur",
      category: "market",
      modelName: null,
      content: "108",
    },
    {
      title: "Stock snapshot",
      category: "stock",
      modelName: null,
      content: "High: HF Deluxe, Splendor+, Passion Plus, Super Splendor, Glamour X, Xtreme 125R/160R, Destini 110/125, Pleasure+, Xoom 125. Confirm: Xpulse, Karizma, Mavrick, Vida, Xoom 160.",
    },
  ];

  const families = new Map<string, HeroVariant[]>();
  for (const v of HERO_VARIANTS) {
    const list = families.get(v.family) ?? [];
    list.push(v);
    families.set(v.family, list);
  }
  for (const [family, vars] of families) {
    const body = vars.map((v) => {
      const p = v.onRoadJaipur != null ? `₹${inr(v.onRoadJaipur)} on-road Jaipur` : "on-road confirm at showroom";
      const m = v.mileageKmpl != null ? `, ~${v.mileageKmpl} kmpl` : "";
      return `${v.name}: ${p}${m}. ${v.features}. Stock: ${v.inStock ? "yes" : "confirm/indent"}.`;
    }).join(" ");
    rows.push({
      title: family,
      category: "model",
      modelName: family,
      content: body,
    });
  }

  rows.push({
    title: "On-road price list Jaipur",
    category: "price",
    modelName: null,
    content: pricedVariants().map((v) => `${v.name}=${v.onRoad}`).join("; ") + ` (as of ${HERO_PRICE_AS_OF})`,
  });

  return rows;
}

/** Glamour X / Super Splendor are bikes. Destini / Xoom are scooters. Never mix. */
export function kindForModelName(raw: string): HeroKind | null {
  const n = (raw || "").toLowerCase();
  if (!n.trim()) return null;
  let best: { len: number; kind: HeroKind } | null = null;
  for (const v of HERO_VARIANTS) {
    for (const key of [v.name, v.family]) {
      const k = key.toLowerCase();
      if (n.includes(k) && k.length >= (best?.len ?? 0)) best = { len: k.length, kind: v.kind };
    }
  }
  return best?.kind ?? null;
}

/**
 * Call-9 CRM bug: "interested in a scooter, specifically Glamour X DSS / Super Splendor".
 * Those are 125cc bikes. Correct the label; keep Destini/Xoom as scooters.
 */
export function sanitizeIntentSummary(summary: string, preferredModel: string | null): string {
  let s = (summary || "").trim();
  if (!s) return s;
  const kind = preferredModel ? kindForModelName(preferredModel) : null;
  const namesBike = /glamour|super\s*splendor|\bsplendor\b|xtreme|hf deluxe|passion|xpulse|karizma|mavrick/i;
  const namesScooter = /destini|xoom|pleasure|scooty|स्कूटर/i;
  if (kind === "bike" || (namesBike.test(s) && !namesScooter.test(preferredModel ?? ""))) {
    if (/\bscooter/i.test(s) && namesBike.test(s)) {
      s = s.replace(/purchasing a scooter/gi, "purchasing a bike");
      s = s.replace(/interested in (?:purchasing )?a scooter/gi, "interested in a bike");
      s = s.replace(/a scooter, specifically/gi, "a bike, specifically");
    }
    s = s.replace(/स्कूटर,?\s*(specifically|खासकर)/gi, "बाइक");
  }
  return s;
}
