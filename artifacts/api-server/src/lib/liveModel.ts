/**
 * Live-call model tracking. Call 17 kept pitching Glamour X DSS cruise after
 * the customer named HF Deluxe, because CRM + greeting + "ग्लैमर नहीं देखी"
 * all counted as Glamour interest.
 *
 * Rule: the last model they are actually shopping this turn wins.
 * A rejection ("नहीं देखी" / "बात नहीं कर रहा") is not interest.
 */

export type LiveSegment = "100cc" | "125cc" | "160cc+" | "scooter_110" | "scooter_125" | "electric";

type ModelHit = {
  index: number;
  length: number;
  name: string;
  family: string;
  segment: LiveSegment;
};

/** Specific names first. lastIndex wins so "not Glamour, HF Deluxe" lands on Deluxe. */
const MODEL_PATTERNS: Array<[RegExp, string, string, LiveSegment]> = [
  [/glamour\s*x?\s*dss/gi, "Glamour X DSS", "Glamour X", "125cc"],
  [/glamour\s*x?\s*drs/gi, "Glamour X DRS", "Glamour X", "125cc"],
  [/glamour|galemar|galaimer|glemor|ग्लैमर/gi, "Glamour X", "Glamour X", "125cc"],
  // Super Splendor is a 125cc bike. Never let "splendor" / "xtec 2.0" inside it win Splendor+.
  [/super[\s-]*splendor[\s-]*(?:एक्सटेक|xtec)|सुपर[\s-]*(?:splendor|स्प्लेंडर)[\s-]*(?:एक्सटेक|xtec)/gi, "Super Splendor XTEC", "Super Splendor", "125cc"],
  [/super[\s-]*splendor|सुपर[\s-]*(?:splendor|स्प्लेंडर)/gi, "Super Splendor", "Super Splendor", "125cc"],
  [/(?<!super\s)(?<!सुपर\s)(?:splendor\s*xtec|splendor\s*plus|स्प्लेंडर)/gi, "Splendor XTEC", "Splendor", "100cc"],
  [/(?<!super\s)(?<!सुपर\s)\bsplendor\b/gi, "Splendor XTEC", "Splendor", "100cc"],
  [/hf\s*deluxe\s*pro|deluxe\s*pro|डीलक्स\s*प्रो/gi, "HF Deluxe Pro", "HF Deluxe", "100cc"],
  [/hf\s*deluxe|hf deluxe/gi, "HF Deluxe", "HF Deluxe", "100cc"],
  [/एच\s*एफ\s*डीलक्स|एच\s*[एसस]\s*डीलक्स|एचएफ\s*डीलक्स|एचएफडी/g, "HF Deluxe", "HF Deluxe", "100cc"],
  [/passion/gi, "Passion Plus", "Passion Plus", "100cc"],
  [/xtreme\s*160|एक्सट्रीम\s*160/gi, "Xtreme 160R", "Xtreme 160R", "160cc+"],
  [/xtreme\s*125|एक्सट्रीम\s*125/gi, "Xtreme 125R", "Xtreme 125R", "125cc"],
  [/एक्सट्रीम/gi, "Xtreme 125R", "Xtreme 125R", "125cc"],
  [/xpulse/gi, "Xpulse 200 4V", "Xpulse", "160cc+"],
  [/karizma/gi, "Karizma XMR", "Karizma", "160cc+"],
  [/destini\s*125|डेस्टिनी\s*125/gi, "Destini 125", "Destini 125", "scooter_125"],
  [/destini\s*110|destini\s*prime|डेस्टिनी\s*110/gi, "Destini 110", "Destini 110", "scooter_110"],
  [/destini|डेस्टिनी/gi, "Destini 110", "Destini 110", "scooter_110"],
  [/xoom\s*125|xoom|ज़ूम|जूम/gi, "Xoom 125", "Xoom 125", "scooter_125"],
  [/pleasure|प्लेज़र|प्लेजर/gi, "Pleasure+", "Pleasure+", "scooter_110"],
  [/vida/gi, "Vida V1 Pro", "Vida", "electric"],
];

export function isRejectingPreviousModel(text: string): boolean {
  return /नहीं देख|देख नहीं|बात नहीं|नहीं कर रहा|nahi dekh|kuch aur dekh|कुछ और देख|कोई और देख|something else|not looking|not talking about/i.test(
    text,
  );
}

/** Families named in a rejection clause ("ग्लैमर नहीं", "स्प्लेंडर की बात नहीं"). */
function rejectedFamilies(text: string, hits: ModelHit[]): Set<string> {
  const out = new Set<string>();
  for (const h of hits) {
    const after = text.slice(h.index + h.length, h.index + h.length + 28);
    if (/^\s*(?:x|एक्स)?\s*(?:की|के|ka|ki)?\s*(?:बात\s*)?(?:नहीं|nahi|नही)/i.test(after)) {
      out.add(h.family);
    }
  }
  return out;
}

