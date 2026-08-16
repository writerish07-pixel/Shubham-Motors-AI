/**
 * Human handoff for Exotel Voicebot.
 *
 * Market pattern (ElevenLabs / Exotel AgentStream): speak a one-line Hindi
 * handoff, remember the destination, then either (a) Exotel Calls API redirect
 * or (b) close the Voicebot WebSocket so the next Connect applet dials sales.
 *
 * CRM `contacts` (type=sales) wins; else SALES_TRANSFER_NUMBER on Fly.
 * Default: ring every active salesperson (simultaneous). Whoever answers is
 * written to calls.transferred_to from Exotel DialWhomNumber.
 */

export type TransferLeg = {
  phone: string;
  name: string;
};

export type PendingTransfer = {
  /** First / selected number — kept for older single-agent callers. */
  phone: string;
  phones: string[];
  legs: TransferLeg[];
  label: string;
  at: number;
};

export type TransferStrategy = "simultaneous" | "round_robin";

const PENDING_TTL_MS = 15 * 60 * 1000;
const pending = new Map<string, PendingTransfer>();
const roundRobin = { n: 0 };

export function resetHumanTransferStateForTests(): void {
  pending.clear();
  roundRobin.n = 0;
}

export function transferStrategy(raw = process.env.TRANSFER_STRATEGY): TransferStrategy {
  return String(raw ?? "simultaneous").toLowerCase() === "round_robin"
    ? "round_robin"
    : "simultaneous";
}

export function normalizeAgentPhone(raw: string): string {
  const d = String(raw ?? "").replace(/\D/g, "");
  if (!d) return "";
  if (d.length === 10) return `+91${d}`;
  if (d.length === 11 && d.startsWith("0")) return `+91${d.slice(1)}`;
  if (d.length === 12 && d.startsWith("91")) return `+${d}`;
  if (d.length > 12 && d.startsWith("91")) return `+${d.slice(-12)}`;
  return d.startsWith("+") ? String(raw) : `+${d}`;
}

export function phoneLast10(raw: string): string {
  return String(raw ?? "").replace(/\D/g, "").slice(-10);
}

export function phonesMatch(a: string, b: string): boolean {
  const x = phoneLast10(a);
  const y = phoneLast10(b);
  return x.length === 10 && x === y;
}

function livePending(hit: PendingTransfer | undefined): PendingTransfer | undefined {
  if (!hit) return undefined;
  if (Date.now() - hit.at > PENDING_TTL_MS) return undefined;
  return hit;
}

export function queueHumanTransfer(callSid: string, phone: string, label: string): boolean {
  return queueHumanTransferTeam(callSid, [{ phone, name: label || "sales" }]);
}

export function queueHumanTransferTeam(callSid: string, legs: TransferLeg[]): boolean {
  const clean = legs
    .map((l) => ({
      phone: normalizeAgentPhone(l.phone),
      name: String(l.name ?? "").trim() || "sales",
    }))
    .filter((l) => l.phone);
  if (!callSid || !clean.length) return false;
  pending.set(callSid, {
    phone: clean[0]!.phone,
    phones: uniquePhones(clean.map((l) => l.phone)),
    legs: clean,
    label: clean.map((l) => l.name).join(", "),
    at: Date.now(),
  });
  return true;
}

export function takeHumanTransfer(callSid: string): PendingTransfer | undefined {
  const hit = livePending(pending.get(callSid));
  pending.delete(callSid);
  return hit;
}

export function peekHumanTransfer(callSid: string): PendingTransfer | undefined {
  const hit = livePending(pending.get(callSid));
  if (!hit) pending.delete(callSid);
  return hit;
}

function uniquePhones(phones: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of phones) {
    const n = normalizeAgentPhone(p);
    if (!n) continue;
    const key = phoneLast10(n) || n;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(n);
  }
  return out;
}

export function pickRoundRobinNumbers(phones: string[], cursor = roundRobin): string[] {
  const list = uniquePhones(phones);
  if (!list.length) return [];
  const i = ((cursor.n % list.length) + list.length) % list.length;
  cursor.n += 1;
  return [list[i]!];
}

export function numbersForConnect(
  phones: string[],
  strategy: TransferStrategy = transferStrategy(),
): string[] {
  const list = uniquePhones(phones);
  if (strategy === "round_robin") return pickRoundRobinNumbers(list);
  return list;
}

export type ConnectContact = {
  type: string;
  isActive: boolean;
  phone: string;
  name?: string;
};

/**
 * Numbers Exotel Connect should dial. Prefers the in-memory queue (peek, so
 * Exotel retries still work), else every active CRM sales contact, else env.
 */
export function resolveConnectNumbers(opts: {
  callSid: string;
  contacts: ConnectContact[];
  fallback?: string;
  strategy?: TransferStrategy;
}): string[] {
  const queued = peekHumanTransfer(opts.callSid);
  let phones = queued?.phones?.length ? queued.phones : [];
  if (!phones.length) {
    phones = opts.contacts
      .filter((c) => c.isActive && c.type === "sales")
      .map((c) => c.phone);
  }
  if (!phones.length && opts.fallback) phones = [opts.fallback];
  return numbersForConnect(phones, opts.strategy ?? transferStrategy());
}

