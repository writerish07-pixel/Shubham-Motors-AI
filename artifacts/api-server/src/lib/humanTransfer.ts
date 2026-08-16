/**
 * Human handoff for Exotel Voicebot.
 *
 * Market pattern (ElevenLabs / Exotel AgentStream): speak a one-line Hindi
 * handoff, remember the destination, then either (a) Exotel Calls API redirect
 * or (b) close the Voicebot WebSocket so the next Connect applet dials sales.
 *
 * CRM `contacts` (type=sales) wins; else SALES_TRANSFER_NUMBER on Fly.
 */

export type PendingTransfer = {
  phone: string;
  label: string;
  at: number;
};

const pending = new Map<string, PendingTransfer>();

export function normalizeAgentPhone(raw: string): string {
  const d = String(raw ?? "").replace(/\D/g, "");
  if (!d) return "";
  if (d.length === 10) return `+91${d}`;
  if (d.length === 11 && d.startsWith("0")) return `+91${d.slice(1)}`;
  if (d.length === 12 && d.startsWith("91")) return `+${d}`;
  if (d.length > 12 && d.startsWith("91")) return `+${d.slice(-12)}`;
  return d.startsWith("+") ? String(raw) : `+${d}`;
}

export function queueHumanTransfer(callSid: string, phone: string, label: string): boolean {
  const n = normalizeAgentPhone(phone);
  if (!callSid || !n) return false;
  pending.set(callSid, { phone: n, label: label || "sales", at: Date.now() });
  return true;
}

export function takeHumanTransfer(callSid: string): PendingTransfer | undefined {
  const hit = pending.get(callSid);
  if (hit) pending.delete(callSid);
  return hit;
}

export function peekHumanTransfer(callSid: string): PendingTransfer | undefined {
  return pending.get(callSid);
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
