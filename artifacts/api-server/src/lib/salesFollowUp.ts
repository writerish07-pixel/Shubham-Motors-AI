/**
 * Ensures every agent turn ends with a contextual sales follow-up question.
 * Kills dead-end replies and long silent gaps on live calls.
 */

import type { ConvStage, DiscoverySignals } from "./openai";
import { buyingTimelineQuestion } from "./buyingTimeline";

export interface FollowUpContext {
  signals?: DiscoverySignals;
  convStage?: ConvStage;
  turn?: number;
  customerText?: string;
  leadName?: string;
}

/** True if the reply already invites a customer response. */
export function endsWithQuestion(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (/[?？]\s*$/.test(t)) return true;

  const lastSentence = t.split(/[.!?।]\s*/).filter(Boolean).pop()?.trim() ?? t;
  return /(?:kya|kaun|kaunsa|kaunsi|kab|kahan|kitna|kitni|kitne|chahenge|chahte|chaahiy|bataiyega|bataiye|batao|plan|suit|theek lag|dekhna|dekh rahe|aayenge|lenge|soch rahe|karun|karu|book|convenient|pasand|try|compare|final|down\s*payment|emi|tenure|variant|drss?|dss)/i.test(
    lastSentence,
  ) || /(?:क्या|कौन|कब|कहाँ|कितना|कितनी|चाहेंगे|चाहते|बताइए|बताएंगे|आएंगे|सोच रहे|पसंद|वेरिएंट|डाउन)/.test(
    lastSentence,
  );
}

/** Pick the single best next question for this moment in the sale. */
export function pickContextualFollowUp(ctx: FollowUpContext): string {
  const s = ctx.signals ?? {};
  const stage = ctx.convStage ?? "connect";
  const customer = (ctx.customerText ?? "").toLowerCase();
  const model = s.interestedModel ?? "";
  const combined = `${customer} ${model}`.toLowerCase();

  if (/cruise|glamour|dss|drs|centro|क्रूज|ग्लैमर/i.test(combined)) {
    if (!/dss|drs/i.test(customer)) {
      return "Aap DRS dekh rahe hain ya DSS with cruise control?";
    }
  }

  if (s.financeInterest) {
    if (/down|hajar|hazaar|lakh|lac|डाउन|हज़ार|लाख/i.test(customer)) {
      return "24 mahine ya 36 mahine — kis tenure par EMI calculate karun?";
    }
    if (model) {
      return `Kitna down payment de sakte hain ${model} ke liye — main exact EMI bata deti hoon?`;
    }
    return "Kitna down payment plan hai — main 24 aur 36 mahine ki EMI bata deti hoon?";
  }

  if (/price|kitne|kimat|qeemat|कीमत|on.?road|rate/i.test(customer)) {
    if (model) return `${model} ka test ride kab convenient hoga?`;
    return "Kaun sa variant aapke liye suit karega?";
  }

  if (/feature|mileage|spec|engine|warranty|माइलेज/i.test(customer)) {
    if (model) return "Showroom pe dekhna chahenge ya pehle WhatsApp pe details bhej doon?";
    return "Daily kitne km chalate hain — us hisaab se exact model suggest karungi?";
  }

  if (stage === "booking" || stage === "ready") {
    return "Test ride book kar doon — Saturday subah ya shaam suit karega?";
  }
  if (stage === "planning" || (!s.buyingTimeline && (ctx.turn ?? 0) >= 3 && (s.segment || s.interestedModel))) {
    return buyingTimelineQuestion(model || undefined);
  }
  if (stage === "negotiating") {
    return "EMI se comfortable hoga ya exchange option explore karein?";
  }
  if (stage === "shortlisting" && model) {
    return `${model} pe test ride kar lenge — kaun sa din aayenge?`;
  }
  if (stage === "comparing") {
    return "Aapke liye sabse important kya hai — mileage, style, ya EMI?";
  }

  if (!s.segment) return "Pehle ye bataiye — scooter chahiye ya bike?";
  if (!s.km) return "Roz kitne km chalana padta hai approximately?";
  if (s.segment?.startsWith("scooter") && s.familyUse === undefined) {
    return "Sirf aap chalayenge ya family ke saath bhi?";
  }
  if (!s.budget) return "Budget cash mein hai ya EMI se lena chahenge?";
  if (!s.interestedModel) {
    if (s.segment === "125cc") {
      return "125cc mein style Glamour ya sporty Xtreme 125R — kya pasand aayega?";
    }
    if (s.segment?.startsWith("scooter")) {
      return "Destini family ke liye ya Xoom sporty look — kaun sa try karna hai?";
    }
    if (s.segment === "100cc") return "HF Deluxe mileage ke liye ya Splendor premium comfort — kaun sa?";
    return "Kaun sa model naam se dekh rahe hain?";
  }

  if (model) return "Test ride ke liye kab aana convenient hoga?";
  return "Aur kya jaanna chahenge — price, EMI, ya test ride?";
}

/** Append a follow-up question when the reply ends without one. */
export function ensureSalesFollowUp(reply: string, ctx: FollowUpContext): string {
  const trimmed = reply.trim();
  if (!trimmed || /^\s*\[TRANSFER/i.test(trimmed)) return reply;
  if (endsWithQuestion(trimmed)) return reply;

  const followUp = pickContextualFollowUp(ctx);
  const base = trimmed.replace(/[.।]\s*$/, "");
  return `${base}. ${followUp}`;
}

/** For streaming TTS — return a separate short sentence if the full reply lacks a question. */
export function getMissingFollowUpSentence(fullReply: string, ctx: FollowUpContext): string | null {
  if (!fullReply.trim() || /^\s*\[TRANSFER/i.test(fullReply)) return null;
  if (endsWithQuestion(fullReply)) return null;
  return pickContextualFollowUp(ctx);
}