export function formatQueuedTransfer(legs: TransferLeg[]): string {
  const names = legs.map((l) => l.name.trim()).filter(Boolean);
  if (!names.length) return "queued: sales team";
  return `queued: ${names.join(", ")}`;
}

export function formatAnsweredTransfer(name: string, phone: string): string {
  const n = String(name ?? "").trim();
  const p = normalizeAgentPhone(phone) || String(phone ?? "").trim();
  return [n || "Sales", p].filter(Boolean).join(" ");
}

export function matchContactByPhone<T extends { name: string; phone: string }>(
  dialWhom: string,
  contacts: T[],
): T | undefined {
  const want = phoneLast10(dialWhom);
  if (want.length !== 10) return undefined;
  return contacts.find((c) => phoneLast10(c.phone) === want);
}

/** Pull the answered / dialed agent mobile from an Exotel status payload. */
export function extractDialWhomNumber(params: Record<string, unknown>): string {
  const directKeys = ["DialWhomNumber", "dialWhomNumber", "DialedNumber", "dialedNumber"];
  for (const k of directKeys) {
    const v = String(params[k] ?? "").trim();
    if (phoneLast10(v).length === 10) return v;
  }
  for (const [k, raw] of Object.entries(params)) {
    if (!/legs\[\d+\]\[(?:number|onumber)\]/i.test(k)) continue;
    const v = String(raw ?? "").trim();
    if (phoneLast10(v).length === 10) return v;
  }
  const legs = params.Legs ?? params.legs;
  if (typeof legs === "string") {
    try {
      return extractDialWhomNumber({ Legs: JSON.parse(legs) });
    } catch {
      /* ignore */
    }
  }
  if (Array.isArray(legs)) {
    for (const leg of legs) {
      if (!leg || typeof leg !== "object") continue;
      const rec = leg as Record<string, unknown>;
      const v = String(rec.Number ?? rec.number ?? rec.OnNumber ?? rec.onumber ?? "").trim();
      if (phoneLast10(v).length === 10) return v;
    }
  }
  return "";
}

export function resolveTransferredToLabel(
  params: Record<string, unknown>,
  contacts: { name: string; phone: string }[],
): string | null {
  const whom = extractDialWhomNumber(params);
  if (!whom) return null;
  const hit = matchContactByPhone(whom, contacts);
  return formatAnsweredTransfer(hit?.name ?? "", whom);
}

/**
 * Customer wants a human. Must NOT fire on product/EMI questions.
 * Live Hindi: "kisi se baat karao", "agent se baat", "insaan se baat".
 */
export function isCustomerAskingForHuman(text: string): boolean {
  const t = text.toLowerCase();
  if (/(offer|discount|scheme|cashback|deal|price|kimat|qeemat|कीमत|emi|finance|कर्ज़|loan|kist|किस्त|mileage|माइलेज|stock|address|service|warranty|कब|when|cc\b|सीसी)/i.test(t)) {
    return false;
  }
  const patterns: RegExp[] = [
    /किसी\s+से\s+बात\s+(करा|करवा|करनी|करना)/,
    /किसी\s+(को|ko)\s+(लगा|मिला|connect)/,
    /(sales|manager|senior|sales\s*expert|agent|executive)\s*(वाले|वाली|बंदे|भाई|व्यक्ति|person|wala|waale|staff|team)?\s*(से|se)\s+(बात|baat|connect|कनेक्ट)/i,
    /(connect|transfer|forward|put\s+me\s+through)\s+(me\s+|us\s+)?(to|with)\s+(a\s+|the\s+)?(sales|manager|human|senior|real\s+person|representative|agent)/i,
    /(talk|speak)\s+(to|with)\s+(a\s+|the\s+)?(human|real\s+person|manager|senior|sales\s+(person|guy|executive|expert))/i,
    /(असली|asli|real)\s+(व्यक्ति|person|aadmi|आदमी|insaan|इंसान)\s+(से|se)\s+(बात|baat)/i,
    /kisi\s+se\s+baat\s+(kara|karwa|karni|karo)/i,
    /(manager|senior|agent|executive|insaan|इंसान)\s+(से|se)\s+baat/i,
    /transfer\s*kar(?:o|do|na)/i,
    /(koi|कोई)\s+(human|insaan|इंसान|agent|person)\s+(se|से)/i,
    /salesperson|sales\s*person|sales\s*wala/i,
  ];
  return patterns.some((re) => re.test(t));
}

/** Energy is a person talking over TTS, not just line echo. */
export function bargeEnergyHits(energy: number, echoRms: number, floor: number): boolean {
  if (energy >= 0.07) return true;
  const adaptive = Math.max(floor, echoRms * 1.7);
  return energy > adaptive;
}
