/**
 * Live-call buying timeline extraction — drives auto follow-up scheduling.
 * Complements post-call LLM analysis in analyzeCallIntent().
 */

export type BuyingTimeline =
  | "immediate"
  | "15days"
  | "month"
  | "festival"
  | "loan_closure"
  | "next_year";

const TIMELINE_PATTERNS: Array<[RegExp, BuyingTimeline]> = [
  [/aaj|abhi|today|turant|is\s*week|is\s*hafte|जल्दी|आज|अभी|इस\s*हफ्ते/i, "immediate"],
  [/agle?\s*(15|pandrah)|15\s*din|do\s*hafte|within\s*15|पंद्रह\s*दिन/i, "15days"],
  [/agle?\s*mahin|next\s*month|salary\s*ke\s*baad|तनख्वाह|वेतन|month\s*end|mahine\s*ke\s*baad|अगले\s*महीने/i, "month"],
  [/diwali|dussehra|holi|navratri|festival|त्योहार|छुट्टी\s*के\s*बाद/i, "festival"],
  [/loan\s*band|loan\s*khatam|emi\s*band|closure|लोन\s*बंद|लोन\s*खत्म/i, "loan_closure"],
  [/agle?\s*saal|next\s*year|अगले\s*साल/i, "next_year"],
];

/** Customer-stated purchase timing from a single utterance or short phrase. */
export function extractBuyingTimeline(text: string): BuyingTimeline | null {
  const t = text.toLowerCase();
  for (const [re, timeline] of TIMELINE_PATTERNS) {
    if (re.test(t)) return timeline;
  }
  // "soch ke batata / family se puch ke" without date → planning window
  if (/soch|decide|मंजूरी|approval|family\s*se|ghar\s*walon/i.test(t) && /baad|later|फिर|बाद/i.test(t)) {
    return "month";
  }
  return null;
}

/** True when customer is answering a when-to-buy question. */
export function isTimelineAnswer(text: string): boolean {
  return extractBuyingTimeline(text) !== null
    || /kab\s*tak|kitne\s*din|when|timeline|कब\s*ले|कब\s*खरीद|कब\s*लेना/i.test(text);
}

/** Standard follow-up question when timeline is still unknown (turn 3+). */
export function buyingTimelineQuestion(model?: string): string {
  const modelBit = model ? ` ${model} ke liye` : "";
  return `Ek important sawaal${modelBit} — aap bike kab tak lena plan kar rahe hain? Is hafte, is mahine, ya festival ke baad?`;
}

export function buyingTimelineLabel(t: BuyingTimeline): string {
  const labels: Record<BuyingTimeline, string> = {
    immediate: "jaldi / is hafte",
    "15days": "15 din ke andar",
    month: "agle mahine / salary ke baad",
    festival: "festival season",
    loan_closure: "purani loan band hone ke baad",
    next_year: "agle saal",
  };
  return labels[t];
}