export function modelFamily(name: string | null | undefined): string {
  const n = String(name ?? "").toLowerCase();
  if (!n) return "";
  if (/glamour/.test(n)) return "Glamour X";
  if (/super\s*splendor/.test(n)) return "Super Splendor";
  if (/splendor/.test(n)) return "Splendor";
  if (/hf\s*deluxe|deluxe/.test(n)) return "HF Deluxe";
  if (/passion/.test(n)) return "Passion Plus";
  if (/xtreme\s*160|एक्सट्रीम\s*160/.test(n)) return "Xtreme 160R";
  if (/xtreme\s*125|एक्सट्रीम/.test(n)) return "Xtreme 125R";
  if (/xpulse/.test(n)) return "Xpulse";
  if (/destini\s*125/.test(n)) return "Destini 125";
  if (/destini/.test(n)) return "Destini 110";
  if (/xoom/.test(n)) return "Xoom 125";
  if (/pleasure/.test(n)) return "Pleasure+";
  if (/vida/.test(n)) return "Vida";
  if (/karizma/.test(n)) return "Karizma";
  return n;
}

export function isGlamourFamily(name: string | null | undefined): boolean {
  return modelFamily(name) === "Glamour X";
}

export function segmentForModel(name: string | null | undefined): LiveSegment | null {
  const fam = modelFamily(name);
  if (fam === "HF Deluxe" || fam === "Splendor" || fam === "Passion Plus") return "100cc";
  if (fam === "Glamour X" || fam === "Super Splendor" || fam === "Xtreme 125R") return "125cc";
  if (fam === "Xtreme 160R" || fam === "Xpulse" || fam === "Karizma") return "160cc+";
  if (fam === "Destini 110" || fam === "Pleasure+") return "scooter_110";
  if (fam === "Destini 125" || fam === "Xoom 125") return "scooter_125";
  if (fam === "Vida") return "electric";
  return null;
}

function spansOverlap(a: ModelHit, b: ModelHit): boolean {
  return a.index < b.index + b.length && a.index + a.length > b.index;
}

/** Call 18: "Super Splendor XTEC" also matched Splendor XTEC (later end → last-hit won 100cc). */
function dropNestedFamilyHits(hits: ModelHit[]): ModelHit[] {
  return hits.filter((h) => {
    if (h.family !== "Splendor") return true;
    return !hits.some((o) => o.family === "Super Splendor" && spansOverlap(h, o));
  });
}

function collectHits(text: string): ModelHit[] {
  const hits: ModelHit[] = [];
  for (const [re, name, family, segment] of MODEL_PATTERNS) {
    const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
    for (const m of text.matchAll(g)) {
      if (m.index == null) continue;
      hits.push({ index: m.index, length: m[0].length, name, family, segment });
    }
  }
  const usable = dropNestedFamilyHits(hits);
  usable.sort((a, b) => (a.index + a.length) - (b.index + b.length) || b.length - a.length);
  return usable;
}

/** Last model they are shopping — not a model they just rejected. */
export function detectNamedModel(text: string): string | null {
  const raw = String(text ?? "").trim();
  if (!raw) return null;
  const hits = collectHits(raw);
  if (!hits.length) return null;
  const dropped = rejectedFamilies(raw, hits);
  const usable = dropped.size ? hits.filter((h) => !dropped.has(h.family)) : hits;
  if (!usable.length) return null;
  return usable[usable.length - 1]!.name;
}

export function liveModelForTurn(
  customerText: string,
  staleModel?: string | null,
): string {
  const named = detectNamedModel(customerText);
  if (named) return named;
  if (shouldDropStaleModel(customerText, staleModel)) return "";
  return staleModel ?? "";
}

/** True when they rejected THIS stale family, or said "something else" without keeping it. */
export function shouldDropStaleModel(text: string, staleModel?: string | null): boolean {
  if (!staleModel || !isRejectingPreviousModel(text)) return false;
  if (detectNamedModel(text)) return false;
  const hits = collectHits(text);
  const dropped = rejectedFamilies(text, hits);
  const prevFam = modelFamily(staleModel);
  if (prevFam && dropped.has(prevFam)) return true;
  const switching = /kuch aur dekh|कुछ और देख|कोई और देख|something else/i.test(text);
  return switching && !hits.some((h) => h.family === prevFam);
}

/** Patch discovery signals so THIS-turn shopping model wins over CRM. */
export function applyLiveModelSwitch<T extends { interestedModel?: string; segment?: string }>(
  existing: T,
  customerText: string,
): T {
  const named = detectNamedModel(customerText);
  const updated = { ...existing };
  if (named) {
    updated.interestedModel = named;
    const seg = segmentForModel(named);
    if (seg) updated.segment = seg;
    return updated;
  }
  if (shouldDropStaleModel(customerText, updated.interestedModel)) {
    const prevSeg = segmentForModel(updated.interestedModel);
    delete updated.interestedModel;
    if (prevSeg && updated.segment === prevSeg) delete updated.segment;
  }
  return updated;
}
